// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice $PAYD's basket and parameters — and a **superseded** `run()`.
///
/// @dev    ⚠️ **The deployment now lives in `DeployPayd`**, which imports this
///         file for its `allocations()`. The reason is an ordering one: the
///         vault has to be born BEFORE the Treasury, whose rewards pocket has
///         it as an immutable destination, and this script takes the Treasury
///         from the environment — hence after. The `run()` below stays usable
///         for a standalone vault, provided it is handed a Treasury that
///         already exists.
///
/// @notice $PAYD's vault, **without going through the timelock**.
///
///   TIMELOCK=0x… TREASURY=0x… REGISTRY=0x… SAFE_MULTISIG=0x… \
///     forge script script/DeployPaydVault.s.sol --rpc-url $RPC_URL --broadcast
///
/// @dev **Why not `Payd.createVaultFor`.** That function is `onlyTimelock`, and
///      `TimelockController` imposes 48 h from the very first operation — so it
///      does not allow launching the same evening. `Bootstrap` builds exactly
///      the same pair with no delay.
///
///      **What is lost, and that is all of it**: the vault is not in
///      `Payd.isVault`, so it does not appear in `vaults()` nor in the front
///      end's index. The registry keeps nothing else — verified: the only read
///      of the registry in the contracts is the DESTINATION check in
///      `FeeVault.migrate` (`recognised`, which queries `isVault` then the
///      successor chain), and an unregistered vault can still migrate TO a
///      registered one.
///
///      **What is not lost**: `platformBps = 0`, the Safe as `LAUNCHER`, and
///      `REGISTRY` wired to the real Payd so that `migrate` stays possible the
///      day V2 arrives.
///
///      Order matters: `platform` and `timelock` are checked non-zero at
///      `init`, so the Treasury and the Timelock must exist first.
contract DeployPaydVault is Script {
    // --- Pons v2 (docs/recon.md §1.1)
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    // --- Uniswap (docs/recon.md §3)
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // --- Chainlink (docs/recon.md §5)
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// @notice PLAN.md §8ter, superseded 2026-09-12. Kept equal to
    ///         `DeployPayd.PAYD_REWARDS_BPS`, which is the one that deploys —
    ///         two launch scripts disagreeing about the holders' share is the
    ///         failure this line exists to avoid. The reasoning lives there.
    uint256 constant REWARDS_BPS = 8_109;
    uint256 constant EPOCH_LENGTH = 30 minutes;

    /// @notice The starting basket: five of the deepest, **all with a live
    ///         Chainlink feed**, at equal weights.
    ///
    /// @dev    This is a DEFAULT, not a finding. The timelock reweights it
    ///         whenever it likes through `setAllocations`, and the choice below
    ///         keeps only tiers pinned in `script/Allowlist.s.sol` — the same
    ///         ones measured cheapest at the quoter.
    ///
    ///         `SGOV` is left out despite its depth: its feed goes stale beyond
    ///         `MAX_FEED_AGE` (measured 13 h on a trading day), so it would buy
    ///         on the TWAP floor alone.
    /// @notice $PAYD's basket: five stocks at 18 % and **$PONS at 10 %**.
    ///
    /// @dev    **Why $PONS is in our own basket, added 2026-09-10.** Every vault
    ///         this system builds is hosted by Pons: a $PAYD holder is paid a
    ///         slice of the launchpad the whole product stands on, alongside the
    ///         stocks. Holding it is the one form of support that costs nobody a
    ///         permission and that anyone can verify on-chain.
    ///
    ///         **10 %, not more, and 10 % is the floor** — `Deploy.t.sol`
    ///         refuses a leg under 1 000 bps, because a weight small enough to
    ///         round away at every purchase is a line the holders never really
    ///         receive. So the smallest deliberate slice IS 1 000, and this is
    ///         it. $PAYD stays what it says it is: a token that pays stocks,
    ///         with an ecosystem tilt rather than a bet on one.
    ///
    ///         The five stocks go 2 000 -> 1 800 each. Nothing else moves.
    ///
    ///         **Tier 10000, feed `address(0)`.** Both are measured, not chosen:
    ///         PONS/USDG at 0.3 % has no 30-minute window at all while the 1 %
    ///         pool has one AND is deeper AND is cheaper at the quoter
    ///         (`docs/allowlist.md`, 2026-09-10). No Chainlink feed exists for
    ///         it, so the floor is the TWAP alone — which over a weekend is the
    ///         better of the two anyway.
    function allocations() public pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](6);
        a[0] = VaultTypes.Allocation(
            0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 500, 1800, 0x41ed2c58611790af0760e31e80Bb427e4e83D603
        ); // QQQ
        a[1] = VaultTypes.Allocation(
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 500, 1800, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
        ); // NVDA
        a[2] = VaultTypes.Allocation(
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 3000, 1800, 0x4A1166a659A55625345e9515b32adECea5547C38
        ); // TSLA
        a[3] = VaultTypes.Allocation(
            0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 500, 1800, 0x42a95341ff361e81fd934F39943c5C98F6991844
        ); // SPCX
        a[4] = VaultTypes.Allocation(
            0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 500, 1800, 0x319724394D3A0e3669269846abE664Cd621f9f6A
        ); // SPY
        a[5] = VaultTypes.Allocation(
            0x39dBED3a2bd333467115dE45665cC57F813C4571, 10000, 1000, 0x0000000000000000000000000000000000000000
        ); // PONS  // TWAP-only floor
    }

    function run() external returns (FeeVault vault, Distributor distributor) {
        address safe = vm.envAddress("SAFE_MULTISIG");
        address timelock = vm.envAddress("TIMELOCK");
        address treasury = vm.envAddress("TREASURY");
        address registry = vm.envAddress("REGISTRY");
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        vm.startBroadcast();

        VaultTypes.Config memory cfg = VaultTypes.Config({
            escrow: ESCROW,
            factory: PONS_FACTORY,
            router: ROUTER,
            v3Factory: V3_FACTORY,
            weth: WETH,
            pivot: USDG,
            ethPivotFee: 100,
            ethUsdFeed: ETH_USD,
            // The residue — 0.50 % of volume — goes back to the Safe.
            creator: safe,
            // Never paid since the share is zero, but `init` refuses zero.
            platform: treasury,
            platformBps: 0,
            rewardsBps: REWARDS_BPS,
            timelock: timelock,
            distributor: address(0), // filled in by the Bootstrap
            // `bind` will require the Pons deployer to be THIS wallet.
            deployer: safe,
            // Wired so that `migrate` stays possible, even off-registry.
            registry: registry,
            intendedToken: address(0),
            quote: address(0),
            quoteFee: 0,
            quoteWethFee: 0,
            minBuy: 0
        });

        // Epoch bounds a third party can read, which matters for a mechanism
        // anybody has to be able to verify.
        uint256 genesis = ((block.timestamp / EPOCH_LENGTH) + 1) * EPOCH_LENGTH;

        Bootstrap boot = new Bootstrap(
            address(new FeeVault()), address(new Distributor()), cfg, allocations(), keeper, genesis, EPOCH_LENGTH
        );
        vault = boot.VAULT();
        distributor = boot.DISTRIBUTOR();

        vm.stopBroadcast();

        console.log("PAYD_VAULT ", address(vault));
        console.log("DISTRIBUTOR", address(distributor));
        console.log("BOOTSTRAP  ", address(boot));
        console.log("GENESIS    ", genesis);
        console.log("");
        console.log("Next step: the SAFE launches on Pons with");
        console.log("  creatorFeeRecipient = PAYD_VAULT");
        console.log("  creatorTaxBps       = 300");
        console.log("  pairToken           = 0x0  (native ETH, bind refuses the rest)");
        console.log("Then anyone calls vault.bind(token).");
    }
}
