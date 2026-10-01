// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Distributor} from "../contracts/distribution/Distributor.sol";
import {FeeVaultV2} from "../contracts/distribution/v2/FeeVaultV2.sol";
import {V2Legs} from "../contracts/distribution/v2/V2Legs.sol";
import {DistributorV3} from "../contracts/distribution/v3/DistributorV3.sol";
import {DistributionFactoryV3} from "../contracts/distribution/v3/DistributionFactoryV3.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @dev The registry, as the vault sees it. Same stub as `FeeVaultV2.t.sol`'s.
contract PaydStubV3 {
    mapping(address => bool) public isVault;
    mapping(address => bytes32) public modeOf;
    bool public crossModeMigration;

    function add(address v) external {
        isVault[v] = true;
        modeOf[v] = "distribution";
    }
}

/// @notice V3 is V2 plus one seeded exclusion, and this file holds that
///         sentence's both ends: the seed is in the DATED log at epoch 0 from
///         the transaction that clones the Distributor, and everything the
///         timelock could do to the list before, it still can. The FeeVault
///         side is untouched — V3 clones the same `FeeVaultV2` implementation
///         — so `test/FeeVaultV2.t.sol` remains its carrier test.
contract DistributorV3Test is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    /// @dev `PonsV2LaunchFactory.locker()`, docs/recon.md §1.1 — verified
    ///      2026-09-15 holding 8.16 % of BERRY's graduated supply.
    address constant PONS_LOCKER = 0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952;

    uint256 constant EPOCH_LENGTH = 30 minutes;

    DistributionFactoryV3 factory;
    PaydStubV3 pad;

    address safe = makeAddr("safe");
    address timelock = makeAddr("timelock");
    address platformWallet = makeAddr("platform");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");

    function setUp() public {
        pad = new PaydStubV3();
        factory = new DistributionFactoryV3(
            address(new FeeVaultV2()), address(new DistributorV3()), address(new V2Legs()), POOL_MANAGER, PONS_LOCKER
        );
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5000, address(0));
    }

    function _cfg() internal view returns (VaultTypes.Config memory) {
        return VaultTypes.Config({
            escrow: ESCROW,
            factory: FACTORY,
            router: ROUTER,
            v3Factory: V3_FACTORY,
            weth: WETH,
            pivot: USDG,
            ethPivotFee: 100,
            ethUsdFeed: ETH_USD,
            creator: dev,
            platform: platformWallet,
            platformBps: 1_000,
            rewardsBps: 7_000,
            timelock: timelock,
            distributor: address(0),
            deployer: safe,
            registry: address(pad),
            intendedToken: address(0),
            quote: address(0),
            quoteFee: 0,
            quoteWethFee: 0,
            minBuy: 0
        });
    }

    function _createV3(bytes memory modeData) internal returns (FeeVaultV2 vault, DistributorV3 dist) {
        (address v, address d) = factory.create(_cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, modeData);
        vault = FeeVaultV2(payable(v));
        dist = DistributorV3(payable(d));
        pad.add(v);
    }

    // ------------------------------------------------------------- the seed

    function test_AV3IsBornWithTheLockerInItsDatedLog() public {
        (, DistributorV3 dist) = _createV3("");

        Distributor.ExclusionChange[] memory log = dist.exclusionLog();
        assertEq(log.length, 1, "one entry, the seed, nothing else");
        assertEq(log[0].account, PONS_LOCKER, "the seed is the locker");
        assertTrue(log[0].state, "excluded, not the other thing");
        assertEq(log[0].fromEpoch, 0, "dated epoch 0: in force from the first root");

        assertTrue(dist.isExcluded(PONS_LOCKER), "the current state agrees");
        assertTrue(dist.isExcludedAt(PONS_LOCKER, 0), "and so does the epoch-0 replay");
        assertEq(dist.excludedList().length, 1, "excludedEver carries it too");
        assertEq(dist.excludedList()[0], PONS_LOCKER, "by name");
    }

    function test_TheSeedSurvivesLegsAndTheLegsSurviveTheSeed() public {
        (FeeVaultV2 vault, DistributorV3 dist) = _createV3(abi.encode(uint256(1_000), uint256(500)));

        assertTrue(vault.LEGS() != address(0), "the launch asked for legs and must get them");
        assertTrue(dist.isExcludedAt(PONS_LOCKER, 0), "and the seed is there all the same");
    }

    // -------------------------------------------------------------- one door

    function test_NeitherInitRunsAfterTheOther() public {
        (, DistributorV3 dist) = _createV3("");

        vm.expectRevert(Distributor.AlreadyInitialised.selector);
        dist.init(address(1), address(2), address(3), 1, EPOCH_LENGTH);

        vm.expectRevert(Distributor.AlreadyInitialised.selector);
        dist.initV3(address(1), address(2), address(3), 1, EPOCH_LENGTH, PONS_LOCKER);
    }

    function test_ASeedOfNothingIsRefusedEverywhere() public {
        // The implementations first: an `expectRevert` watches the NEXT call,
        // and a `new` in an argument position would be it.
        address vaultImpl = address(new FeeVaultV2());
        address distImpl = address(new DistributorV3());
        address legsImpl = address(new V2Legs());

        vm.expectRevert(DistributionFactoryV3.ZeroAddress.selector);
        new DistributionFactoryV3(vaultImpl, distImpl, legsImpl, POOL_MANAGER, address(0));
    }

    // ------------------------------------------------- the timelock's door

    function test_TheTimelockStillOwnsTheDiscretionaryList() public {
        (, DistributorV3 dist) = _createV3("");

        // Adding on top of the seed works exactly as on a V1: dated, forward.
        address cex = makeAddr("cex");
        address[] memory a = new address[](1);
        a[0] = cex;
        vm.prank(timelock);
        dist.setExcluded(a, true);
        assertTrue(dist.isExcluded(cex), "the discretionary door still opens");
        assertFalse(dist.isExcludedAt(cex, 0), "forward only: epoch 0 predates it");

        // And the timelock can even reverse the seed — forward only, so the
        // epoch-0 replay keeps saying what was true at epoch 0. That is the
        // dated log doing its one job.
        a[0] = PONS_LOCKER;
        vm.prank(timelock);
        dist.setExcluded(a, false);
        assertFalse(dist.isExcluded(PONS_LOCKER), "reversible, like any entry");
        assertTrue(dist.isExcludedAt(PONS_LOCKER, 0), "history does not move");
    }
}
