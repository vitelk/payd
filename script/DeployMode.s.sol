// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {ModeFactory} from "../contracts/modes/ModeFactory.sol";

/// @notice Deploys a second payout mode's factory, and prints the two
///         governance calls that admit it.
///
///   PAYD=0x… MODE=my-mode forge script script/DeployMode.s.sol --rpc-url $RPC_URL --broadcast
///
///      Without --verify: the explorer sits behind Cloudflare and 403s a
///      scripted request. Verify by hand, with --show-standard-json-input.
///
/// @dev **Deploying the factory admits nothing.** A factory nobody enabled
///      builds vaults that are in no registry: not `migrate` destinations, not
///      in the front's index, reachable by nobody. That is why this step is
///      permissionless and this script needs no privileged key.
///
///      What admits it takes TWO keys and cannot be scripted from one wallet,
///      so the calls are printed rather than sent:
///
///        1. `Payd.approve(factory, true)` — the generation Ledger, which is
///           kept apart from the Safe's signers. It approves and never
///           triggers: on its own it changes nothing;
///        2. `Payd.enableFactory(factory)` — the timelock. The Safe proposes,
///           anyone executes 48 h later.
///
///      **`enableFactory`, not `setFactory`.** `enableFactory` admits the mode
///      WITHOUT moving the default: `createVault` and every existing caller,
///      script and front page keep building exactly what they built yesterday,
///      and the new mode is reached through `createVaultWith(factory, …)`.
///      `setFactory` is for replacing the default with a new version of the
///      SAME mode. Reach for it only if that is what you mean.
///
///      Both are class (a) in `FLOWS.md` §6 — an admitted factory builds vaults
///      registered in `isVault`, hence valid `migrate` destinations — and
///      `FLOWS.md` is the file to update when this lands.
contract DeployMode is Script {
    function run() external returns (ModeFactory factory) {
        address payd = vm.envAddress("PAYD");
        // The mode's name, stamped into every vault this factory ever builds
        // and compared by `FeeVault.migrate` for ever. `ModeFactory`'s
        // constructor refuses zero and the old placeholder; what it cannot
        // refuse is a name another mode already uses, which is what the second
        // `require` below is for.
        bytes32 mode = bytes32(bytes(vm.envString("MODE")));

        vm.startBroadcast();
        factory = new ModeFactory(mode);
        vm.stopBroadcast();

        console.log("ModeFactory     ", address(factory));
        console.log("MODE            ", vm.toString(factory.MODE()));
        console.log("VAULT_IMPL      ", factory.VAULT_IMPL());

        // Fail here rather than after two keys and 48 h: `_enable` refuses a
        // zero mode, and a mode string already in use would silently make this
        // factory's vaults valid `migrate` destinations for another mode's.
        require(factory.MODE() != bytes32(0), "MODE is zero: Payd.enableFactory would revert BadMode");
        require(
            factory.MODE() != Payd(payd).factoryMode(address(Payd(payd).factory())),
            "MODE collides with the default factory's"
        );

        console.log("");
        console.log("1. generation Ledger -> Payd.approve");
        console.log("   to  ", payd);
        console.log("   data", vm.toString(abi.encodeCall(Payd.approve, (address(factory), true))));
        console.log("");
        console.log("2. Safe proposes -> Timelock -> Payd.enableFactory (48 h)");
        console.log("   to  ", payd);
        console.log("   data", vm.toString(abi.encodeCall(Payd.enableFactory, (address(factory)))));
        console.log("");
        console.log("Then launch under it with Payd.createVaultWith(", address(factory), ", ...)");
    }
}
