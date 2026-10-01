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

import {Distributor} from "../Distributor.sol";

/// @title  DistributorV3
/// @notice `Distributor` plus one fact known at birth: an address that holds
///         the token without ever being a holder — the Pons locker — written
///         into the DATED exclusion log at epoch 0, before the clone has any
///         history the entry could contradict.
///
/// @dev    **Why init-time and not `setExcluded`.** The timelock door takes
///         48 h, so every vault opened with a window: from its graduation to
///         the execution of its own `setExcluded`, the locker — 8.16 % of a
///         graduated supply, measured on BERRY 2026-09-15 — accrued shares.
///         Undeliverable ones (the keeper's push filter skips the locker), but
///         withheld from that window's holders all the same, and the schedule/
///         execute pair had to be re-run per vault, forever. Seeding the log
///         at `fromEpoch 0` closes the window and retires the ritual.
///
///         **The dated log is the load-bearing part.** Both replays — the
///         on-chain `isExcludedAt` and the reference one in
///         `offchain/src/snapshot.ts` — stop at the first entry PAST the
///         target epoch, so an entry at 0 is in force from the first root and
///         a verifier replaying any epoch derives it identically. Nothing
///         off-chain changes; `structuralExclusions` stays exactly as it is,
///         because an undated set is what it must never become (see the note
///         above the push filter in `offchain/src/keeper.ts`).
///
///         **Why a child and not an edit.** V1's `Distributor` is deployed,
///         and rebuilding it would change a build nothing on-chain matches.
///         The log members are `internal` precisely so a successor can write
///         them; only `_lock` is private, which is why `initV3` reaches the
///         parent's `init` through an external self-call instead of
///         re-writing its body. The self-call re-uses `AlreadyInitialised`,
///         so `init` and `initV3` are one door wearing two names: whichever
///         runs first, nothing runs second.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract DistributorV3 is Distributor {
    /// @notice Configures a fresh clone and seeds one exclusion, dated
    ///         epoch 0. Once, and only once — `BootstrapV3` calls this in the
    ///         same transaction as the clone, so no block ever holds an
    ///         initialised clone with an empty log.
    function initV3(
        address feeVault,
        address timelock,
        address keeper_,
        uint256 genesis,
        uint256 epochLength,
        address excludedAtBirth
    ) external {
        // A V3 with nothing to seed is a V2 — refuse the pretence. Checked
        // before the self-call so the revert names the actual mistake.
        if (excludedAtBirth == address(0)) revert ZeroAddress();

        this.init(feeVault, timelock, keeper_, genesis, epochLength);

        isExcluded[excludedAtBirth] = true;
        _excludedEver.push(excludedAtBirth);
        _exclusionLog.push(ExclusionChange({account: excludedAtBirth, state: true, fromEpoch: 0}));

        address[] memory seeded = new address[](1);
        seeded[0] = excludedAtBirth;
        emit ExcludedSet(seeded, true, 0);
    }
}
