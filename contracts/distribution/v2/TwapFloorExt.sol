// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TwapFloor} from "../../libraries/TwapFloor.sol";

/// @title  TwapFloorExt — `TwapFloor`, one delegatecall away
///
/// @notice The same floor `FeeVault` inlines, wrapped in EXTERNAL functions so
///         the code lives in a deployed library instead of inside the vault.
///         This exists for one reason: `FeeVaultV2` is a copy of a contract
///         that already sits against EIP-170, and the TWAP stack drags
///         `TickMath.getSqrtPriceAtTick` — the single largest pure-math block
///         in the vault — with it everywhere it is inlined. Moving it out is
///         what turns a two-digit byte margin into a budget future fixes can
///         actually spend.
///
/// @dev    A wrapper, not a fork: every function forwards to `TwapFloor`, so
///         there is exactly one copy of the rounding subtleties and V1 and V2
///         keep computing the same floor to the wei. The cost is one
///         DELEGATECALL per floor read (~700 gas) on a path that already pays
///         tens of thousands for the `observe` calls it wraps.
///
///         V1 stays inlined ON PURPOSE: `FeeVault` is deployed, its source is
///         the record of what runs, and re-linking it would change a build
///         nothing on-chain would match.
library TwapFloorExt {
    function meanTick(address pool, uint32 secondsAgo) external view returns (int24) {
        return TwapFloor.meanTick(pool, secondsAgo);
    }

    function tryMeanTick(address pool, uint32 secondsAgo) external view returns (bool ok, int24 tick) {
        return TwapFloor.tryMeanTick(pool, secondsAgo);
    }

    function quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        external
        pure
        returns (uint256)
    {
        return TwapFloor.quoteAtTick(tick, baseAmount, baseToken, quoteToken);
    }

    function quoteTwoHops(
        address poolA,
        address tokenIn,
        address mid,
        address poolB,
        address tokenOut,
        uint128 amountIn,
        uint32 secondsAgo
    ) external view returns (uint256) {
        return TwapFloor.quoteTwoHops(poolA, tokenIn, mid, poolB, tokenOut, amountIn, secondsAgo);
    }
}
