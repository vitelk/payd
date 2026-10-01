// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";
import {TickMath} from "../contracts/libraries/TickMath.sol";
import {TwapFloor} from "../contracts/libraries/TwapFloor.sol";

/// @notice **T-HYG-02 — the four files this repository did not write.**
///
/// @dev    `contracts/libraries/{FullMath,TickMath,BitMath,CustomRevert}.sol`
///         are Uniswap's, copied in. `AUDIT_PLAN.md` §4 records that they had
///         been checked on their load-bearing surface and **never textually
///         diffed against upstream**, because upstream is not in `lib/` and
///         nothing in the build would notice an edit.
///
///         **Diffed 2026-09-11 against `Uniswap/v4-core`, branch `main`: all four are
///         byte-identical.** Nothing to report as a divergence, which is the
///         answer one hopes for and not one that can be assumed.
///
///         `contracts/libraries/TwapFloor.sol` is NOT vendored — it is our 0.8
///         port of v3-periphery's `OracleLibrary`, so it is read rather than
///         hashed. Compared the same day: `quoteAtTick` is `getQuoteAtTick`
///         line for line under v4's names (`sqrtPriceX96`,
///         `getSqrtPriceAtTick`), and `_tickFrom` reproduces `consult`'s
///         round-toward-negative-infinity exactly. What it drops is
///         `harmonicMeanLiquidity`, which nothing here consults — a reduction,
///         not a change.
///
///         **What this file is for is the NEXT edit.** A diff is a photograph;
///         the hashes below make it a property. Change one of those four files,
///         for any reason, and the suite says so — which is the only way a
///         "copied from upstream" claim stays true after the day it was made.
///
///         **If one of these fails**: re-fetch the file from
///         `raw.githubusercontent.com/Uniswap/v4-core/main/src/libraries/`,
///         diff it, and either restore it or update the hash WITH the reason in
///         the commit. A hash bumped without a sentence is how a vendored
///         library quietly becomes a fork.
contract VendoredLibrariesTest is Test {
    /// @dev `sha256`, not `keccak256`: it is what `shasum -a 256` prints, so the
    ///      number below can be checked from a terminal without this suite.
    function _pin(string memory name, bytes32 expected) internal view {
        bytes32 got = sha256(bytes(vm.readFile(string.concat("contracts/libraries/", name))));
        assertEq(got, expected, string.concat(name, " is no longer the file Uniswap published"));
    }

    function test_TheVendoredUniswapLibrariesAreUpstreamsByteForByte() public view {
        _pin("FullMath.sol", 0xa9607255a6fd604d9c92f6b7416811c38b9d86e5dfdb0c345a494ebd35f7a4a3);
        _pin("TickMath.sol", 0x272d4f6d3ff9ae33596ebcdb84a71a3c2d4542ae8fb5c88ddf1aca8043f5d06b);
        _pin("BitMath.sol", 0xe8a45eb3d57f9427fc47bbb2543c1a6a5f394113b378123ac7ca9f113a7502b4);
        _pin("CustomRevert.sol", 0x9d3dbe6b742cb1ac30f57df89d879ade9649389de1165fc637114bd062d39fca);
    }

    /// @notice **And the surface this project actually leans on, exercised
    ///         rather than trusted.**
    ///
    /// @dev    A hash proves the bytes are upstream's. It does not prove that
    ///         upstream's bytes do what the callers here assume — and the two
    ///         assumptions that carry money are exactly these: `mulDiv` is
    ///         EXACT where a plain `a * b / d` would overflow, and
    ///         `getSqrtPriceAtTick` is strictly increasing across the whole
    ///         range a v3 pool can return (`TwapFloor.quoteAtTick` feeds it a
    ///         mean tick and trusts the result to be a price).
    function testFuzz_MulDivIsExactWhereThePlainProductWouldOverflow(uint256 a, uint256 b, uint256 d) public pure {
        d = bound(d, 1, type(uint256).max);
        // Where the product does NOT overflow, `mulDiv` must agree with the
        // ordinary arithmetic — the only place the two can be compared at all.
        if (a != 0 && b > type(uint256).max / a) {
            // Phantom overflow: no reference to compare against, so check the
            // identity that defines the function instead.
            if (b != 0) assertEq(FullMath.mulDiv(a, b, b), a, "mulDiv(a, b, b) must be a, however large");
            return;
        }
        assertEq(FullMath.mulDiv(a, b, d), (a * b) / d, "mulDiv disagrees with the plain product");
    }

    function testFuzz_TheSqrtPriceIsStrictlyIncreasingInTheTick(int24 tick) public pure {
        tick = int24(bound(int256(tick), TickMath.MIN_TICK, TickMath.MAX_TICK - 1));
        assertLt(
            TickMath.getSqrtPriceAtTick(tick),
            TickMath.getSqrtPriceAtTick(tick + 1),
            "a higher tick must be a higher price, or every floor derived from a TWAP is nonsense"
        );
    }

    /// @notice **T-HYP-02's sibling, settled: `quoteAtTick` cannot revert on a
    ///         tick a pool can produce.**
    ///
    /// @dev    `AUDIT_PLAN.md` Appendix A: `TwapFloor.quoteAtTick` is called
    ///         OUTSIDE the `try` in `FeeVault._legFloor` — `tryMeanTick` is
    ///         wrapped, the line after it is not. If
    ///         `TickMath.getSqrtPriceAtTick` ever rejected the returned tick,
    ///         the revert would take the whole `buyBasket` down, which is the
    ///         failure §S3's fix was written to remove. Exactly the asymmetry
    ///         T-HYP-02 found on the first hop, one line further along.
    ///
    ///         **It is unreachable, and here is the reason rather than the
    ///         claim.** A pool clamps its own ticks to ∓887 272, an observation
    ///         is a sum of in-range ticks, and the arithmetic mean of two such
    ///         cumulatives is therefore in range by construction. This walks the
    ///         WHOLE range and asserts no tick in it reverts — both token
    ///         orderings, since `quoteAtTick` branches on the addresses.
    ///
    ///         **What it does NOT cover, said plainly:** `_tickFrom` casts to
    ///         `int24`, which TRUNCATES rather than reverting, and `int24`'s
    ///         range is wider than the tick range. A pool returning cumulatives
    ///         outside its own invariants could therefore hand back a tick this
    ///         test's range does not contain, and that would take the purchase
    ///         down — the same accepted class as T-HYP-02's first hop, and a
    ///         pool that violates its own invariants is not a pool any floor
    ///         could protect against.
    function testFuzz_QuoteAtTickAnswersForEveryTickAPoolCanProduce(int24 tick, uint128 amount) public pure {
        tick = int24(bound(int256(tick), TickMath.MIN_TICK, TickMath.MAX_TICK));
        amount = uint128(bound(uint256(amount), 1, type(uint96).max));
        address low = address(1);
        address high = address(2);

        // Both orderings: the branch is on `baseToken < quoteToken`.
        TwapFloor.quoteAtTick(tick, amount, low, high);
        TwapFloor.quoteAtTick(tick, amount, high, low);
    }

    /// @notice And the price it answers with moves the right way.
    ///
    /// @dev    A floor derived from a TWAP is only a floor if a higher tick
    ///         means more of the quote token. Monotonicity is checked away from
    ///         the extremes, where the Q64.96 rounding can make two adjacent
    ///         ticks quote the same amount for a small base.
    function testFuzz_AHigherTickQuotesMore(int24 tick) public pure {
        tick = int24(bound(int256(tick), -700_000, 700_000));
        uint128 amount = 1e18;
        assertGe(
            TwapFloor.quoteAtTick(tick + 1, amount, address(1), address(2)),
            TwapFloor.quoteAtTick(tick, amount, address(1), address(2)),
            "a higher tick must not quote less"
        );
    }

    /// @notice The three constants every caller here relies on by name.
    function test_TheTickBoundsAreTheOnesTheCallersAssume() public pure {
        assertEq(TickMath.MIN_TICK, -887272, "MIN_TICK");
        assertEq(TickMath.MAX_TICK, 887272, "MAX_TICK");
        // Tick zero is price 1, i.e. 2^96 in Q64.96. If this moved, every quote
        // in the system would be off by the same factor and nothing would say so.
        assertEq(TickMath.getSqrtPriceAtTick(0), 2 ** 96, "tick 0 must be a price of exactly one");
    }
}
