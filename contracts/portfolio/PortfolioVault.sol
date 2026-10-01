// SPDX-License-Identifier: MIT
//
//         ○   ○
//          ╲ ╱               P A Y D
//         ╭─┴─╮
//        ╱     ╲             Creator fees buy tokenised equities for a token's holders.
//       │       │            No staking, no sign-up, nothing to approve.
//        ╲_____╱             paydprotocol.eth  ·  https://paydprotocol.eth.limo  ·  x.com/PaydRH
//
pragma solidity 0.8.26;

import {BaseModeVault} from "../modes/BaseModeVault.sol";
import {V2Legs} from "../distribution/v2/V2Legs.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";
import {IDistributor, IERC20, ISwapRouter02, IUniswapV3Factory} from "../interfaces/IExternal.sol";
import {TwapFloor} from "../libraries/TwapFloor.sol";

/// @title  PortfolioVault — the personal-portfolio mode's vault
///
/// @notice It converts the holders' share into the **pivot** and stops there.
///         Which stocks each holder ends up with is decided by that holder, in
///         `PortfolioBook`, and executed by `PortfolioDistributor` at delivery.
///
/// @dev    **Why this mode does not buy a basket, stated once.** `FeeVault`
///         buys ONE basket per purchase, bounded at `MAX_BASKET = 8`, and the
///         platform allows around 46 stocks. So "the vault buys what the
///         holders asked for" and "a holder chooses freely" cannot both hold:
///         the aggregate of free choices routinely spans more than eight lines.
///         The first version of this mode made the vault buy the aggregate and
///         had to move the vault's timelock seat to reweight the basket every
///         thirty minutes; it was abandoned, because converting at DELIVERY
///         keeps the freedom whole AND needs no new power at all.
///
///         **What that makes this contract**: `BaseModeVault` — the platform's
///         half, inherited verbatim: the Pons claim, the three-way split, the
///         bounty and its cap, `migrate` and the reserve it carries — plus one
///         `payout()`. That is `FeeVault.buyBasket` with the legs deleted: the
///         same window, the same held-back reserve, the same `payoutBps`
///         pacing, the same first hop, and then `fundWindow` with a single
///         pivot line instead of up to eight stock ones.
///
///         **`_toPivot` and `_route` are ported from `FeeVault` deliberately
///         unchanged.** They are the money path and the pivot is a crossroads,
///         not a wall: a quote with no pivot pool is reached by
///         `QUOTE -> WETH -> PIVOT`, which is what makes COIN and cbBTC
///         servable. Porting them rather than narrowing them is what lets this
///         mode serve every quote the default one serves — 100 % of Pons
///         volume and not the 22 % a pivot-only version would have reached. The
///         template omits them to save bytes and says so; this mode has 11 kB
///         of margin and no reason to.
///
///         **A fix landing in `FeeVault._toPivot` or `_route` has to be carried
///         here**, and `test/PortfolioMode.t.sol` is what says whether it was.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract PortfolioVault is BaseModeVault {
    error BadPayoutRate();
    error BelowMinBuy(uint256 have, uint256 need);
    error MinOutZero();
    error NoPool();

    /// @notice The TWAP window every floor on this path is read over. `FeeVault`'s.
    uint32 public constant TWAP_WINDOW = 1_800;
    /// @notice Tolerance against the oracle floor. `FeeVault`'s.
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice The absolute size of one conversion, in units of the floor.
    ///         `FeeVault`'s, and for its reason: the fraction smooths and the
    ///         floor lifts a small vault off the ground, but neither bounds how
    ///         much one call moves, and price impact is a function of that.
    uint256 public constant MAX_BUY_MULTIPLE = 40;

    uint256 public constant MIN_PAYOUT_BPS = 10;
    uint256 public constant MAX_PAYOUT_BPS = 1_000;

    /// @notice What the reserve holds back so a refund is always payable, as a
    ///         gas figure rather than an amount.
    ///
    /// @dev    **It used to hold `MAX_REFUND` — the CEILING of a refund, not
    ///         its cost — and the two are three orders of magnitude apart.**
    ///         Measured 2026-09-22: `payout()` is 352,341 gas
    ///         (`test_TheVaultConvertsToThePivotAndCreditsTheWindow` prints it)
    ///         and the chain's basefee is 0.0574 gwei, so one refund costs
    ///         0.0000202 ether. `MAX_REFUND` is 0.01 — **495 times** that, all
    ///         of it frozen.
    ///
    ///         Frozen matters because it compounds with the purchase floor: a
    ///         vault must hold `MAX_REFUND + MIN_BUY_QUOTE` before it can spend
    ///         anything at all, and the live $PAYD vault is sitting in exactly
    ///         that state — 0.0154 ether of rewards, 0.01 unreachable, and a
    ///         keeper logging "reserve short of the floor, letting it build"
    ///         every minute.
    ///
    ///         `block.basefee` is what `_refundAmount` prices in, so the
    ///         reserve and the refund move together and cannot drift apart.
    ///         The margin covers the basefee rising between the reserve being
    ///         computed and the next call paying out; past 54x today's gas the
    ///         cap takes over and the old behaviour returns, which is the safe
    ///         direction to degrade in.
    ///
    ///         **Not carried into `FeeVault` or `FeeVaultV2`**, deliberately:
    ///         their implementations are deployed, `verify/` holds the standard
    ///         JSON that matches that bytecode, and editing the source would
    ///         make the repository describe a build nothing on-chain runs. It
    ///         reaches them through a new implementation or not at all.
    uint256 internal constant REFUND_RESERVE_GAS = 400_000;
    uint256 internal constant REFUND_RESERVE_MARGIN = 8;

    /// @notice V2's burn and locked-LP legs, one `V2Legs` per vault, funded in
    ///         QUOTE out of every conversion. Zero when the launch asked for
    ///         none, and then this mode costs one SLOAD for being able to.
    ///
    /// @dev    **This mode nearly shipped without them, and the reason is worth
    ///         recording.** Every other mode clones the deployed `FeeVaultV2`,
    ///         which carries the legs; this one is built on `BaseModeVault`
    ///         because it buys no basket — and in leaving three quarters of
    ///         `FeeVault` behind it left the legs too, silently, without anyone
    ///         deciding that a creator who wants their holders to choose must
    ///         give up buy-and-burn. They do not conflict: the legs take their
    ///         slice of the QUOTE, before the pivot hop, and `payout()` converts
    ///         what is left.
    address public LEGS;
    /// @dev No getter: the getter is bytes, and `V2Legs.burnBps + lpBps` says
    ///      the same thing from the contract that spends it.
    uint256 internal legsBps;
    /// @notice The ceiling on the legs' slice, `FeeVaultV2`'s and for its
    ///         reason: half the holders' share is already a lot to route
    ///         somewhere they did not ask for. Enforced HERE and not only at
    ///         the factory, because this is the contract the money moves
    ///         through.
    uint256 internal constant MAX_LEGS_BPS = 5_000;

    /// @notice How much of the reserve one conversion spends. Seeded at
    ///         `FeeVault`'s 4 %, bounded the same way, timelock-only.
    uint256 public payoutBps;

    event Converted(uint256 indexed toEpoch, uint256 spent, uint256 pivotOut);

    /// @notice This mode's slice of `init`.
    ///
    /// @dev    **The basket is the DEFAULT portfolio, not a purchase.** It is
    ///         handed to `PortfolioBook` by the factory in the same
    ///         transaction; this vault never reads it and never buys it. It may
    ///         be empty, which means "a holder who declares nothing is paid in
    ///         the pivot" — a coherent launch.
    function _initMode(VaultTypes.Allocation[] memory, bytes memory modeData) internal override {
        payoutBps = 400; // 4 % per window, `FeeVault`'s seed

        // **What arrives here is the BOOTSTRAP's `modeData`, not the
        // creator's.** The creator's is `(burnBps, lpBps)` and the factory
        // decodes it; what it hands down is the legs clone's address and their
        // combined weight, because the vault cannot learn an address from two
        // numbers. Empty is legal and means a launch with no legs at all —
        // which is every launch that passed no `modeData` of its own.
        if (modeData.length == 0) return;
        (address legs, uint256 legsBps_) = abi.decode(modeData, (address, uint256));
        if (legsBps_ > MAX_LEGS_BPS || (legsBps_ != 0 && legs == address(0))) revert BadSplit();
        LEGS = legs;
        legsBps = legsBps_;
    }

    /// @notice Converts a slice of the holders' reserve into the pivot and
    ///         credits it to the Distributor as one window.
    ///
    /// @dev    Permissionless and self-funding, like every other cycle action:
    ///         a wei refund on an ether vault, the in-kind bounty otherwise.
    function payout() external nonReentrant returns (uint256 pivotOut) {
        uint256 g0 = gasleft();

        // The window is every epoch the Distributor has not been paid for, up
        // to the last one that has finished. It refuses an empty window itself.
        uint256 cur = IDistributor(DISTRIBUTOR).currentEpoch();
        if (cur == 0) revert NothingToDo();
        uint256 toEpoch = cur - 1;
        if (toEpoch < IDistributor(DISTRIBUTOR).nextEpoch()) revert NothingToDo();

        uint256 spent = _slice();
        // The legs take their slice of every conversion, in QUOTE, BEFORE the
        // pivot hop — `FeeVaultV2.buyBasket`'s own order, for its own reason:
        // burn and locked LP act on the token's own pool, so converting their
        // share into the pivot first would be a round trip that costs two pool
        // fees to end up where it started.
        spent -= _fundLegs(spent);
        pivotOut = _toPivot(spent);
        if (pivotOut == 0) revert NothingToDo();

        // ONE line, and it is the pivot. `quoteSpent` is what the vault spent
        // in its OWN currency, which is what the eligibility floor is a formula
        // over — the same semantics `_buyLegs` gives it.
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory spentArr = new uint256[](1);
        stocks[0] = PIVOT;
        amounts[0] = pivotOut;
        spentArr[0] = spent;
        IERC20(PIVOT).approve(DISTRIBUTOR, 0);
        if (!IERC20(PIVOT).transfer(DISTRIBUTOR, pivotOut)) revert TransferFailed();
        IDistributor(DISTRIBUTOR).fundWindow(toEpoch, stocks, amounts, spentArr);
        emit Converted(toEpoch, spent, pivotOut);

        uint256 refund = QUOTE == address(0) ? _refundAmount(g0) : _bounty(spent);
        if (refund > spent) refund = spent;
        if (refund > rewardsPool) refund = rewardsPool;
        if (refund != 0) {
            rewardsPool -= refund;
            _pay(msg.sender, refund, true);
        }
    }

    // ------------------------------------------------------------- timelock

    /// @notice Sets the conversion pace. It never changes where funds go nor
    ///         their total, and `MIN_PAYOUT_BPS` stops it being used to freeze
    ///         the mode.
    function setPayoutBps(uint256 bps) external onlyTimelock {
        if (bps < MIN_PAYOUT_BPS || bps > MAX_PAYOUT_BPS) revert BadPayoutRate();
        payoutBps = bps;
    }

    // ------------------------------------------------------------ internals

    /// @dev What one call spends, and every line of it is `buyBasket`'s. Its
    ///      own function so `payout`'s locals fit — the `via_ir` remedy used
    ///      throughout (see CLAUDE.md §Build).
    function _slice() internal returns (uint256 spent) {
        uint256 pool = rewardsPool;
        // The reserve exists to have a refund left to pay, so it holds ONE
        // back: what a refund costs at this block's gas on an ether vault, and
        // `MIN_BUY_QUOTE` in kind, where there is no oracle on this path and no
        // way to price gas in NVDA.
        uint256 held = QUOTE == address(0) ? _refundReserve() : MIN_BUY_QUOTE;
        if (pool <= held) revert NothingToDo();
        uint256 free = pool - held;

        // The fraction SMOOTHS when there is plenty, the floor spends more when
        // there is little, and the cap bounds the absolute size. Below the
        // floor nothing is stranded, only deferred.
        spent = (free * payoutBps) / BPS;
        if (spent < MIN_BUY_QUOTE) spent = MIN_BUY_QUOTE;
        uint256 cap = MIN_BUY_QUOTE * MAX_BUY_MULTIPLE;
        if (spent > cap) spent = cap;
        if (spent > free) revert BelowMinBuy(free, MIN_BUY_QUOTE);
        rewardsPool = pool - spent;
    }

    /// @dev One refund, at this block's gas, bounded by the ceiling one can
    ///      ever be. See `REFUND_RESERVE_GAS`.
    function _refundReserve() internal view returns (uint256 held) {
        held = REFUND_RESERVE_GAS * block.basefee * REFUND_RESERVE_MARGIN;
        if (held > MAX_REFUND) held = MAX_REFUND;
    }

    /// @dev The legs' slice, in QUOTE. `FeeVaultV2._fundLegs`, with `_send`
    ///      where V2 has its own `_sendQuote` — the same call, and the generic
    ///      one is already on `BaseModeVault`.
    ///
    ///      A zero rate costs one SLOAD and a return, so a launch with no legs
    ///      pays almost nothing for the mode being able to carry them. No event
    ///      here: the legs emit `Funded` on the same amount in the same
    ///      transaction.
    function _fundLegs(uint256 spent_) internal returns (uint256 total) {
        total = (spent_ * legsBps) / BPS;
        if (total == 0) return 0;
        if (QUOTE == address(0)) {
            V2Legs(payable(LEGS)).fund{value: total}(total);
        } else {
            if (!_send(QUOTE, LEGS, total)) revert TransferFailed();
            V2Legs(payable(LEGS)).fund(total);
        }
    }

    /// @dev `FeeVault._toPivot`, ported unchanged. See the contract NatSpec.
    function _toPivot(uint256 amountIn) internal returns (uint256 pivot) {
        address quote = QUOTE;
        if (quote == PIVOT) {
            pivot = amountIn;
        } else {
            if (amountIn > type(uint128).max) revert MinOutZero();
            address tokenIn = quote == address(0) ? WETH : quote;

            (bytes memory path, uint256 floorOut) = _route(tokenIn, quote == address(0), uint128(amountIn));

            ISwapRouter02.ExactInputParams memory p = ISwapRouter02.ExactInputParams({
                path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: floorOut
            });
            if (quote == address(0)) {
                pivot = ISwapRouter02(ROUTER).exactInput{value: amountIn}(p);
            } else {
                IERC20(quote).approve(ROUTER, amountIn);
                pivot = ISwapRouter02(ROUTER).exactInput(p);
            }
        }
        // Whatever a failed conversion left behind last time joins this one.
        pivot += pivotReserve;
        pivotReserve = 0;
    }

    /// @dev `FeeVault._route`, ported unchanged — direct at the declared tier,
    ///      or the `QUOTE -> WETH -> PIVOT` detour when the currency is deeply
    ///      traded against WETH and invisible against the pivot. Exactly one of
    ///      `QUOTE_FEE` / `QUOTE_WETH_FEE` is non-zero, declared at birth from
    ///      a measurement and never probed at swap time.
    function _route(address tokenIn, bool isEth, uint128 amountIn)
        internal
        view
        returns (bytes memory path, uint256 floorOut)
    {
        uint24 direct = isEth ? ETH_PIVOT_FEE : QUOTE_FEE;

        if (direct != 0) {
            address pool = IUniswapV3Factory(V3_FACTORY).getPool(tokenIn, PIVOT, direct);
            if (pool == address(0)) revert NoPool();
            floorOut = TwapFloor.quoteAtTick(TwapFloor.meanTick(pool, TWAP_WINDOW), amountIn, tokenIn, PIVOT);
            path = abi.encodePacked(tokenIn, direct, PIVOT);
        } else {
            address poolA = IUniswapV3Factory(V3_FACTORY).getPool(tokenIn, WETH, QUOTE_WETH_FEE);
            address poolB = IUniswapV3Factory(V3_FACTORY).getPool(WETH, PIVOT, ETH_PIVOT_FEE);
            if (poolA == address(0) || poolB == address(0)) revert NoPool();
            floorOut = TwapFloor.quoteTwoHops(poolA, tokenIn, WETH, poolB, PIVOT, amountIn, TWAP_WINDOW);
            path = abi.encodePacked(tokenIn, QUOTE_WETH_FEE, WETH, ETH_PIVOT_FEE, PIVOT);
        }

        // One tolerance, two hops. The detour pays TWO pool fees where the
        // direct route pays one and the floor does not know that: it comes from
        // the TWAP, which is a price, not a cost.
        floorOut = (floorOut * (BPS - MAX_SLIPPAGE_BPS)) / BPS;
        if (floorOut == 0) revert MinOutZero();
    }
}
