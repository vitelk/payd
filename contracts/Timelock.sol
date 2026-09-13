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

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title  Timelock
/// @notice The only holder of power in the system. **The list lives in
///         `FLOWS.md` §6, not here** — this comment claimed five functions and
///         named only the two contracts its author had open at the time,
///         leaving out everything the `Treasury` and the `Payd` added
///         later. A power list that drifts is worse than no list: it is the
///         first thing a reader trusts and the last thing anyone updates.
///
///         What holds regardless of the list, and is worth stating here:
///
///           - **it cannot withdraw a single wei to an address it chooses.**
///             No function of any contract takes a destination and sends value
///             to it; every destination is either immutable or is the caller
///             themselves recovering a payment that had failed;
///           - two of its powers DO move value — `Treasury.setSplit`, bounded
///             by a ratchet the dev share can only fall through, and
///             `FeeVault.migrate`, which redirects a vault's future stream and
///             carries its unspent reserve to a destination the registry
///             already knows. Both are named as such in `FLOWS.md` §7 rather
///             than dressed up as verifications. This line used to name
///             `Payd.setSuccessor` alongside `migrate`; that function was
///             deleted with the `Payd` / `DistributionFactory` split (`ARCHITECTURE.md`
///             §S45), and `migrate` no longer walks a chain of registries — it
///             asks OUR registry about the destination and nothing else;
///           - every one of them costs a full delay and emits `CallScheduled`
///             when proposed.
///
/// @dev    OpenZeppelin 5.x `TimelockController`, deployed WITHOUT the optional
///         admin (`admin = address(0)`): it is self-administered from
///         construction, so no key exists that could shorten the delay or grant
///         itself a role after the fact.
///
///         `proposers` is the Safe multisig. Passing `address(0)` as the sole
///         executor makes execution OPEN TO ANYONE: the multisig decides, but
///         anybody executes once the delay has elapsed — nobody can hold a
///         decision hostage by simply staying silent.
///
///         Note that OpenZeppelin also grants CANCELLER_ROLE to proposers. The
///         Safe can therefore still cancel a pending operation: opening
///         execution removes its ability to WITHHOLD a change, not its ability
///         to STOP one.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract Timelock is TimelockController {
    /// @notice 48 h, per docs/CONVENTIONS.md. This is the INITIAL delay, not a permanent
    ///         one — an earlier version of this comment called it immutable and
    ///         that was wrong. `TimelockController` keeps the live value in a
    ///         private `_minDelay` and exposes `updateDelay`, callable only by
    ///         the timelock itself: the proposers can therefore schedule
    ///         `updateDelay(x)`, wait out the current 48 h, and change it. The
    ///         same route reaches `grantRole`, since the constructor grants
    ///         `DEFAULT_ADMIN_ROLE` to `address(this)`.
    ///
    ///         What IS fixed here is that no account outside the timelock ever
    ///         holds that admin role: the fourth constructor argument below is
    ///         hard-coded `address(0)`, so every change costs one full delay
    ///         and emits `CallScheduled` when proposed.
    uint256 public constant MIN_DELAY = 48 hours;

    constructor(address[] memory proposers, address[] memory executors)
        TimelockController(MIN_DELAY, proposers, executors, address(0))
    {}
}
