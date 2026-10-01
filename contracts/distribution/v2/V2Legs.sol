// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IERC20,
    IPoolManager,
    IPonsV2BondingCurve,
    IPonsV2LaunchFactory,
    IPonsV2MemeHookSource
} from "../../interfaces/IExternal.sol";
import {TickMath} from "../../libraries/TickMath.sol";
import {FullMath} from "../../libraries/FullMath.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice The one question the legs ask their vault: which token was bound.
interface IVaultToken {
    function token() external view returns (address);
}

/// @title  V2Legs — the buy-and-burn and locked-LP legs of the distribution
///         mode's second version, one instance per vault.
///
/// @notice `FeeVault` has 591 bytes of margin under EIP-170 and these legs do
///         not fit in it — so they live here, funded by the vault in its own
///         QUOTE, and act on the LAUNCH TOKEN's v4 pool. Both legs are ports
///         of what `Treasury` already runs on $PAYD (`Treasury.sol:474-890`,
///         measured in `test/V4Swap.t.sol`), generalised to a quote that is
///         not native ETH: currencies sort by address and the launched token
///         lands on either side (`docs/recon.md` §13), so the swap direction,
///         the side the price limit sits on and the settle path are all
///         derived from the key, never assumed.
///
/// @dev    **Nothing here can leave except through the pool.** The burn pocket
///         has one exit, `buyAndBurn`, and it ends at `0xdead` — an address
///         `structuralExclusions` already keeps out of every snapshot, so a
///         burnt balance earns nothing. The LP pocket has one exit,
///         `addLiquidity`, and it ends in a position keyed to THIS contract
///         on the PoolManager — no NFT, and no function here removes
///         liquidity, which is the lock. There is deliberately no withdraw,
///         no owner and no migration of the pockets: the legs serve the
///         TOKEN's pool, and the token does not change when the vault
///         migrates — a successor vault simply funds the same legs.
///
///         **The price bound is a LIMIT against a stale anchor, not a floor**
///         (`Treasury._burnOnPool` verbatim): v4 has no oracle, the Pons hook
///         provides none, and `slot0` is manipulable inside a block. The
///         anchor is the price the last burn ended on — at least a cooldown
///         old, so moving it means holding a moved price for hours — and the
///         band around it widens with the time since the last FULL burn. A
///         limit fills partially instead of reverting: the leg buys what
///         fits, keeps the rest, and the anchor walks toward the truth.
contract V2Legs {
    // -------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice How often the burn may run, so each purchase is worth its
    ///         slippage instead of a stream of dust trades.
    uint256 public constant BURN_COOLDOWN = 4 hours;

    /// @notice How far the burn lets the price move per cooldown elapsed, and
    ///         the ceiling on that band. Same values, same reasoning as the
    ///         Treasury's (`Treasury.sol:138-159`).
    uint256 public constant BURN_BAND_BPS = 1_000;
    uint256 public constant BURN_BAND_CAP_BPS = 5_000;

    /// @notice How far the LP's own half-swap may walk the price, and how wide
    ///         the position is, in tick spacings either side.
    uint256 public constant LP_BAND_BPS = 200;
    int24 public constant LP_RANGE_SPACINGS = 20;

    /// @notice Tolerance on the pre-graduation burn's curve floor. Tight on
    ///         purpose: the curve has no external liquidity, so the only thing
    ///         that can move between reading the reserves and buying is
    ///         another buy in the same window (`Treasury.sol:166-173`).
    uint256 public constant MAX_SLIPPAGE_BPS = 100;

    // ------------------------------------------------------------------ state

    /// @notice The only funder. Written once at `init`.
    address public VAULT;
    /// @notice The launched token these legs burn and provide liquidity for.
    ///         NOT an init parameter: the vault is created BEFORE the launch
    ///         exists (it is the `creatorFeeRecipient` the launch names), so
    ///         the token is read from the vault on first use and cached.
    address public TOKEN;
    /// @notice The vault's quote — `address(0)` for native ETH. Matches the
    ///         launch's `pairToken`: both come from the same registry wiring.
    address public QUOTE;
    IPonsV2LaunchFactory public FACTORY;
    IPoolManager public POOL_MANAGER;
    /// @notice The smallest amount each pocket will move — the vault's
    ///         `MIN_BUY_QUOTE`, because "0.005 ether" means nothing in a quote
    ///         with other decimals. Below it the pocket waits; nothing is
    ///         lost by waiting.
    uint256 public MIN_MOVE;

    /// @notice The two pockets, in QUOTE units. Their sum never exceeds the
    ///         quote this contract holds.
    uint256 public burnPool;
    uint256 public lpPool;

    /// @notice How a funding splits between the two pockets. Held HERE and not
    ///         on the vault: the vault keeps one rate and one call, and the
    ///         split lives next to the pockets it feeds. Written once at
    ///         `init`, by the bootstrap.
    uint256 public burnBps;
    uint256 public lpBps;

    uint256 public lastBurnAt;
    uint256 public lastFullBurnAt;
    /// @notice The anchor: the price the last burn ended on.
    uint160 public lastBurnSqrtPrice;

    /// @notice One position, one range, for the life of the contract — a
    ///         second range would leave the first uncollectable, since
    ///         nothing here remembers more than one.
    uint128 public lpLiquidity;
    int24 public lpLower;
    int24 public lpUpper;

    /// @dev Carried across the `unlock` callback, which cannot take arguments
    ///      of its own once `_adding` claims the discriminant.
    struct Pending {
        IPoolManager.PoolKey key;
        uint256 amount;
        uint160 limit;
        uint256 spent;
        uint256 out;
        bool keepToken;
    }

    Pending private _pending;

    struct Adding {
        IPoolManager.PoolKey key;
        int24 lower;
        int24 upper;
        uint128 liquidity;
        uint256 quoteUsed;
        uint256 tokenUsed;
    }

    Adding private _adding;

    uint256 private _lock;

    // ----------------------------------------------------------------- events

    event Funded(uint256 toBurn, uint256 toLp);
    event StrayFunded(uint256 toBurn);
    event Burned(uint256 quoteSpent, uint256 tokensBurned);
    event LiquidityAdded(uint256 quoteUsed, uint256 tokenUsed, uint128 liquidity);

    // ----------------------------------------------------------------- errors

    error AlreadyInit();
    error NotVault();
    error NotPoolManager();
    error BadFunding();
    error NotGraduated();
    error NothingToDo();
    error BelowMinimum(uint256 have, uint256 need);
    error TooSoon(uint256 ready);
    error TooLittleOut(uint256 got, uint256 floor);
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ------------------------------------------------------------------- init

    /// @notice Wired by the factory in the same transaction as the clone, so
    ///         no block holds an unconfigured instance.
    function init(
        address vault,
        address quote,
        address factory,
        address poolManager,
        uint256 minMove,
        uint256 burnBps_,
        uint256 lpBps_
    ) external {
        if (VAULT != address(0)) revert AlreadyInit();
        if (vault == address(0) || burnBps_ + lpBps_ == 0) revert BadFunding();
        VAULT = vault;
        QUOTE = quote;
        FACTORY = IPonsV2LaunchFactory(factory);
        POOL_MANAGER = IPoolManager(poolManager);
        MIN_MOVE = minMove;
        burnBps = burnBps_;
        lpBps = lpBps_;
        _lock = 1;
    }

    // ---------------------------------------------------------------- funding

    /// @notice Credits the two pockets, split by the rates set at birth. Only
    ///         the vault, which sends the quote in the same transaction —
    ///         native with the call, an ERC-20 by a transfer just before it,
    ///         which the balance check pins.
    function fund(uint256 amount) external payable {
        if (msg.sender != VAULT) revert NotVault();
        if (QUOTE == address(0)) {
            if (msg.value != amount) revert BadFunding();
        } else {
            if (msg.value != 0) revert BadFunding();
            if (IERC20(QUOTE).balanceOf(address(this)) < burnPool + lpPool + amount) revert BadFunding();
        }
        uint256 toBurn = (amount * burnBps) / (burnBps + lpBps);
        uint256 toLp = amount - toBurn;
        burnPool += toBurn;
        lpPool += toLp;
        emit Funded(toBurn, toLp);
    }

    /// @notice Re-credits quote that arrived outside `fund` — the same rule as
    ///         `FeeVault.fundRewards` for strays: never stranded, and it goes
    ///         to the burn pocket. Permissionless.
    function fundStray() external nonReentrant returns (uint256 credited) {
        uint256 held = QUOTE == address(0) ? address(this).balance : IERC20(QUOTE).balanceOf(address(this));
        uint256 committed = burnPool + lpPool;
        if (held <= committed) revert NothingToDo();
        credited = held - committed;
        burnPool += credited;
        emit StrayFunded(credited);
    }

    // ---------------------------------------------------------------- burning

    /// @notice Buys the token with the burn pocket and sends it to the dead
    ///         address. Permissionless, and it runs in BOTH regimes: on the
    ///         bonding curve before graduation (exact floor), on the v4 pool
    ///         after (banded limit). Only a launch with neither — Swept
    ///         waiting on its pool, Rescued, unbound — leaves the pocket
    ///         accumulating. `addLiquidity` is the leg that waits: there is no
    ///         pool to hold a position in before phase 2.
    function buyAndBurn() external nonReentrant returns (uint256 burned) {
        uint256 ready = lastBurnAt + BURN_COOLDOWN;
        if (block.timestamp < ready) revert TooSoon(ready);

        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(_token());

        uint256 amount = burnPool;
        if (amount < MIN_MOVE) revert BelowMinimum(amount, MIN_MOVE);

        // Phase 2 is `PoolCreated` — the ONLY phase with a v4 pool. Before
        // graduation the burn buys on the CURVE instead of waiting, exactly as
        // the Treasury does for $PAYD: the curve is `x·y = k` on its reserves,
        // so the floor is exact and the burn runs from the launch's first
        // credit. Only the phases with neither pool nor live curve — Swept
        // waiting on its pool, a Rescued graduation, an unbound vault — leave
        // the pocket accumulating.
        if (l.phase != 2) {
            if (l.curve == address(0) || IPonsV2BondingCurve(l.curve).graduated()) revert NotGraduated();
            return _burnOnCurve(l, amount);
        }

        // Since the last FULL burn: a run of partial fills has to widen the
        // band, or a fast rally strands the pocket.
        uint256 elapsed = lastFullBurnAt == 0 ? BURN_COOLDOWN : block.timestamp - lastFullBurnAt;
        burnPool = 0;
        lastBurnAt = block.timestamp;

        IPoolManager.PoolKey memory key = _poolKey(l);
        uint160 anchor = lastBurnSqrtPrice;
        // First burn after graduation: nothing to anchor to, so take the pool
        // as it stands — the one burn that runs on a spot reference.
        if (anchor == 0) anchor = _spotSqrtPrice(key);
        if (anchor == 0) revert NothingToDo();

        uint256 band = (BURN_BAND_BPS * elapsed) / BURN_COOLDOWN;
        if (band > BURN_BAND_CAP_BPS) band = BURN_BAND_CAP_BPS;

        (uint256 spent, uint256 out) = _swapQuoteForToken(key, amount, _limit(key, anchor, band), false);
        burned = out;
        if (spent < amount) {
            // The limit bit. What it kept goes back to the pocket, and
            // `lastFullBurnAt` stays put — the next band is wider by exactly
            // the time this one waited.
            burnPool += amount - spent;
        } else {
            lastFullBurnAt = block.timestamp;
        }
        lastBurnSqrtPrice = _spotSqrtPrice(key);
        emit Burned(spent, burned);
    }

    /// @dev The pre-graduation burn: one curve buy, floored EXACTLY —
    ///      `x·y = k` on the reserves with the trader's total fee taken off
    ///      the input, a tight tolerance on top (`Treasury.buyAndBurn`'s curve
    ///      arm, quote generalised). The curve always takes everything, so a
    ///      curve burn is always a full one; the pool anchor stays untouched —
    ///      there is no pool to anchor to yet.
    function _burnOnCurve(IPonsV2LaunchFactory.LaunchedToken memory l, uint256 amount)
        internal
        returns (uint256 burned)
    {
        uint256 floorOut = _curveFloor(l, amount);
        if (floorOut == 0) revert NothingToDo();
        burnPool = 0;
        lastBurnAt = block.timestamp;

        if (QUOTE == address(0)) {
            burned = IPonsV2BondingCurve(l.curve).buy{value: amount}(amount, floorOut, DEAD);
        } else {
            // The curve pulls its quote: approve exactly this purchase, and
            // the buy consumes it whole. Reset first — a USDT-style quote
            // that refuses a non-zero-to-non-zero approve would otherwise
            // wedge the burn for good on a contract nobody can fix (security
            // review, 2026-09-14). A fee-on-transfer quote stays UNSUPPORTED:
            // `fund`'s balance check refuses the shortfall upstream.
            if (!IERC20(QUOTE).approve(l.curve, 0)) revert TransferFailed();
            if (!IERC20(QUOTE).approve(l.curve, amount)) revert TransferFailed();
            burned = IPonsV2BondingCurve(l.curve).buy(amount, floorOut, DEAD);
        }
        if (burned < floorOut) revert TooLittleOut(burned, floorOut);
        lastFullBurnAt = block.timestamp;
        emit Burned(amount, burned);
    }

    /// @dev What `amount` of QUOTE must buy at the curve's current state, less
    ///      a tight tolerance. Zero when the state cannot be read, which stops
    ///      the burn rather than letting it run blind.
    function _curveFloor(IPonsV2LaunchFactory.LaunchedToken memory l, uint256 amount) internal view returns (uint256) {
        (uint256 quoteReserve, uint256 tokenReserve) = IPonsV2BondingCurve(l.curve).getReserves();
        if (quoteReserve == 0 || tokenReserve == 0) return 0;

        uint256 feeBps = _totalFeeBps(l);
        if (feeBps == 0 || feeBps >= BPS) return 0;

        uint256 eff = (amount * (BPS - feeBps)) / BPS;
        uint256 out = (tokenReserve * eff) / (quoteReserve + eff);
        return (out * (BPS - MAX_SLIPPAGE_BPS)) / BPS;
    }

    /// @dev The creator tax plus the curve fee — what a trader pays, read from
    ///      the launch record and the launch config rather than assumed
    ///      (`Treasury._totalFeeBps`, selector probed in
    ///      `docs/recon-launchpad.md`). Zero if the read fails, which the
    ///      caller treats as "do not burn".
    function _totalFeeBps(IPonsV2LaunchFactory.LaunchedToken memory l) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            address(FACTORY).staticcall(abi.encodeWithSelector(bytes4(0x1cad862d), uint256(0)));
        if (!ok || ret.length < 64) return 0;
        (, uint256 curveFee) = abi.decode(ret, (uint256, uint256));
        if (curveFee == 0) return 0;
        return uint256(l.creatorTaxBps) + curveFee;
    }

    // -------------------------------------------------------------- liquidity

    /// @notice Turns the LP pocket into locked protocol liquidity on the
    ///         token's own pool. Half the quote buys the token, both sides go
    ///         into ONE position held by this contract on the PoolManager,
    ///         and no function here takes it back.
    ///
    /// @dev    The position earns no swap fee — every graduated Pons pool
    ///         carries `poolFee = 0`, the HOOK takes the fee in `afterSwap`
    ///         and routes it to the launch's `creatorFeeRecipient`, which is
    ///         the vault itself. Deeper liquidity therefore pays holders
    ///         through more volume and more creator fees, not through the
    ///         position — which is why there is no collect function either.
    function addLiquidity() external nonReentrant returns (uint256 quoteUsed, uint256 tokenUsed) {
        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(_token());
        if (l.phase != 2) revert NotGraduated();

        uint256 amount = lpPool;
        if (amount < MIN_MOVE) revert BelowMinimum(amount, MIN_MOVE);
        lpPool = 0;

        IPoolManager.PoolKey memory key = _poolKey(l);
        uint160 spot = _spotSqrtPrice(key);
        if (spot == 0) revert NothingToDo();

        // Half to the token side, banded against the same stale anchor as the
        // burn — `spot` only bounds our own impact, it says nothing about a
        // price somebody moved in the transaction just before. Before the
        // first burn the spot is all there is, the same one-off the burn
        // already accepts.
        uint160 anchor = lastBurnSqrtPrice != 0 ? lastBurnSqrtPrice : spot;
        (uint256 spentOnToken,) = _swapQuoteForToken(key, amount / 2, _limit(key, anchor, LP_BAND_BPS), true);

        // The WHOLE token balance goes in, not just this swap's output: the
        // previous round's leftover and any donated tokens compound into the
        // position instead of sitting here.
        uint256 tokenHeld = IERC20(TOKEN).balanceOf(address(this));
        uint256 quoteHeld = amount - spentOnToken;

        (int24 lower, int24 upper) = _range(key);
        // Stay on the range already opened, so every addition compounds one
        // position instead of scattering several this contract cannot track.
        if (lpLiquidity != 0) {
            lower = lpLower;
            upper = lpUpper;
        }

        bool tokenIs0 = key.currency0 == TOKEN;
        uint128 liquidity =
            _liquidityFor(spot, lower, upper, tokenIs0 ? tokenHeld : quoteHeld, tokenIs0 ? quoteHeld : tokenHeld);
        if (liquidity == 0) {
            // Nothing could be placed: put the quote back rather than sit on
            // it. The token side waits for the next round.
            lpPool += quoteHeld;
            return (0, 0);
        }

        _adding = Adding({key: key, lower: lower, upper: upper, liquidity: liquidity, quoteUsed: 0, tokenUsed: 0});
        POOL_MANAGER.unlock("");
        quoteUsed = _adding.quoteUsed;
        tokenUsed = _adding.tokenUsed;
        delete _adding;

        lpLiquidity += liquidity;
        lpLower = lower;
        lpUpper = upper;

        // What the ratio did not take comes back and joins the next round.
        lpPool += quoteHeld - quoteUsed;
        emit LiquidityAdded(quoteUsed, tokenUsed, liquidity);
    }

    // ------------------------------------------------------------ v4 plumbing

    /// @dev One banded exact-input swap, quote in, token out — to the dead
    ///      address for a burn, to this contract for a position.
    function _swapQuoteForToken(IPoolManager.PoolKey memory key, uint256 amount, uint160 limit, bool keepToken)
        internal
        returns (uint256 spent, uint256 out)
    {
        _pending = Pending({key: key, amount: amount, limit: limit, spent: 0, out: 0, keepToken: keepToken});
        POOL_MANAGER.unlock("");
        spent = _pending.spent;
        out = _pending.out;
        delete _pending;
    }

    /// @dev The price limit, on the side the swap walks. Selling the quote for
    ///      the token moves the price DOWN when the quote is `currency0` and
    ///      UP when it is `currency1` — with a non-ETH quote the token lands
    ///      on either side of the key (`docs/recon.md` §13), so the side is
    ///      computed, never assumed. Clamped inside v4's open interval.
    function _limit(IPoolManager.PoolKey memory key, uint160 anchor, uint256 band) internal view returns (uint160) {
        bool zeroForOne = key.currency0 != TOKEN;
        uint256 raw = zeroForOne ? (uint256(anchor) * (BPS - band)) / BPS : (uint256(anchor) * (BPS + band)) / BPS;
        if (raw <= TickMath.MIN_SQRT_PRICE) raw = TickMath.MIN_SQRT_PRICE + 1;
        if (raw >= TickMath.MAX_SQRT_PRICE) raw = TickMath.MAX_SQRT_PRICE - 1;
        return uint160(raw);
    }

    /// @dev The v4 dance. `settle` what the swap says we owe, `take` what it
    ///      says we are owed.
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        if (_adding.liquidity != 0) return _addCallback();

        bool zeroForOne = _pending.key.currency0 != TOKEN;
        int256 delta = POOL_MANAGER.swap(
            _pending.key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -int256(_pending.amount), sqrtPriceLimitX96: _pending.limit
            }),
            ""
        );

        // Packed BalanceDelta: amount0 high, amount1 low. Negative is owed to
        // the pool, positive is owed to us. Which is the quote and which is
        // the token follows the direction, not a convention.
        (int128 amount0, int128 amount1) = _unpack(delta);
        int128 quoteDelta = zeroForOne ? amount0 : amount1;
        int128 tokenDelta = zeroForOne ? amount1 : amount0;

        if (quoteDelta < 0) {
            _pending.spent = uint256(uint128(-quoteDelta));
            _settleQuote(_pending.spent);
        }
        if (tokenDelta > 0) {
            _pending.out = uint256(uint128(tokenDelta));
            POOL_MANAGER.take(TOKEN, _pending.keepToken ? address(this) : DEAD, _pending.out);
        }
        return "";
    }

    /// @dev Settling a position: what the delta says we owe, we pay — and
    ///      both signs, because `modifyLiquidity` realises accrued value in
    ///      the same delta as the principal (`Treasury._addCallback` learned
    ///      this the measured way).
    function _addCallback() internal returns (bytes memory) {
        (int256 delta,) = POOL_MANAGER.modifyLiquidity(
            _adding.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: _adding.lower,
                tickUpper: _adding.upper,
                liquidityDelta: int256(uint256(_adding.liquidity)),
                salt: 0
            }),
            ""
        );
        (int128 amount0, int128 amount1) = _unpack(delta);
        bool tokenIs0 = _adding.key.currency0 == TOKEN;
        int128 quoteDelta = tokenIs0 ? amount1 : amount0;
        int128 tokenDelta = tokenIs0 ? amount0 : amount1;

        if (quoteDelta < 0) {
            _adding.quoteUsed = uint256(uint128(-quoteDelta));
            _settleQuote(_adding.quoteUsed);
        } else if (quoteDelta > 0) {
            // Realised quote lands untracked and `fundStray` re-enters it.
            POOL_MANAGER.take(QUOTE, address(this), uint256(uint128(quoteDelta)));
        }

        if (tokenDelta < 0) {
            _adding.tokenUsed = uint256(uint128(-tokenDelta));
            POOL_MANAGER.sync(TOKEN);
            if (!IERC20(TOKEN).transfer(address(POOL_MANAGER), _adding.tokenUsed)) revert TransferFailed();
            POOL_MANAGER.settle();
        } else if (tokenDelta > 0) {
            // Realised tokens stay here and join the next round's position.
            POOL_MANAGER.take(TOKEN, address(this), uint256(uint128(tokenDelta)));
        }
        return "";
    }

    /// @dev Native rides with the call; an ERC-20 needs `sync`, a plain
    ///      transfer, then `settle`.
    function _settleQuote(uint256 amount) internal {
        if (QUOTE == address(0)) {
            POOL_MANAGER.settle{value: amount}();
        } else {
            POOL_MANAGER.sync(QUOTE);
            if (!IERC20(QUOTE).transfer(address(POOL_MANAGER), amount)) revert TransferFailed();
            POOL_MANAGER.settle();
        }
    }

    /// @dev The token, from the vault, cached on first sight. An unbound
    ///      vault answers zero, which is NOT cached: `getLaunchedToken(0)`
    ///      reads back `phase = 0` and the caller refuses `NotGraduated` —
    ///      the pockets simply accumulate until the launch is bound.
    function _token() internal returns (address t) {
        t = TOKEN;
        if (t == address(0)) {
            t = IVaultToken(VAULT).token();
            if (t != address(0)) TOKEN = t;
        }
    }

    function _unpack(int256 delta) internal pure returns (int128 amount0, int128 amount1) {
        amount0 = int128(delta >> 128);
        amount1 = int128(int256(uint256(uint128(uint256(delta)))));
    }

    /// @dev The key is built from the launch record and the factory's hook —
    ///      never from discovery: a squatter can put the meme hook in a key of
    ///      their own, and an `Initialize` carrying it proves nothing
    ///      (`docs/recon.md` §13). Native ETH always sorts first; two ERC-20s
    ///      sort by address, and the token lands on either side.
    function _poolKey(IPonsV2LaunchFactory.LaunchedToken memory l)
        internal
        view
        returns (IPoolManager.PoolKey memory key)
    {
        address hook = IPonsV2MemeHookSource(address(FACTORY)).memeHook();
        (address c0, address c1) =
            QUOTE == address(0) ? (address(0), TOKEN) : (TOKEN < QUOTE ? (TOKEN, QUOTE) : (QUOTE, TOKEN));
        key = IPoolManager.PoolKey({
            currency0: c0, currency1: c1, fee: l.poolFee, tickSpacing: l.tickSpacing, hooks: hook
        });
    }

    /// @dev A range around the current tick, aligned on the pool's spacing.
    function _range(IPoolManager.PoolKey memory key) internal view returns (int24 lower, int24 upper) {
        (, int24 tick) = _slot0(key);
        int24 spacing = key.tickSpacing;
        int24 mid = (tick / spacing) * spacing;
        lower = mid - LP_RANGE_SPACINGS * spacing;
        upper = mid + LP_RANGE_SPACINGS * spacing;
    }

    /// @dev The liquidity two amounts can support, taking the side that runs
    ///      out first — so a position never asks for more than we hold.
    function _liquidityFor(uint160 spot, int24 lower, int24 upper, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        uint160 a = TickMath.getSqrtPriceAtTick(lower);
        uint160 b = TickMath.getSqrtPriceAtTick(upper);
        if (spot <= a || spot >= b) return 0; // out of range: one side would go unused

        uint256 l0 = FullMath.mulDiv(amount0, FullMath.mulDiv(spot, b, 1 << 96), b - spot);
        uint256 l1 = FullMath.mulDiv(amount1, 1 << 96, spot - a);
        uint256 l = l0 < l1 ? l0 : l1;
        return l > type(uint128).max ? type(uint128).max : uint128(l);
    }

    /// @dev The pool's price, from where v4 keeps it: `_pools` is slot 6 of
    ///      the PoolManager and a pool's first word packs `sqrtPriceX96` in
    ///      its low 160 bits. Probed against the chain (`docs/recon.md` §1.9).
    function _spotSqrtPrice(IPoolManager.PoolKey memory key) internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,) = _slot0(key);
    }

    function _slot0(IPoolManager.PoolKey memory key) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        bytes32 slot = keccak256(abi.encode(keccak256(abi.encode(key)), uint256(6)));
        (bool ok, bytes memory ret) =
            address(POOL_MANAGER).staticcall(abi.encodeWithSelector(IExtsload.extsload.selector, slot));
        if (!ok || ret.length < 32) return (0, 0);
        uint256 word = uint256(abi.decode(ret, (bytes32)));
        sqrtPriceX96 = uint160(word & ((1 << 160) - 1));
        tick = int24(uint24((word >> 160) & 0xFFFFFF));
    }

    /// @dev `take` of native quote lands here; nothing else is expected.
    receive() external payable {}
}
