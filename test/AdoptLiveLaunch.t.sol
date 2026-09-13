// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice **An already-launched token joins the registry, without relaunching.**
///
/// @dev    A creator does not have to launch through us to use us. If their Pons
///         `deployer` and their current `creatorFeeRecipient` are the same
///         address — which is how a launch starts out — that address can create
///         a vault (becoming its `LAUNCHER`) and, as the current recipient,
///         point the stream at it. `bind` then finds both of its conditions
///         satisfied by one party, and anybody may call it.
///
///         **The fixture is a THIRD PARTY's live launch, and that is the
///         point** — twice over. It proves the path works for a creator who
///         owes us nothing, and it keeps this public file from naming the
///         address that deployed our own launch: `getLaunchedToken` returns the
///         deployer, and `getOwners()` turns one address into a list of
///         signers. The test needs the SHAPE of a launch, never whose it is.
///
///         The premise is read on-chain and asserted, so a fixture that drifts
///         fails loudly instead of testing a world that no longer exists. If it
///         does, pick another launch off the factory's logs — topic
///         `0x8d4aad49…`, the one `front/src/launchlog.ts` already knows —
///         where `deployer == creatorFeeRecipient` and `pairToken == 0`.
contract AdoptLiveLaunchTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;

    /// @dev A live, ungraduated, ETH-quoted Pons launch belonging to somebody
    ///      else. Everything about it is read on-chain, never assumed.
    address constant LIVE = 0xf15667A02960c5d31e6e23aA1701833f4e4487f2;

    Payd pad;
    /// @dev The second authority -- `Payd.setFactory`, `Treasury.bindPlatform`,
    ///      `Treasury.migrateTreasury`. It approves, it never triggers. A
    ///      separate address, because on the same key as the Safe it would close
    ///      nothing.
    address generationKey = makeAddr("generation key");
    DistributionFactory factory = new DistributionFactory();
    address timelock = makeAddr("timelock");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");

    function setUp() public {
        pad = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: treasury,
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
                factory: address(factory)
            }),
            1_000,
            Payd.Seed(
                new address[](0),
                new uint24[](0),
                new address[](0),
                new address[](0),
                new uint24[](0),
                new uint24[](0),
                new uint256[](0)
            ),
            Payd.Genesis(address(0), 0, 0, new VaultTypes.Allocation[](0))
        );

        address[] memory s = new address[](2);
        uint24[] memory f = new uint24[](2);
        address[] memory d = new address[](2);
        (s[0], f[0], d[0]) = (NVDA, 500, address(0));
        (s[1], f[1], d[1]) = (QQQ, 500, address(0));
        vm.prank(timelock);
        pad.allowStocks(s, f, d);
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
    }

    function test_ALiveLaunchCanJoinTheRegistryWithoutRelaunching() public {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(LIVE);

        // The premise, read rather than assumed. If Pons or the launcher ever moves
        // the recipient, this fixture must fail LOUDLY instead of testing a
        // world that no longer exists.
        assertTrue(l.exists, "the fixture must still be a live Pons launch");
        assertEq(l.pairToken, address(0), "and quoted in native ETH");
        address launcher = l.deployer;
        assertEq(l.creatorFeeRecipient, launcher, "the premise: deployer AND current recipient are the same address");
        console.log("the launcher    ", launcher);

        // --- 1. The launcher creates the vault, naming the token as the only one it
        //        may ever bind to. Anything else and this vault is inert.
        vm.prank(launcher);
        (address vault,) = pad.createVault(_basket(), 7_000, 30 minutes, LIVE);
        assertEq(FeeVault(payable(vault)).LAUNCHER(), launcher, "the creator is the launcher");

        // --- 2. `bind` cannot work yet: the stream still points at the launcher.
        //        Worth asserting — it is the state a creator sits in between two
        //        multisig transactions, and it must be a clean refusal.
        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        FeeVault(payable(vault)).bind(LIVE);

        // --- 3. The launcher, as the CURRENT recipient, points the stream at the
        //        vault. Immediate, in this transaction (`recon.md` §1.2).
        vm.prank(launcher);
        (bool ok,) = FACTORY.call(abi.encodeWithSelector(0x2931861b, LIVE, vault));
        assertTrue(ok, "the current recipient may hand the stream over");

        // --- 4. Now anyone binds. Not the launcher: neither condition is the
        //        caller's, and that is the whole design.
        vm.prank(makeAddr("a passer-by"));
        FeeVault(payable(vault)).bind(LIVE);

        assertEq(address(FeeVault(payable(vault)).token()), LIVE, "the vault carries the token");
        (FeeVault.Hook status, address current,) = FeeVault(payable(vault)).hookStatus();
        assertEq(uint8(status), uint8(FeeVault.Hook.Hooked), "and the fees now arrive here");
        assertEq(current, vault, "with Pons agreeing");
    }
}
