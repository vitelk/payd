// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice The three fields the form DOES NOT ASK FOR are exactly the ones
///         where a wrong value breaks the launch permanently.
///
/// @dev    `front/src/pons.ts` builds the `launchToken` transaction on the
///         creator's behalf and locks `creatorFeeRecipient`, `pairToken` and
///         `expectedEconomics`. That is a claim about the contract, not an
///         interface preference -- and an untested claim is only a comment.
///
///         Each test below really launches on the Pons factory with ONE field
///         changed, and shows that `bind` refuses. The first one shows that the
///         form's combination does go through.
///
///         What is NOT tested here: `expectedEconomics`. That is a commitment
///         Pons checks itself at launch, not at `bind` -- a stale value makes
///         `launchToken` fail before this file gets a word in. The front end
///         re-reads it just before sending for that reason.
contract LaunchFormTest is Test {
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

    Timelock internal timelock;
    Payd internal pad;
    /// @dev The second authority -- `Payd.setFactory`, `Treasury.bindPlatform`,
    ///      `Treasury.migrateTreasury`. It approves, it never triggers. A
    ///      separate address, because on the same key as the Safe it would close
    ///      nothing.
    address internal generationKey = makeAddr("generation key");
    DistributionFactory internal factory = new DistributionFactory();
    address internal safe = makeAddr("safe");
    address internal creator = makeAddr("creator");
    address internal anyone = makeAddr("a passer-by");

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new Timelock(proposers, executors);

        Treasury treasury = new Treasury(
            Treasury.Wiring({
                timelock: address(timelock),
                devWallet: makeAddr("dev"),
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
        pad = new Payd(
            Payd.Wiring({
                timelock: address(timelock),
                platform: address(treasury),
                keeper: makeAddr("keeper"),
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

        // The allowlist, without which `createVault` refuses every basket.
        address[] memory st = new address[](2);
        uint24[] memory fe = new uint24[](2);
        address[] memory fd = new address[](2);
        (st[0], fe[0], fd[0]) = (NVDA, 500, address(0));
        (st[1], fe[1], fd[1]) = (QQQ, 500, address(0));
        bytes memory data = abi.encodeCall(Payd.allowStocks, (st, fe, fd));

        uint256 delay = timelock.getMinDelay();
        vm.prank(safe);
        timelock.schedule(address(pad), 0, data, bytes32(0), bytes32("allow"), delay);
        vm.warp(block.timestamp + delay);
        timelock.execute(address(pad), 0, data, bytes32(0), bytes32("allow"));
    }

    /// @dev The vault, created the way the form creates it: by the creator
    ///      themselves, through `createVault` and not `createVaultFor`.
    function _vault() internal returns (address vault) {
        VaultTypes.Allocation[] memory a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
        vm.prank(creator);
        (vault,) = pad.createVault(a, 7_000, 30 minutes, address(0));
    }

    /// @dev The parameters as `front/src/pons.ts` assembles them. `who` signs,
    ///      `recipient` and `pair` are the two fields we vary.
    function _launch(address who, address recipient, address pair, bytes32 salt) internal returns (address token) {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        uint256 fee = f.launchFee();
        vm.deal(who, fee + 1 ether);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "Form",
            symbol: "FORM",
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: recipient,
            creatorTaxBps: 300,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, pair),
            salt: salt
        });
        vm.prank(who);
        (token,) = f.launchToken{value: fee}(p, 0, pair);
    }

    function _skip() internal returns (bool) {
        if (IPonsLaunch(FACTORY).launchEnabled()) return false;
        console.log("SKIPPED: Pons has closed launching");
        return true;
    }

    /// @notice The form's exact combination binds on the first try.
    function test_TheFormsCombinationBinds() public {
        if (_skip()) return;
        address vault = _vault();
        address token = _launch(creator, vault, address(0), bytes32(uint256(0xF01)));

        vm.prank(anyone); // step 3 is open to everyone, and the form says so
        FeeVault(payable(vault)).bind(token);
        assertEq(address(FeeVault(payable(vault)).token()), token, "the vault carries the token");
    }

    /// @notice The field the form hides first: the fees pointed elsewhere.
    function test_AFeeRecipientThatIsNotTheVaultCannotBind() public {
        if (_skip()) return;
        address vault = _vault();
        // The PLAUSIBLE mistake: the creator puts themselves in, as on any
        // other registry. The launch succeeds, and it is unrepairable --
        // changing recipient at Pons takes 3 days and belongs to the current
        // recipient alone.
        address token = _launch(creator, creator, address(0), bytes32(uint256(0xF02)));

        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        vm.prank(anyone);
        FeeVault(payable(vault)).bind(token);
    }

    /// @notice The second: a pair that is not native ETH.
    function test_ANonEthPairCannotBind() public {
        if (_skip()) return;
        address vault = _vault();
        address token = _launch(creator, vault, USDG, bytes32(uint256(0xF03)));

        vm.expectRevert(abi.encodeWithSelector(FeeVault.UnsupportedPair.selector, USDG));
        vm.prank(anyone);
        FeeVault(payable(vault)).bind(token);
    }

    /// @notice The third is not a field, it is the SIGNER. Pons records
    ///         `msg.sender` as the deployer and `bind` compares it to `LAUNCHER`
    ///         -- launching from a wallet other than the one that created the
    ///         vault produces an unbindable launch. The front end reads
    ///         `LAUNCHER` and refuses before sending, because Pons does not
    ///         refund the fee.
    function test_AnotherWalletCannotBind() public {
        if (_skip()) return;
        address vault = _vault();
        address token = _launch(makeAddr("someone else"), vault, address(0), bytes32(uint256(0xF04)));

        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        vm.prank(anyone);
        FeeVault(payable(vault)).bind(token);
    }
}
