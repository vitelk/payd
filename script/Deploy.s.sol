// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice Full deployment.
///
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
///
///      Without --verify: the explorer is behind Cloudflare and 403s a scripted
///      request. Verify by hand, with --show-standard-json-input.
///
/// @dev Every external address below was read on-chain and dated in
///      docs/recon.md. None is assumed.
contract Deploy is Script {
    // --- Pons v2 (docs/recon.md §1.1)
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    // --- Uniswap (docs/recon.md §3)
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // --- Chainlink (docs/recon.md §5)
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// @dev 30 minutes in production. Overridable so a fork rehearsal can run a
    ///      whole cycle in seconds instead of half an hour — the keeper, the
    ///      seed delay and the publication path are identical either way, only
    ///      the clock changes. See docs/REHEARSAL.md.
    uint256 immutable EPOCH_LENGTH = vm.envOr("EPOCH_LENGTH_SECONDS", uint256(30 minutes));

    /// @dev The keeper publishes a root at the end of each epoch, and it takes
    ///      effect IMMEDIATELY. No bond, no challenge window.
    ///
    ///      What that costs exactly: a compromised keeper key can publish a root
    ///      that assigns itself `quoteAtRisk` — what has not yet been delivered.
    ///      Since deliveries run continuously, that is on the order of ONE
    ///      epoch, a few tens of dollars. Continuous pushing is what bounds the
    ///      blast radius.

    /// @dev The five deepest of the ten Payd shipped with, re-measured
    ///      2026-09-08 against live pools (`docs/allowlist.md`), equal weights.
    ///
    ///      Depth here is the USDG a pool absorbs before the price moves 1 %,
    ///      computed from the active liquidity at the current tick:
    ///
    ///          QQQ  1 659 834    NVDA 1 363 520    GLD  690 010
    ///          SPCX   602 806    TSLA   506 867
    ///
    ///      The five dropped — GME, AMZN, USO, GOOGL, AAPL — are all liquid
    ///      enough to buy; there is simply no room for ten in a basket of five.
    ///
    ///      Weights are 2 000 each. That used to carry a second argument — the
    ///      rotation wheel kept its "never twice in a row" promise only within
    ///      certain weights — and the argument died with the wheel: one
    ///      purchase now buys the whole basket, each line by its own weight
    ///      (§S41), and `allocationOf` was removed in 2026-09. Equal fifths are
    ///      now just equal fifths. `FeeVault.MIN_ALLOC_BPS` (1 000) still
    ///      refuses a dust leg; five at 2 000 sit well above it.
    ///
    ///      **This basket is a default, not a finding.** It is what the
    ///      measurement supports today; the timelock can reweight it, and a
    ///      registry creator picks their own five from the allowlist.
    function allocations() public pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](5);
        a[0] = VaultTypes.Allocation(
            0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 500, 2000, 0x41ed2c58611790af0760e31e80Bb427e4e83D603
        ); // QQQ
        a[1] = VaultTypes.Allocation(
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 500, 2000, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
        ); // NVDA
        // GLD carries no Chainlink feed -> TWAP-only floor, acceptable on a pool
        // this deep: depth protects better than a second price source (S20).
        a[2] = VaultTypes.Allocation(0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 3000, 2000, address(0)); // GLD
        a[3] = VaultTypes.Allocation(
            0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 500, 2000, 0x42a95341ff361e81fd934F39943c5C98F6991844
        ); // SPCX
        a[4] = VaultTypes.Allocation(
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 3000, 2000, 0x4A1166a659A55625345e9515b32adECea5547C38
        ); // TSLA
    }

    function run() external {
        address safe = vm.envAddress("SAFE_MULTISIG"); // timelock proposers AND the token deployer
        address dev = vm.envAddress("DEV_ADDRESS");
        address keeper = vm.envAddress("KEEPER_ADDRESS"); // hot key, holds nothing but gas

        vm.startBroadcast();

        // 1. Timelock. Proposers = the Safe. Executors = address(0): execution
        //    is open to anyone once the delay has elapsed, so nobody can hold a
        //    decision already made hostage.
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        Timelock timelock = new Timelock(proposers, executors);

        // 2. Distributor + FeeVault, in one transaction (see Bootstrap.sol for
        //    the circular dependency).
        VaultTypes.Config memory cfg = VaultTypes.Config({
            escrow: ESCROW,
            factory: PONS_FACTORY,
            router: ROUTER,
            v3Factory: V3_FACTORY,
            weth: WETH,
            pivot: USDG,
            ethPivotFee: 100,
            ethUsdFeed: ETH_USD,
            creator: dev,
            // $PLAT taxes nobody but itself: the platform share is zero on the
            // platform's own vault, and its whole residue is the dev share.
            platform: dev,
            platformBps: 0,
            rewardsBps: 8_511,
            timelock: address(timelock),
            distributor: address(0), // filled in by the Bootstrap
            deployer: safe,
            registry: address(0),
            intendedToken: address(0),
            quote: address(0),
            quoteFee: 0,
            quoteWethFee: 0,
            minBuy: 0
        });

        // The schedule starts at the next round hour: epoch bounds are then
        // human-readable, which matters for a mechanism third parties have to be
        // able to verify.
        uint256 genesis = ((block.timestamp / EPOCH_LENGTH) + 1) * EPOCH_LENGTH;

        // The two implementations, deployed ONCE. Every launch after this
        // clones them, which is what takes a launch from ~6.1 M gas to a few
        // hundred thousand (`PLAN.md` D5).
        address vaultImpl = address(new FeeVault());
        address distImpl = address(new Distributor());
        Bootstrap boot = new Bootstrap(vaultImpl, distImpl, cfg, allocations(), keeper, genesis, EPOCH_LENGTH);

        vm.stopBroadcast();

        console.log("TIMELOCK   ", address(timelock));
        console.log("DISTRIBUTOR", address(boot.DISTRIBUTOR()));
        console.log("FEE_VAULT  ", address(boot.VAULT()));
        // Printed because it has to be VERIFIED on the explorer like the other
        // three: it is the contract that deployed them, and an unverified link
        // in the provenance chain is exactly what a careful reader flags.
        // Digging it out of broadcast/ at launch time is how it gets skipped.
        console.log("BOOTSTRAP  ", address(boot));
        console.log("GENESIS    ", genesis);
        console.log("KEEPER     ", keeper);

        console.log("");
        console.log("Next step: launch the token on Pons v2 from the Safe,");
        console.log("with params.feeWallet = FEE_VAULT. See docs/LAUNCH_CHECKLIST.md.");
    }
}
