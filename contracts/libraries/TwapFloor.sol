// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "./TickMath.sol";
import {FullMath} from "./FullMath.sol";
import {IUniswapV3PoolObserver} from "../interfaces/IExternal.sol";

/// @title TwapFloor
/// @notice Price floor derived from a Uniswap v3 TWAP. It is the only source
///         that is always available: Chainlink equity feeds go stale over the
///         weekend (docs/recon.md §5), the TWAP never does.
/// @dev    Ports the logic of Uniswap v3-periphery's `OracleLibrary` to 0.8, on
///         top of `TickMath`/`FullMath` extracted from a v4-core source verified
///         on-chain (chainId 4663).
///
///         WARNING - prerequisite: the pool's observation cardinality must cover
///         `secondsAgo`. Uniswap v3 writes at most one observation per second,
///         so a cardinality of N guarantees N seconds of continuous trading.
///         Measurements and fix in docs/ARCHITECTURE.md §S3.
library TwapFloor {
    error TwapUnavailable();

    /// @notice Arithmetic mean tick over the last `secondsAgo` seconds.
    /// @dev    Reverts if the pool lacks observations — this is deliberate: the
    ///         caller must then skip that stock, never fall back to a single
    ///         source nor to `minOut = 0`. A caller that must not revert AT ALL
    ///         asks `tryMeanTick` instead.
    function meanTick(address pool, uint32 secondsAgo) internal view returns (int24) {
        if (secondsAgo == 0) revert TwapUnavailable();

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives,) = IUniswapV3PoolObserver(pool).observe(secondsAgos);
        return _tickFrom(tickCumulatives[1] - tickCumulatives[0], secondsAgo);
    }

    /// @notice `meanTick`, saying so instead of reverting when the pool cannot
    ///         serve the window.
    ///
    /// @dev    This lives HERE, around `observe`, and not at the call site,
    ///         because `try` only wraps an EXTERNAL call: an internal library
    ///         call cannot be caught, which is how `ARCHITECTURE.md` §S3's
    ///         promise ("`observe()` in a try/catch, that stock is not bought
    ///         this cycle") survived a reading of a `FeeVault` where one
    ///         unusable pool reverted the WHOLE basket.
    ///
    ///         `false` means no floor, which every caller must read as "do not
    ///         buy this leg" — never as a licence to swap without one.
    function tryMeanTick(address pool, uint32 secondsAgo) internal view returns (bool ok, int24 tick) {
        if (secondsAgo == 0) return (false, 0);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        try IUniswapV3PoolObserver(pool).observe(secondsAgos) returns (int56[] memory tc, uint160[] memory) {
            return (true, _tickFrom(tc[1] - tc[0], secondsAgo));
        } catch {
            return (false, 0);
        }
    }

    /// @dev The mean tick of a cumulative delta, rounded towards -infinity as
    ///      OracleLibrary does: never over-estimate the tick, hence never
    ///      over-estimate the output price. One copy, because the rounding is
    ///      the whole subtlety and two copies of a subtlety is one copy too many.
    function _tickFrom(int56 delta, uint32 secondsAgo) private pure returns (int24 tick) {
        tick = int24(delta / int56(uint56(secondsAgo)));
        if (delta < 0 && (delta % int56(uint56(secondsAgo)) != 0)) tick--;
    }

    /// @notice How much `quoteToken` `baseAmount` of `baseToken` is worth at this tick.
    function quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);

        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /// @notice Expected output of a two-hop route, at the TWAP.
    function quoteTwoHops(
        address poolA,
        address tokenIn,
        address mid,
        address poolB,
        address tokenOut,
        uint128 amountIn,
        uint32 secondsAgo
    ) internal view returns (uint256) {
        uint256 midAmount = quoteAtTick(meanTick(poolA, secondsAgo), amountIn, tokenIn, mid);
        if (midAmount == 0 || midAmount > type(uint128).max) revert TwapUnavailable();
        return quoteAtTick(meanTick(poolB, secondsAgo), uint128(midAmount), mid, tokenOut);
    }
}
