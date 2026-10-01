// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {FeeVaultV2} from "../contracts/distribution/v2/FeeVaultV2.sol";
import {V2Legs} from "../contracts/distribution/v2/V2Legs.sol";
import {DistributorV3} from "../contracts/distribution/v3/DistributorV3.sol";
import {DistributionFactoryV3} from "../contracts/distribution/v3/DistributionFactoryV3.sol";

/// @notice Deploys the distribution mode's V3 — V2's vault and legs
///         implementations plus `DistributorV3`, then the factory that clones
///         them — and prints the two governance calls that admit it.
///
///   PAYD=0x… forge script script/DeployModeV3.s.sol --rpc-url $RPC_URL --broadcast
///
///      Without --verify: the explorer sits behind Cloudflare and 403s a
///      scripted request. Verify by hand, with --show-standard-json-input.
///
/// @dev **Deploying admits nothing** — same as `DeployModeV2.s.sol`, same two
///      keys to admit, and the same file to update when it lands (`FLOWS.md`
///      §6). What V3 changes is one thing: every Distributor it builds is
///      born with the Pons locker in its dated exclusion log at epoch 0, so
///      the per-vault `setExcluded` schedule/execute pair — and the window it
///      left open — are gone. The locker address is a constructor argument,
///      readable before either key signs, taken from `docs/recon.md` §1.1.
contract DeployModeV3 is Script {
    /// @dev The canonical Uniswap v4 PoolManager, `docs/recon.md` §3.2 — the
    ///      singleton every graduated Pons pool lives in, and what the legs
    ///      trade on.
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev `PonsV2LaunchFactory.locker()`, `docs/recon.md` §1.1 — verified
    ///      2026-09-15 holding 8.16 % of BERRY's graduated supply, with no
    ///      claim path. If Pons rotates lockers, the new one is a new factory.
    address constant PONS_LOCKER = 0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952;

    function run() external returns (DistributionFactoryV3 factory) {
        address payd = vm.envAddress("PAYD");

        vm.startBroadcast();
        address vaultImpl = address(new FeeVaultV2());
        address distImpl = address(new DistributorV3());
        address legsImpl = address(new V2Legs());
        factory = new DistributionFactoryV3(vaultImpl, distImpl, legsImpl, POOL_MANAGER, PONS_LOCKER);
        vm.stopBroadcast();

        console.log("FeeVaultV2 impl   ", vaultImpl);
        console.log("DistributorV3 impl", distImpl);
        console.log("V2Legs impl       ", legsImpl);
        console.log("FactoryV3         ", address(factory));
        console.log("MODE              ", vm.toString(factory.MODE()));
        console.log("EXCLUDED_AT_BIRTH ", factory.EXCLUDED_AT_BIRTH());

        // Same check as V2's script, same reason: the mode name colliding
        // with the default's is the entire upgrade path. Fail if it ever
        // stops matching.
        require(
            factory.MODE() == Payd(payd).factoryMode(address(Payd(payd).factory())),
            "MODE must equal the default factory's: V3 is a new version of the SAME mode"
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
