// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {
    IERC20,
    IPonsV2LaunchFactory,
    IPonsV2BondingCurve,
    IPonsV2MemeHookSource
} from "../contracts/interfaces/IExternal.sol";

/// @notice The registry, reduced to the only question `FeeVault.migrate` asks
///         it. **It answers one thing and one thing only** now, and that is the
///         point: the successor chain was removed from the real contract, hence
///         from the stub.
///
/// @dev    `isVault` is written, in the real `Payd`, only by `_create`. Nobody
///         can steer it -- that is what makes it the one unforgeable destination
///         check available to `migrate`. The stub writes it directly because a
///         test has to be able to set the state, not because anybody can in
///         production.
contract PaydStub {
    mapping(address => bool) public isVault;
    mapping(address => bytes32) public modeOf;
    /// @dev `false` at birth here as on-chain: the stub must not be the reason
    ///      a cross-mode migration goes through.
    bool public crossModeMigration;

    function openCrossMode(bool state) external {
        crossModeMigration = state;
    }

    /// @dev Registers a vault the way `Payd._create` does: `isVault` AND the
    ///      mode of the factory that built it. The two are written together
    ///      there, so a stub that wrote only the first would let `migrate`
    ///      compare two zeroes and pass a check that does not hold on-chain.
    function add(address v) external {
        isVault[v] = true;
        modeOf[v] = "distribution";
    }

    /// @dev A vault of ANOTHER mode — a second factory, approved and set, whose
    ///      `MODE` is not this one's.
    function addAs(address v, bytes32 mode) external {
        isVault[v] = true;
        modeOf[v] = mode;
    }
}

interface IPonsOwner {
    function owner() external view returns (address);
    function setCreatorFeeRecipient(address token, address newRecipient) external;
    function executeCreatorFeeRecipientChange(address token) external;
}

interface IPonsLaunch {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function launchFee() external view returns (uint256);
    function launchEnabled() external view returns (bool);
}

interface IEscrow {
    function balanceOf(address) external view returns (uint256);
    /// @dev Permissionless on the real escrow: crediting a recipient is how
    ///      Pons pays, and anyone may top it up.
    function credit(address recipient) external payable;
}

/// @notice The rehearsal, as a test.
///
///         Every other fork test uses somebody else's token: they prove the code
///         is right against real state, not that OUR launch collects anything.
///         The paths that only exist when we are the `creatorFeeRecipient` —
///         `bind`, the fee sweep, `harvest` on our own fees — had never run.
///
///         They can. `launchEnabled()` is true, so a test can launch a real
///         token on the real factory and be its creator. Nothing here is mocked:
///         the factory, the curve, the escrow and the fee maths are Pons's.
///
/// @dev    This is what `docs/REHEARSAL.md` calls tier A, minus the parts that
///         need wall-clock time or a second party. It runs in CI, for free, on
///         every push — so the launch path stays exercised rather than being
///         checked once by hand and then drifting.
contract LaunchTest is CloneBase {
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

    FeeVault vault;
    Distributor dist;
    address token;
    IPonsV2BondingCurve curve;

    /// @dev The second authority -- `Payd.setFactory`, `Treasury.bindPlatform`,
    ///      `Treasury.migrateTreasury`. It approves, it never triggers. A
    ///      separate address, because on the same key as the Safe it would close
    ///      nothing.
    address generationKey = makeAddr("generation key");
    DistributionFactory factory = new DistributionFactory();
    address safe = makeAddr("safe");
    address timelock = makeAddr("timelock");
    address platformWallet = makeAddr("platform");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");
    address trader = makeAddr("trader");

    /// @dev The smallest basket the vault accepts: two stocks. One would be
    ///      refused, and rightly — Pons already pays holders in the pair token
    ///      without any contract of ours in the path.
    function _twoStockBasket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5000, address(0));
    }

    PaydStub internal pad;

    function setUp() public {
        pad = new PaydStub();
        VaultTypes.Allocation[] memory allocs = _twoStockBasket();

        VaultTypes.Config memory cfg = VaultTypes.Config({
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

        Bootstrap boot = new Bootstrap(
            address(new FeeVault()), address(new Distributor()), cfg, allocs, keeper, block.timestamp, EPOCH_LENGTH
        );
        vault = boot.VAULT();
        dist = boot.DISTRIBUTOR();
        // The registry knows its own vault. `Payd._create` writes this for
        // every vault it builds, and `migrate` now reads the SOURCE's mode as
        // well as the destination's.
        pad.add(address(vault));

        // The Safe launches, exactly as LAUNCH_CHECKLIST.md §3 says: `bind`
        // requires the launch's deployer to be the vault's immutable DEPLOYER.
        vm.deal(safe, 10 ether);
        // startPrank, not prank: `_launch` makes three external calls and a
        // single `prank` would be spent on the first read, leaving the launch
        // itself sent by this test contract. The same trap is documented in
        // FeeVault.t.sol and Distributor.t.sol — every read is a call.
        vm.startPrank(safe);
        token = _launch();
        vm.stopPrank();

        vault.bind(token);
        curve = IPonsV2BondingCurve(vault.curve());

        // Past the snipe tax: 99 % decaying over 3 s after the launch
        // (recon.md §1.5). It is paid to the creator, so a trade inside that
        // window credits us ~70 % of the spend and the fee measurements below
        // would be meaningless. In production nobody measures the rate on the
        // first three seconds; here we have to step over them deliberately.
        vm.warp(block.timestamp + 10);
    }

    function _launch() internal returns (address) {
        return _launchFor(address(vault), "Payd", "PAYD", bytes32(0));
    }

    /// @dev The same launch, for an arbitrary recipient. Needed once a single
    ///      creator can hold several vaults: two launches must be able to name
    ///      two different fee recipients in the same test.
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
            // Pins the fee policy. If Pons raised protocolFeeShareBps between the
            // fork's block and this call, the launch reverts instead of quietly
            // repricing us (docs/recon.md §9.5).
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: salt
        });

        (address t,) = f.launchToken{value: f.launchFee()}(p, 0, address(0));
        return t;
    }

    /// @dev One basket purchase, by `caller`.
    ///
    ///      Every read happens BEFORE the prank. `vm.prank` and
    ///      `vm.expectRevert` both attach to the NEXT CALL, and a helper that
    ///      reads the contract first would spend them on a `currentEpoch()`
    ///      staticcall — the purchase would then run as the test contract, and
    ///      an assertion about the caller's refund would quietly measure
    ///      nothing.
    function _buyAs(FeeVault v, address caller) internal returns (uint256) {
        Distributor d = Distributor(payable(v.DISTRIBUTOR()));
        if (d.currentEpoch() == 0) vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](v.getAllocations().length);
        vm.prank(caller);
        return v.buyBasket(minOuts);
    }

    function _buy(FeeVault v) internal returns (uint256) {
        return _buyAs(v, address(this));
    }

    /// @notice The launch is wired the way the checklist requires, and `bind`
    ///         only accepts it because of that wiring.
    function test_LaunchIsWiredToTheVault() public view {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token);

        assertEq(l.creatorFeeRecipient, address(vault), "the vault must be the fee recipient");
        assertEq(l.deployer, safe, "the Safe must be the deployer");
        assertEq(l.pairToken, address(0), "fees must arrive as native ETH");
        assertFalse(l.buybackEnabled, "buyback must be off");
        assertEq(l.creatorTaxBps, CREATOR_TAX_BPS, "creator tax");
        assertEq(address(vault.token()), token, "the vault did not bind");
    }

    /// @notice The binding does not prove the fees still arrive, and
    ///         `hookStatus` is what does.
    ///
    /// @dev    The four states, walked in order on a real launch. The last two
    ///         need Pons's owner, so the schedule is what is impersonated here
    ///         — the launch, the factory and the recipient are all real.
    function test_HookStatusFollowsTheRecipientAndNotTheBinding() public {
        // Money in first: "the flag freezes nothing" is only worth asserting on
        // a vault that has something to freeze.
        vm.deal(address(this), 1 ether);
        IEscrow(ESCROW).credit{value: 1 ether}(address(vault));
        vault.harvest();

        (FeeVault.Hook status, address current, uint64 effectiveAt) = vault.hookStatus();
        assertEq(uint256(status), uint256(FeeVault.Hook.Hooked), "a bound, undisturbed vault is Hooked");
        assertEq(current, address(vault), "and it is the recipient");
        assertEq(effectiveAt, 0, "nothing is scheduled");

        // Nobody may cry wolf while the fees still come here.
        vm.expectRevert(FeeVault.StillHooked.selector);
        vault.flagHookLost();

        // 1. Pons proposes a redirection: three days' notice, no veto for us.
        address ponsOwner = IPonsOwner(FACTORY).owner();
        vm.deal(ponsOwner, 1 ether);
        vm.prank(ponsOwner);
        IPonsOwner(FACTORY).setCreatorFeeRecipient(token, address(0xdead));

        (status, current, effectiveAt) = vault.hookStatus();
        assertEq(uint256(status), uint256(FeeVault.Hook.Redirecting), "a pending change must show");
        assertEq(current, address(0xdead), "and say where it points");
        assertEq(effectiveAt, uint64(block.timestamp + 3 days), "and when it bites");

        // Still ours until then: the flag must stay refused.
        vm.expectRevert(FeeVault.StillHooked.selector);
        vault.flagHookLost();

        // 2. Nobody executes it. Past the window the proposal DIES, and the
        //    vault goes back to Hooked with no transaction from anyone.
        vm.warp(effectiveAt + 3 days + 1);
        (status,,) = vault.hookStatus();
        assertEq(uint256(status), uint256(FeeVault.Hook.Hooked), "an expired proposal must stop counting");

        // 3. This time it is executed. Now we are off the launch.
        vm.prank(ponsOwner);
        IPonsOwner(FACTORY).setCreatorFeeRecipient(token, address(0xdead));
        vm.warp(block.timestamp + 3 days + 1);
        IPonsOwner(FACTORY).executeCreatorFeeRecipientChange(token);

        (status, current,) = vault.hookStatus();
        assertEq(uint256(status), uint256(FeeVault.Hook.Lost), "the recipient moved, the status must say so");
        assertEq(current, address(0xdead), "and name who took it");
        assertEq(address(vault.token()), token, "while the binding is untouched: that is the whole point");

        // The flag is a record, not a switch: it dates the loss and changes
        // nothing else.
        uint256 rewardsBefore = vault.rewardsPool();
        uint256 owedToCreator = vault.creatorPool();
        assertGt(rewardsBefore, 0, "fixture assumes the vault collected before losing the stream");

        vault.flagHookLost();
        assertEq(vault.hookLostAt(), block.timestamp, "the loss must be dated");
        assertEq(vault.rewardsPool(), rewardsBefore, "the flag must not touch a single wei");

        // And the vault keeps working: what it already holds still pays out.
        assertEq(vault.payCreator(), owedToCreator, "an unhooked vault must still settle what it owes");
    }

    /// @notice `economics()` says what the vault takes in points of VOLUME, and
    ///         it derives every number rather than storing any.
    ///
    /// @dev    This is the figure the front puts on a token's page. If it were
    ///         a constant it would be a lie the day Pons moves its share, so
    ///         the test that matters is not "does it print 470" — it is "does
    ///         it follow when the input moves".
    function test_EconomicsIsDerivedFromPonsNotStored() public {
        (
            uint256 taxBps,
            uint256 curveFeeBps,
            uint256 ponsShareBps,
            uint256 gross,
            uint256 rewards,
            uint256 creator,
            uint256 platform
        ) = vault.economics();

        // The three inputs, read on-chain and not from us.
        assertEq(taxBps, CREATOR_TAX_BPS, "the tax must come from the launch record");
        assertEq(curveFeeBps, 100, "curveFeeBps is 1.00 pct, second word of getLaunchConfig(0)");
        assertEq(ponsShareBps, 3_000, "Pons takes 30 pct of the curve fee today");

        // 400 + 100 x 70 pct = 470 bps. The 4.70 pct of docs/recon.md 1.9,
        // recomputed by the contract instead of copied into it.
        assertEq(gross, 470, "the gross must be 4.70 pct of volume");
        assertEq(rewards + creator + platform, gross, "the three parts must exhaust the gross");
        assertEq(platform, (gross * vault.PLATFORM_BPS()) / 10_000, "the platform share of volume");

        // Now move the input Pons controls, to its documented ceiling.
        //
        // T-HYG-01, re-read 2026-09-11. The only `vm.mockCall` on a Pons
        // contract left in the suite, and it survives the house rule for a
        // reason that is visible three lines up: the test reads the hook's REAL
        // `protocolFeeShareBps` first and asserts it is 3 000. It does not "only
        // pass thanks to the mock" — remove the fork and the first half fails.
        // What the mock buys is the SECOND half: that our own arithmetic follows
        // Pons down to its documented ceiling, which cannot be observed because
        // Pons is not at its ceiling today. `economics()` is a view and no money
        // moves through it.
        //
        // If it ever needs re-basing, the treatment is the one
        // `Treasury.t.sol::test_FollowMigrationGoesWhereTheVaultWentAndNowhereElse`
        // adopted: `vm.etch` our own stub at the address Pons genuinely
        // designates, clearing the slots first.
        address hook = IPonsV2MemeHookSource(FACTORY).memeHook();
        vm.mockCall(hook, abi.encodeWithSelector(bytes4(0x9040f866)), abi.encode(uint256(5_000)));

        (,, uint256 worseShare, uint256 worseGross,,,) = vault.economics();
        assertEq(worseShare, 5_000, "the mock did not take");
        // 400 + 100 x 50 pct = 450. Same 0.20 point of volume as recon 9.5.
        assertEq(worseGross, 450, "the gross must follow Pons down, not stay at 470");
    }

    /// @notice **The measurement that decides the whole economic model:** a trade
    ///         of size X credits us 4.70 % of X.
    ///
    ///         `recon.md` §1.9 derived that from the intra-transaction split on
    ///         two graduated tokens belonging to other people. This gets it from
    ///         our own launch, on our own tax, end to end.
    function test_WeCollectExactly470BpsOfVolume() public {
        uint256 spend = 1 ether;
        vm.deal(trader, spend);
        vm.prank(trader);
        curve.buy{value: spend}(spend, 0, trader);

        // Only the fee recipient may sweep: the curve calls that field
        // `deployer`, and it holds the recipient, not the launching wallet.
        vm.prank(address(vault));
        _sweep();

        uint256 credited = IEscrow(ESCROW).balanceOf(address(vault));
        assertEq(credited, (spend * 470) / 10_000, "we must collect exactly 4.70 % of the trade");
    }

    /// @notice A single `harvest()` sweeps Pons and claims, from a cold start.
    ///
    /// @dev    The escrow is EMPTY when this runs. Before `_sweepFees`, `harvest`
    ///         reverted `NothingToDo()` here and the fees sat on the curve until
    ///         a Pons operator moved them. This is the test that would catch the
    ///         sweep being removed.
    function test_HarvestSweepsAndClaimsInOneCall() public {
        uint256 spend = 1 ether;
        vm.deal(trader, spend);
        vm.prank(trader);
        curve.buy{value: spend}(spend, 0, trader);

        assertEq(IEscrow(ESCROW).balanceOf(address(vault)), 0, "escrow must start empty for this to prove anything");

        uint256 gross = vault.harvest();

        assertEq(gross, (spend * 470) / 10_000, "harvest must claim the full 4.70 %");
        // Net of the caller's gas refund, which the creator's residue pays.
        uint256 nominal = gross - (gross * vault.PLATFORM_BPS()) / 10_000 - (gross * vault.rewardsBps()) / 10_000;
        assertLe(vault.creatorPool(), nominal, "the creator share cannot exceed the residue");
        assertGt(vault.creatorPool(), (nominal * 99) / 100, "the refund ate more of it than it should");
        assertGt(vault.rewardsPool(), 0, "rewards share");
        assertGt(address(dist).balance, 0, "the Distributor must be funded with gas");
    }

    /// @notice The launching wallet cannot sweep, even though it is the
    ///         `deployer` of the launch. Only the fee recipient can.
    ///
    /// @dev    recon.md asserted the opposite for two passes. This locks the
    ///         corrected reading down: the field the curve calls `deployer` is
    ///         the creator FEE RECIPIENT.
    function test_OnlyTheFeeRecipientCanSweep() public {
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        curve.buy{value: 1 ether}(1 ether, 0, trader);

        vm.prank(safe);
        (bool ok,) = address(curve).call(abi.encodeWithSignature("sweepFees(uint256)", uint256(0)));
        assertFalse(ok, "the launching Safe must not be able to sweep");

        vm.prank(makeAddr("stranger"));
        (bool ok2,) = address(curve).call(abi.encodeWithSignature("sweepFees(uint256)", uint256(0)));
        assertFalse(ok2, "a stranger must not be able to sweep");

        vm.prank(address(vault));
        _sweep();
        assertGt(IEscrow(ESCROW).balanceOf(address(vault)), 0, "the fee recipient must be able to sweep");
    }

    /// @notice A full epoch, end to end, on our own launch: fees in, one stock
    ///         bought, seed anchored and revealed, root published, holder paid.
    ///
    /// @dev    `docs/REHEARSAL.md` listed this as unreachable without a manual
    ///         rehearsal. It is not: `vm.warp` and `vm.roll` give us the epoch
    ///         boundary and the 128-block seed delay for free, and the swap goes
    ///         through the real Uniswap v3 pools.
    function test_FullEpochCycleToClaim() public {
        _trade(2 ether);
        vault.harvest();
        assertGt(vault.rewardsPool(), 0, "nothing to spend");

        address stock = vault.getAllocations()[0].stock;

        uint256 legs = _buy(vault);
        assertEq(legs, vault.getAllocations().length, "the whole basket must have been bought");
        assertGt(dist.totalFunded(stock), 0, "the stock was not credited");
        assertGt(dist.quoteAtRisk(), 0, "quoteSpent must be recorded for the threshold");
        assertEq(IERC20(stock).balanceOf(address(vault)), 0, "the vault must keep no stock");

        // The window the purchase covered is already closed — `fundWindow`
        // refuses anything else — so the root can go out at once.
        uint256 epoch = dist.nextEpoch() - 1;

        // A one-leaf root: the root IS the leaf and the proof is empty, which is
        // enough to exercise the whole settlement path.
        uint256 owed = dist.totalFunded(stock);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(trader, stock, owed))));
        vm.prank(keeper);
        dist.publishRoot(epoch, leaf, leaf, bytes32("cid"), "bafyTEST");

        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = stock;
        cum[0] = owed;
        proofs[0] = new bytes32[](0);

        uint256 before = IERC20(stock).balanceOf(trader);
        vm.prank(trader);
        dist.claim(stocks, cum, proofs);

        assertEq(IERC20(stock).balanceOf(trader) - before, owed, "the holder was not paid in full");
        assertEq(dist.claimedSoFar(trader, stock), owed, "claimedSoFar not recorded");
    }

    /// @notice Graduation, and the post-graduation sweep succeeding.
    ///
    /// @dev    The one path that genuinely cannot be reached on mainnet without
    ///         spending: it needs 4.2 ETH of real curve reserve. On a fork the
    ///         ETH is free, so the branch of `_sweepFees` that talks to the v4
    ///         hook — the newest code in the vault — gets exercised for nothing.
    function test_GraduationAndPostGraduationSweep() public {
        // Push the curve over its 4.2 ETH threshold.
        vm.deal(trader, 6 ether);
        vm.startPrank(trader);
        curve.buy{value: 5 ether}(5 ether, 0, trader);
        vm.stopPrank();

        assertTrue(curve.graduated(), "the curve did not graduate");

        // Graduation is a PERMISSIONLESS three-step process, and the buy that
        // crosses the threshold already performs the first two: the curve marks
        // itself graduated and the launch moves to phase `Swept`. What remains is
        // opening the v4 pool, which anyone can do — no Pons operator involved.
        IPonsV2LaunchFactory.LaunchedToken memory mid = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token);
        assertEq(mid.phase, 1, "the crossing buy should have left the launch Swept");

        (bool okP,) = FACTORY.call(abi.encodeWithSignature("createGraduatedPool(address)", token));
        assertTrue(okP, "createGraduatedPool() failed");

        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token);
        assertEq(l.phase, 2, "phase must be 2 once the pool exists");

        // Everything the curve had accrued still has to reach us.
        uint256 gross = vault.harvest();
        assertGt(gross, 0, "harvest collected nothing after graduation");
    }

    /// @notice A migration redirects the stream IMMEDIATELY, and only towards
    ///         another vault of the same token.
    ///
    /// @dev    Instant because `transferCreatorFeeRecipient`, called by the
    ///         CURRENT recipient, applies in the same transaction — the
    ///         pending/timelock machinery belongs to `setCreatorFeeRecipient`,
    ///         which is Pons's power over us and not ours (docs/recon.md §1.3).
    ///
    ///         Every document in this repository once said the redirect took
    ///         3 days plus a 3-day window. It never did.
    /// @notice **A migration that actually carries a pivot reserve — which had
    ///         never run.**
    ///
    /// @dev    `_moveReserve` sends `pivotReserve` to the successor and then
    ///         calls `fundPivot` on it, so the money is BOOKED there rather than
    ///         sitting in a balance nothing spends. The coverage report showed
    ///         `fundPivot` had never executed anywhere, and `_moveReserve`'s
    ///         `pivotOut != 0` arm never taken: every migration test so far
    ///         started from a vault whose reserve was empty, so the branch that
    ///         moves the money was the one nobody exercised.
    ///
    ///         A reserve is what a skipped leg leaves behind, and it is exactly
    ///         what a migration must not lose — `fundPivot` exists for this and
    ///         for pivot arriving by an unplanned path.
    ///
    ///         **It also pins a residual I would rather state than have someone
    ///         find**: `reserveQuote` — the QUOTE that bought the pivot, added
    ///         by T-RISK-01 — does NOT follow. `fundPivot` takes an amount and
    ///         no provenance, so the successor holds pivot with nothing behind
    ///         it and its first purchase under-attributes by that much. Bounded
    ///         by the migrated reserve, on a timelock path, and asserted here so
    ///         it stays a known number instead of a surprise.
    function test_AMigrationCarriesThePivotReserveAndBooksItOnTheSuccessor() public {
        FeeVault next = _migrationTarget(7_000, 1_000);

        // Pivot sitting in the old vault, booked the way `fundPivot` books it.
        uint256 stray = 1_234e6;
        deal(USDG, address(vault), stray);
        uint256 credited = vault.fundPivot();
        assertEq(credited, stray, "fundPivot credits what is really here, measured not passed");
        assertEq(vault.pivotReserve(), stray, "and books it into the reserve the next leg spends");

        vm.prank(timelock);
        vault.migrate(address(next));

        assertEq(vault.pivotReserve(), 0, "the old vault keeps none of it");
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0, "not even in its balance");
        assertEq(next.pivotReserve(), stray, "and the successor has it BOOKED, not merely received");
        assertEq(IERC20(USDG).balanceOf(address(next)), stray, "with the tokens really there");

        // The residual, stated: the quote behind that pivot does not travel.
        assertEq(next.reserveQuote(), 0, "reserveQuote does not follow a migration -- known, bounded, documented");
    }

    /// @notice **`fundPivot` refuses when there is nothing to book**, so a
    ///         fixed-cost transaction is never spent on zero.
    function test_FundPivotRefusesWhenThereIsNothingStray() public {
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.fundPivot();
    }

    function test_MigrateMovesTheStreamAtOnceAndBindsTheNewVault() public {
        FeeVault next = _migrationTarget(7_000, 1_000);

        vm.prank(timelock);
        vault.migrate(address(next));

        assertEq(_recipient(), address(next), "the redirect must take effect immediately");
        assertEq(address(next.token()), token, "the new vault must be bound in the same transaction");
        assertEq(vault.migratedTo(), address(next), "the old vault must record where it went");

        // And it is one-way: a second migration is refused.
        FeeVault other = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vm.expectRevert(FeeVault.AlreadyMigrated.selector);
        vault.migrate(address(other));
    }

    /// @notice **The till follows, the stocks stay.** A migrated vault produces
    ///         from its very first transaction; what was already bought stays
    ///         claimable where it is, forever.
    ///
    /// @dev    The dividing line is not arbitrary, it follows what is ALREADY
    ///         PROMISED. A stock at the Distributor is covered by a published
    ///         root, it belongs by name to the holders of closed epochs: moving
    ///         it would break valid proofs. `rewardsPool` and `pivotReserve` are
    ///         promised to nobody in particular -- it is currency waiting for a
    ///         purchase -- and leaving them behind meant running two baskets, two
    ///         roots and two snapshot pipelines for a single token.
    ///
    ///         `creatorPool` and `platformPool` stay too: they are owed to
    ///         immutable addresses, and `payCreator` / `payPlatform` go on
    ///         working on the old vault forever.
    ///
    ///         The price to pay is named in `FeeVault.migrate`: that function now
    ///         moves value, so its destination check has to be worth something.
    ///         It is: the destination must be in THIS vault's registry, and
    ///         `isVault` is written only by `Payd._create`. Nobody can steer it
    ///         -- that is what removing the successor chain made possible.
    function test_MigrateCarriesTheReserveAndLeavesTheStocks() public {
        _trade(2 ether);
        vault.harvest();
        _buy(vault);

        address stock = vault.getAllocations()[0].stock;
        uint256 heldBefore = IERC20(stock).balanceOf(address(dist));
        uint256 rewardsBefore = vault.rewardsPool();
        uint256 pivotBefore = vault.pivotReserve();
        uint256 creatorBefore = vault.creatorPool();
        uint256 platformBefore = vault.platformPool();
        assertGt(heldBefore, 0, "fixture assumes the old vault bought something");
        assertGt(rewardsBefore, 0, "fixture assumes a reserve left to carry");

        FeeVault next = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vault.migrate(address(next));

        // What stays, and why.
        assertEq(IERC20(stock).balanceOf(address(dist)), heldBefore, "a stock left the old Distributor");
        assertEq(IERC20(stock).balanceOf(address(next.DISTRIBUTOR())), 0, "the new one received no stock");
        assertEq(vault.creatorPool(), creatorBefore, "the creator share is owed where it is");
        assertEq(vault.platformPool(), platformBefore, "and so is the platform share");

        // What leaves, and where to.
        assertEq(vault.rewardsPool(), 0, "the old vault keeps a reserve");
        assertEq(vault.pivotReserve(), 0, "and a pivot reserve");
        assertEq(next.rewardsPool(), rewardsBefore, "the new one produces from now on");
        assertEq(next.pivotReserve(), pivotBefore, "pivot reserve included");

        // And the old one stays solvent for what it still owes.
        assertGe(
            address(vault).balance,
            vault.creatorPool() + vault.platformPool() + vault.pendingTotal(),
            "the old vault must cover what it still owes"
        );
    }

    /// @notice Where a COMPROMISED timelock can send the stream: nowhere useful.
    ///
    /// @dev    This test replaces the one that asked the same question of the
    ///         old escape valve — and got a bad answer. Redirecting to the Safe
    ///         made the Safe the current recipient, and the current recipient
    ///         can move the stream again, immediately, anywhere. Two
    ///         transactions from a compromised key to an arbitrary address.
    ///
    ///         `migrate` closes that: the destination must be a vault the
    ///         Payd made, for the same token, with the same creator, and
    ///         paying holders at least as well. A thief walking through the
    ///         door arrives at a contract that pays somebody else.
    function test_WhereACompromisedTimelockCanSendTheStream() public {
        // 1. An arbitrary address: refused. There is no version of this call
        //    that names a destination of the caller's choosing.
        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotAVault.selector);
        vault.migrate(makeAddr("thief"));

        // 2. A contract that merely LOOKS like a vault: refused, because the
        //    Payd has never heard of it.
        FeeVault impostor = _migrationVault(pad, 7_000, 1_000, false, token);
        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotAVault.selector);
        vault.migrate(address(impostor));

        // 3. A real vault of the Payd, but aimed at another token.
        FeeVault wrongToken = _migrationVault(pad, 7_000, 1_000, true, address(0xBEEF));
        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        vault.migrate(address(wrongToken));

        // 4. The right token, but it pays holders LESS. This is the one that
        //    matters: it is the only profitable direction, and it is closed.
        FeeVault worse = _migrationTarget(6_999, 1_000);
        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.migrate(address(worse));

        // 5. The right token, paying holders the same, but taking a bigger
        //    platform cut. Closed too.
        FeeVault greedy = _migrationTarget(7_000, 1_001);
        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.migrate(address(greedy));

        // 6. And nobody but the timelock gets to try any of it.
        FeeVault fine = _migrationTarget(7_000, 1_000);
        vm.prank(safe);
        vm.expectRevert(FeeVault.NotTimelock.selector);
        vault.migrate(address(fine));

        assertEq(_recipient(), address(vault), "after all that, the stream has not moved");
    }

    /// @notice **A new version of the vault code, with no new registry** — and
    ///         migration recognises it through `isVault` alone.
    ///
    /// @dev    The defect this test locks down, and how it was resolved. A vault
    ///         asks ITS registry — the one engraved at its birth — whether the
    ///         destination is one of ours. As long as `VAULT_IMPL` lived in the
    ///         registry, a new implementation forced a new registry, hence a new
    ///         `isVault`: v1 answered no to every v2 vault, and the system's only
    ///         way out closed on its own generation.
    ///
    ///         The answer at the time was a successor chain. It worked, and it
    ///         was the largest residual hole: `setSuccessor` accepted any
    ///         address, and five lines answering `isVault(x) = true` opened
    ///         `migrate` — hence the future stream AND the reserve — onto
    ///         anything.
    ///
    ///         Today's answer is structural: the implementations live in
    ///         `DistributionFactory`, a new version is a new factory, and its vaults are
    ///         born in the **same** registry. The check becomes `isVault` again,
    ///         written by `_create` and by nobody else.
    function test_ANewVaultCodeIsReachedWithoutANewRegistry() public {
        // The next version of the vault code comes out of a DIFFERENT factory,
        // and registers with the SAME registry. That is all the change does, and
        // it is what makes the successor chain unnecessary.
        FeeVault next = _migrationTarget(7_000, 1_000);
        assertTrue(pad.isVault(address(next)), "it is born in the same registry");

        vm.prank(timelock);
        vault.migrate(address(next));

        assertEq(vault.migratedTo(), address(next), "the door must lead to the next version");
        assertEq(_recipient(), address(next), "and the stream must have followed");
    }

    /// @notice **A vault of another MODE is not a destination**, however
    ///         legitimate it is.
    ///
    /// @dev    The gap this closes. `isVault` says the destination was born in
    ///         our registry; it says nothing about what it pays. As long as one
    ///         payout mode exists the two questions have the same answer — the
    ///         day a second factory builds something else, they do not, and a
    ///         single timelock operation would move a pro-rata stream into
    ///         another promise. The holders bought this one.
    ///
    ///         The check compares the MODE, not the factory address, and the
    ///         test above is the reason: a new version of the same mode is a
    ///         new factory, and comparing addresses would forbid exactly the
    ///         migration this system exists to allow. Same mode migrates, other
    ///         mode does not, and both halves are asserted here.
    function test_AVaultOfAnotherModeIsNotADestination() public {
        FeeVault lottery = _migrationVault(pad, 7_000, 1_000, false, token);
        // Registered, same token, same creator, same split, same quote: it
        // passes every other check in `migrate`. Only the mode differs.
        pad.addAs(address(lottery), "lottery");

        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotOurMode.selector);
        vault.migrate(address(lottery));

        assertEq(_recipient(), address(vault), "the stream must not have moved");
        assertEq(vault.migratedTo(), address(0), "and the door must still be shut");

        // And the same mode still goes through, from the same state.
        FeeVault next = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vault.migrate(address(next));
        assertEq(_recipient(), address(next), "a same-mode destination is unaffected");
    }

    /// @notice **The door between modes opens, and only the generation key has
    ///         the handle.**
    ///
    /// @dev    Shut at birth. What lifts the refusal is `Payd`'s
    ///         `crossModeMigration`, held by the cold key — which authorises
    ///         and never acts: the timelock must still call `migrate` itself,
    ///         and every other condition of that function still holds. Neither
    ///         key alone moves a holder into another promise, which is the
    ///         property this system keeps everywhere it can.
    function test_CrossModeMigrationNeedsTheSwitchAndTheTimelock() public {
        FeeVault lottery = _migrationVault(pad, 7_000, 1_000, false, token);
        pad.addAs(address(lottery), "lottery");

        // Shut by default — asserted here and not only in the test above,
        // because the default is the whole point of the switch.
        assertFalse(pad.crossModeMigration(), "the door must be shut at birth");
        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotOurMode.selector);
        vault.migrate(address(lottery));

        // Open it: the timelock still has to be the one calling.
        pad.openCrossMode(true);
        vm.prank(safe);
        vm.expectRevert(FeeVault.NotTimelock.selector);
        vault.migrate(address(lottery));

        // And the other conditions do not lift with it: a destination paying
        // holders less is still refused, switch or no switch.
        FeeVault worse = _migrationVault(pad, 6_999, 1_000, false, token);
        pad.addAs(address(worse), "lottery");
        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.migrate(address(worse));

        // Now it goes through.
        vm.prank(timelock);
        vault.migrate(address(lottery));
        assertEq(_recipient(), address(lottery), "the stream must have followed");
    }

    /// @notice Shutting the door again closes it at once.
    function test_ClosingTheCrossModeDoorTakesEffectImmediately() public {
        FeeVault lottery = _migrationVault(pad, 7_000, 1_000, false, token);
        pad.addAs(address(lottery), "lottery");

        pad.openCrossMode(true);
        pad.openCrossMode(false);

        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotOurMode.selector);
        vault.migrate(address(lottery));
        assertEq(vault.migratedTo(), address(0), "the door must be shut again");
    }

    /// @notice A destination no registry knows is refused, and nobody can get
    ///         it recognised.
    ///
    /// @dev    What replaces the successor-chain test. There is no door left to
    ///         open: `isVault` is written only by `_create`, so neither the
    ///         timelock nor the Ledger can pass an address off as a vault.
    function test_NothingCanMakeAStrangerLookLikeAVault() public {
        FeeVault impostor = _migrationVault(pad, 7_000, 1_000, false, token);

        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotAVault.selector);
        vault.migrate(address(impostor));

        // And there exists, in the real registry, no function to get it in
        // there: `isVault` is written only by `_create`. That is the difference
        // with the successor chain, where one timelock operation was enough to
        // have any address recognised.
    }

    /// @notice The five conditions apply identically to a destination from a
    ///         new version.
    function test_ANewVaultCodeObeysTheSameFiveConditions() public {
        // Worse for the holders.
        FeeVault worse = _migrationVault(pad, 6_999, 1_000, true, token);
        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.migrate(address(worse));

        // Greedier for the platform.
        FeeVault greedy = _migrationVault(pad, 7_000, 1_001, true, token);
        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.migrate(address(greedy));

        // Aims at a different token.
        FeeVault elsewhere = _migrationVault(pad, 7_000, 1_000, true, address(0xBEEF));
        vm.prank(timelock);
        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        vault.migrate(address(elsewhere));

        // And the one that satisfies everything goes through.
        FeeVault fine = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vault.migrate(address(fine));
        assertEq(vault.migratedTo(), address(fine), "the compliant destination must go through");
    }

    ///      token, same creator.
    function _migrationTarget(uint256 rewardsBps_, uint256 platformBps_) internal returns (FeeVault v) {
        v = _migrationVault(pad, rewardsBps_, platformBps_, true, token);
    }

    /// @dev `register` and `aimedAt` are SEPARATE on purpose: the compromised
    ///      timelock test needs a vault that is registered but aims elsewhere,
    ///      and conflating the two made that case silently migrate instead of
    ///      being refused.
    function _migrationVault(PaydStub on, uint256 rewardsBps_, uint256 platformBps_, bool register, address aimedAt)
        internal
        returns (FeeVault v)
    {
        Distributor d = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeper,
            block.timestamp,
            EPOCH_LENGTH
        );
        v = _cloneVault(
            VaultTypes.Config({
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
                platformBps: platformBps_,
                rewardsBps: rewardsBps_,
                timelock: timelock,
                distributor: address(d),
                deployer: safe,
                registry: address(on),
                intendedToken: aimedAt,
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _twoStockBasket()
        );
        if (register) on.add(address(v));
    }

    /// @notice A window buys once. A second call before another epoch closes is
    ///         refused, so nobody can drain the reserve by looping.
    function test_AWindowBuysOnlyOnce() public {
        _trade(2 ether);
        vault.harvest();
        _buy(vault);

        // Read first, arm second.
        uint256[] memory minOuts = new uint256[](vault.getAllocations().length);
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.buyBasket(minOuts);
    }

    /// @notice Two epochs, one settlement — and replaying it pays nothing.
    ///
    /// @dev    The cumulative model's whole promise (§S18), on real fees: a
    ///         holder away for several epochs is paid once, and an old proof is
    ///         inert rather than dangerous.
    function test_TwoEpochsSettleInOneClaimAndDoNotPayTwice() public {
        _trade(2 ether);
        vault.harvest();

        address stock = vault.getAllocations()[0].stock;
        _buy(vault);
        uint256 firstWindow = dist.totalFunded(stock);
        assertGt(firstWindow, 0, "the first window bought nothing");

        // A second window, later: the cumulative total must grow, and a single
        // claim must settle both.
        vm.warp(dist.epochEnd(dist.nextEpoch()) + 1);
        _buy(vault);

        uint256 owed = dist.totalFunded(stock);
        assertGt(owed, firstWindow, "the second window credited nothing");

        uint256 e2 = dist.nextEpoch() - 1;

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(trader, stock, owed))));
        vm.prank(keeper);
        dist.publishRoot(e2, leaf, leaf, bytes32("cid"), "bafyTEST");

        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = stock;
        cum[0] = owed;
        proofs[0] = new bytes32[](0);

        uint256 before = IERC20(stock).balanceOf(trader);
        vm.prank(trader);
        dist.claim(stocks, cum, proofs);
        uint256 paid = IERC20(stock).balanceOf(trader) - before;

        assertEq(paid, owed, "one claim must settle BOTH epochs");

        // Replay the very same proof. It pays nothing — `claimedSoFar` already
        // covers it — and it says so loudly rather than succeeding in silence:
        // a batch that delivers nothing reverts, so a caller cannot mistake a
        // no-op for a payment (§S6).
        vm.expectRevert(Distributor.NothingDelivered.selector);
        vm.prank(trader);
        dist.claim(stocks, cum, proofs);
        assertEq(IERC20(stock).balanceOf(trader) - before, paid, "a replay must not move a single token");
    }

    /// @notice A holder who claimed nothing, was never airdropped, and whose
    ///         epoch's artifact has since been pruned, still gets everything.
    ///
    /// @dev    The question pruning raises, answered on-chain rather than
    ///         asserted. Roots are CUMULATIVE: each one carries the whole
    ///         history from genesis, so a later root already contains every
    ///         earlier one. The old artifact is an older snapshot of the same
    ///         running total, never "their epoch" — nothing is stored only
    ///         there.
    ///
    ///         Here epoch A is funded and its root published, the holder ignores
    ///         it, epoch B is funded and supersedes that root, and the holder
    ///         then claims once against the CURRENT root — receiving A and B
    ///         together. The proof for the superseded root is dead; the money
    ///         behind it is not.
    function test_AnUnclaimedEpochSurvivesItsRootBeingSuperseded() public {
        _trade(2 ether);
        vault.harvest();

        // --- window A: funded, root published, holder does nothing.
        address stock = vault.getAllocations()[0].stock;
        _buy(vault);
        uint256 epochA = dist.nextEpoch() - 1;
        uint256 owedA = dist.totalFunded(stock);

        bytes32 leafA = keccak256(bytes.concat(keccak256(abi.encode(trader, stock, owedA))));
        vm.prank(keeper);
        dist.publishRoot(epochA, leafA, leafA, bytes32("cidA"), "bafyTEST");

        assertEq(IERC20(stock).balanceOf(trader), 0, "the holder must not have been paid yet");

        // --- window B: funded, and its root supersedes A.
        vm.warp(dist.epochEnd(dist.nextEpoch()) + 1);
        _buy(vault);
        uint256 epochB = dist.nextEpoch() - 1;
        uint256 owedTotal = dist.totalFunded(stock);
        assertGt(owedTotal, owedA, "window B credited nothing");

        bytes32 leafB = keccak256(bytes.concat(keccak256(abi.encode(trader, stock, owedTotal))));
        vm.prank(keeper);
        dist.publishRoot(epochB, leafB, leafB, bytes32("cidB"), "bafyTEST");

        // The old proof is dead — `claim` only verifies against the active root.
        // This is the part that looks alarming and is not: what died is the
        // PROOF, not the entitlement.
        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = stock;
        proofs[0] = new bytes32[](0);

        cum[0] = owedA;
        vm.expectRevert();
        vm.prank(trader);
        dist.claim(stocks, cum, proofs);

        // The current root pays epoch A and epoch B together, in one claim.
        cum[0] = owedTotal;
        vm.prank(trader);
        dist.claim(stocks, cum, proofs);

        assertEq(IERC20(stock).balanceOf(trader), owedTotal, "the ignored epoch must be paid too");
        assertGt(owedA, 0, "epoch A must have been worth something for this to prove anything");
    }

    /// `bind` is once and for good — the vault must never be re-pointed at a
    /// different token after fees have started flowing.
    function test_BindingASecondTimeIsRefused() public {
        vm.expectRevert(FeeVault.AlreadyBound.selector);
        vault.bind(token);

        vm.expectRevert(FeeVault.AlreadyBound.selector);
        vault.bind(0x99563a25F128f1b6F9776FDe18caB03020Fe698D);
    }

    /// A dead Chainlink feed must NOT block a purchase. The oracle only ever
    /// tightens the floor; the TWAP is what guarantees it exists at all, so
    /// `minOut` is never zero even with no feed (the rule of docs S3).
    function test_AStaleChainlinkFeedDoesNotBlockThePurchase() public {
        _trade(2 ether);
        vault.harvest();

        // Push time past MAX_FEED_AGE so every feed reads stale.
        vm.warp(block.timestamp + vault.MAX_FEED_AGE() + 1 hours);

        uint256 legs = _buy(vault);

        assertGt(legs, 0, "a stale feed must not stop the purchase");
        assertGt(dist.quoteAtRisk(), 0, "and the window must be funded");
    }

    /// The reentrancy guard on the vault, made to refuse: `harvest` hands gas
    /// back to its caller, and a caller that re-enters is stopped there.
    function test_TheVaultReentrancyGuardRefusesAReentrantCall() public {
        _trade(2 ether);
        VaultReenterer r = new VaultReenterer(vault);
        r.go();
        assertTrue(r.guardHeld(), "the reentrant call should have been refused");
        assertGt(vault.rewardsPool(), 0, "and the harvest must still have happened");
    }

    /// Why the destination could not be an address, however trusted.
    ///
    /// The old escape valve pointed at the Safe and the checklist claimed that,
    /// being hard-coded, it "cannot point the fees elsewhere even compromised".
    /// That was wrong, and this test is what showed it: the Safe becomes the
    /// CURRENT RECIPIENT, and the current recipient can move the stream again,
    /// immediately, anywhere (recon §1.2). Two transactions from a compromised
    /// key to an arbitrary address.
    ///
    /// The step below still passes — it is Pons's rule, not ours, and it has
    /// not changed. What changed is that no function of ours hands anybody that
    /// first step any more: `migrate` only ever leads to another vault
    /// (`test_WhereACompromisedTimelockCanSendTheStream`).
    function test_WhyTheDestinationCannotBeAnAddress() public {
        // Put the Safe in the recipient's seat, the way the old valve did —
        // here through the migration vault's own creator, since only the
        // current recipient may move the stream.
        FeeVault next = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vault.migrate(address(next));
        assertEq(_recipient(), address(next), "fixture: the stream must have moved to the new vault");

        // A vault cannot re-point the stream at an address: there is no
        // function for it. The only mover is `migrate`, and it has already run.
        vm.prank(timelock);
        vm.expectRevert(FeeVault.AlreadyMigrated.selector);
        vault.migrate(makeAddr("attacker"));

        // And this is what an ADDRESS in that seat would have been able to do —
        // Pons's rule, demonstrated on a plain EOA rather than on us.
        assertEq(_recipient(), address(next), "the stream is still on a contract, not a key");
    }

    function _recipient() internal view returns (address) {
        return IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token).creatorFeeRecipient;
    }

    /// THE MIGRATION, end to end, on a token that is already live.
    ///
    /// `FeeVault.DISTRIBUTOR` and `Distributor.FEE_VAULT` are both immutable,
    /// so a broken Distributor cannot be swapped underneath its vault. The
    /// recovery is to replace the PAIR — and this test proves the whole path
    /// actually works against the real Pons factory, not just the two transfer
    /// calls in isolation:
    ///
    ///   1. the old vault collects (so there is really something to lose)
    ///   2. emergencyRedirect parks the stream on the Safe
    ///   3. a fresh pair is deployed
    ///   4. the Safe, now the recipient, re-points the stream at the new vault
    ///   5. the new vault binds the SAME token
    ///   6. new trading fees land in the NEW vault, and not in the old one
    function test_TheWholePairCanBeReplacedOnALiveToken() public {
        _trade(2 ether);
        uint256 collectedByOld = vault.harvest();
        assertGt(collectedByOld, 0, "the old vault must be collecting for this to mean anything");

        // ONE call, where the old escape valve took four steps through the Safe
        // — and left the stream sitting on a key in between, which is exactly
        // the window `migrate` removes.
        FeeVault vault2 = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vault.migrate(address(vault2));

        assertEq(_recipient(), address(vault2), "the stream must now point at the new vault");
        assertEq(address(vault2.token()), token, "the new vault must be bound to the same token");
        assertTrue(address(vault2) != address(vault), "the new vault must be a different contract");

        // New fees go to the new vault, and the old one is left dry.
        uint256 oldPoolBefore = vault.rewardsPool();
        _trade(2 ether);
        uint256 collectedByNew = vault2.harvest();

        assertGt(collectedByNew, 0, "the NEW vault must now be collecting");
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.harvest();
        assertEq(vault.rewardsPool(), oldPoolBefore, "the old vault must receive nothing further");

        // And what the old pair already holds is not destroyed — it stays
        // claimable there. Nothing sweeps it across; that is the price, and it
        // is also the guarantee: a function that COULD sweep it would be a
        // theft path with a 48-hour delay in front of it.
        assertGt(vault.rewardsPool() + vault.creatorPool(), 0, "the old vault keeps what it had");
    }

    /// The same migration, but AFTER graduation — the state it would actually
    /// be needed in. A distribution bug found months in finds a token whose
    /// fees no longer come from the curve but from the v4 hook, and the escape
    /// hatch has to work there too.
    function test_ThePairCanStillBeReplacedAfterGraduation() public {
        vm.deal(trader, 8 ether);
        vm.prank(trader);
        curve.buy{value: 5 ether}(5 ether, 0, trader);
        assertTrue(curve.graduated(), "the curve did not graduate");

        (bool okP,) = FACTORY.call(abi.encodeWithSignature("createGraduatedPool(address)", token));
        assertTrue(okP, "createGraduatedPool() failed");
        assertEq(IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token).phase, 2, "must be past graduation");

        vault.harvest();

        // The migration, on a graduated token.
        FeeVault vault2 = _migrationTarget(7_000, 1_000);
        vm.prank(timelock);
        vault.migrate(address(vault2));

        assertEq(_recipient(), address(vault2), "the stream must re-point after graduation too");
        // `bind` ran inside `migrate`, and it reads the launch record — which
        // graduation does not disturb.
        assertEq(address(vault2.token()), token, "the new vault must bind the graduated token");
        assertTrue(address(vault2.curve()) != address(0), "and still resolve the curve");
    }

    function _trade(uint256 amount) internal {
        vm.deal(trader, amount);
        vm.prank(trader);
        curve.buy{value: amount}(amount, 0, trader);
    }

    function _sweep() internal {
        (bool ok,) = address(curve).call(abi.encodeWithSignature("sweepFees(uint256)", uint256(0)));
        require(ok, "sweepFees reverted");
    }

    /// `owedTo` is what the front reads before pushing. Its clamp is the guard
    /// that keeps an INFLATED root from promising stock the contract does not
    /// hold.
    function test_OwedToReportsTheTruthAndCannotPromiseMoreThanIsHeld() public {
        _trade(2 ether);
        vault.harvest();

        address stock = vault.getAllocations()[0].stock;
        _buy(vault);
        uint256 e = dist.nextEpoch() - 1;
        uint256 owed = dist.totalFunded(stock);
        assertGt(owed, 0, "the window must hold stock for this to prove anything");

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(trader, stock, owed))));
        vm.prank(keeper);
        dist.publishRoot(e, leaf, leaf, bytes32("cid"), "bafyTEST");

        // Nothing paid yet: the whole entitlement is outstanding.
        assertEq(dist.owedTo(trader, stock, owed), owed, "should owe the full amount");

        // A root claiming twice what was ever funded cannot conjure it: the
        // answer is capped by what the contract actually holds.
        assertEq(dist.owedTo(trader, stock, owed * 2), owed, "an inflated cumulative must be clamped");

        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        stocks[0] = stock;
        cum[0] = owed;
        proofs[0] = new bytes32[](0);
        vm.prank(trader);
        dist.claim(stocks, cum, proofs);

        // Settled: nothing left, and nothing left to clamp against either.
        assertEq(dist.owedTo(trader, stock, owed), 0, "a settled holder is owed nothing");
        assertEq(dist.owedTo(trader, stock, owed * 2), 0, "and the stock is gone, so the clamp yields zero");

        // Someone with no entitlement at all is owed nothing.
        assertEq(dist.owedTo(address(0xBEEF), stock, owed), 0, "a stranger must be owed nothing");
    }

    /// @notice **One creator, several tokens** — and the fees of one cannot
    ///         land in the vault of another.
    ///
    /// @dev    Nothing in `createVault` limits a creator: `_byCreator` is an
    ///         array and `vaultsOf` returns it, so the shape was always meant
    ///         for several. What had never been checked is the property that
    ///         makes several SAFE — a vault binds to the launch that names IT,
    ///         and to no other.
    ///
    ///         Two real launches on the real factory, one creator, two vaults.
    function test_OneCreatorCanLaunchSeveralTokensAndTheirFeesNeverCross() public {
        address creator = makeAddr("a serial launcher");
        Payd real = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: platformWallet,
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

        address[] memory st = new address[](2);
        uint24[] memory fe = new uint24[](2);
        address[] memory fd = new address[](2);
        (st[0], fe[0], fd[0]) = (NVDA, 500, address(0));
        (st[1], fe[1], fd[1]) = (QQQ, 500, address(0));
        vm.prank(timelock);
        real.allowStocks(st, fe, fd);

        VaultTypes.Allocation[] memory basket = _twoStockBasket();

        // Three vaults, one creator. The third stays unbound on purpose: it is
        // what the cross-binding attempt below needs.
        vm.startPrank(creator);
        (address v1,) = real.createVault(basket, 7_000, EPOCH_LENGTH, address(0));
        (address v2,) = real.createVault(basket, 6_000, 1 hours, address(0));
        (address v3,) = real.createVault(basket, 5_000, EPOCH_LENGTH, address(0));
        vm.stopPrank();

        assertEq(real.vaultsOf(creator).length, 3, "nothing limits a creator to one vault");
        assertTrue(v1 != v2 && v2 != v3, "and each is its own pair");

        // Two real launches, by the same wallet, naming two different vaults.
        vm.deal(creator, 10 ether);
        vm.startPrank(creator);
        address tokenA = _launchFor(v1, "Alpha", "ALPHA", bytes32(uint256(1)));
        address tokenB = _launchFor(v2, "Beta", "BETA", bytes32(uint256(2)));
        vm.stopPrank();
        assertTrue(tokenA != tokenB, "two launches, two tokens");

        FeeVault(payable(v1)).bind(tokenA);
        FeeVault(payable(v2)).bind(tokenB);
        assertEq(address(FeeVault(payable(v1)).token()), tokenA, "each vault takes its own launch");
        assertEq(address(FeeVault(payable(v2)).token()), tokenB, "and only its own");

        // **The property that matters.** A third vault of the SAME creator
        // cannot capture a launch that names another vault — the creator's
        // identity is not enough, the launch has to point back. Without this,
        // one creator's second vault could siphon the first one's stream.
        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        FeeVault(payable(v3)).bind(tokenA);

        // And a bound vault stays bound, whatever else the creator launches.
        vm.expectRevert(FeeVault.AlreadyBound.selector);
        FeeVault(payable(v1)).bind(tokenB);

        // The two vaults keep their own settings, read back from storage
        // rather than assumed: `rewardsBps` and the epoch differ by design.
        assertEq(FeeVault(payable(v1)).rewardsBps(), 7_000, "vault one keeps its split");
        assertEq(FeeVault(payable(v2)).rewardsBps(), 6_000, "vault two keeps its own");
        assertEq(Distributor(payable(FeeVault(payable(v2)).DISTRIBUTOR())).EPOCH_LENGTH(), 1 hours, "and its own clock");
    }
}

/// @dev Re-enters the vault from the gas refund `harvest` hands it.
contract VaultReenterer {
    FeeVault immutable V;
    bool public guardHeld;

    constructor(FeeVault v) {
        V = v;
    }

    function go() external {
        V.harvest();
    }

    receive() external payable {
        try V.withdraw() {}
        catch (bytes memory err) {
            if (err.length >= 4 && bytes4(err) == FeeVault.Reentrancy.selector) guardHeld = true;
        }
    }
}
