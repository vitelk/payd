// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {
    IERC20,
    IPonsV2BondingCurve,
    IPonsV2LaunchFactory,
    IPonsV2MemeHookSource,
    IPoolManager,
    IUniswapV3Factory
} from "../contracts/interfaces/IExternal.sol";

/// @notice The platform vault, reduced to what the Treasury asks of it.
///
/// @dev    **Why a stand-in is legitimate here, and only here.** The project
///         rule forbids pretending about Pons or Uniswap: those are the states
///         we do not control, and a test that simulates them proves nothing.
///         This one is OUR contract, and the Treasury asks it only two things,
///         one line each. The real vault is tested at home, in `FeeVault.t.sol`.
///
///         The stand-in is necessary because on this fork the fixture launch's
///         `creatorFeeRecipient` is an EOA: it can neither receive `fundRewards`
///         nor answer `migratedTo`.
contract PlatformVaultStub {
    address public migratedTo;
    uint256 public received;

    function fundRewards() external payable returns (uint256) {
        received += msg.value;
        return msg.value;
    }

    function setMigratedTo(address to) external {
        migratedTo = to;
    }

    receive() external payable {}
}

/// @notice Fork tests against the real state of Robinhood Chain (chainId 4663).
/// @dev    The curve, the factory and the token are Pons's own, on a real
///         launch. Nothing about the burn is mocked — it is the one action
///         here that spends money at a price, so it is the one that has to be
///         proven against the chain rather than against a stand-in.
contract TreasuryTest is Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    /// @dev A real, ungraduated Pons v2 launch and its curve, standing in for
    ///      the platform token. **A THIRD PARTY's launch, on purpose**: this
    ///      file is public, and a fixture pointing at our own deployment would
    ///      publish the address of the Safe that deployed it — `getLaunchedToken`
    ///      returns the deployer, and `getOwners()` turns that into a list of
    ///      signers. $RNVDA is used for what it IS, not for whose it is:
    ///      ungraduated, ETH-quoted, `creatorTaxBps = 400`.
    ///
    ///      **If a test here starts failing on `graduated()`**, the fixture
    ///      graduated — pick another ungraduated launch off the factory's logs
    ///      (topic `0x8d4aad49…`, the one `front/src/launchlog.ts` already
    ///      knows) rather than weakening the assertion.
    address constant PLAT = 0xf15667A02960c5d31e6e23aA1701833f4e4487f2;
    address constant PLAT_CURVE = 0x310C0cAC423466B2F2Dc2B21a6FD844F08A254C5;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev An 18-decimal listed stock with a real WETH pool at tier 500. Used
    ///      for the dust sweep: one wei of it is worth zero wei of ether.
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    /// @dev A listed quote with NO pool against WETH on any of the four tiers --
    ///      one of the ten `test_EveryListedQuoteCanLeaveTheTreasuryAsEth` named
    ///      on 2026-09-10, and the reason the pivot detour exists here.
    address constant PLTR = 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev A Pons launch that really graduated, paired in native ETH.
    address constant SQUEEZE = 0xD0782C1358E20FF07A4d3b420221D78F3C160485;

    Treasury t;
    address timelock = makeAddr("timelock");
    address devWallet = makeAddr("dev");
    /// @dev The generation Ledger: it looks at the (token, vault) pair, the
    ///      timelock names it. Neither of the two is enough on its own.
    address generationKey = makeAddr("generation key");
    /// @dev The vault the fixture launch's fees REALLY go to -- the only value
    ///      `bindPlatform` will accept.
    address realVaultOf;
    address stranger = makeAddr("stranger");

    /// @dev The vault $PLAT's fees really point at — read once, in `setUp`.
    ///
    ///      Not a helper called inline: `vm.prank` and `vm.expectRevert` attach
    ///      to the NEXT CALL, and a read of the Pons factory sitting between
    ///      the cheatcode and the function under test would swallow it. Even
    ///      `makeAddr` is a call. Everything is resolved before anything is
    ///      armed.
    address realVault;
    address notTheRecipient = makeAddr("not the recipient");
    address notALaunch = makeAddr("not a launch");

    function setUp() public {
        t = _treasuryFor(PLAT);
    }

    /// @dev A Treasury wired to a REAL Pons launch, of the kind the actual
    ///      launch night produces, and it records along the way which vault the
    ///      launch's fees REALLY go to -- the only value `bindPlatform` will
    ///      accept.
    function _treasuryFor(address launch) internal returns (Treasury) {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(launch);
        realVault = l.creatorFeeRecipient;
        realVaultOf = l.creatorFeeRecipient;
        return new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: devWallet,
                generationKey: generationKey,
                predecessor: address(0),
                ponsFactory: PONS_FACTORY,
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

    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(t).call{value: amount}("");
        assertTrue(ok, "the Treasury refused a payment");
    }

    /// @notice What arrives is split 3333 / 1667 / 1667 / 3333 — thirds and
    ///         sixths — and the residue lands on the holders' pocket.
    ///
    /// @dev    The weights are read from the contract rather than written twice.
    ///         A test that hard-codes them passes on a WRONG default as long as
    ///         someone updates both — it checks arithmetic, not policy. What is
    ///         worth pinning is the SHAPE: dev and rewards equal, burn and LP
    ///         equal and half of them, and nothing lost.
    function test_TheSplitIsFourWaysAndLosesNothing() public {
        assertEq(t.devBps(), t.rewardsBps(), "dev and the holders' pocket share alike");
        assertEq(t.burnBps(), t.lpBps(), "burn and LP share alike");
        assertEq(t.devBps(), 2 * t.burnBps() - 1, "and each of those is half a third");
        assertEq(t.devBps() + t.burnBps() + t.lpBps() + t.rewardsBps(), 10_000, "the weights must be whole");

        _fund(1 ether);
        t.split();

        assertEq(t.devPool(), (1 ether * t.devBps()) / 10_000, "dev takes its third");
        assertEq(t.burnPool(), (1 ether * t.burnBps()) / 10_000, "burn takes its sixth");
        assertEq(t.lpPool(), (1 ether * t.lpBps()) / 10_000, "LP takes its sixth");
        assertEq(
            t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(),
            1 ether,
            "the four pockets must exhaust what arrived"
        );

        uint256 rewardsBefore = t.rewardsPool();

        // An amount that does not divide cleanly: the rounding residue goes to
        // the pocket that gives stocks back, not to ours.
        uint256 devBefore = t.devPool();
        _fund(3);
        t.split();
        assertEq(t.devPool(), devBefore, "dev must get nothing from 3 wei");
        assertEq(t.rewardsPool(), rewardsBefore + 3, "the residue lands on rewards");
    }

    /// @notice A donation is split like a launch's payment.
    ///
    /// @dev    `_split` measures the BALANCE against what is already booked, so
    ///         anything that lands by any path reaches the pockets. Without
    ///         that, ETH sent by hand would sit here for ever with no function
    ///         able to reach it.
    function test_ADonationIsSplitToo() public {
        address donor = makeAddr("donor");
        vm.deal(donor, 1 ether);
        vm.prank(donor);
        (bool ok,) = address(t).call{value: 1 ether}("");
        assertTrue(ok, "the donation was refused");

        assertEq(t.split(), 1 ether, "the whole donation must be allocated");
        assertEq(t.rewardsPool(), (1 ether * t.rewardsBps()) / 10_000, "and reach the holders' pocket");
    }

    /// @notice The one pocket that leaves the ecosystem: fixed destination,
    ///         minimum, and no way to aim it.
    ///
    /// @dev    It used to be two. `withdrawLp` sent the LP pocket to an
    ///         `LP_SAFE`, and that was a permanent path from this contract to an
    ///         address the maintainer controls. It was deleted rather than
    ///         narrowed further, so the LP half of this test became the
    ///         assertion below: pre-graduation, NOTHING moves that pocket.
    function test_TheDevPocketGoesWhereItMustAndNowhereElse() public {
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf); // $PLAT is still on its curve
        _fund(1 ether);

        uint256 devBefore = devWallet.balance;
        uint256 lpShare = (1 ether * t.lpBps()) / 10_000;

        // Anyone may trigger it; nobody chooses where it lands.
        // **Both reads resolved BEFORE the prank is armed.** `vm.prank` attaches
        // to the next CALL, and Solidity does not specify the order in which a
        // function's arguments are evaluated — so with `t.devBps()` written
        // inline, whichever of the two solc emits first takes the prank, and on
        // the wrong ordering `payDev` runs as this contract. The assertion
        // passes either way, which is what makes it worth fixing: the prank was
        // decoration, not a guard. See `test/CheatcodeOrder.t.sol`.
        uint256 expected = (1 ether * t.devBps()) / 10_000;
        vm.prank(stranger);
        assertEq(t.payDev(), expected, "the dev share must move");
        assertEq(devWallet.balance - devBefore, (1 ether * t.devBps()) / 10_000, "dev must be paid");

        // And the LP pocket is untouched by it: before graduation the only
        // function that spends it, `addLiquidity`, has no pool to spend it into.
        assertEq(t.lpPool(), lpShare, "the LP pocket must be intact after payDev");
        vm.expectRevert(Treasury.GraduatedNotSupportedYet.selector);
        t.addLiquidity();
        assertEq(t.lpPool(), lpShare, "and intact after the refusal");

        // Emptied, and refused below the minimum.
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 0, t.MIN_MOVE()));
        t.payDev();
    }

    /// @notice The burn computes its own floor from the curve, and it is the
    ///         exact output — because the curve is `x·y = k` less 5.00 %.
    ///
    /// @dev    The measurement `docs/recon-launchpad.md` records, executed
    ///         rather than quoted. If Pons ever changed the curve's shape, this
    ///         is the test that would say so.
    function test_TheBurnPricesItselfFromTheCurve() public {
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf);

        _fund(1 ether);
        t.split();
        uint256 spend = t.burnPool();
        assertGt(spend, t.MIN_MOVE(), "fixture assumes a burn worth doing");

        (uint256 q, uint256 tok) = IPonsV2BondingCurve(PLAT_CURVE).getReserves();
        uint256 eff = (spend * 9_500) / 10_000; // 400 creator tax + 100 curve fee
        uint256 expected = (tok * eff) / (q + eff);

        uint256 deadBefore = IERC20(PLAT).balanceOf(DEAD);
        vm.recordLogs();
        vm.prank(stranger); // permissionless, and unrefunded
        uint256 burned = t.buyAndBurn();

        assertEq(burned, expected, "the curve must be constant product less 5.00 pct");

        // **The floor has to BIND, not merely exist.** Asserting on the output
        // alone proves the curve model and nothing else: the amount received is
        // what the curve gives whatever floor was passed, so a floor of 1 would
        // sail through. What matters is the number the contract actually handed
        // the curve, and that it sits a hair under the expected output.
        uint256 floorUsed = _floorFromLogs();
        assertEq(floorUsed, (expected * (10_000 - t.MAX_SLIPPAGE_BPS())) / 10_000, "the floor must be the real one");
        assertGt(floorUsed, (expected * 98) / 100, "a floor that loose would let a sandwich through");
        assertEq(IERC20(PLAT).balanceOf(DEAD) - deadBefore, burned, "the tokens must be burnt, not held");
        assertEq(IERC20(PLAT).balanceOf(address(t)), 0, "the Treasury must keep no token");
        assertEq(t.burnPool(), 0, "the pocket must be spent");
    }

    /// @notice And the curve really enforces the floor it is handed.
    ///
    /// @dev    Our floor is only worth what the curve does with it. Asked for
    ///         more than it can give, it must refuse — otherwise every number
    ///         computed above is decoration.
    function test_TheCurveRefusesBelowTheFloorItIsGiven() public {
        (uint256 q, uint256 tok) = IPonsV2BondingCurve(PLAT_CURVE).getReserves();
        uint256 eff = (0.01 ether * 9_500) / 10_000;
        uint256 exact = (tok * eff) / (q + eff);

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert();
        IPonsV2BondingCurve(PLAT_CURVE).buy{value: 0.01 ether}(0.01 ether, exact + 1, stranger);

        // And at exactly the amount it can give, it goes through.
        vm.prank(stranger);
        IPonsV2BondingCurve(PLAT_CURVE).buy{value: 0.01 ether}(0.01 ether, exact, stranger);
    }

    /// @dev `floorUsed` from the `Burned` event.
    function _floorFromLogs() internal returns (uint256 floorUsed) {
        bytes32 topic = keccak256("Burned(uint256,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) (,, floorUsed) = abi.decode(logs[i].data, (uint256, uint256, uint256));
        }
    }

    /// @notice The burn works PAST graduation, and its limit degrades instead
    ///         of blocking.
    ///
    /// @dev    The question that shaped this path: a floor would deadlock the
    ///         moment $PLAT's price rose more than the band, because the
    ///         reference only updates on success. A v4 price limit fills
    ///         PARTIALLY instead — measured in `test/V4Swap.t.sol` — so the
    ///         burn always runs, buys what fits, and keeps the rest.
    ///
    ///         SQUEEZE is the fixture because it is a Pons launch that really
    ///         graduated, paired in native ETH. Nothing about the pool, the
    ///         hook or the swap is mocked.
    function test_TheBurnWorksPastGraduationAndNeverBlocks() public {
        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf);

        _fund(1 ether);
        t.split();
        uint256 pocket = t.burnPool();
        uint256 deadBefore = IERC20(SQUEEZE).balanceOf(DEAD);

        // First burn: no reference yet, so it takes the pool as it stands.
        uint256 burned = t.buyAndBurn();
        assertGt(burned, 0, "the graduated path must buy");
        assertEq(IERC20(SQUEEZE).balanceOf(DEAD) - deadBefore, burned, "and burn, not hold");
        assertEq(IERC20(SQUEEZE).balanceOf(address(t)), 0, "the Treasury must never hold the token");
        assertGt(t.lastBurnSqrtPrice(), 0, "the reference must be recorded for the next one");

        // Whatever the limit stopped it from spending stays in the pocket.
        assertLe(t.burnPool(), pocket, "the pocket cannot grow from a burn");

        // A second burn, one cooldown later and against a moved price, must
        // still go through — that is the whole point of a limit over a floor.
        vm.warp(block.timestamp + t.BURN_COOLDOWN());
        _fund(1 ether);
        uint256 burned2 = t.buyAndBurn();
        assertGt(burned2, 0, "a banded burn must still buy something");
    }

    /// @notice A run of partial fills widens the band until one clears.
    ///
    /// @dev    The flaw this fixes: measuring the band from the LAST BURN pins
    ///         it at exactly `BURN_BAND_BPS` for any steady cadence — every
    ///         burn arrives one cooldown after the previous, so the band never
    ///         grows. A price rising faster than the band would then make every
    ///         burn fill partially, for ever, and the pocket would grow without
    ///         ever catching up.
    ///
    ///         Measuring from the last FULL burn is what ends the run. This
    ///         checks the mechanism: a burn that filled everything moves
    ///         `lastFullBurnAt`, one that did not leaves it be — so the next
    ///         band is wider by exactly the time this one waited.
    function test_APartialFillDoesNotResetTheBand() public {
        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf);

        _fund(1 ether);
        t.buyAndBurn();
        uint256 firstFull = t.lastFullBurnAt();
        assertGt(firstFull, 0, "a burn must stamp when it last took everything");

        // A pocket far larger than the band allows: the limit has to bite.
        vm.warp(block.timestamp + t.BURN_COOLDOWN());
        _fund(200 ether);
        uint256 pocket = t.burnPool() + (200 ether * t.burnBps()) / 10_000;
        t.buyAndBurn();

        if (t.burnPool() > 0) {
            // It filled partially, which is the case under test.
            assertEq(t.lastFullBurnAt(), firstFull, "a partial fill must not move the full-burn stamp");
            assertLt(t.burnPool(), pocket, "and it must still have spent something");
        } else {
            assertGt(t.lastFullBurnAt(), firstFull, "a full fill must move the stamp");
        }
    }

    /// @notice The LP pocket becomes protocol-owned liquidity, by itself.
    ///
    /// @dev    This is what removes the design's one point of trust. The share
    ///         used to go to a Safe that added it by hand, because nobody knew
    ///         whether the Pons hook allowed adding at all. It does.
    ///
    ///         And it checks the thing that makes it safe: `modifyLiquidity`
    ///         lives on the PoolManager, so the position belongs to the
    ///         Treasury with no NFT in between — there is nothing to approve,
    ///         nothing to transfer, and no function here that removes it.
    function test_TheLpPocketBecomesLiquidityAndKeepsItsRemainder() public {
        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf);

        _fund(4 ether);
        t.split();
        uint256 pocket = t.lpPool();
        assertGt(pocket, t.MIN_MOVE(), "fixture assumes a pocket worth placing");

        vm.prank(stranger); // permissionless, and unrefunded
        (uint256 ethUsed, uint256 tokenUsed) = t.addLiquidity();

        assertGt(ethUsed, 0, "a position must consume ETH");
        assertGt(tokenUsed, 0, "and the token side too");

        // **It never consumes everything, and that is by construction**: the
        // ratio is the price's to decide. What is left goes back to the pocket
        // for next time, exactly like a skipped leg or a capped burn.
        assertGt(t.lpPool(), 0, "the remainder must return to the pocket");
        assertLt(t.lpPool(), pocket, "but most of it must have been placed");

        // The Treasury holds no loose ETH beyond what the pockets claim.
        assertGe(
            address(t).balance,
            t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(),
            "the pockets must stay covered"
        );
    }

    /// @notice A Pons position earns NO swap fee, and a second addition still
    ///         works.
    ///
    /// @dev    Measured rather than assumed: every graduated Pons launch read
    ///         on-chain carries `poolFee = 0`. The pool charges nothing and the
    ///         hook takes the fee in `afterSwap`, so there is no LP income —
    ///         which is why no `collectLpFees` exists. What the liquidity pays
    ///         goes to the launch's `creatorFeeRecipient` instead, and for
    ///         $PLAT that is its own vault: it reaches holders as stock rather
    ///         than accruing in a position.
    ///
    ///         The second addition is the part that matters for correctness:
    ///         `modifyLiquidity` realises fees in the same delta as the
    ///         principal, and v4 reverts the whole `unlock` on any unsettled
    ///         delta. The callback handles both signs so a pool that DOES
    ///         charge would not break this the day it becomes productive.
    function test_APonsPositionEarnsNoSwapFeeAndStillAcceptsMore() public {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(SQUEEZE);
        assertEq(l.poolFee, 0, "a Pons pool charges nothing: the hook does");

        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf);

        _fund(4 ether);
        t.addLiquidity();
        uint128 first = t.lpLiquidity();
        int24 lower = t.lpLower();
        assertGt(first, 0, "the position must be recorded");

        _fund(4 ether);
        (uint256 ethUsed,) = t.addLiquidity();
        assertGt(ethUsed, 0, "a second addition must go through");
        assertGt(t.lpLiquidity(), first, "and compound the same position");
        assertEq(t.lpLower(), lower, "on the same range, so it stays trackable");
    }

    /// @notice Before graduation there is no pool, so the pocket simply waits.
    ///
    /// @dev    Waiting is the whole behaviour now. There is no hatch to the Safe
    ///         any more, so the accepted cost is stated here rather than in a
    ///         comment: a token that never graduates leaves this ETH
    ///         immobilised, and that is preferred to a door standing open for
    ///         the life of the contract.
    function test_LiquidityRefusesBeforeGraduationAndTheLpPocketJustWaits() public {
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf); // still on its curve

        _fund(1 ether);
        // `_fund` only sends the ETH; the pockets are credited by `_split`, and
        // reading `lpPool` before it has run reads zero rather than the share.
        t.split();
        uint256 share = (1 ether * t.lpBps()) / 10_000;
        vm.expectRevert(Treasury.GraduatedNotSupportedYet.selector);
        t.addLiquidity();
        assertEq(t.lpPool(), share, "the pocket keeps its share");

        // A second funding accumulates on top rather than being divertible.
        _fund(1 ether);
        t.split();
        assertEq(t.lpPool(), share * 2, "and it accumulates, like burn and rewards");
    }

    /// @notice The LP pocket has exactly ONE exit, and it leads into a position
    ///         nothing can take back.
    ///
    /// @dev    This is what replaced `test_TheSafeHatchClosesOnceThePoolExists`.
    ///         That test checked a hatch reverted after graduation; the hatch is
    ///         gone, so what is worth checking is the stronger statement: every
    ///         other permissionless mover on this contract leaves `lpPool`
    ///         exactly where it was, and only `addLiquidity` spends it.
    ///
    ///         Mutation check, run 2026-09-10: adding `lpPool = 0` to `payDev`
    ///         fails this test, `test_TheDevPocketGoesWhereItMustAndNowhereElse`
    ///         and `test_TheBurnWaitsForTheTokenWithoutStrandingAnything`, each
    ///         naming the pocket by name rather than returning a bare revert.
    ///
    ///         **What it does NOT catch, stated so nobody relies on it:** a
    ///         brand-new function that drains the pocket. This test enumerates
    ///         the surface as it stands, and so does the `DevPathInvariants`
    ///         balance sheet — a fuzz campaign only calls the selectors its
    ///         handler lists. A new exit is caught by review against `FLOWS.md`
    ///         §5, which is why that list is maintained rather than inferred.
    function test_TheLpPocketHasExactlyOneExit() public {
        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf); // graduated

        _fund(1 ether);
        t.split(); // credits the four pockets; without it `lpPool` is still zero
        uint256 held = t.lpPool();
        assertGt(held, 0, "the pocket must hold something to be worth testing");

        // Every other open money-mover, in turn. None may touch the pocket.
        vm.prank(stranger);
        t.payDev();
        assertEq(t.lpPool(), held, "payDev must not touch the LP pocket");
        vm.prank(stranger);
        t.buyAndBurn();
        assertEq(t.lpPool(), held, "buyAndBurn must not touch the LP pocket");
        // Wrapped, because on THIS fixture the bound vault is the real launch's
        // `creatorFeeRecipient` — an EOA — so the call reverts on a payment to a
        // non-contract. Either way the pocket must read the same afterwards: a
        // revert rolls the state back, and a success spends `rewardsPool` and
        // nothing else. Wrapping keeps the assertion meaningful on a fixture
        // where the vault IS a contract instead of tying it to this one.
        vm.prank(stranger);
        try t.fundPlatformRewards() {} catch {}
        assertEq(t.lpPool(), held, "fundPlatformRewards must not touch the LP pocket");
        vm.prank(stranger);
        t.split();
        assertEq(t.lpPool(), held, "split must not touch the LP pocket");

        // And the one exit works, into a position with no removal path.
        (uint256 ethUsed,) = t.addLiquidity();
        assertGt(ethUsed, 0, "addLiquidity is the only way out, and it must work");
        assertLt(t.lpPool(), held, "and it must actually spend the pocket");
    }

    /// @notice **T-COV-01, the graduated half — three refusals and a clamp that
    ///         only a graduated fixture can reach.**
    ///
    /// @dev    `docs/AUDIT_FIXES.md` §3.12 classified the branches left after
    ///         `TreasuryGuards.t.sol` into three piles, and the largest was
    ///         "needs a graduated fixture with real liquidity". SQUEEZE is that
    ///         fixture — a Pons launch that really graduated, paired in native
    ///         ether — and this is the pile, on the paths that spend.
    function test_TheGraduatedPathsRefuseBelowTheirFloorsToo() public {
        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf);

        // A hundred wei, split four ways: every pocket far under `MIN_MOVE`.
        // Past graduation `addLiquidity` gets past its `GraduatedNotSupportedYet`
        // guard and reaches the floor, which is the arm an ungraduated fixture
        // can never see.
        _fund(100);
        uint256 floor_ = t.MIN_MOVE();
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 16, floor_));
        t.addLiquidity();

        assertEq(address(t).balance, 100, "refusing spends nothing");
    }

    /// @notice **The burn's band is CAPPED, and only a long silence shows it.**
    ///
    /// @dev    `_burnOnPool` widens the price band with the time since the last
    ///         FULL burn — a stale anchor deserves less trust — and then clamps
    ///         it at `BURN_BAND_CAP_BPS`. The clamp is what stops a vault that
    ///         has not burned for a month from executing against a band wide
    ///         enough to be no band at all. Nothing reached it: the cooldown
    ///         test warps by one cooldown, and one cooldown is exactly one band.
    ///
    ///         Asserted through what it PRODUCES rather than by reading the
    ///         local: after a very long silence the burn still runs and still
    ///         buys, which is only true if the band was clamped to something a
    ///         v4 limit accepts.
    function test_ALongSilenceDoesNotWidenTheBurnBandWithoutLimit() public {
        t = _treasuryFor(SQUEEZE);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(SQUEEZE, realVaultOf);

        _fund(1 ether);
        t.buyAndBurn(); // the first one, which sets the anchor

        // A month of nothing. `elapsed / BURN_COOLDOWN` is ~180, so the band
        // asks for 180x `BURN_BAND_BPS` and the cap is the only thing between
        // that and a limit the pool would ignore.
        vm.warp(block.timestamp + 30 days);
        _fund(1 ether);

        uint256 burnedBefore = IERC20(SQUEEZE).balanceOf(DEAD);
        uint256 burned = t.buyAndBurn();
        assertGt(burned, 0, "after a month of silence the burn still buys");
        assertEq(
            IERC20(SQUEEZE).balanceOf(DEAD) - burnedBefore, burned, "and what it bought really went to the dead address"
        );
    }

    /// @notice **A sweep of dust refuses rather than swapping into nothing.**
    ///
    /// @dev    `sweepToEth` derives its floor from the declared pool's TWAP and
    ///         then takes `MAX_SWEEP_SLIPPAGE_BPS` off it. On an amount small
    ///         enough the floor rounds to zero — and a zero floor is `minOut = 0`,
    ///         which this system forbids everywhere. So it stops, and the dust
    ///         waits for the next payment to make it worth moving.
    ///
    ///         One wei of an 18-decimal stock is that amount: at ~$180 a share
    ///         against ~$2,400 an ether it is ~7.5e-20 ETH, which is zero wei.
    function test_ASweepOfDustRefusesRatherThanSwappingIntoNothing() public {
        address[] memory tok = new address[](1);
        uint24[] memory weth = new uint24[](1);
        uint24[] memory none = new uint24[](1);
        tok[0] = NVDA;
        weth[0] = 500;
        vm.prank(timelock);
        t.allowSweeps(tok, weth, none);

        deal(NVDA, address(t), 1);
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.sweepToEth(NVDA, 0);

        assertEq(IERC20(NVDA).balanceOf(address(t)), 1, "the dust waits rather than leaving at no price at all");
    }

    /// @notice The burn runs at most every four hours.
    function test_TheBurnHasACooldown() public {
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf);
        _fund(1 ether);
        t.buyAndBurn();

        _fund(1 ether);
        uint256 ready = t.lastBurnAt() + t.BURN_COOLDOWN();
        vm.expectRevert(abi.encodeWithSelector(Treasury.TooSoon.selector, ready));
        t.buyAndBurn();

        vm.warp(ready);
        t.buyAndBurn(); // and at the boundary it goes through
    }

    /// @notice Nothing burns before the platform token exists, and nothing is
    ///         lost while it does not.
    function test_TheBurnWaitsForTheTokenWithoutStrandingAnything() public {
        _fund(1 ether);

        vm.expectRevert(Treasury.NotBound.selector);
        t.buyAndBurn();

        // The dev payment, on the other hand, works end to end: its
        // destination is written from birth, it waits on nobody.
        t.payDev();
        assertEq(t.burnPool(), (1 ether * t.burnBps()) / 10_000, "the burn pocket must have kept its share");
        assertEq(t.lpPool(), (1 ether * t.lpBps()) / 10_000, "the LP pocket must have kept its share");
        assertEq(t.rewardsPool(), (1 ether * t.rewardsBps()) / 10_000, "and the rewards pocket too");

        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf);
        t.buyAndBurn();
        assertEq(t.burnPool(), 0, "and spend it once the token is known");
        // The LP pocket keeps waiting, because $PLAT is on its curve and there
        // is no pool yet. Nothing else can reach it.
        assertEq(t.lpPool(), (1 ether * t.lpBps()) / 10_000, "the LP pocket keeps waiting for a pool");
    }

    /// @notice **Wiring the Treasury takes TWO keys, and nothing gets through
    ///         with one.**
    ///
    /// @dev    The test that holds the audit's central fix. The previous version
    ///         let the Safe name the destination vault in one argument, with no
    ///         delay: since any contract can be the `creatorFeeRecipient` of a
    ///         Pons launch (`docs/recon.md` §1.2), all it took was launching a
    ///         decoy token pointing at a six-line contract, binding it, and
    ///         `fundPlatformRewards` — **permissionless** — paid a third of
    ///         everything that will ever enter here into that contract. "Only
    ///         once" bounds nothing when the first shot is the right one.
    ///
    ///         The pair is approved as one block: naming the right token with
    ///         the wrong vault would redirect the rewards pocket, naming the
    ///         right vault with the wrong token would make the buyback buy
    ///         somebody else's token. A hash of the two makes each inseparable
    ///         from the other.
    function test_TheWiringNeedsBothKeysAndNeitherAlone() public {
        // 1. The timelock alone: refused. That is the case that matters — a
        //    compromised timelock can no longer wire anything here.
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotApproved.selector);
        t.bindPlatform(PLAT, realVaultOf);

        // 2. The generation key alone: it approves, it does not name.
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        assertEq(t.platformToken(), address(0), "approving does not name");
        assertEq(address(t.platformVault()), address(0), "and does not wire the rewards pocket");

        // 3. Nobody else approves, timelock included.
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotGenerationKey.selector);
        t.approvePlatform(SQUEEZE, realVaultOf);

        // 4. The two together.
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf);
        assertEq(t.platformToken(), PLAT, "the two keys together must go through");
        assertEq(address(t.platformVault()), realVaultOf, "and the rewards pocket is wired");
    }

    /// @notice The approved pair is the one that must be named, not another.
    ///
    /// @dev    What is left of the on-chain checks: they do not stop two keys
    ///         that collude — nothing can — but they rule out the typo, and that
    ///         is already what they were written for.
    function test_BindingChecksTheLaunchAndHappensOnce() public {
        // A vault that is not the token's fee recipient.
        vm.prank(generationKey);
        t.approvePlatform(PLAT, notTheRecipient);
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotBound.selector);
        t.bindPlatform(PLAT, notTheRecipient);

        // An address that is not a launch at all.
        vm.prank(generationKey);
        t.approvePlatform(notALaunch, realVaultOf);
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotBound.selector);
        t.bindPlatform(notALaunch, realVaultOf);

        // Approving one pair does not authorise the other.
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotApproved.selector);
        t.bindPlatform(SQUEEZE, realVaultOf);

        // And once named, for good.
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf);
        vm.prank(generationKey);
        t.approvePlatform(SQUEEZE, realVaultOf);
        vm.prank(timelock);
        vm.expectRevert(Treasury.AlreadyBound.selector);
        t.bindPlatform(SQUEEZE, realVaultOf);
    }

    /// @notice `followMigration` follows the vault, and goes nowhere else.
    ///
    /// @dev    It takes no argument: calling it is not a choice, it is an
    ///         update. The only reachable destination is the one the current
    ///         vault declares itself, and `migratedTo` is written only by
    ///         `FeeVault.migrate` — timelock, 48 h, six checks.
    ///
    ///         **`vm.etch`, and not `vm.mockCall`.** On this fork, the fixture
    ///         launch's `creatorFeeRecipient` is an EOA: it can neither receive
    ///         `fundRewards` nor answer `migratedTo`. We put OUR code at the
    ///         address Pons designates — Pons goes on telling the truth, none of
    ///         its state is simulated. Simulating its answer would be refused by
    ///         the project's rules, and rightly so.
    function test_FollowMigrationGoesWhereTheVaultWentAndNowhereElse() public {
        PlatformVaultStub template = new PlatformVaultStub();
        vm.etch(realVaultOf, address(template).code);
        // **`etch` replaces the code, not the storage.** The address Pons
        // designates here is a deployed Safe, and slot 0 of a Safe holds its
        // singleton's address -- so the stub read a non-zero `migratedTo` there
        // and followed a migration that had not happened. An hour lost the first
        // time.
        vm.store(realVaultOf, bytes32(0), bytes32(0));
        vm.store(realVaultOf, bytes32(uint256(1)), bytes32(0));
        PlatformVaultStub bound = PlatformVaultStub(payable(realVaultOf));
        PlatformVaultStub next = new PlatformVaultStub();

        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVaultOf);
        vm.prank(timelock);
        t.bindPlatform(PLAT, realVaultOf);

        // Nothing to follow until the vault has moved.
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.followMigration();

        bound.setMigratedTo(address(next));
        vm.prank(stranger); // permissionless: this is not a decision
        assertEq(t.followMigration(), address(next), "the pocket must follow the vault");
        assertEq(address(t.platformVault()), address(next), "et s'y tenir");

        // The same migration is not followed twice.
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.followMigration();

        // And the pocket now arrives at the successor, and at it alone.
        _fund(1 ether);
        t.fundPlatformRewards();
        assertEq(bound.received(), 0, "nothing left at the old one");
        assertGt(next.received(), 0, "everything at the new one");
    }

    // --------------------------------------------------- third currencies

    /// @notice **A token received here is no longer stuck here.**
    ///
    /// @dev    The hole this plugs, and it was a big one. `FeeVault._pay` sends
    ///         the platform share in the VAULT'S CURRENCY: a USDG-quoted vault
    ///         pays in USDG, an NVDA-quoted vault pays in NVDA. But this contract
    ///         only knew about ETH — `_split` measures `address(this).balance`,
    ///         and no withdrawal exists. Those tokens were lost, permanently.
    ///
    ///         Measurement of 2026-09-08 (`docs/CONVENTIONS.md`): 40.9 % of Pons volume is
    ///         ETH-quoted, **22.0 % USDG and 37.2 % stock tokens** — that is
    ///         ~59 % of the platform's revenue landing in a contract unable to
    ///         see it.
    ///
    ///         The USDG/WETH pool is real and it is the deepest on the chain:
    ///         nothing is simulated here.
    function test_AThirdPartyCurrencyBecomesEthAndReachesThePockets() public {
        _allow(USDG, 100, 0); // the measured tier, `docs/recon.md` §4.1

        deal(USDG, address(t), 5_000e6); // 5 000 USDG
        assertEq(address(t).balance, 0, "the fixture starts from a Treasury with no ETH");

        vm.prank(stranger); // permissionless, aucune destination en argument
        uint256 out = t.sweepToEth(USDG, 0);
        assertGt(out, 0, "the sweep must return ETH");
        assertEq(IERC20(USDG).balanceOf(address(t)), 0, "and leave nothing behind");

        // The ETH belongs to no pocket: the next split divides it four ways,
        // exactly like a donation.
        assertEq(t.split(), out, "everything must be allocated");
        assertEq(t.devPool(), (out * t.devBps()) / 10_000, "dev");
        assertEq(
            t.rewardsPool(),
            out - (out * t.devBps()) / 10_000 - (out * t.burnBps()) / 10_000 - (out * t.lpBps()) / 10_000,
            "holders"
        );
    }

    /// @notice The sweep refuses a token the timelock has not declared.
    ///
    /// @dev    Same rule as `Allocation.poolFee` and `quoteListing`: the route is
    ///         measured, never guessed at the moment the money moves. The most
    ///         likely mistake is the right token at the wrong tier, and probing
    ///         does not catch it.
    function test_SweepingRefusesAnUndeclaredToken() public {
        deal(USDG, address(t), 5_000e6);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, USDG));
        t.sweepToEth(USDG, 0);

        address[] memory one = new address[](1);
        one[0] = USDG;
        uint24[] memory tier = new uint24[](1);
        tier[0] = 100;
        vm.expectRevert(Treasury.NotTimelock.selector);
        t.allowSweeps(one, tier, new uint24[](1));
    }

    /// @notice **A route may be repointed, never removed.**
    ///
    /// @dev    `Payd._requireSweepable` makes the registry refuse a quote this
    ///         list does not carry, so the way out exists before the way in.
    ///         The inverse had no guard: zeroing both tiers on a currency whose
    ///         vaults are already live closes the way out AFTER the way in, and
    ///         those vaults are stamped with their quote for life — they keep
    ///         paying in something that can no longer leave. It does not
    ///         revert. It accumulates.
    ///
    ///         Repointing is the operation that actually comes up, and it stays
    ///         open: a pool that dries out is replaced by naming another tier.
    ///         Only naming NONE is forbidden.
    function test_ASweepRouteIsRepointableButNotRemovable() public {
        _allow(USDG, 100, 0);
        assertEq(t.sweepFee(USDG), 100, "listed on the pivot's own pool");

        // Repointing: another tier, same token, no ceremony.
        _allow(USDG, 3000, 0);
        assertEq(t.sweepFee(USDG), 3000, "a route can move");

        // Removing: refused, and by the same error the undeclared case uses —
        // there is one answer to "this token has no way out", whichever side it
        // is asked from.
        address[] memory tokens = new address[](1);
        tokens[0] = USDG;
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, USDG));
        t.allowSweeps(tokens, new uint24[](1), new uint24[](1));
        assertEq(t.sweepFee(USDG), 3000, "and the route it had is untouched");
    }

    /// @notice The sweep's floor bites, and the caller can only tighten it.
    function test_TheSweepFloorBindsAndTheCallerCanOnlyTightenIt() public {
        _allow(USDG, 100, 0);
        deal(USDG, address(t), 5_000e6);

        // A floor the market cannot hold: the caller's transaction fails, and
        // nothing else.
        vm.expectRevert();
        t.sweepToEth(USDG, 100 ether);

        assertEq(IERC20(USDG).balanceOf(address(t)), 5_000e6, "nothing moved");
        assertGt(t.sweepToEth(USDG, 0), 0, "and the normal path still works");
    }

    /// @dev One row, through the timelock. The API is a batch because the list
    ///      is forty rows long and each timelock OPERATION costs 48 hours.
    function _allow(address token, uint24 wethFee, uint24 pivotFee) internal {
        address[] memory tokens = new address[](1);
        uint24[] memory wethFees = new uint24[](1);
        uint24[] memory pivotFees = new uint24[](1);
        (tokens[0], wethFees[0], pivotFees[0]) = (token, wethFee, pivotFee);
        vm.prank(timelock);
        t.allowSweeps(tokens, wethFees, pivotFees);
    }

    /// @notice **A currency with no `token/WETH` pool at all still leaves as
    ///         ETH, through the pivot.**
    ///
    /// @dev    This is the hole `test_EveryListedQuoteCanLeaveTheTreasuryAsEth`
    ///         opened on 2026-09-10, and PLTR is one of the ten it named: a
    ///         listed quote, so a vault can be PAID in it, with no pool against
    ///         WETH on any of the four tiers. The old single-hop sweep had
    ///         nothing to offer it — the money arrived and stayed.
    ///
    ///         The detour's second hop is the `USDG/WETH` pool the direct sweep
    ///         above already uses and every ETH-quoted vault already crosses.
    ///         One pool, two uses. Nothing is simulated: the pools are real and
    ///         the absence of the `PLTR/WETH` one is the reason this test exists.
    function test_ACurrencyWithNoWethPoolLeavesThroughThePivot() public {
        for (uint256 i; i < 4; ++i) {
            uint24[4] memory tiers = [uint24(100), 500, 3000, 10_000];
            assertEq(
                IUniswapV3Factory(V3_FACTORY).getPool(PLTR, WETH, tiers[i]),
                address(0),
                "fixture: PLTR must have no WETH pool, or this proves nothing"
            );
        }

        _allow(PLTR, 0, 3000); // the tier `Quotelist` measured against USDG
        // ~$1 000, i.e. 40x the list's ~$25 `minBuy` for PLTR. **The size is
        // part of the measurement**: the listing floor is $5 000 absorbable
        // before +1 %, so a sweep of $33 000 reverts `Too little received` on a
        // floor that is right to bite, and it reads exactly like a routing bug.
        deal(PLTR, address(t), 6e18);
        assertEq(address(t).balance, 0, "the fixture starts from a Treasury with no ETH");

        vm.prank(stranger); // permissionless, no destination in the arguments
        uint256 out = t.sweepToEth(PLTR, 0);
        assertGt(out, 0, "PLTR -> USDG -> WETH -> ETH");
        assertEq(IERC20(PLTR).balanceOf(address(t)), 0, "and nothing is left behind");
        assertEq(t.split(), out, "the ETH belongs to no pocket and is shared four ways");
    }

    /// @notice A row declares ONE route, and the pivot cannot route through
    ///         itself.
    ///
    /// @dev    Both tiers at once would be the contract choosing in place of
    ///         whoever did the measuring; `PIVOT` with a pivot tier would build
    ///         a `USDG, fee, USDG` path no pool can serve. Both zero is NOT an
    ///         error — it is the only way to delist.
    function test_ASweepRowDeclaresExactlyOneRoute() public {
        address[] memory tokens = new address[](1);
        uint24[] memory wethFees = new uint24[](1);
        uint24[] memory pivotFees = new uint24[](1);

        (tokens[0], wethFees[0], pivotFees[0]) = (PLTR, 500, 3000);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, PLTR));
        t.allowSweeps(tokens, wethFees, pivotFees);

        (tokens[0], wethFees[0], pivotFees[0]) = (USDG, 0, 100);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, USDG));
        t.allowSweeps(tokens, wethFees, pivotFees);

        // **Both zero used to DELIST, and that is what changed.**
        //
        // It was a deliberate capability with this test behind it, and it was
        // the more dangerous half of the pair. `Payd._requireSweepable` now
        // makes the registry refuse a quote this list does not carry — the way
        // out before the way in. Delisting here is that door closing AFTER the
        // way in: the vaults already created with that quote are stamped with
        // it for life and keep paying us in it, and the payments would neither
        // revert nor be recoverable. They would accumulate.
        //
        // What is lost is the ability to tidy the list. What is kept is
        // repointing, which is the operation that actually comes up, and a
        // stale row costs nothing — `sweepToEth` reverts `NoPool` and the money
        // waits for a route rather than being locked out of one.
        _allow(PLTR, 0, 3000);
        (tokens[0], wethFees[0], pivotFees[0]) = (PLTR, 0, 0);
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, PLTR));
        t.allowSweeps(tokens, wethFees, pivotFees);
        assertEq(t.sweepPivotFee(PLTR), 3000, "the row it had survives the attempt");
    }

    // -------------------------------------------------------- the succession

    /// @notice **Everything moves to a successor, under two keys, once.**
    ///
    /// @dev    This is the only function in the system that moves funds to an
    ///         address somebody names, and it is written as such rather than
    ///         disguised. It exists because this contract has no withdrawal: if a
    ///         defect made it unusable, everything it holds would be lost, and
    ///         the vaults already created would go on paying it forever — their
    ///         `PLATFORM` is written at their birth.
    ///
    ///         Three locks, and this test holds all three.
    function test_TheTreasuryMigratesUnderTwoKeysOnceAndOnlyToASuccessor() public {
        _fund(3 ether);
        t.split();
        uint256 dev = t.devPool();
        uint256 held = address(t).balance;

        Treasury next = _successorOf(t);

        // 1. The timelock alone: refused.
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotApproved.selector);
        t.migrateTreasury(address(next));

        // 2. The key alone: it approves, it does not move anything.
        vm.prank(generationKey);
        t.approveTreasury(address(next));
        assertEq(address(t).balance, held, "approving moves nothing");

        // 3. The destination has to be expecting you: an EOA has no
        //    `receiveMigration`, and a Treasury that does not declare you as its
        //    predecessor refuses it.
        vm.prank(generationKey);
        t.approveTreasury(stranger);
        vm.prank(timelock);
        vm.expectRevert();
        t.migrateTreasury(stranger);

        // 4. Both keys, towards a real successor.
        vm.prank(generationKey);
        t.approveTreasury(address(next));
        vm.prank(timelock);
        t.migrateTreasury(address(next));

        assertEq(address(t).balance, 0, "the old one keeps nothing");
        assertEq(address(next).balance, held, "and the new one has everything");
        assertEq(next.devPool(), dev, "the pockets arrive as they are");
        assertEq(t.devPool(), 0, "and the old one emptied them");

        // One way: never anywhere else again.
        Treasury other = _successorOf(t);
        vm.prank(generationKey);
        t.approveTreasury(address(other));
        vm.prank(timelock);
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.migrateTreasury(address(other));
    }

    /// @notice What arrives AFTER the migration follows, without anyone
    ///         choosing where.
    ///
    /// @dev    The vaults already created pay the old Treasury forever — their
    ///         `PLATFORM` is immutable, and that is what guarantees a creator
    ///         that the platform will not redirect itself at their expense.
    ///         Without `pushAll`, everything they pay in after a migration would
    ///         stay stranded. The destination is not an argument: it is
    ///         `migratedTo`.
    function test_LatePaymentsFollowTheMigrationAndNobodyChoosesWhere() public {
        Treasury next = _successorOf(t);
        vm.prank(generationKey);
        t.approveTreasury(address(next));
        vm.prank(timelock);
        t.migrateTreasury(address(next));

        // A vault from before pays the old one, as it always will.
        _fund(1 ether);
        assertEq(address(t).balance, 1 ether, "the old one still receives");

        // And the old one's exits are closed: nothing accumulates there.
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.payDev();

        vm.prank(stranger); // permissionless
        assertEq(t.pushAll(address(0)), 1 ether, "everything must follow");
        assertEq(address(next).balance, 1 ether, "et arriver au successeur");
    }

    /// @dev A successor that declares `t` as its predecessor -- the only shape
    ///      `migrateTreasury` accepts.
    function _successorOf(Treasury from) internal returns (Treasury) {
        return new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: devWallet,
                generationKey: generationKey,
                predecessor: address(from),
                ponsFactory: PONS_FACTORY,
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

    /// @notice Reweighting goes through the timelock, and must stay a partition.
    function test_OnlyTheTimelockReweightsAndItMustSumTo10000() public {
        vm.expectRevert(Treasury.NotTimelock.selector);
        t.setSplit(2_500, 1_250, 1_250, 5_000);

        vm.prank(timelock);
        vm.expectRevert(Treasury.BadSplit.selector);
        t.setSplit(3_333, 1_667, 1_667, 3_332);

        // **The dev share can only go down.** Without this ratchet,
        // `setSplit(10_000, 0, 0, 0)` is a perfectly legal partition: two
        // timelock operations, and every wei that enters here belongs to the dev
        // pocket. The ceiling is what gives the sentence "the dev takes a third"
        // its value.
        uint256 devBefore = t.devBps();
        vm.prank(timelock);
        vm.expectRevert(Treasury.BadSplit.selector);
        t.setSplit(10_000, 0, 0, 0);

        vm.prank(timelock);
        vm.expectRevert(Treasury.BadSplit.selector);
        t.setSplit(devBefore + 1, 1_667, 1_666, 10_000 - devBefore - 3_334);

        // Rebalancing the other three among themselves stays entirely open.
        vm.prank(timelock);
        t.setSplit(1_000, 1_000, 1_000, 7_000);
        _fund(1 ether);
        t.split();
        assertEq(t.rewardsPool(), 0.7 ether, "the new weights must apply to what arrives next");

        // And a ratchet is a ratchet: there is no going back up towards the
        // old value either.
        vm.prank(timelock);
        vm.expectRevert(Treasury.BadSplit.selector);
        t.setSplit(devBefore, 1_667, 1_667, 10_000 - devBefore - 3_334);
    }

    receive() external payable {}
}

