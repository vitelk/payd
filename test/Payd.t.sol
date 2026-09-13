// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {IPayd} from "../contracts/interfaces/IExternal.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";

/// @notice A factory of ANOTHER payout mode, as far as the registry can tell.
///
/// @dev    It builds the same pair as `DistributionFactory` — writing a second payout
///         contract to test the registry's plumbing would be testing the wrong
///         thing. What matters here is the only thing `Payd` reads off a
///         factory: `MODE`. Everything downstream — `modeOf`, `createVaultWith`,
///         the refusal in `FeeVault.migrate` — keys off this one word.
/// @dev A platform that answers the sweep list, so the registry's new guard is
///      exercised against OUR code at the address the registry genuinely holds
///      — `vm.etch`, not a mocked call.
contract SweepStub {
    uint24 public direct;
    uint24 public viaPivot;

    function sweepFee(address) external view returns (uint24) {
        return direct;
    }

    function sweepPivotFee(address) external view returns (uint24) {
        return viaPivot;
    }

    function set(uint24 d, uint24 p) external {
        direct = d;
        viaPivot = p;
    }
}

/// @dev A Distributor that refuses to be rotated, so the skip path is exercised
///      against a real registry entry rather than a mocked one.
contract RefusingDistributor {
    fallback() external payable {
        revert("no");
    }
}

contract OtherModeFactory {
    bytes32 public constant MODE = "lottery";

    DistributionFactory public immutable INNER = new DistributionFactory();

    function create(
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory basket,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor) {
        return INNER.create(cfg, basket, keeper, genesis, epochLength, modeData);
    }
}

/// @notice A mode that bounds nothing and keeps what it was handed.
///
/// @dev    It exists to show what the registry does NOT do. It declares a mode,
///         accepts any `epochLength`, accepts any `basket` including none, and
///         records `modeData` verbatim. `Payd` registers what it returns without
///         looking at it — which is the property under test, not a weakness:
///         admitting a factory is what takes two keys.
contract FreeModeFactory {
    bytes32 public constant MODE = "free";

    bytes public lastModeData;
    uint256 public lastEpochLength;
    uint256 public lastBasketLength;

    function create(
        VaultTypes.Config memory,
        VaultTypes.Allocation[] memory basket,
        address,
        uint256,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor) {
        lastModeData = modeData;
        lastEpochLength = epochLength;
        lastBasketLength = basket.length;
        vault = address(new StubVault());
        distributor = vault;
    }
}

contract StubVault {}

/// @dev The two reads `_depthUsd` needs, and the two `Payd._requirePool` makes.
///      Declared here rather than imported so this file keeps its own vocabulary.
interface IV3PoolDepth {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
}

interface IV3FactoryPool {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice A factory that declares nothing. Refused at the door.
contract MuteFactory {
    bytes32 public constant MODE = bytes32(0);
}

/// @notice Fork tests against the real state of Robinhood Chain (chainId 4663).
/// @dev    No mock on Pons nor on Uniswap: the addresses below were read
///         on-chain and dated in `docs/recon.md` §1.1 and §3.1, and the stocks
///         come from the measurement in `docs/allowlist.md`.
contract PaydTest is Test {
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    // The three deepest of the measured basket (docs/allowlist.md).
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e; // no feed, by design

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
    address creator = makeAddr("creator");

    function setUp() public {
        pad = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: treasury,
                keeper: keeper,
                coSigner: address(0),
                escrow: ESCROW,
                ponsFactory: PONS_FACTORY,
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
        _allow();
    }

    function _allow() internal {
        _allowOn(pad);
    }

    function _allowOn(Payd p) internal {
        address[] memory s = new address[](3);
        uint24[] memory f = new uint24[](3);
        address[] memory d = new address[](3);
        s[0] = QQQ;
        f[0] = 500;
        d[0] = QQQ_FEED;
        s[1] = NVDA;
        f[1] = 500;
        d[1] = NVDA_FEED;
        s[2] = GLD;
        f[2] = 3000;
        d[2] = address(0);
        vm.prank(timelock);
        p.allowStocks(s, f, d);
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);
        a[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
    }

    /// @notice **A new version of the vault code does not change registry**,
    ///         and that is what made it possible to delete the successor chain.
    ///
    /// @dev    What used to be here: `VAULT_IMPL` lived in this contract, as an
    ///         `immutable`. A new implementation therefore forced a new registry,
    ///         hence a new `isVault`, hence a bridge between the two —
    ///         `setSuccessor` and `recognised`. That bridge was the system's
    ///         largest residual hole: `setSuccessor` accepted any address, and
    ///         five lines answering `isVault(x) = true` opened `migrate` onto
    ///         anything, hence the future stream AND the reserve of any vault.
    ///
    ///         The implementations now live in `DistributionFactory`. A new version is a
    ///         new factory, its vaults are born **here**, and `migrate`
    ///         recognises them through `isVault` alone — written by `_create` and
    ///         by nothing else.
    function test_ANewVaultCodeStaysInTheSameRegistry() public {
        _allow();
        DistributionFactory v2 = new DistributionFactory();
        assertTrue(v2.VAULT_IMPL() != factory.VAULT_IMPL(), "a new factory, new code");

        // A vault of the CURRENT version, born before the upgrade.
        vm.prank(creator);
        (address v1Vault,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        vm.prank(generationKey);
        pad.approve(address(v2), true);
        vm.prank(timelock);
        pad.setFactory(address(v2));

        vm.prank(creator);
        (address vault,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        // The point: no new registry, hence no bridge to build.
        assertTrue(pad.isVault(vault), "the new version's vault is IN the same registry");
        assertEq(FeeVault(payable(vault)).REGISTRY(), address(pad), "and it knows it");

        // And the mode check added for the modes does NOT close this path: a new
        // VERSION is a new factory, but it is the same MODE, which is exactly
        // why `migrate` compares what two vaults promise and not which
        // deployment made them. v1 -> v2 still migrates.
        assertEq(pad.modeOf(vault), pad.modeOf(v1Vault), "a new version is not a new mode");
    }

    /// @notice **The factory is changed with TWO keys, and with neither of them
    ///         alone.**
    ///
    /// @dev    This is a class (a) function: a hostile factory builds vaults that
    ///         will be registered here, hence valid `migrate` destinations. No
    ///         on-chain check tells a real factory from a fake one — everything
    ///         you could read on it is written by it. So what closes this is not
    ///         an `if`, it is the timelock **and** the generation Ledger.
    /// @notice The cross-mode door: shut at birth, and the timelock cannot
    ///         open it for itself.
    ///
    /// @dev    The registry side of `Launch.t.sol`'s
    ///         `test_CrossModeMigrationNeedsTheSwitchAndTheTimelock`. Here we
    ///         only care who holds the handle: the cold key authorises, and the
    ///         authority that would use the authorisation cannot grant it.
    function test_TheCrossModeDoorIsShutAndOnlyTheColdKeyOpensIt() public {
        assertFalse(pad.crossModeMigration(), "shut at birth, with nothing to configure");

        vm.prank(timelock);
        vm.expectRevert(Payd.NotGenerationKey.selector);
        pad.setCrossModeMigration(true);

        vm.prank(makeAddr("anyone"));
        vm.expectRevert(Payd.NotGenerationKey.selector);
        pad.setCrossModeMigration(true);

        vm.prank(generationKey);
        pad.setCrossModeMigration(true);
        assertTrue(pad.crossModeMigration(), "the cold key opens it");

        vm.prank(generationKey);
        pad.setCrossModeMigration(false);
        assertFalse(pad.crossModeMigration(), "and shuts it again, at once");
    }

    /// @notice **Two modes in one registry**, which is what `Payd` being an
    ///         interface over factories rather than a pointer to one buys.
    ///
    /// @dev    The default keeps building what it always built — every existing
    ///         caller, script and front page goes through `createVault` and
    ///         nothing about them changes. A second factory, enabled by the same
    ///         two keys, is reached by name and stamps its own mode on what it
    ///         builds. The two live side by side and `migrate` keeps them apart.
    function test_TwoModesLiveInOneRegistry() public {
        _allow();
        OtherModeFactory other = new OtherModeFactory();

        // Not enabled: named or not, it builds nothing here.
        vm.expectRevert(abi.encodeWithSelector(Payd.FactoryNotEnabled.selector, address(other)));
        pad.createVaultWith(address(other), _basket(), 7_000, 30 minutes, address(0), address(0), "");

        // Two keys, exactly as for the default.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.NotApproved.selector, address(other)));
        pad.enableFactory(address(other));

        vm.prank(generationKey);
        pad.approve(address(other), true);
        assertEq(pad.factoryMode(address(other)), bytes32(0), "approving does not enable");

        vm.prank(creator);
        vm.expectRevert(Payd.NotTimelock.selector);
        pad.enableFactory(address(other));

        vm.prank(timelock);
        pad.enableFactory(address(other));
        assertEq(pad.factoryMode(address(other)), bytes32("lottery"), "the registry read its mode");

        // Enabling did NOT move the default: the ordinary path is untouched.
        assertEq(address(pad.factory()), address(factory), "the default has not moved");

        (address plain,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        (address exotic,) =
            pad.createVaultWith(address(other), _basket(), 7_000, 30 minutes, address(0), address(0), "");

        assertTrue(pad.isVault(plain) && pad.isVault(exotic), "both are of this registry");
        assertEq(pad.modeOf(plain), bytes32("distribution"), "the default's mode");
        assertEq(pad.modeOf(exotic), bytes32("lottery"), "and the named factory's");

        // And they cannot leak into each other: two different stamps is all
        // `FeeVault.migrate` needs to refuse. That refusal is asserted on bound
        // vaults, where it belongs, in `Launch.t.sol`
        // (`test_AVaultOfAnotherModeIsNotADestination`) — here a vault is never
        // launched, so `migrate` stops at `NotBound` long before the mode.
        assertTrue(pad.modeOf(plain) != pad.modeOf(exotic), "two modes, two stamps");
    }

    /// @notice A factory that declares no mode never gets in, by either door.
    function test_AFactoryThatDeclaresNothingIsRefused() public {
        MuteFactory mute = new MuteFactory();

        vm.prank(generationKey);
        pad.approve(address(mute), true);

        vm.prank(timelock);
        vm.expectRevert(Payd.BadMode.selector);
        pad.enableFactory(address(mute));

        vm.prank(timelock);
        vm.expectRevert(Payd.BadMode.selector);
        pad.setFactory(address(mute));
    }

    /// @notice Disabling stops what is next and touches nothing already built.
    ///
    /// @dev    Revoking `approved` does not reach backwards into `factoryMode` —
    ///         so without `disableFactory` a factory the generation key had
    ///         disowned would keep minting registered vaults for ever.
    function test_DisablingAFactoryStopsWhatIsNextAndNothingElse() public {
        _allow();
        OtherModeFactory other = new OtherModeFactory();
        vm.prank(generationKey);
        pad.approve(address(other), true);
        vm.prank(timelock);
        pad.enableFactory(address(other));

        (address built,) = pad.createVaultWith(address(other), _basket(), 7_000, 30 minutes, address(0), address(0), "");

        vm.prank(timelock);
        pad.disableFactory(address(other));

        vm.expectRevert(abi.encodeWithSelector(Payd.FactoryNotEnabled.selector, address(other)));
        pad.createVaultWith(address(other), _basket(), 7_000, 30 minutes, address(0), address(0), "");

        // The vault it already built is untouched: registered, stamped, alive.
        assertTrue(pad.isVault(built), "a disabled factory does not unmake its vaults");
        assertEq(pad.modeOf(built), bytes32("lottery"), "and their mode stands");

        // The default cannot be pulled out from under `createVault`.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.FactoryIsTheDefault.selector, address(factory)));
        pad.disableFactory(address(factory));
    }

    function test_TheFactoryNeedsBothKeysAndNeitherAlone() public {
        DistributionFactory v2 = new DistributionFactory();
        address hostile = makeAddr("fausse factory");

        // 1. The timelock alone: refused. The case that matters.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.NotApproved.selector, hostile));
        pad.setFactory(hostile);

        // 2. The key alone: it approves, it does not name.
        vm.prank(generationKey);
        pad.approve(address(v2), true);
        assertEq(address(pad.factory()), address(factory), "approving does not name");

        // 3. Nobody else approves, timelock included.
        vm.prank(timelock);
        vm.expectRevert(Payd.NotGenerationKey.selector);
        pad.approve(hostile, true);

        // 4. The two together.
        vm.prank(timelock);
        pad.setFactory(address(v2));
        assertEq(address(pad.factory()), address(v2), "the two keys together must go through");
    }

    /// @notice The approval can be withdrawn as long as the timelock has not
    ///         executed.
    ///
    /// @dev    A key that can only make a mistake and never correct it is a key
    ///         nobody dares use. And the table stays the **lineage**: what was
    ///         approved is readable on-chain, so we know which versions of the
    ///         vault code were ever judged good.
    function test_ApprovalIsRevocable() public {
        DistributionFactory v2 = new DistributionFactory();

        vm.prank(generationKey);
        pad.approve(address(v2), true);
        assertTrue(pad.approved(address(v2)), "the lineage is readable on-chain");

        vm.prank(generationKey);
        pad.approve(address(v2), false);

        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.NotApproved.selector, address(v2)));
        pad.setFactory(address(v2));
    }

    function test_CreateVaultMakesAWiredRegisteredPair() public {
        uint256 g = gasleft();
        vm.prank(creator);
        (address vault, address dist) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        console.log("createVault:", g - gasleft());

        FeeVault v = FeeVault(payable(vault));
        assertEq(v.DISTRIBUTOR(), dist, "the vault must know its Distributor");
        assertEq(Distributor(payable(dist)).FEE_VAULT(), vault, "and the Distributor must know the vault");

        // The creator, not us: this is what `bind` will demand of the Pons
        // launch record, and it is why the Payd is nobody's deployer.
        assertEq(v.LAUNCHER(), creator, "the caller must be the launcher");
        assertEq(v.CREATOR(), creator, "and the payee");
        assertEq(v.PLATFORM(), treasury, "the platform share must go to the Treasury");
        assertEq(v.REGISTRY(), address(pad), "the vault must know its Payd, for migrate");

        assertEq(v.PLATFORM_BPS(), 1_000, "the platform share must be stamped from the current value");
        assertEq(v.rewardsBps(), 7_000, "the creator's split must take");
        assertEq(Distributor(payable(dist)).EPOCH_LENGTH(), 30 minutes, "the epoch must take");
        assertEq(Distributor(payable(dist)).keeper(), keeper, "the keeper must be wired");

        assertTrue(pad.isVault(vault), "the registry must know it: migrate depends on this");
        // Through the INTERFACE a vault actually calls, not through the
        // Payd's own type. `FeeVault.migrate` asks this exact question of
        // this exact signature, and the two were written days apart — a drift
        // here would only show up the day somebody needed to migrate.
        assertTrue(IPayd(address(pad)).isVault(vault), "the interface migrate uses must match");
        assertFalse(IPayd(address(pad)).isVault(makeAddr("stranger")), "and answer no for anything else");
        assertEq(pad.vaultCount(), 1, "the registry must count it");
        assertEq(pad.vaultsOf(creator)[0], vault, "and file it under its creator");
    }

    /// @notice Raising the platform's share reaches the NEXT vault, never one
    ///         that exists.
    ///
    /// @dev    The promise behind `PLATFORM_BPS` being written once: a creator
    ///         knows at their launch what the platform takes, for the life of
    ///         the vault.
    function test_PlatformBpsReachesTheNextVaultAndNeverThePrevious() public {
        vm.prank(creator);
        (address first,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        vm.prank(timelock);
        pad.setPlatformBps(1_500);

        vm.prank(creator);
        (address second,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        assertEq(FeeVault(payable(first)).PLATFORM_BPS(), 1_000, "the first vault must keep its terms");
        assertEq(FeeVault(payable(second)).PLATFORM_BPS(), 1_500, "the second takes the new ones");

        // And there is a ceiling on what we can ever ask.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.PlatformBpsTooHigh.selector, 1_501, 1_500));
        pad.setPlatformBps(1_501);
    }

    /// @notice What a basket may not contain.
    ///
    /// @dev    The allowlist pins the TIER and the FEED, not just the address.
    ///         The likeliest honest mistake is the right stock at a tier with
    ///         no pool; the likeliest deliberate one is a null feed on a stock
    ///         that has one, which drops that leg's floor to the TWAP alone.
    function test_TheAllowlistPinsTheTierAndTheFeed() public {
        VaultTypes.Allocation[] memory a = _basket();

        // A stock nobody listed.
        a[0].stock = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E; // GME, real but unlisted
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.StockNotAllowed.selector, a[0].stock));
        pad.createVault(a, 7_000, 30 minutes, address(0));

        // The right stock, the wrong tier.
        a = _basket();
        a[0].poolFee = 3000;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.WrongPoolFee.selector, QQQ, uint24(500), uint24(3000)));
        pad.createVault(a, 7_000, 30 minutes, address(0));

        // The right stock, no feed — a quiet downgrade of the floor.
        a = _basket();
        a[0].feed = address(0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.WrongFeed.selector, QQQ, QQQ_FEED, address(0)));
        pad.createVault(a, 7_000, 30 minutes, address(0));

        // GLD really does carry no feed, and that is listed as such.
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(GLD, 3000, 5_000, address(0));
        a[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        vm.prank(creator);
        pad.createVault(a, 7_000, 30 minutes, address(0));
    }

    /// @notice Delisting a stock leaves every existing basket alone.
    ///
    /// @dev    It must: a delisting that reached backwards would break every
    ///         vault holding that stock, which is worse than a stock that dried
    ///         up. Only the vault's own timelock reweights it, one at a time.
    function test_DelistingDoesNotReachBackwards() public {
        vm.prank(creator);
        (address vault,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        address[] memory gone = new address[](1);
        gone[0] = QQQ;
        vm.prank(timelock);
        pad.removeStocks(gone);

        assertEq(FeeVault(payable(vault)).getAllocations()[0].stock, QQQ, "the existing basket must be untouched");

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.StockNotAllowed.selector, QQQ));
        pad.createVault(_basket(), 7_000, 30 minutes, address(0));
    }

    /// @notice The epoch a creator may choose, and the bounds on it.
    function test_TheEpochLengthIsBounded() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DistributionFactory.BadEpochLength.selector, 29 minutes));
        pad.createVault(_basket(), 7_000, 29 minutes, address(0));

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DistributionFactory.BadEpochLength.selector, 1 days + 1));
        pad.createVault(_basket(), 7_000, 1 days + 1, address(0));

        vm.prank(creator);
        pad.createVault(_basket(), 7_000, 1 days, address(0));
    }

    /// @notice Everything that governs the Payd goes through the timelock.
    function test_OnlyTheTimelockGoverns() public {
        address[] memory s = new address[](1);
        uint24[] memory f = new uint24[](1);
        address[] memory d = new address[](1);
        s[0] = QQQ;
        f[0] = 500;
        d[0] = QQQ_FEED;

        vm.expectRevert(Payd.NotTimelock.selector);
        pad.allowStocks(s, f, d);

        vm.expectRevert(Payd.NotTimelock.selector);
        pad.removeStocks(s);

        vm.expectRevert(Payd.NotTimelock.selector);
        pad.setPlatformBps(500);

        vm.expectRevert(Payd.NotTimelock.selector);
        pad.setKeeper(makeAddr("other"));
    }

    /// @notice `setKeeper` alone reaches the NEXT vault only.
    ///
    /// @dev    Still deliberate, but no longer the whole story: `rotateKeeper`
    ///         is the door that reaches the live ones, and the two are separate
    ///         so that staging a successor and cutting over to it are separate
    ///         decisions. This test holds the half that did not change.
    function test_RotatingTheKeeperDoesNotReachExistingVaults() public {
        vm.prank(creator);
        (, address first) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        address other = makeAddr("keeper2");
        vm.prank(timelock);
        pad.setKeeper(other);

        vm.prank(creator);
        (, address second) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        assertEq(Distributor(payable(first)).keeper(), keeper, "an existing vault keeps its keeper");
        assertEq(Distributor(payable(second)).keeper(), other, "a new one takes the new keeper");
    }

    /// @notice **One operation rotates every live vault, and a vault that
    ///         refuses does not stop it.**
    ///
    /// @dev    The registry used to reach future Distributors only, on the
    ///         argument that one call must not swap every publisher at once.
    ///         The timelock could already do it — N calls, N × 48 h — so the
    ///         absence never withheld the power, only the ability to USE it
    ///         against a compromised key across a thousand vaults.
    ///
    ///         The skip is the part worth testing. A Distributor that reverts
    ///         is counted out and named in an event, and the rotation carries
    ///         on: same rule as a basket leg that cannot be bought. A rotation
    ///         that stopped on the first awkward vault would be useless in the
    ///         one situation it exists for.
    function test_RotateKeeperReachesEveryLiveVaultAndSkipsWhatItCannot() public {
        vm.startPrank(creator);
        (, address d1) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        (, address d2) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        (, address d3) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        vm.stopPrank();

        address other = makeAddr("keeper2");
        vm.prank(timelock);
        pad.setKeeper(other);
        assertEq(Distributor(payable(d1)).keeper(), keeper, "setKeeper alone moves nothing live");

        // The middle vault's Distributor is made to refuse. OUR code at an
        // address the registry genuinely indexes — nothing about the registry
        // is faked.
        vm.etch(d2, type(RefusingDistributor).runtimeCode);

        vm.prank(timelock);
        uint256 rotated = pad.rotateKeeper(0, type(uint256).max);

        assertEq(rotated, 2, "two moved, one refused");
        assertEq(Distributor(payable(d1)).keeper(), other, "the first followed");
        assertEq(Distributor(payable(d3)).keeper(), other, "and so did the one AFTER the failure");
    }

    /// @notice **A vault is born with the second key, or the feature ships
    ///         switched off.**
    ///
    /// @dev    `Distributor.coSigner` is what actually gates a publication, and
    ///         a per-vault timelock call after the fact is one nobody makes. So
    ///         `Payd._create` stamps it at birth — and the coverage report
    ///         showed that line had **never executed**, which on a governance
    ///         lever is the same as not having it. A thousand vaults would have
    ///         been born single-key and nothing would have said so.
    ///
    ///         The stamp is a SOFT call, like `rotateKeeper`'s: a mode with no
    ///         second contract returns its own vault as `distributor` and has no
    ///         `setCoSigner`, which is not an error.
    function test_ANewVaultIsBornWithTheRegistrysCoSigner() public {
        address signer = makeAddr("co-signer");

        // Before: nobody named, so a vault is born single-key — which is what
        // every vault made before this existed already is.
        vm.prank(creator);
        (, address before_) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        assertEq(Distributor(payable(before_)).coSigner(), address(0), "no requirement until one is named");

        vm.prank(timelock);
        pad.setCoSigner(signer);
        assertEq(pad.coSigner(), signer, "the registry now names one");

        // After: born with it, and in force from its first block.
        vm.prank(creator);
        (, address after_) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        assertEq(Distributor(payable(after_)).coSigner(), signer, "a new vault is born with the second key");
        assertTrue(Distributor(payable(after_)).coSignerRequired(), "and it is in force, not merely written");

        // And naming one reaches nothing already built — the same rule
        // `setKeeper` follows, and why `rotateCoSigner` exists.
        assertEq(Distributor(payable(before_)).coSigner(), address(0), "an existing vault is untouched");
    }

    /// @notice **One operation puts the second key into every live vault, and a
    ///         Distributor that refuses does not stop it.**
    ///
    /// @dev    The whole function had never executed. It is the answer to a
    ///         co-signer that has to be replaced across a registry — 48 h once,
    ///         rather than 48 h per vault — and the skip is the part worth
    ///         testing: same rule as a basket leg that cannot be bought, or as
    ///         `rotateKeeper`, which this mirrors deliberately.
    ///
    ///         `vm.etch` puts OUR code at an address the registry genuinely
    ///         produced, so nothing about the Distributor is faked — it is
    ///         replaced by a contract that refuses, which is the state under
    ///         test.
    function test_RotatingTheCoSignerReachesLiveVaultsAndSkipsARefusal() public {
        address signer = makeAddr("co-signer");

        vm.prank(creator);
        (, address d1) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        vm.prank(creator);
        (, address d2) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        vm.prank(creator);
        (, address d3) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        vm.etch(d2, type(RefusingDistributor).runtimeCode);

        vm.prank(timelock);
        pad.setCoSigner(signer);

        vm.prank(timelock);
        uint256 rotated = pad.rotateCoSigner(0, type(uint256).max);

        assertEq(rotated, 2, "two moved, one refused");
        assertEq(Distributor(payable(d1)).coSigner(), signer, "the first followed");
        assertEq(Distributor(payable(d3)).coSigner(), signer, "and so did the one AFTER the failure");
    }

    /// @notice **The range is bounds, not addresses — and an empty one is
    ///         refused rather than silently doing nothing.**
    ///
    /// @dev    `FLOWS.md` §6 says it of `rotateKeeper` and a reader who takes
    ///         `(from, to)` for a key pair misreads both. `to` past the end is
    ///         clamped, because a caller cannot know the length without reading
    ///         it, and `from >= to` reverts because a rotation that moves
    ///         nothing is a 48-hour operation spent on nothing.
    function test_TheCoSignerRotationRangeIsClampedAndNeverEmpty() public {
        vm.prank(creator);
        pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        vm.prank(timelock);
        pad.setCoSigner(makeAddr("co-signer"));

        // Past the end: clamped to what exists, not reverted.
        vm.prank(timelock);
        assertEq(pad.rotateCoSigner(0, 999), 1, "a range past the end covers what there is");

        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.EmptyRange.selector, 1, 1));
        pad.rotateCoSigner(1, 1);

        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.EmptyRange.selector, 5, 1));
        pad.rotateCoSigner(5, 1);
    }

    /// @notice **Both of the second key's doors are the timelock's, and removal
    ///         is a legal value.**
    ///
    /// @dev    Zero is not a mistake here: it is what takes the requirement off
    ///         FUTURE vaults. What it is NOT is the emergency lever — that is
    ///         `Distributor.CO_SIGNER_GRACE`, which lifts by itself in three
    ///         hours, because 48 h of timelock on a protocol that pays every
    ///         thirty minutes is ninety-six epochs.
    function test_OnlyTheTimelockNamesOrRotatesTheCoSigner() public {
        vm.prank(creator);
        vm.expectRevert(Payd.NotTimelock.selector);
        pad.setCoSigner(makeAddr("x"));

        vm.prank(creator);
        vm.expectRevert(Payd.NotTimelock.selector);
        pad.rotateCoSigner(0, 1);

        vm.prank(timelock);
        pad.setCoSigner(makeAddr("x"));
        vm.prank(timelock);
        pad.setCoSigner(address(0));
        assertEq(pad.coSigner(), address(0), "removal is a value, not a mistake");
    }

    /// @notice **Delisting a quote, which had never run.**
    ///
    /// @dev    `removeQuotes` is the only way back out of the quote list, and
    ///         the coverage report showed not one line of it had executed. What
    ///         it must do is reach the NEXT vault and no existing one — a vault's
    ///         quote is stamped at birth and this list is only ever read there,
    ///         which is `FLOWS.md` §7.5 and is deliberate: making a delisting
    ///         reach backwards would strand vaults already paying in it.
    function test_DelistingAQuoteReachesTheNextVaultAndNoneAlreadyBuilt() public {
        // USDG is the PIVOT, so it lists with no route and no tier — exactly as
        // `script/Quotelist.s.sol` lists it, and the only shape `_allowQuotes`
        // accepts for it.
        address[] memory q = new address[](1);
        uint256[] memory floor_ = new uint256[](1);
        q[0] = USDG;
        floor_[0] = 10e6;
        vm.prank(timelock);
        pad.allowQuotes(q, new uint24[](1), new uint24[](1), floor_);

        vm.prank(creator);
        (address live,) = pad.createVaultQuoted(_basket(), 7_000, 30 minutes, address(0), USDG);
        assertEq(FeeVault(payable(live)).QUOTE(), USDG, "fixture: a live vault quoted in it");

        address[] memory gone = new address[](1);
        gone[0] = USDG;
        vm.prank(timelock);
        pad.removeQuotes(gone);

        (,,, bool allowed) = pad.quoteListing(USDG);
        assertFalse(allowed, "the row is gone");

        // The next one cannot be created in it.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.QuoteNotAllowed.selector, USDG));
        pad.createVaultQuoted(_basket(), 7_000, 30 minutes, address(0), USDG);

        // And the one already built keeps working: its quote was written into
        // it, not read from here.
        assertEq(FeeVault(payable(live)).QUOTE(), USDG, "a live vault is untouched by a delisting");
    }

    /// @notice **The shapes a listing cannot take**, in one pass.
    ///
    /// @dev    Individually trivial; together they are the difference between a
    ///         timelock vote that fails now and a registry row that is read for
    ///         the life of every vault created under it. Both lists, both
    ///         mismatches, and the zero on either side.
    function test_ListingRefusesEveryShapeThatCannotBeRead() public {
        address[] memory one = new address[](1);
        one[0] = NVDA;

        vm.prank(timelock);
        vm.expectRevert(Payd.LengthMismatch.selector);
        pad.allowStocks(one, new uint24[](2), new address[](1));

        vm.prank(timelock);
        vm.expectRevert(Payd.ZeroAddress.selector);
        pad.allowStocks(new address[](1), new uint24[](1), new address[](1));

        vm.prank(timelock);
        vm.expectRevert(Payd.LengthMismatch.selector);
        pad.allowQuotes(one, new uint24[](2), new uint24[](1), new uint256[](1));

        // A quote with no `minBuy` is a quote whose floor is zero, and
        // `MIN_BUY_QUOTE` is the only dollar-denominated number a vault carries.
        uint256[] memory noFloor = new uint256[](1);
        vm.prank(timelock);
        vm.expectRevert(Payd.ZeroAddress.selector);
        pad.allowQuotes(one, new uint24[](1), new uint24[](1), noFloor);

        // The pivot against itself: no route, hence no tier.
        address[] memory pivot = new address[](1);
        uint24[] memory tier = new uint24[](1);
        uint256[] memory floor_ = new uint256[](1);
        pivot[0] = USDG;
        tier[0] = 500;
        floor_[0] = 1e6;
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.QuoteNotAllowed.selector, USDG));
        pad.allowQuotes(pivot, tier, new uint24[](1), floor_);
    }

    /// @notice **A quote the till cannot convert back is refused at listing.**
    ///
    /// @dev    The way in and the way out are two separate timelock votes and
    ///         nothing used to make them agree. A quote listed here but absent
    ///         from `Treasury.allowSweeps` produces vaults whose platform share
    ///         arrives in a currency `sweepToEth` refuses — and it does not
    ///         revert, it accumulates for ever.
    ///
    ///         Both directions are held: refused when the till says it has no
    ///         route, and accepted the moment it has one. The stub is OUR code
    ///         at the address the registry already carries as `PLATFORM`, so
    ///         nothing about the Treasury is faked — only shortened.
    function test_AQuoteTheTillCannotSweepIsRefused() public {
        vm.etch(treasury, type(SweepStub).runtimeCode);

        address[] memory q = new address[](1);
        uint24[] memory poolFees = new uint24[](1);
        uint24[] memory wethFees = new uint24[](1);
        uint256[] memory minBuys = new uint256[](1);
        q[0] = NVDA;
        poolFees[0] = 500;
        minBuys[0] = 0.12 ether;

        SweepStub(treasury).set(0, 0);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.QuoteNotSweepable.selector, NVDA));
        pad.allowQuotes(q, poolFees, wethFees, minBuys);

        // One route is enough — the till converts directly or through the
        // pivot, and the registry does not care which.
        SweepStub(treasury).set(3000, 0);
        vm.prank(timelock);
        pad.allowQuotes(q, poolFees, wethFees, minBuys);
        (,,, bool allowed) = pad.quoteListing(NVDA);
        assertTrue(allowed, "a sweepable quote lists");

        SweepStub(treasury).set(0, 500);
        vm.prank(timelock);
        pad.allowQuotes(q, poolFees, wethFees, minBuys);
        assertTrue(allowed, "and so does one reachable only through the pivot");
    }

    /// @notice **And the guard fails OPEN against a platform that says nothing.**
    ///
    /// @dev    `PLATFORM` is immutable and written at deployment: a platform
    ///         that is not a Treasury is a wiring catastrophe this guard is not
    ///         meant to catch, and refusing every quote against one would trade
    ///         a liveness hazard for nothing. This test pins that choice so it
    ///         cannot be "fixed" into a revert by someone reading the guard
    ///         without its reason — the rest of this suite runs against a plain
    ///         address for exactly this reason.
    function test_AnUnansweringPlatformDoesNotBlockListing() public {
        address[] memory q = new address[](1);
        uint24[] memory poolFees = new uint24[](1);
        uint24[] memory wethFees = new uint24[](1);
        uint256[] memory minBuys = new uint256[](1);
        q[0] = NVDA;
        poolFees[0] = 500;
        minBuys[0] = 0.12 ether;

        assertEq(treasury.code.length, 0, "the fixture's platform really is a plain address");
        vm.prank(timelock);
        pad.allowQuotes(q, poolFees, wethFees, minBuys);
        (,,, bool allowed) = pad.quoteListing(NVDA);
        assertTrue(allowed, "listing must not depend on the platform answering");
    }

    /// @notice **A second publisher, named once, valid on vaults that already
    ///         existed — and taken back the same way.**
    ///
    /// @dev    This is the half `rotateKeeper` cannot do. Rotating REPLACES a
    ///         vault's pinned key one vault at a time; the set ADDS a publisher
    ///         to every vault at once, with no loop, because a Distributor asks
    ///         the registry at publish time instead of holding a copy.
    ///
    ///         Both ends are tested, and the second is the one that matters:
    ///         a set you cannot empty is not a set, it is a permanent grant.
    function test_TheRegistryCanNameExtraPublishersAndTakeThemBack() public {
        vm.prank(creator);
        (, address d) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        Distributor dist = Distributor(payable(d));

        address second = makeAddr("keeper2");
        bytes32 root = keccak256("root");
        vm.warp(dist.epochEnd(0) + 1);

        vm.prank(second);
        vm.expectRevert(Distributor.NotKeeper.selector);
        dist.publishRoot(0, root, root, bytes32("d"), "bafyTEST");

        vm.prank(timelock);
        pad.allowKeeper(second, true);

        // No rotation, no loop: a vault that already existed obeys at once.
        vm.prank(second);
        dist.publishRoot(0, root, root, bytes32("d"), "bafyTEST");
        assertEq(dist.activeRoot(), 1, "the named publisher reaches a live vault");

        vm.prank(timelock);
        pad.allowKeeper(second, false);

        vm.warp(dist.epochEnd(1) + 1);
        vm.prank(second);
        vm.expectRevert(Distributor.NotKeeper.selector);
        dist.publishRoot(1, root, root, bytes32("d"), "bafyTEST");
    }

    /// @notice **A registry that stops answering must not stop the cycle.**
    ///
    /// @dev    The set is an extension of who may publish, never a condition of
    ///         it. `publishRoot` checks the pinned key with one SLOAD and asks
    ///         the registry only if that failed — so the nominal publisher pays
    ///         nothing for the set's existence and keeps working whatever
    ///         happens to the registry. Get that order wrong and every vault's
    ///         liveness, every thirty minutes, depends on another contract.
    ///
    ///         The stranger half is here too: an unreachable registry answers
    ///         "no", it does not propagate a revert that would turn a wrong
    ///         caller into an outage.
    function test_ThePinnedKeeperPublishesEvenIfTheRegistryIsUnreachable() public {
        vm.prank(creator);
        (, address d) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        Distributor dist = Distributor(payable(d));
        bytes32 root = keccak256("root");
        vm.warp(dist.epochEnd(0) + 1);

        // The registry answers nothing at all, any call.
        vm.etch(address(pad), type(RefusingDistributor).runtimeCode);

        vm.prank(keeper);
        dist.publishRoot(0, root, root, bytes32("d"), "bafyTEST");
        assertEq(dist.activeRoot(), 1, "the pinned key does not need the registry");

        vm.warp(dist.epochEnd(1) + 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Distributor.NotKeeper.selector);
        dist.publishRoot(1, root, root, bytes32("d"), "bafyTEST");
    }

    /// @notice The door is the timelock's, and an empty slice is an error.
    ///
    /// @dev    `to` is clamped rather than checked, so naming the whole list is
    ///         always legal; `from >= to` is not clamped, because a range that
    ///         contains nothing is a typo and a silent no-op would hide it in
    ///         the one operation nobody gets to rehearse.
    function test_RotateKeeperIsTimelockOnlyAndRefusesAnEmptyRange() public {
        vm.prank(creator);
        pad.createVault(_basket(), 7_000, 30 minutes, address(0));

        vm.expectRevert(Payd.NotTimelock.selector);
        pad.rotateKeeper(0, 1);

        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.EmptyRange.selector, uint256(5), uint256(1)));
        pad.rotateKeeper(5, 1);
        assertEq(pad.rotateKeeper(0, type(uint256).max), 1, "the whole list is one call");
        vm.stopPrank();
    }

    /// @notice **The exemption is a guarded function, not a window.**
    ///
    /// @dev    `$PAYD` funds the platform, so charging it the platform share
    ///         would be the Treasury paying itself through two hops. Its vault
    ///         is therefore born at `platformBps = 0`.
    ///
    ///         This test holds both ends. First: only the timelock reaches the
    ///         path — without that, the exemption would be the default rate for
    ///         whoever asks. Second, and this is the one that matters: **the
    ///         ordinary path still stamps the global rate**, so the existence
    ///         of the exemption does not weaken it.
    function test_OnlyTheTimelockCanMintAnExemptVault() public {
        VaultTypes.Allocation[] memory b = _basket();
        address safe = makeAddr("the Payd safe");

        // Nobody else, at any rate they care to ask for.
        vm.prank(creator);
        vm.expectRevert(Payd.NotTimelock.selector);
        pad.createVaultFor(address(factory), safe, b, 8_649, 30 minutes, address(0), 0, address(0), "");

        vm.prank(timelock);
        (address vault,) =
            pad.createVaultFor(address(factory), safe, b, 8_649, 30 minutes, address(0), 0, address(0), "");

        assertEq(FeeVault(payable(vault)).PLATFORM_BPS(), 0, "the platform's own vault does not tax itself");
        assertEq(FeeVault(payable(vault)).rewardsBps(), 8_649, "and carries the holders' share asked for");

        // **The LAUNCHER is the Safe, not the timelock.** `bind` will require
        // the token's Pons deployer to be this address: the timelock makes the
        // vault, the Safe launches. Two different keys, on purpose.
        assertEq(FeeVault(payable(vault)).LAUNCHER(), safe, "the launcher is the Safe");
        assertEq(FeeVault(payable(vault)).CREATOR(), safe, "and the residue goes to it");

        // Registered like any other — which was the whole point of going
        // through the Payd instead of deploying it alongside.
        assertTrue(pad.isVault(vault), "registered");
        assertEq(pad.vaultsOf(safe).length, 1, "and attached to its launcher");

        // And the ordinary path has not moved an inch.
        vm.prank(creator);
        (address normal,) = pad.createVault(b, 7_000, 30 minutes, address(0));
        assertEq(FeeVault(payable(normal)).PLATFORM_BPS(), 1_000, "the global rate still holds");
    }

    /// @notice The exempt path still obeys the cap, like the global rate.
    function test_TheExemptPathStillObeysTheCap() public {
        VaultTypes.Allocation[] memory b = _basket();
        uint256 max = pad.MAX_PLATFORM_BPS();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.PlatformBpsTooHigh.selector, max + 1, max));
        pad.createVaultFor(address(factory), makeAddr("x"), b, 7_000, 30 minutes, address(0), max + 1, address(0), "");
    }

    /// @notice **USDG is the only stock this mode BUYS with no pool.**
    ///
    /// @dev    It used to be the only one that could be LISTED with none, and
    ///         that changed on 2026-09-11: tier zero now declares "no v3 route"
    ///         for the benefit of a mode that settles elsewhere, and the list is
    ///         read by every mode. What stayed is the part that was really about
    ///         the pivot — there is no pool of it against itself, so a non-zero
    ///         tier on it is still an error, and it is still the only basket line
    ///         this mode accepts without one.
    ///
    /// @dev    The tier is mandatory everywhere else because the likeliest
    ///         mistake is the right stock at the wrong tier. USDG has no pool
    ///         against itself: demanding a tier there is demanding a lie, and the
    ///         vault would skip the line silently at every purchase. The
    ///         exception is named, not general.
    function test_UsdgIsTheOnlyStockThisModeBuysWithoutAPool() public {
        address[] memory s = new address[](1);
        uint24[] memory f = new uint24[](1);
        address[] memory d = new address[](1);

        // 1. Any other stock at zero is now LISTED — it declares no v3 route
        //    — but the distribution mode cannot put it in a basket.
        s[0] = QQQ;
        f[0] = 0;
        vm.prank(timelock);
        pad.allowStocks(s, f, d);
        VaultTypes.Allocation[] memory dead = new VaultTypes.Allocation[](2);
        dead[0] = VaultTypes.Allocation(QQQ, 0, 5_000, address(0));
        dead[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        vm.prank(creator);
        vm.expectRevert(FeeVault.NoPool.selector);
        pad.createVault(dead, 7_000, 30 minutes, address(0));
        // Put it back the way the rest of this file expects it.
        f[0] = 500;
        d[0] = QQQ_FEED;
        vm.prank(timelock);
        pad.allowStocks(s, f, d);
        d[0] = address(0);

        // 2. USDG is the only line for which a NON-ZERO tier is an error, and
        //    the only one this mode will buy at zero.
        s[0] = USDG;
        f[0] = 500;
        vm.expectRevert(abi.encodeWithSelector(Payd.WrongPoolFee.selector, USDG, 0, uint24(500)));
        vm.prank(timelock);
        pad.allowStocks(s, f, d);

        f[0] = 0;
        vm.prank(timelock);
        pad.allowStocks(s, f, d);
        (uint24 tier,, bool allowed) = pad.listing(USDG);
        assertTrue(allowed, "USDG is listable");
        assertEq(tier, 0, "with no pool");

        // 3. And a basket containing a line of it can be created.
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(USDG, 0, 5_000, address(0));
        basket[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        vm.prank(creator);
        (address vault,) = pad.createVault(basket, 7_000, 30 minutes, address(0));
        assertTrue(pad.isVault(vault), "the vault is created and registered");
    }

    /// @notice **A tier that designates no pool is refused from the list.**
    ///
    /// @dev    The list held by measurement discipline and not by a guard: the
    ///         right stock could be listed at the wrong tier -- what `Listing`'s
    ///         own comment calls "the likeliest mistake" -- and the vaults then
    ///         skipped the line silently at every purchase, its share piling up
    ///         in `pivotReserve` for the whole of their life. No revert, no
    ///         alert: the worst kind of failure.
    ///
    ///         The guard checks NEITHER depth NOR the TWAP. It catches the
    ///         mechanical mistake, the one a human makes copying a figure across,
    ///         and it makes it shout.
    function test_AListingWithoutItsPoolIsRefused() public {
        address[] memory s = new address[](1);
        uint24[] memory f = new uint24[](1);
        address[] memory d = new address[](1);

        // NVDA exists, its deep USDG pool is at tier 500. Tier 10000 EXISTS
        // too -- `getPool` returns an address there -- but it is EMPTY. That is
        // why the guard looks at liquidity and not at existence: the "the pool
        // exists" version would have let exactly this line through.
        s[0] = NVDA;
        f[0] = 10000;
        d[0] = NVDA_FEED;
        vm.expectRevert(abi.encodeWithSelector(Payd.NoLiquidityAt.selector, NVDA, USDG, uint24(10000)));
        vm.prank(timelock);
        pad.allowStocks(s, f, d);

        // At the right tier, the same line goes through: the guard aims at the
        // pool, not at the stock. Without this second step, a universal `revert`
        // would pass the test.
        f[0] = 500;
        vm.prank(timelock);
        pad.allowStocks(s, f, d);
        (uint24 tier,, bool ok) = pad.listing(NVDA);
        assertTrue(ok, "the same line at the right tier is accepted");
        assertEq(tier, 500);
    }

    /// @notice The same guard on a currency, and on BOTH hops of the detour.
    ///
    /// @dev    A detour whose second hop is missing is as dead as a direct route
    ///         with no pool -- and it is more insidious, because the first hop
    ///         does exist.
    function test_AQuoteRouteWithoutItsPoolIsRefused() public {
        address[] memory q = new address[](1);
        uint24[] memory f = new uint24[](1);
        uint24[] memory w = new uint24[](1);
        uint256[] memory m = new uint256[](1);
        m[0] = 1e17;

        // A direct route, at the wrong tier.
        q[0] = NVDA;
        f[0] = 10000;
        vm.expectRevert(abi.encodeWithSelector(Payd.NoLiquidityAt.selector, NVDA, USDG, uint24(10000)));
        vm.prank(timelock);
        pad.allowQuotes(q, f, w, m);

        // Detour, wrong tier on the FIRST hop: NVDA/WETH at 100 does not exist
        // at all, where NVDA/USDG at 10000 existed but empty. The guard covers
        // both shapes of the same mistake.
        f[0] = 0;
        w[0] = 100;
        vm.expectRevert(abi.encodeWithSelector(Payd.NoLiquidityAt.selector, NVDA, WETH, uint24(100)));
        vm.prank(timelock);
        pad.allowQuotes(q, f, w, m);

        // And the route that really exists goes through.
        f[0] = 500;
        w[0] = 0;
        vm.prank(timelock);
        pad.allowQuotes(q, f, w, m);
        (uint24 tier,,, bool ok) = pad.quoteListing(NVDA);
        assertTrue(ok, "the measured route is accepted");
        assertEq(tier, 500);
    }

    /// @dev The two keys, in the order the runbook uses them.
    function _enableFactory(address f) internal {
        vm.prank(generationKey);
        pad.approve(f, true);
        vm.prank(timelock);
        pad.enableFactory(f);
    }

    /// @notice **An empty basket is the registry's business no longer.**
    ///
    /// @dev    A basket is the distribution mode's parameter. Requiring one
    ///         forced every future mode to be handed a stock it would never buy,
    ///         purely to get past a line in `_create`. What is kept is the half
    ///         that is genuinely the registry's: the list is governance's, so a
    ///         basket PRESENTED here is still checked entry by entry.
    ///
    ///         It fails closed for the mode that does want one — one step later,
    ///         in the contract that knows what a basket is for.
    function test_AnEmptyBasketPassesTheRegistryAndDiesAtTheVault() public {
        VaultTypes.Allocation[] memory none = new VaultTypes.Allocation[](0);

        // The registry lets it through; `FeeVault.init` does not.
        vm.prank(creator);
        vm.expectRevert(FeeVault.BadWeights.selector);
        pad.createVault(none, 7_000, 30 minutes, address(0));

        // And a mode with no use for a basket is not asked for one.
        FreeModeFactory free = new FreeModeFactory();
        _enableFactory(address(free));
        vm.prank(creator);
        (address v,) = pad.createVaultWith(address(free), none, 7_000, 30 minutes, address(0), address(0), "");
        assertTrue(pad.isVault(v), "the registry registered it");
        assertEq(free.lastBasketLength(), 0, "and asked for no stock");

        // A basket that IS presented is still held to the allowlist.
        VaultTypes.Allocation[] memory bad = _basket();
        bad[0].stock = address(0xBEEF);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.StockNotAllowed.selector, address(0xBEEF)));
        pad.createVaultWith(address(free), bad, 7_000, 30 minutes, address(0), address(0), "");
    }

    /// @notice **The epoch bounds belong to the factory, not to the registry.**
    ///
    /// @dev    They are a `Distributor` cadence, and a registry that is an
    ///         interface over factories has no business refusing a number
    ///         because THIS mode's Distributor would dislike it. A mode without
    ///         epochs never reads the argument.
    function test_TheEpochBoundsBelongToTheFactoryNotTheRegistry() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DistributionFactory.BadEpochLength.selector, 29 minutes));
        pad.createVault(_basket(), 7_000, 29 minutes, address(0));

        FreeModeFactory free = new FreeModeFactory();
        _enableFactory(address(free));

        // One second. The registry says nothing; this mode bounds nothing.
        vm.prank(creator);
        pad.createVaultWith(address(free), _basket(), 7_000, 1, address(0), address(0), "");
        assertEq(free.lastEpochLength(), 1, "the registry forwarded it untouched");
    }

    /// @notice **`modeData` reaches the mode, and the registry never opens it.**
    ///
    /// @dev    The third scope. Platform-wide values are this registry's
    ///         immutables, per-mode values are the factory's — what had nowhere
    ///         to go is the value a LAUNCHER chooses and that differs from one
    ///         launch to the next.
    ///
    ///         A mode with none REFUSES a non-empty value rather than ignoring
    ///         it: silence would let a launcher believe they configured
    ///         something.
    function test_ModeDataIsForwardedUnreadAndRefusedByAModeWithoutOne() public {
        FreeModeFactory free = new FreeModeFactory();
        _enableFactory(address(free));

        bytes memory payload = abi.encode(address(0xC0FFEE), uint256(42));
        vm.prank(creator);
        pad.createVaultWith(address(free), _basket(), 7_000, 30 minutes, address(0), address(0), payload);
        assertEq(free.lastModeData(), payload, "verbatim, byte for byte");

        // Distribution's per-launch parameter is the basket, and it has its own
        // argument. Anything here was meant for another mode.
        vm.prank(creator);
        vm.expectRevert(DistributionFactory.UnexpectedModeData.selector);
        pad.createVaultWith(address(factory), _basket(), 7_000, 30 minutes, address(0), address(0), hex"01");

        // And the ordinary paths never carry any: their signatures did not move.
        vm.prank(creator);
        (address plain,) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        assertEq(pad.modeOf(plain), bytes32("distribution"), "unchanged for every existing caller");
    }

    /// @notice **The timelock can mint a destination in any ENABLED mode.**
    ///
    /// @dev    This function exists to give a MIGRATION a destination when the
    ///         launcher will not or cannot make one — `FeeVault.migrate` demands
    ///         a destination whose `LAUNCHER` matches, and only this function
    ///         sets it for someone else.
    ///
    ///         It was wired to the default factory, to native ETH and to an
    ///         empty `modeData`, which put every vault of a secondary mode,
    ///         every non-ETH vault and every mode with a per-launch parameter
    ///         out of reach of any migration its launcher did not perform in
    ///         person — for ever, a vault's code being fixed at birth.
    ///
    ///         It grants nothing new: the same `FactoryNotEnabled` gate as
    ///         `createVaultWith`, so the timelock still picks among the modes
    ///         BOTH keys admitted.
    function test_TheTimelockCanMintADestinationInAnyEnabledMode() public {
        FreeModeFactory free = new FreeModeFactory();
        address launcher = makeAddr("someone else's launcher");
        address token = makeAddr("their token");

        // Not enabled: the timelock gets no private door.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.FactoryNotEnabled.selector, address(free)));
        pad.createVaultFor(address(free), launcher, _basket(), 7_000, 30 minutes, token, 0, address(0), hex"01");

        _enableFactory(address(free));

        vm.prank(creator);
        vm.expectRevert(Payd.NotTimelock.selector);
        pad.createVaultFor(address(free), launcher, _basket(), 7_000, 30 minutes, token, 0, address(0), hex"01");

        vm.prank(timelock);
        (address dest,) =
            pad.createVaultFor(address(free), launcher, _basket(), 7_000, 30 minutes, token, 0, address(0), hex"01");

        assertTrue(pad.isVault(dest), "a destination of this registry");
        assertEq(pad.modeOf(dest), bytes32("free"), "stamped with the mode it was built under");
        assertEq(free.lastModeData(), hex"01", "and its per-launch parameter arrived");
    }

    /// @notice **A line may be listed with NO Uniswap v3 route, and the mode
    ///         that needs one still refuses it.**
    ///
    /// @dev    The two allowlists are read by every mode, and `_requirePool` is
    ///         a v3 guard. A mode settling on v4 — or paying without a swap at
    ///         all — could not get a line listed without inventing a tier for a
    ///         pool it would never touch. Tier zero now declares "no v3 route".
    ///
    ///         Nothing is given away. A line that DOES declare a tier is
    ///         measured exactly as before, at listing time, which is still the
    ///         deployment for anything in the seed. And the distribution mode
    ///         refuses a route-less line at the vault's birth rather than
    ///         skipping it in silence on every purchase for its whole life.
    function test_AListingMayDeclareNoV3RouteAndTheV3ModeRefusesIt() public {
        address[] memory s = new address[](1);
        uint24[] memory f = new uint24[](1);
        address[] memory d = new address[](1);
        s[0] = GLD;
        f[0] = 0; // no v3 route declared
        d[0] = address(0);

        vm.prank(timelock);
        pad.allowStocks(s, f, d);
        (uint24 tier,, bool ok) = pad.listing(GLD);
        assertTrue(ok, "listed without a pool");
        assertEq(tier, 0, "and carrying no tier");

        // The distribution mode cannot buy it, and says so at birth.
        VaultTypes.Allocation[] memory b = new VaultTypes.Allocation[](2);
        b[0] = VaultTypes.Allocation(GLD, 0, 5_000, address(0));
        b[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        vm.prank(creator);
        vm.expectRevert(FeeVault.NoPool.selector);
        pad.createVault(b, 7_000, 30 minutes, address(0));

        // A tier that IS declared is still measured. Nothing was given away.
        f[0] = 10000;
        vm.expectRevert(abi.encodeWithSelector(Payd.NoLiquidityAt.selector, NVDA, USDG, uint24(10000)));
        vm.prank(timelock);
        s[0] = NVDA;
        pad.allowStocks(s, f, d);
    }

    /// @notice **The same, for a quote.** Two tiers at zero declare a currency
    ///         with no v3 route; `FeeVault.init` refuses such a vault.
    function test_AQuoteMayDeclareNoV3RouteAndTheV3ModeRefusesIt() public {
        address[] memory q = new address[](1);
        uint24[] memory f = new uint24[](1);
        uint24[] memory w = new uint24[](1);
        uint256[] memory m = new uint256[](1);
        q[0] = NVDA;
        m[0] = 1e17;
        // f and w both zero: no route.

        vm.prank(timelock);
        pad.allowQuotes(q, f, w, m);
        (uint24 tier, uint24 wethTier,, bool ok) = pad.quoteListing(NVDA);
        assertTrue(ok, "listed without a route");
        assertEq(tier, 0);
        assertEq(wethTier, 0);

        // The distribution mode has nowhere to swap it, and refuses at birth.
        vm.prank(creator);
        vm.expectRevert(FeeVault.BadQuote.selector);
        pad.createVaultQuoted(_basket(), 7_000, 30 minutes, address(0), NVDA);

        // Two routes at once are still refused: the contract would be choosing
        // in place of whoever did the measuring.
        f[0] = 500;
        w[0] = 3000;
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.QuoteNotAllowed.selector, NVDA));
        pad.allowQuotes(q, f, w, m);
    }

    // ------------------------------------------------------- audit, 2026-09-11

    /// @dev The threshold `docs/allowlist.md` proposes and
    ///      `PaydDeploy.t.sol::test_EveryQuoteRouteCarriesEnoughDepth` enforces,
    ///      in dollars. Repeated rather than imported: the other file holds it
    ///      as a private constant, and a second copy that disagrees would be
    ///      louder than a shared one that drifts.
    uint256 constant MIN_DEPTH_USD = 5_000;
    /// @dev sqrt(1.01) - 1, in 1e9. Same derivation as `PaydDeploy.t.sol:441`.
    uint256 constant K_NUM = 4_987_562;
    uint256 constant K_DEN = 1_000_000_000;

    /// @dev cbBTC, read out of `script/Quotelist.s.sol:237` — the ONE money-path
    ///      address that is in neither `docs/recon.md` nor `docs/allowlist.md`,
    ///      which is `AUDIT_PLAN.md` §2.4bis and `T-RECON-01`.
    address constant CBBTC = 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4;

    /// @dev Active depth absorbable before +1 %, against the PIVOT, in dollars.
    ///      The same arithmetic as `PaydDeploy.t.sol::_depthUsd`, narrowed to
    ///      the pivot leg because that is the only one this test reads.
    function _depthUsdVsPivot(address pool) internal view returns (uint256) {
        if (pool == address(0)) return 0;
        (uint160 sqrtP,,,,,,) = IV3PoolDepth(pool).slot0();
        uint128 liq = IV3PoolDepth(pool).liquidity();
        if (sqrtP == 0 || liq == 0) return 0;
        uint256 raw = IV3PoolDepth(pool).token0() == USDG
            ? FullMath.mulDiv(FullMath.mulDiv(liq, 2 ** 96, sqrtP), K_NUM, K_DEN)
            : FullMath.mulDiv(FullMath.mulDiv(liq, sqrtP, 2 ** 96), K_NUM, K_DEN);
        return raw / 1e6; // USDG carries 6 decimals, so one unit is one dollar
    }

    /// @notice **T-QUOTE-01 — a quote whose declared route is under the depth
    ///         bar must not list.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property that SHOULD
    ///         hold: `allowQuotes` refuses a route whose pool cannot absorb what
    ///         `docs/allowlist.md` calls a minimum. It was red — the row listed
    ///         anyway — and it is green since `Payd.MIN_ROUTE_DEPTH` landed; the
    ///         `AUDIT_RED` gate is gone and it runs in the main suite.
    ///
    ///         **Structural, and deliberately not about a drift.** The audit's
    ///         first draft framed this around cbBTC's WETH route having fallen
    ///         to $4 166; re-measured at the pinned block that route reads
    ///         **$11 291**, comfortably over the bar, and the reading behind the
    ///         $4 166 was an RPC error. So the framing is void and the structure
    ///         is what is left — and the structure needs no drift at all:
    ///         `Payd._requirePool` (`contracts/Payd.sol:907-912`) admits any
    ///         pool on `liquidity() != 0`, and its own comment says it does not
    ///         catch a thin tier. The fixture below is therefore a REAL tier
    ///         that is REAL and thin today, not one that used to be deep.
    ///
    ///         cbBTC/USDG at tier 3000 is such a pool: it exists, it carries
    ///         non-zero liquidity, and its active depth at +1 % is two dollars.
    ///         A timelock that copied `3000` from the token's WETH row into the
    ///         pivot column — the exact mechanical slip
    ///         `test_AListingWithoutItsPoolIsRefused` exists to catch — would
    ///         be waved straight through, and the vault it produces is stamped
    ///         with that quote for life (`removeQuotes` reaches no existing
    ///         vault, §7.5).
    ///
    ///         Severity: Medium. The listing needs the timelock and 48 h of
    ///         notice, so this is a missing guard on a slow, privileged path
    ///         rather than something an attacker reaches.
    ///
    ///         **Fixed 2026-09-11, and the on-chain bar is NOT this test's
    ///         `MIN_DEPTH_USD`.** `Payd.MIN_ROUTE_DEPTH` is **$500**, an order of
    ///         magnitude under the $5 000 `docs/allowlist.md` sets, and that gap
    ///         is deliberate: active liquidity at the current tick is volatile —
    ///         the cbBTC/WETH pool read $158 774, $4 166, $4 927, $2 496, $9 546
    ///         and $11 302 inside a few hours on 2026-09-11 with its deposits
    ///         unchanged — so a $5 000 revert would make the registry's own seed
    ///         deploy or not depending on the block. The contract refuses the
    ///         typo; the policy stays off-chain and re-measured. The fixture
    ///         below reads two dollars, so it is refused either way, and the
    ///         `MIN_DEPTH_USD` premise is kept because the POLICY bar is what
    ///         makes this pool the wrong one to declare a route on.
    // T-QUOTE-01
    function test_AQuoteRouteUnderTheDepthBarIsRefused() public {
        address pool = IV3FactoryPool(V3_FACTORY).getPool(CBBTC, USDG, 3000);
        assertTrue(pool != address(0), "fixture: the cbBTC/USDG tier-3000 pool must exist");
        // The fixture's premise, checked rather than assumed: the pool must be
        // exactly what `_requirePool` waves through — alive, and far too thin.
        assertGt(IV3PoolDepth(pool).liquidity(), 0, "fixture: _requirePool only admits non-zero liquidity");

        uint256 depth = _depthUsdVsPivot(pool);
        emit log_named_address("cbBTC/USDG tier 3000, pool", pool);
        emit log_named_uint("  active depth at +1 %, in $", depth);
        assertLt(depth, MIN_DEPTH_USD, "fixture: the pool must be under the bar for this to prove anything");

        address[] memory q = new address[](1);
        uint24[] memory f = new uint24[](1);
        uint24[] memory w = new uint24[](1);
        uint256[] memory m = new uint256[](1);
        q[0] = CBBTC;
        f[0] = 3000; // the pivot route, declared on a pool holding $2
        m[0] = 32_000; // `Quotelist.s.sol:237` — cbBTC carries 8 decimals

        bool listed;
        vm.prank(timelock);
        try pad.allowQuotes(q, f, w, m) {
            listed = true;
        } catch {}

        assertFalse(listed, "a quote whose declared route is under the $5,000 depth bar must not list");
    }
}
