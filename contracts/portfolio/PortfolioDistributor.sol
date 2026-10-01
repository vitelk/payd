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

import {DistributorV3} from "../distribution/v3/DistributorV3.sol";
import {IERC20, ISwapRouter02, IUniswapV3Factory} from "../interfaces/IExternal.sol";
import {TwapFloor} from "../libraries/TwapFloor.sol";

interface IPortfolioVault {
    function PIVOT() external view returns (address);
    function ROUTER() external view returns (address);
    function V3_FACTORY() external view returns (address);
    function REGISTRY() external view returns (address);
}

interface IPortfolioBook {
    function weightOf(address holder, address stock) external view returns (uint256);
}

interface IStockListing {
    function listing(address stock) external view returns (uint24 poolFee, address feed, bool allowed);
}

/// @title  PortfolioDistributor — converts at delivery, one swap per batch
///
/// @notice A `DistributorV3` in every respect — same roots, same proofs, same
///         `claimedSoFar`, same clamp — with **one** function added: a batch of
///         holders who all want the same stock is settled by ONE swap out of
///         the pivot, then a transfer each.
///
/// @dev    **Why the conversion lives here and not in the vault.** The vault
///         buys one basket per purchase, bounded at eight lines, and the
///         platform allows around 46 stocks: a launch whose holders choose
///         freely cannot have its wishes expressed as one basket. Converting at
///         delivery removes the bound entirely — a batch is one swap, and there
///         is no limit on how many batches a window is settled in.
///
///         **The gas is mutualised exactly as the basket's was.** The default
///         mode pays one `buyBasket` shared by every holder of a launch; this
///         mode pays one swap shared by every holder of a batch. What changes is
///         who shares with whom, not the shape of the cost — and the existing
///         floor already scales with how many lines a holder is settled across
///         (`pushFloorParts`, `docs/ARCHITECTURE.md` §S20), so a holder who
///         names six stocks needs six times the floor before they are fully
///         served. That was already true of a six-line basket.
///
///         **The weight is READ, never taken from the call.** `distributeInto`
///         is driven by a keeper naming a stock and a batch; if the weight came
///         from that call, a compromised keeper could convert a holder's whole
///         share into a stock they gave 5 % to. It comes from
///         `PortfolioBook.weightOf`, so the worst that call can do is convert
///         what the holder actually asked for, sooner or later than they hoped.
///         **This mode therefore adds no key and no privileged function.**
///
///         **Nothing is ever burnt.** `_one` refuses to record a delivery whose
///         transfer failed; here the pivot has already become stock by the time
///         a transfer can fail, so the share is credited to `pending` and
///         `collect` hands it over later — the same shape the backing mode uses
///         for a paused leg. A paused stock costs a delay, never a loss.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract PortfolioDistributor is DistributorV3 {
    error BookNotSet();
    error MinOutZero();
    error NoPool();
    error NotListedHere(address stock);
    error NothingConverted();

    /// @notice The TWAP window every floor here is read over, and the tolerance
    ///         against it. `FeeVault`'s, unchanged.
    uint32 public constant TWAP_WINDOW = 1_800;
    uint256 public constant MAX_SLIPPAGE_BPS = 300;

    /// @notice This launch's `PortfolioBook`. Written once, by the bootstrap,
    ///         in the birth transaction.
    address public book;

    /// @notice Stock a holder is owed because a transfer failed when it was
    ///         converted for them. Claimable by anyone on their behalf.
    mapping(address holder => mapping(address stock => uint256)) public pending;

    /// @notice How much of a holder's PIVOT entitlement has already been
    ///         converted into each stock. **Cumulative, like everything else
    ///         here, and this mapping is the whole of a bug worth recording.**
    ///
    /// @dev    Without it the weight applies to what is LEFT rather than to the
    ///         total: a 50/50 holder took half their share into the first
    ///         stock, then half of the remainder into the second, then half of
    ///         that — converging on the whole share but never reaching it, and
    ///         in the wrong proportions (2/3 against 1/3 for a row that said
    ///         1/2 and 1/2). Measured, not reasoned: 750 of 1,000 units settled
    ///         after both calls, in `test_ASilentHolderIsServedThroughTheCreatorsDefault`.
    ///
    ///         With it, a holder's target on a stock is `cumulative * bps / BPS`
    ///         — a function of the ROOT and their row, never of the order the
    ///         batches happened to run in — and this counter is what has
    ///         already been delivered against that target. Exactly the shape
    ///         `claimedSoFar` has against `cumulative`.
    mapping(address holder => mapping(address stock => uint256)) public convertedInto;

    event ConvertedInto(address indexed stock, uint256 pivotIn, uint256 out, uint256 holders);
    event Pending(address indexed holder, address indexed stock, uint256 amount);
    event Collected(address indexed holder, address indexed stock, uint256 amount);

    /// @notice Names the book. Once, and it is the bootstrap that does it in the
    ///         same transaction as the clone.
    function setBook(address book_) external {
        if (book != address(0) || book_ == address(0)) revert BadInput();
        // Before `initV3` has run there is no vault to check against, so the
        // only window in which this is callable is the birth transaction — the
        // same posture `initV3` itself takes.
        if (FEE_VAULT != address(0)) revert BadInput();
        book = book_;
    }

    /// @notice Settles a batch of holders into ONE stock: their pivot
    ///         entitlement is converted in a single swap, then transferred.
    ///
    /// @param stock      what this batch is being paid in. Must be allowed by
    ///                   the registry AT THE TIME OF THE CALL — a delisted
    ///                   stock stops being convertible, and the holder's pivot
    ///                   entitlement is untouched, so nothing is lost. The
    ///                   PIVOT itself is always accepted and is settled by
    ///                   transfer: that line means "pay me in dollars".
    /// @param accounts   the holders, at most `MAX_BATCH`.
    /// @param cumulative each holder's cumulative PIVOT leaf, from the root.
    /// @param proofs     aligned proofs.
    /// @param minOut     the caller's own floor. It can only TIGHTEN the
    ///                   oracle's (§S3), so a bad one costs the caller a revert
    ///                   and never a holder a worse price.
    function distributeInto(
        address stock,
        address[] calldata accounts,
        uint256[] calldata cumulative,
        bytes32[][] calldata proofs,
        uint256 minOut
    ) external nonReentrant returns (uint256 out) {
        uint256 g0 = gasleft();
        address bk = book;
        if (bk == address(0)) revert BookNotSet();

        uint256 n = accounts.length;
        if (n == 0 || cumulative.length != n || proofs.length != n) revert BatchMismatch();
        if (n > MAX_BATCH) revert BatchTooLarge(MAX_BATCH);

        uint256 id = activeRoot;
        if (id == 0) revert NoActiveRoot();
        bytes32 root = roots[id].pushRoot;
        if (root == bytes32(0)) revert NoActiveRoot();

        address vault = FEE_VAULT;
        address pivot = IPortfolioVault(vault).PIVOT();

        // **A line naming the PIVOT is "leave my share in dollars", and it is
        // settled by transfer.** There is no pool of a currency against itself,
        // so there is nothing to swap, no floor to compute and nothing to
        // protect — the same reason `FeeVault._setAllocations` takes a USDG
        // line in a basket at tier zero. It is also exempt from the allowlist:
        // the pivot is not a stock the platform picked, it is the currency this
        // contract already holds and already owes.
        //
        // This used to revert. What that cost was not an edge case: on a launch
        // whose creator set a default basket, a holder had NO WAY to say they
        // wanted dollars — `clearPortfolio` returns them to that default and
        // the next push converts them into it.
        uint24 poolFee;
        if (stock != pivot) {
            bool allowed;
            (poolFee,, allowed) = IStockListing(IPortfolioVault(vault).REGISTRY()).listing(stock);
            if (!allowed) revert NotListedHere(stock);
        }

        uint256[] memory parts = new uint256[](n);
        uint256 pivotIn;
        uint256 moved;
        {
            uint256 funded = totalFunded[pivot];
            for (uint256 i; i < n; ++i) {
                // One entry per holder. A repeat would verify and then take
                // nothing, but it would still be priced by `_refund` — the
                // T-REFUND-01 shape, refused at the root rather than priced
                // around.
                for (uint256 j; j < i; ++j) {
                    if (accounts[j] == accounts[i]) revert BadInput();
                }
                uint256 part = _take(bk, pivot, stock, accounts[i], cumulative[i], proofs[i], root, funded);
                parts[i] = part;
                pivotIn += part;
                if (part != 0 && funded != 0) moved += (part * quoteFundedFor[pivot]) / funded;
            }
        }
        if (pivotIn == 0) revert NothingConverted();

        // The pivot line skips the pool entirely: what came out is what went
        // in, and the pro-rata below then hands each holder exactly their own
        // part. `minOut` can only tighten a floor, and there is no floor to
        // tighten here — a caller asking for more than the identity gets the
        // revert they asked for.
        if (stock == pivot) {
            if (minOut > pivotIn) revert MinOutZero();
            out = pivotIn;
        } else {
            out = _swap(vault, pivot, stock, poolFee, pivotIn, minOut);
        }

        // Pro-rata of what the ONE swap returned. Rounding down per holder, so
        // a few units stay here and join the next batch's `pending` sweep
        // rather than being promised twice.
        uint256 handed;
        for (uint256 i; i < n; ++i) {
            if (parts[i] == 0) continue;
            uint256 share = (out * parts[i]) / pivotIn;
            if (share == 0) continue;
            handed += share;
            if (!_tryTransfer(stock, accounts[i], share)) {
                pending[accounts[i]][stock] += share;
                emit Pending(accounts[i], stock, share);
            } else {
                emit Delivered(accounts[i], stock, msg.sender, share);
            }
        }
        // What the pivot was worth has left the building, so it can no longer be
        // siphoned — the same decrement `_one` makes, for the same reason.
        quoteAtRisk = moved >= quoteAtRisk ? 0 : quoteAtRisk - moved;
        emit ConvertedInto(stock, pivotIn, handed, n);

        _refund(g0, (moved * REFUND_VALUE_BPS) / BPS);
    }

    /// @notice Hands over stock a failed transfer left here. Permissionless and
    ///         the beneficiary is the holder, never the caller.
    function collect(address holder, address stock) external nonReentrant returns (uint256 amount) {
        amount = pending[holder][stock];
        if (amount == 0) revert NothingDelivered();
        pending[holder][stock] = 0;
        if (!_tryTransfer(stock, holder, amount)) {
            pending[holder][stock] = amount;
            revert NothingDelivered();
        }
        emit Collected(holder, stock, amount);
    }

    // ------------------------------------------------------------ internals

    /// @dev One holder's slice of the conversion, and the three bounds are
    ///      `_one`'s in the same order: the proof verifies, we take only
    ///      `cumulative - already paid`, and never more than the pivot line
    ///      actually received. The fourth is this mode's: only the fraction the
    ///      HOLDER asked for on this stock.
    ///
    ///      It DEBITS here, before the swap, because the swap is what can
    ///      revert — and a revert unwinds this. After it, a failed transfer is
    ///      caught into `pending`, so no entitlement is ever burnt.
    function _take(
        address bk,
        address pivot,
        address stock,
        address account,
        uint256 cumulative,
        bytes32[] calldata proof,
        bytes32 root,
        uint256 funded
    ) internal returns (uint256 part) {
        if (account == address(0)) revert BadInput();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, pivot, cumulative))));
        if (!_verify(proof, root, leaf)) revert InvalidProof();

        uint256 bps = IPortfolioBook(bk).weightOf(account, stock);
        if (bps == 0) return 0;

        // The TARGET is a share of the whole cumulative, not of what is left.
        // See `convertedInto` for the bug this shape exists to prevent.
        uint256 target = (cumulative * bps) / BPS;
        uint256 already = convertedInto[account][stock];
        if (target <= already) return 0;
        part = target - already;

        // Then the two bounds every delivery here carries: never more than the
        // holder's own untouched entitlement, and never more than the pivot
        // line actually received — the only bound on a false root.
        uint256 paid = claimedSoFar[account][pivot];
        if (cumulative <= paid) return 0;
        uint256 owed = cumulative - paid;
        if (part > owed) part = owed;
        uint256 remaining = funded - totalDistributed[pivot];
        if (part > remaining) part = remaining;
        if (part == 0) return 0;

        convertedInto[account][stock] = already + part;
        claimedSoFar[account][pivot] = paid + part;
        totalDistributed[pivot] += part;
    }

    /// @dev The batch's one swap, floored by the pool's own 30-minute TWAP and
    ///      tightened by the caller. Never `minOut = 0`.
    ///
    ///      The pool fee is deducted BEFORE the band, the same fix
    ///      `FeeVault._legFloor` carries: the TWAP is a price and the fee is a
    ///      cost, so a 1 % tier against a 3 % band would otherwise eat a third
    ///      of the tolerance without anyone deciding to.
    function _swap(address vault, address pivot, address stock, uint24 poolFee, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 out)
    {
        if (amountIn > type(uint128).max) revert MinOutZero();
        address factory = IPortfolioVault(vault).V3_FACTORY();
        address pool = IUniswapV3Factory(factory).getPool(pivot, stock, poolFee);
        if (pool == address(0)) revert NoPool();

        uint256 floor = TwapFloor.quoteAtTick(TwapFloor.meanTick(pool, TWAP_WINDOW), uint128(amountIn), pivot, stock);
        uint256 band = BPS - MAX_SLIPPAGE_BPS - (poolFee / 100);
        floor = (floor * band) / BPS;
        if (floor == 0) revert MinOutZero();
        if (minOut > floor) floor = minOut;

        address router = IPortfolioVault(vault).ROUTER();
        IERC20(pivot).approve(router, amountIn);
        out = ISwapRouter02(router)
            .exactInput(
                ISwapRouter02.ExactInputParams({
                path: abi.encodePacked(pivot, poolFee, stock),
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: floor
            })
            );
    }
}
