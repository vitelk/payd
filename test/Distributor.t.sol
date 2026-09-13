// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @notice Fork tests with REAL Robinhood stock tokens, obtained by pranking an
///         actual holder — they are BeaconProxies with ERC-7201 storage, and
///         writing their balance slot would be a disguised mock.
///
///         Model: CUMULATIVE roots (docs/ARCHITECTURE.md §S18).

contract DistributorForkTest is CloneBase {
    address keeperAddr = makeAddr("keeperAddr");
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_WHALE = 0x9f736F87E6293AC1Bd9142E257dbfAC8b7AcF1ae;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant SPY_WHALE = 0xC8b77E0dabfea5E3B4eC6F313BF8358BC1BC121c;

    Distributor dist;
    address feeVault = makeAddr("feeVault");
    address timelock = makeAddr("timelock");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant EPOCH_LENGTH = 1 hours;
    uint256 constant ETH_SPENT = 1 ether;
    uint256 genesis;

    function setUp() public {
        genesis = block.timestamp;
        dist = _cloneDistributor(feeVault, timelock, keeperAddr, genesis, EPOCH_LENGTH);
        vm.deal(address(dist), 0.5 ether);
        vm.deal(address(this), 100 ether);
    }

    // ---- helpers ---------------------------------------------------------

    /// @dev The leaf does NOT carry the epoch: (holder, stock, cumulative).
    function _leaf(address holder, address stock, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, stock, cumulative))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    /// @dev One purchase covering the window that ends at `epoch`, holding a
    ///      single stock. The real vault buys the whole basket in one go; a
    ///      basket of one is enough to exercise everything downstream, and it
    ///      keeps these tests about the Distributor.
    /// @dev `deal` rather than a transfer from a whale. Borrowing a stranger's
    ///      tokens makes the suite depend on THEIR balance: on 2026-09-08 the
    ///      NVDA whale moved enough of them to break twelve tests at once, on
    ///      `ERC20InsufficientBalance`.
    ///
    ///      This is not a mock in the sense of docs/CONVENTIONS.md: no behaviour of Pons
    ///      or of Uniswap is simulated. We write a standard ERC-20 balance, and
    ///      every swap, pool and Pons call stays real. The `whale` parameter is
    ///      kept so as not to touch the 20 call sites.
    function _fund(uint256 epoch, address stock, address whale, uint256 amount) internal {
        whale; // kept for the readability of the call sites
        deal(stock, address(dist), IERC20(stock).balanceOf(address(dist)) + amount);
        if (block.timestamp < dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        stocks[0] = stock;
        amounts[0] = amount;
        eth[0] = ETH_SPENT;
        vm.prank(feeVault);
        dist.fundWindow(epoch, stocks, amounts, eth);
    }

    /// @dev `fundWindow` with a one-stock basket and no transfer, for the tests
    ///      that are about what it REFUSES.
    /// @dev Closes an epoch so `fundWindow` will accept it. Kept SEPARATE from
    ///      `_fundRaw`: a read inside a helper would eat the `vm.expectRevert`
    ///      armed just before it.
    function _closeEpoch(uint256 epoch) internal {
        if (block.timestamp < dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
    }

    function _fundRaw(uint256 epoch, address stock, uint256 amount, uint256 quoteSpent) internal {
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        stocks[0] = stock;
        amounts[0] = amount;
        eth[0] = quoteSpent;
        vm.prank(feeVault);
        dist.fundWindow(epoch, stocks, amounts, eth);
    }

    /// @dev A root can only cover a FINISHED epoch. Since the time weighting
    ///      there is nothing left to draw, so that is the only condition.
    function _seed(uint256 epoch) internal {
        vm.warp(dist.epochEnd(epoch) + 1);
    }

    /// @dev `distribute` is now the ONLY permissionless refunded action on the
    ///      Distributor — `anchorEpoch` and `revealSeed`, which used to carry
    ///      these tests, are gone. Sets up a payable delivery to `alice` and
    ///      returns the proof that triggers it.
    function _deliverable(uint256 epoch, uint256 amount) internal returns (bytes32 proofLeaf) {
        _fund(epoch, NVDA, NVDA_WHALE, amount * 2);
        _seed(epoch);
        proofLeaf = _leaf(bob, NVDA, amount);
        _publish(epoch, _leaf(alice, NVDA, amount), proofLeaf);
    }

    /// @dev Publishes a two-leaf root. Immediate effect.
    function _publish(uint256 upToEpoch, bytes32 leafA, bytes32 leafB) internal returns (bytes32 root) {
        root = _pair(leafA, leafB);
        vm.prank(keeperAddr);
        dist.publishRoot(upToEpoch, root, root, bytes32("cid"), "bafyTEST");
    }

    function _single(bytes32 sibling) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = sibling;
    }

    function _arr(address a) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a;
    }

    function _arr(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _arr(bytes32[] memory a) internal pure returns (bytes32[][] memory x) {
        x = new bytes32[][](1);
        x[0] = a;
    }

    // ---- tests -----------------------------------------------------------

    function test_OnlyFeeVaultCanFund() public {
        _closeEpoch(0);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        stocks[0] = NVDA;
        amounts[0] = 1e18;
        eth[0] = ETH_SPENT;
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotFeeVault.selector);
        dist.fundWindow(0, stocks, amounts, eth);
    }

    /// @notice Full cycle: fund, anchor, publish, claim.
    function test_FullCycleClaim() public {
        _fund(0, NVDA, NVDA_WHALE, 5e18);
        _seed(0);
        bytes32 la = _leaf(alice, NVDA, 3e18);
        bytes32 lb = _leaf(bob, NVDA, 2e18);
        _publish(0, la, lb);

        vm.prank(alice);
        uint256 got = dist.claim(_arr(NVDA), _arr(uint256(3e18)), _arr(_single(lb)));

        assertEq(got, 3e18, "amount delivered");
        assertEq(IERC20(NVDA).balanceOf(alice), 3e18, "NVDA not received");
        assertEq(dist.claimedSoFar(alice, NVDA), 3e18, "cumulative paid not recorded");
    }

    /// @notice THE point of the model: one entry settles several epochs.
    ///         Replaying the same proof afterwards pays nothing.
    function test_CumulativeSettlesManyEpochsInOneEntry() public {
        // 24 one-hour epochs, all on NVDA.
        for (uint256 e; e < 24; ++e) {
            _fund(e, NVDA, NVDA_WHALE, 1e17);
        }
        _seed(23);

        // Alice's cumulative covers all 24 epochs at once.
        bytes32 la = _leaf(alice, NVDA, 24e17);
        bytes32 lb = _leaf(bob, NVDA, 1);
        _publish(23, la, lb);

        vm.recordLogs();
        vm.prank(alice);
        uint256 got = dist.claim(_arr(NVDA), _arr(uint256(24e17)), _arr(_single(lb)));
        assertEq(got, 24e17, "the 24 epochs should have been settled in one entry");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 TRANSFER = keccak256("Transfer(address,address,uint256)");
        uint256 transfers;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].topics.length == 3 && logs[i].topics[0] == TRANSFER
                    && address(uint160(uint256(logs[i].topics[2]))) == alice
            ) transfers++;
        }
        assertEq(transfers, 1, "one single transfer expected for 24 epochs");

        // Replay: idempotent, pays nothing.
        vm.expectRevert(Distributor.NothingDelivered.selector);
        vm.prank(alice);
        dist.claim(_arr(NVDA), _arr(uint256(24e17)), _arr(_single(lb)));
    }

    /// @notice A root that REDUCES a cumulative pays zero; it does not underflow
    ///         and takes back nothing already paid.
    function test_LowerCumulativePaysNothing() public {
        _fund(0, NVDA, NVDA_WHALE, 5e18);
        _seed(0);
        bytes32 lb = _leaf(bob, NVDA, 2e18);
        _publish(0, _leaf(alice, NVDA, 3e18), lb);
        vm.prank(alice);
        dist.claim(_arr(NVDA), _arr(uint256(3e18)), _arr(_single(lb)));

        // A new root where alice falls back to 1e18 (< already paid).
        _fund(1, NVDA, NVDA_WHALE, 1e18);
        _seed(1);
        bytes32 lb2 = _leaf(bob, NVDA, 3e18);
        _publish(1, _leaf(alice, NVDA, 1e18), lb2);

        vm.expectRevert(Distributor.NothingDelivered.selector);
        vm.prank(alice);
        dist.claim(_arr(NVDA), _arr(uint256(1e18)), _arr(_single(lb2)));
        assertEq(IERC20(NVDA).balanceOf(alice), 3e18, "tokens were taken back");
    }

    /// @notice An inflated root cannot pay out more than the stock received:
    ///         that is the bound limiting a malicious publisher's damage at the
    ///         scale of one stock.
    function test_InflatedRootCannotExceedFunding() public {
        _fund(0, NVDA, NVDA_WHALE, 1e18);
        _seed(0);
        bytes32 lb = _leaf(bob, NVDA, 0);
        _publish(0, _leaf(alice, NVDA, 100e18), lb);

        vm.prank(alice);
        uint256 got = dist.claim(_arr(NVDA), _arr(uint256(100e18)), _arr(_single(lb)));
        assertEq(got, 1e18, "capped at the funded amount");
        assertEq(dist.totalDistributed(NVDA), dist.totalFunded(NVDA), "total invariant");
    }

    /// @notice A single batch settles several stocks.
    function test_MultipleStocksInOneCall() public {
        _fund(0, NVDA, NVDA_WHALE, 2e18);
        _fund(1, SPY, SPY_WHALE, 1e18);
        _seed(1);
        bytes32 lNvda = _leaf(alice, NVDA, 2e18);
        bytes32 lSpy = _leaf(alice, SPY, 1e18);
        bytes32 root = _pair(lNvda, lSpy);
        vm.prank(keeperAddr);
        dist.publishRoot(1, root, root, bytes32("cid"), "bafyTEST");

        address[] memory stocks = new address[](2);
        stocks[0] = NVDA;
        stocks[1] = SPY;
        uint256[] memory cum = new uint256[](2);
        cum[0] = 2e18;
        cum[1] = 1e18;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = _single(lSpy);
        proofs[1] = _single(lNvda);

        vm.prank(alice);
        assertEq(dist.claim(stocks, cum, proofs), 3e18, "both stocks should have been settled");
    }

    /// @notice The push is open to anyone, pays the leaf, and is not profitable in itself.
    function test_PushIsPermissionlessAndProfitable() public {
        _fund(0, NVDA, NVDA_WHALE, 5e18);
        _seed(0);
        bytes32 lb = _leaf(bob, NVDA, 2e18);
        _publish(0, _leaf(alice, NVDA, 3e18), lb);

        address pusher = makeAddr("pusher");
        uint256 before = pusher.balance;
        uint256 g0 = gasleft();
        vm.prank(pusher);
        dist.distribute(alice, _arr(NVDA), _arr(uint256(3e18)), _arr(_single(lb)));
        uint256 used = g0 - gasleft();

        assertEq(IERC20(NVDA).balanceOf(alice), 3e18, "alice not served");
        assertEq(IERC20(NVDA).balanceOf(pusher), 0, "the caller received stocks");
        assertGt(pusher.balance - before, used * block.basefee, "pushing is not profitable");
    }

    function test_BadProofReverts() public {
        _fund(0, NVDA, NVDA_WHALE, 5e18);
        _seed(0);
        _publish(0, _leaf(alice, NVDA, 3e18), _leaf(bob, NVDA, 2e18));
        vm.expectRevert(Distributor.InvalidProof.selector);
        vm.prank(alice);
        dist.claim(_arr(NVDA), _arr(uint256(3e18)), _arr(_single(keccak256("faux"))));
    }

    /// @notice An epoch still running cannot be published, EVEN by the keeper.
    ///
    ///         This is what replaces the seed. A holder's share is a
    ///         time-weighted average over `[GENESIS + e*L, GENESIS + (e+1)*L)`
    ///         — a window fixed by two immutables, that nobody chooses. So
    ///         there is only one thing left to forbid: publishing over a period
    ///         still open, which is an average truncated wherever it suits the
    ///         publisher.
    function test_CannotPublishAnEpochStillRunning() public {
        _fund(0, NVDA, NVDA_WHALE, 1e18);
        uint256 e = dist.currentEpoch();
        vm.expectRevert(abi.encodeWithSelector(Distributor.EpochNotOver.selector, dist.epochEnd(e)));
        vm.prank(keeperAddr);
        dist.publishRoot(e, keccak256("r"), keccak256("r"), bytes32("cid"), "bafyTEST");

        // One second later the same publication goes through.
        vm.warp(dist.epochEnd(e) + 1);
        vm.prank(keeperAddr);
        dist.publishRoot(e, keccak256("r"), keccak256("r"), bytes32("cid"), "bafyTEST");
    }

    /// @notice Publishing is restricted to the keeper. That is THE trade-off of
    ///         the system: no bond and no window, so nothing stops a false root
    ///         — except that nobody else can post one.
    function test_OnlyKeeperCanPublish() public {
        _seed(0);
        bytes32 la = _leaf(alice, NVDA, 1e18);

        vm.expectRevert(Distributor.NotKeeper.selector);
        vm.prank(bob);
        dist.publishRoot(0, la, la, bytes32("cid"), "bafyTEST");

        vm.expectRevert(Distributor.NotKeeper.selector);
        vm.prank(timelock);
        dist.publishRoot(0, la, la, bytes32("cid"), "bafyTEST");

        vm.prank(keeperAddr);
        dist.publishRoot(0, la, la, bytes32("cid"), "bafyTEST");
        assertEq(dist.activeRoot(), 1, "the keeper root must take effect immediately");
    }

    /// @notice The timelock can revoke a compromised key, and the keeper cannot
    ///         revoke itself. It takes 48 h, so it does not stop a theft in
    ///         progress: it stops it from happening again.
    ///
    /// @dev    There is a second caller, and it is not tested here because it
    ///         does not exist for a standalone Distributor: a vault that names
    ///         a registry lets that registry rotate it too, which is what
    ///         `Payd.rotateKeeper` uses to reach every live vault in one
    ///         operation. Held by
    ///         `test_RotateKeeperReachesEveryLiveVaultAndSkipsWhatItCannot`.
    function test_OnlyTimelockRotatesKeeper() public {
        address nouveau = makeAddr("newKeeper");

        vm.expectRevert(Distributor.NotTimelock.selector);
        vm.prank(keeperAddr);
        dist.setKeeper(nouveau);

        vm.prank(timelock);
        dist.setKeeper(nouveau);
        assertEq(dist.keeper(), nouveau, "keeper not rotated");

        // The old key publishes nothing any more.
        _seed(0);
        bytes32 la = _leaf(alice, NVDA, 1e18);
        vm.expectRevert(Distributor.NotKeeper.selector);
        vm.prank(keeperAddr);
        dist.publishRoot(0, la, la, bytes32("cid"), "bafyTEST");
    }

    function test_CurrentEpochFollowsClock() public {
        assertEq(dist.currentEpoch(), 0, "initial epoch");
        vm.warp(genesis + EPOCH_LENGTH * 5 + 1);
        assertEq(dist.currentEpoch(), 5, "schedule shifted");
    }

    /// @notice Only the timelock manages the exclusion list.
    function test_OnlyTimelockSetsExcluded() public {
        address[] memory a = _arr(makeAddr("cex"));
        vm.expectRevert(Distributor.NotTimelock.selector);
        vm.prank(keeper);
        dist.setExcluded(a, true);

        vm.prank(timelock);
        dist.setExcluded(a, true);
        assertTrue(dist.isExcluded(a[0]), "exclusion not recorded");
        assertEq(dist.excludedList().length, 1, "list not maintained");
    }

    /// @notice The covered range must MOVE FORWARD. Republishing the same range
    ///         would allow rewriting a root already in force — hence
    ///         redistributing an epoch already settled.
    function test_RootScopeCannotRegress() public {
        _seed(0);
        bytes32 la = _leaf(alice, NVDA, 1e18);
        _publish(0, la, la); // root active at upToEpoch = 0

        vm.expectRevert(Distributor.BadInput.selector);
        vm.prank(keeperAddr);
        dist.publishRoot(0, la, la, bytes32("cid"), "bafyTEST");
    }

    /// @notice An exclusion is DATED, takes effect at the next epoch, and the
    ///         past is never rewritten.
    ///
    ///         Without this, two honest verifiers replaying the same epoch on
    ///         either side of a `setExcluded` read `isExcluded`, a live boolean,
    ///         and produced DIFFERENT roots. A good-faith challenger lost their
    ///         bond over a disagreement that is not fraud.
    function test_ExclusionIsDatedAndNeverRewritesThePast() public {
        address cex = makeAddr("cex");
        address[] memory a = _arr(cex);

        // Move forward so we do not test at the edge of epoch 0.
        vm.warp(block.timestamp + 10 * dist.EPOCH_LENGTH());
        uint256 at = dist.currentEpoch();

        vm.prank(timelock);
        dist.setExcluded(a, true);

        // The current epoch is untouched: shares may already have been computed
        // for it. The effect starts at the next one.
        assertFalse(dist.isExcludedAt(cex, at), "the current epoch was rewritten");
        assertTrue(dist.isExcludedAt(cex, at + 1), "the exclusion does not bite at the next epoch");
        assertTrue(dist.isExcludedAt(cex, at + 500), "the exclusion must persist");

        // Reinstatement later: it must not erase the excluded period.
        vm.warp(block.timestamp + 20 * dist.EPOCH_LENGTH());
        uint256 back = dist.currentEpoch();
        vm.prank(timelock);
        dist.setExcluded(a, false);

        assertTrue(dist.isExcludedAt(cex, at + 1), "the past was rewritten by the reinstatement");
        assertTrue(dist.isExcludedAt(cex, back), "the reinstatement must not bite on the current epoch");
        assertFalse(dist.isExcludedAt(cex, back + 1), "the reinstatement does not take effect");

        // The log carries both changes, dated and increasing.
        Distributor.ExclusionChange[] memory log = dist.exclusionLog();
        assertEq(log.length, 2, "incomplete log");
        assertEq(log[0].fromEpoch, uint48(at + 1), "date of the first change");
        assertEq(log[1].fromEpoch, uint48(back + 1), "date of the second change");
        assertTrue(log[0].state && !log[1].state, "states recorded wrong");
        assertLe(log[0].fromEpoch, log[1].fromEpoch, "fromEpoch must be increasing");
    }

    // ================================================================
    //  Guard clauses. Every branch below refuses something; none of them
    //  had ever been taken. A guard nobody has seen refuse is a guard
    //  nobody has seen work.
    // ================================================================

    /// @dev Clone first, arm second. A `CREATE` under an armed `expectRevert`
    ///      consumes it, and the failure reported is `LibClone`'s, not ours.
    function test_InitRefusesZeroAddressesAndZeroTiming() public {
        Distributor d;
        d = _bareDistributor();
        vm.expectRevert(Distributor.ZeroAddress.selector);
        d.init(address(0), timelock, keeperAddr, genesis, EPOCH_LENGTH);

        d = _bareDistributor();
        vm.expectRevert(Distributor.ZeroAddress.selector);
        d.init(feeVault, address(0), keeperAddr, genesis, EPOCH_LENGTH);

        d = _bareDistributor();
        vm.expectRevert(Distributor.ZeroAddress.selector);
        d.init(feeVault, timelock, address(0), genesis, EPOCH_LENGTH);

        d = _bareDistributor();
        vm.expectRevert(Distributor.BadInput.selector);
        d.init(feeVault, timelock, keeperAddr, 0, EPOCH_LENGTH);

        d = _bareDistributor();
        vm.expectRevert(Distributor.BadInput.selector);
        d.init(feeVault, timelock, keeperAddr, genesis, 0);
    }

    function test_FundRefusesAZeroStockOrAZeroAmount() public {
        _closeEpoch(0);
        vm.expectRevert(Distributor.BadInput.selector);
        _fundRaw(0, address(0), 1, ETH_SPENT);

        vm.expectRevert(Distributor.BadInput.selector);
        _fundRaw(0, NVDA, 0, ETH_SPENT);
    }

    function test_PublishRefusesAnEmptyClaimRoot() public {
        uint256 e = dist.currentEpoch();
        _seed(e);
        vm.prank(keeperAddr);
        vm.expectRevert(Distributor.BadInput.selector);
        dist.publishRoot(e, bytes32(0), bytes32("push"), bytes32("cid"), "bafyTEST");
    }

    function test_SetKeeperRefusesTheZeroAddress() public {
        vm.prank(timelock);
        vm.expectRevert(Distributor.BadInput.selector);
        dist.setKeeper(address(0));
    }

    /// Settlement input guards, in one place: they all sit above the Merkle
    /// verification, so nothing here needs a valid tree.
    function test_SettlementRefusesMalformedBatches() public {
        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = NVDA;

        // No active root yet.
        vm.prank(alice);
        vm.expectRevert(Distributor.NoActiveRoot.selector);
        dist.claim(stocks, cum, proofs);

        // Empty batch, and mismatched lengths.
        address[] memory none = new address[](0);
        uint256[] memory cum0 = new uint256[](0);
        bytes32[][] memory pr0 = new bytes32[][](0);
        vm.prank(alice);
        vm.expectRevert(Distributor.BatchMismatch.selector);
        dist.claim(none, cum0, pr0);

        uint256[] memory cum2 = new uint256[](2);
        vm.prank(alice);
        vm.expectRevert(Distributor.BatchMismatch.selector);
        dist.claim(stocks, cum2, proofs);

        // Over MAX_BATCH.
        uint256 big = dist.MAX_BATCH() + 1;
        address[] memory many = new address[](big);
        uint256[] memory manyCum = new uint256[](big);
        bytes32[][] memory manyPr = new bytes32[][](big);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Distributor.BatchTooLarge.selector, dist.MAX_BATCH()));
        dist.claim(many, manyCum, manyPr);

        // `distribute` takes the account as an argument, so unlike `claim` it
        // can actually be handed address(0).
        vm.expectRevert(Distributor.BadInput.selector);
        dist.distribute(address(0), stocks, cum, proofs);
    }

    /// A root published with an EMPTY push tree must refuse pushes while still
    /// accepting claims — the two trees are read independently.
    function test_AnEmptyPushTreeRefusesPushesOnly() public {
        uint256 e = dist.currentEpoch();
        _fund(e, NVDA, NVDA_WHALE, 1e18);
        _seed(e);

        bytes32 leaf = _leaf(alice, NVDA, 1e18);
        vm.prank(keeperAddr);
        dist.publishRoot(e, leaf, bytes32(0), bytes32("cid"), "bafyTEST");

        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = NVDA;
        cum[0] = 1e18;
        proofs[0] = new bytes32[](0);

        vm.expectRevert(Distributor.NoActiveRoot.selector);
        dist.distribute(alice, stocks, cum, proofs);

        vm.prank(alice);
        assertEq(dist.claim(stocks, cum, proofs), 1e18, "the claim side must still work");
    }

    function test_SetExcludedSkipsTheZeroAddress() public {
        address[] memory list = new address[](2);
        list[0] = address(0);
        list[1] = alice;

        vm.prank(timelock);
        dist.setExcluded(list, true);

        assertTrue(dist.isExcluded(alice), "alice should be excluded");
        assertFalse(dist.isExcluded(address(0)), "address(0) must never be recorded");
        assertEq(dist.exclusionLog().length, 1, "only one entry should have been logged");
    }

    /// The refund is best effort. With an empty reserve there is nothing to pay
    /// and the action must still go through — that is the point of S8.
    function test_AnEmptyReserveSkipsTheRefundWithoutBlocking() public {
        bytes32 lb = _deliverable(0, 1e18);
        vm.deal(address(dist), 0);

        uint256 before = address(this).balance;
        dist.distribute(alice, _arr(NVDA), _arr(uint256(1e18)), _arr(_single(lb)));
        assertEq(address(this).balance, before, "nothing could be refunded");
        assertEq(IERC20(NVDA).balanceOf(alice), 1e18, "and the delivery must still have happened");
    }

    /// The gas reserve and the deferred payments share ONE balance. A refund
    /// must only ever spend the free part of it: otherwise the reserve pays a
    /// third party with ETH already owed to somebody else, and that somebody's
    /// `withdraw()` then reverts for want of funds — a debt the contract still
    /// says it owes, backed by nothing.
    function test_ARefundNeverSpendsWhatIsAlreadyOwed() public {
        Rejector r = new Rejector();
        vm.deal(address(dist), 0.5 ether);

        bytes32 l0 = _deliverable(0, 1e18);
        vm.prank(address(r));
        dist.distribute(alice, _arr(NVDA), _arr(uint256(1e18)), _arr(_single(l0)));
        uint256 owed = dist.pendingWithdrawal(address(r));
        assertGt(owed, 0, "no deferred payment, the test proves nothing");
        assertEq(dist.pendingTotal(), owed, "pendingTotal out of step with the debt");

        // Squeeze the reserve down to exactly the debt, then let a healthy
        // caller go on earning refunds. There is no free ETH left, so it must
        // be paid nothing — and the action must still go through.
        vm.deal(address(dist), owed);
        for (uint256 i = 1; i <= 3; ++i) {
            bytes32 lb = _deliverable(i, 1e18 * (i + 1));
            uint256 before = address(this).balance;
            dist.distribute(alice, _arr(NVDA), _arr(uint256(1e18 * (i + 1))), _arr(_single(lb)));
            assertEq(address(this).balance, before, "a refund was paid out of somebody else's money");
        }
        assertGe(address(dist).balance, dist.pendingTotal(), "the debt is no longer covered");
    }

    function test_WithdrawRevertsWhenTheRecipientRefusesEth() public {
        Rejector r = new Rejector();
        vm.deal(address(dist), 1 ether);

        // Earn a refund the 30,000 gas push cannot deliver: it becomes a debt.
        bytes32 lb = _deliverable(0, 1e18);
        vm.prank(address(r));
        dist.distribute(alice, _arr(NVDA), _arr(uint256(1e18)), _arr(_single(lb)));
        assertGt(dist.pendingWithdrawal(address(r)), 0, "the refund should have been deferred");

        // Pulling it fails too, and says so rather than silently zeroing it.
        vm.expectRevert(Distributor.TransferFailed.selector);
        r.pull(address(dist));
        assertGt(dist.pendingWithdrawal(address(r)), 0, "a failed pull must not consume the debt");
    }

    /// A stock that refuses to move must cost the holder NOTHING. The transfer
    /// is attempted first and the entitlement is written only if it succeeds,
    /// so a frozen, paused or blocklisting token defers the payment instead of
    /// destroying it (S4). This is the try/catch the whole delivery side rests
    /// on, and it had never once caught anything.
    function test_AFrozenStockDefersDeliveryAndBurnsNoEntitlement() public {
        BrokenStock bs = new BrokenStock();
        uint256 e = dist.currentEpoch();
        bs.mint(address(dist), 5e18);
        _closeEpoch(e);
        _fundRaw(e, address(bs), 5e18, ETH_SPENT);
        _seed(e);

        bytes32 leaf = _leaf(alice, address(bs), 5e18);
        vm.prank(keeperAddr);
        dist.publishRoot(e, leaf, leaf, bytes32("cid"), "bafyTEST");

        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = address(bs);
        cum[0] = 5e18;
        proofs[0] = new bytes32[](0);

        // The token is frozen: nothing is delivered, and the call says so
        // rather than reporting a silent success.
        vm.prank(alice);
        vm.expectRevert(Distributor.NothingDelivered.selector);
        dist.claim(stocks, cum, proofs);
        assertEq(dist.claimedSoFar(alice, address(bs)), 0, "a failed delivery must record nothing");

        // A token that returns false rather than reverting must be treated the
        // same way — the return value is checked, not just the absence of a revert.
        bs.setMode(BrokenStock.Mode.ReturnsFalse);
        vm.prank(alice);
        vm.expectRevert(Distributor.NothingDelivered.selector);
        dist.claim(stocks, cum, proofs);
        assertEq(dist.claimedSoFar(alice, address(bs)), 0, "returning false must not count as delivered");

        // Once it works again the entitlement is still whole.
        bs.setMode(BrokenStock.Mode.Works);
        vm.prank(alice);
        assertEq(dist.claim(stocks, cum, proofs), 5e18, "the entitlement must have survived");
        assertEq(bs.balanceOf(alice), 5e18, "the holder must actually hold it");
    }

    /// The reentrancy guard, made to refuse. The gas refund hands control back
    /// to the caller; a caller that re-enters must be stopped there.
    function test_TheReentrancyGuardRefusesAReentrantCall() public {
        bytes32 lb = _deliverable(0, 1e18);
        Reenterer r = new Reenterer(dist);
        vm.deal(address(dist), 1 ether);

        r.go(alice, _arr(NVDA), _arr(uint256(1e18)), _arr(_single(lb)));

        assertTrue(r.guardHeld(), "the reentrant call should have been refused by the guard");
        assertEq(IERC20(NVDA).balanceOf(alice), 1e18, "and the outer call must still have gone through");
    }

    receive() external payable {}

    // ------------------------------------------------------- audit, 2026-09-11

    /// @notice **T-ROOT-01 — a false root takes the stock's WHOLE undelivered
    ///         balance, and that is now what the documents say.**
    ///
    /// @dev    **REWRITTEN 2026-09-11, and the rewrite is the fix.** This test
    ///         used to assert `got <= perWindow` — the property `FLOWS.md` §7.c
    ///         and `docs/ARCHITECTURE.md` §S29 published, "about one epoch in
    ///         the contract", ~$42/$83/$417 a day. It was red, and the
    ///         resolution is not a narrower clamp: nothing on-chain separates a
    ///         thief's leaf from a dormant holder's, so any cap that refuses the
    ///         first refuses the second by exactly as much, and §S29 removed the
    ///         bond and the challenge window that were the other two answers.
    ///         A per-root fraction was costed and rejected — 96 roots fit inside
    ///         the 48 h a revocation takes, so a 1 % cap still reaches 62 % of
    ///         the pot while throttling every honest dormant claim by the same
    ///         1 % (`docs/AUDIT_FIXES.md` §2.1).
    ///
    ///         So the DOCUMENTS moved to the enforced number and this test is
    ///         now what pins them: §S29, `FLOWS.md` §7.c, `AUDIT_PLAN.md` §7.1
    ///         and `Distributor.quoteAtRisk`'s own NatSpec all now say
    ///         `totalFunded − totalDistributed`, i.e. `holders below the push
    ///         floor × pushFloor + one window in flight`. Twelve unswept windows
    ///         is the cheapest honest way to stage that here, and the assertion
    ///         below is that the whole twelve is reachable — which is the
    ///         sentence a reader of §7.1 has to be able to trust.
    ///
    ///         `test_InflatedRootCannotExceedFunding` above already shows the
    ///         only bound there is — `Distributor._one:544-545`, `owed` clamped
    ///         to `totalFunded - totalDistributed` — and asserts the claimant
    ///         walks with 100 % of it. That test is right and stays. This one
    ///         asks the different question: is that clamp the number the
    ///         documents quote? The premise behind "only about one epoch is in
    ///         the contract" is that deliveries run continuously, and
    ///         `offchain/src/epoch.ts:306` pushes an entry only once its
    ///         outstanding value clears `pushFloor` — so every holder under
    ///         ~$10 carries their entitlement indefinitely and the undelivered
    ///         balance is `holders below the floor x pushFloor`, plus one epoch
    ///         in flight. Twelve unswept windows is the cheapest honest way to
    ///         stage that here.
    ///
    ///         Nothing is mocked: real NVDA, the real clamp, the real root.
    // T-ROOT-01
    function test_AFalseRootTakesTheWholeUndeliveredBalance() public {
        uint256 perWindow = 1e18;
        uint256 windows = 12;
        for (uint256 e; e < windows; ++e) {
            _fund(e, NVDA, NVDA_WHALE, perWindow);
        }

        uint256 pot = dist.totalFunded(NVDA) - dist.totalDistributed(NVDA);
        assertEq(pot, windows * perWindow, "fixture: nothing was delivered, so the whole history is outstanding");

        address attacker = makeAddr("attacker");
        _seed(windows - 1);
        bytes32 lb = _leaf(bob, NVDA, 0);
        _publish(windows - 1, _leaf(attacker, NVDA, type(uint128).max), lb);

        vm.prank(attacker);
        uint256 got = dist.claim(_arr(NVDA), _arr(uint256(type(uint128).max)), _arr(_single(lb)));

        emit log_named_uint("taken by the false root, raw NVDA ", got);
        emit log_named_uint("one window's funding, raw NVDA    ", perWindow);
        emit log_named_uint("ratio, taken / one window         ", got / perWindow);
        emit log_named_uint("windows left unswept              ", windows);

        assertEq(got, pot, "the enforced ceiling is the stock's whole undelivered balance, per Distributor._one");
        assertGt(
            got,
            perWindow,
            "and it is more than one window: the documents must not go back to saying otherwise (S29, FLOWS 7.c)"
        );
    }

    /// @dev `(stock, cumulative, proof)` repeated `n` times. The first slot
    ///      delivers and writes `claimedSoFar`; the other `n - 1` verify their
    ///      proof and return 0 at `Distributor.sol:541`. One stock, 64 slots —
    ///      the basket size does not bound it, because `_settle` fixes one
    ///      account and never looks at whether two entries name the same stock.
    function _repeat(address stock, uint256 cumulative, bytes32[] memory proof, uint256 n)
        internal
        pure
        returns (address[] memory st, uint256[] memory cu, bytes32[][] memory pf)
    {
        st = new address[](n);
        cu = new uint256[](n);
        pf = new bytes32[][](n);
        for (uint256 i; i < n; ++i) {
            st[i] = stock;
            cu[i] = cumulative;
            pf[i] = proof;
        }
    }

    /// @notice **T-REFUND-01 — a batch that repeats a stock is refused, so
    ///         there is nothing left to price around.**
    ///
    /// @dev    **REWRITTEN 2026-09-11 with the fix.** It used to assert
    ///         `padded <= honest * 1.5` and was red at **1.854x**: one real
    ///         delivery riding with 63 no-ops cost the reserve nearly twice the
    ///         honest refund for the same delivery, because `_refund` prices the
    ///         whole call. The fix refuses the batch rather than pricing around
    ///         it — `_settle` fixes ONE account, so two entries naming the same
    ///         stock can never both deliver, and nothing legitimate repeats one.
    ///         So the assertion is now that the padded call REVERTS, and that
    ///         the honest one still delivers and is still refunded.
    ///
    ///         `_refund(g0)` (`Distributor.sol:651-663`) prices `gasUsed` over
    ///         the whole call, and `_settle` (`:521`) happily loops 64 times
    ///         over the same `(stock, cumulative, proof)`. `distribute` requires
    ///         only that the TOTAL delivered be non-zero (`:491`), so one real
    ///         delivery carries 63 no-ops that each pay for a Merkle
    ///         verification and two SLOADs.
    ///
    ///         **Why refusal rather than a cheaper price.** Charging the
    ///         padding to the padder needs the refund to know which entries did
    ///         work, which is the same arithmetic done twice; and it would
    ///         leave 2 kB of proof calldata on the chain for nothing. Refusing
    ///         costs 28 comparisons on a real 8-line batch and removes the
    ///         construction entirely.
    ///
    ///         Measured at block 60310000: **17 105 303 400 400 wei honest
    ///         against 31 714 125 142 800 padded — 1.854x, not the 3.4x §2.2
    ///         predicts**. The difference is that the repeated entries hit warm
    ///         storage: the same `claimedSoFar`, `totalFunded` and
    ///         `totalDistributed` slots 64 times over, at 100 gas rather than
    ///         the ~3 500 the plan budgets. The property still fails, and the
    ///         honest figure is the one worth carrying forward.
    ///
    ///         **No longer `via_ir`-dependent.** The old form rested on the
    ///         ratio of two gas measurements and §3a had measured the sibling
    ///         property failing under `--ir-minimum`. A revert is a revert under
    ///         either pipeline.
    // T-REFUND-01
    function test_ABatchThatRepeatsAStockIsRefused() public {
        _fund(0, NVDA, NVDA_WHALE, 5e18);
        _seed(0);
        bytes32 lb = _leaf(bob, NVDA, 2e18);
        _publish(0, _leaf(alice, NVDA, 3e18), lb);

        address padder = makeAddr("padder");
        uint256 snap = vm.snapshotState();

        // 1. The padded call: the same delivery, 63 no-ops riding with it.
        (address[] memory st, uint256[] memory cu, bytes32[][] memory pf) = _repeat(NVDA, 3e18, _single(lb), 64);
        vm.prank(padder);
        vm.expectRevert(abi.encodeWithSelector(Distributor.DuplicateStock.selector, NVDA));
        dist.distribute(alice, st, cu, pf);

        // Two entries are already two too many: the bar is one per stock, not
        // "not too many".
        (st, cu, pf) = _repeat(NVDA, 3e18, _single(lb), 2);
        vm.prank(padder);
        vm.expectRevert(abi.encodeWithSelector(Distributor.DuplicateStock.selector, NVDA));
        dist.distribute(alice, st, cu, pf);

        // 2. The honest call is untouched: it delivers, and it is refunded.
        vm.revertToState(snap);
        uint256 reserveBefore = address(dist).balance;
        vm.prank(padder);
        uint256 delivered = dist.distribute(alice, _arr(NVDA), _arr(uint256(3e18)), _arr(_single(lb)));
        uint256 honest = reserveBefore - address(dist).balance;

        emit log_named_uint("honest refund, wei", honest);

        assertEq(delivered, 3e18, "the honest call must still deliver");
        assertEq(IERC20(NVDA).balanceOf(padder), 0, "the caller receives no stock: the leaf names alice");
        assertGt(honest, 0, "and it must still be refunded, or the fix has broken the engine");
    }

    /// @notice **T-REFUND-02, as a unit — a delivery worth almost nothing is
    ///         refunded almost nothing.**
    ///
    /// @dev    **REPURPOSED 2026-09-11, and what it used to assert was wrong in
    ///         a way worth recording.** This slot held
    ///         `test_PaddingTheBatchPaysThePadder`, which asserted the padder
    ///         turns a PROFIT — `AUDIT_PLAN.md` §2.2 states they net about
    ///         +1.45 % of the gas burned and that "positive is the whole
    ///         problem: it makes the loop worth running". Measured at block
    ///         60310000 the padder was refunded 31 714 125 142 800 wei against
    ///         a cost of 34 930 731 360 000 — **a net of −9.2 %**, worse still
    ///         in a real transaction where ~2 kB of proof calldata is charged as
    ///         intrinsic gas outside the window the refund prices. So §2.2's two
    ///         halves came apart: the drain was real, the attacker was not. The
    ///         test asserted a property nobody wants to be true, and the fix
    ///         above has since made padding impossible outright.
    ///
    ///         What the slot holds instead is the OTHER half of T-REFUND-02,
    ///         the one that needs no padding at all: a **small** delivery used
    ///         to cost the reserve the same fixed refund as a large one, because
    ///         `_refund` priced the call and nothing related it to what moved.
    ///         The campaign's sharpest counterexample was 23 087 729 830 400 wei
    ///         of refund against about **7 wei** of value delivered.
    ///
    ///         `REFUND_VALUE_BPS` is the bound, and this is it as a unit test: a
    ///         delivery worth almost nothing is refunded at most 10 % of almost
    ///         nothing, and it still DELIVERS — the bar caps, it never reverts.
    // T-REFUND-02
    function test_ASmallDeliveryIsRefundedOnlyUpToWhatItMoved() public {
        // A large window, so that one raw unit of NVDA is worth almost no quote:
        // `backing = owed * quoteFundedFor / totalFunded`.
        _fund(0, NVDA, NVDA_WHALE, 5e18);
        _seed(0);
        bytes32 lb = _leaf(bob, NVDA, 0);
        _publish(0, _leaf(alice, NVDA, 1), lb);

        address pusher = makeAddr("pusher");
        uint256 reserveBefore = address(dist).balance;
        vm.prank(pusher);
        uint256 delivered = dist.distribute(alice, _arr(NVDA), _arr(uint256(1)), _arr(_single(lb)));
        uint256 paid = reserveBefore - address(dist).balance;

        // What that one raw unit was worth, by the contract's own formula.
        uint256 moved = (delivered * dist.quoteFundedFor(NVDA)) / dist.totalFunded(NVDA);
        emit log_named_uint("delivered, raw NVDA     ", delivered);
        emit log_named_uint("worth, wei              ", moved);
        emit log_named_uint("refunded by the reserve ", paid);

        assertEq(delivered, 1, "the delivery must still go through: the bar caps, it never reverts");
        assertLe(
            paid * 10_000,
            moved * dist.REFUND_VALUE_BPS(),
            "the reserve paid more than REFUND_VALUE_BPS of what the delivery moved"
        );
    }
}

/// @dev Refuses ETH however it is offered. Used to drive the deferred-payment
///      and failed-withdrawal branches.
contract Rejector {
    receive() external payable {
        revert("no");
    }

    function pull(address d) external returns (uint256) {
        return Distributor(payable(d)).withdraw();
    }
}

/// @dev A stock that can be made to fail on purpose. Not a mock of Pons nor of
///      Uniswap — those stay real — but a broken TOKEN, which is the only way
///      to see what happens when a delivery fails.
contract BrokenStock {
    enum Mode {
        Reverts,
        ReturnsFalse,
        Works
    }

    Mode public mode = Mode.Reverts;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        if (mode == Mode.Reverts) revert("frozen");
        if (mode == Mode.ReturnsFalse) return false;
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// @dev Re-enters the Distributor from the gas refund it is handed.
contract Reenterer {
    Distributor immutable D;
    bool public guardHeld;

    constructor(Distributor d) {
        D = d;
    }

    function go(address account, address[] calldata stocks, uint256[] calldata cumulative, bytes32[][] calldata proofs)
        external
    {
        D.distribute(account, stocks, cumulative, proofs);
    }

    receive() external payable {
        try D.withdraw() {}
        catch (bytes memory err) {
            if (err.length >= 4 && bytes4(err) == Distributor.Reentrancy.selector) guardHeld = true;
        }
    }
}
