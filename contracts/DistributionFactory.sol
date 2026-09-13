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

import {FeeVault} from "./FeeVault.sol";
import {Distributor} from "./Distributor.sol";
import {Bootstrap} from "./Bootstrap.sol";
import {VaultTypes} from "./interfaces/VaultTypes.sol";

/// @title  DistributionFactory
/// @notice Builds one `FeeVault` + `Distributor` pair. **That is all it does**,
///         and that is why it exists on its own.
///
/// @dev    **Why it was pulled out of `Payd`.** Two reasons, and the second one
///         forced the issue.
///
///         The first is a name. `Payd` holds the lists, the platform rate, the
///         keeper and the vault registry: that is governance. Cloning is a
///         different job, and the two lived in one file because they had
///         started together, not because they belonged together.
///
///         The second is a measurement. A contract that calls `new FeeVault()`
///         embeds its creation code — 26 768 bytes — plus `Distributor`'s and
///         `Bootstrap`'s. `Payd` weighed **54 635 bytes of initcode**, above the
///         EIP-3860 cap (49 152). And it still had to build the $PAYD vault on
///         top. Split, each fits under the Ethereum caps with room to spare:
///         the heavy machinery here, the governance next door.
///
///         That is not a precaution on principle. Of 89 addresses read on this
///         chain, **not one exceeds 24 576 bytes** — the largest, Uniswap's
///         V3Factory, sits at 24 535. The chain is Arbitrum Nitro (ArbOS 116),
///         where the cap applies to the compressed size, so a larger contract
///         might well go through; nobody knows, and a deployment that fails is
///         discovered at the worst possible moment.
///
///         **And it makes a vault-code upgrade almost dull.** A new `FeeVault`
///         implementation is a new factory, and `Payd` points at it (two keys,
///         48 h). The vaults that follow are born in the **same registry**, so
///         `migrate` recognises them through `isVault` alone — written by
///         `_create` and by nothing else.
///
///         That is what allowed `setSuccessor`, and the chain of generations it
///         opened, to be **deleted**: the most dangerous power in the system, an
///         arbitrary address nothing could verify, whose only reason to exist
///         was that a new implementation demanded a new registry.
///
///         **Permissionless, and it adds no power.** Anyone may call `create`:
///         that was already true of `Bootstrap`, a public contract. A vault
///         built directly is in no registry, so it is neither a `migrate`
///         destination nor visible in the front's index. It costs nobody
///         anything.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract DistributionFactory {
    error BadEpochLength(uint256 given);
    /// @dev This mode has no per-launch parameter, and says so rather than
    ///      dropping one on the floor.
    error UnexpectedModeData();

    /// @notice The cadence this mode's `Distributor` accepts.
    ///
    /// @dev    **These live here and no longer in `Payd`.** They are an epoch
    ///         bound, and an epoch is this mode's idea: a registry that is an
    ///         interface over factories has no business refusing a number
    ///         because THIS mode's Distributor would not like it. A mode with
    ///         no epochs simply never reads the argument.
    ///
    ///         Thirty minutes is what a token with real volume wants; a day is
    ///         what a quiet one wants, so its keeper is not publishing roots
    ///         into the void (`PLAN.md` D4). Below the floor the off-chain cost
    ///         stops being worth the resolution; above the ceiling a holder
    ///         waits too long to see anything at all.
    uint256 public constant MIN_EPOCH_LENGTH = 30 minutes;
    uint256 public constant MAX_EPOCH_LENGTH = 1 days;

    /// @notice What this factory builds: **the payout mode**, declared by the
    ///         code rather than guessed from it.
    ///
    /// @dev    `Payd` reads it once, when the factory is set, and stamps every
    ///         vault this factory builds with it (`Payd.modeOf`).
    ///         `FeeVault.migrate` then refuses a destination of another mode:
    ///         holders bought a pro-rata stream and a timelock operation must
    ///         not be able to move them into some other promise.
    ///
    ///         **A name, not the factory's address.** A new version of the SAME
    ///         mode is a new factory — that is the entire upgrade path — so
    ///         comparing addresses would forbid exactly the migration this
    ///         system exists to allow. What has to match between two vaults is
    ///         what they promise, not which deployment made them.
    ///
    ///         **It adds no power.** An approved factory can declare whatever
    ///         mode it likes; an approved factory can already build vaults that
    ///         register here. That is the class (a) risk `setFactory`'s two keys
    ///         answer, and this changes neither side of it. What it does close
    ///         is the honest case: two modes coexisting, and a vault of one
    ///         being pointed at a vault of the other. Reasoning and the two
    ///         alternatives weighed against it: `ARCHITECTURE.md` §S46.
    bytes32 public constant MODE = "distribution";

    /// @notice The two implementations every launch clones.
    ///
    /// @dev    Deployed once, here, in the constructor. This is what takes a
    ///         launch from ~6.1 M gas to ~900 k (`PLAN.md` D5): every vault
    ///         after that is only a minimal proxy.
    address public immutable VAULT_IMPL;
    address public immutable DIST_IMPL;

    event VaultBuilt(address indexed vault, address indexed distributor);

    constructor() {
        VAULT_IMPL = address(new FeeVault());
        DIST_IMPL = address(new Distributor());
    }

    /// @notice Builds the pair, wired to each other, in one transaction.
    ///
    /// @dev    The knot lives in `Bootstrap`: the two contracts reference each
    ///         other, so neither can be deployed first without the other
    ///         existing. `Bootstrap` predicts the address of its second
    ///         deployment before making the first — a CREATE address depends
    ///         only on the deployer and its nonce — and checks the prediction
    ///         before it returns.
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
        // The basket IS this mode's per-launch parameter, and it has its own
        // argument. Anything here was meant for another mode.
        if (modeData.length != 0) revert UnexpectedModeData();
        Bootstrap boot = new Bootstrap(VAULT_IMPL, DIST_IMPL, cfg, basket, keeper, genesis, epochLength);
        vault = address(boot.VAULT());
        distributor = address(boot.DISTRIBUTOR());
        emit VaultBuilt(vault, distributor);
    }
}
