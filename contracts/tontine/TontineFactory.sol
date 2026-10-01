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

import {BootstrapV3} from "../distribution/v3/BootstrapV3.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  TontineFactory
/// @notice The diamond-hands payout mode. Fees buy the basket and a root is
///         published every epoch exactly as the distribution mode does; what
///         changes is one rule about what a root may say: shares a holder has
///         earned but NOT yet been delivered are forfeited pro-rata when their
///         launch-token balance falls, and redistributed to the holders who
///         stayed. Sell half, and half of what is still owed to you goes to
///         them.
///
/// @dev    **This mode adds no new on-chain machinery, and that is the
///         finding, not a shortcut.** The distribution mode already pays by
///         TWAB, so a mid-epoch seller is already only paid for the time held;
///         and `Distributor` already tolerates a cumulative that goes DOWN
///         between two roots (`_one`: `if (cumulative <= paid) return 0` — a
///         lowered cumulative pays zero, it never underflows and never claws
///         back what was delivered). Forfeiture therefore lives entirely in
///         how the off-chain builds the cumulative
///         (`offchain/src/tontine.ts`), and the vault, the legs, the
///         distributor and the bootstrap are the DEPLOYED distribution impls,
///         reused verbatim. The backing mode proved a new payout mode needs no
///         new vault; this one pushes it one step further — it needs no new
///         distributor either.
///
///         **`MODE` is `"tontine"`, a name no other factory carries.**
///         `FeeVault.migrate` compares mode names, so this string is what
///         keeps a distribution vault from migrating here — a strictly harsher
///         promise to its holders — unless the generation key has opened
///         `crossModeMigration` first. It is also the single on-chain fact
///         that tells the keeper, the disputer and the co-signer which accrual
///         rule to apply: `Payd.modeOf(vault) == "tontine"`.
///
///         **The impls are constructor ARGUMENTS** — the same EIP-3860
///         posture as `DistributionFactoryV2`/`V3`, and what lets the
///         generation key read every wire before signing the admission. Pass
///         the already-deployed `FeeVaultV2` / `DistributorV3` / `V2Legs`, the
///         Uniswap v4 singleton, and the Pons locker: a tontine vault gets the
///         V3 birth exclusion for the same reason every other vault does, and
///         the locker never accrues, so it never forfeits and never receives a
///         forfeiture.
///
///         The selectors `MODE()` and `create(...)` are fixed by the cast in
///         `Payd._enable` / `Payd._create` — reusing `VaultTypes` is what
///         guarantees the match. Verify after any change:
///
///             forge inspect contracts/tontine/TontineFactory.sol:TontineFactory methods
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract TontineFactory {
    error BadEpochLength(uint256 given);
    error BadModeData();
    error ZeroAddress();

    uint256 public constant MIN_EPOCH_LENGTH = 30 minutes;
    uint256 public constant MAX_EPOCH_LENGTH = 1 days;

    /// @notice The legs are orthogonal to the payout rule — a tontine can burn
    ///         and lock LP like any V2/V3 launch — so the bounds are the ones
    ///         `FeeVaultV2.initLegs` enforces again where the money moves.
    uint256 public constant MIN_LEG_BPS = 500;
    uint256 public constant MAX_LEGS_BPS = 5_000;

    bytes32 public constant MODE = "tontine";

    address public immutable VAULT_IMPL;
    address public immutable DIST_IMPL;
    address public immutable LEGS_IMPL;
    /// @notice The Uniswap v4 singleton the legs trade on. A constructor
    ///         argument because nothing in `VaultTypes.Config` carries it —
    ///         the basket lives on v3.
    address public immutable POOL_MANAGER;
    /// @notice What every Distributor this factory builds excludes from birth,
    ///         at epoch 0. The Pons locker on this chain, declared from recon
    ///         (`docs/recon.md` §1.1) and never probed at create time.
    address public immutable EXCLUDED_AT_BIRTH;

    event VaultBuilt(address indexed vault, address indexed distributor);

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
    ///         wired to each other, in one transaction. Byte for byte the same
    ///         knot `DistributionFactoryV3` ties: the difference between the
    ///         two modes is the `MODE` stamped on the vault, and what the
    ///         off-chain reads it to decide.
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
