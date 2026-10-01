// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Allowlist} from "../script/Allowlist.s.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/IExternal.sol";

interface IV3Pool {
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16 cardinality, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @notice **Is every pinned tier the CHEAPEST one, not the deepest?**
///
///   forge script script/CheckTiers.s.sol --rpc-url $RPC_URL
///
/// @dev    **A script and not a test, and that is a decision, not an oversight.**
///         It makes ~180 quotes, each one an EVM execution against the fork, and
///         takes ten minutes. Run inside the suite, it failed on `metadata is not
///         found`: the node had pruned the pinned block's state WHILE the test
///         was running. A check that depends on an RPC's retention will be flaky
///         forever, and a flaky test ends up ignored -- which is worse than no
///         test at all.
///
///         Its place is before scheduling the allowlist, by hand, as
///         `docs/PAYD_RUNBOOK.md` says.
///
/// @dev    The first version of this check compared raw LIQUIDITY and flagged
///         three stocks -- GME, RBLX, SKHY -- as badly pinned. The criterion was
///         wrong.
///
///         A 1 % fee tier can be deeper AND more expensive: on GME, 1.25x more
///         liquidity does not buy back 0.95 point of extra fees. Measured at the
///         quoter over 500 USDG, the pinned tier returns 1.42 % MORE. All three
///         flags were false positives.
///
///         What decides is the total cost -- fees plus slippage -- at the amount
///         actually traded. That is what the quoter returns, so that is what we
///         ask rather than reasoning about L.
///
///         The check REPORTS instead of asserting on the winner: liquidity
///         moves, and going red because a competing tier swelled overnight would
///         be noise. What it does assert is that a pinned tier returns
///         something -- a tier that cannot quote is a defect.
///
/// @dev    **Cost is half the criterion, and on 2026-09-11 the missing half
///         nearly cost three lines.** This script compares what a tier RETURNS.
///         It said nothing about whether that tier can serve `TWAP_WINDOW`, and
///         three of its seven suggestions -- TSLA, RIVN, F -- pointed at pools
///         whose observation ring answers `OLD`. A line moved onto one of those
///         is bought NEVER and in silence, its weight piling into
///         `pivotReserve` for the vault's whole life: that is `BA`, delisted the
///         same day for exactly it.
///
///         So a candidate now has to pass both. `_servesWindow` asks the pool
///         the same question `FeeVault._legFloor` asks -- `observe([1800, 0])`,
///         around the external call, since that is the only thing that answers
///         it truthfully -- and a tier that cannot is never named as "better",
///         however cheap. Its cardinality is printed alongside, because a ring
///         that answers today with 8 slots will stop the day the pool gets
///         busy, and that number is the only warning available in advance.
contract CheckTiers is Script {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant QUOTER = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;

    /// @dev 500 USDG: the order of magnitude of a real leg. The ranking of the
    ///      tiers depends on the amount -- at $50 000 depth would take the lead
    ///      back over fees -- so the amount is part of the criterion.
    uint256 constant TRADE = 500e6;

    /// @dev **An EMPTY pool does not quote, it takes the backend down.**
    ///
    ///      SGOV/USDG at tier 100 is initialised at the far end of the tick space
    ///      with zero liquidity. The quoter walks the whole space there looking
    ///      for liquidity, generates thousands of storage reads, and the fork
    ///      gives up on `failed to get storage`. This is not an error a Solidity
    ///      try/catch catches: it happens below the EVM, in the fork backend.
    ///
    ///      Two runs were lost diagnosing this as state pruning -- including
    ///      against a local anvil, where the same pool failed. That is what
    ///      finally pointed at it.
    function _quote(address stock, uint24 fee) internal returns (uint256 out) {
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(stock, USDG, fee);
        if (pool == address(0) || IV3Pool(pool).liquidity() == 0) return 0;

        try IQuoterV2(QUOTER)
            .quoteExactInputSingle(
                IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: USDG, tokenOut: stock, amountIn: TRADE, fee: fee, sqrtPriceLimitX96: 0
            })
            ) returns (
            uint256 a, uint160, uint32, uint256
        ) {
            return a;
        } catch {
            return 0;
        }
    }

    /// @dev **The other half of the criterion.** A cheaper tier that cannot
    ///      serve the 30-minute window is not cheaper, it is dead: the floor
    ///      cannot be computed, `_legFloor` returns 0, and the leg is skipped
    ///      on every purchase without a revert anyone would notice.
    ///
    ///      `card` is returned rather than judged. There is no threshold worth
    ///      hard-coding -- what matters is slots against the pool's own cadence,
    ///      and a busy pool burns its ring faster -- but a candidate carrying 1
    ///      or 8 slots is one quiet hour away from answering `OLD`, and the
    ///      reader deserves to see it before scheduling a timelock operation.
    function _servesWindow(address stock, uint24 fee) internal view returns (bool ok, uint16 card) {
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(stock, USDG, fee);
        if (pool == address(0)) return (false, 0);
        (,,, card,,,) = IV3Pool(pool).slot0();

        uint32[] memory window = new uint32[](2);
        window[0] = 1_800;
        try IV3Pool(pool).observe(window) returns (int56[] memory, uint160[] memory) {
            return (true, card);
        } catch {
            return (false, card);
        }
    }

    function run() external {
        Allowlist list = new Allowlist();
        (address[] memory stocks, uint24[] memory fees,) = list.listings();
        uint24[4] memory all = [uint24(100), 500, 3000, 10000];

        uint256 worse;
        for (uint256 i; i < stocks.length; ++i) {
            uint256 pinned = _quote(stocks[i], fees[i]);
            if (pinned == 0) {
                console.log("PINNED TIER CANNOT QUOTE -- a defect, not a preference");
                console.logAddress(stocks[i]);
                continue;
            }

            uint256 best = pinned;
            uint24 bestFee = fees[i];
            uint16 bestCard;
            for (uint256 j; j < 4; ++j) {
                if (all[j] == fees[i]) continue;
                uint256 out = _quote(stocks[i], all[j]);
                if (out <= best) continue;
                // Cheaper means nothing if the leg can never be priced there.
                (bool serves, uint16 card) = _servesWindow(stocks[i], all[j]);
                if (!serves) {
                    console.log("cheaper BUT the ring cannot serve the window - not a candidate:");
                    console.logAddress(stocks[i]);
                    console.log("  refused tier", all[j]);
                    console.log("  its cardinality", card);
                    continue;
                }
                best = out;
                bestFee = all[j];
                bestCard = card;
            }

            // A gap under 0.1 % does not pay for a timelock operation.
            if (bestFee != fees[i] && best > (pinned * 1_001) / 1_000) {
                ++worse;
                console.log("cheaper tier elsewhere:");
                console.logAddress(stocks[i]);
                console.log("  pinned tier", fees[i]);
                console.log("  pinned out ", pinned);
                console.log("  better tier", bestFee);
                console.log("  better out ", best);
                console.log("  its cardinality", bestCard);
                console.log("  gain, in bps  ", ((best - pinned) * 10_000) / pinned);
            }
        }
        console.log("stocks pinned on a costlier tier:", worse, "of", stocks.length);
    }
}
