// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BLS} from "solady/utils/ext/ithaca/BLS.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LotteryDistributor} from "../../contracts/lottery/LotteryDistributor.sol";

/// @dev A minimal ERC20 to stand in for a stock in the pot. The draw logic does
///      not care what the token is — the pot is a balance — so this keeps the
///      lifecycle test fork-independent. The beacon it settles against is real.
contract MiniToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// @dev A token that is paused: reverts on transfer. Used to prove a leg defers
///      and the entitlement survives for a later collect.
contract PausedToken {
    function balanceOf(address) external pure returns (uint256) {
        return 500e18;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("paused");
    }
}

/// @notice **The draw lifecycle against a real quicknet beacon** (round
///         1,000,000, public history — not a mock). Runs under the `prague` EVM
///         for the EIP-2537 precompiles. The `LotteryDistributor` is exercised
///         in isolation with the test acting as its vault and keeper, so the
///         draw — publish for a future round, settle with the beacon, collect
///         the prize — is tested end to end without needing Pons.
contract DrawLifecycleTest is Test {
    // Round 1,000,000: real signature and, since the draw is deterministic in
    // it, a known winning ticket of 93_389 out of 1_000_000 (recon §14.1).
    uint64 constant ROUND = 1_000_000;
    uint256 constant DRAND_GENESIS = 1_692_803_367;
    uint256 constant TOTAL_TICKETS = 1_000_000;
    uint256 constant WINNING_TICKET = 93_389;

    uint256 constant EPOCH_LENGTH = 30 minutes;
    uint256 constant POT_BPS = 1_000; // 10 %

    LotteryDistributor dist;
    MiniToken stockA;
    MiniToken stockB;

    address winner = makeAddr("winner");
    address loser = makeAddr("loser");
    address timelock = makeAddr("timelock");

    // A time at which round 1,000,000 is ~210 rounds in the future.
    uint256 t0 = DRAND_GENESIS + (ROUND - 210) * 3;

    function setUp() public {
        vm.warp(t0);
        // genesis 20 epochs back, so epochs 0..19 are closed at t0.
        uint256 genesis = t0 - 20 * EPOCH_LENGTH;
        dist = LotteryDistributor(payable(LibClone.clone(address(new LotteryDistributor()))));
        // FEE_VAULT and keeper are this test contract.
        dist.init(address(this), timelock, address(this), genesis, EPOCH_LENGTH, POT_BPS);

        stockA = new MiniToken();
        stockB = new MiniToken();
    }

    function _sig() internal pure returns (BLS.G1Point memory) {
        return BLS.G1Point({
            x_a: 0x0000000000000000000000000000000003ad29e4c409f9470fc2ef02f90214df,
            x_b: 0x49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72,
            y_a: 0x0000000000000000000000000000000001776ff7408b39c5f6f9fa50746efd7e,
            y_b: 0xea17fbb61f2e7b9c849ff0528e5a3deeedd029d0df345199963d75ba93b5a02a
        });
    }

    function _leaf(address holder, uint256 start, uint256 end) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, start, end))));
    }

    /// @dev The two-leaf tree: winner holds [0, WINNING_TICKET+1), loser holds
    ///      the rest. Returns the root and each holder's one-sibling proof.
    function _tree() internal view returns (bytes32 root, bytes32[] memory winnerProof, bytes32[] memory loserProof) {
        bytes32 a = _leaf(winner, 0, WINNING_TICKET + 1);
        bytes32 b = _leaf(loser, WINNING_TICKET + 1, TOTAL_TICKETS);
        root = a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
        winnerProof = new bytes32[](1);
        winnerProof[0] = b;
        loserProof = new bytes32[](1);
        loserProof[0] = a;
    }

    /// @dev Funds a window and the pot, then publishes a draw for round
    ///      1,000,000. Returns the draw id and the tree.
    function _publish() internal returns (uint256 drawId, bytes32[] memory winnerProof, bytes32[] memory loserProof) {
        address[] memory stocks = new address[](2);
        stocks[0] = address(stockA);
        stocks[1] = address(stockB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1000e18;
        amounts[1] = 2000e18;
        // As the vault: register the window.
        dist.fundWindow(5, stocks, amounts, amounts);
        // The pot itself: the stocks land on the distributor.
        stockA.mint(address(dist), 1000e18);
        stockB.mint(address(dist), 2000e18);

        bytes32 root;
        (root, winnerProof, loserProof) = _tree();
        dist.publishDraw(5, root, uint128(TOTAL_TICKETS), ROUND, bytes32("digest"), "ipfs://cid");
        drawId = dist.drawCount();
    }

    // ---- gating ------------------------------------------------------------

    function test_ADrawMustCommitToAFutureRound() public {
        (bytes32 root,,) = _tree();
        uint64 nowRound = dist.currentRound();
        // Too near: current round + 1.
        vm.expectRevert();
        dist.publishDraw(5, root, uint128(TOTAL_TICKETS), nowRound + 1, bytes32("d"), "cid");
        // Too far: more than a day out.
        vm.expectRevert();
        dist.publishDraw(5, root, uint128(TOTAL_TICKETS), nowRound + 30_000, bytes32("d"), "cid");
    }

    function test_PublishIsKeeperOnlyAndTheEpochMustBeOver() public {
        (bytes32 root,,) = _tree();
        vm.prank(loser);
        vm.expectRevert(LotteryDistributor.NotKeeper.selector);
        dist.publishDraw(5, root, uint128(TOTAL_TICKETS), ROUND, bytes32("d"), "cid");

        // Epoch 50 is far in the future — not over.
        vm.expectRevert();
        dist.publishDraw(50, root, uint128(TOTAL_TICKETS), ROUND, bytes32("d"), "cid");
    }

    // ---- the full draw -----------------------------------------------------

    function test_ARealBeaconSettlesAndTheWinnerCollectsThePotShare() public {
        (uint256 drawId, bytes32[] memory winnerProof,) = _publish();

        dist.settleDraw(drawId, _sig());
        (,,,, LotteryDistributor.DrawStatus status,, uint256 winningTicket,,,,) = dist.draws(drawId);
        assertEq(uint256(status), uint256(LotteryDistributor.DrawStatus.Settled), "settled");
        assertEq(winningTicket, WINNING_TICKET, "the winning ticket is the beacon's, mod totalTickets");

        address[] memory stocks = new address[](2);
        stocks[0] = address(stockA);
        stocks[1] = address(stockB);
        uint256 paid = dist.collect(drawId, winner, 0, WINNING_TICKET + 1, winnerProof, stocks);
        assertEq(paid, 2, "both legs delivered");
        // POT_BPS (10 %) of each pot.
        assertEq(stockA.balanceOf(winner), 100e18, "10 % of stockA");
        assertEq(stockB.balanceOf(winner), 200e18, "10 % of stockB");
    }

    function test_ANonWinnerCannotCollect() public {
        (uint256 drawId,, bytes32[] memory loserProof) = _publish();
        dist.settleDraw(drawId, _sig());

        address[] memory stocks = new address[](1);
        stocks[0] = address(stockA);
        // The loser's interval does not contain the winning ticket.
        vm.expectRevert(LotteryDistributor.NotTheWinner.selector);
        dist.collect(drawId, loser, WINNING_TICKET + 1, TOTAL_TICKETS, loserProof, stocks);
    }

    function test_CollectingTwiceDeliversNothingTheSecondTime() public {
        (uint256 drawId, bytes32[] memory winnerProof,) = _publish();
        dist.settleDraw(drawId, _sig());

        address[] memory stocks = new address[](2);
        stocks[0] = address(stockA);
        stocks[1] = address(stockB);
        dist.collect(drawId, winner, 0, WINNING_TICKET + 1, winnerProof, stocks);
        uint256 balA = stockA.balanceOf(winner);

        uint256 paidAgain = dist.collect(drawId, winner, 0, WINNING_TICKET + 1, winnerProof, stocks);
        assertEq(paidAgain, 0, "nothing left to pay");
        assertEq(stockA.balanceOf(winner), balA, "balance unchanged");
    }

    function test_ASettledDrawCannotBeSettledAgain() public {
        (uint256 drawId,,) = _publish();
        dist.settleDraw(drawId, _sig());
        vm.expectRevert(LotteryDistributor.WrongDrawStatus.selector);
        dist.settleDraw(drawId, _sig());
    }

    function test_AWrongBeaconIsRejected() public {
        (uint256 drawId,,) = _publish();
        BLS.G1Point memory bad = _sig();
        bad.x_b = bytes32(uint256(bad.x_b) ^ 1);
        vm.expectRevert();
        dist.settleDraw(drawId, bad);
    }

    /// @notice A paused stock defers and never burns the prize: `collect` skips
    ///         it, and a later `collect` (once unpaused) pays it.
    function test_APausedLegDefersAndCollectRetries() public {
        // Fund a window and publish, but the pot's stockA is a paused token.
        address paused = address(new PausedToken());
        address[] memory stocks = new address[](1);
        stocks[0] = paused;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 500e18;
        dist.fundWindow(5, stocks, amounts, amounts);

        (bytes32 root, bytes32[] memory winnerProof,) = _tree();
        dist.publishDraw(5, root, uint128(TOTAL_TICKETS), ROUND, bytes32("d"), "cid");
        uint256 drawId = dist.drawCount();
        dist.settleDraw(drawId, _sig());

        uint256 paid = dist.collect(drawId, winner, 0, WINNING_TICKET + 1, winnerProof, stocks);
        assertEq(paid, 0, "the paused leg deferred, nothing delivered");
        assertFalse(dist.drawStockPaid(drawId, paused), "and stays unpaid, so a retry can pay it");

        // Unpause: etch a working token with the same 500e18 balance at that
        // address, retry, and the prize (10 % = 50e18) lands.
        vm.etch(paused, address(new MiniToken()).code);
        MiniToken(paused).mint(address(dist), 500e18);
        uint256 paid2 = dist.collect(drawId, winner, 0, WINNING_TICKET + 1, winnerProof, stocks);
        assertEq(paid2, 1, "the retry delivered the deferred leg");
        assertEq(MiniToken(paused).balanceOf(winner), 50e18, "10 % of the pot, once it could move");
    }
}
