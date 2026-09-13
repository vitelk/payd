// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseModeVault} from "./BaseModeVault.sol";
import {FeeVault} from "../FeeVault.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  ModeVault — a payout mode with no payout
///
/// @notice Copy this file, rename it, and fill in the one function. Everything
///         else — the Pons claim, the three-way split, the refunds, `migrate`,
///         `withdraw` — is inherited and should not be touched.
///
/// @dev    It compiles and it deploys as it stands. What it does: harvests,
///         splits, pays the creator and the platform, and lets `rewardsPool`
///         accumulate for ever. That is deliberate — the reserve is never
///         stranded (`migrate` carries it, `fundRewards` re-credits strays),
///         so an unfinished mode holds holders' money without losing it.
contract ModeVault is BaseModeVault {
    /// @notice What this mode does with the holders' share.
    ///
    /// @dev    **This is the entire second mode.** `rewardsPool` is yours;
    ///         `creatorPool`, `platformPool` and `pendingTotal` are not, and on
    ///         a pivot-quoted vault `pivotReserve` shares the same balance —
    ///         see `fundRewards` for how the base keeps those apart.
    ///
    ///         Rules the platform holds you to, none of them enforced by code
    ///         outside this contract:
    ///           - permissionless, and it refunds its own gas on an ETH vault
    ///             (`_refundAmount`, capped at `MAX_REFUND`);
    ///           - `nonReentrant` and CEI — debit `rewardsPool` before the
    ///             external call, never after;
    ///           - every swap gets a `minOut` from an oracle. Never `minOut = 0`;
    ///           - a leg that cannot execute is SKIPPED, never reverted: one
    ///             paused stock must not take the whole payout down;
    ///           - no unbounded loop over holders. Cap the batch.
    ///
    ///         Delete this function if your mode's entrypoint has another
    ///         shape. Nothing in the base calls it.
    function payout() external nonReentrant {
        revert NothingToDo(); // TODO
    }

    /// @notice Your mode's slice of `init`, if it needs one.
    ///
    /// @dev    `basket` is whatever the caller passed, possibly empty — the
    ///         registry no longer requires one. If it is non-empty, `Payd` has
    ///         already checked every entry against the stock allowlist.
    ///
    ///         `modeData` is your per-launch parameter, straight from
    ///         `Payd.createVaultWith` and untouched by it. Decode it here:
    ///
    ///             (address payoutToken, uint256 threshold) =
    ///                 abi.decode(modeData, (address, uint256));
    ///
    ///         This template expects none, and says so rather than ignoring one.
    function _initMode(VaultTypes.Allocation[] memory basket, bytes memory modeData) internal override {
        if (modeData.length != 0) revert UnexpectedModeData();
    }
}
