// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @notice **`docs/AUDIT_PLAN_2.md` §4 — T2-REFUND-01, T2-GAS-01, and the money
///         behind the composition finding.**
///
/// @dev    Real NVDA on the fork, as `test/Distributor.t.sol` does: a standard
///         ERC-20 balance is written, no behaviour of Pons or Uniswap is
///         simulated. Written RED against the frozen tree, green since the fix,
///         and ungated — `docs/AUDIT_FIXES_2.md`.
contract DistributorAudit2Test is CloneBase {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    Distributor internal dist;
    address internal feeVault = makeAddr("feeVault");
    address internal timelock = makeAddr("timelock");
    address internal keeper = makeAddr("keeper");
    address internal bob = makeAddr("bob");

    uint256 internal coSignerPk = 0xC05167;
    address internal coSigner;

    uint256 internal constant LEN = 30 minutes;
    uint256 internal constant QUOTE_PER_WINDOW = 1 ether;

    function setUp() public {
        coSigner = vm.addr(coSignerPk);
        dist = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);
        vm.deal(address(dist), 0.5 ether);
    }

    function _leaf(address holder, address stock, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, stock, cumulative))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    function _single(bytes32 x) internal pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = x;
    }

    function _arr(address a) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a;
    }

    function _arrU(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _arrP(bytes32[] memory a) internal pure returns (bytes32[][] memory x) {
        x = new bytes32[][](1);
        x[0] = a;
    }

    /// @dev One window: `amount` of `stock` credited as bought with `quote`.
    function _fund(uint256 epoch, address stock, uint256 amount, uint256 quote) internal {
        deal(stock, address(dist), IERC20(stock).balanceOf(address(dist)) + amount);
        if (block.timestamp < dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
        vm.prank(feeVault);
        dist.fundWindow(epoch, _arr(stock), _arrU(amount), _arrU(quote));
    }

    // ---- T2-BANK-01, in money ----------------------------------------------

    /// @notice **What the banked request is worth, in the currency the purchases
    ///         were made in.** Property asserted: once a co-signer is named and
    ///         live, the keeper's key alone extracts nothing.
    ///
    /// @dev    RED. The keeper banks one `requestCoSignature` while the vault is
    ///         still single-key — its state at launch — lets the three hours run
    ///         with nobody able to refuse, and the request stays lapsed for ever.
    ///         Twelve honest windows later, with the second key named,
    ///         heartbeating and believed to be in force, that root publishes on
    ///         one key and takes `totalFunded - totalDistributed`, i.e. the same
    ///         ceiling `FLOWS.md` §7.c names for the case where BOTH keys are
    ///         held. The co-signature bought nothing against a keeper that
    ///         planned ahead by one transaction.
    function test_ALiveCoSignerLeavesTheKeeperNothingToTakeAlone() public {
        // Launch day: no second key yet. The keeper tries to arm a single-key
        // publication for one transaction of ~25k gas, which is what it used to
        // cost, and is refused — there is no requirement to lift and no key that
        // could ever refuse the request.
        vm.warp(dist.epochEnd(0) + 1);
        bytes32 bobLeaf = _leaf(bob, NVDA, 0);
        address attacker = makeAddr("attacker");
        bytes32 forgedLeaf = _leaf(attacker, NVDA, type(uint128).max);
        bytes32 forgedRoot = _pair(forgedLeaf, bobLeaf);

        vm.prank(keeper);
        bool banked;
        try dist.requestCoSignature(0, forgedRoot, forgedRoot, bytes32("cid")) {
            banked = true;
        } catch {
            banked = false;
        }
        assertFalse(banked, "nothing may be armed while no second key exists");

        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(timelock);
        dist.setCoSigner(coSigner);

        // Twelve honest windows, nothing delivered — the standing balance
        // `Distributor.quoteAtRisk` describes, and what the attacker was waiting
        // for when it armed the root while the vault held nothing.
        for (uint256 e; e < 12; ++e) {
            _fund(e, NVDA, 1e18, QUOTE_PER_WINDOW);
            vm.prank(coSigner);
            dist.heartbeat();
        }
        vm.warp(dist.epochEnd(11) + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(dist.coSignerRequired(), "the second key is in force at the moment of the attempt");

        uint256 pot = dist.totalFunded(NVDA) - dist.totalDistributed(NVDA);
        assertGt(pot, 0, "fixture: there is something to take");

        // Every door the keeper has, tried in turn, on its own key.
        assertFalse(
            dist.coSignatureLapsed(11, forgedRoot, forgedRoot, bytes32("cid")), "nothing aged while nobody could refuse"
        );
        vm.prank(keeper);
        bool published;
        try dist.publishRoot(11, forgedRoot, forgedRoot, bytes32("cid"), "bafyFORGED") {
            published = true;
        } catch {
            published = false;
        }
        assertFalse(published, "a live co-signer must leave the keeper's key nothing to take alone");

        // And the entitlement never existed, so there is nothing to claim
        // against either.
        vm.prank(attacker);
        uint256 got;
        try dist.claim(_arr(NVDA), _arrU(type(uint128).max), _arrP(_single(bobLeaf))) returns (uint256 d) {
            got = d;
        } catch {
            got = 0;
        }
        console.log("the pot, raw NVDA :", pot);
        console.log("taken, raw NVDA   :", got);
        assertEq(got, 0, "and nothing is extractable");
    }

    // ---- T2-REFUND-01 ------------------------------------------------------

    /// @notice Property: the reserve never pays more than `REFUND_VALUE_BPS` of
    ///         what the delivery is worth. GREEN against the ceiling itself —
    ///         `_refund` clamps `owed` to it before `MAX_REFUND` and before the
    ///         free balance, so the three compose in the safe order.
    function test_TheRefundNeverExceedsItsShareOfWhatMoved() public {
        _fund(0, NVDA, 1e18, QUOTE_PER_WINDOW);
        vm.warp(dist.epochEnd(1) + 1);

        // A delivery worth a hundred-thousandth of the window.
        uint256 owed = 1e13;
        bytes32 target = _leaf(bob, NVDA, owed);
        bytes32 other = _leaf(makeAddr("other"), NVDA, 1);
        bytes32 root = _pair(target, other);
        vm.prank(keeper);
        dist.publishRoot(1, root, root, bytes32("cid"), "bafy");

        address pusher = makeAddr("pusher");
        uint256 before_ = address(dist).balance;
        vm.fee(1 gwei);
        vm.prank(pusher);
        dist.distribute(bob, _arr(NVDA), _arrU(owed), _arrP(_single(other)));
        uint256 paid = before_ - address(dist).balance;

        // `moved` is the delivery's share of the window's quote, which is the
        // same figure `quoteAtRisk` is decremented by.
        uint256 moved = (owed * QUOTE_PER_WINDOW) / 1e18;
        uint256 ceiling = (moved * dist.REFUND_VALUE_BPS()) / 10_000;
        console.log("refund paid, wei :", paid);
        console.log("ceiling, wei     :", ceiling);
        assertLe(paid, ceiling, "the reserve pays at most REFUND_VALUE_BPS of what the call moved");
    }

    /// @notice **T2-REFUND-01, second half — ACCEPTED, with its bound asserted
    ///         rather than its absence.**
    ///
    ///         `REFUND_VALUE_BPS` bounds the refund by `moved`, and `moved` is
    ///         priced at `quoteFundedFor / totalFunded` — a BLENDED rate, not
    ///         the rate the stock in hand was bought at. `FeeVault._buyLegs`
    ///         carries a skipped leg's quote forward in `reserveQuote` (T-RISK-01,
    ///         and correctly), so the blend is reachable through ordinary
    ///         skipped legs rather than through anything an attacker does.
    ///
    /// @dev    **Not fixed, and the reason is the price of the alternative.**
    ///         Pricing `backing` at the window's own rate means keeping a rate
    ///         per window, i.e. an SSTORE per window on the funding path, to
    ///         bound a figure that is already bounded by `MAX_REFUND` at 0.02
    ///         ETH per call and that nobody extracts — the reserve pays itself,
    ///         and the caller is a pusher doing the work. So the bound is
    ///         stated: **the refund never exceeds `MAX_REFUND`, and the blend's
    ///         factor is exactly the ratio of quote credited to stock
    ///         delivered.** Measured here at 11x, which is what ten skipped
    ///         windows against one honest purchase produce.
    ///
    ///         The direction is the part to watch and it is `offchain/src/check.ts`'s
    ///         job: the ceiling is loosest exactly when legs are failing, which
    ///         is when the basket is already in trouble.
    function test_TheRefundCeilingLoosensWithTheBlendAndStopsAtMaxRefund() public {
        // Window 0: one honest purchase. This is the true rate.
        _fund(0, NVDA, 1e18, QUOTE_PER_WINDOW);
        // A window whose leg skipped: the quote is carried and arrives with the
        // leg that finally buys.
        _fund(1, NVDA, 1, 10 * QUOTE_PER_WINDOW);

        vm.warp(dist.epochEnd(2) + 1);
        uint256 owed = 1e13;
        bytes32 target = _leaf(bob, NVDA, owed);
        bytes32 other = _leaf(makeAddr("other"), NVDA, 1);
        bytes32 root = _pair(target, other);
        vm.prank(keeper);
        dist.publishRoot(2, root, root, bytes32("cid"), "bafy");

        uint256 before_ = address(dist).balance;
        vm.fee(1 gwei);
        vm.prank(makeAddr("pusher"));
        dist.distribute(bob, _arr(NVDA), _arrU(owed), _arrP(_single(other)));
        uint256 paid = before_ - address(dist).balance;

        uint256 trueValue = (owed * QUOTE_PER_WINDOW) / 1e18;
        uint256 blended = (owed * dist.quoteFundedFor(NVDA)) / dist.totalFunded(NVDA);
        console.log("refund paid, wei          :", paid);
        console.log("true value delivered, wei :", trueValue);
        console.log("blended `moved`, wei      :", blended);
        console.log("the blend's factor, x100  :", (blended * 100) / trueValue);

        // 1. The enforced ceiling, which is what `_refund` actually applies.
        assertLe(paid, (blended * dist.REFUND_VALUE_BPS()) / 10_000, "REFUND_VALUE_BPS of `moved` is enforced");
        // 2. The hard stop behind it, and the reason this is accepted.
        assertLe(paid, dist.MAX_REFUND(), "and MAX_REFUND is the bound that does not move with the blend");
        // 3. The blend itself, pinned exactly — including the one wei `_one`'s
        //    `mulDiv` floors off — so a change to `_buyLegs` shows up here as a
        //    number rather than as a diff.
        assertEq(blended, trueValue * 11 - 1, "ten skipped windows against one honest purchase blend at 11x");
    }

    // ---- T2-GAS-01 ---------------------------------------------------------

    /// @notice Property: the duplicate-stock loop is not a denial of service at
    ///         `MAX_BATCH`, and the honest 8-entry cost is negligible.
    ///
    /// @dev    GREEN expected. 64 DISTINCT stocks are not reachable in the
    ///         product — a holder is owed at most `MAX_BASKET` (8) lines — but
    ///         the loop's bound is `MAX_BATCH`, so what is measured is the worst
    ///         case a caller can construct: 64 distinct addresses whose proofs
    ///         all verify. The comparison count is `n(n-1)/2` = 2 016, at 3 gas
    ///         a `calldataload` pair.
    function test_TheDuplicateLoopCostsNothingAtTheHonestWidthAndSurvivesTheCap() public {
        _fund(0, NVDA, 1e18, QUOTE_PER_WINDOW);
        vm.warp(dist.epochEnd(1) + 1);
        bytes32 root = _leaf(bob, NVDA, 1);
        vm.prank(keeper);
        dist.publishRoot(1, root, root, bytes32("cid"), "bafy");

        uint256 one = _measureDuplicateScan(1);
        uint256 eight = _measureDuplicateScan(8);
        uint256 sixtyFour = _measureDuplicateScan(64);
        console.log("claim of 1 entry, gas    :", one);
        console.log("claim of 8 entries, gas  :", eight);
        console.log("claim of 64 entries, gas :", sixtyFour);
        console.log("the scan at 8, gas       :", eight - one);
        console.log("the scan at 64, gas      :", sixtyFour - one);
        // 2 016 comparisons against 28 -- the quadratic is real and it is small.
        assertLt(sixtyFour, 400_000, "the worst case a caller can construct stays far under a block");
        assertLt(eight - one, 20_000, "and the honest width is noise");
    }

    /// @dev `n` DISTINCT stocks, each its own leaf, so the duplicate scan runs
    ///      to completion before the first proof is rejected. The delta against
    ///      `n = 1` isolates the comparisons.
    function _measureDuplicateScan(uint256 n) internal returns (uint256) {
        address[] memory stocks = new address[](n);
        uint256[] memory cum = new uint256[](n);
        bytes32[][] memory proofs = new bytes32[][](n);
        for (uint256 i; i < n; ++i) {
            stocks[i] = address(uint160(0x1000 + i));
            cum[i] = 1;
            proofs[i] = new bytes32[](0);
        }
        uint256 g0 = gasleft();
        try dist.claim(stocks, cum, proofs) {} catch {}
        return g0 - gasleft();
    }
}
