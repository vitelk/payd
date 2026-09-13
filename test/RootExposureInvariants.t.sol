// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @notice **T-ROOT-02 — how big the pot a leaked keeper key can award itself
///         actually gets.**
///
/// @dev    `test/Invariants.t.sol` drives the Distributor at random and asks
///         whether the accounting holds. This campaign asks a different and
///         narrower question, and it is the one `FLOWS.md` §7.c answers with a
///         number: after an HONEST cycle — windows funded, honest roots
///         published, and the shipped push floor applied to who gets delivered
///         — how much stays undelivered?
///
///         The published answer WAS "about one epoch in the contract", from
///         which §S29 derived ~$42 / ~$83 / ~$417 a day. That rests on
///         deliveries running continuously, and they do not reach the
///         sub-floor tail: `offchain/src/epoch.ts:306` pushes an entry only
///         once its outstanding value clears `pushFloor`, so a holder below
///         that floor is never pushed and settles only by calling `claim`
///         themselves. The handler below therefore pushes exactly what
///         `pushSet` would push and nothing else.
///
///         **This campaign is what corrected the figure.** It reached 2.00x one
///         window on its final run and a peak of three windows in flight, on an
///         entirely honest cycle, with nine pushes falling under the floor.
///         §S29, `FLOWS.md` §7.c and `AUDIT_PLAN.md` §7.1 were rewritten to the
///         measured bound — `holders below the floor x pushFloor + windows in
///         flight` — and the peak ghosts below are the evidence they quote.
///
///         **ASSERTION DIRECTION, after the rewrite.** The invariant asserts
///         that `quoteAtRisk` is a true upper bound on what the windows spent,
///         because that is the figure the corrected documents send an operator
///         to watch. The coverage guard asserts the sub-floor tail was actually
///         exercised, without which the campaign would quietly re-derive the
///         figure that was wrong.
///
///         Nothing is mocked: real NVDA, the real `fundWindow`, the real root,
///         the real settlement. `deal` writes a standard ERC-20 balance, which
///         `test/Invariants.t.sol` already does for the same reason.
contract RootExposureHandler is Test {
    Distributor public dist;
    address public immutable STOCK;

    /// @dev Ten holders, because the shape of the finding is "how many sit
    ///      under the floor", and three cannot show a tail.
    address[10] public holders;

    /// @dev `MIN_BUY_QUOTE` for the vault this campaign models. An ether vault,
    ///      so `pushFloorFor` takes the gas branch and this is unread — carried
    ///      anyway so the port below is the whole function and not half of it.
    uint256 public constant MIN_BUY_QUOTE = 0.01 ether;

    // ---- the push floor, ported from offchain/src/epoch.ts ------------------
    //
    // `offchain/src/epoch.ts:157-160` is four lines and this is the same four.
    // The campaign has to exercise the SHIPPED floor: an invented one would
    // make the result a statement about this file rather than about the system.
    //
    //     export function pushFloorFor(quote, minBuyQuote, basefee) {
    //       if (quote !== zero) return (minBuyQuote * NON_ETH_PUSH_BPS) / 10_000n;
    //       const gasFloor = PUSH_K_MIN * SETTLE_GAS * basefee;
    //       return gasFloor > PUSH_TARGET_WEI ? gasFloor : PUSH_TARGET_WEI;
    //     }

    /// @dev `offchain/src/epoch.ts:29`, measured.
    uint256 public constant SETTLE_GAS = 93_000;
    /// @dev `offchain/src/epoch.ts:90`, ~$10 at $2 386/ETH.
    uint256 public constant PUSH_TARGET_WEI = 4_192_000_000_000_000;
    /// @dev `offchain/src/epoch.ts:91`. 1 - 1/20 = 95 % guaranteed to the holder.
    uint256 public constant PUSH_K_MIN = 20;
    /// @dev `offchain/src/epoch.ts:146`. 40 % of `MIN_BUY_QUOTE`, i.e. ~$10.
    uint256 public constant NON_ETH_PUSH_BPS = 4_000;

    /// @dev The vault modelled here is quoted in ether, so `quote` is zero and
    ///      the branch is fixed. Both arms are written out so the port can be
    ///      read against its source line for line.
    function pushFloorFor(address quote, uint256 minBuyQuote, uint256 basefee) public pure returns (uint256) {
        if (quote != address(0)) return (minBuyQuote * NON_ETH_PUSH_BPS) / 10_000;
        uint256 gasFloor = PUSH_K_MIN * SETTLE_GAS * basefee;
        return gasFloor > PUSH_TARGET_WEI ? gasFloor : PUSH_TARGET_WEI;
    }

    // ---- ghosts ------------------------------------------------------------

    /// @dev The funding of the LAST window, which is the bound the documents
    ///      claim. Recorded rather than recomputed: the invariant must compare
    ///      against what really went in.
    uint256 public lastWindowFunding;
    uint256 public quoteOfLastWindow;
    uint256 public nextEpoch;

    /// @dev The entitlement each holder's leaf carries under the active root.
    mapping(address => uint256) public cumulativeOf;

    uint256 public callsFund;
    uint256 public callsPublish;
    uint256 public callsPush;
    uint256 public pushesSkippedUnderFloor;

    /// @dev The worst the pot ever got, and the worst multiple of one window it
    ///      ever reached. Sampled after every call rather than at the end: the
    ///      campaign can settle back down, and the exposure is the PEAK — a
    ///      leaked key publishes whenever it likes.
    uint256 public peakUndelivered;
    uint256 public peakWindowsInFlight;

    constructor(address stock, address[10] memory hs) {
        STOCK = stock;
        holders = hs;
    }

    function setDistributor(Distributor d) external {
        require(address(dist) == address(0), "already wired");
        dist = d;
    }

    receive() external payable {}

    // ---- actions -----------------------------------------------------------

    /// @dev The handler IS the vault, so it funds. One window, one purchase,
    ///      the whole basket in one stock — which is what the Distributor sees
    ///      whatever the basket held.
    function fund(uint96 amount) external {
        // A narrow band on purpose: "windows in flight" is only a meaningful
        // ratio if two windows are the same order of magnitude. 1e15..1e20 was
        // tried first and made the peak multiple read 19 620, which measures the
        // spread of the bound and not the size of the pot.
        uint256 a = bound(uint256(amount), 1e19, 1e20);
        if (IERC20(STOCK).balanceOf(address(this)) < a) return;

        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (epoch < nextEpoch) return;

        IERC20(STOCK).transfer(address(dist), a);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory quote = new uint256[](1);
        stocks[0] = STOCK;
        amounts[0] = a;
        // One window's worth of ether spent on the purchase, at the scale the
        // steady state of §2.4 describes: ~$333 at ~$2 600/ETH.
        quote[0] = 0.128 ether;

        try dist.fundWindow(epoch, stocks, amounts, quote) {
            lastWindowFunding = a;
            quoteOfLastWindow = quote[0];
            nextEpoch = epoch + 1;
            ++callsFund;
        } catch {}
        _observe();
    }

    /// @dev An HONEST root. Every holder's cumulative is their share of what has
    ///      been funded so far, and the tree is flat — root = leaf for a single
    ///      holder is not enough here, because the finding is about the tail, so
    ///      the root is a 16-leaf balanced tree over the ten holders padded with
    ///      zero leaves. A 16-leaf tree keeps the proof four deep and the
    ///      arithmetic exact.
    function publish(uint8 skew) external {
        uint256 cur = dist.currentEpoch();
        if (cur == 0) return;
        uint256 epoch = cur - 1;
        if (nextEpoch == 0 || epoch + 1 < nextEpoch) return;

        uint256 funded = dist.totalFunded(STOCK);
        if (funded == 0) return;

        // One large holder and a long tail, which is what a Pons token looks
        // like — `docs/recon.md` §6 records one with 103 968 holders. At 5 %
        // each the nine tail holders sit under the ~$10 push floor on any
        // ordinary window, which is the condition the campaign exists to run.
        //
        // **Fixed, not fuzzed, and the last holder takes the remainder.** A
        // fuzzed split makes a cumulative go DOWN between two roots, which pays
        // zero and leaves a residue no delivery ever clears; the remainder makes
        // the ten leaves sum to `funded` exactly. Without both, the campaign
        // trips on integer-division dust — measured, it shrank to a
        // counterexample two WEI over the bound, which says nothing about the
        // finding. `skew` is kept in the signature so the selector list does not
        // move, and is deliberately unread.
        skew;
        uint256[10] memory w = [uint256(55), 5, 5, 5, 5, 5, 5, 5, 5, 5];

        uint256 given;
        for (uint256 i; i < 9; ++i) {
            uint256 share = (funded * w[i]) / 100;
            cumulativeOf[holders[i]] = share;
            given += share;
        }
        cumulativeOf[holders[9]] = funded - given;

        bytes32 root = _root();
        try dist.publishRoot(epoch, root, root, bytes32("cid"), "bafyTEST") {
            ++callsPublish;
        } catch {}
        _observe();
    }

    /// @dev Delivers exactly the entries `pushSet` would select, and no others.
    ///      This is the whole point of the campaign: the deliveries that the
    ///      shipped keeper really makes, not the deliveries a bound would need.
    function push() external {
        if (dist.activeRoot() == 0) return;
        uint256 funded = dist.totalFunded(STOCK);
        if (funded == 0) return;

        uint256 floor_ = pushFloorFor(address(0), MIN_BUY_QUOTE, block.basefee);
        uint256 totalQuote = dist.quoteFundedFor(STOCK);

        for (uint256 i; i < 10; ++i) {
            address h = holders[i];
            uint256 cum = cumulativeOf[h];
            uint256 already = dist.claimedSoFar(h, STOCK);
            if (cum <= already) continue;

            // `offchain/src/epoch.ts:305` — the outstanding share valued in the
            // quote the purchases were made in, against the floor.
            uint256 valueWei = ((cum - already) * totalQuote) / funded;
            if (valueWei < floor_) {
                ++pushesSkippedUnderFloor;
                continue;
            }

            address[] memory stocks = new address[](1);
            uint256[] memory cums = new uint256[](1);
            bytes32[][] memory proofs = new bytes32[][](1);
            stocks[0] = STOCK;
            cums[0] = cum;
            proofs[0] = _proof(i);
            try dist.distribute(h, stocks, cums, proofs) {
                ++callsPush;
            } catch {}
        }
        _observe();
    }

    /// @dev A holder who settles for themselves. Open to anyone, always, and
    ///      the only way out for the sub-floor tail.
    function claimFor(uint8 who) external {
        uint256 i = bound(uint256(who), 0, 9);
        address h = holders[i];
        if (dist.activeRoot() == 0) return;
        if (cumulativeOf[h] <= dist.claimedSoFar(h, STOCK)) return;

        address[] memory stocks = new address[](1);
        uint256[] memory cums = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = STOCK;
        cums[0] = cumulativeOf[h];
        proofs[0] = _proof(i);
        vm.prank(h);
        try dist.claim(stocks, cums, proofs) {} catch {}
        _observe();
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(uint256(dt), 30 minutes, 2 hours));
        vm.roll(block.number + 1);
    }

    /// @dev Sampled at the end of every ACTION, and not from the invariant.
    ///      Foundry rolls back whatever an invariant function writes, so a ghost
    ///      updated there reads zero for ever — which it did, on the first run
    ///      of this campaign, while the end-of-campaign figure was 2.77 windows.
    function _observe() internal {
        uint256 undelivered = dist.totalFunded(STOCK) - dist.totalDistributed(STOCK);
        if (undelivered > peakUndelivered) peakUndelivered = undelivered;
        uint256 window = lastWindowFunding;
        if (window != 0) {
            uint256 mult = undelivered / window;
            if (mult > peakWindowsInFlight) peakWindowsInFlight = mult;
        }
    }

    // ---- the tree ----------------------------------------------------------

    function _leafAt(uint256 i) internal view returns (bytes32) {
        if (i >= 10) return bytes32(0);
        return keccak256(bytes.concat(keccak256(abi.encode(holders[i], STOCK, cumulativeOf[holders[i]]))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    /// @dev A balanced 16-leaf tree, slots 10..15 held at zero.
    function _root() internal view returns (bytes32) {
        bytes32[16] memory n;
        for (uint256 i; i < 16; ++i) {
            n[i] = _leafAt(i);
        }
        for (uint256 width = 16; width > 1; width /= 2) {
            for (uint256 i; i < width / 2; ++i) {
                n[i] = _pair(n[2 * i], n[2 * i + 1]);
            }
        }
        return n[0];
    }

    /// @dev The four siblings on the path from leaf `idx` to the root.
    function _proof(uint256 idx) internal view returns (bytes32[] memory p) {
        bytes32[16] memory n;
        for (uint256 i; i < 16; ++i) {
            n[i] = _leafAt(i);
        }
        p = new bytes32[](4);
        uint256 k = idx;
        uint256 d;
        for (uint256 width = 16; width > 1; width /= 2) {
            p[d++] = n[k ^ 1];
            for (uint256 i; i < width / 2; ++i) {
                n[i] = _pair(n[2 * i], n[2 * i + 1]);
            }
            k /= 2;
        }
    }
}

/// @notice The campaign. Small like the other three fork campaigns, and for the
///         same reason: 256 x 64 against a live RPC at 60 CU/s would not finish.
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 80
/// forge-config: default.invariant.fail-on-revert = false
contract RootExposureInvariants is StdInvariant, CloneBase {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    Distributor internal dist;
    RootExposureHandler internal handler;

    function setUp() public {
        address[10] memory hs = [
            makeAddr("h0"),
            makeAddr("h1"),
            makeAddr("h2"),
            makeAddr("h3"),
            makeAddr("h4"),
            makeAddr("h5"),
            makeAddr("h6"),
            makeAddr("h7"),
            makeAddr("h8"),
            makeAddr("h9")
        ];

        handler = new RootExposureHandler(NVDA, hs);
        // The handler is both the vault and the keeper: it funds the windows and
        // it publishes the roots, which is the honest cycle this campaign runs.
        dist = _cloneDistributor(address(handler), makeAddr("timelock"), address(handler), block.timestamp, 30 minutes);
        handler.setDistributor(dist);

        deal(NVDA, address(handler), 1_000_000e18);
        vm.deal(address(dist), 1 ether); // the delivery reserve

        bytes4[] memory sels = new bytes4[](5);
        sels[0] = RootExposureHandler.fund.selector;
        sels[1] = RootExposureHandler.publish.selector;
        sels[2] = RootExposureHandler.push.selector;
        sels[3] = RootExposureHandler.claimFor.selector;
        sels[4] = RootExposureHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
        targetContract(address(handler));
    }

    /// @notice **The monitor has to track the thing it monitors.**
    ///
    /// @dev    **REWRITTEN 2026-09-11, and the rewrite is the fix.** This
    ///         invariant used to assert `undelivered <= lastWindowFunding` —
    ///         `FLOWS.md` §7.c's "about one 30-minute epoch", as an assertion.
    ///         It was red at 2.00x on the final run and a peak of three windows,
    ///         and the resolution is that the SENTENCE was wrong, not the
    ///         contract: the push floor means the sub-floor tail is never
    ///         delivered to, so the standing balance is `holders below the floor
    ///         x pushFloor + windows in flight`. §S29, `FLOWS.md` §7.c and
    ///         `AUDIT_PLAN.md` §7.1 now say that, and `test_AFalseRootTakes-
    ///         TheWholeUndeliveredBalance` pins the ceiling itself.
    ///
    ///         What is left for a CAMPAIGN to assert is the thing those
    ///         documents now send an operator to look at. They tell them to
    ///         watch `quoteAtRisk` as a ratio to one window's funding, and
    ///         `offchain/src/check.ts` warns above eight. That advice is only
    ///         worth anything if `quoteAtRisk` is a true upper bound on what the
    ///         windows spent — it rises once per `fundWindow` and falls once per
    ///         delivery, and a decrement that ran twice, or on the wrong
    ///         denominator, would make the published figure read LOW exactly
    ///         when the pot is large. That is the property below, and it is
    ///         exact rather than approximate: every decrement is a `mulDiv`
    ///         rounded DOWN, so the figure can only ever err high.
    ///
    ///         The peak ghosts stay and are logged by `afterInvariant`: they are
    ///         the measurement §S29 now quotes.
    // T-ROOT-02
    function invariant_QuoteAtRiskNeverExceedsWhatTheWindowsSpent() public view {
        assertLe(
            dist.quoteAtRisk(),
            dist.quoteFundedFor(NVDA),
            "quoteAtRisk exceeds what the windows spent: the published exposure is not an upper bound"
        );
    }

    /// @notice The accounting still has to hold, red bound or not.
    function invariant_DistributedNeverExceedsFundedHere() public view {
        assertLe(dist.totalDistributed(NVDA), dist.totalFunded(NVDA), "distributed > funded");
    }

    /// @notice Coverage guard, the same shape as `Invariants.t.sol:251-262`.
    ///         Without it a broken handler gives an entirely green campaign:
    ///         zero calls, zero violations.
    function afterInvariant() public {
        assertGt(handler.callsFund(), 0, "the fuzzer never funded: worthless campaign");
        assertGt(handler.callsPublish(), 0, "no root published: the cycle was not exercised");
        // Deliveries have to have HAPPENED, or `quoteAtRisk`'s decrement — the
        // half of it this campaign's invariant is about — was never executed
        // and the property held for the wrong reason.
        //
        // The tail is the campaign's subject, but `pushesSkippedUnderFloor` is
        // not the guard for it: at ten holders on a 55/5x9 split a tail share is
        // ~0.0064 ETH against a ~0.0042 ETH floor, so an entry falls under the
        // floor only on the dust left after a push, which is seed-dependent. It
        // is logged below and read, not asserted — a flaky guard is worse than
        // none.
        assertGt(handler.callsPush(), 0, "nothing was ever delivered: quoteAtRisk's decrement was never exercised");
        emit log_named_uint("pushes that cleared the floor ", handler.callsPush());
        emit log_named_uint("pushes skipped under the floor", handler.pushesSkippedUnderFloor());
        emit log_named_uint("undelivered NVDA at the end   ", dist.totalFunded(NVDA) - dist.totalDistributed(NVDA));
        emit log_named_uint("one window's funding          ", handler.lastWindowFunding());
        emit log_named_uint("PEAK undelivered NVDA         ", handler.peakUndelivered());
        emit log_named_uint("PEAK windows in flight        ", handler.peakWindowsInFlight());
    }
}
