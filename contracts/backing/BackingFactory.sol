// SPDX-License-Identifier: MIT
//
//         ○   ○
//          ╲ ╱               P A Y D
//         ╭─┴─╮
//        ╱     ╲             Creator fees buy tokenised equities for a token's holders.
//       │       │            No staking, no sign-up, nothing to approve.
//        ╲_____╱             paydprotocol.eth  ·  https://paydprotocol.eth.limo  ·  x.com/PaydRH
//
pragma solidity 0.8.26;

import {BackingBootstrap} from "./BackingBootstrap.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  BackingFactory
/// @notice The burn-to-redeem payout mode. Fees buy the basket exactly as the
///         distribution mode does; the stocks land on a `BackingRedeemer` and
///         stay there, and any holder burns launch tokens to take their
///         pro-rata slice. No keeper, no root, no push cycle — the only mode
///         that removes keys instead of adding machinery.
///
/// @dev    **`MODE` is `"backing"`, a name no other factory carries.**
///         `FeeVault.migrate` compares mode names, so this string is what
///         keeps a distribution vault from migrating here — a different
///         promise to holders — without the generation key opening
///         `crossModeMigration` first.
///
///         **The vault is the deployed `FeeVaultV2` implementation, passed as
///         a constructor argument** and cloned with no legs: this mode
///         changes where the stocks go, never how they are bought, so the buy
///         stack — floors, pivot routing, skip-don't-revert, bounty — exists
///         in exactly one place. Impls as arguments is also the EIP-3860
///         posture (`DistributionFactoryV2`), and it makes every wire
///         readable before either key signs the admission.
///
///         **`keeper` is accepted and ignored.** The selector is fixed by the
///         cast in `Payd._create` and the registry always passes its pinned
///         keeper; this mode simply has nothing for one to publish.
///
///         The selectors `MODE()` and `create(...)` are fixed by the cast in
///         `Payd._enable` / `Payd._create` — reusing `VaultTypes` is what
///         guarantees the match. Verify after any change:
///
///             forge inspect contracts/backing/BackingFactory.sol:BackingFactory methods
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract BackingFactory {
    error BadEpochLength(uint256 given);
    error UnexpectedModeData();
    error ZeroAddress();

    uint256 public constant MIN_EPOCH_LENGTH = 30 minutes;
    uint256 public constant MAX_EPOCH_LENGTH = 1 days;

    bytes32 public constant MODE = "backing";

    address public immutable VAULT_IMPL;
    address public immutable REDEEMER_IMPL;

    event VaultBuilt(address indexed vault, address indexed redeemer);

    constructor(address vaultImpl, address redeemerImpl) {
        if (vaultImpl == address(0) || redeemerImpl == address(0)) revert ZeroAddress();
        VAULT_IMPL = vaultImpl;
        REDEEMER_IMPL = redeemerImpl;
    }

    /// @notice Builds the pair, wired to each other, in one transaction.
    ///
    /// @dev    `modeData` must be empty: this mode has no per-launch
    ///         parameter, and a factory that ignores bytes it did not ask for
    ///         teaches callers that the field does nothing — until a mode
    ///         where it does.
    function create(
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory basket,
        address, /* keeper — nothing to publish, see the contract doc */
        uint256 genesis,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor) {
        if (epochLength < MIN_EPOCH_LENGTH || epochLength > MAX_EPOCH_LENGTH) {
            revert BadEpochLength(epochLength);
        }
        if (modeData.length != 0) revert UnexpectedModeData();
        BackingBootstrap boot = new BackingBootstrap(VAULT_IMPL, REDEEMER_IMPL, cfg, basket, genesis, epochLength);
        vault = address(boot.VAULT());
        distributor = address(boot.REDEEMER());
        emit VaultBuilt(vault, distributor);
    }
}
