// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IERC20,
    IWETH,
    ISwapRouter02,
    IUniswapV3Factory,
    IPonsV2BondingCurve,
    IPonsV2LaunchFactory,
    IPonsV2LauncherToken,
    IPonsV2MemeHookSource,
    IPoolManager
} from "./interfaces/IExternal.sol";
import {TwapFloor} from "./libraries/TwapFloor.sol";

/// @notice The PoolManager's raw storage. v4 keeps no getter for a pool's
///         price; `extsload` is the sanctioned way in.
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

import {TickMath} from "./libraries/TickMath.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @notice The vault of the platform token, seen from here. One function, and
///         it is the one that makes the flywheel real rather than rhetorical.
interface IPlatformVault {
    function fundRewards() external payable returns (uint256);
    /// @notice Recovers a payment that could not go through. The vault pays
    ///         `msg.sender`, so this contract: there is no destination to
    ///         choose.
    function withdraw() external returns (uint256);
    /// @notice Where this vault's stream was sent on, or zero. Written only by
    ///         `FeeVault.migrate`, once, under the timelock.
    function migratedTo() external view returns (address);
}

/// @notice The next Treasury, seen from here. One function, and it refuses any
///         caller that is not the predecessor it declared for itself.
interface ISuccessorTreasury {
    function receiveMigration(uint256 dev, uint256 burn, uint256 lp, uint256 rewards) external payable;
}

/// @title  Treasury
/// @notice Receives the platform's share of every launch and splits it four
///         ways: dev, burn, LP, and the platform token's own rewards.
///
/// @dev    **No gas refunds anywhere here**, unlike the vault cycle. Payd
///         refunded because the HOLDERS' rewards depended on strangers calling;
///         these four pockets pay the platform and the holders of $PLAT, so the
///         platform has every reason to call them itself. Removing the refund
///         removes the faucet at the root instead of bounding it — an action
///         that hands out gas has to be floored, or it is called on dust in a
///         loop for the refund. Nothing is lost if nobody calls: the pockets
///         accumulate.
///
///         Minimums remain, for the other reason: do not pay a swap's fixed
///         cost to move dust.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract Treasury {
    // ----------------------------------------------------------------- errors

    error NotTimelock();
    error NotGenerationKey();
    error NotApproved();
    error AlreadyMigrated();
    error NotPredecessor();
    error SweepNotAllowed(address token);
    error NoPool();
    error ZeroAddress();
    error BadSplit();
    error NothingToDo();
    error BelowMinimum(uint256 have, uint256 need);
    error TooSoon(uint256 ready);
    error NotBound();
    error AlreadyBound();
    error GraduatedNotSupportedYet();
    error TooLittleOut(uint256 got, uint256 floor);
    error TransferFailed();
    error LengthMismatch();

    // ----------------------------------------------------------------- events

    /// @notice The four immutable destinations, written down at birth.
    ///
    /// @dev    They are all `public immutable` and readable at any time — but a
    ///         reader has to know the contract exists to read them. An event
    ///         puts them in the log an indexer already follows, which is what
    ///         makes the deployment reconstructible from the chain alone rather
    ///         than from somebody's word.
    event Wired(address timelock, address devWallet, address generationKey);
    event Split(uint256 toDev, uint256 toBurn, uint256 toLp, uint256 toRewards);
    /// @dev The destination is immutable, and named anyway: an indexer
    ///      reconstructing the flows should not have to read storage to know
    ///      where a `DevPaid` landed.
    event DevPaid(address indexed to, uint256 amount);
    event Burned(uint256 quoteIn, uint256 tokensBurned, uint256 floorUsed);
    event LiquidityAdded(uint256 ethUsed, uint256 tokenUsed, uint128 liquidity);
    event PlatformRewardsFunded(uint256 amount);
    event SplitSet(uint256 dev, uint256 burn, uint256 lp, uint256 rewards);
    event PlatformBound(address token, address curve, address vault);
    /// @notice The rewards pocket follows the vault to where it migrated.
    event PlatformVaultFollowed(address vault);
    event PlatformApproved(address token, address vault);
    event SweepAllowed(address indexed token, uint24 wethFee, uint24 pivotFee);
    event Swept(address indexed token, uint256 amountIn, uint256 ethOut);
    event Collected(address indexed vault, uint256 amount);
    /// @notice Everything went to a successor. One-way, once.
    event TreasuryApproved(address indexed candidate);
    event TreasuryMigrated(address indexed to, uint256 dev, uint256 burn, uint256 lp, uint256 rewards);
    event Pushed(address indexed to, address indexed token, uint256 amount);

    // -------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice How often the burn may run.
    ///
    /// @dev    Four hours, so each purchase is worth its slippage instead of
    ///         being a stream of dust trades that move the price against
    ///         themselves. It is not protecting a gas refund — there is none.
    uint256 public constant BURN_COOLDOWN = 4 hours;

    /// @notice The smallest amount each pocket will move.
    ///
    /// @dev    A swap and a transfer both cost the same whatever they carry.
    ///         Below this the pocket waits, and nothing is lost by waiting.
    uint256 public constant MIN_MOVE = 0.005 ether;

    /// @notice How far the graduated burn lets the price move per cooldown
    ///         elapsed, and the ceiling on that band.
    ///
    /// @dev    **A LIMIT, not a floor, and that distinction is the design.**
    ///         A floor reverts, and a burn that reverts when $PLAT's price
    ///         rises would deadlock exactly when things go well — the
    ///         anchorPrice only updates on success, so it would stay stuck for
    ///         good. A v4 price limit instead makes the swap fill PARTIALLY:
    ///         measured on a graduated Pons pool, a limit 0.1 % under spot
    ///         spent 0.00538 of the 0.05 ETH offered and returned the rest
    ///         (`docs/recon-launchpad.md`).
    ///
    ///         So a burn always runs. If the price moved further than the band,
    ///         it buys what fits, keeps the rest, and the anchorPrice walks
    ///         toward the truth — self-healing rather than blocked.
    ///
    ///         The band widens with the time since the last FULL burn — a
    ///         stale reference deserves less trust, and a run of partial fills
    ///         has to be able to end. It is capped so a long outage cannot
    ///         leave the first burn back completely unguarded.
    uint256 public constant BURN_BAND_BPS = 1_000;
    uint256 public constant BURN_BAND_CAP_BPS = 5_000;

    /// @notice How far the LP's own swap may walk the price, and how wide the
    ///         position is, in tick spacings either side.
    uint256 public constant LP_BAND_BPS = 200;
    int24 public constant LP_RANGE_SPACINGS = 20;

    /// @notice Tolerance on the burn's on-chain floor.
    ///
    /// @dev    Tight on purpose. The bonding curve is `x·y = k` on its reserves
    ///         with 5.00 % taken off the input — measured to the wei on
    ///         2026-09-08 (`docs/recon-launchpad.md`) — and it has no external
    ///         liquidity, so the only thing that can move between reading the
    ///         reserves and buying is another buy in the same window.
    uint256 public constant MAX_SLIPPAGE_BPS = 100;

    /// @notice Tolerance of a third-party token's sweep into ETH, and the
    ///         window of its TWAP.
    ///
    /// @dev    Wider than the curve's (100 bps) because the price comes from a
    ///         pool and not from a formula: it is the same value as the
    ///         basket legs' floor, calibrated on the same pools.
    uint256 public constant MAX_SWEEP_SLIPPAGE_BPS = 300;
    uint32 public constant TWAP_WINDOW = 1_800;

    // ------------------------------------------------------------- immutables

    address public immutable TIMELOCK;
    /// @notice Where the dev share goes. Immutable, and the only pocket of the
    ///         four that leaves the ecosystem — so the only one nobody can
    ///         verify after the fact.
    address public immutable DEV_WALLET;
    /// @notice **The second authority.** A Ledger kept apart from the Safe
    ///         signers, which holds nothing and signs nothing else.
    ///
    /// @dev    It guards the two doors that move value without the destination
    ///         being written into the code: naming the platform token and its
    ///         vault (`bindPlatform`), and migrating this whole contract
    ///         (`migrateTreasury`). It can do NOTHING on its own — it
    ///         authorises, the timelock executes after its 48 h.
    ///
    ///         **What that closes, and what it does not.** No on-chain check
    ///         tells a real vault from a fake one: everything you would read
    ///         from it, it writes. So this makes nothing "legitimate". It turns
    ///         one compromise into two, independent — which is worth something
    ///         only if the key is kept differently from the Safe.
    ///
    ///         **What it replaces.** There used to be an `OPENER` here — the
    ///         Safe — naming the token with no delay, so that no timelock
    ///         operation would sit on launch night's critical path. That
    ///         shortcut has no purpose any more: this contract is EMPTY at
    ///         genesis, since it fills only from the platform share of
    ///         third-party launches, which do not exist yet. Waiting 48 h to
    ///         wire four empty pockets costs nothing, and the $PAYD vault —
    ///         which pays its holders without ever passing through here — runs
    ///         from the first block.
    address public immutable GENERATION_KEY;

    /// @notice The Treasury this one takes over from, or zero.
    ///
    /// @dev    Only `PREDECESSOR` may call `receiveMigration`. That is what
    ///         stops anyone from creating pockets here by calling the takeover
    ///         function with numbers of their own choosing.
    address public immutable PREDECESSOR;
    IPonsV2LaunchFactory public immutable FACTORY;
    IPoolManager public immutable POOL_MANAGER;
    /// @notice Uniswap v3, for sweeping third-party currencies into ETH.
    ///         Nothing else uses them: the buy-and-burn and the liquidity live
    ///         on v4.
    address public immutable ROUTER;
    address public immutable V3_FACTORY;
    address public immutable WETH;
    /// @notice The currency the whole system routes through -- USDG on this
    ///         chain. **The Treasury needs it for the same reason `FeeVault`
    ///         does, and it needed it sooner than anyone noticed.**
    ///
    /// @dev    A vault pays its platform share in ITS OWN currency, and the
    ///         currencies a vault may be quoted in are the ones `Quotelist`
    ///         measured -- against the PIVOT. `sweepToEth` only ever knew the
    ///         way to WETH, and for most of that list there is no `token/WETH`
    ///         pool at all: measured 2026-09-10, ten of the 41 listed quotes
    ///         (IBM, BABA, USO, DELL, PLTR, FIG, PFE, RIVN, UPS, and JNJ whose
    ///         pool has no 30-minute window). The way in and the way out did not
    ///         agree, so ten currencies could be paid to this contract and never
    ///         leave it.
    ///
    ///         The detour reuses the pivot's own pool, which is the deepest on
    ///         the chain and which every ETH-quoted vault already crosses. One
    ///         pool, two uses -- the same argument `FeeVault.QUOTE_WETH_FEE`
    ///         makes in the other direction.
    address public immutable PIVOT;
    /// @notice The tier of the `PIVOT/WETH` pool, the detour's second hop.
    ///         Declared at birth from a measurement, never probed.
    uint24 public immutable PIVOT_WETH_FEE;

    // ------------------------------------------------------------------ state

    // Thirds and sixths: dev and rewards a third each, burn and LP a sixth.
    // "33 / 16.5 / 16.5 / 33" only adds up to 99 % — and `setSplit` demands an
    // EXACT sum of 10 000, so the missing percent has to land somewhere. It is
    // given back to the two thirds rather than to the sixths, which keeps the
    // symmetry that was wanted.
    uint256 public devBps = 3_333;
    uint256 public burnBps = 1_667;
    uint256 public lpBps = 1_667;
    uint256 public rewardsBps = 3_333;

    uint256 public devPool;
    uint256 public burnPool;
    uint256 public lpPool;
    uint256 public rewardsPool;

    address public platformToken;
    IPonsV2BondingCurve public platformCurve;
    /// @notice Where the rewards pocket goes. Named ONCE by `bindPlatform`,
    ///         under the two keys, and afterwards it moves only through
    ///         `followMigration` — which takes no argument and goes only where
    ///         the vault itself declares it went.
    IPlatformVault public platformVault;

    /// @notice The (token, vault) pair the generation key looked at. A hash:
    ///         both together, or neither.
    bytes32 public approvedPlatform;

    /// @notice The Treasury this one sent everything to, or zero. One-way,
    ///         once.
    address public migratedTo;

    /// @notice The tokens the timelock declared sweepable straight to WETH, and
    ///         the tier of the `token/WETH` pool they convert through.
    mapping(address token => uint24) public sweepFee;

    /// @notice The tokens that reach WETH through the PIVOT instead, and the
    ///         tier of the `token/PIVOT` pool. The second hop is
    ///         `PIVOT_WETH_FEE`, the same for all of them.
    ///
    /// @dev    **Exactly one of the two is non-zero**, and neither is guessed at
    ///         the moment the money moves: same rule as `Allocation.poolFee` and
    ///         `quoteListing`. The likeliest mistake is the right token at the
    ///         wrong tier, and probing does not catch it.
    mapping(address token => uint24) public sweepPivotFee;

    /// @notice The Treasury the generation key looked at.
    address public approvedSuccessor;

    uint256 public lastBurnAt;
    /// @notice When a burn last spent its whole pocket.
    ///
    /// @dev    **The band grows from HERE, not from the last burn.** Measuring
    ///         it from the last burn pins it at exactly `BURN_BAND_BPS` for any
    ///         steady cadence — so a price rising faster than the band would
    ///         make every burn fill partially, for ever, and the pocket would
    ///         grow without ever catching up. Growing it from the last FULL
    ///         burn makes consecutive partial fills widen the band until one
    ///         clears. Self-correcting instead of merely self-healing.
    uint256 public lastFullBurnAt;
    /// @notice `sqrtPriceX96` the last graduated burn ended on. The anchorPrice
    ///         the next one is banded against — at least a cooldown old, so
    ///         moving it means holding a moved price for hours, not for a block.
    uint160 public lastBurnSqrtPrice;

    /// @dev Carried across the `unlock` callback, which cannot take arguments
    ///      of our choosing. Deleted at the end of every burn.
    struct Pending {
        IPoolManager.PoolKey key;
        uint256 amount;
        uint160 limit;
        uint256 spent;
        uint256 out;
        /// @dev A burn sends the token straight to the dead address; the LP's
        ///      own swap keeps it here to become half a position.
        bool keepToken;
    }

    Pending private _pending;

    /// @dev Same reason as `Pending`: the unlock callback takes no arguments of
    ///      ours. Only one of the two is ever set.
    struct Adding {
        IPoolManager.PoolKey key;
        int24 lower;
        int24 upper;
        uint128 liquidity;
        uint256 ethUsed;
        uint256 tokenUsed;
    }

    Adding private _adding;
    /// @notice The single position this contract holds, and its range.
    uint128 public lpLiquidity;
    int24 public lpLower;
    int24 public lpUpper;

    uint256 private _lock = 1;

    modifier onlyTimelock() {
        if (msg.sender != TIMELOCK) revert NotTimelock();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert NothingToDo();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @dev Ten addresses do not read positionally. Grouped, you can see what
    ///      you are signing.
    struct Wiring {
        address timelock;
        address devWallet;
        address generationKey;
        /// @dev The Treasury this one takes over from. Zero for the first.
        address predecessor;
        address ponsFactory;
        address poolManager;
        address router;
        address v3Factory;
        address weth;
        address pivot;
        uint24 pivotWethFee;
    }

    /// @dev The sweep list, seeded at birth for the same reason `Payd.Seed`
    ///      exists: **the 48-hour delay protects CHANGES, not the initial
    ///      state.** Without it this contract spends its first two days able to
    ///      be PAID in forty currencies and to spend none of them, while the
    ///      timelock waits out a delay on a list the deployer had just written.
    struct Seed {
        address[] tokens;
        uint24[] wethFees;
        uint24[] pivotFees;
    }

    constructor(Wiring memory w, Seed memory seed) {
        if (
            w.timelock == address(0) || w.devWallet == address(0) || w.generationKey == address(0)
                || w.ponsFactory == address(0) || w.poolManager == address(0) || w.router == address(0)
                || w.v3Factory == address(0) || w.weth == address(0) || w.pivot == address(0) || w.pivotWethFee == 0
        ) revert ZeroAddress();
        TIMELOCK = w.timelock;
        DEV_WALLET = w.devWallet;
        GENERATION_KEY = w.generationKey;
        // Zero on the very first Treasury: it has nobody to take over from, so
        // `receiveMigration` is unreachable for it, for ever.
        PREDECESSOR = w.predecessor;
        FACTORY = IPonsV2LaunchFactory(w.ponsFactory);
        POOL_MANAGER = IPoolManager(w.poolManager);
        ROUTER = w.router;
        V3_FACTORY = w.v3Factory;
        WETH = w.weth;
        PIVOT = w.pivot;
        PIVOT_WETH_FEE = w.pivotWethFee;
        _allowSweeps(seed.tokens, seed.wethFees, seed.pivotFees);
        emit Wired(w.timelock, w.devWallet, w.generationKey);
    }

    /// @dev **Deliberately does nothing but accept.**
    ///
    ///      A child vault pays us through `FeeVault._pay`, which forwards
    ///      **30 000 gas and no more** — a cap that exists so a hostile payee
    ///      cannot burn a vault's gas. Splitting here would need five cold
    ///      storage writes and a call, run out, and the vault would book the
    ///      payment as a deferred debt instead. So the money lands, and
    ///      `_split` runs on the next action that touches it.
    ///
    ///      `PLAN.md` §4 said the dev share was pushed "in the inflow
    ///      transaction". It cannot be, and this is why.
    receive() external payable {}

    // ------------------------------------------------------------- 1. sharing

    /// @notice Allocates everything that has arrived. Permissionless, and run
    ///         automatically by every action below — nobody has to remember it.
    function split() external nonReentrant returns (uint256 allocated) {
        return _split();
    }

    function _split() internal returns (uint256 unallocated) {
        // What is here and belongs to no pocket yet — a launch's payment, a
        // donation, anything. Measuring the BALANCE rather than trusting a
        // parameter is what makes a donation reach the pockets too.
        unallocated = address(this).balance - (devPool + burnPool + lpPool + rewardsPool);
        if (unallocated == 0) return 0;

        uint256 toDev = (unallocated * devBps) / BPS;
        uint256 toBurn = (unallocated * burnBps) / BPS;
        uint256 toLp = (unallocated * lpBps) / BPS;
        // The residue, so not a wei is lost to rounding — and it lands on the
        // pocket that gives stocks back to holders rather than on ours.
        uint256 toRewards = unallocated - toDev - toBurn - toLp;

        devPool += toDev;
        burnPool += toBurn;
        lpPool += toLp;
        rewardsPool += toRewards;

        emit Split(toDev, toBurn, toLp, toRewards);
    }

    // ------------------------------------------------------------- 2. paying

    /// @notice Pays the dev share. Permissionless, immutable destination.
    function payDev() external nonReentrant returns (uint256 amount) {
        if (migratedTo != address(0)) revert AlreadyMigrated();
        _split();
        amount = devPool;
        if (amount < MIN_MOVE) revert BelowMinimum(amount, MIN_MOVE);
        devPool = 0;
        (bool ok,) = DEV_WALLET.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit DevPaid(DEV_WALLET, amount);
    }

    /// @notice Turns the LP pocket into protocol-owned liquidity, itself.
    ///
    /// @dev    **This removes the one point of trust the design had.** The
    ///         share used to go to a Safe that added the liquidity by hand,
    ///         because nobody knew whether the Pons hook let anyone add at all.
    ///         It does — it carries no liquidity callback, and an ordinary
    ///         contract adding to a graduated pool is measured in
    ///         `test/V4Swap.t.sol`.
    ///
    ///         `modifyLiquidity` lives on the PoolManager, so the position
    ///         belongs to THIS CONTRACT, keyed by (owner, ticks, salt). There
    ///         is no NFT, so there is nothing to approve, nothing to transfer
    ///         and nothing to sell: **the liquidity cannot be pulled, because
    ///         no function here removes it.**
    ///
    ///         **It never consumes everything, and it is not supposed to.** A
    ///         position takes two sides in a ratio the price decides, so half
    ///         the ETH is swapped and whatever the ratio leaves over goes back
    ///         to the pocket for next time — the same rule as a skipped leg or
    ///         a burn the limit cut short.
    ///
    ///         **And this position earns no swap fee.** Every graduated Pons
    ///         pool carries `poolFee = 0`, read on-chain on two of them: the
    ///         pool charges nothing and the HOOK takes the fee in `afterSwap`.
    ///         So there is no LP income to collect, and no function here tries
    ///         to.
    ///
    ///         What the liquidity pays instead is better placed: the fee the
    ///         hook takes on a trade goes to the launch's
    ///         `creatorFeeRecipient`, which for $PLAT is its own vault. Deeper
    ///         liquidity therefore means more volume, more creator fees, and
    ///         more stocks for $PLAT holders — it reaches people rather than
    ///         accruing inside a position.
    function addLiquidity() external nonReentrant returns (uint256 ethUsed, uint256 tokenUsed) {
        if (migratedTo != address(0)) revert AlreadyMigrated();
        if (platformToken == address(0)) revert NotBound();
        if (!platformCurve.graduated()) revert GraduatedNotSupportedYet();

        _split();
        uint256 amount = lpPool;
        if (amount < MIN_MOVE) revert BelowMinimum(amount, MIN_MOVE);
        lpPool = 0;

        IPoolManager.PoolKey memory key = _poolKey();
        uint160 spot = _spotSqrtPrice(key);
        if (spot == 0) revert NothingToDo();

        // Half to the token side. The split is approximate on purpose: the
        // exact ratio depends on the range, and chasing it would cost more gas
        // than the remainder is worth.
        uint256 half = amount / 2;
        // **Banded against the same stale anchor as the burn, not against the
        // spot.** `spot` is `slot0`, i.e. the price as this block left it, so a
        // limit derived from it only bounds OUR OWN impact — it says nothing
        // about a price somebody moved in the transaction just before. A
        // sandwich therefore got to set the reference it was about to be
        // measured against. `lastBurnSqrtPrice` is at least a cooldown old, so
        // moving it means holding a moved price for hours.
        //
        // Before the first burn there is nothing to anchor to and the spot is
        // all there is — the same one-off the burn already accepts. The ratio
        // below still reads the real spot: a position's two sides are decided
        // by where the price IS, not by where it was.
        uint160 anchor = lastBurnSqrtPrice != 0 ? lastBurnSqrtPrice : spot;
        _pending = Pending({
            key: key,
            amount: half,
            limit: uint160((uint256(anchor) * (BPS - LP_BAND_BPS)) / BPS),
            spent: 0,
            out: 0,
            keepToken: true
        });
        POOL_MANAGER.unlock("");
        uint256 spentOnToken = _pending.spent;
        uint256 tokenHeld = _pending.out;
        delete _pending;

        uint256 ethHeld = amount - spentOnToken;
        (int24 lower, int24 upper) = _range(key, key.tickSpacing);
        // Stay on the range already opened, so every addition compounds one
        // position instead of scattering several this contract cannot track.
        if (lpLiquidity != 0) {
            lower = lpLower;
            upper = lpUpper;
        }
        uint128 liquidity = _liquidityFor(spot, lower, upper, ethHeld, tokenHeld);
        if (liquidity == 0) {
            // Nothing could be placed: put it all back rather than sit on it.
            lpPool += ethHeld;
            return (0, 0);
        }

        _adding = Adding({key: key, lower: lower, upper: upper, liquidity: liquidity, ethUsed: 0, tokenUsed: 0});
        POOL_MANAGER.unlock("");
        ethUsed = _adding.ethUsed;
        tokenUsed = _adding.tokenUsed;
        delete _adding;

        // One position, one range, for the life of the contract: a second range
        // would leave the first uncollectable, since nothing here remembers
        // more than one.
        lpLiquidity += liquidity;
        lpLower = lower;
        lpUpper = upper;

        // What the ratio did not take comes back. The token side stays here and
        // joins the next round's position.
        lpPool += ethHeld - ethUsed;
        emit LiquidityAdded(ethUsed, tokenUsed, liquidity);
    }

    /// @dev A range around the current tick, aligned on the pool's spacing.
    ///
    ///      The tick is read from `slot0` rather than derived back from the
    ///      price: v4 packs it in the 24 bits just above `sqrtPriceX96`, so it
    ///      is already there and the inverse function is not needed.
    function _range(IPoolManager.PoolKey memory key, int24 spacing) internal view returns (int24 lower, int24 upper) {
        (, int24 tick) = _slot0(key);
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

    // ------------------------------------------------- the hatch that is gone
    //
    // **`withdrawLp` and `LP_SAFE` were removed, and nothing replaced them.**
    // The LP pocket has exactly one exit, `addLiquidity`, and that exit places
    // the money in a position no function here can take back.
    //
    // The hatch existed for the one state `addLiquidity` refuses — before
    // graduation there is no pool to place liquidity in — and it sent the pocket
    // to a Safe so the liquidity could be added by hand. Successive narrowings
    // ("only pre-graduation", "only once the token is named") kept shrinking the
    // window without addressing what it was: **a permanent path from this
    // contract to an address the maintainer controls.** No narrowing fixes that.
    // Deleting it does, and it is the only change that turns "the maintainer
    // will not divert the LP share" from a promise into an absent function.
    //
    // What it costs, stated rather than hidden: if the platform token NEVER
    // graduates, `lpPool` accumulates and there is nothing that spends it —
    // `setSplit` reweights future inflow, not a pocket already allocated. That
    // ETH is then immobilised for good. Accepted: in a world where the platform
    // token never graduates, a sixth of a Treasury nobody filled is not the
    // problem, and the alternative was a door standing open for the lifetime of
    // the contract to cover a failure case.
    //
    // Pre-graduation the pocket simply accumulates, exactly as the burn and
    // rewards pockets already do.

    /// @notice Sends the rewards share into the platform token's own vault,
    ///         where it buys real stocks for $PLAT holders.
    ///
    /// @dev    The biggest of the four pockets, and the only one that hands
    ///         something back to people rather than acting on a price.
    ///         `fundRewards` is payable, permissionless, takes no dev cut and
    ///         no gas cut, and has no way back out — so this is a one-way
    ///         street into somebody else's reserve, which is the point.
    function fundPlatformRewards() external nonReentrant returns (uint256 amount) {
        if (migratedTo != address(0)) revert AlreadyMigrated();
        if (address(platformVault) == address(0)) revert NotBound();
        _split();
        amount = rewardsPool;
        if (amount < MIN_MOVE) revert BelowMinimum(amount, MIN_MOVE);
        rewardsPool = 0;
        platformVault.fundRewards{value: amount}();
        emit PlatformRewardsFunded(amount);
    }

    // -------------------------------------------------------------- 3. burning

    /// @notice Buys $PLAT with the burn pocket and sends it to the dead address.
    ///
    /// @dev    **The floor is computed here, never supplied.** The curve is
    ///         `x·y = k` on its reserves with `creatorTax + curveFee` taken off
    ///         the input — measured against the live curve to the wei
    ///         (`docs/recon-launchpad.md`). Both rates are read on-chain, so
    ///         the expected output is a function of chain state and nothing
    ///         else.
    ///
    ///         That is the whole difference with the registry that rugged on
    ///         this chain: its harvest took `minOut` from its operator, and an
    ///         operator who can pass zero can route the money anywhere
    ///         (`PLAN.md` §10).
    function buyAndBurn() external nonReentrant returns (uint256 burned) {
        if (migratedTo != address(0)) revert AlreadyMigrated();
        if (address(platformCurve) == address(0)) revert NotBound();

        uint256 ready = lastBurnAt + BURN_COOLDOWN;
        if (block.timestamp < ready) revert TooSoon(ready);

        _split();
        uint256 amount = burnPool;
        if (amount < MIN_MOVE) revert BelowMinimum(amount, MIN_MOVE);

        // Since the last FULL burn: a run of partial fills has to widen the
        // band, or a fast rally strands the pocket. The cooldown guarantees at
        // least one period has passed, so the band is never zero — except on
        // the very first burn, where there is no full burn to measure from and
        // a zero band would put the limit exactly ON the price, which v4
        // rejects outright.
        uint256 elapsed = lastFullBurnAt == 0 ? BURN_COOLDOWN : block.timestamp - lastFullBurnAt;
        burnPool = 0;
        lastBurnAt = block.timestamp;

        if (platformCurve.graduated()) {
            // Past graduation the fees come from the v4 hook and the price from
            // a v4 pool. The hook gates nothing — measured, not assumed
            // (`test/V4Swap.t.sol`) — so an ordinary swap works.
            (uint256 spentEth, uint256 out) = _burnOnPool(amount, elapsed);
            burned = out;
            if (spentEth < amount) {
                // The limit bit. What it stopped us from spending goes back to
                // the pocket, and `lastFullBurnAt` stays where it was — so the
                // next band is wider by exactly the time this one waited.
                burnPool += amount - spentEth;
            } else {
                lastFullBurnAt = block.timestamp;
            }
            emit Burned(spentEth, burned, 0);
        } else {
            // On the curve the floor is EXACT: `x·y = k` on its reserves less
            // the 5.00 % taken at the input, measured to the wei.
            uint256 floorOut = _curveFloor(amount);
            if (floorOut == 0) revert NothingToDo();
            burned = platformCurve.buy{value: amount}(amount, floorOut, DEAD);
            if (burned < floorOut) revert TooLittleOut(burned, floorOut);
            // The curve always takes everything: its price is exact.
            lastFullBurnAt = block.timestamp;
            emit Burned(amount, burned, floorOut);
        }
    }

    /// @dev The graduated burn: one v4 swap, bounded by a PRICE LIMIT.
    ///
    ///      There is no oracle for $PLAT — v4 ships none, the Pons hook
    ///      provides none, and a memecoin has no Chainlink feed. `slot0` gives
    ///      the spot, which is manipulable inside a block, so using it as the
    ///      anchorPrice would be StockBound's mistake wearing another hat.
    ///
    ///      The anchorPrice is instead the price the LAST burn ended on, which is
    ///      at least a cooldown old: moving it means holding a moved price for
    ///      hours rather than for one block. The band around it widens with the
    ///      time elapsed, because a stale anchorPrice deserves less trust.
    function _burnOnPool(uint256 amount, uint256 elapsed) internal returns (uint256 spentEth, uint256 out) {
        IPoolManager.PoolKey memory key = _poolKey();

        uint160 anchorPrice = lastBurnSqrtPrice;
        // First burn after graduation: nothing to anchorPrice, so take the pool
        // as it stands. It is the one burn that runs unbanded, and it happens
        // once in the token's life.
        if (anchorPrice == 0) anchorPrice = _spotSqrtPrice(key);
        if (anchorPrice == 0) revert NothingToDo();

        uint256 band = (BURN_BAND_BPS * elapsed) / BURN_COOLDOWN;
        if (band > BURN_BAND_CAP_BPS) band = BURN_BAND_CAP_BPS;
        // Buying the token with ETH walks the price DOWN, so the limit sits
        // below the anchorPrice.
        uint160 limit = uint160((uint256(anchorPrice) * (BPS - band)) / BPS);

        _pending = Pending({key: key, amount: amount, limit: limit, spent: 0, out: 0, keepToken: false});
        POOL_MANAGER.unlock("");

        spentEth = _pending.spent;
        out = _pending.out;
        delete _pending;

        lastBurnSqrtPrice = _spotSqrtPrice(key);
    }

    /// @dev The v4 dance. `settle` what the swap says we owe, `take` what it
    ///      says we are owed, and send the tokens straight to the dead address
    ///      so the Treasury never holds $PLAT for an instant.
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotTimelock();
        if (_adding.liquidity != 0) return _addCallback();

        int256 delta = POOL_MANAGER.swap(
            _pending.key,
            IPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(_pending.amount), sqrtPriceLimitX96: _pending.limit
            }),
            ""
        );

        // Packed BalanceDelta: amount0 high, amount1 low. Negative is owed to
        // the pool, positive is owed to us.
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(int256(uint256(uint128(uint256(delta)))));

        if (amount0 < 0) {
            _pending.spent = uint256(uint128(-amount0));
            POOL_MANAGER.settle{value: _pending.spent}();
        }
        if (amount1 > 0) {
            _pending.out = uint256(uint128(amount1));
            // To the dead address for a burn, to us for a position.
            POOL_MANAGER.take(_pending.key.currency1, _pending.keepToken ? address(this) : DEAD, _pending.out);
        }
        return "";
    }

    /// @dev Settling a position: what the delta says we owe, we pay. Native
    ///      ETH rides with the call; an ERC-20 needs `sync`, a plain transfer,
    ///      then `settle`.
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
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(int256(uint256(uint128(uint256(delta)))));

        // **Both signs, and the positive one is not hypothetical.**
        // `modifyLiquidity` realises the position's accrued FEES in the same
        // delta as the principal. Once the position has earned more on a side
        // than the new liquidity costs there, that side turns positive — and v4
        // reverts the whole `unlock` if any delta is left unsettled. Handling
        // only the negative case would have worked right up until the LP became
        // productive, then failed for good.
        if (amount0 < 0) {
            _adding.ethUsed = uint256(uint128(-amount0));
            POOL_MANAGER.settle{value: _adding.ethUsed}();
        } else if (amount0 > 0) {
            // ETH fees land as a plain balance, so the next `_split` sees them
            // as unallocated and shares them across the four pockets. The LP's
            // earnings re-enter the system instead of pooling in a corner.
            _adding.ethUsed = uint256(uint128(amount0));
            POOL_MANAGER.take(address(0), address(this), _adding.ethUsed);
        }

        if (amount1 < 0) {
            _adding.tokenUsed = uint256(uint128(-amount1));
            POOL_MANAGER.sync(_adding.key.currency1);
            if (!IERC20(platformToken).transfer(address(POOL_MANAGER), _adding.tokenUsed)) revert TransferFailed();
            POOL_MANAGER.settle();
        } else if (amount1 > 0) {
            // Token fees stay here and become half of the next position.
            _adding.tokenUsed = uint256(uint128(amount1));
            POOL_MANAGER.take(_adding.key.currency1, address(this), _adding.tokenUsed);
        }
        return "";
    }

    /// @dev The pool's price, from where v4 keeps it: `_pools` is slot 6 of the
    ///      PoolManager and a pool's first word packs `sqrtPriceX96` in its low
    ///      160 bits. Probed against the chain, not read off a layout document
    ///      (`docs/recon-launchpad.md`).
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

    function _poolKey() internal view returns (IPoolManager.PoolKey memory key) {
        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(platformToken);
        if (l.pairToken != address(0)) revert NotBound();
        key = IPoolManager.PoolKey({
            currency0: address(0), // native ETH always sorts first
            currency1: platformToken,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: IPonsV2MemeHookSource(address(FACTORY)).memeHook()
        });
    }

    /// @dev What `amount` of ETH must buy at the curve's current state, less a
    ///      tight tolerance. Zero when the state cannot be read, which stops
    ///      the burn rather than letting it run blind.
    function _curveFloor(uint256 amount) internal view returns (uint256) {
        (uint256 quoteReserve, uint256 tokenReserve) = platformCurve.getReserves();
        if (quoteReserve == 0 || tokenReserve == 0) return 0;

        uint256 feeBps = _totalFeeBps();
        if (feeBps == 0 || feeBps >= BPS) return 0;

        uint256 eff = (amount * (BPS - feeBps)) / BPS;
        uint256 out = (tokenReserve * eff) / (quoteReserve + eff);
        return (out * (BPS - MAX_SLIPPAGE_BPS)) / BPS;
    }

    /// @dev The creator tax plus the curve fee — the 5.00 % a trader pays,
    ///      read from the launch record and the launch config rather than
    ///      assumed. Zero if either read fails, which the caller treats as
    ///      "do not burn".
    function _totalFeeBps() internal view returns (uint256) {
        uint256 tax = FACTORY.getLaunchedToken(platformToken).creatorTaxBps;
        (bool ok, bytes memory ret) =
            address(FACTORY).staticcall(abi.encodeWithSelector(bytes4(0x1cad862d), uint256(0)));
        if (!ok || ret.length < 64) return 0;
        (, uint256 curveFee) = abi.decode(ret, (uint256, uint256));
        if (curveFee == 0) return 0;
        return tax + curveFee;
    }

    // -------------------------------------------------------------- 4. wiring

    /// @notice The generation key looks at a (token, vault) PAIR.
    ///
    /// @dev    Both together or neither: naming the right token with the wrong
    ///         vault would send a third of everything that enters here to an
    ///         address somebody chose, and naming the right vault with the
    ///         wrong token would make the buy-and-burn buy somebody else's
    ///         token. Hashing the pair makes one inseparable from the other.
    ///
    ///         Overwritable for as long as the timelock has not executed: the
    ///         key can correct a mistake, not only make one.
    function approvePlatform(address token, address vault) external {
        if (msg.sender != GENERATION_KEY) revert NotGenerationKey();
        approvedPlatform = keccak256(abi.encode(token, vault));
        emit PlatformApproved(token, vault);
    }

    /// @notice Names the platform token and its holders' vault. **Two keys,
    ///         once, and for good.**
    ///
    /// @dev    Chicken and egg: $PLAT is launched on Pons through the platform,
    ///         so its address cannot be known when this contract is deployed.
    ///         Until it is, the four pockets simply accumulate — `payDev` works
    ///         throughout, its destination having been written at birth.
    ///
    ///         **What this call decides, and why it is worth two keys.** The
    ///         token decides what the buy-and-burn destroys and which pool the
    ///         liquidity joins: two actions on a PRICE. The vault decides who
    ///         receives a third of everything this contract will ever hold, in
    ///         ETH, on a `call`. No check makes the second one safe in one
    ///         transaction, because everything you would read from that vault
    ///         is written by that vault — and `docs/recon.md` §1.2 establishes
    ///         that ANY contract can be a Pons launch's `creatorFeeRecipient`.
    ///         So it is not a mis-aiming risk, it is an exit, and what closes
    ///         it is not an `if`: it is the timelock AND the Ledger, neither
    ///         being enough.
    ///
    ///         The on-chain checks remain, and they rule out the typo: a real
    ///         Pons launch, its curve, and a vault that really is where its
    ///         fees go.
    function bindPlatform(address token, address vault) external onlyTimelock {
        if (migratedTo != address(0)) revert AlreadyMigrated();
        if (platformToken != address(0)) revert AlreadyBound();
        if (token == address(0) || vault == address(0)) revert ZeroAddress();
        if (keccak256(abi.encode(token, vault)) != approvedPlatform) revert NotApproved();

        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(token);
        // A real Pons launch, with its curve — the buy-and-burn buys on it.
        // And `vault` must be the address its fees REALLY go to, or the biggest
        // pocket would feed a contract with nothing to do with this token.
        if (!l.exists || l.curve == address(0) || l.creatorFeeRecipient != vault) revert NotBound();

        platformToken = token;
        platformCurve = IPonsV2BondingCurve(l.curve);
        platformVault = IPlatformVault(vault);
        emit PlatformBound(token, l.curve, vault);
    }

    /// @notice Follows the platform vault to where it migrated.
    ///         **Permissionless, and it takes no argument.**
    ///
    /// @dev    `FeeVault.migrate` moves a vault's stream to its successor and
    ///         writes `migratedTo` on the old one. Without this function the
    ///         rewards pocket would keep feeding the retired vault: holders
    ///         would still be paid — `fundRewards` and `buyBasket` work on a
    ///         migrated vault — but through its old basket and its old
    ///         Distributor, so two snapshot pipelines for one token, for ever.
    ///
    ///         **It adds no trust, and that is the condition for it to exist.**
    ///         The only reachable destination is the one the current vault
    ///         declares itself, and `migratedTo` is written only by `migrate` —
    ///         timelock, 48 h, six checks. No argument here: calling this
    ///         function is not a choice, it is an update.
    ///
    ///         The read DEGRADES: nothing forces the destination to be one of
    ///         our vaults, and a high-level call to a codeless address reverts
    ///         with no data. It answers "nothing to do" rather than becoming a
    ///         wall.
    function followMigration() external returns (address to) {
        (bool ok, bytes memory ret) =
            address(platformVault).staticcall(abi.encodeWithSelector(IPlatformVault.migratedTo.selector));
        if (!ok || ret.length < 32) revert NothingToDo();
        to = abi.decode(ret, (address));
        if (to == address(0)) revert NothingToDo();
        platformVault = IPlatformVault(to);
        emit PlatformVaultFollowed(to);
    }

    // ---------------------------------------- 5. third-party currencies

    /// @notice Declares tokens sweepable, and the route each converts through.
    ///
    /// @dev    **The route is measured, never guessed.** Same rule as
    ///         `Allocation.poolFee` and `quoteListing`: the likeliest mistake
    ///         is the right token at the wrong tier, and probing does not catch
    ///         it. The timelock declares what `MeasureRoutes` told it.
    ///
    ///         **One row, one route.** `wethFee` names a `token/WETH` pool;
    ///         `pivotFee` names a `token/PIVOT` pool whose second hop is
    ///         `PIVOT_WETH_FEE`. Both non-zero would be this contract choosing
    ///         in place of whoever did the measuring. **Both zero delists**,
    ///         which is the only way back out of this list and is why it is not
    ///         an error.
    ///
    ///         A batch, and not for gas: the list is forty rows long, and the
    ///         timelock pays 48 hours per OPERATION. One call is one wait.
    ///
    ///         Class (b): it moves nothing and chooses no destination. What it
    ///         authorises ends up in this contract.
    function allowSweeps(address[] calldata tokens, uint24[] calldata wethFees, uint24[] calldata pivotFees)
        external
        onlyTimelock
    {
        _allowSweeps(tokens, wethFees, pivotFees);
    }

    /// @dev The body, shared by the vote and by the constructor's seed.
    function _allowSweeps(address[] memory tokens, uint24[] memory wethFees, uint24[] memory pivotFees) internal {
        uint256 n = tokens.length;
        if (wethFees.length != n || pivotFees.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            if (tokens[i] == address(0) || tokens[i] == WETH) revert SweepNotAllowed(tokens[i]);
            // Both routes at once, or the pivot routed through itself -- a path
            // of `PIVOT, fee, PIVOT` that no pool can serve.
            if (wethFees[i] != 0 && pivotFees[i] != 0) revert SweepNotAllowed(tokens[i]);
            if (tokens[i] == PIVOT && pivotFees[i] != 0) revert SweepNotAllowed(tokens[i]);
            // **And never NEITHER: a route may be repointed, never removed.**
            //
            // `Payd._requireSweepable` makes the registry refuse a quote this
            // list does not carry, so the way out exists before the way in. The
            // inverse had no guard at all: zeroing both tiers here, on a
            // currency whose vaults are already live and already paying us,
            // closes the way out AFTER the way in — and those vaults are
            // stamped with their quote for life, so they keep paying in a
            // currency that can no longer leave. It would not revert. It would
            // accumulate.
            //
            // Repointing stays open, which is the operation that actually comes
            // up: a pool that dries out is replaced by naming another tier. The
            // only thing forbidden is naming none, and a stale route costs
            // nothing — `sweepToEth` reverts `NoPool` and the money waits.
            if (wethFees[i] == 0 && pivotFees[i] == 0) revert SweepNotAllowed(tokens[i]);
            sweepFee[tokens[i]] = wethFees[i];
            sweepPivotFee[tokens[i]] = pivotFees[i];
            emit SweepAllowed(tokens[i], wethFees[i], pivotFees[i]);
        }
    }

    /// @notice Converts a token that landed here into ETH. **Permissionless,
    ///         no destination in the arguments.**
    ///
    /// @dev    **The hole this plugs, and it was a big one.** `FeeVault._pay`
    ///         sends the platform share in the VAULT'S OWN CURRENCY: a
    ///         USDG-quoted vault pays in USDG, an NVDA-quoted vault pays in
    ///         NVDA. But this contract only ever understood ETH — `_split`
    ///         measures `address(this).balance`, and there is no withdrawal.
    ///         Those tokens were lost, permanently. Measured 2026-09-08: 40.9 %
    ///         of Pons volume is ETH-quoted, 22.0 % USDG and 37.2 % stock
    ///         tokens — so ~59 % of the platform's revenue was landing in a
    ///         contract unable to see it.
    ///
    ///         The ETH obtained belongs to no pocket: the next `_split` sees it
    ///         as unallocated and shares it four ways, exactly like a donation.
    ///
    ///         The floor comes from the declared pool's 30-minute TWAP, less
    ///         the same tolerance as the rest of the system. The caller may
    ///         TIGHTEN it with `minOut`, never loosen it: a hostile caller can
    ///         only make their own transaction fail.
    function sweepToEth(address token, uint256 minOut) external nonReentrant returns (uint256 ethOut) {
        if (token == WETH) revert SweepNotAllowed(token);

        uint256 amountIn = IERC20(token).balanceOf(address(this));
        if (amountIn == 0 || amountIn > type(uint128).max) revert NothingToDo();

        (bytes memory path, uint256 floorOut) = _sweepRoute(token, uint128(amountIn));
        floorOut = (floorOut * (BPS - MAX_SWEEP_SLIPPAGE_BPS)) / BPS;
        if (floorOut == 0) revert NothingToDo();
        if (minOut > floorOut) floorOut = minOut;

        IERC20(token).approve(ROUTER, amountIn);
        uint256 wethOut = ISwapRouter02(ROUTER)
            .exactInput(
                ISwapRouter02.ExactInputParams({
                path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: floorOut
            })
            );
        // The pockets are in native ETH, not WETH.
        IWETH(WETH).withdraw(wethOut);
        ethOut = wethOut;
        emit Swept(token, amountIn, ethOut);
    }

    /// @dev The declared route and the floor it implies. Its own function for
    ///      the stack, and because the choice between the two paths is the whole
    ///      of what changed here.
    ///
    ///      **One tolerance, two hops.** The detour pays two pool fees where the
    ///      direct route pays one, and the floor does not know it -- it comes
    ///      from the TWAP, which is a price and not a cost. At 300 bps the
    ///      margin covers 1 % + 0.01 % comfortably; it is up to the timelock not
    ///      to declare a route whose two tiers eat it, and the pivot hop it
    ///      lands on is the deepest pool on the chain. The same sentence
    ///      `FeeVault._route` writes about the mirror-image detour.
    function _sweepRoute(address token, uint128 amountIn) internal view returns (bytes memory path, uint256 floorOut) {
        uint24 direct = sweepFee[token];
        uint24 viaPivot = sweepPivotFee[token];
        if (direct == 0 && viaPivot == 0) revert SweepNotAllowed(token);

        if (direct != 0) {
            address pool = IUniswapV3Factory(V3_FACTORY).getPool(token, WETH, direct);
            if (pool == address(0)) revert NoPool();
            floorOut = TwapFloor.quoteAtTick(TwapFloor.meanTick(pool, TWAP_WINDOW), amountIn, token, WETH);
            path = abi.encodePacked(token, direct, WETH);
        } else {
            address poolA = IUniswapV3Factory(V3_FACTORY).getPool(token, PIVOT, viaPivot);
            address poolB = IUniswapV3Factory(V3_FACTORY).getPool(PIVOT, WETH, PIVOT_WETH_FEE);
            if (poolA == address(0) || poolB == address(0)) revert NoPool();
            floorOut = TwapFloor.quoteTwoHops(poolA, token, PIVOT, poolB, WETH, amountIn, TWAP_WINDOW);
            path = abi.encodePacked(token, viaPivot, PIVOT, PIVOT_WETH_FEE, WETH);
        }
    }

    /// @notice Recovers a payment a vault could not make to us.
    ///
    /// @dev    The other face of the same problem. If a vault's ERC-20
    ///         `transfer` fails, the amount falls into its `pendingWithdrawal`
    ///         under this contract's name, recoverable through `withdraw()` —
    ///         which only this contract may call, and it had no function to do
    ///         so. Stuck there too.
    ///
    ///         Permissionless, and with no destination: the vault pays
    ///         `msg.sender`, which is us.
    function collectFrom(address vault) external nonReentrant returns (uint256 amount) {
        amount = IPlatformVault(vault).withdraw();
        emit Collected(vault, amount);
    }

    // -------------------------------------------------------- 6. succession

    /// @notice The generation key looks at a successor Treasury.
    function approveTreasury(address candidate) external {
        if (msg.sender != GENERATION_KEY) revert NotGenerationKey();
        approvedSuccessor = candidate;
        emit TreasuryApproved(candidate);
    }

    /// @notice **Sends everything to a successor.** Two keys, once, one-way.
    ///
    /// @dev    **This is the only function in the system that moves funds to an
    ///         address somebody names, and it has to be said that way.** It
    ///         exists because this contract has no withdrawal: if a defect made
    ///         it unusable, everything it holds would be lost, and the vaults
    ///         already created would keep paying it for ever — their `PLATFORM`
    ///         is written at their birth. The door limits the bleeding; it is
    ///         also, by construction, a door.
    ///
    ///         Three locks, and none of them pretends to make the destination
    ///         "legitimate":
    ///
    ///           1. **two keys.** The timelock with its 48 public hours, plus
    ///              the generation Ledger. Neither is enough;
    ///           2. **once, one-way.** With `migratedTo` written, this contract
    ///              can never send anywhere else;
    ///           3. **the destination must be expecting you.** It must expose
    ///              `receiveMigration` AND carry this contract as its immutable
    ///              `PREDECESSOR`. An EOA or a mistyped address is refused by
    ///              construction — which does not exclude a contract written
    ///              for the occasion, and that is why there are two keys.
    ///
    ///         **The liquidity position does not follow, and that is
    ///         deliberate.** Moving it would require a `removeLiquidity`, that
    ///         is, turning "nobody can pull the liquidity" into "nobody except
    ///         two keys". It loses nothing by staying: it keeps providing depth
    ///         in $PLAT's pool. The successor opens its own beside it.
    function migrateTreasury(address to) external onlyTimelock nonReentrant {
        if (migratedTo != address(0)) revert AlreadyMigrated();
        if (to == address(0)) revert ZeroAddress();
        if (to != approvedSuccessor) revert NotApproved();

        _split();
        uint256 d = devPool;
        uint256 b = burnPool;
        uint256 l = lpPool;
        uint256 r = rewardsPool;
        devPool = 0;
        burnPool = 0;
        lpPool = 0;
        rewardsPool = 0;
        migratedTo = to;

        ISuccessorTreasury(to).receiveMigration{value: address(this).balance}(d, b, l, r);
        emit TreasuryMigrated(to, d, b, l, r);
    }

    /// @notice Forwards whatever arrives AFTER the migration. **Permissionless,
    ///         and the destination is not chosen: it is `migratedTo`.**
    ///
    /// @dev    The vaults already created pay this contract for ever — their
    ///         `PLATFORM` is immutable, and that is what guarantees a creator
    ///         the platform will not re-point itself at their expense. Without
    ///         this function, everything they pay after a migration would sit
    ///         stranded here.
    ///
    ///         `token == address(0)` pushes the ETH, otherwise the token.
    function pushAll(address token) external nonReentrant returns (uint256 amount) {
        address to = migratedTo;
        if (to == address(0)) revert NothingToDo();
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount == 0) revert NothingToDo();
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            amount = IERC20(token).balanceOf(address(this));
            if (amount == 0) revert NothingToDo();
            if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        }
        emit Pushed(to, token, amount);
    }

    /// @notice Takes over what a predecessor sends, pockets included.
    ///
    /// @dev    Reserved to `PREDECESSOR`, written in the constructor. Without
    ///         that lock, anyone could manufacture pockets here with a split of
    ///         their own choosing.
    ///
    ///         The sum must add up: we never credit more than what arrived.
    function receiveMigration(uint256 dev, uint256 burn, uint256 lp, uint256 rewards) external payable {
        if (msg.sender != PREDECESSOR || PREDECESSOR == address(0)) revert NotPredecessor();
        if (dev + burn + lp + rewards > msg.value) revert BadSplit();
        devPool += dev;
        burnPool += burn;
        lpPool += lp;
        rewardsPool += rewards;
        // The remainder — what the predecessor held without having allocated
        // it — stays unallocated here, and the next `_split` shares it four
        // ways.
    }

    /// @notice Reweights the four pockets. 48 hours of notice, like everything
    ///         — and **the dev share only ever turns one way.**
    ///
    /// @dev    Without the ratchet, `setSplit(10_000, 0, 0, 0)` is a legal
    ///         partition: two timelock operations and every wei that ever
    ///         reaches this contract belongs to the dev pocket. These four
    ///         weights were the last thing in the system that could be pointed
    ///         at us, and a promise that the dev takes a third is worth exactly
    ///         what its ceiling is worth.
    ///
    ///         So `devBps` may fall and may never rise. Same shape as
    ///         `FeeVault.setRewardsBps` on the creator's side: the number a
    ///         reader saw when they arrived can only ever improve for them.
    ///         Rebalancing burn / LP / rewards among themselves stays entirely
    ///         open, which is what the setting was actually for.
    function setSplit(uint256 dev, uint256 burn, uint256 lp, uint256 rewards) external onlyTimelock {
        if (dev + burn + lp + rewards != BPS) revert BadSplit();
        if (dev > devBps) revert BadSplit();
        devBps = dev;
        burnBps = burn;
        lpBps = lp;
        rewardsBps = rewards;
        emit SplitSet(dev, burn, lp, rewards);
    }
}
