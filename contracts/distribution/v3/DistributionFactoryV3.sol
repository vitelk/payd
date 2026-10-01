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

import {BootstrapV3} from "./BootstrapV3.sol";
import {VaultTypes} from "../../interfaces/VaultTypes.sol";

/// @title  DistributionFactoryV3
/// @notice The distribution mode's third version: everything V2 does — the
///         optional burn and locked-LP legs included — plus one exclusion
///         seeded into every Distributor at birth, dated epoch 0: the Pons
///         locker, which holds 8.16 % of a graduated supply and can never
///         claim. V2 vaults needed a per-vault timelock `setExcluded` (48 h)
///         after creation, and every launch graduating inside that window
///         accrued shares to the locker; a V3 vault is born with the entry
///         already in its dated log, and the ritual is retired.
///
/// @dev    **`MODE` is `"distribution"`, the SAME string as V1 and V2 — on
///         purpose.** `FeeVault.migrate` compares mode names, not factory
///         addresses, and that is the entire upgrade path: an existing vault
///         may migrate into a vault this factory built, under timelock alone,
///         because all three make the same promise to holders. A seeded
///         exclusion does not change the promise — it stops paying a contract
///         that cannot claim.
///
///         **`EXCLUDED_AT_BIRTH` is a constructor argument, not a live read.**
///         The route-declaration rule applies: declared at birth from a
///         measurement (`docs/recon.md` §1.1, `factory.locker()`), never
///         probed at create time — a factory whose behaviour depends on what
///         Pons answers that block is a factory the generation key cannot
///         review before signing. If Pons ever rotates lockers, the new one
///         is a new factory; until then the keeper's push filter, which DOES
///         read `factory.locker()` live, still stops deliveries to whatever
///         the current locker is.
///
///         The selectors `MODE()` and `create(...)` are fixed by the cast in
///         `Payd._enable` / `Payd._create` — reusing `VaultTypes` is what
///         guarantees the match. Verify after any change:
///
///             forge inspect contracts/v3/DistributionFactoryV3.sol:DistributionFactoryV3 methods
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract DistributionFactoryV3 {
    error BadEpochLength(uint256 given);
    error BadModeData();
    error ZeroAddress();

    uint256 public constant MIN_EPOCH_LENGTH = 30 minutes;
    uint256 public constant MAX_EPOCH_LENGTH = 1 days;

    /// @notice A leg that is on must be worth having: below 5 % of the
    ///         holders' share it is a rounding error wearing a feature's name.
    ///         And the two together may never take more than half — the cap
    ///         `FeeVaultV2.initLegs` enforces again where the money moves.
    uint256 public constant MIN_LEG_BPS = 500;
    uint256 public constant MAX_LEGS_BPS = 5_000;

    bytes32 public constant MODE = "distribution";

    address public immutable VAULT_IMPL;
    address public immutable DIST_IMPL;
    address public immutable LEGS_IMPL;
    /// @notice The Uniswap v4 singleton the legs trade on. A constructor
    ///         argument because nothing in `VaultTypes.Config` carries it —
    ///         the basket lives on v3.
    address public immutable POOL_MANAGER;
    /// @notice What every Distributor this factory builds excludes from
    ///         birth, at epoch 0. The Pons locker on this chain.
    address public immutable EXCLUDED_AT_BIRTH;

    event VaultBuilt(address indexed vault, address indexed distributor);

    /// @dev The implementations are ARGUMENTS, not `new` expressions: three
    ///      embedded creation codes put V2's factory initcode at 50,904
    ///      bytes, over the EIP-3860 cap of 49,152 — the same wall that split
    ///      `DistributionFactory` out of `Payd`. The deploy script deploys
    ///      them first and hands the addresses over; what `Payd.approve` and
    ///      `enableFactory` admit is this factory WITH its wiring, and every
    ///      immutable here is readable before either key signs.
    constructor(address vaultImpl, address distImpl, address legsImpl, address poolManager, address excludedAtBirth) {
        if (
            vaultImpl == address(0) || distImpl == address(0) || legsImpl == address(0) || poolManager == address(0)
                || excludedAtBirth == address(0)
        ) {
            revert ZeroAddress();
        }
        VAULT_IMPL = vaultImpl;
        DIST_IMPL = distImpl;
        LEGS_IMPL = legsImpl;
        POOL_MANAGER = poolManager;
        EXCLUDED_AT_BIRTH = excludedAtBirth;
    }

    /// @notice Builds the pair — and the legs, when the launch asked for any —
    ///         wired to each other, in one transaction.
    ///
    /// @dev    `modeData` is this mode's per-launch parameter:
    ///         `abi.encode(uint256 burnBps, uint256 lpBps)`. Empty means no
    ///         legs; anything else is validated here, because the registry
    ///         never decodes what it forwards.
    function create(
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory basket,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor) {
        if (epochLength < MIN_EPOCH_LENGTH || epochLength > MAX_EPOCH_LENGTH) {
            revert BadEpochLength(epochLength);
        }
        (uint256 burnBps, uint256 lpBps) = _decodeLegs(modeData);
        BootstrapV3 boot = new BootstrapV3(
            VAULT_IMPL,
            DIST_IMPL,
            LEGS_IMPL,
            POOL_MANAGER,
            cfg,
            basket,
            keeper,
            genesis,
            epochLength,
            burnBps,
            lpBps,
            EXCLUDED_AT_BIRTH
        );
        vault = address(boot.VAULT());
        distributor = address(boot.DISTRIBUTOR());
        emit VaultBuilt(vault, distributor);
    }

    /// @dev Empty is the way to say "no legs" — `(0, 0)` spelled out is
    ///      refused, so there is exactly one encoding per intention. A leg
    ///      that is on is at least `MIN_LEG_BPS`; the sum never exceeds
    ///      `MAX_LEGS_BPS`.
    function _decodeLegs(bytes memory modeData) internal pure returns (uint256 burnBps, uint256 lpBps) {
        if (modeData.length == 0) return (0, 0);
        if (modeData.length != 64) revert BadModeData();
        (burnBps, lpBps) = abi.decode(modeData, (uint256, uint256));
        if (burnBps + lpBps == 0) revert BadModeData();
        if (burnBps != 0 && burnBps < MIN_LEG_BPS) revert BadModeData();
        if (lpBps != 0 && lpBps < MIN_LEG_BPS) revert BadModeData();
        if (burnBps + lpBps > MAX_LEGS_BPS) revert BadModeData();
    }
}
