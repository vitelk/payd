// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {IERC20, IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";

/// @notice **T-COV-01 — the guards of the contract that holds the platform's
///         money.**
///
/// @dev    `AUDIT_PLAN.md` §4 measured `contracts/Treasury.sol` at **43.53 % of
///         branches, 37 of 85** — the worst block in the tree, on the one
///         contract that holds the platform's money, and it had 25 tests and its
///         own invariant campaign already. The gap is not in what the money
///         DOES: lines were at 95.25 % and functions at 96.88 %. It is entirely
///         in what the contract REFUSES, and in the recovery paths nobody has
///         ever taken.
///
///         `test/Treasury.t.sol` proves the happy paths against real chain
///         state, and keeps doing so. This file is its mirror image: every
///         `revert` arm, and the three functions the coverage report showed had
///         **never executed a single line** — `collectFrom`, `pushAll`'s token
///         branch, and `addLiquidity`'s refund when no liquidity can be placed.
///
///         Same fixtures, same rules: the Pons factory, the curve and the token
///         are real; the only stand-ins are OUR side of an interface the
///         Treasury calls, which is what `Treasury.t.sol`'s own
///         `PlatformVaultStub` already establishes.
contract TreasuryGuardsTest is Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant PLAT = 0xf15667A02960c5d31e6e23aA1701833f4e4487f2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    Treasury t;
    address timelock = makeAddr("timelock");
    address devWallet = makeAddr("dev");
    address generationKey = makeAddr("generation key");
    address stranger = makeAddr("stranger");
    address realVault;

    function setUp() public {
        t = _mk(devWallet, address(0));
    }

    // ---- fixtures ----------------------------------------------------------

    /// @dev A Treasury of the shape `script/DeployPayd.s.sol` builds, with two
    ///      fields left to the caller: the dev wallet (so one can be made
    ///      unpayable) and the predecessor (so `receiveMigration` is reachable).
    function _mk(address dev_, address predecessor) internal returns (Treasury) {
        realVault = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(PLAT).creatorFeeRecipient;
        return new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: dev_,
                generationKey: generationKey,
                predecessor: predecessor,
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

    function _fund(Treasury to, uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(to).call{value: amount}("");
        assertTrue(ok, "the Treasury refused a payment");
    }

    /// @dev Binds the fixture launch, both keys, in the runbook's order.
    function _bind(Treasury to) internal {
        vm.prank(generationKey);
        to.approvePlatform(PLAT, realVault);
        vm.prank(timelock);
        to.bindPlatform(PLAT, realVault);
    }

    /// @dev A Treasury that has migrated, and the successor it migrated to.
    function _migrated() internal returns (Treasury successor) {
        successor = _mk(devWallet, address(t));
        _fund(t, 1 ether);
        vm.prank(generationKey);
        t.approveTreasury(address(successor));
        vm.prank(timelock);
        t.migrateTreasury(address(successor));
        assertEq(t.migratedTo(), address(successor), "fixture: the migration must have happened");
    }

    function _one() internal pure returns (address[] memory a) {
        a = new address[](1);
    }

    function _fees(uint24 v) internal pure returns (uint24[] memory a) {
        a = new uint24[](1);
        a[0] = v;
    }

    receive() external payable {}

    // ---- 1. the constructor ------------------------------------------------

    /// @notice **Every wire is required, and the check is one `if` with ten
    ///         arms.** Coverage read it as one branch taken and one never.
    ///
    /// @dev    A Treasury missing any of these is not a degraded Treasury, it is
    ///         one where a `call` goes to `address(0)` or a swap to nothing. It
    ///         costs a reverted deployment to find out now and a dead platform
    ///         to find out later.
    function test_TheConstructorRefusesEveryMissingWire() public {
        Treasury.Wiring memory w = Treasury.Wiring({
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
        });
        Treasury.Seed memory s = Treasury.Seed(new address[](0), new uint24[](0), new uint24[](0));

        // The one field that is legitimately zero: the first Treasury takes over
        // from nobody, so `receiveMigration` is unreachable for it, for ever.
        Treasury ok_ = new Treasury(w, s);
        assertEq(ok_.PREDECESSOR(), address(0), "the first Treasury has no predecessor, and that is legal");

        for (uint256 i; i < 10; ++i) {
            Treasury.Wiring memory bad = w;
            if (i == 0) bad.timelock = address(0);
            if (i == 1) bad.devWallet = address(0);
            if (i == 2) bad.generationKey = address(0);
            if (i == 3) bad.ponsFactory = address(0);
            if (i == 4) bad.poolManager = address(0);
            if (i == 5) bad.router = address(0);
            if (i == 6) bad.v3Factory = address(0);
            if (i == 7) bad.weth = address(0);
            if (i == 8) bad.pivot = address(0);
            if (i == 9) bad.pivotWethFee = 0;
            vm.expectRevert(Treasury.ZeroAddress.selector);
            new Treasury(bad, s);
        }
    }

    // ---- 2. nothing moves before the token is named ------------------------

    /// @notice **Unbound, the three actions that touch the platform token
    ///         refuse, and `payDev` does not.**
    ///
    /// @dev    That asymmetry is the design and it is worth an assertion rather
    ///         than a comment: `payDev`'s destination is written at birth, so it
    ///         works from the first block. The other three need to know WHICH
    ///         token — the burn buys it, the liquidity joins its pool, the
    ///         rewards feed its vault — and until `bindPlatform` says so, the
    ///         pockets simply accumulate.
    function test_NothingThatNeedsTheTokenRunsBeforeItIsNamed() public {
        _fund(t, 1 ether);

        vm.expectRevert(Treasury.NotBound.selector);
        t.addLiquidity();
        vm.expectRevert(Treasury.NotBound.selector);
        t.fundPlatformRewards();
        vm.expectRevert(Treasury.NotBound.selector);
        t.buyAndBurn();

        // And the one that does not need it works, from any address.
        vm.prank(stranger);
        uint256 paid = t.payDev();
        assertGt(paid, 0, "payDev's destination is immutable, so it never waited for a binding");
    }

    /// @notice **Every pocket has a floor, and it is the same floor.**
    ///
    /// @dev    `MIN_MOVE` exists so that a fixed-cost transaction is never spent
    ///         on dust. Below it each action refuses with the amount it has and
    ///         the amount it needs, rather than moving a hundred wei — and the
    ///         money is deferred, never stranded: the next payment lifts the
    ///         pocket over the bar.
    function test_EveryPocketRefusesBelowItsFloorAndKeepsTheMoney() public {
        _bind(t);
        // A hundred wei, split four ways, puts every pocket far under the floor.
        _fund(t, 100);

        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 33, t.MIN_MOVE()));
        t.payDev();
        // 35 and not 16: `_split` gives the ROUNDING RESIDUE to the holders'
        // pocket, so on a hundred wei rewards takes 100 - 33 - 16 - 16.
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 35, t.MIN_MOVE()));
        t.fundPlatformRewards();
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 16, t.MIN_MOVE()));
        t.buyAndBurn();

        assertEq(address(t).balance, 100, "refusing must not spend anything");
        // And the pockets are still ZERO, which is the right state rather than a
        // surprising one: each of those calls ran `_split()` first and then
        // reverted, which rolled the allocation back with it. The money is
        // unallocated, not lost — one successful `split` puts it in the pockets,
        // and the next payment lifts them over the bar.
        assertEq(t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(), 0, "a reverted split allocates nothing");
        t.split();
        assertEq(t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(), 100, "and nothing was lost on the way");
    }

    // ---- 3. an unpayable dev wallet ----------------------------------------

    /// @notice **`payDev` reverts rather than burning the pocket.**
    ///
    /// @dev    `DEV_WALLET` is immutable, so a wallet that becomes unable to
    ///         receive ETH cannot be replaced. The pocket is zeroed BEFORE the
    ///         call, so the only safe answer to a failed transfer is to revert
    ///         the whole thing — and this asserts that it does, which is what
    ///         keeps the money in the pocket for a later attempt.
    ///
    ///         Contrast with `FeeVault._pay` and `Distributor._pay`, which defer
    ///         instead: there the payee is one of several and blocking the
    ///         action would hold everyone else hostage. Here the payment IS the
    ///         action.
    function test_AnUnpayableDevWalletRevertsRatherThanLosingThePocket() public {
        Rejector rj = new Rejector();
        Treasury t2 = _mk(address(rj), address(0));
        _fund(t2, 1 ether);

        vm.expectRevert(Treasury.TransferFailed.selector);
        t2.payDev();

        // Nothing moved, and the pocket is still there for a later attempt.
        assertEq(address(t2).balance, 1 ether, "a failed payment must not have spent anything");
        t2.split();
        assertGt(t2.devPool(), 0, "and the pocket must still hold what it was owed");
    }

    // ---- 4. the sweep list -------------------------------------------------

    /// @notice **A sweep row declares exactly one route, on a real token, and
    ///         never none.**
    ///
    /// @dev    `Treasury.t.sol` covers the two-routes-at-once case. These are the
    ///         other four arms of the same guard, and the last one is the one
    ///         that matters: **both tiers zero would DELIST**, and a currency
    ///         whose vaults are already live keeps paying us in it for ever —
    ///         their quote is stamped at birth. Closing the way out after the
    ///         way in does not revert, it accumulates.
    function test_ASweepRowIsRefusedOnEveryShapeThatCannotWork() public {
        address[] memory tok = _one();
        tok[0] = NVDA;

        // Lengths that do not line up: the row would be read off the end.
        vm.prank(timelock);
        vm.expectRevert(Treasury.LengthMismatch.selector);
        t.allowSweeps(tok, new uint24[](2), _fees(0));

        // The zero address, and WETH — which is what the sweep converts INTO.
        address[] memory zero = _one();
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, address(0)));
        t.allowSweeps(zero, _fees(500), _fees(0));

        address[] memory weth = _one();
        weth[0] = WETH;
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, WETH));
        t.allowSweeps(weth, _fees(500), _fees(0));

        // The pivot routed through itself: a path of PIVOT, fee, PIVOT.
        address[] memory pivot = _one();
        pivot[0] = USDG;
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, USDG));
        t.allowSweeps(pivot, _fees(0), _fees(500));

        // And neither: a route may be repointed, never removed.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, NVDA));
        t.allowSweeps(tok, _fees(0), _fees(0));

        assertEq(t.sweepFee(NVDA), 0, "nothing was written by any of the five");
    }

    /// @notice **A declared route whose pool does not exist stops the sweep, and
    ///         the money waits.**
    ///
    /// @dev    `allowSweeps` does NOT check that the pool exists, deliberately —
    ///         the route is what the timelock measured, and a tier that dries up
    ///         later would otherwise need a new vote to become un-declarable.
    ///         What that costs is here: `sweepToEth` reverts `NoPool` rather
    ///         than swapping into nothing. Both arms, direct and via the pivot.
    function test_ASweepRouteWithNoPoolRevertsInsteadOfSwappingBlind() public {
        deal(NVDA, address(t), 1e18);

        address[] memory tok = _one();
        tok[0] = NVDA;
        // 5000 is not an enabled Uniswap v3 fee amount, so `getPool` is zero.
        vm.prank(timelock);
        t.allowSweeps(tok, _fees(5000), _fees(0));
        vm.expectRevert(Treasury.NoPool.selector);
        t.sweepToEth(NVDA, 0);

        // The same, on the pivot detour: hop one has no pool at that tier.
        vm.prank(timelock);
        t.allowSweeps(tok, _fees(0), _fees(5000));
        vm.expectRevert(Treasury.NoPool.selector);
        t.sweepToEth(NVDA, 0);

        assertEq(IERC20(NVDA).balanceOf(address(t)), 1e18, "the money waits rather than leaving at any price");
    }

    /// @notice **The sweep refuses WETH itself, and refuses to run on nothing.**
    ///
    /// @dev    WETH is the currency the sweep converts INTO, so sweeping it
    ///         would be a swap from a token to itself; and an empty balance is
    ///         `NothingToDo` rather than an approval and a swap of zero.
    function test_TheSweepRefusesWethAndAnEmptyBalance() public {
        vm.expectRevert(abi.encodeWithSelector(Treasury.SweepNotAllowed.selector, WETH));
        t.sweepToEth(WETH, 0);

        address[] memory tok = _one();
        tok[0] = NVDA;
        vm.prank(timelock);
        t.allowSweeps(tok, _fees(500), _fees(0));
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.sweepToEth(NVDA, 0);
    }

    // ---- 5. the two keys, on both doors ------------------------------------

    /// @notice **Neither key opens a door alone, on either of the two doors the
    ///         generation Ledger guards here.**
    ///
    /// @dev    `Treasury.t.sol` covers the platform binding. This is the other
    ///         one, `approveTreasury` / `migrateTreasury` — the function
    ///         `FLOWS.md` §7.a calls the only one in the system that moves funds
    ///         to an address somebody names.
    function test_TheSuccessorDoorNeedsBothKeysAndAnExpectingDestination() public {
        Treasury successor = _mk(devWallet, address(t));

        // The Ledger approves and never triggers.
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotGenerationKey.selector);
        t.approveTreasury(address(successor));

        // The timelock triggers and never approves: unapproved, it is refused.
        vm.prank(timelock);
        vm.expectRevert(Treasury.NotApproved.selector);
        t.migrateTreasury(address(successor));

        // Zero is refused before the approval is even consulted.
        vm.prank(timelock);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        t.migrateTreasury(address(0));

        // And the timelock is the only caller, approval or no approval.
        vm.prank(generationKey);
        t.approveTreasury(address(successor));
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotTimelock.selector);
        t.migrateTreasury(address(successor));
    }

    /// @notice **`receiveMigration` is reserved to the predecessor, and it never
    ///         credits more than what arrived.**
    ///
    /// @dev    Without the first lock anyone could manufacture pockets here with
    ///         a split of their own choosing; without the second, a predecessor
    ///         could declare four pockets summing to more than the ETH it sent,
    ///         and the contract would promise money it does not hold — which is
    ///         the one piece of accounting every other function rests on.
    function test_ReceiveMigrationIsReservedAndNeverCreditsMoreThanArrived() public {
        Treasury successor = _mk(devWallet, address(t));

        vm.deal(stranger, 10 ether);
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotPredecessor.selector);
        successor.receiveMigration{value: 1 ether}(0, 0, 0, 0);

        // The first Treasury of all has no predecessor, so this door is welded
        // shut for it rather than merely guarded.
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotPredecessor.selector);
        t.receiveMigration{value: 1 ether}(0, 0, 0, 0);

        // And the predecessor itself cannot over-declare.
        vm.deal(address(t), 10 ether);
        vm.prank(address(t));
        vm.expectRevert(Treasury.BadSplit.selector);
        successor.receiveMigration{value: 1 ether}(1 ether, 1, 0, 0);
    }

    // ---- 6. after the migration -------------------------------------------

    /// @notice **Once migrated, every function that spends is shut, and the
    ///         ones that forward open.**
    ///
    /// @dev    The vaults already created pay this contract for ever — their
    ///         `PLATFORM` is immutable, which is what guarantees a creator the
    ///         platform will not re-point itself at their expense. So the
    ///         contract must stop ACTING and start FORWARDING, and both halves
    ///         are asserted here rather than one.
    function test_AMigratedTreasuryStopsActingAndStartsForwarding() public {
        _bind(t);
        Treasury successor = _migrated();

        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.payDev();
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.addLiquidity();
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.fundPlatformRewards();
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.buyAndBurn();
        // Once, and one way: it can never send anywhere else.
        vm.prank(timelock);
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.migrateTreasury(address(successor));
        // Nor name a platform token it will never act on.
        vm.prank(generationKey);
        t.approvePlatform(PLAT, realVault);
        vm.prank(timelock);
        vm.expectRevert(Treasury.AlreadyMigrated.selector);
        t.bindPlatform(PLAT, realVault);

        // What opens: a late payment in ETH goes on to the successor, and the
        // caller chooses nothing.
        uint256 before = address(successor).balance;
        _fund(t, 0.3 ether);
        vm.prank(stranger);
        uint256 pushed = t.pushAll(address(0));
        assertEq(pushed, 0.3 ether, "a late ether payment must follow the migration");
        assertEq(address(successor).balance - before, 0.3 ether, "and land on the successor");
    }

    /// @notice **`pushAll` forwards a TOKEN too — the branch that had never
    ///         executed a single line.**
    ///
    /// @dev    ~59 % of Pons volume is quoted in something other than ether
    ///         (22.0 % USDG + 37.2 % stock tokens, measured 2026-09-08), and
    ///         `FeeVault._pay` sends the platform share in the vault's OWN
    ///         currency. So the tokens a migrated Treasury receives are the
    ///         common case, not the exotic one, and this is the only way they
    ///         reach the successor: `sweepToEth` is `nonReentrant` and available,
    ///         but the ETH it produces would then be stuck behind the migration
    ///         gate.
    function test_ALateTokenPaymentAlsoFollowsTheMigration() public {
        Treasury successor = _migrated();

        deal(NVDA, address(t), 7e18);
        vm.prank(stranger);
        uint256 pushed = t.pushAll(NVDA);

        assertEq(pushed, 7e18, "the whole balance goes");
        assertEq(IERC20(NVDA).balanceOf(address(successor)), 7e18, "and it lands on the successor");
        assertEq(IERC20(NVDA).balanceOf(address(t)), 0, "with nothing left behind");
    }

    /// @notice **`pushAll` refuses before a migration, and on an empty balance.**
    ///
    /// @dev    Before the migration there is no destination, so a push would be
    ///         a transfer to `address(0)`; on an empty balance it is a
    ///         fixed-cost transaction that moves nothing. Both arms, and both
    ///         currencies.
    function test_PushAllRefusesWithNoDestinationAndWithNothingToSend() public {
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.pushAll(address(0));
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.pushAll(NVDA);

        _migrated();
        // The migration took the whole balance with it, so both are empty.
        assertEq(address(t).balance, 0, "fixture: the migration emptied it");
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.pushAll(address(0));
        vm.expectRevert(Treasury.NothingToDo.selector);
        t.pushAll(NVDA);
    }

    // ---- 7. the recovery nobody had ever run -------------------------------

    /// @notice **`collectFrom` — a function whose every line the coverage report
    ///         showed had never executed.**
    ///
    /// @dev    The other face of the sweep's problem. If a vault's ERC-20
    ///         `transfer` to us fails, the amount falls into that vault's
    ///         `pendingWithdrawal` under THIS CONTRACT's name, and only this
    ///         contract may call `withdraw()` to get it back. Without this
    ///         function the money is visible, owed, and unreachable.
    ///
    ///         The stand-in is our own side of the interface — a vault that owes
    ///         the Treasury and pays `msg.sender`, which is the whole of what
    ///         `Distributor.withdraw` and `FeeVault.withdraw` do. What is being
    ///         tested is that the Treasury ASKS, and that what comes back lands
    ///         in the pockets like anything else.
    function test_CollectFromRecoversAPaymentAVaultCouldNotMake() public {
        OwingVault v = new OwingVault();
        vm.deal(address(v), 2 ether);
        v.setOwed(2 ether);

        vm.prank(stranger);
        uint256 got = t.collectFrom(address(v));
        assertEq(got, 2 ether, "the vault pays msg.sender, which is the Treasury");
        assertEq(address(t).balance, 2 ether, "and the ether really arrives");

        // It belongs to no pocket until the next split, exactly like a donation.
        t.split();
        assertEq(t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(), 2 ether, "then it is shared four ways");
    }

    /// @notice **A token that answers `false` is a failed push, not a silent
    ///         one.**
    ///
    /// @dev    The ETH arm's `!ok` cannot be reached — `migratedTo` is by
    ///         construction a Treasury, and a Treasury's `receive` accepts. The
    ///         token arm can: an ERC-20 that returns `false` instead of
    ///         reverting is the classic shape, and a `transfer` whose result is
    ///         not read would leave the log saying the money moved when it did
    ///         not. The stand-in is a broken TOKEN, not a stand-in for Pons or
    ///         for Uniswap — the same latitude `Distributor.t.sol`'s
    ///         `BrokenStock` already takes, and for the same reason: there is no
    ///         other way to see what happens when a transfer fails.
    function test_APushOfATokenThatRefusesRevertsRatherThanLying() public {
        _migrated();
        RefusingToken bad = new RefusingToken();
        bad.mint(address(t), 5e18);

        vm.expectRevert(Treasury.TransferFailed.selector);
        t.pushAll(address(bad));
    }

    /// @notice **`bindPlatform` refuses a zero on either side of the pair.**
    ///
    /// @dev    The pair is hashed, so a zero would have to be approved as a zero
    ///         first — and it is still refused, before the hash is even
    ///         consulted. Naming the right token with a zero vault would send a
    ///         third of everything this contract holds to `address(0)`.
    function test_BindingRefusesAZeroOnEitherSideOfThePair() public {
        vm.prank(generationKey);
        t.approvePlatform(address(0), realVault);
        vm.prank(timelock);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        t.bindPlatform(address(0), realVault);

        vm.prank(generationKey);
        t.approvePlatform(PLAT, address(0));
        vm.prank(timelock);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        t.bindPlatform(PLAT, address(0));

        assertEq(t.platformToken(), address(0), "nothing was bound by either attempt");
    }

    // ---- 8. the callback ---------------------------------------------------

    /// @notice **Only the PoolManager may call back into the swap.**
    ///
    /// @dev    `unlockCallback` executes a swap and a `settle` from state this
    ///         contract wrote a line earlier. A stranger who could call it would
    ///         re-run whatever `_pending` still held — which is why the first
    ///         line is the caller check and why it is worth pinning even though
    ///         `_pending` is cleared after every use.
    function test_OnlyThePoolManagerCanCallTheUnlockCallback() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.NotTimelock.selector);
        t.unlockCallback("");
    }

    // ---- 9. the split's ratchet -------------------------------------------

    /// @notice **The dev share only ever turns one way, and the four must be a
    ///         partition.**
    ///
    /// @dev    `Treasury.t.sol` covers the sum. This is the ratchet: without it
    ///         `setSplit(10_000, 0, 0, 0)` is a legal partition, and two timelock
    ///         operations turn every wei that ever reaches this contract into
    ///         the dev pocket.
    function test_TheDevShareIsARatchetAndCannotBeRaisedBack() public {
        // **Every weight read BEFORE anything is armed**, and this is not
        // style: `vm.expectRevert` attaches to the NEXT CALL, and `t.burnBps()`
        // written inline is a call. It swallowed the cheatcode and the test
        // reported "did not revert" on a line that reverts — the same trap
        // `Treasury.t.sol` records about `makeAddr`.
        uint256 dev0 = t.devBps();
        uint256 burn0 = t.burnBps();
        uint256 lp0 = t.lpBps();
        uint256 rew0 = t.rewardsBps();
        assertGt(dev0, 0, "fixture: there is a dev share to ratchet down");

        vm.prank(timelock);
        vm.expectRevert(Treasury.BadSplit.selector);
        t.setSplit(dev0 + 1, burn0, lp0, rew0 - 1);

        // Down is allowed, and the rest rebalances freely.
        vm.prank(timelock);
        t.setSplit(dev0 - 100, burn0, lp0, rew0 + 100);
        assertEq(t.devBps(), dev0 - 100, "down is allowed");

        // And there is no way back up, not even to where it started.
        vm.prank(timelock);
        vm.expectRevert(Treasury.BadSplit.selector);
        t.setSplit(dev0, burn0, lp0, rew0);
    }
}

/// @dev An ERC-20 that answers `false` rather than reverting. A broken TOKEN,
///      not a simulation of Pons or of Uniswap — the same latitude
///      `Distributor.t.sol`'s `BrokenStock` takes.
contract RefusingToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Refuses ETH however it is offered. Used to drive `payDev`'s failure arm.
///      Not a stand-in for anything external: it is a wallet that cannot be
///      paid, which is the state `DEV_WALLET` being immutable makes permanent.
contract Rejector {
    receive() external payable {
        revert("no");
    }
}

/// @dev A vault that owes the Treasury a payment it could not make, and pays it
///      to whoever asks for it — which is the whole of `FeeVault.withdraw` and
///      `Distributor.withdraw` from the Treasury's side of the interface.
contract OwingVault {
    uint256 public owed;

    function setOwed(uint256 a) external {
        owed = a;
    }

    function withdraw() external returns (uint256 amount) {
        amount = owed;
        owed = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {}
}
