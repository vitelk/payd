// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {FeeVault} from "../contracts/distribution/FeeVault.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

interface IEpochLength {
    function EPOCH_LENGTH() external view returns (uint256);
}

/// @notice **Moving a LIVE vault to another payout mode, in six calls.** Reads
///         everything off the chain and prints the calldata for each; it
///         broadcasts nothing and holds no key.
///
///   PAYD=0x… VAULT=0x… forge script script/MigrateMode.s.sol \
///       --sig "plan(address)" <newModeFactory> --rpc-url $RPC_URL
///
///   …then, once step 3 has executed and produced the destination vault:
///
///   PAYD=0x… VAULT=0x… forge script script/MigrateMode.s.sol \
///       --sig "migrateCall(address)" <newVault> --rpc-url $RPC_URL
///
/// @dev  **Why two entrypoints and not one.** Step 5 names an address that does
///       not exist until step 3 has been executed, and step 3 names one that
///       does not exist until the factory is deployed. A single command
///       printing all six would have to invent two of them. So `plan` prints
///       what a deployed factory determines — steps 1, 2, 3, 4 and 6 — and
///       `migrateCall` prints step 5 against the vault that actually came out,
///       re-checking every precondition `FeeVault.migrate` will check.
///
///       **The basket is DERIVED, never retyped.** Step 3's destination must
///       carry the same lines as the source or the holders who declare nothing
///       stop being paid what they were: `plan` reads `getAllocations()` off
///       the live vault and encodes exactly that. A hand-typed basket is a
///       transcription error waiting for a 48-hour delay to make it expensive.
///
///       **Two keys, and the order matters.** `Payd.enableFactory` makes a mode
///       REACHABLE for new launches; it does nothing for an existing vault.
///       What lets a live vault cross modes is the generation key opening
///       `Payd.crossModeMigration`, and `FeeVault.migrate` reads that at
///       EXECUTION — so step 4 belongs just before step 5 executes, not before
///       it is proposed. The door is then open for minutes, not for 48 hours.
///       `FLOWS.md` §6 is the file to update when one of these lands.
///
///       **TWO delays in the whole procedure, not three, and steps 2 and 3 are
///       ONE timelock operation.** `createVaultFor` reads `factoryMode` at
///       execution, so step 3 needs step 2 to have EXECUTED before it — not to
///       have been proposed before it. `Timelock` is an OpenZeppelin 5.x
///       `TimelockController`, so `scheduleBatch` takes both calls as one
///       operation, ordered inside and atomic: one 48 h, and the ordering is
///       guaranteed rather than remembered by whoever clicks execute.
///
///           t=0     generation key: approve. It is read at EXECUTION, so it
///                   may even arrive during the wait.
///                   Safe proposes the BATCH [enableFactory, createVaultFor].
///           t=48h   execute the batch -> the destination vault exists, inert.
///                   Safe proposes migrate against the address it produced.
///           t=96h   generation key opens crossModeMigration, migrate
///                   executes, generation key shuts it again.
///
///       The second delay is irreducible: step 5 names the address step 3
///       produces, so it cannot be proposed any earlier. The FIRST one is the
///       one worth understanding, because its 48 h are not protecting the
///       vault it creates — that vault is born inert, bound to no token, not
///       yet Pons's `creatorFeeRecipient`, holding nothing, and NOTHING about
///       the live vault changes until step 5. The delay is the access control
///       on `createVaultFor`'s two arguments: an arbitrary `launcher` and a
///       chosen `platformBps`. Creating a vault is otherwise permissionless
///       (`createVaultWith`); what is not is choosing the rate it carries for
///       ever, and $PAYD needs zero. See the NOTE `plan` prints.
contract MigrateMode is Script {
    function _src() internal view returns (Payd payd, FeeVault src) {
        payd = Payd(vm.envAddress("PAYD"));
        src = FeeVault(payable(vm.envAddress("VAULT")));
        require(payd.isVault(address(src)), "VAULT is not in this registry");
        require(src.migratedTo() == address(0), "VAULT has already migrated: nothing to do");
        require(address(src.token()) != address(0), "VAULT is not bound to a token yet");
    }

    /// @notice Steps 1, 2, 3, 4 and 6 — everything a deployed factory settles.
    function plan(address factory) external view {
        (Payd payd, FeeVault src) = _src();
        bytes32 fromMode = payd.modeOf(address(src));

        console.log("source vault            ", address(src));
        console.log("  token                 ", address(src.token()));
        console.log("  mode                  ", vm.toString(fromMode));
        console.log("  launcher              ", src.LAUNCHER());
        console.log("  quote                 ", src.QUOTE());
        console.log("  rewardsBps            ", src.rewardsBps());
        console.log("  platformBps            ", src.PLATFORM_BPS());
        console.log("  epoch length          ", IEpochLength(src.DISTRIBUTOR()).EPOCH_LENGTH());
        console.log("");

        // The destination's split has to be no worse for the holders and no
        // better for the platform, and `PLATFORM_BPS` is stamped at birth and
        // never written again. On a vault exempted at 0 — the platform's own —
        // that means ONLY `createVaultFor` can build a legal destination:
        // `createVaultWith` stamps the registry's current rate, for good.
        uint256 platformBps = src.PLATFORM_BPS();
        if (platformBps < payd.platformBps()) {
            console.log("NOTE: this vault pays LESS platform than the registry's current rate");
            console.log("      (", platformBps, "against", payd.platformBps());
            console.log("      ). createVaultWith would stamp the higher rate FOR EVER and");
            console.log("      migrate would then revert BadSplit, permanently. Step 3 below");
            console.log("      is createVaultFor for that reason, and it is onlyTimelock.");
            console.log("");
        }

        VaultTypes.Allocation[] memory basket = src.getAllocations();
        uint256 sum;
        for (uint256 i; i < basket.length; ++i) {
            sum += basket[i].bps;
            (uint24 fee, address feed, bool allowed) = payd.listing(basket[i].stock);
            require(allowed, "a line of the source basket is no longer allowed: it cannot be carried over");
            require(fee == basket[i].poolFee && feed == basket[i].feed, "a line has been re-tiered or re-fed since");
        }
        require(sum == 10_000, "the source basket does not sum to BPS");
        console.log("basket carried over     ", basket.length, "line(s), read off the vault, sum 10000");
        console.log("");

        bytes32 toMode = payd.factoryMode(factory);
        console.log("destination factory     ", factory);
        console.log(
            "  MODE                  ",
            toMode == bytes32(0) ? "not enabled yet (step 2 does that)" : vm.toString(toMode)
        );
        console.log("");

        console.log("1. generation Ledger -> Payd.approve");
        console.log("   to  ", address(payd));
        console.log("   data", vm.toString(abi.encodeCall(Payd.approve, (factory, true))));
        console.log("");
        console.log("2+3. Safe proposes ONE Timelock batch: 48 h, ordered, atomic.");
        console.log("     scheduleBatch, not two operations. createVaultFor reads");
        console.log("     factoryMode at EXECUTION, so it needs enableFactory executed");
        console.log("     before it -- not proposed before it. One delay, and the order is");
        console.log("     guaranteed instead of remembered by whoever clicks execute.");
        console.log("");
        console.log("2. Payd.enableFactory");
        console.log("   to  ", address(payd));
        console.log("   data", vm.toString(abi.encodeCall(Payd.enableFactory, (factory))));
        console.log("");
        console.log("3. Payd.createVaultFor");
        console.log("   Builds the DESTINATION, INERT: bound to no token, not yet Pons's");
        console.log("   creatorFeeRecipient, holding nothing. Nothing about the live vault");
        console.log("   changes here. onlyTimelock not for the vault but for this call's two");
        console.log("   arguments: an arbitrary launcher, and a platformBps stamped for ever.");
        console.log("   to  ", address(payd));
        console.log(
            "   data",
            vm.toString(
                abi.encodeCall(
                    Payd.createVaultFor,
                    (
                        factory,
                        src.LAUNCHER(),
                        basket,
                        src.rewardsBps(),
                        IEpochLength(src.DISTRIBUTOR()).EPOCH_LENGTH(),
                        address(src.token()),
                        platformBps,
                        src.QUOTE(),
                        ""
                    )
                )
            )
        );
        console.log("");
        console.log("4. generation Ledger -> Payd.setCrossModeMigration(true)");
        console.log("   IMMEDIATE, nothing schedules. Send it just before step 5 EXECUTES,");
        console.log("   not before it is proposed: migrate reads this at execution.");
        console.log("   to  ", address(payd));
        console.log("   data", vm.toString(abi.encodeCall(Payd.setCrossModeMigration, (true))));
        console.log("");
        console.log("5. Safe proposes -> Timelock -> FeeVault.migrate (48 h)");
        console.log("   Needs the vault step 3 produced. Run:");
        console.log("     forge script script/MigrateMode.s.sol --sig \"migrateCall(address)\" <newVault>");
        console.log("");
        console.log("6. generation Ledger -> Payd.setCrossModeMigration(false)");
        console.log("   to  ", address(payd));
        console.log("   data", vm.toString(abi.encodeCall(Payd.setCrossModeMigration, (false))));
        console.log("");
        console.log("TWO delays in all, not three:");
        console.log("  t=0     approve (read at execution, may arrive during the wait)");
        console.log("          + propose the batch [2, 3]");
        console.log("  t=48h   execute the batch, then propose 5 against the new vault");
        console.log("  t=96h   open 4, execute 5, shut 6");
    }

    /// @notice Step 5, against the vault step 3 actually produced — and every
    ///         precondition `FeeVault.migrate` will check, checked here first.
    ///
    /// @dev    Checking now is the difference between a migration that does not
    ///         happen and one that reverts after 48 hours of waiting. The one
    ///         condition that cannot be checked ahead is `crossModeMigration`,
    ///         which is step 4's whole job and is meant to be shut right now.
    function migrateCall(address newVault) external view {
        (Payd payd, FeeVault src) = _src();
        FeeVault dst = FeeVault(payable(newVault));

        require(payd.isVault(newVault), "destination is not in this registry");
        require(dst.LAUNCHER() == src.LAUNCHER(), "different launcher: migrate reverts NotOurLaunch");
        require(dst.INTENDED_TOKEN() == address(src.token()), "destination is bound to another token");
        require(dst.rewardsBps() >= src.rewardsBps(), "destination pays holders LESS: reverts BadSplit");
        require(dst.PLATFORM_BPS() <= src.PLATFORM_BPS(), "destination takes MORE platform: reverts BadSplit");
        require(dst.QUOTE() == src.QUOTE(), "different quote: reverts BadQuote");
        require(dst.migratedTo() == address(0), "destination has itself migrated");

        bytes32 from = payd.modeOf(address(src));
        bytes32 to = payd.modeOf(newVault);
        console.log("source mode             ", vm.toString(from));
        console.log("destination mode        ", vm.toString(to));
        if (from != to) {
            console.log("");
            console.log("CROSS-MODE. migrate reverts NotOurMode unless crossModeMigration is");
            console.log("open AT EXECUTION. It is currently:", payd.crossModeMigration());
            console.log("Step 4 opens it, step 6 shuts it again.");
        }
        console.log("");
        console.log("5. Safe proposes -> Timelock -> FeeVault.migrate (48 h)");
        console.log("   to  ", address(src));
        console.log("   data", vm.toString(abi.encodeCall(FeeVault.migrate, (newVault))));
    }
}
