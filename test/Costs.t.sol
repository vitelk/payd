// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @notice Measures the cycle's real costs, so we reason on figures rather than
///         on estimates. Against the chain's real state.
contract CostsTest is CloneBase {
    address keeperAddr = makeAddr("keeperAddr");
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_WHALE = 0x9f736F87E6293AC1Bd9142E257dbfAC8b7AcF1ae;
    address constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address constant SPY_WHALE = 0xC8b77E0dabfea5E3B4eC6F313BF8358BC1BC121c;

    Distributor dist;
    address feeVault = makeAddr("feeVault");
    address timelock = makeAddr("timelock");
    address proposer = makeAddr("proposer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        dist = _cloneDistributor(feeVault, timelock, keeperAddr, block.timestamp, 1 hours);
        vm.deal(proposer, 10 ether);
        vm.deal(address(dist), 1 ether);
    }

    function _leaf(address h, address s, uint256 c) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(h, s, c))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    function _two(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        out[0] = a;
        out[1] = b;
    }

    function _amounts(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    function test_MeasureCycleCosts() public {
        uint256 g;

        // --- fund (called by the vault every epoch)
        deal(NVDA, address(dist), IERC20(NVDA).balanceOf(address(dist)) + 10e18);
        deal(SPY, address(dist), IERC20(SPY).balanceOf(address(dist)) + 10e18);
        // ONE call for the whole basket and the whole window, where Payd paid
        // `fund` once per epoch per stock (docs/ARCHITECTURE.md S39).
        vm.warp(dist.epochEnd(1) + 1);
        g = gasleft();
        vm.prank(feeVault);
        dist.fundWindow(1, _two(NVDA, SPY), _amounts(5e18, 5e18), _amounts(1e16, 1e16));
        console.log("fundWindow 2 stk:", g - gasleft());

        // --- publication, once per CYCLE. No bond, no finalisation: the root
        //     takes effect immediately.
        bytes32 la = _leaf(alice, NVDA, 3e18);
        bytes32 lb = _leaf(alice, SPY, 2e18);
        bytes32 root = _pair(la, lb);
        g = gasleft();
        vm.prank(keeperAddr);
        dist.publishRoot(1, root, root, bytes32("cid"), "bafyTEST");
        console.log("publishRoot     :", g - gasleft());

        // --- settling ONE holder across TWO stocks, in ONE call.
        //     That is the real shape of an airdrop: one transaction per holder,
        //     one entry per stock.
        address[] memory st = new address[](2);
        uint256[] memory cu = new uint256[](2);
        bytes32[][] memory pr = new bytes32[][](2);
        st[0] = NVDA;
        cu[0] = 3e18;
        pr[0] = new bytes32[](1);
        pr[0][0] = lb;
        st[1] = SPY;
        cu[1] = 2e18;
        pr[1] = new bytes32[](1);
        pr[1][0] = la;

        address pusher = makeAddr("pusher");
        g = gasleft();
        vm.prank(pusher);
        dist.distribute(alice, st, cu, pr);
        uint256 gPush2 = g - gasleft();
        console.log("distribute 2 stk:", gPush2);
        console.log("  -> per stock  :", (gPush2 - 21000) / 2);
    }

    /// @notice What a per-holder transaction costs, split into the part that is
    ///         PAID ONCE per holder and the part that scales with their stocks.
    ///
    ///         That split is the whole question behind a `distributeMany`: only
    ///         the fixed part can ever be shared between holders. The variable
    ///         part — a proof to verify, a ledger row to write, an ERC-20
    ///         transfer — is owed per (holder, stock) whatever the shape of the
    ///         call.
    function test_MeasureWhatABatchCouldSave() public {
        deal(NVDA, address(dist), IERC20(NVDA).balanceOf(address(dist)) + 10e18);
        deal(SPY, address(dist), IERC20(SPY).balanceOf(address(dist)) + 10e18);
        vm.warp(dist.epochEnd(1) + 1);
        vm.prank(feeVault);
        dist.fundWindow(1, _two(NVDA, SPY), _amounts(5e18, 5e18), _amounts(1e16, 1e16));

        // A four-leaf tree: alice takes one stock, bob takes two.
        bytes32 l0 = _leaf(alice, NVDA, 1e18);
        bytes32 l1 = _leaf(bob, NVDA, 1e18);
        bytes32 l2 = _leaf(bob, SPY, 1e18);
        bytes32 l3 = _leaf(makeAddr("carol"), NVDA, 1e18);
        bytes32 top = _pair(_pair(l0, l1), _pair(l2, l3));
        vm.prank(keeperAddr);
        dist.publishRoot(1, top, top, bytes32("cid"), "bafyTEST");

        // --- one holder, ONE stock
        address[] memory s1 = new address[](1);
        uint256[] memory c1 = new uint256[](1);
        bytes32[][] memory p1 = new bytes32[][](1);
        s1[0] = NVDA;
        c1[0] = 1e18;
        p1[0] = new bytes32[](2);
        p1[0][0] = l1;
        p1[0][1] = _pair(l2, l3);

        // An address that ALREADY EXISTS: paying a fresh one costs 25,000 gas
        // of account creation, which is a property of the payee and not of the
        // function. The keeper's wallet has existed for a long time.
        address pusher = makeAddr("pusher");
        vm.deal(pusher, 1 ether);
        uint256 g = gasleft();
        vm.prank(pusher);
        dist.distribute(alice, s1, c1, p1);
        uint256 one = g - gasleft();

        // --- one holder, TWO stocks
        address[] memory s2 = new address[](2);
        uint256[] memory c2 = new uint256[](2);
        bytes32[][] memory p2 = new bytes32[][](2);
        s2[0] = NVDA;
        c2[0] = 1e18;
        p2[0] = new bytes32[](2);
        p2[0][0] = l0;
        p2[0][1] = _pair(l2, l3);
        s2[1] = SPY;
        c2[1] = 1e18;
        p2[1] = new bytes32[](2);
        p2[1][0] = l3;
        p2[1][1] = _pair(l0, l1);

        g = gasleft();
        vm.prank(pusher);
        dist.distribute(bob, s2, c2, p2);
        uint256 two = g - gasleft();

        uint256 perStock = two - one;
        // The 21,000 of the transaction itself is outside the measured frame.
        uint256 fixedPerHolder = one + 21_000 - perStock;

        console.log("distribute 1 stock      :", one + 21_000);
        console.log("distribute 2 stocks     :", two + 21_000);
        console.log("marginal cost per stock :", perStock);
        console.log("fixed cost per HOLDER   :", fixedPerHolder);
        console.log("  ^ that, minus one refund, is all a distributeMany can save per holder");

        _measureClaim(one);
    }

    /// @dev The same settlement WITHOUT the refund: `claim`, paid by the holder.
    ///      The gap between the two is exactly what refunding costs — split out
    ///      into its own frame because the measurement above runs out of stack.
    function _measureClaim(uint256 pushed) internal {
        address carol = makeAddr("carol");
        // Recomputed rather than passed in: five arguments blew the stack of
        // the caller, and these are pure functions of the addresses anyway.
        bytes32 l0 = _leaf(alice, NVDA, 1e18);
        bytes32 l1 = _leaf(bob, NVDA, 1e18);
        bytes32 l2 = _leaf(bob, SPY, 1e18);
        address[] memory st = new address[](1);
        uint256[] memory cu = new uint256[](1);
        bytes32[][] memory pr = new bytes32[][](1);
        st[0] = NVDA;
        cu[0] = 1e18;
        pr[0] = new bytes32[](2);
        pr[0][0] = l2;
        pr[0][1] = _pair(l0, l1);

        uint256 g = gasleft();
        vm.prank(carol);
        dist.claim(st, cu, pr);
        uint256 claimOne = g - gasleft();
        console.log("claim 1 stock (holder pays):", claimOne + 21_000);
        console.log("  refund machinery costs   :", pushed - claimOne);
    }
}
