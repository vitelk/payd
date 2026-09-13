// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDistributor} from "./interfaces/IExternal.sol";

/// @title  Collector
/// @notice Settles several launches in ONE transaction.
///
/// @dev    **Why it has to exist.** `claim` settles from `msg.sender`, so it can
///         only ever reach one vault. `distribute` takes the beneficiary as an
///         argument and is callable by anyone — but every launch has its OWN
///         `Distributor`, so collecting from five launches is five calls. This
///         contract makes it one.
///
///         **It is a router, and it holds nothing.** That is the whole security
///         argument, and it rests on two facts read in `Distributor`:
///
///         1. `distribute(account, …)` sends the stock to `account` **directly**
///            — the tokens never touch this contract, not even in transit;
///         2. `_refund` pays `msg.sender`, which here is this contract. That ETH
///            is the only value that ever sits here, and it is forwarded to the
///            caller before the call returns.
///
///         **No allowlist, deliberately, and the reason changed under it.**
///         This comment used to argue that restricting the targets to
///         `Payd.isVault` would lock out the platform's own token, $PAYD's vault
///         being deployed by `Bootstrap` outside the registry. **That is no
///         longer true**: the registry builds $PAYD's vault in its own
///         constructor and writes `isVault` for it, so an allowlist would let it
///         through today (`test/LaunchTonight.t.sol`).
///
///         The decision stands on the argument that never depended on it: an
///         allowlist would buy nothing. A hostile address passed in as a
///         "distributor" cannot take anything, because there is nothing here to
///         take — the stock goes straight to `account`, and the only ETH that
///         ever sits here is the refund, forwarded before the call returns. The
///         worst it can do is waste the caller's own gas. A check that costs gas
///         on every collect and removes no capability is not a safeguard, it is
///         a toll.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract Collector {
    error LengthMismatch();
    error NothingCollected();

    /// @param account who the stock went to — not necessarily the caller.
    /// @param settled how many of the launches actually delivered.
    /// @param refund  the gas the launches paid back, forwarded to the caller.
    event Collected(address indexed account, address indexed caller, uint256 settled, uint256 refund);

    uint256 private _lock = 1;

    /// @dev A hostile contract passed as a `distributor` gets called by this
    ///      one, so it could try to re-enter. It would find nothing — but the
    ///      guard costs one slot and removes the question entirely.
    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Settles `account`'s share on every listed launch.
    ///
    /// @dev    **A launch that reverts is skipped, not fatal.** One paused
    ///         stock, one stale proof or one launch with nothing owed must not
    ///         cost the caller the other four. Same rule as a leg that cannot
    ///         be bought inside a basket — the rest goes through.
    ///
    ///         The arrays are parallel and per-launch, which is why they nest:
    ///         one launch owns one list of stocks, one list of cumulatives and
    ///         one list of proofs.
    function collect(
        address account,
        address[] calldata distributors,
        address[][] calldata stocks,
        uint256[][] calldata cumulative,
        bytes32[][][] calldata proofs
    ) external nonReentrant returns (uint256 settled) {
        uint256 n = distributors.length;
        if (stocks.length != n || cumulative.length != n || proofs.length != n) revert LengthMismatch();

        // Measured, not assumed: only what THIS call brought in is forwarded.
        // Dust left by an earlier caller stays where it is rather than becoming
        // a prize for whoever calls next.
        uint256 before = address(this).balance;

        for (uint256 i; i < n; ++i) {
            try IDistributor(distributors[i]).distribute(account, stocks[i], cumulative[i], proofs[i]) returns (
                uint256 delivered
            ) {
                if (delivered != 0) ++settled;
            } catch {
                // Skipped on purpose. See the note above.
            }
        }
        if (settled == 0) revert NothingCollected();

        uint256 refund = address(this).balance - before;
        emit Collected(account, msg.sender, settled, refund);

        // Last, and after the event: nothing below depends on it, and the
        // caller is the only address that can be paid here.
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            // A caller that refuses its own refund does not undo five
            // deliveries. The ETH stays for the next call rather than
            // reverting settled work.
            ok;
        }
    }

    /// @dev **Deliberately empty, and that matters.** `Distributor._pay`
    ///      forwards exactly 30 000 gas and, on failure, books the refund as
    ///      `pendingWithdrawal` inside the Distributor instead. A `receive`
    ///      that wrote storage would push every refund into that deferred
    ///      state, where only this contract could ever claim it back.
    receive() external payable {}
}
