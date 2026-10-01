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

import {LotteryBootstrap} from "./LotteryBootstrap.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  LotteryFactory
/// @notice The lottery payout mode. Fees buy the basket exactly as the
///         distribution mode does; the stocks land on a `LotteryDistributor` as
///         a pot, and each draw pays `POT_BPS` of every stock to ONE winner,
///         drawn from a drand `quicknet` beacon verified on-chain. Tickets are
///         the window's time-weighted balances — a sniper is paid in tickets
///         proportional to the time held (§S38).
///
/// @dev    **`MODE` is `"lottery"`, a name no other factory carries.**
///         `FeeVault.migrate` compares mode names, so this string is what keeps
///         a distribution vault from migrating here without the generation key
///         opening `crossModeMigration` first.
///
///         **The vault is the deployed `FeeVaultV2` implementation, passed as a
///         constructor argument** and cloned with no legs — the lottery changes
///         where the stocks go and how they are paid, never how they are bought.
///         Impls as arguments is also the EIP-3860 posture
///         (`DistributionFactoryV2`), and it makes every wire readable before
///         either key signs the admission.
///
///         **`modeData` carries the per-launch `POT_BPS`**: `abi.encode(uint256
///         potBps)`, bounded `[MIN_POT_BPS, MAX_POT_BPS]` at the door and again
///         in `LotteryDistributor.init`. One encoding per intention — an empty
///         `modeData` is refused, because a lottery with no pot share is a bug.
///
///         The selectors `MODE()` and `create(...)` are fixed by the cast in
///         `Payd._enable` / `Payd._create` — reusing `VaultTypes` guarantees the
///         match. Verify after any change:
///
///             forge inspect contracts/lottery/LotteryFactory.sol:LotteryFactory methods
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract LotteryFactory {
    error BadEpochLength(uint256 given);
    error BadModeData();
    error ZeroAddress();

    uint256 public constant MIN_EPOCH_LENGTH = 30 minutes;
    uint256 public constant MAX_EPOCH_LENGTH = 1 days;

    /// @notice The per-draw payout share bounds, mirrored from
    ///         `LotteryDistributor`. A leg below 5 % is a rounding error; above
    ///         50 % a single unlucky draw would empty the pot.
    uint256 public constant MIN_POT_BPS = 500;
    uint256 public constant MAX_POT_BPS = 5_000;

    bytes32 public constant MODE = "lottery";

    address public immutable VAULT_IMPL;
    address public immutable DIST_IMPL;

    event VaultBuilt(address indexed vault, address indexed distributor);

    constructor(address vaultImpl, address distImpl) {
        if (vaultImpl == address(0) || distImpl == address(0)) revert ZeroAddress();
        VAULT_IMPL = vaultImpl;
        DIST_IMPL = distImpl;
    }

    /// @notice Builds the vault + lottery distributor pair, wired to each other,
    ///         in one transaction.
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
        uint256 potBps = _decodePotBps(modeData);
        LotteryBootstrap boot =
            new LotteryBootstrap(VAULT_IMPL, DIST_IMPL, cfg, basket, keeper, genesis, epochLength, potBps);
        vault = address(boot.VAULT());
        distributor = address(boot.DISTRIBUTOR());
        emit VaultBuilt(vault, distributor);
    }

    /// @dev Exactly 32 bytes = `abi.encode(uint256 potBps)`, bounded. Empty or
    ///      any other length is refused — one encoding per intention.
    function _decodePotBps(bytes memory modeData) internal pure returns (uint256 potBps) {
        if (modeData.length != 32) revert BadModeData();
        potBps = abi.decode(modeData, (uint256));
        if (potBps < MIN_POT_BPS || potBps > MAX_POT_BPS) revert BadModeData();
    }
}
