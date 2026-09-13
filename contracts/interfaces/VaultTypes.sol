// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title  VaultTypes — the shapes every payout mode is handed
///
/// @notice The creation config and the basket line, in a file that belongs to no
///         mode.
///
/// @dev    **They lived on `FeeVault` until 2026-09-11, and that was a leak.**
///         `Payd._create` assembles a `Config` for whatever factory it is
///         calling, and `IVaultFactory.create` takes one — so the registry and
///         every future mode were typed on the DISTRIBUTION mode's vault. It
///         compiled and it read as a lie: nothing in these two structs is about
///         buying stocks.
///
///         **Their ORDER is an ABI, not a style choice.** `Payd` casts every
///         admitted factory to `IVaultFactory`, so the encoding must be
///         identical on both sides of that call — reordering a field silently
///         moves it in the calldata of every factory that was not recompiled
///         with the change. Re-read the selector after any edit:
///
///             forge inspect contracts/DistributionFactory.sol:DistributionFactory methods
///
///         A library rather than file-level structs, for one reason: `Allocation`
///         is a generic word, and `VaultTypes.Allocation` says where it comes
///         from at every use. A library with no function generates no code.
library VaultTypes {
    struct Allocation {
        address stock; // the Robinhood stock token
        uint24 poolFee; // fee tier of the PIVOT/stock pool
        uint16 bps; // weight, the basket's summing to 10_000
        address feed; // Chainlink feed, or address(0) if none (§S3)
    }

    struct Config {
        address escrow;
        address factory;
        address router;
        address v3Factory;
        address weth;
        address pivot;
        /// @dev Tier of the WETH/PIVOT pool. Non-zero: without it a natively
        ///      ETH-quoted vault has no way to reach the pivot.
        uint24 ethPivotFee;
        address ethUsdFeed;
        address creator;
        address platform;
        uint256 platformBps;
        uint256 rewardsBps;
        address timelock;
        address distributor;
        address deployer;
        address registry;
        address intendedToken;
        /// @dev `address(0)` for a native-ETH vault, i.e. v1's only shape.
        address quote;
        /// @dev Tier of the QUOTE/PIVOT pool. Zero for native ETH and for the
        ///      pivot itself — there is no hop to price — and zero as well when
        ///      the currency goes through the WETH detour.
        uint24 quoteFee;
        /// @dev Tier of the QUOTE/WETH pool, the fallback route. Exactly one
        ///      of the two is non-zero for a currency that is neither ETH nor
        ///      the pivot.
        uint24 quoteWethFee;
        /// @dev Zero means `MIN_BUY`, and is only allowed on an ETH vault.
        uint256 minBuy;
    }
}
