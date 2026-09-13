// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeVault} from "../FeeVault.sol";
import {ModeVault} from "./ModeVault.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  ModeFactory — what `Payd` admits as a payout mode
///
/// @notice One factory declares one mode and clones its vault. Copy, rename,
///         change `MODE`, point it at your vault.
///
/// @dev    **Two members are not yours to reshape.** `Payd._enable` and
///         `Payd._create` cast this address to `DistributionFactory`, so the selectors
///         must match that type exactly — `MODE()` = `0x1fcbc407`,
///         `create(...)` = `0x2c3aaedb`. Reusing `VaultTypes.Config` and
///         `VaultTypes.Allocation` is how that is guaranteed rather than hoped;
///         re-declaring the structs locally would work until somebody reorders
///         a field. Verify after any change:
///
///             forge inspect contracts/modes/ModeFactory.sol:ModeFactory methods
///
///         **Permissionless, and it adds no power.** Anyone may call `create`.
///         A vault built directly, outside `Payd`, is in no registry: it is
///         neither a `migrate` destination nor visible in the front's index.
///         What takes two keys is `Payd.approve` (generation Ledger) followed
///         by `enableFactory` (timelock, 48 h) — see `script/DeployMode.s.sol`.
contract ModeFactory {
    /// @notice What this factory builds. Non-zero, or `Payd._enable` reverts
    ///         `BadMode`. Read ONCE at admission and never again.
    ///
    /// @dev    **Pick a string nobody else uses.** `FeeVault.migrate` compares
    ///         mode NAMES, not factory addresses — that is what lets a new
    ///         version of the same mode be a valid destination, and it is the
    ///         entire upgrade path. The flip side is enforced nowhere: reusing
    ///         an existing mode's string makes this factory's vaults valid
    ///         `migrate` destinations for every vault of that mode, without the
    ///         generation key ever opening `crossModeMigration`.
    ///
    ///         The distribution mode holds `"distribution"`. 31 bytes max.
    ///
    ///         **A constructor argument since 2026-09-11, and it used to be
    ///         `constant "TODO-name-this-mode"` (T-MODE-02).** `Payd._enable`
    ///         refused only `bytes32(0)`, so the placeholder went through and
    ///         became a permanent, unforgeable `modeOf` value that
    ///         `FeeVault.migrate` compares against for ever — every later
    ///         factory wanting to be a destination for those vaults would have
    ///         had to declare it too. Naming the mode is now a thing you cannot
    ///         forget to do rather than a thing you are asked to remember, and
    ///         `Payd._enable` refuses the old placeholder besides, for any copy
    ///         of this file that predates the change.
    bytes32 public immutable MODE;

    /// @notice Deployed once, here. This is what takes a launch from millions
    ///         of gas to a minimal proxy.
    address public immutable VAULT_IMPL;

    event VaultBuilt(address indexed vault, address indexed distributor);

    error BadMode();

    /// @param mode_ The name this factory's vaults are stamped with, for ever.
    ///        Not zero, and not the placeholder this template used to carry.
    constructor(bytes32 mode_) {
        if (mode_ == bytes32(0) || mode_ == PLACEHOLDER) revert BadMode();
        MODE = mode_;
        VAULT_IMPL = address(new ModeVault());
    }

    /// @dev The name this file shipped with until 2026-09-11. Kept so that
    ///      refusing it is a statement rather than a magic literal — `Payd`
    ///      refuses the same value at the registry's door.
    bytes32 internal constant PLACEHOLDER = "TODO-name-this-mode";

    /// @notice The one function `Payd` calls. Do not reorder, do not add a
    ///         parameter — the signature is fixed by the cast in `Payd._create`.
    ///
    /// @dev    `cfg` arrives fully wired by the registry, `platformBps` as of
    ///         today, `creator`/`deployer` = the launcher. A mode may ignore
    ///         any of it; it cannot refuse to receive it.
    ///
    ///         `keeper`, `genesis` and `epochLength` are the distribution
    ///         mode's `Distributor` arguments. A mode with no second contract
    ///         drops them and returns the vault twice: `Payd` only emits the
    ///         second address, nothing ever calls it. Nothing bounds
    ///         `epochLength` any more either — `DistributionFactory` bounds its own
    ///         because its Distributor has epochs. Bound yours here if you
    ///         grow any.
    ///
    ///         No `Bootstrap` here. It exists in the distribution mode because
    ///         `FeeVault` and `Distributor` hold each other as `immutable` and
    ///         neither can be deployed first. One contract needs no such knot —
    ///         if your mode grows a second one, copy `contracts/Bootstrap.sol`
    ///         rather than reinventing the address prediction.
    function create(
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory basket,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor) {
        // A mode with no distributor leaves the field zero: `BaseModeVault`
        // then skips the gas slice in `harvest` instead of paying nobody.
        cfg.distributor = address(0);
        vault = LibClone.clone(VAULT_IMPL);
        // Cloned and configured in the SAME transaction: there is no block in
        // which an unconfigured vault exists for someone else to claim.
        ModeVault(payable(vault)).init(cfg, basket, modeData);
        distributor = vault;
        emit VaultBuilt(vault, distributor);
    }
}
