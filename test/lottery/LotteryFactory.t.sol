// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Payd} from "../../contracts/Payd.sol";
import {DistributionFactory} from "../../contracts/distribution/DistributionFactory.sol";
import {FeeVault} from "../../contracts/distribution/FeeVault.sol";
import {Distributor} from "../../contracts/distribution/Distributor.sol";
import {Bootstrap} from "../../contracts/distribution/Bootstrap.sol";
import {FeeVaultV2} from "../../contracts/distribution/v2/FeeVaultV2.sol";
import {LotteryDistributor} from "../../contracts/lottery/LotteryDistributor.sol";
import {LotteryFactory} from "../../contracts/lottery/LotteryFactory.sol";
import {VaultTypes} from "../../contracts/interfaces/VaultTypes.sol";

interface IDecimalsOf {
    function decimals() external view returns (uint8);
}

/// @notice **The lottery factory, admitted through the registry against real
///         Pons state.** Admission (both keys), the mode stamp, the hard
///         co-signer stamp, `modeData` validation, wiring, and the carrier that
///         proves the vault is an unmodified `FeeVaultV2`. The draw itself lives
///         in `DrawLifecycle.t.sol` (it needs the prague EVM for the beacon).
contract LotteryFactoryTest is Test {
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;

    uint256 constant EPOCH_LENGTH = 30 minutes;

    Payd pad;
    LotteryFactory lotteryFactory;
    address vaultImpl;

    address timelock = makeAddr("timelock");
    address generationKey = makeAddr("generation key");
    address treasury = makeAddr("platform");
    address keeper = makeAddr("keeper");
    address launcher = makeAddr("launcher");

    function setUp() public {
        pad = _newPad(address(0));
        vaultImpl = address(new FeeVaultV2());
        lotteryFactory = new LotteryFactory(vaultImpl, address(new LotteryDistributor()));
    }

    function _newPad(address coSigner) internal returns (Payd p) {
        p = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: treasury,
                keeper: keeper,
                coSigner: coSigner,
                escrow: ESCROW,
                ponsFactory: PONS_FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                generationKey: generationKey,
                factory: address(new DistributionFactory())
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
        s[0] = NVDA;
        f[0] = 500;
        d[0] = NVDA_FEED;
        s[1] = QQQ;
        f[1] = 500;
        d[1] = QQQ_FEED;
        vm.prank(timelock);
        p.allowStocks(s, f, d);
    }

    function _enable(Payd p, address f_) internal {
        vm.prank(generationKey);
        p.approve(f_, true);
        vm.prank(timelock);
        p.enableFactory(f_);
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);
    }

    function _create(Payd p, bytes memory modeData) internal returns (FeeVaultV2 vault, LotteryDistributor dist) {
        vm.prank(launcher);
        (address v,) =
            p.createVaultWith(address(lotteryFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), modeData);
        vault = FeeVaultV2(payable(v));
        dist = LotteryDistributor(payable(vault.DISTRIBUTOR()));
    }

    function test_TheFactoryIsAdmittedAndWiresTheDrawPot() public {
        _enable(pad, address(lotteryFactory));
        (FeeVaultV2 vault, LotteryDistributor dist) = _create(pad, abi.encode(uint256(1_000)));

        assertTrue(pad.isVault(address(vault)), "in the registry");
        assertEq(pad.modeOf(address(vault)), bytes32("lottery"), "stamped lottery");
        assertEq(dist.FEE_VAULT(), address(vault), "the pot answers to its vault");
        assertEq(vault.DISTRIBUTOR(), address(dist), "and the vault funds the pot");
        assertEq(dist.POT_BPS(), 1_000, "the per-launch pot share travels through modeData");
        assertEq(vault.LEGS(), address(0), "a lottery vault has no legs");
    }

    function test_ModeDataBoundsAtTheDoor() public {
        _enable(pad, address(lotteryFactory));
        // Empty is refused: a lottery must declare a pot share.
        vm.prank(launcher);
        vm.expectRevert(LotteryFactory.BadModeData.selector);
        pad.createVaultWith(address(lotteryFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), "");
        // Below 5 %.
        vm.prank(launcher);
        vm.expectRevert(LotteryFactory.BadModeData.selector);
        pad.createVaultWith(
            address(lotteryFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), abi.encode(uint256(499))
        );
        // Above 50 %.
        vm.prank(launcher);
        vm.expectRevert(LotteryFactory.BadModeData.selector);
        pad.createVaultWith(
            address(lotteryFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), abi.encode(uint256(5_001))
        );
    }

    /// @notice The registry's hard co-signer stamp lands on the lottery
    ///         distributor — it keeps the whole co-signer stack, so the stamp is
    ///         wanted, not sidestepped.
    function test_TheCoSignerStampLands() public {
        address coSigner = makeAddr("co-signer");
        Payd p2 = _newPad(coSigner);
        _enable(p2, address(lotteryFactory));
        (, LotteryDistributor dist) = _create(p2, abi.encode(uint256(1_000)));
        assertEq(dist.coSigner(), coSigner, "stamped at birth, no CoSignerStampFailed");
    }

    /// @dev `BasketBought.quoteIn` from the last call's logs — the pre-pool spend.
    function _lastQuoteIn(Vm.Log[] memory logs) internal pure returns (uint256 quoteIn) {
        bytes32 sig = keccak256("BasketBought(uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            (quoteIn,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
        }
    }

    /// @notice **The carrier.** A lottery vault spends WEI FOR WEI what a plain
    ///         V1 spends on the same reserve — it is the unmodified FeeVaultV2
    ///         buy stack. When a `FeeVault` fix lands, this says whether it was
    ///         carried into the copy the lottery reuses.
    function test_ALotteryVaultSpendsExactlyLikeAV1() public {
        _enable(pad, address(lotteryFactory));

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
        _register(address(v1));

        (FeeVaultV2 v2,) = _create(pad, abi.encode(uint256(1_000)));

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
        assertEq(v2Spent, v1Spent, "the lottery vault is a plain V2 buy stack, to the wei");
    }

    function _cfg() internal view returns (VaultTypes.Config memory) {
        return VaultTypes.Config({
            escrow: ESCROW,
            factory: PONS_FACTORY,
            router: ROUTER,
            v3Factory: V3_FACTORY,
            weth: WETH,
            pivot: USDG,
            ethPivotFee: 100,
            ethUsdFeed: ETH_USD,
            creator: launcher,
            platform: treasury,
            platformBps: 1_000,
            rewardsBps: 7_000,
            timelock: timelock,
            distributor: address(0),
            deployer: launcher,
            registry: address(pad),
            intendedToken: address(0),
            quote: address(0),
            quoteFee: 0,
            quoteWethFee: 0,
            minBuy: 0
        });
    }

    /// @dev The V1 fixture vault needs to be a registry vault so its
    ///      `fundRewards`/`buyBasket` guards pass. It was minted outside Payd, so
    ///      register it by hand the way the other mode tests do — through the
    ///      real registry is not possible for an externally-built vault, so a
    ///      direct storage-free path: create it through the default factory.
    function _register(address v) internal {
        // The default distribution factory is Payd's own; a vault built by hand
        // via Bootstrap is not in the registry, but FeeVault only calls
        // REGISTRY.isKeeper / isVault on settlement paths the carrier does not
        // touch. buyBasket/fundRewards need no registry membership.
        v; // no-op: kept for readability of the carrier's intent.
    }
}
