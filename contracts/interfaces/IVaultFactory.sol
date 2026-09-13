// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeVault} from "../FeeVault.sol";
import {VaultTypes} from "./VaultTypes.sol";

/// @notice **What `Payd` requires of a factory, and the whole of it.**
///
/// @dev    The registry used to hold `DistributionFactory` — the distribution
///         mode's own type — and cast every admitted factory to it. That was
///         accurate while one mode existed and became a lie the day a second
///         one could be enabled: `Payd` is an interface over factories, and the
///         type it speaks must not be one mode's implementation.
///
///         Two members, and they are fixed by this interface rather than by a
///         convention. Re-read the selectors after any change to the signature
///         — `MODE()` never moves, `create(...)` moves with `Config`.
///         A factory that does not match is not callable here, whatever it
///         declares. Check yours with:
///
///             forge inspect <path>:<Contract> methods
///
///         **The two shapes it passes live in `VaultTypes`, which belongs to no
///         mode.** They sat on `FeeVault` until 2026-09-11, which typed this
///         interface — and the registry behind it — on the distribution mode's
///         own vault. Struct names never reach the ABI, so the move changed no
///         selector: `create(...)` is `0x34abd429` on either side of it.
interface IVaultFactory {
    /// @notice The payout mode this factory builds. Non-zero, read once at
    ///         admission, stamped onto every vault it builds.
    function MODE() external view returns (bytes32);

    /// @notice Builds one vault. What comes back is registered by `Payd` as-is:
    ///         the registry checks the arguments it owns, never the code.
    ///
    /// @param  modeData the launcher's per-launch parameter for this mode,
    ///         forwarded verbatim and never decoded by `Payd`. Empty on every
    ///         path but `createVaultWith`. A mode that has none should REFUSE a
    ///         non-empty value rather than ignore it: silence would let a
    ///         launcher believe they configured something.
    function create(
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory basket,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor);
}
