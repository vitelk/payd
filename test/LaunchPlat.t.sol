// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice **P7, played end to end: $PAYD launched through our own Payd.**
///
/// @dev    The parameters are the ones frozen in `PLAN.md` §8ter, and the last
///         assertion is the point of the whole file: it checks that they
///         actually produce 3.00 % to holders and 0.70 % to the creator, read
///         back from `economics()` rather than recomputed here.
///
///         **It also proves the ordering costs TWO waits, not three.** The
///         allowlist and the vault creation are independent operations: both
///         can be scheduled at once and executed in sequence 48 h later, as
///         long as the allowlist executes first — `createVaultFor` validates
///         the basket against it. Binding the Treasury needs the launch to
///         exist, so it is a second wave and cannot be folded in.
contract LaunchPlatTest is Test {
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

    // --- PLAN.md §8ter
    uint16 constant CREATOR_TAX_BPS = 300; // 4,00 % total with the 1 % curve fee
    uint256 constant REWARDS_BPS = 8_109; // holders 3.00 % · creator 0.70 %
    uint256 constant PLATFORM_BPS = 0; // $PAYD does not tax itself
    uint256 constant EPOCH = 30 minutes;

    Timelock timelock;
    Treasury treasury;
    Payd pad;

    /// @dev The second authority -- `Payd.setFactory`, `Treasury.bindPlatform`,
    ///      `Treasury.migrateTreasury`. It approves, it never triggers. A
    ///      separate address, because on the same key as the Safe it would close
    ///      nothing.
    address generationKey = makeAddr("generation key");
    DistributionFactory factory = new DistributionFactory();
    address safe = makeAddr("the Payd safe");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");

    function setUp() public {
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new Timelock(proposers, executors);
        treasury = _treasury();
        pad = _registry();
    }

    /// @dev Each construction in its own function, **for the stack**. `via_ir`
    ///      -- enabled so that `FeeVault` fits under EIP-170 -- hit a "stack too
    ///      deep" that the old pipeline swallowed: three structs of ten to
    ///      thirteen fields in the same frame. Same remedy as `_buyLegs` and
    ///      `_create` on the contract side.
    ///
    ///      $PAYD's vault is not built here: this test is only about the
    ///      `createVaultFor` path, and the empty genesis (`launcher = 0`) leaves
    ///      the constructor minting nothing.
    function _treasury() internal returns (Treasury) {
        return new Treasury(
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
    }

    function _registry() internal returns (Payd) {
        return new Payd(
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
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
    }

    function _schedule(bytes memory data, bytes32 salt) internal returns (bytes memory) {
        uint256 delay = timelock.getMinDelay();
        vm.prank(safe);
        timelock.schedule(address(0), 0, data, bytes32(0), salt, delay);
        return data;
    }

    /// @dev The Pons launch, moved into its own function **for the stack**.
    ///      `via_ir` -- enabled so that `FeeVault` fits under EIP-170 -- hit a
    ///      "stack too deep" here that the old pipeline swallowed: a struct of
    ///      ten fields plus a dozen locals in the same frame. Same remedy as
    ///      `_buyLegs` and `_create` on the contract side.
    function _launch(IPonsLaunch f, address vault) internal returns (address token) {
        uint256 fee = f.launchFee();
        vm.deal(safe, fee + 10 ether);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "Payd",
            symbol: "PAYD",
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "https://paydprotocol.eth.limo", ""),
            creatorFeeRecipient: vault,
            creatorTaxBps: CREATOR_TAX_BPS,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: bytes32(uint256(0x7))
        });
        vm.prank(safe);
        (token,) = f.launchToken{value: fee}(p, 0, address(0));
    }

    /// @dev Wave one, in its own frame. See the comment on `test_TheWholeOfP7`
    ///      for the reason.
    function _waveOne() internal {
        address[] memory st = new address[](2);
        uint24[] memory fe = new uint24[](2);
        address[] memory fd = new address[](2);
        (st[0], fe[0], fd[0]) = (NVDA, 500, address(0));
        (st[1], fe[1], fd[1]) = (QQQ, 500, address(0));

        bytes memory allowData = abi.encodeCall(Payd.allowStocks, (st, fe, fd));
        bytes memory vaultData = abi.encodeCall(
            Payd.createVaultFor,
            (address(factory), safe, _basket(), REWARDS_BPS, EPOCH, address(0), PLATFORM_BPS, address(0), "")
        );

        uint256 delay = timelock.getMinDelay();
        vm.startPrank(safe);
        timelock.schedule(address(pad), 0, allowData, bytes32(0), bytes32("allow"), delay);
        timelock.schedule(address(pad), 0, vaultData, bytes32(0), bytes32("vault"), delay);
        vm.stopPrank();

        vm.warp(block.timestamp + delay);

        // Anyone executes — the executor role is open, and the ORDER is ours.
        address anyone = makeAddr("a passer-by");
        vm.prank(anyone);
        timelock.execute(address(pad), 0, allowData, bytes32(0), bytes32("allow"));
        vm.prank(anyone);
        timelock.execute(address(pad), 0, vaultData, bytes32(0), bytes32("vault"));
    }

    function test_TheWholeOfP7() public {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        if (!f.launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }

        // ---- wave one: the allowlist and the vault, scheduled together -----
        //
        // Both are timelock operations and they do not depend on each other to
        // be SCHEDULED — only to be EXECUTED, in order. Scheduling them in the
        // same session costs one 48 h wait instead of two, which is the whole
        // reason this is worth measuring rather than assuming.
        //
        // **The block is explicitly scoped**, and that is not style: three
        // arrays and two `bytes memory` living to the end of the function made
        // `via_ir` fail on a "stack too deep". Enclosing them makes them die
        // here. `via_ir` is enabled so that `FeeVault` fits under EIP-170 — see
        // `foundry.toml`.
        _waveOne();

        address vault = pad.vaults()[0];
        assertEq(FeeVault(payable(vault)).PLATFORM_BPS(), 0, "$PAYD does not pay the platform share");
        assertEq(FeeVault(payable(vault)).LAUNCHER(), safe, "and the Safe is who must launch it");

        // ---- the Safe launches on Pons, with the vault as fee recipient -----
        address token = _launch(f, vault);

        // ---- anyone binds. Neither condition is the caller's to satisfy. ----
        vm.prank(makeAddr("a passer-by"));
        FeeVault(payable(vault)).bind(token);
        assertEq(address(FeeVault(payable(vault)).token()), token, "the vault carries $PAYD");

        // ---- what the Treasury is still waiting for ------------------------
        //
        // Wiring the Treasury takes TWO keys and one timelock operation --
        // `approvePlatform` by the Ledger, `bindPlatform` by the timelock -- and
        // it is not on launch night's critical path: this contract is empty at
        // genesis, it only fills with the platform shares of THIRD-PARTY
        // launches. `Treasury.t.sol` holds that door in full.
        assertEq(address(treasury.platformVault()), address(0), "nothing is wired until both keys have spoken");

        // ---- and the numbers the parameters were chosen for ----------------
        _checkEconomics(vault);
    }

    /// @dev The four numbers, in their own function **for the stack**.
    ///      `economics()` returns seven values; receiving them in the main test's
    ///      frame, already loaded with three arrays and two `bytes memory`, made
    ///      `via_ir` fail on a "stack too deep" that the old pipeline swallowed.
    ///      `via_ir` is enabled so that `FeeVault` fits under EIP-170 -- see
    ///      `foundry.toml`.
    function _checkEconomics(address vault) internal view {
        (,,, uint256 gross, uint256 rewards, uint256 creator, uint256 platform) = FeeVault(payable(vault)).economics();

        console.log("gross of volume, bps  ", gross);
        console.log("  to holders          ", rewards);
        console.log("  to the creator      ", creator);
        console.log("  to the platform     ", platform);

        assertEq(gross, 370, "3.70 % reaches the vault");
        assertEq(rewards, 300, "3.00 % to holders");
        assertEq(creator, 70, "0.70 % to the creator");
        assertEq(platform, 0, "and nothing to the platform");
    }
}
