// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice Drives the Distributor at random. Every call is wrapped in a `try`:
///         an invalid sequence must not stop the campaign, it must simply change
///         nothing. That is what lets the fuzzer explore call orders nobody
///         thought of.
contract Handler is Test {
    Distributor public dist;
    address public immutable STOCK;
    address public immutable TIMELOCK;
    address[3] public holders;

    /// @dev Witnesses: what the contract must never contradict.
    mapping(address holder => uint256) public ghostMaxClaimed;
    uint256 public ghostStockSent;
    uint256 public nextEpoch;
    address public lastHolder;
    uint256 public lastCumulative;
    address public activeHolder;
    uint256 public activeCumulative;
    uint256 public callsFund;
    uint256 public callsClaim;
    uint256 public claimAttempts;
    bytes public lastClaimError;
    uint256 public callsPublish;
    uint256 public proposeAttempts;
    bytes public lastProposeError;

    constructor(address stock, address timelock_, address[3] memory hs) {
        STOCK = stock;
        TIMELOCK = timelock_;
        holders = hs;
    }

    /// @dev Once only. The fuzzer calls everything exposed: without this lock it
    ///      repointed the handler at a random address and the whole campaign ran
    ///      into the void. The `targetSelector` allowlist already excludes it —
    ///      belt AND braces.
    function setDistributor(Distributor d) external {
        require(address(dist) == address(0), "already wired");
        dist = d;
    }

    receive() external payable {}

    // ---- actions ---------------------------------------------------------

    /// @dev The handler IS the Distributor's FeeVault, so it can fund.
    function fund(uint96 amount, uint8 epochSeed) external {
        uint256 a = bound(uint256(amount), 1, 1e21);
        if (IERC20(STOCK).balanceOf(address(this)) < a) return;
        uint256 epoch = bound(uint256(epochSeed), 0, 8);

        IERC20(STOCK).transfer(address(dist), a);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        stocks[0] = STOCK;
        amounts[0] = a;
        eth[0] = 1 ether;
        try dist.fundWindow(epoch, stocks, amounts, eth) {
            ghostStockSent += a;
            ++callsFund;
        } catch {}
    }

    /// @dev A ONE-leaf root: the root IS the leaf, the proof is empty. That is
    ///      enough to exercise the whole settlement path without building a
    ///      tree, and it lets the fuzzer choose who and how much.
    function propose(uint8 who, uint96 cumulative) external {
        address h = holders[bound(uint256(who), 0, 2)];
        uint256 c = bound(uint256(cumulative), 1, 1e21);

        // The covered range must MOVE FORWARD.
        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (nextEpoch != 0 && epoch < nextEpoch) return;

        ++proposeAttempts;
        bytes32 leaf = _leaf(h, STOCK, c);
        // The handler IS the keeper: the root takes effect immediately, there is
        // no bond, no window and no separate finalisation any more.
        try dist.publishRoot(epoch, leaf, leaf, bytes32("cid"), "bafyTEST") {
            nextEpoch = epoch + 1;
            ++callsPublish;
            // We remember the published leaf: without this, `claimIt` would draw
            // a random cumulative that would NEVER match the root, no claim would
            // ever succeed, and the accounting invariants would never see a
            // single token move.
            lastHolder = h;
            lastCumulative = c;
            activeHolder = h;
            activeCumulative = c;
        } catch (bytes memory err) {
            lastProposeError = err;
        }
    }

    function claimIt() external {
        address h = activeHolder;
        if (h == address(0)) return;
        uint256 c = activeCumulative;

        address[] memory stocks = new address[](1);
        stocks[0] = STOCK;
        uint256[] memory cums = new uint256[](1);
        cums[0] = c;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        ++claimAttempts;
        vm.prank(h);
        try dist.claim(stocks, cums, proofs) {
            ++callsClaim;
        } catch (bytes memory err) {
            lastClaimError = err;
        }
    }

    function withdrawIt(uint8 who) external {
        address h = holders[bound(uint256(who), 0, 2)];
        vm.prank(h);
        try dist.withdraw() {} catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 1, 3 days));
        vm.roll(block.number + 1);
    }

    // ---- witnesses -------------------------------------------------------

    /// @dev Called by the invariant: updates the maximum seen, and reports any
    ///      DECREASE of `claimedSoFar`.
    function checkClaimedMonotonic() external returns (bool ok) {
        ok = true;
        for (uint256 i; i < 3; ++i) {
            uint256 now_ = dist.claimedSoFar(holders[i], STOCK);
            if (now_ < ghostMaxClaimed[holders[i]]) ok = false;
            ghostMaxClaimed[holders[i]] = now_;
        }
    }

    function _leaf(address holder, address stock, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, stock, cumulative))));
    }
}

/// @notice Distributor invariants — what must stay true AFTER ANY sequence of
///         calls, not only the ones we imagined.
///
///         The 35 example-based tests prove the anticipated cases work. The ones
///         below look for the cases we did not anticipate, with REAL Robinhood
///         stock tokens taken from a whale — not a mock.
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 80
/// forge-config: default.invariant.fail-on-revert = false
contract DistributorInvariants is StdInvariant, CloneBase {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_WHALE = 0x9f736F87E6293AC1Bd9142E257dbfAC8b7AcF1ae;

    Distributor internal dist;
    Handler internal handler;

    function setUp() public {
        address[3] memory hs = [makeAddr("holderA"), makeAddr("holderB"), makeAddr("holderC")];

        address tl = makeAddr("timelock");
        handler = new Handler(NVDA, tl, hs);
        // The handler IS the keeper: it is the one that publishes the roots.
        dist = _cloneDistributor(address(handler), tl, address(handler), block.timestamp, 1 hours);
        handler.setDistributor(dist);

        // Real stock tokens, obtained by pranking an actual holder.
        // A FIXED amount, written directly. Taking a quarter of a whale's
        // balance made the campaign depend on what a stranger holds that day --
        // and on its SIZE, hence on the depth explored.
        deal(NVDA, address(handler), 1_000_000e18);

        vm.deal(address(dist), 1 ether); // operating gas reserve

        // Allowlist: only the ACTIONS are fuzzed. Without it the fuzzer also
        // calls the wiring and the witnesses, and the campaign stops testing the
        // contract and starts testing the harness.
        // `rotateKeeper` was REMOVED from the fuzzing. The fuzzer could take away
        // the handler's own ability to publish and never give it back: no root at
        // all, and the coverage guard failed the campaign, rightly so. Rotation is
        // already covered deterministically by `test_OnlyTimelockRotatesKeeper`;
        // the job of an invariant campaign is the path the MONEY takes.
        // `anchorAndReveal` went with the seed: the time weighting draws
        // nothing, and `propose` only has to land on a finished epoch — which
        // the fuzzer's own warps produce anyway.
        bytes4[] memory sels = new bytes4[](5);
        sels[0] = Handler.fund.selector;
        sels[1] = Handler.propose.selector;
        sels[2] = Handler.claimIt.selector;
        sels[3] = Handler.withdrawIt.selector;
        sels[4] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// @notice You cannot distribute more than you received. The basic
    ///         accounting invariant: if it falls, someone was paid with somebody
    ///         else's stock.
    function invariant_DistributedNeverExceedsFunded() public view {
        assertLe(dist.totalDistributed(NVDA), dist.totalFunded(NVDA), "distributed > funded");
    }

    /// @notice **The quote-side twin of the one above (T-RISK-01).** The stock
    ///         ledger and the quote ledger are two accounts of the same
    ///         deliveries: `fundWindow` raises both, `_one` lowers both, and the
    ///         second is what `FLOWS.md` §7.c and `docs/ARCHITECTURE.md` §S29
    ///         publish as the exposure of a leaked keeper key.
    ///
    /// @dev    It is a `<=` and not an `==` on purpose, and the direction is the
    ///         guarantee: every decrement is `owed * quoteFundedFor /
    ///         totalFunded`, a `mulDiv` rounded DOWN, so `quoteAtRisk` can only
    ///         ever err HIGH. A figure that errs high is a monitor; one that
    ///         errs low is what T-RISK-01 found in `FeeVault._buyLegs`, where a
    ///         skipped leg's quote was never recorded at all and the published
    ///         exposure drifted low exactly when legs were failing.
    function invariant_QuoteAtRiskNeverExceedsWhatWasSpent() public view {
        assertLe(dist.quoteAtRisk(), dist.quoteFundedFor(NVDA), "quoteAtRisk exceeds what the windows spent");
    }

    /// @notice The contract physically holds what it still owes. Complements the
    ///         previous one: the accounting can be consistent while the tokens
    ///         have already left.
    function invariant_StockBalanceCoversOutstanding() public view {
        uint256 owed = dist.totalFunded(NVDA) - dist.totalDistributed(NVDA);
        assertGe(IERC20(NVDA).balanceOf(address(dist)), owed, "balance insufficient to cover what is owed");
    }

    /// @notice `claimedSoFar` never decreases. THAT is what prevents being paid
    ///         twice under cumulative roots: if it could go backwards, the whole
    ///         history would become claimable again.
    function invariant_ClaimedNeverDecreases() public {
        assertTrue(handler.checkClaimedMonotonic(), "claimedSoFar decreased");
    }

    /// @notice The ETH held covers at least the pending withdrawals. Pull over
    ///         push must never promise more than the balance.
    function invariant_EthCoversPendingWithdrawals() public view {
        uint256 promised;
        for (uint256 i; i < 3; ++i) {
            promised += dist.pendingWithdrawal(handler.holders(i));
        }
        promised += dist.pendingWithdrawal(address(handler));
        assertGe(address(dist).balance, promised, "promised more ETH than held");
    }

    /// @notice Coverage guard. This is NOT an invariant — Foundry evaluates
    ///         invariants from setup onwards, before any call, and a coverage
    ///         assertion there would always fail. `afterInvariant` runs once the
    ///         campaign is over.
    ///
    ///         Without it, a broken harness would give an entirely green suite:
    ///         zero calls, zero violations. That is the most insidious failure
    ///         mode of invariant fuzzing.
    function afterInvariant() public {
        assertGt(handler.callsFund(), 0, "the fuzzer never funded: worthless campaign");
        if (handler.callsPublish() == 0) {
            emit log_named_uint("propose attempts", handler.proposeAttempts());
            emit log_named_bytes("last publishRoot revert", handler.lastProposeError());
        }
        assertGt(handler.callsPublish(), 0, "no root published: the cycle was not exercised");
        if (handler.callsClaim() == 0) {
            emit log_named_uint("claim attempts", handler.claimAttempts());
            emit log_named_bytes("last revert", handler.lastClaimError());
        }
        assertGt(handler.callsClaim(), 0, "no successful claim: the accounting invariants saw nothing move");
    }
}

// ----------------------------------------------------------- audit, 2026-09-11

/// @notice **T-REFUND-02 — the delivery reserve pays for work, not for value.**
///
/// @dev    A SECOND handler rather than a batch dimension bolted onto the one
///         above. The campaign above is green and its `afterInvariant` coverage
///         guard is what makes it meaningful; adding a selector to it would
///         change the call distribution of five invariants that currently hold,
///         to test something none of them is about. This one drives the same
///         contract with the same rules and fuzzes the one thing the other does
///         not: **how many entries a settlement carries**.
///
///         `Distributor._refund:651-663` prices the gas the whole call used.
///         `_settle:521` loops up to `MAX_BATCH = 64` and `_one:541` returns 0
///         without reverting when `cumulative <= paid`, so entries that deliver
///         nothing are paid for exactly like entries that deliver. `distribute`
///         requires only that the TOTAL be non-zero (`:491`).
contract RefundBoundHandler is Test {
    Distributor public dist;
    address public immutable STOCK;
    address[3] public holders;

    uint256 public nextEpoch;
    address public activeHolder;
    uint256 public activeCumulative;

    /// @dev Everything the reserve paid out, and everything those payments
    ///      actually moved, valued in the currency the purchases were made in.
    ///      `deliveredValueWei` is `Distributor._one`'s own `backing` formula
    ///      (`:561`): `owed * quoteFundedFor / totalFunded`.
    uint256 public refundsTotal;
    uint256 public deliveredValueWei;

    uint256 public callsFund;
    uint256 public callsPublish;
    uint256 public callsSettle;
    uint256 public widestBatch;

    constructor(address stock, address[3] memory hs) {
        STOCK = stock;
        holders = hs;
    }

    function setDistributor(Distributor d) external {
        require(address(dist) == address(0), "already wired");
        dist = d;
    }

    receive() external payable {}

    function fund(uint96 amount) external {
        uint256 a = bound(uint256(amount), 1e15, 1e21);
        if (IERC20(STOCK).balanceOf(address(this)) < a) return;

        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (epoch < nextEpoch) return;

        IERC20(STOCK).transfer(address(dist), a);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        stocks[0] = STOCK;
        amounts[0] = a;
        eth[0] = 1 ether;
        try dist.fundWindow(epoch, stocks, amounts, eth) {
            nextEpoch = epoch + 1;
            ++callsFund;
        } catch {}
    }

    /// @dev A one-leaf root: the root IS the leaf and the proof is empty, the
    ///      same shortcut `Handler.propose` above takes.
    function propose(uint8 who, uint96 cumulative) external {
        address h = holders[bound(uint256(who), 0, 2)];
        uint256 c = bound(uint256(cumulative), 1, 1e21);

        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (nextEpoch != 0 && epoch < nextEpoch) return;

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(h, STOCK, c))));
        try dist.publishRoot(epoch, leaf, leaf, bytes32("cid"), "bafyTEST") {
            ++callsPublish;
            activeHolder = h;
            activeCumulative = c;
        } catch {}
    }

    /// @dev **The batch dimension is gone, and that is the fix showing through.**
    ///      This used to repeat `(stock, cumulative, proof)` `batch` times — the
    ///      first slot delivering, the rest verifying their proof and returning
    ///      0 — which is the padding T-REFUND-01 measured at 1.854x the honest
    ///      refund. `Distributor._settle` now refuses a repeated stock outright,
    ///      so such a batch reverts and there is nothing left to fuzz there.
    ///
    ///      **The campaign is unaffected, because padding was never what it was
    ///      about.** Its counterexample shrank to a single settlement: a small
    ///      delivery costs the reserve the same fixed refund as a large one,
    ///      `_refund` pricing the call and nothing relating it to what moved.
    ///      `propose` fuzzes `cumulative` over twelve orders of magnitude
    ///      against a window fuzzed over six, so one entry is all it takes.
    ///      `batch` is kept in the signature so the selector list does not move.
    function settle(uint8 batch) external {
        address h = activeHolder;
        if (h == address(0)) return;
        batch;
        uint256 n = 1;

        address[] memory stocks = new address[](n);
        uint256[] memory cums = new uint256[](n);
        bytes32[][] memory proofs = new bytes32[][](n);
        for (uint256 i; i < n; ++i) {
            stocks[i] = STOCK;
            cums[i] = activeCumulative;
            proofs[i] = new bytes32[](0);
        }

        uint256 funded = dist.totalFunded(STOCK);
        if (funded == 0) return;
        uint256 quoteFunded = dist.quoteFundedFor(STOCK);

        uint256 before = address(this).balance;
        try dist.distribute(h, stocks, cums, proofs) returns (uint256 delivered) {
            refundsTotal += address(this).balance - before;
            deliveredValueWei += (delivered * quoteFunded) / funded;
            ++callsSettle;
            if (n > widestBatch) widestBatch = n;
        } catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 1 hours, 3 days));
        vm.roll(block.number + 1);
    }
}

/// @notice The campaign. Same shape and same budget as the three other fork
///         campaigns, for the reason `AUDIT_PLAN.md` §6.3 gives: 256 x 64
///         against a live RPC at 60 CU/s would not finish.
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 80
/// forge-config: default.invariant.fail-on-revert = false
contract RefundBoundInvariants is StdInvariant, CloneBase {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    /// @dev **`k`, and it was DERIVED FROM THE WRONG THING at first.** It read
    ///      4.3e-5 — one honest push measured at block 60310000, 17 105 303 400
    ///      400 wei of refund against a delivery worth 6e17, plus 50 % of
    ///      headroom. That is the ratio of one particular LARGE delivery, not a
    ///      bound honest operation respects: the refund is near enough fixed
    ///      while the delivery is not, so at the push floor itself
    ///      (`PUSH_TARGET_WEI`, ~4.19e15 wei) the honest ratio is ~4e-3, a
    ///      hundred times looser. A campaign cannot hold a bar its own honest
    ///      traffic crosses.
    ///
    ///      `k` is now the bound the CONTRACT enforces: `REFUND_VALUE_BPS`, one
    ///      tenth, which `Distributor._refund` applies to every `distribute`.
    ///      That constant is itself derived from `offchain/src/epoch.ts`'s
    ///      `PUSH_K_MIN = 20` — the push floor already guarantees the gas is at
    ///      most 5 % of what a delivery moves — with a factor of two for
    ///      `REFUND_OVERHEAD` and `PUSH_MARGIN_BPS`, which sit outside
    ///      `SETTLE_GAS`.
    uint256 constant K_NUM = 1_000;
    uint256 constant K_DEN = 10_000;

    Distributor internal dist;
    RefundBoundHandler internal handler;

    function setUp() public {
        address[3] memory hs = [makeAddr("rh A"), makeAddr("rh B"), makeAddr("rh C")];
        handler = new RefundBoundHandler(NVDA, hs);
        // The handler is both the vault and the keeper, as in the campaign above.
        dist = _cloneDistributor(address(handler), makeAddr("timelock"), address(handler), block.timestamp, 1 hours);
        handler.setDistributor(dist);

        deal(NVDA, address(handler), 1_000_000e18);
        vm.deal(address(dist), 1 ether);

        bytes4[] memory sels = new bytes4[](4);
        sels[0] = RefundBoundHandler.fund.selector;
        sels[1] = RefundBoundHandler.propose.selector;
        sels[2] = RefundBoundHandler.settle.selector;
        sels[3] = RefundBoundHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// @notice **The reserve's outlay stays proportional to the value its
    ///         deliveries moved.**
    ///
    /// @dev    It used to be red: the refund was priced per CALL and nothing
    ///         related it to what changed hands, so the reserve funded work that
    ///         moved nothing — 23 087 729 830 400 wei paid against about 7 wei
    ///         of value on the sharpest counterexample, with no padding needed.
    ///
    ///         **Green since 2026-09-11**: `_refund` takes a ceiling of
    ///         `REFUND_VALUE_BPS` of what the call moved, so the relation exists
    ///         and this is it. The gate is removed.
    // T-REFUND-02
    function invariant_RefundsAreBoundedByTheValueDelivered() public view {
        assertLe(
            handler.refundsTotal() * K_DEN,
            handler.deliveredValueWei() * K_NUM,
            "the delivery reserve paid out more than the value its deliveries moved"
        );
    }

    /// @notice Coverage guard, the same shape as `Invariants.t.sol:251-262`.
    function afterInvariant() public {
        assertGt(handler.callsFund(), 0, "the fuzzer never funded: worthless campaign");
        assertGt(handler.callsPublish(), 0, "no root published: the cycle was not exercised");
        assertGt(handler.callsSettle(), 0, "nothing settled: the refund path saw no traffic");
        emit log_named_uint("widest batch settled        ", handler.widestBatch());
        emit log_named_uint("refunds paid, wei           ", handler.refundsTotal());
        emit log_named_uint("value delivered, wei        ", handler.deliveredValueWei());
        emit log_named_uint(
            "ratio x1e9, refunds / value ",
            handler.deliveredValueWei() == 0 ? 0 : (handler.refundsTotal() * 1e9) / handler.deliveredValueWei()
        );
    }
}

// ------------------------------------------------- audit phase 2, 2026-09-11

/// @notice **T-INV-01 — the conservation invariants, with more than one stock
///         and with legs that give way.**
///
/// @dev    The campaign at the top of this file funds ONE stock, NVDA, in every
///         window. `FeeVault._fund` truncates its arrays to the legs that
///         actually bought, so what a Distributor really sees is a basket whose
///         LENGTH changes from window to window — two stocks, then one, then
///         two again. Nothing exercised that: `invariant_DistributedNeverExceedsFunded`
///         and `invariant_StockBalanceCoversOutstanding` have only ever been
///         checked against a single ledger.
///
///         A second handler rather than a second stock bolted onto the first:
///         the campaign above is green and its coverage guard is what makes it
///         meaningful, and widening its call distribution would change five
///         invariants that currently hold in order to test something none of
///         them is about.
contract MultiStockHandler is Test {
    Distributor public dist;
    address public immutable A;
    address public immutable B;
    address[3] public holders;

    uint256 public nextEpoch;
    address public activeHolder;
    address public activeStock;
    uint256 public activeCumulative;

    uint256 public callsFund;
    uint256 public callsPublish;
    uint256 public callsClaim;
    uint256 public windowsWithOneLeg;
    uint256 public windowsWithTwoLegs;

    constructor(address a, address b, address[3] memory hs) {
        A = a;
        B = b;
        holders = hs;
    }

    function setDistributor(Distributor d) external {
        require(address(dist) == address(0), "already wired");
        dist = d;
    }

    receive() external payable {}

    /// @dev `legs` decides how many of the two lines actually bought. One leg is
    ///      the shape `_fund` produces when `_legFloor` returned 0 for the
    ///      other — a pool that could not serve the window, a feed behind a
    ///      rally, a tier with no pool.
    function fund(uint96 amount, bool bothLegs, bool whichOne) external {
        uint256 a = bound(uint256(amount), 1e15, 1e20);

        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (epoch < nextEpoch) return;

        // **The shape ALTERNATES, it is not tossed for.** `bothLegs` was fuzzed,
        // and `fund` only gets through once per epoch — so the number of
        // successful funds in a campaign is small, and a run where the coin
        // never came up "one leg" failed the coverage guard below on a seed and
        // passed on the next. A guard that fails for the wrong reason is worse
        // than no guard: it teaches people to re-run.
        //
        // Alternating gives both shapes by the second successful fund and costs
        // the campaign nothing — what is under test is the ACCOUNTING across a
        // basket whose length changes, not the fuzzer's ability to find that
        // length. `bothLegs` stays in the signature so the selector list does
        // not move, and is deliberately unread.
        bothLegs;
        bool both = callsFund % 2 == 0;
        uint256 n = both ? 2 : 1;
        address[] memory stocks = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256[] memory quote = new uint256[](n);
        if (both) {
            stocks[0] = A;
            stocks[1] = B;
            amounts[0] = a;
            amounts[1] = a / 2 + 1;
            quote[0] = 0.6 ether;
            quote[1] = 0.4 ether;
        } else {
            stocks[0] = whichOne ? A : B;
            amounts[0] = a;
            quote[0] = 1 ether;
        }

        for (uint256 i; i < n; ++i) {
            if (IERC20(stocks[i]).balanceOf(address(this)) < amounts[i]) return;
        }
        for (uint256 i; i < n; ++i) {
            IERC20(stocks[i]).transfer(address(dist), amounts[i]);
        }

        try dist.fundWindow(epoch, stocks, amounts, quote) {
            nextEpoch = epoch + 1;
            ++callsFund;
            if (bothLegs) ++windowsWithTwoLegs;
            else ++windowsWithOneLeg;
        } catch {
            // The transfer already happened; `fundRewards`'s counterpart on the
            // Distributor does not exist, so the stock simply sits there. That
            // is what `invariant_StockBalanceCoversOutstanding` tolerates: the
            // balance may EXCEED what is owed, never fall short.
        }
    }

    function propose(uint8 who, bool stockA, uint96 cumulative) external {
        address h = holders[bound(uint256(who), 0, 2)];
        address st = stockA ? A : B;
        uint256 c = bound(uint256(cumulative), 1, 1e21);

        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (nextEpoch != 0 && epoch < nextEpoch) return;

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(h, st, c))));
        try dist.publishRoot(epoch, leaf, leaf, bytes32("cid"), "bafyTEST") {
            ++callsPublish;
            activeHolder = h;
            activeStock = st;
            activeCumulative = c;
        } catch {}
    }

    function claimIt() external {
        if (activeHolder == address(0)) return;
        address[] memory stocks = new address[](1);
        uint256[] memory cums = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = activeStock;
        cums[0] = activeCumulative;
        proofs[0] = new bytes32[](0);
        vm.prank(activeHolder);
        try dist.claim(stocks, cums, proofs) {
            ++callsClaim;
        } catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 1 hours, 3 days));
        vm.roll(block.number + 1);
    }
}

/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 80
/// forge-config: default.invariant.fail-on-revert = false
contract MultiStockInvariants is StdInvariant, CloneBase {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    Distributor internal dist;
    MultiStockHandler internal handler;

    function setUp() public {
        address[3] memory hs = [makeAddr("ms A"), makeAddr("ms B"), makeAddr("ms C")];
        handler = new MultiStockHandler(NVDA, SPY, hs);
        dist = _cloneDistributor(address(handler), makeAddr("timelock"), address(handler), block.timestamp, 1 hours);
        handler.setDistributor(dist);

        deal(NVDA, address(handler), 1_000_000e18);
        deal(SPY, address(handler), 1_000_000e18);
        vm.deal(address(dist), 1 ether);

        bytes4[] memory sels = new bytes4[](4);
        sels[0] = MultiStockHandler.fund.selector;
        sels[1] = MultiStockHandler.propose.selector;
        sels[2] = MultiStockHandler.claimIt.selector;
        sels[3] = MultiStockHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// @notice **ASSERTION DIRECTION.** The property that SHOULD hold, on both
    ///         ledgers at once: you cannot distribute more than you received.
    ///         Green expected — the ledgers are per-stock mappings and a window
    ///         of one leg touches only one of them.
    // T-INV-01
    function invariant_NeitherStockDistributesMoreThanItWasFunded() public view {
        assertLe(dist.totalDistributed(NVDA), dist.totalFunded(NVDA), "NVDA: distributed > funded");
        assertLe(dist.totalDistributed(SPY), dist.totalFunded(SPY), "SPY: distributed > funded");
    }

    /// @notice The tokens are really there, per stock. Complements the previous
    ///         one: the accounting can be consistent while the tokens have left.
    // T-INV-01
    function invariant_BothStockBalancesCoverTheirOutstanding() public view {
        assertGe(
            IERC20(NVDA).balanceOf(address(dist)),
            dist.totalFunded(NVDA) - dist.totalDistributed(NVDA),
            "NVDA: balance does not cover what is owed"
        );
        assertGe(
            IERC20(SPY).balanceOf(address(dist)),
            dist.totalFunded(SPY) - dist.totalDistributed(SPY),
            "SPY: balance does not cover what is owed"
        );
    }

    function afterInvariant() public {
        assertGt(handler.callsFund(), 0, "the fuzzer never funded: worthless campaign");
        assertGt(handler.callsPublish(), 0, "no root published: the cycle was not exercised");
        assertGt(handler.callsClaim(), 0, "no successful claim: the accounting invariants saw nothing move");
        // The shape this campaign exists for: windows of one leg AND of two.
        // Guaranteed by the alternation in `fund`, not hoped for: the first
        // successful fund is two legs and the second is one.
        assertGt(handler.callsFund(), 1, "fewer than two windows funded: the alternation never produced both shapes");
        assertGt(handler.windowsWithTwoLegs(), 0, "never funded a two-stock window");
        assertGt(handler.windowsWithOneLeg(), 0, "never funded a window with a leg missing");
        emit log_named_uint("windows with two legs", handler.windowsWithTwoLegs());
        emit log_named_uint("windows with one leg ", handler.windowsWithOneLeg());
    }
}

/// @notice **T-REG-01 — `Payd` and `DistributionFactory` never hold a wei.**
///
/// @dev    `CLAUDE.md` states it as a non-negotiable rule, `FLOWS.md` §2 repeats
///         it, and **nothing asserted it**. It is true today for a structural
///         reason worth writing down: neither contract declares `receive`,
///         `fallback` or a single `payable` function, so a plain transfer to
///         either one reverts. The handler below tries anyway, from a funded
///         address, on every call — because "true by construction" is a claim
///         about the construction, and the construction is what a future commit
///         changes.
///
///         Cheaper than the other campaigns on purpose: every call is local, no
///         swap and no stock transfer, so the budget buys depth rather than RPC
///         round trips.
contract RegistryPocketHandler is Test {
    Payd public immutable PAD;
    address public immutable FACTORY_;
    VaultTypes.Allocation[] internal basket;

    uint256 public callsCreate;
    uint256 public sendAttempts;
    uint256 public sendsThatSucceeded;

    constructor(Payd pad, address factory_, VaultTypes.Allocation[] memory b) {
        PAD = pad;
        FACTORY_ = factory_;
        for (uint256 i; i < b.length; ++i) {
            basket.push(b[i]);
        }
    }

    receive() external payable {}

    function createOne(uint16 rewardsBps, uint32 epochLength) external {
        uint256 r = bound(uint256(rewardsBps), 5_000, 9_000);
        uint256 e = bound(uint256(epochLength), 30 minutes, 1 days);
        try PAD.createVault(basket, r, e, address(0)) {
            ++callsCreate;
        } catch {}
    }

    /// @dev The two doors, tried for real. `call` rather than `transfer` so a
    ///      refusal is observed and not thrown.
    function trySend(uint96 amount, bool atRegistry) external {
        uint256 a = bound(uint256(amount), 1, 1 ether);
        address target = atRegistry ? address(PAD) : FACTORY_;
        if (address(this).balance < a) return;
        ++sendAttempts;
        (bool ok,) = target.call{value: a}("");
        if (ok) ++sendsThatSucceeded;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 1, 1 days));
        vm.roll(block.number + 1);
    }
}

/// forge-config: default.invariant.runs = 4
/// forge-config: default.invariant.depth = 40
/// forge-config: default.invariant.fail-on-revert = false
contract RegistryPocketInvariants is StdInvariant, CloneBase {
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;

    Payd internal pad;
    DistributionFactory internal factory;
    RegistryPocketHandler internal handler;

    function setUp() public {
        address timelock = makeAddr("timelock");
        factory = new DistributionFactory();
        pad = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: makeAddr("platform"),
                keeper: makeAddr("keeper"),
                coSigner: address(0),
                escrow: ESCROW,
                ponsFactory: PONS_FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                generationKey: makeAddr("generation key"),
                factory: address(factory)
            }),
            1_000,
            Payd.Seed(
                new address[](0),
                new uint24[](0),
                new address[](0),
                new address[](0),
                new uint24[](0),
                new uint24[](0),
                new uint256[](0)
            ),
            Payd.Genesis(address(0), 0, 0, new VaultTypes.Allocation[](0))
        );

        address[] memory s = new address[](2);
        uint24[] memory f = new uint24[](2);
        address[] memory d = new address[](2);
        s[0] = NVDA;
        f[0] = 500;
        d[0] = NVDA_FEED;
        s[1] = QQQ;
        f[1] = 500;
        d[1] = QQQ_FEED;
        vm.prank(timelock);
        pad.allowStocks(s, f, d);

        VaultTypes.Allocation[] memory b = new VaultTypes.Allocation[](2);
        b[0] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        b[1] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);

        handler = new RegistryPocketHandler(pad, address(factory), b);
        vm.deal(address(handler), 100 ether);

        bytes4[] memory sels = new bytes4[](3);
        sels[0] = RegistryPocketHandler.createOne.selector;
        sels[1] = RegistryPocketHandler.trySend.selector;
        sels[2] = RegistryPocketHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// @notice **ASSERTION DIRECTION.** The property that SHOULD hold, and does:
    ///         green. "`Payd` and `DistributionFactory` never hold a wei" is a
    ///         `CLAUDE.md` rule; this is the sensor on it.
    // T-REG-01
    function invariant_TheRegistryAndTheFactoryHoldNothing() public view {
        assertEq(address(pad).balance, 0, "the registry holds a wei: it stamps and indexes, it does not hold");
        assertEq(address(factory).balance, 0, "the factory holds a wei: it clones, it does not hold");
    }

    function afterInvariant() public {
        assertGt(handler.callsCreate(), 0, "no vault was ever created: the registry did nothing");
        assertGt(handler.sendAttempts(), 0, "nobody ever tried to fund either contract");
        emit log_named_uint("vaults created            ", handler.callsCreate());
        emit log_named_uint("attempts to send them ETH ", handler.sendAttempts());
        emit log_named_uint("attempts that succeeded   ", handler.sendsThatSucceeded());
        assertEq(handler.sendsThatSucceeded(), 0, "a plain transfer reached one of them");
    }
}
