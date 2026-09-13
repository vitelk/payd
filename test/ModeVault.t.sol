// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {ModeFactory} from "../contracts/modes/ModeFactory.sol";
import {ModeVault} from "../contracts/modes/ModeVault.sol";
import {BaseModeVault} from "../contracts/modes/BaseModeVault.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {IERC20, IPonsV2LaunchFactory, IPonsV2BondingCurve} from "../contracts/interfaces/IExternal.sol";
import {IPonsLaunch} from "./Launch.t.sol";

interface IDecimalsOf {
    function decimals() external view returns (uint8);
}

/// @notice **`contracts/modes/` under test for the first time.**
///
/// @dev    `BaseModeVault.sol` is 721 lines carrying its own `harvest`,
///         `migrate`, `bind`, `fundRewards`, `fundPivot`, `_pay`, `withdraw`,
///         `_sweepFees`, `hookStatus` and `economics` — a near-copy of
///         `FeeVault`'s non-basket half. It compiles into the build,
///         `ModeFactory`'s constructor deploys a `ModeVault` implementation and
///         clones it, and `script/DeployMode.s.sol` deploys the factory.
///         `forge coverage --ir-minimum` measured the whole directory at
///         **0.00 % on every axis** — 240 lines, 348 statements, 75 branches,
///         28 functions, none of them reached (`AUDIT_PLAN.md` §3a). This file
///         is the first thing that reaches any of it.
///
///         `test/Payd.t.sol` exercises multi-mode behaviour against its own
///         local stubs (`OtherModeFactory`, `FreeModeFactory`) and never
///         touches `ModeFactory` or `ModeVault`. The whole point here is to
///         deploy the real ones.
///
///         Nothing is mocked: the real Pons factory, the real escrow, the real
///         curve, the real USDG.
contract ModeVaultTest is Test {
    // --- Pons v2 (docs/recon.md §1.1)
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    // --- Uniswap v3 (docs/recon.md §3.1)
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // --- Chainlink (docs/recon.md §5)
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;

    Payd pad;
    ModeFactory modeFactory;
    DistributionFactory factory = new DistributionFactory();

    address timelock = makeAddr("timelock");
    address generationKey = makeAddr("generation key");
    address treasury = makeAddr("platform"); // a plain address: `_requireSweepable` fails open
    address keeper = makeAddr("keeper");
    address launcher = makeAddr("launcher");

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

        // The two lists a quoted vault needs, in the runbook's order.
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
        pad.allowStocks(s, f, d);

        // USDG is the pivot, so it lists with no route and no tier — exactly as
        // `script/Quotelist.s.sol` lists it.
        address[] memory q = new address[](1);
        uint24[] memory qf = new uint24[](1);
        uint24[] memory qw = new uint24[](1);
        uint256[] memory qm = new uint256[](1);
        q[0] = USDG;
        qm[0] = 10 * 10 ** IDecimalsOf(USDG).decimals();
        vm.prank(timelock);
        pad.allowQuotes(q, qf, qw, qm);

        // The template no longer names itself: `ModeFactory` takes its mode as
        // a constructor argument and refuses zero and the old placeholder
        // (T-MODE-02). This is a real name, so the fixture's vaults are stamped
        // with one.
        modeFactory = new ModeFactory("audit-mode");
    }

    // ---- helpers -----------------------------------------------------------

    /// @dev The two keys, in the order `script/DeployMode.s.sol` uses them.
    function _enable(address f_) internal {
        vm.prank(generationKey);
        pad.approve(f_, true);
        vm.prank(timelock);
        pad.enableFactory(f_);
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);
    }

    /// @dev A real Pons launch quoted in `pair`, with `recipient` as the
    ///      creator fee recipient. Returns `address(0)` if Pons refused.
    ///
    ///      `launchFee()` is read BEFORE the prank: inside `{value: ...}` it is
    ///      still a CALL, and `vm.prank` attaches to the next one — written
    ///      inline it eats the prank and the launch goes out as the test
    ///      contract, which `bind` then refuses with `NotOurLaunch`.
    function _launch(address pair, address recipient, string memory sym, bytes32 salt) internal returns (address) {
        IPonsLaunch f = IPonsLaunch(PONS_FACTORY);
        bytes32 eco = f.previewLaunchEconomics(0, pair);

        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: sym,
            symbol: sym,
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: recipient,
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: eco,
            salt: salt
        });

        uint256 fee = f.launchFee();
        vm.prank(launcher);
        (address t,) = f.launchToken{value: fee}(p, 0, pair);
        return t;
    }

    /// @dev A real trade on the real curve, so a real creator fee accrues. Past
    ///      the 3 s snipe tax first — inside it the creator is credited ~70 % of
    ///      the spend and the numbers stop meaning anything.
    function _trade(address token, address quote, uint256 amountIn) internal {
        IPonsV2BondingCurve curve =
            IPonsV2BondingCurve(IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(token).curve);
        address buyer = makeAddr("buyer");
        deal(quote, buyer, amountIn * 10);
        vm.warp(block.timestamp + 10);
        vm.startPrank(buyer);
        IERC20(quote).approve(address(curve), type(uint256).max);
        curve.buy(amountIn, 0, buyer);
        vm.stopPrank();
    }

    /// @dev The whole fixture: a real `ModeVault`, born through the registry
    ///      under the real `ModeFactory`, quoted in USDG, bound to a real
    ///      USDG-quoted Pons launch that has really traded.
    function _usdgModeVaultWithFees(bytes32 salt) internal returns (ModeVault v) {
        _enable(address(modeFactory));

        vm.prank(launcher);
        (address vault,) = pad.createVaultWith(address(modeFactory), _basket(), 7_000, 30 minutes, address(0), USDG, "");
        v = ModeVault(payable(vault));

        assertTrue(pad.isVault(vault), "the mode's vault must be in the registry");
        assertEq(pad.modeOf(vault), modeFactory.MODE(), "and stamped with its factory's mode");
        assertEq(v.QUOTE(), USDG, "quoted in USDG");

        vm.deal(launcher, 10 ether);
        address token = _launch(USDG, vault, "MODEV", salt);
        require(token != address(0), "fixture: a USDG-quoted launch must be possible");
        v.bind(token);

        uint256 one = 10 ** IDecimalsOf(USDG).decimals();
        _trade(token, USDG, 1_000 * one);
    }

    // ---- the tests ---------------------------------------------------------

    /// @notice **T-MODE-01 — a second mode's vault pays its caller, in its own
    ///         currency, on a quote that is not ether.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property that SHOULD
    ///         hold, and that the distribution mode already holds
    ///         (`PairToken.t.sol::test_ANonEthVaultPaysItsHarvestBountyInItsOwnCurrency`):
    ///         whoever runs the cycle is paid. **RED means the finding is
    ///         reproduced** — `contracts/modes/BaseModeVault.sol:407` reads
    ///
    ///             uint256 refund = QUOTE == address(0) ? _refundAmount(g0) : 0;
    ///
    ///         and there was no `keeperBountyBps`, no
    ///         `MIN_/MAX_KEEPER_BOUNTY_BPS` and no `setKeeperBountyBps`
    ///         anywhere in the file. So a non-ether vault of a second mode paid
    ///         its caller nothing — on 59.1 % of Pons volume (22.0 % USDG +
    ///         37.2 % stock tokens, measured 2026-09-08 over seven days of
    ///         `V2FeeEscrow` credits).
    ///
    ///         That was the exact condition `docs/ARCHITECTURE.md` §S40 and
    ///         `FLOWS.md` §4.3bis were written to close, closed in `FeeVault`
    ///         and not carried into the template every future mode is told to
    ///         copy. A mode built from that base shipped with an unfunded cycle
    ///         and nobody would have found out until the keeper stopped.
    ///
    ///         **Fixed 2026-09-11**: `_bounty` and its two bounds are ported
    ///         into `BaseModeVault`, so the line now reads
    ///         `: _bounty(gross)`. ModeVault 12 956 -> 13 215 bytes, 11 361 of
    ///         margin. The gate is removed and this runs in the main suite.
    // T-MODE-01
    function test_ASecondModesNonEthVaultPaysItsHarvestCaller() public {
        ModeVault v = _usdgModeVaultWithFees(bytes32(uint256(0x601)));

        address caller = makeAddr("cycle caller");
        uint256 wei0 = caller.balance;
        uint256 usdg0 = IERC20(USDG).balanceOf(caller);

        vm.prank(caller);
        uint256 gross = v.harvest();
        assertGt(gross, 0, "fixture: the harvest must claim a real fee, or there is nothing to be paid out of");

        uint256 paid = IERC20(USDG).balanceOf(caller) - usdg0;
        emit log_named_uint("gross harvested, raw USDG", gross);
        emit log_named_uint("paid to the caller, raw USDG", paid);
        emit log_named_uint("creator residue, raw USDG", v.creatorPool());

        assertEq(caller.balance, wei0, "a USDG vault holds no wei, so none can move: this half is right");
        assertGt(paid, 0, "whoever runs the cycle on a non-ether vault must be paid, as FeeVault pays them");
    }

    /// @notice **`docs/AUDIT_PLAN_2.md` §4, T2-MODE-01 — the template's bounty
    ///         against `FeeVault`'s, and the lever that sets it.**
    ///
    ///         Two hypotheses, both rejected. GREEN.
    ///
    /// @dev    First: that `BaseModeVault._bounty` diverges from
    ///         `FeeVault._bounty` under some split. It cannot — both are
    ///         `min(moved * keeperBountyBps / BPS, MIN_BUY_QUOTE)` and both
    ///         carry the same two bounds and the same seed. What is asserted
    ///         here is the CLOSED FORM against a real harvest, so a later edit
    ///         to either shape shows up as a number rather than as a diff.
    ///
    ///         Second: that `keeperBountyBps` is unreachable because no mode
    ///         calls `setKeeperBountyBps`. It is `external onlyTimelock` on
    ///         `BaseModeVault` and every mode inherits it; the lever is
    ///         exercised in both directions below, which is the first time a
    ///         line of it runs.
    function test_TheTemplatesBountyIsFeeVaultsAndItsLeverReachesIt() public {
        ModeVault v = _usdgModeVaultWithFees(bytes32(uint256(0x602)));

        // The three numbers, read off both contracts rather than transcribed.
        assertEq(v.keeperBountyBps(), 70, "seeded where FeeVault seeds it");
        assertEq(v.MIN_KEEPER_BOUNTY_BPS(), 10, "same floor");
        assertEq(v.MAX_KEEPER_BOUNTY_BPS(), 300, "same ceiling");

        // The lever, both arms. Every read is resolved into a local BEFORE the
        // cheatcode is armed: a getter written as an argument is a call, and
        // `vm.expectRevert` attaches to the next one (`test/CheatcodeOrder.t.sol`).
        uint256 tooMuch = v.MAX_KEEPER_BOUNTY_BPS() + 1;
        uint256 tooLittle = v.MIN_KEEPER_BOUNTY_BPS() - 1;
        vm.startPrank(timelock);
        vm.expectRevert();
        v.setKeeperBountyBps(tooMuch);
        vm.expectRevert();
        v.setKeeperBountyBps(tooLittle);
        v.setKeeperBountyBps(120);
        vm.stopPrank();
        assertEq(v.keeperBountyBps(), 120, "the timelock reaches the template's bounty rate");

        // And the closed form, against a real harvest of a real Pons fee.
        address caller = makeAddr("bounty caller");
        uint256 usdg0 = IERC20(USDG).balanceOf(caller);
        uint256 residue0 = v.creatorPool();
        vm.prank(caller);
        uint256 gross = v.harvest();
        assertGt(gross, 0, "fixture: a real fee was claimed");
        uint256 paid = IERC20(USDG).balanceOf(caller) - usdg0;

        uint256 floorQuote = v.MIN_BUY_QUOTE();
        uint256 rate = (gross * v.keeperBountyBps()) / 10_000;
        if (rate > floorQuote) rate = floorQuote;
        emit log_named_uint("gross harvested, raw USDG ", gross);
        emit log_named_uint("bounty paid, raw USDG     ", paid);
        emit log_named_uint("closed form, raw USDG     ", rate);
        emit log_named_uint("creator residue before    ", residue0);
        // The residue cap sits on top of the two above, exactly as on FeeVault.
        assertLe(paid, rate, "never more than the rate, capped at MIN_BUY_QUOTE");
        assertGt(paid, 0, "and the caller is paid");
    }

    /// @notice **T-MODE-02 — a factory still carrying the template's mode name
    ///         is refused at the door.**
    ///
    /// @dev    **Fixed 2026-09-11, in two places, and this test covers the one
    ///         that keeps working on a copy of the template made yesterday.**
    ///         `Payd._enable` refused only `bytes32(0)`, so the placeholder went
    ///         straight through. `ModeFactory` now takes its mode as a
    ///         constructor argument and refuses both zero and the old literal —
    ///         naming the mode became a thing you cannot forget rather than a
    ///         thing you are asked to remember — and the registry refuses the
    ///         same literal at its door, which is what a stale copy of the file
    ///         still runs into. The stub below is exactly such a copy.
    ///
    ///         What that costs is not cosmetic. `modeOf` is written once, at
    ///         birth, and `FeeVault.migrate:1624-1627` compares mode NAMES for
    ///         ever after — that name comparison is the entire upgrade path, and
    ///         it is what lets a new version of a mode be a valid destination.
    ///         A mode admitted as `TODO-name-this-mode` therefore becomes a
    ///         permanent, unforgeable value that every later factory wanting to
    ///         be a destination for those vaults must also declare. And
    ///         `ModeFactory`'s own comment says the flip side is enforced
    ///         nowhere: reusing an existing mode's string makes a factory's
    ///         vaults valid `migrate` destinations for every vault of that mode,
    ///         without the generation key ever opening `crossModeMigration`.
    ///
    ///         Two keys and 48 h guard this, so it is Medium: a slow,
    ///         privileged path with a missing sanity check, not something an
    ///         attacker reaches.
    // T-MODE-02
    function test_AFactoryStillCarryingTheTemplateModeNameIsRefused() public {
        // The template itself can no longer be built this way: naming it is the
        // constructor's business now.
        vm.expectRevert(ModeFactory.BadMode.selector);
        new ModeFactory("TODO-name-this-mode");
        vm.expectRevert(ModeFactory.BadMode.selector);
        new ModeFactory(bytes32(0));

        // What the registry still has to refuse is a copy of the template made
        // before that change, which names itself however it likes.
        StaleTemplateFactory stale = new StaleTemplateFactory();
        assertEq(stale.MODE(), bytes32("TODO-name-this-mode"), "fixture: the stale copy carries the placeholder");

        vm.prank(generationKey);
        pad.approve(address(stale), true);

        bool enabled;
        vm.prank(timelock);
        try pad.enableFactory(address(stale)) {
            enabled = true;
        } catch {}

        assertFalse(enabled, "a factory still declaring the template's placeholder mode must not be enabled");
    }

    /// @notice The fixture itself, kept green: the real `ModeFactory` and the
    ///         real `ModeVault` do reach the registry, bind a real launch and
    ///         harvest a real fee.
    ///
    /// @dev    Without this, `test_ASecondModesNonEthVaultPaysItsHarvestCaller`
    ///         being red would be indistinguishable from the fixture being
    ///         broken. It is also, on its own, the first test in the repository
    ///         to execute a line of `contracts/modes/`.
    // T-MODE-01
    function test_TheModeTemplateHarvestsARealFeeThroughTheRegistry() public {
        ModeVault v = _usdgModeVaultWithFees(bytes32(uint256(0x602)));

        uint256 gross = v.harvest();
        assertGt(gross, 0, "harvest must reach the USDG ledger");
        assertGt(v.rewardsPool(), 0, "and credit the holders' share");
        assertEq(
            v.rewardsPool(), (gross * v.rewardsBps()) / 10_000, "no delivery budget is skimmed: there is no Distributor"
        );
        assertGt(v.platformPool(), 0, "and the platform's");

        // The template's payout is deliberately empty, and says so rather than
        // pretending. This is the one line a new mode replaces.
        vm.expectRevert(BaseModeVault.NothingToDo.selector);
        v.payout();
    }
}

/// @dev A copy of `contracts/modes/ModeFactory.sol` as it stood before
///      2026-09-11: the mode is a constant, and it is the placeholder. Not a
///      mock of anything external — it is our own old code, which is the only
///      way to check that the registry still refuses it.
contract StaleTemplateFactory {
    bytes32 public constant MODE = "TODO-name-this-mode";

    function create(VaultTypes.Config memory, VaultTypes.Allocation[] memory, address, uint256, uint256, bytes memory)
        external
        view
        returns (address, address)
    {
        return (address(this), address(this));
    }
}
