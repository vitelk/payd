// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {FeeVault} from "../contracts/distribution/FeeVault.sol";
import {Distributor} from "../contracts/distribution/Distributor.sol";
import {Bootstrap} from "../contracts/distribution/Bootstrap.sol";
import {FeeVaultV2} from "../contracts/distribution/v2/FeeVaultV2.sol";
import {V2Legs} from "../contracts/distribution/v2/V2Legs.sol";
import {DistributionFactoryV2} from "../contracts/distribution/v2/DistributionFactoryV2.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {IPonsLaunch} from "./Launch.t.sol";

/// @dev The registry, as the vault sees it. Same stub as `Launch.t.sol`'s.
contract PaydStubV2 {
    mapping(address => bool) public isVault;
    mapping(address => bytes32) public modeOf;
    bool public crossModeMigration;

    function add(address v) external {
        isVault[v] = true;
        modeOf[v] = "distribution";
    }
}

/// @notice `FeeVaultV2` is `FeeVault` plus one slice, and this file holds both
///         ends of that sentence: the slice reaches the legs on every basket
///         purchase, and a V2 with no legs spends WEI FOR WEI what a V1
///         spends — the carrier test that says whether a future `FeeVault`
///         fix was ported, the way `test/ModeVault.t.sol` does for the
///         template.
contract FeeVaultV2Test is Test {
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

    uint256 constant EPOCH_LENGTH = 30 minutes;
    uint16 constant CREATOR_TAX_BPS = 400;

    DistributionFactoryV2 factory;
    PaydStubV2 pad;

    address safe = makeAddr("safe");
    address timelock = makeAddr("timelock");
    address platformWallet = makeAddr("platform");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");

    function setUp() public {
        pad = new PaydStubV2();
        factory = new DistributionFactoryV2(
            address(new FeeVaultV2()), address(new Distributor()), address(new V2Legs()), POOL_MANAGER
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

    function _createV2(bytes memory modeData) internal returns (FeeVaultV2 vault, Distributor dist) {
        (address v, address d) = factory.create(_cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, modeData);
        vault = FeeVaultV2(payable(v));
        dist = Distributor(payable(d));
        pad.add(v);
    }

    /// @dev `BasketBought.quoteIn` from the last call's logs — what the basket
    ///      actually had to spend, after the legs took their slice.
    function _lastQuoteIn(Vm.Log[] memory logs) internal pure returns (uint256 quoteIn) {
        bytes32 sig = keccak256("BasketBought(uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            (quoteIn,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
        }
    }

    // ------------------------------------------------------------- the wiring

    function test_TheFactoryWiresTheLegsBothWays() public {
        (FeeVaultV2 vault,) = _createV2(abi.encode(uint256(1_000), uint256(500)));

        V2Legs legs = V2Legs(payable(vault.LEGS()));
        assertTrue(address(legs) != address(0), "the launch asked for legs and must get them");
        assertEq(legs.VAULT(), address(vault), "the legs answer to their vault");
        assertEq(legs.burnBps(), 1_000, "the burn rate travels");
        assertEq(legs.lpBps(), 500, "the LP rate travels");
        assertEq(legs.QUOTE(), address(0), "in the vault's own quote");
        assertEq(legs.MIN_MOVE(), vault.MIN_BUY_QUOTE(), "and the vault's own minimum");
    }

    function test_EmptyModeDataBuildsAPlainVault() public {
        (FeeVaultV2 vault,) = _createV2("");
        assertEq(vault.LEGS(), address(0), "no legs were asked for, none exist");
    }

    function test_ModeDataIsValidatedAtTheDoor() public {
        // Zero spelled out: empty is the one way to say "none".
        vm.expectRevert(DistributionFactoryV2.BadModeData.selector);
        factory.create(_cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, abi.encode(uint256(0), uint256(0)));

        // A leg that is on is at least 5 %.
        vm.expectRevert(DistributionFactoryV2.BadModeData.selector);
        factory.create(_cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, abi.encode(uint256(499), uint256(500)));
        vm.expectRevert(DistributionFactoryV2.BadModeData.selector);
        factory.create(_cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, abi.encode(uint256(500), uint256(1)));

        // Together they never take more than half.
        vm.expectRevert(DistributionFactoryV2.BadModeData.selector);
        factory.create(
            _cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, abi.encode(uint256(4_600), uint256(500))
        );

        // The wrong shape entirely.
        vm.expectRevert(DistributionFactoryV2.BadModeData.selector);
        factory.create(_cfg(), _basket(), keeper, block.timestamp, EPOCH_LENGTH, hex"deadbeef");
    }

    // -------------------------------------------------------------- the slice

    function test_ABasketPurchaseFundsTheLegs() public {
        (FeeVaultV2 vault, Distributor dist) = _createV2(abi.encode(uint256(1_000), uint256(500)));
        V2Legs legs = V2Legs(payable(vault.LEGS()));

        vm.deal(address(this), 2 ether);
        vault.fundRewards{value: 1 ether}();
        vm.warp(block.timestamp + 2 * EPOCH_LENGTH + 1);

        vm.recordLogs();
        uint256 bought = vault.buyBasket(new uint256[](2));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(bought, 0, "the basket still buys");
        assertGt(dist.nextEpoch(), 0, "and the Distributor was credited");

        uint256 toLegs = legs.burnPool() + legs.lpPool();
        assertGt(toLegs, 0, "the legs took their slice");
        // 15 % of the original spend: `quoteIn` in the event is what remained.
        uint256 origSpent = _lastQuoteIn(logs) + toLegs;
        assertEq(toLegs, (origSpent * 1_500) / 10_000, "exactly the declared slice, never more");
        // Split 1000:500 inside the legs.
        assertEq(legs.burnPool(), (toLegs * 1_000) / 1_500, "two thirds to the burn");
        assertEq(legs.lpPool(), toLegs - legs.burnPool(), "the rest to the LP");
    }

    /// @notice **The carrier.** A V2 vault with no legs must spend WEI FOR WEI
    ///         what a V1 spends on the same reserve — `quoteIn` is computed
    ///         from the reserve and the parameters before any pool is touched,
    ///         so any drift here is a divergence between the two contracts,
    ///         not market noise. When a `FeeVault` fix lands, this test is
    ///         what says whether it was carried into the copy.
    function test_AV2WithNoLegsSpendsExactlyLikeAV1() public {
        // The V1 pair, built the way `DistributionFactory` builds it.
        Bootstrap boot = new Bootstrap(
            address(new FeeVault()),
            address(new Distributor()),
            _cfg(),
            _basket(),
            keeper,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault v1 = boot.VAULT();
        pad.add(address(v1));

        (FeeVaultV2 v2,) = _createV2("");

        vm.deal(address(this), 3 ether);
        v1.fundRewards{value: 1 ether}();
        v2.fundRewards{value: 1 ether}();
        vm.warp(block.timestamp + 2 * EPOCH_LENGTH + 1);

        vm.recordLogs();
        v1.buyBasket(new uint256[](2));
        uint256 v1Spent = _lastQuoteIn(vm.getRecordedLogs());

        vm.recordLogs();
        v2.buyBasket(new uint256[](2));
        uint256 v2Spent = _lastQuoteIn(vm.getRecordedLogs());

        assertGt(v1Spent, 0, "the fixture must actually buy");
        assertEq(v2Spent, v1Spent, "no legs means V1 to the wei");
    }

    // ---------------------------------------------------------- the migration

    /// @notice **The production migration, rehearsed end to end** — a V1 vault
    ///         bound to a REAL launch on the real factory migrates into a V2
    ///         with legs, under a pranked timelock. The 48 hours are the only
    ///         thing this test compresses: the redirect, the atomic re-bind,
    ///         the reserve booking and the legs' first meal all run against
    ///         real Pons state, exactly the sequence the $PAYD vault will walk.
    function test_AV1VaultMigratesIntoAV2AndTheLegsStartEating() public {
        Bootstrap boot = new Bootstrap(
            address(new FeeVault()),
            address(new Distributor()),
            _cfg(),
            _basket(),
            keeper,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault v1 = boot.VAULT();
        pad.add(address(v1));

        // A real launch naming the V1 vault as its fee recipient — the same
        // helper and the same trap note as `Launch.t.sol`: startPrank, because
        // every read on the way is a call.
        vm.deal(safe, 10 ether);
        vm.startPrank(safe);
        address tok = _launchFor(address(v1), "PaydV2Rehearsal", "PV2R", bytes32(uint256(0x777)));
        vm.stopPrank();
        v1.bind(tok);

        // The destination: a V2 with legs, aimed at the SAME token — `migrate`
        // compares `LAUNCHER` and `INTENDED_TOKEN`, and this is how the real
        // destination will be minted (`createVaultWith` wires the same cfg).
        VaultTypes.Config memory cfg = _cfg();
        cfg.intendedToken = tok;
        (address v2addr,) = factory.create(
            cfg, _basket(), keeper, block.timestamp, EPOCH_LENGTH, abi.encode(uint256(1_000), uint256(500))
        );
        FeeVaultV2 v2 = FeeVaultV2(payable(v2addr));
        pad.add(v2addr);

        // A reserve worth carrying.
        vm.deal(address(this), 2 ether);
        v1.fundRewards{value: 1 ether}();

        vm.prank(timelock);
        v1.migrate(v2addr);

        assertEq(v1.migratedTo(), v2addr, "the old vault records where it went");
        assertEq(address(v2.token()), tok, "the new vault is bound in the same transaction");
        assertEq(v2.rewardsPool(), 1 ether, "the reserve followed, booked and not merely received");

        // The migrated stream feeds the legs from its very first purchase.
        vm.warp(block.timestamp + 2 * EPOCH_LENGTH + 1);
        v2.buyBasket(new uint256[](2));
        V2Legs legs = V2Legs(payable(v2.LEGS()));
        assertGt(legs.burnPool() + legs.lpPool(), 0, "the legs eat from the first V2 purchase");

        // The pocket is real but still under the minimum move, so it waits —
        // the size check fires before the regime branch. Once it clears the
        // bar the burn runs on the CURVE without waiting for graduation:
        // `test_APreGraduationBurnBuysOnTheCurve` is the proof of that path.
        vm.expectRevert(abi.encodeWithSelector(V2Legs.BelowMinimum.selector, legs.burnPool(), legs.MIN_MOVE()));
        legs.buyAndBurn();
    }

    function _launchFor(address recipient, string memory name_, string memory sym, bytes32 salt)
        internal
        returns (address)
    {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        require(f.launchEnabled(), "Pons: launching is closed");

        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: name_,
            symbol: sym,
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "https://paydprotocol.eth.limo", ""),
            creatorFeeRecipient: recipient,
            creatorTaxBps: CREATOR_TAX_BPS,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: salt
        });

        (address t,) = f.launchToken{value: f.launchFee()}(p, 0, address(0));
        return t;
    }
}
