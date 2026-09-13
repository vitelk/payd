// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {DeployPaydVault} from "../script/DeployPaydVault.s.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice **Launch night, played in full — without a single delay.**
///
/// @dev    The chosen plan: $PAYD's vault is built by `Bootstrap` and not by
///         `Payd.createVaultFor`, which is `onlyTimelock` and would cost 48 h.
///         Everything else is identical.
///
///         This test exists to prove the ORDER, which is not free — and it
///         changed. The vault is now born BEFORE the Treasury, whose rewards
///         pocket has it as its immutable destination. The two addresses it
///         would need (`platform`, `registry`) do not exist yet, and it does
///         without them: the first because a vault with `platformBps = 0` never
///         pays anything, the second because the timelock names it afterwards.
///         This is word for word what `script/DeployPayd.s.sol` does.
contract LaunchTonightTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// @dev The second authority -- `Payd.setFactory`, `Treasury.bindPlatform`,
    ///      `Treasury.migrateTreasury`. It approves, it never triggers. A
    ///      separate address, because on the same key as the Safe it would close
    ///      nothing.
    address generationKey = makeAddr("generation key");
    DistributionFactory factory = new DistributionFactory();
    address safe = makeAddr("the Payd safe");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");

    /// @dev The seed that allows exactly $PAYD's basket. The registry mints its
    ///      first vault in its constructor, so the lists have to be written
    ///      before -- which they are, in the same constructor, a few lines
    ///      earlier.
    function _seedFor(VaultTypes.Allocation[] memory a) internal pure returns (Payd.Seed memory) {
        address[] memory stocks = new address[](a.length);
        uint24[] memory fees = new uint24[](a.length);
        address[] memory feeds = new address[](a.length);
        for (uint256 i; i < a.length; ++i) {
            stocks[i] = a[i].stock;
            fees[i] = a[i].poolFee;
            feeds[i] = a[i].feed;
        }
        return Payd.Seed(stocks, fees, feeds, new address[](0), new uint24[](0), new uint24[](0), new uint256[](0));
    }

    function _emptySeed() internal pure returns (Payd.Seed memory) {
        return Payd.Seed(
            new address[](0),
            new uint24[](0),
            new address[](0),
            new address[](0),
            new uint24[](0),
            new uint24[](0),
            new uint256[](0)
        );
    }

    function test_TheWholeEveningWithoutASingleDelay() public {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        if (!f.launchEnabled()) {
            console.log("SKIPPED: Pons has closed launches");
            return;
        }

        // --- 1. the timelock, then the predictions --------------------------
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        Timelock timelock = new Timelock(proposers, executors);

        DeployPaydVault script_ = new DeployPaydVault();

        // --- 2. the factory, the Treasury, then the registry ----------------
        //
        // **The order is not free, and it is the whole subject of this test.**
        // Three immutable addresses stood in a circle: the registry points at
        // the Treasury, the Treasury at the platform vault, and the vault at its
        // registry. A cycle of three does not deploy in one stroke, and
        // predicting it from a script does not work -- the creator of the `new`s
        // there is the script contract in simulation and the EOA at broadcast.
        //
        // The cycle is cut by having the vault born INSIDE the registry's
        // constructor: `address(this)` is known there, so the vault knows its
        // registry from birth like all the others. All that is left for the
        // Treasury is to be named afterwards, under two keys -- and that waits
        // on nothing, since it is empty at genesis.
        DistributionFactory f2 = new DistributionFactory();
        Treasury treasury = new Treasury(
            Treasury.Wiring({
                timelock: address(timelock),
                devWallet: dev,
                generationKey: generationKey,
                predecessor: address(0),
                ponsFactory: FACTORY,
                poolManager: POOL_MANAGER,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                pivotWethFee: 100
            }),
            Treasury.Seed(new address[](0), new uint24[](0), new uint24[](0))
        );
        Payd pad = new Payd(
            Payd.Wiring({
                timelock: address(timelock),
                platform: address(treasury),
                keeper: keeper,
                coSigner: address(0),
                escrow: ESCROW,
                ponsFactory: FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                generationKey: generationKey,
                factory: address(f2)
            }),
            1_000,
            _seedFor(script_.allocations()),
            Payd.Genesis({launcher: safe, rewardsBps: 8_109, epochLength: 30 minutes, basket: script_.allocations()})
        );

        FeeVault vault = FeeVault(payable(pad.platformVault()));
        assertEq(vault.PLATFORM_BPS(), 0, "$PAYD does not tax itself");
        assertEq(vault.LAUNCHER(), safe, "the Safe is the one that has to launch");
        assertEq(vault.rewardsBps(), 8_109, "the holders' share asked for");
        // **Compared against the source, not against a number.** This said
        // `5` until 2026-09-10 and went red the day $PONS joined the basket --
        // a count belonging to `DeployPaydVault` that had been copied here.
        // What this test actually means is "the genesis basket reaches the
        // vault intact", so it asks the script rather than remembering it.
        VaultTypes.Allocation[] memory want = script_.allocations();
        VaultTypes.Allocation[] memory got = vault.getAllocations();
        assertEq(got.length, want.length, "the basket lost or gained a line on the way in");
        for (uint256 i; i < want.length; ++i) {
            assertEq(got[i].stock, want[i].stock, "a basket line changed stock");
            assertEq(got[i].bps, want[i].bps, "a basket line changed weight");
        }
        assertEq(vault.PLATFORM(), address(treasury), "and it knows the Treasury");

        // **It is IN the registry**, which the old `Bootstrap` arrangement did
        // not allow: it appears in `vaults()`, in the front end's index, and
        // `migrate` recognises it through `isVault` alone -- without ever having
        // to name a successor.
        assertEq(vault.REGISTRY(), address(pad), "the vault knows its registry from birth");
        assertTrue(pad.isVault(address(vault)), "and the registry knows it");
        assertEq(pad.vaults().length, 1, "it is the first, and it is indexed");

        // The Treasury, meanwhile, waits for its two keys. No hurry: it is empty.
        assertEq(address(treasury.platformVault()), address(0), "nothing is wired until both keys have spoken");

        // --- 3. the Safe launches on Pons -----------------------------------
        uint256 fee = f.launchFee();
        vm.deal(safe, fee + 10 ether);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "Payd",
            symbol: "PAYD",
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "https://paydprotocol.eth.limo", ""),
            creatorFeeRecipient: address(vault),
            creatorTaxBps: 300,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: bytes32(uint256(0x9))
        });
        vm.prank(safe);
        (address token,) = f.launchToken{value: fee}(p, 0, address(0));

        // --- 4. anyone binds ------------------------------------------------
        vm.prank(makeAddr("a passer-by"));
        vault.bind(token);
        (FeeVault.Hook status,,) = vault.hookStatus();
        assertEq(uint8(status), uint8(FeeVault.Hook.Hooked), "the fees really do arrive here");

        // --- 5. and the numbers the parameters were chosen for ---------------
        (,,, uint256 gross, uint256 rewards, uint256 creator, uint256 platform) = vault.economics();
        console.log("gross bps      ", gross);
        console.log("  holders      ", rewards);
        console.log("  creator      ", creator);
        console.log("  platform     ", platform);
        assertEq(gross, 370, "3.70 % reaches the vault");
        assertEq(rewards, 300, "3.00 % to holders");
        assertEq(creator, 70, "0.70 % to the creator");
        assertEq(platform, 0, "nothing to the platform");

        // --- what is given up, asserted so it is a choice and not an oversight
        assertEq(vault.REGISTRY(), address(pad), "and migrate stays possible");
    }
}
