// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

contract BootstrapTest is CloneBase {
    function _cfg(address timelock) internal returns (VaultTypes.Config memory c) {
        c.escrow = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
        c.factory = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
        c.router = 0xCaf681a66D020601342297493863E78C959E5cb2;
        c.v3Factory = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
        c.weth = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
        c.pivot = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        c.ethPivotFee = 100;
        c.ethUsdFeed = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
        c.creator = makeAddr("creator");
        c.platform = makeAddr("platform");
        c.platformBps = 1_000;
        c.rewardsBps = 7_000;
        c.timelock = timelock;
        c.distributor = address(1); // overwritten by the Bootstrap
        c.deployer = makeAddr("safe");
        c.registry = address(0);
        c.intendedToken = address(0);
    }

    function _allocs() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](5);
        address[5] memory stocks = [
            0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, // QQQ
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, // NVDA
            0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, // GLD
            0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, // SPCX
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d // TSLA
        ];
        for (uint256 i; i < 5; ++i) {
            a[i] = VaultTypes.Allocation(stocks[i], 500, 2000, address(0));
        }
    }

    /// @notice What a launch actually costs, implementations already on chain.
    ///
    /// @dev    THE number behind D5. `test_DeploysBothWiredInOneTransaction`
    ///         deploys the implementations inside its own measurement, which is
    ///         what the platform pays ONCE; a creator pays only what is below.
    function test_MeasureWhatALaunchCosts() public {
        // Paid once by the platform, not by a launch.
        address vaultImpl = address(new FeeVault());
        address distImpl = address(new Distributor());

        uint256 g = gasleft();
        new Bootstrap(
            vaultImpl, distImpl, _cfg(makeAddr("tl")), _allocs(), makeAddr("keeper"), block.timestamp, 1 hours
        );
        uint256 used = g - gasleft();

        console.log("a launch (2 clones + 2 inits):", used);
        // Full deployments cost ~6.1 M. Anything near that means the clones are
        // not being cloned.
        assertLt(used, 1_500_000, "a launch must stay far under a full deployment");
    }

    /// @notice Both contracts come out of ONE transaction, correctly wired. If
    ///         the address prediction were off, the constructor reverts and no
    ///         orphaned contract is left behind.
    function test_DeploysBothWiredInOneTransaction() public {
        address timelock = makeAddr("timelock");
        address keeper = makeAddr("keeper");
        Bootstrap b = new Bootstrap(
            address(new FeeVault()),
            address(new Distributor()),
            _cfg(timelock),
            _allocs(),
            keeper,
            block.timestamp,
            1 hours
        );

        FeeVault vault = b.VAULT();
        Distributor dist = b.DISTRIBUTOR();

        assertEq(vault.DISTRIBUTOR(), address(dist), "the vault does not point at the distributor");
        assertEq(dist.FEE_VAULT(), address(vault), "the distributor does not accept this vault");
        assertEq(vault.TIMELOCK(), timelock, "timelock wired wrong");
        assertEq(dist.TIMELOCK(), timelock, "timelock wired wrong on the distributor side");
        assertEq(dist.EPOCH_LENGTH(), 1 hours, "epoch length");
        assertEq(dist.keeper(), keeper, "keeper wired wrong");
        // Cumulative roots: a single publication in flight, whatever the epoch
        // length. That is what makes the cadence independent of capital.
        assertEq(dist.rootCount(), 0, "no root published at deployment");
    }

    /// @notice The distributor must accept funds ONLY from the vault produced by
    ///         the same bootstrap.
    function test_DistributorRejectsAnyOtherFunder() public {
        Bootstrap b = new Bootstrap(
            address(new FeeVault()),
            address(new Distributor()),
            _cfg(makeAddr("tl")),
            _allocs(),
            makeAddr("keeper"),
            block.timestamp,
            1 hours
        );
        // Read the getter FIRST: it is a call, it would consume the expectRevert.
        Distributor dist = b.DISTRIBUTOR();
        vm.expectRevert(Distributor.NotFeeVault.selector);
        vm.prank(makeAddr("impostor"));
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory eth = new uint256[](1);
        stocks[0] = address(0xBEEF);
        amounts[0] = 1e18;
        eth[0] = 1 ether;
        dist.fundWindow(1, stocks, amounts, eth);
    }
}
