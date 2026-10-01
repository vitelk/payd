// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/IExternal.sol";
import {Allowlist} from "./Allowlist.s.sol";
import {MeasureQuotes} from "./MeasureQuotes.s.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";

interface IV3Pool {
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
}

interface IMeta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IQuoter {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external
        returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256);
}

interface IObserver {
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

/// @notice **Is there a fallback route through WETH?**
///
///   forge script script/MeasureRoutes.s.sol --rpc-url $RPC_URL
///
/// @dev    The question asked is: if a token has no pool against the PIVOT,
///         would a `PIVOT -> WETH -> token` pick it up? It gets measured before
///         it gets implemented -- `recon.md` §4.1 says the stocks' liquidity is
///         against USDG, and if that is still true the fallback route exists
///         nowhere.
contract MeasureRoutes is Script {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant PIVOT = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    /// @dev sqrt(1.01) - 1, in 1e9 -- the same measurement as `MeasureQuotes`.
    uint256 constant K_NUM = 4_987_562;
    uint256 constant K_DEN = 1_000_000_000;
    uint256 constant Q96 = 2 ** 96;
    /// @dev ETH/USD at the Chainlink feed of 2026-09-08, to bring a depth
    ///      denominated in WETH back to dollars. Compares a USDG depth to a WETH
    ///      depth without going through the raw `L`s, which are NOT comparable
    ///      between two pairs -- the mistake `CheckTiers` documents.
    uint256 constant ETH_USD_CENTS = 249_106;

    /// @dev The pairs actually used on Pons that have NO pool at all against
    ///      the pivot. Two of them carry 198 of the week's ~220 credits; the
    ///      others are one-off launches.
    function unreachable() public pure returns (address[] memory u) {
        u = new address[](24);
        u[0] = 0x6330D8C3178a418788dF01a47479c0ce7CCF450b;
        u[1] = 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4;
        u[2] = 0x3eC8A8174129D5cBeCef67eE2AF8621319c34c03;
        u[3] = 0x96F10D7A43639B9c7e09aee5304C406670289aB4;
        u[4] = 0x9c4852B2DEDD1EE707c4b66BB466c737291410B0;
        u[5] = 0x0616ab29F9a6443777acF3a3cbBA5D6D428cF1c6;
        u[6] = 0x71df0898f02a3B8a24546a6d3aD3E5b519D23687;
        u[7] = 0x15eC874e36a19d40CD1Aa3089A2A9c92954e9d28;
        u[8] = 0xcD405B55F0185D2D55394cA051Fda69af9036Fce;
        u[9] = 0x9E4596ab50aaDc5F36CF0e4DB17d714b60CA6554;
        u[10] = 0x89314DD83f307d7d9bc19ff261888027fA531658;
        u[11] = 0x7958d38C854b4101C9bBed9a3391aAC253898a8F;
        u[12] = 0x15B4bA895FEed50F3192F145A5C84172F2F7dE17;
        u[13] = 0xB977a8D485b196320e76Babd8a5F9c14292bE363;
        u[14] = 0xcE7a584eab2Fe5A23624120dE2A623Ef1381CC1E;
        u[15] = 0xa46403920931A33b03b055ed013d75A868bAEbe4;
        u[16] = 0x0a28a76b83D257A62dEe3AE2CF2386cA9591F694;
        u[17] = 0x61e60c0b90f2a5AE4352890c407dC7ffFac7d2C7;
        u[18] = 0xE9b78B6C2F3e3be6F91bF3d478A27373B20c4b7c;
        u[19] = 0x5Bb97bd366D7D09967C234d99A8dA32D26076c21;
        u[20] = 0x7443e7C48e19363c6927d57A7f78B90568B7047b;
        u[21] = 0xaa5F82C7Db87F48a8c29873508302a1c68b14849;
        u[22] = 0xa14bA236C4B16b083c2bd9a8f40Da0900777467F;
        u[23] = 0xE6A167FAFB3A8854b275c1B48Db35fA967589cD7;
    }

    /// @dev Depth absorbable before +1 %, expressed in the pool's OTHER token,
    ///      then brought back to dollars.
    function _depthUsd(address pool, address other) internal view returns (uint256) {
        if (pool == address(0)) return 0;
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSelector(IV3Pool.slot0.selector));
        if (!ok || ret.length < 32) return 0;
        uint160 sqrtP = abi.decode(ret, (uint160));
        uint128 L = IV3Pool(pool).liquidity();
        if (sqrtP == 0 || L == 0) return 0;

        uint256 raw = IV3Pool(pool).token0() == other
            ? FullMath.mulDiv(FullMath.mulDiv(L, Q96, sqrtP), K_NUM, K_DEN)
            : FullMath.mulDiv(FullMath.mulDiv(L, sqrtP, Q96), K_NUM, K_DEN);

        // PIVOT: 6 decimals, $1. WETH: 18 decimals, $ETH_USD_CENTS/100.
        if (other == PIVOT) return raw / 1e6;
        return FullMath.mulDiv(raw, ETH_USD_CENTS, 100) / 1e18;
    }

    function _bestDepth(address token, address other) internal view returns (uint24 tier, uint256 usd) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        for (uint256 i; i < tiers.length; ++i) {
            uint256 d = _depthUsd(IUniswapV3Factory(V3_FACTORY).getPool(token, other, tiers[i]), other);
            if (d <= usd) continue;
            tier = tiers[i];
            usd = d;
        }
    }

    function _best(address a, address b) internal view returns (uint24 tier, uint128 liq) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        for (uint256 i; i < tiers.length; ++i) {
            address p = IUniswapV3Factory(V3_FACTORY).getPool(a, b, tiers[i]);
            if (p == address(0)) continue;
            uint128 l = IV3Pool(p).liquidity();
            if (l <= liq) continue;
            tier = tiers[i];
            liq = l;
        }
    }

    function _sym(address t) internal view returns (string memory) {
        try IMeta(t).symbol() returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }

    function run() external {
        // 1. The 47 listed stocks: would the WETH route be BETTER?
        (address[] memory stocks,,) = new Allowlist().listings();
        uint256 wethWins;
        uint256 wethOnly;
        for (uint256 i; i < stocks.length; ++i) {
            (, uint256 dp) = _bestDepth(stocks[i], PIVOT);
            (, uint256 dw) = _bestDepth(stocks[i], WETH);
            if (dw > dp) ++wethWins;
            if (dp == 0 && dw > 0) ++wethOnly;
        }
        console.log("listed stocks where WETH is deeper :", wethWins, "of", stocks.length);
        console.log("listed stocks reachable ONLY through WETH :", wethOnly);

        // 2. THE question: the pairs with no pivot pool, does WETH pick them up?
        console.log("");
        console.log("unreachable pairs -- depth $ pivot vs WETH");
        address[] memory u = unreachable();
        for (uint256 i; i < u.length; ++i) {
            (uint24 tp, uint256 dp) = _bestDepth(u[i], PIVOT);
            (uint24 tw, uint256 dw) = _bestDepth(u[i], WETH);
            console.log(
                string.concat(
                    _sym(u[i]),
                    "  pivot: tier=",
                    vm.toString(uint256(tp)),
                    " depth=$",
                    vm.toString(dp),
                    "   weth: tier=",
                    vm.toString(uint256(tw)),
                    " depth=$",
                    vm.toString(dw)
                )
            );
        }

        // 3. The first hop of any fallback route.
        (uint24 tpw, uint256 dpw) = _bestDepth(PIVOT, WETH);
        console.log("");
        console.log(string.concat("pool PIVOT/WETH: tier=", vm.toString(uint256(tpw)), " depth=$", vm.toString(dpw)));

        // 4. The two that are worth the fallback route: price through the
        //    detour, and TWAP of the pool they take.
        console.log("");
        console.log("the two kept -- price through the detour, and TWAP of the QUOTE/WETH pool");
        address[2] memory keep = [u[0], u[1]];
        for (uint256 i; i < keep.length; ++i) {
            (uint24 tw,) = _bestDepth(keep[i], WETH);
            uint8 dec = IMeta(keep[i]).decimals();
            bytes memory path = abi.encodePacked(keep[i], tw, WETH, tpw, PIVOT);
            (uint256 out,,,) = IQuoter(QUOTER).quoteExactInput(path, 10 ** dec);
            bool twapOk = _twap(IUniswapV3Factory(V3_FACTORY).getPool(keep[i], WETH, tw));
            console.log(
                string.concat(
                    _sym(keep[i]),
                    "  dec=",
                    vm.toString(uint256(dec)),
                    "  wethTier=",
                    vm.toString(uint256(tw)),
                    "  price=$",
                    vm.toString(out / 1e6),
                    "  twap=",
                    twapOk ? "yes" : "NO",
                    "  minBuy=",
                    vm.toString(FullMath.mulDiv(24_910_000, 10 ** dec, out))
                )
            );
        }
    }

    address constant QUOTER = 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7;

    function _twap(address pool) internal view returns (bool) {
        if (pool == address(0)) return false;
        uint32[] memory w = new uint32[](2);
        (w[0], w[1]) = (1_800, 0);
        try IObserver(pool).observe(w) returns (int56[] memory, uint160[] memory) {
            return true;
        } catch {
            return false;
        }
    }
}
