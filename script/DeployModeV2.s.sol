// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {FeeVaultV2} from "../contracts/distribution/v2/FeeVaultV2.sol";
import {V2Legs} from "../contracts/distribution/v2/V2Legs.sol";
import {Distributor} from "../contracts/distribution/Distributor.sol";
import {DistributionFactoryV2} from "../contracts/distribution/v2/DistributionFactoryV2.sol";

/// @notice Deploys the distribution mode's V2 — three implementations, then
///         the factory that clones them — and prints the two governance calls
///         that admit it.
///
///   PAYD=0x… forge script script/DeployModeV2.s.sol --rpc-url $RPC_URL --broadcast
///
///      Without --verify: the explorer sits behind Cloudflare and 403s a
///      scripted request. Verify by hand, with --show-standard-json-input.
///
/// @dev **Deploying admits nothing** — same as `DeployMode.s.sol`, same two
///      keys to admit, and the same file to update when it lands (`FLOWS.md`
///      §6). Two differences, both deliberate:
///
///        - the implementations are deployed HERE and handed to the factory:
///          three embedded creation codes put the factory's initcode over the
///          EIP-3860 cap, so it takes addresses instead of `new`ing;
///        - `MODE` collides with the default factory's ON PURPOSE. This is a
///          new version of the SAME mode — `FeeVault.migrate` compares names,
///          and the collision is the entire upgrade path: it is what lets the
///          $PAYD vault migrate into a V2 vault under timelock alone.
///
///      **`enableFactory`, never `setFactory`.** The default stays V1: the
///      default is the choice made for creators who did not choose (decision
///      of 2026-09-11). V2 is reached through `createVaultWith(factory, …)`
///      with `modeData = abi.encode(burnBps, lpBps)` — or empty for a vault
///      that behaves exactly like a V1.
contract DeployModeV2 is Script {
    /// @dev The canonical Uniswap v4 PoolManager, `docs/recon.md` §3.2 — the
    ///      singleton every graduated Pons pool lives in, and what the legs
    ///      trade on.
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external returns (DistributionFactoryV2 factory) {
        address payd = vm.envAddress("PAYD");

        vm.startBroadcast();
        address vaultImpl = address(new FeeVaultV2());
        address distImpl = address(new Distributor());
        address legsImpl = address(new V2Legs());
        factory = new DistributionFactoryV2(vaultImpl, distImpl, legsImpl, POOL_MANAGER);
        vm.stopBroadcast();

        console.log("FeeVaultV2 impl ", vaultImpl);
        console.log("Distributor impl", distImpl);
        console.log("V2Legs impl     ", legsImpl);
        console.log("FactoryV2       ", address(factory));
        console.log("MODE            ", vm.toString(factory.MODE()));

        // The one check that must NOT mirror `DeployMode.s.sol`: there the
        // mode name colliding with the default's is the mistake; here it is
        // the point. Fail if it ever stops matching.
        require(
            factory.MODE() == Payd(payd).factoryMode(address(Payd(payd).factory())),
            "MODE must equal the default factory's: V2 is a new version of the SAME mode"
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
        console.log("modeData: abi.encode(burnBps, lpBps) - or empty for a plain V1-like vault");
    }
}
