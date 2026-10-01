// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IUniswapV3Factory, IUniswapV3PoolObserver} from "../contracts/interfaces/IExternal.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";

interface IV3Pool {
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
}

interface IErc20Meta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}

/// @notice **The candidates for quote-currency status, put through the two
///         measurements of `docs/allowlist.md`.**
///
///   forge script script/MeasureQuotes.s.sol --rpc-url $RPC_URL
///
/// @dev    A script and not a test, for the same reason as `CheckTiers`: it
///         reads the chain's live state, and a check that depends on an RPC's
///         retention would be flaky forever.
///
///         The eight addresses below are the tokens that WERE USED as a pair on
///         Pons during the seven days before 2026-09-08, that have a USDG pool,
///         and that are NOT among the 47 listed stocks. They are the only
///         possible candidates: the 24 other pairs observed have no USDG pool at
///         all, hence no route.
///
///         The two measurements are the allowlist's, no more and no less:
///
///           1. **depth >= $5 000** for a 1 % move, computed on the active
///              liquidity at the current tick;
///           2. **a 30-minute TWAP that answers** — `observe([1800, 0])`. Uniswap
///              reverts `OLD` when the history is shorter than the window, and on
///              a QUOTE that does not skip a leg: `_toUsdg` brings the whole
///              purchase down.
contract MeasureQuotes is Script {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @dev sqrt(1.01) - 1, in 1e9. The fraction of the price that a purchase of
    ///      `depth` moves.
    uint256 constant K_NUM = 4_987_562;
    uint256 constant K_DEN = 1_000_000_000;
    uint256 constant Q96 = 2 ** 96;
    /// @dev The threshold from `docs/allowlist.md`, in USDG (6 decimals).
    uint256 constant MIN_DEPTH = 5_000 * 1e6;

    function candidates() public pure returns (address[] memory c) {
        c = new address[](9);
        c[0] = 0xB90A19fF0Af67f7779afF50A882A9CfF42446400;
        c[1] = 0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67;
        c[2] = 0xceF9027c7d6985b85f0BA431125073529A947A68;
        c[3] = 0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6;
        c[4] = 0x48E39E56aCdbA37b09020C0b734A613C9a2f100A;
        c[5] = 0x408c14038a04f7bD235329E26d2bf569ee20e250;
        c[6] = 0x43B07D15cE533bEc5476d70C22a78a1B2B662155;
        c[7] = 0xF53F66751B1Eff985311b693531E3290F600c410;
        // $PONS -- not a stock, but the question kept coming back and it
        // deserves a number rather than an intuition.
        //
        // **Its pools pass and it is still not a QUOTE.** Listed as one until
        // 2026-09-10, when test_EveryListedQuoteRunsTheWholeCycle found that
        // Pons's factory refuses its own token as a `pairToken` (`0x49285dfb`,
        // and `launchConfigCount()` is 1). No depth this script can report will
        // change that -- it measures pools, and the refusal is upstream of any
        // pool. It IS on the stock allowlist, at tier 10000: buying it for
        // holders asks nothing of Pons.
        c[8] = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    }

    function run() external {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        address[] memory c = candidates();

        console.log(
            "candidate                                  sym    tier   USDG in pool  depth+1%       TWAP30  verdict"
        );
        for (uint256 i; i < c.length; ++i) {
            string memory sym = _symbol(c[i]);

            // The best tier is the one that carries the most depth.
            uint24 bestTier;
            uint256 bestDepth;
            uint256 bestUsdg;
            bool bestTwap;
            for (uint256 t; t < tiers.length; ++t) {
                address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, c[i], tiers[t]);
                if (pool == address(0)) continue;
                uint256 d = _depth(pool);
                if (d <= bestDepth) continue;
                bestTier = tiers[t];
                bestDepth = d;
                bestUsdg = IErc20Meta(USDG).balanceOf(pool);
                bestTwap = _twapAnswers(pool);
            }

            string memory verdict = bestTier == 0
                ? "NO POOL"
                : bestDepth < MIN_DEPTH ? "REFUSED  depth < $5 000" : !bestTwap ? "REFUSED  no 30 min TWAP" : "LISTABLE";

            console.log(
                string.concat(
                    vm.toString(c[i]),
                    "  ",
                    sym,
                    "  tier=",
                    vm.toString(uint256(bestTier)),
                    "  usdg=",
                    vm.toString(bestUsdg / 1e6),
                    "  depth=",
                    vm.toString(bestDepth / 1e6),
                    "  twap=",
                    bestTwap ? "yes" : "NO",
                    "  -> ",
                    verdict
                )
            );
        }
    }

    /// @dev Depth absorbable in USDG before a 1 % price move, from the active
    ///      liquidity and the current price.
    function _depth(address pool) internal view returns (uint256) {
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSelector(IV3Pool.slot0.selector));
        if (!ok || ret.length < 32) return 0;
        uint160 sqrtP = abi.decode(ret, (uint160));
        if (sqrtP == 0) return 0;

        uint128 L = IV3Pool(pool).liquidity();
        if (L == 0) return 0;

        // USDG = token1 : dY = L x sqrtP x K.  USDG = token0 : dX = L / sqrtP x K.
        if (IV3Pool(pool).token0() == USDG) {
            return FullMath.mulDiv(FullMath.mulDiv(L, Q96, sqrtP), K_NUM, K_DEN);
        }
        return FullMath.mulDiv(FullMath.mulDiv(L, sqrtP, Q96), K_NUM, K_DEN);
    }

    function _twapAnswers(address pool) internal view returns (bool) {
        uint32[] memory w = new uint32[](2);
        (w[0], w[1]) = (1_800, 0);
        try IUniswapV3PoolObserver(pool).observe(w) returns (int56[] memory, uint160[] memory) {
            return true;
        } catch {
            return false;
        }
    }

    function _symbol(address t) internal view returns (string memory) {
        try IErc20Meta(t).symbol() returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }
}
