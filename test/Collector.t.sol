// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Collector} from "../contracts/Collector.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @dev A hostile "Distributor": it calls the Collector back while it is
///      running, **with a target that really delivers**.
///
///      The first version called itself back: with no lock it went into
///      recursion until it ran out of gas, the try/catch swallowed the failure,
///      and `succeeded` stayed false either way. The test passed WITH and
///      WITHOUT the lock -- it proved nothing. Verified by mutation, not
///      assumed.
///
///      By targeting a healthy Distributor, the reentrancy SUCCEEDS if the lock
///      is not there. That is what makes the assertion able to fail.
contract Reenterer {
    Collector public immutable COL;
    address public immutable TARGET;
    address public immutable STOCK;
    uint256 public immutable CUM;
    bool public tried;
    bool public succeeded;

    constructor(Collector c, address target, address stock, uint256 cum) {
        COL = c;
        TARGET = target;
        STOCK = stock;
        CUM = cum;
    }

    function distribute(address account, address[] calldata, uint256[] calldata, bytes32[][] calldata)
        external
        returns (uint256)
    {
        tried = true;
        address[] memory ds = new address[](1);
        ds[0] = TARGET;
        address[][] memory st = new address[][](1);
        uint256[][] memory cu = new uint256[][](1);
        bytes32[][][] memory pr = new bytes32[][][](1);
        st[0] = new address[](1);
        st[0][0] = STOCK;
        cu[0] = new uint256[](1);
        cu[0][0] = CUM;
        pr[0] = new bytes32[][](1);
        pr[0][0] = new bytes32[](0);
        try COL.collect(account, ds, st, cu, pr) {
            succeeded = true;
        } catch {}
        return 0;
    }
}

/// @notice **Collecting several launches in one transaction.**
///
/// @dev    Every launch has ITS OWN Distributor, so collecting across five
///         launches used to be five transactions. `Collector` makes it one.
///
///         This file proves the three properties that make that safe: the
///         contract holds NOTHING at the end, the gas refund goes to the caller,
///         and a launch that fails does not take the others down.
contract CollectorTest is CloneBase {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    Collector internal col;
    Distributor internal dA;
    Distributor internal dB;

    address internal vaultA = makeAddr("vault A");
    address internal vaultB = makeAddr("vault B");
    address internal keeper = makeAddr("keeper");
    address internal timelock = makeAddr("timelock");
    address internal holder = makeAddr("holder");
    address internal pusher = makeAddr("a passer-by");

    function setUp() public {
        col = new Collector();
        dA = _cloneDistributor(vaultA, timelock, keeper, block.timestamp, 30 minutes);
        dB = _cloneDistributor(vaultB, timelock, keeper, block.timestamp, 30 minutes);
    }

    /// @dev A SINGLE leaf: the root IS the leaf, the proof is empty. Enough to
    ///      exercise the whole settlement path without building a tree, and that
    ///      is what the invariant campaign already does.
    function _leaf(address who, address stock, uint256 cum) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(who, stock, cum))));
    }

    function _arm(Distributor d, address vault, address stock, uint256 amount) internal {
        deal(stock, address(d), IERC20(stock).balanceOf(address(d)) + amount);
        vm.deal(address(d), 1 ether); // delivery gas reserve

        address[] memory st = new address[](1);
        uint256[] memory am = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        (st[0], am[0], eth[0]) = (stock, amount, 1 ether);

        // `fundWindow` covers a WINDOW of closed epochs: so the end of epoch 0
        // has to be past BEFORE the call, not after.
        if (block.timestamp < d.epochEnd(0)) vm.warp(d.epochEnd(0) + 1);
        vm.prank(vault);
        d.fundWindow(0, st, am, eth);

        bytes32 leaf = _leaf(holder, stock, amount);
        vm.prank(keeper);
        d.publishRoot(0, leaf, leaf, bytes32("cid"), "bafyTEST");
    }

    function _one(address stock, uint256 cum)
        internal
        pure
        returns (address[] memory st, uint256[] memory cu, bytes32[][] memory pr)
    {
        st = new address[](1);
        cu = new uint256[](1);
        pr = new bytes32[][](1);
        st[0] = stock;
        cu[0] = cum;
        pr[0] = new bytes32[](0);
    }

    function test_TwoLaunchesSettleInOneCall() public {
        _arm(dA, vaultA, NVDA, 5e18);
        _arm(dB, vaultB, SPY, 3e18);

        address[] memory ds = new address[](2);
        (ds[0], ds[1]) = (address(dA), address(dB));

        address[][] memory st = new address[][](2);
        uint256[][] memory cu = new uint256[][](2);
        bytes32[][][] memory pr = new bytes32[][][](2);
        (st[0], cu[0], pr[0]) = _one(NVDA, 5e18);
        (st[1], cu[1], pr[1]) = _one(SPY, 3e18);

        uint256 ethBefore = pusher.balance;

        // **Anyone triggers it, and the holder is paid.** The beneficiary is a
        // parameter, not msg.sender -- that is what makes the batching possible
        // without the Collector ever holding anything.
        vm.prank(pusher);
        uint256 settled = col.collect(holder, ds, st, cu, pr);

        assertEq(settled, 2, "both launches must deliver");
        assertEq(IERC20(NVDA).balanceOf(holder), 5e18, "the first one's stock goes to the HOLDER");
        assertEq(IERC20(SPY).balanceOf(holder), 3e18, "and the second one's does too");

        // **The contract keeps nothing.** That is the whole security argument:
        // the tokens never pass through it, and the refunded ETH leaves again.
        assertEq(address(col).balance, 0, "the Collector holds no ETH");
        assertEq(IERC20(NVDA).balanceOf(address(col)), 0, "nor any stock");
        assertGt(pusher.balance, ethBefore, "and the gas is refunded to the CALLER");
    }

    /// @notice A launch that fails does not take the others down.
    ///
    /// @dev    Same rule as a leg that cannot be bought in a basket: the rest
    ///         goes through. Without it, a single launch with nothing to deliver
    ///         would cost the caller the other four.
    function test_AFailingLaunchDoesNotTakeTheOthersDown() public {
        _arm(dA, vaultA, NVDA, 5e18);
        // dB is neither funded nor published: its `distribute` reverts.

        address[] memory ds = new address[](2);
        (ds[0], ds[1]) = (address(dB), address(dA)); // the dead one FIRST

        address[][] memory st = new address[][](2);
        uint256[][] memory cu = new uint256[][](2);
        bytes32[][][] memory pr = new bytes32[][][](2);
        (st[0], cu[0], pr[0]) = _one(SPY, 1e18);
        (st[1], cu[1], pr[1]) = _one(NVDA, 5e18);

        vm.prank(pusher);
        uint256 settled = col.collect(holder, ds, st, cu, pr);

        assertEq(settled, 1, "only one delivered");
        assertEq(IERC20(NVDA).balanceOf(holder), 5e18, "and it is the one that could");
        assertEq(address(col).balance, 0, "the contract stays empty");
    }

    /// @notice Nothing to collect reverts rather than costing gas for nothing.
    /// @notice **T-HYP-03, settled: the dust is real, it is stranded, and it is
    ///         bounded by callers who refuse their own money.**
    ///
    /// @dev    `collect` measures `address(this).balance` BEFORE the loop and
    ///         forwards only the delta, so a previous caller's unrefunded
    ///         remainder stays. `AUDIT_PLAN.md` Appendix A asks whether that is
    ///         permanently stranded. It is: there is no `withdraw` here, and the
    ///         next call forwards only its OWN delta — which is the design and
    ///         not an oversight, since forwarding the residue would make it a
    ///         prize for whoever calls next.
    ///
    ///         **What bounds it is who can create it.** Dust appears only when
    ///         `msg.sender.call` fails, i.e. when the caller is a contract that
    ///         refuses ETH — and the amount it loses is its own refund. An EOA
    ///         never leaves any. So this is bookkeeping rather than loss: the
    ///         only address that can be out of pocket is one that declined the
    ///         payment.
    ///
    ///         The refund is swallowed on purpose (`ok;`): a caller refusing its
    ///         own money must not undo settled deliveries for the holder, who
    ///         chose none of this.
    function test_ACallerThatRefusesItsRefundStrandsItAndNobodyElseGetsIt() public {
        _arm(dA, vaultA, NVDA, 5e18);
        (address[] memory st, uint256[] memory cu, bytes32[][] memory pr) = _one(NVDA, 5e18);
        address[] memory ds = new address[](1);
        ds[0] = address(dA);

        Refuser refuser = new Refuser();
        vm.prank(address(refuser));
        uint256 settled = col.collect(holder, ds, _wrap(st), _wrapU(cu), _wrapP(pr));

        assertEq(settled, 1, "the holder is served whatever the caller does with its refund");
        assertEq(IERC20(NVDA).balanceOf(holder), 5e18, "and served in full");
        uint256 dust = address(col).balance;
        assertGt(dust, 0, "a caller that refuses its refund leaves it here");
        assertEq(address(refuser).balance, 0, "and is out of pocket by exactly that, which is its own doing");

        // **The next caller does not inherit it.** That is the property the
        // before/after measurement exists for: the residue is not a prize.
        _arm(dB, vaultB, SPY, 3e18);
        (address[] memory st2, uint256[] memory cu2, bytes32[][] memory pr2) = _one(SPY, 3e18);
        address[] memory ds2 = new address[](1);
        ds2[0] = address(dB);

        uint256 before = pusher.balance;
        vm.prank(pusher);
        col.collect(holder, ds2, _wrap(st2), _wrapU(cu2), _wrapP(pr2));

        assertLt(pusher.balance - before, dust + 1 ether, "the second caller is paid its own refund");
        assertGe(address(col).balance, dust, "and the first caller's dust is still sitting here");
    }

    function _wrap(address[] memory a) internal pure returns (address[][] memory o) {
        o = new address[][](1);
        o[0] = a;
    }

    function _wrapU(uint256[] memory a) internal pure returns (uint256[][] memory o) {
        o = new uint256[][](1);
        o[0] = a;
    }

    function _wrapP(bytes32[][] memory a) internal pure returns (bytes32[][][] memory o) {
        o = new bytes32[][][](1);
        o[0] = a;
    }

    function test_NothingToCollectReverts() public {
        address[] memory ds = new address[](1);
        ds[0] = address(dA);
        address[][] memory st = new address[][](1);
        uint256[][] memory cu = new uint256[][](1);
        bytes32[][][] memory pr = new bytes32[][][](1);
        (st[0], cu[0], pr[0]) = _one(NVDA, 1e18);

        vm.expectRevert(Collector.NothingCollected.selector);
        col.collect(holder, ds, st, cu, pr);
    }

    /// @notice A hostile "Distributor" cannot come back in through the window.
    ///
    /// @dev    There is nothing to steal -- the contract holds nothing -- and the
    ///         danger lies elsewhere. Verified by MUTATION: with the lock
    ///         removed, the test fails on `NothingCollected`, because the nested
    ///         call DELIVERS FIRST and the outer loop no longer finds anything to
    ///         deliver.
    ///
    ///         So the reentrancy takes nothing: it CONSUMES what the loop was
    ///         expecting, and skews the refund on the way, which is a
    ///         before/after balance difference.
    function test_AHostileTargetCannotReenter() public {
        _arm(dA, vaultA, NVDA, 5e18);
        // The reentrancy targets the HEALTHY Distributor: if the lock is
        // missing, the nested call succeeds and the assertion fails.
        Reenterer bad = new Reenterer(col, address(dA), NVDA, 5e18);

        address[] memory ds = new address[](2);
        (ds[0], ds[1]) = (address(bad), address(dA));
        address[][] memory st = new address[][](2);
        uint256[][] memory cu = new uint256[][](2);
        bytes32[][][] memory pr = new bytes32[][][](2);
        (st[0], cu[0], pr[0]) = _one(SPY, 1e18);
        (st[1], cu[1], pr[1]) = _one(NVDA, 5e18);

        vm.prank(pusher);
        uint256 settled = col.collect(holder, ds, st, cu, pr);

        assertTrue(bad.tried(), "the harness must really have attempted the reentrancy");
        assertFalse(bad.succeeded(), "and it must have failed");
        assertEq(settled, 1, "the honest launch still goes through");
        assertEq(IERC20(NVDA).balanceOf(holder), 5e18, "and delivers");
        assertEq(address(col).balance, 0, "the contract stays empty");
    }

    /// @notice Misaligned arrays are refused, not silently truncated.
    function test_MismatchedArraysRevert() public {
        address[] memory ds = new address[](2);
        (ds[0], ds[1]) = (address(dA), address(dB));
        address[][] memory st = new address[][](1);
        uint256[][] memory cu = new uint256[][](2);
        bytes32[][][] memory pr = new bytes32[][][](2);

        vm.expectRevert(Collector.LengthMismatch.selector);
        col.collect(holder, ds, st, cu, pr);
    }
}

/// @dev A caller that refuses its own refund. Not a stand-in for anything: it is
///      the only way the `Collector`'s dust can be created at all.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}
