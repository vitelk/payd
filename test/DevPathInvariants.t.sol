// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant, Vm} from "forge-std/Test.sol";
import {Treasury} from "../contracts/Treasury.sol";

/// @notice The platform vault, reduced to what the Treasury asks of it.
///
/// @dev    A stand-in for OUR contract, not for a third-party protocol: the
///         project rule forbids simulating Pons or Uniswap, because those are
///         the states we do not control. Here the two functions are one line
///         each, and the real vault is tested at home.
contract VaultStub {
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

/// @notice **The attacker is the key holder.** Every action is played from the
///         timelock or from the Safe, never from a stranger — a stranger would
///         prove nothing, they have no power to divert.
///
/// @dev    Everything is wrapped in a `try`: an invalid sequence must not stop
///         the campaign, it must simply change nothing. What the handler counts,
///         it counts on RETURN VALUES and not on balances: Foundry funds the
///         addresses it draws as senders, so any invariant that reads a balance
///         also reads the fuzzer — the lesson is spelled out in
///         `TreasuryInvariants.t.sol` and it cost a green campaign that proved
///         nothing.
contract DevPathHandler is Test {
    Treasury public t;
    address public immutable TIMELOCK;
    address public immutable GENERATION;
    VaultStub public immutable VAULT;
    Treasury public SUCCESSOR;
    /// @dev What a migration carried away. Counts as an exit in the closed
    ///      balance sheet, on the same footing as the other three.
    uint256 public migratedOut;

    /// @dev Everything that entered the Treasury through this handler.
    uint256 public paidIn;
    /// @dev What each exit ACTUALLY moved, taken from its return value.
    uint256 public devPaid;
    uint256 public rewardsPaid;

    uint256 public callsPay;
    uint256 public callsDev;
    uint256 public callsHostile;

    /// @dev The balance as the handler left it. Any gap observed at the START
    ///      of a call arrived without going through us.
    uint256 public lastSeen;
    uint256 public unaccounted;

    modifier observed() {
        uint256 before = address(t).balance;
        if (before > lastSeen) unaccounted += before - lastSeen;
        _;
        lastSeen = address(t).balance;
    }

    constructor(address timelock, address generation, VaultStub vault) {
        TIMELOCK = timelock;
        GENERATION = generation;
        VAULT = vault;
    }

    function setTreasury(Treasury t_, Treasury successor_) external {
        require(address(t) == address(0), "already wired");
        t = t_;
        SUCCESSOR = successor_;
    }

    receive() external payable {}

    // ------------------------------------------------------------- arrivals

    /// @dev A child vault paying in its platform share, or anyone making a
    ///      donation. Both arrive the same way, and `_split` measures the
    ///      BALANCE.
    ///
    ///      The floor is not cosmetic: `payDev` refuses below `MIN_MOVE`, so a
    ///      payment of a few wei builds pockets that can never leave, and a
    ///      whole campaign goes by without exercising a single exit.
    function pay(uint96 amount) external observed {
        uint256 a = bound(uint256(amount), 0.05 ether, 30 ether);
        if (address(this).balance < a) return;
        (bool ok,) = address(t).call{value: a}("");
        if (ok) {
            paidIn += a;
            ++callsPay;
        }
    }

    // --------------------------------------------------------------- exits

    function doSplit() external observed {
        try t.split() returns (uint256) {} catch {}
    }

    function doPayDev() external observed {
        try t.payDev() returns (uint256 amount) {
            devPaid += amount;
            ++callsDev;
        } catch {}
    }

    function doFundRewards() external observed {
        try t.fundPlatformRewards() returns (uint256 amount) {
            rewardsPaid += amount;
        } catch {}
    }

    // ------------------------------------------------------ the attacker

    /// @dev The timelock tries to give itself more. The ratchet must refuse any
    ///      value above the current one.
    function hostileSetSplit(uint16 dev, uint16 burn, uint16 lp) external observed {
        uint256 d = bound(uint256(dev), 0, 10_000);
        uint256 b = bound(uint256(burn), 0, 10_000 - d);
        uint256 l = bound(uint256(lp), 0, 10_000 - d - b);
        vm.prank(TIMELOCK);
        try t.setSplit(d, b, l, 10_000 - d - b - l) {
            ++callsHostile;
        } catch {}
    }

    /// @dev **The two keys collude** and try to name a (token, vault) pair of
    ///      their choosing — including two made-up addresses. This is the worst
    ///      case: we are not testing a compromised timelock on its own, we are
    ///      testing collusion.
    function hostileBind(address token, address vault) external observed {
        vm.prank(GENERATION);
        t.approvePlatform(token, vault);
        vm.prank(TIMELOCK);
        try t.bindPlatform(token, vault) {
            ++callsHostile;
        } catch {}
    }

    /// @dev The two keys try to carry away the Treasury's contents.
    ///
    ///      The only function in the system that moves funds to an address
    ///      somebody names. It is here because an invariant that does not play
    ///      it does not measure the system we deploy.
    function hostileMigrate(bool toSuccessor) external observed {
        address to = toSuccessor ? address(SUCCESSOR) : address(this);
        vm.prank(GENERATION);
        t.approveTreasury(to);
        uint256 held = address(t).balance;
        vm.prank(TIMELOCK);
        try t.migrateTreasury(to) {
            // `migrateTreasury` sends the WHOLE balance, pockets included.
            migratedOut += held;
            ++callsHostile;
        } catch {}
    }

    /// @dev The Safe tries to point the rewards pocket elsewhere, through the
    ///      only function that moves it. It takes no argument: the only thing
    ///      the attacker can do is write `migratedTo` on the vault — which in
    ///      production only `FeeVault.migrate` does, under timelock.
    function hostileFollow(address to) external observed {
        VAULT.setMigratedTo(to);
        vm.prank(GENERATION);
        try t.followMigration() returns (address) {
            ++callsHostile;
        } catch {}
        VAULT.setMigratedTo(address(0));
    }

    function warp(uint32 dt) external observed {
        vm.warp(block.timestamp + bound(uint256(dt), 1, 2 days));
        vm.roll(block.number + 1);
    }
}

/// @notice **The dev path, fuzzed with the keys in the attacker's hands.**
///
/// @dev    The promise this file keeps, word for word: *the only path between
///         the protocol and the dev is a fixed share, and everything else is
///         out of their reach.* The example tests prove that the intended
///         sequences work; this one looks for the ones nobody imagined — a
///         `setSplit` between two payments, a bind in the middle of a cycle, a
///         migration followed while the pocket is full.
///
///         The three exit addresses are excluded from the sender draw: Foundry
///         FUNDS the address it draws, and an invariant that reads `dev.balance`
///         would then read the fuzzer as much as the contract.
///
/// forge-config: default.invariant.runs = 12
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = false
contract DevPathInvariants is StdInvariant, Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    Treasury internal t;
    Treasury internal successor;
    DevPathHandler internal h;
    VaultStub internal vault;

    address internal dev = makeAddr("dev");
    address internal timelock = makeAddr("timelock");
    address internal generation = makeAddr("generation key");

    /// @dev The dev share as it was born. The whole file measures against it,
    ///      and it is the ceiling `setSplit`'s ratchet promises.
    uint256 internal devBpsAtBirth;

    function setUp() public {
        vault = new VaultStub();
        h = new DevPathHandler(timelock, generation, vault);
        t = new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: dev,
                generationKey: generation,
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
        successor = new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: dev,
                generationKey: generation,
                // The successor declares THIS contract as its predecessor:
                // that is what makes `receiveMigration` unreachable by anyone
                // else.
                predecessor: address(t),
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
        h.setTreasury(t, successor);
        devBpsAtBirth = t.devBps();
        vm.deal(address(h), 500 ether);

        bytes4[] memory sels = new bytes4[](8);
        sels[0] = DevPathHandler.pay.selector;
        sels[1] = DevPathHandler.doSplit.selector;
        sels[2] = DevPathHandler.doPayDev.selector;
        sels[3] = DevPathHandler.doFundRewards.selector;
        sels[4] = DevPathHandler.hostileSetSplit.selector;
        sels[5] = DevPathHandler.hostileBind.selector;
        sels[6] = DevPathHandler.hostileFollow.selector;
        sels[7] = DevPathHandler.hostileMigrate.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
        targetContract(address(h));

        // None of these addresses may be funded by the fuzzer: every one of
        // them is read as a balance by an invariant further down.
        excludeSender(address(t));
        excludeSender(dev);
        excludeSender(address(vault));
        excludeSender(address(successor));
    }

    // ------------------------------------------------------------ A. the share

    /// @notice **The dev Safe never receives more than its share of what came
    ///         in.** The invariant the audit report asked for in so many words.
    ///
    /// @dev    The ceiling is read against the share at BIRTH and not against
    ///         the current share: `setSplit` can lower it, never raise it, and
    ///         it is that asymmetry that makes the bound true for the life of
    ///         the contract rather than for an instant.
    ///
    ///         `_split` rounds down at every payment, so the sum of the shares
    ///         is always <= the share of the sum: no tolerance to grant.
    function invariant_TheDevSafeNeverGetsMoreThanItsShare() public view {
        assertLe(dev.balance, (h.paidIn() * devBpsAtBirth) / 10_000, "the dev Safe received more than its share");
    }

    /// @notice And what it received is exactly what `payDev` returned: no other
    ///         path leads there.
    function invariant_TheDevSafeIsOnlyEverPaidByPayDev() public view {
        assertEq(h.unaccounted(), 0, "ETH arrived without going through the handler");
        assertEq(dev.balance, h.devPaid(), "the dev Safe was funded by something other than payDev");
    }

    /// @notice **The ratchet.** The dev share never goes back up, whatever the
    ///         timelock attempts.
    function invariant_DevBpsOnlyEverFalls() public view {
        assertLe(t.devBps(), devBpsAtBirth, "the dev share went back up");
    }

    // ---------------------------------------------------------- B. the till

    /// @notice **Nothing leaves through any door but the two known ones.**
    ///
    /// @dev    The balance sheet is closed: what came in is either still there,
    ///         or gone through `payDev` or `fundPlatformRewards`. A third exit —
    ///         a `rescue`, an arbitrary `call`, an `approve` on a parameterisable
    ///         destination, or the `withdrawLp` this file used to count — would
    ///         break this equality before it broke anything else.
    ///
    ///         The burn and the liquidity add do not appear because they cannot
    ///         execute here: no platform token can be named, `hostileBind`
    ///         demonstrates that every campaign. This is deliberately the most
    ///         constrained scenario — the one where the only remaining exits are
    ///         those that hand ETH to an address.
    function invariant_EverythingIsHeldOrLeftByAKnownExit() public view {
        assertEq(
            h.paidIn(),
            address(t).balance + h.devPaid() + h.rewardsPaid() + h.migratedOut(),
            "ETH left the Treasury through a door that is not counted"
        );
    }

    /// @notice The rewards pocket never arrives anywhere but at the vault
    ///         frozen at birth — or at the one it migrated to.
    function invariant_RewardsOnlyEverReachTheVault() public view {
        assertEq(vault.received(), h.rewardsPaid(), "the rewards pocket went somewhere else");
    }

    /// @notice The pockets never promise more than the contract holds.
    function invariant_PocketsStayCovered() public view {
        assertGe(
            address(t).balance,
            t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(),
            "the pockets promise more than the balance"
        );
    }

    /// @notice Coverage guardrail. Foundry evaluates the invariants from the
    ///         setup onwards, so a coverage assertion there would always be
    ///         false; `afterInvariant` runs once. Without it, a broken handler
    ///         gives a green campaign that exercised nothing.
    ///
    /// @dev    **It does NOT require that a `payDev` succeeded, and that is a
    ///         finding from the first campaign.** The timelock can bring the dev
    ///         share down to 1 bps on the very first call; the ratchet locks it
    ///         there, and `devPool` then never crosses `MIN_MOVE` again. The
    ///         behaviour is correct — the dev share only falls by decision of the
    ///         timelock — but it makes the exit unreachable for the rest of the
    ///         campaign. Demanding a payment here would mean reining the attacker
    ///         in, that is, testing a weaker adversary than the real one.
    ///
    ///         Coverage of the exit is held by
    ///         `test_TheDevShareIsPaidAndBounded`, as an example: the usual
    ///         split. The examples prove the intended path works, the fuzz looks
    ///         for the ones nobody imagined.
    ///
    ///         ⚠️ **If this guardrail fails with counters at zero, empty
    ///         `cache/invariant/failures/DevPathInvariants` before looking any
    ///         further.** Foundry caches a failure's sequence and REPLAYS it as
    ///         is in later campaigns — shrunk to a single call. The guardrail
    ///         then fails forever, on a one-call campaign that obviously funded
    ///         nothing, and the message blames the fuzzer instead of the cache.
    ///         An hour lost the first time.
    function afterInvariant() public view {
        assertGt(h.callsPay(), 0, "the fuzzer never funded anything: campaign without value");
        assertGt(h.callsHostile(), 0, "no hostile action succeeded: nothing was attacked");
    }
}

/// @notice **D. Traceability.** What matters to the tax authorities, and what
///         does not fuzz: every wei that goes to the dev leaves a trace an
///         indexer can read back without reading storage.
contract DevPathTraceability is Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    Treasury internal t;
    VaultStub internal vault;
    address internal dev = makeAddr("dev");
    address internal timelock = makeAddr("timelock");
    address internal generation = makeAddr("generation key");

    function setUp() public {
        vault = new VaultStub();
        t = new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: dev,
                generationKey: generation,
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

    /// @notice The dev exit, exercised end to end and bounded.
    ///
    /// @dev    What the campaign above can no longer guarantee once the attacker
    ///         is let loose. Without this test, `invariant_TheDevSafe...` stays
    ///         true while measuring nothing: zero is always <= a share.
    function test_TheDevShareIsPaidAndBounded() public {
        vm.deal(address(this), 3 ether);
        (bool ok,) = address(t).call{value: 3 ether}("");
        assertTrue(ok, "the Treasury refused a payment");

        uint256 paid = t.payDev();
        assertEq(paid, (3 ether * t.devBps()) / 10_000, "the dev share must leave in full");
        assertEq(dev.balance, paid, "and reach the dev Safe");
        assertLe(dev.balance, (3 ether * t.devBps()) / 10_000, "and never beyond its share");

        // Empty, and refused below the minimum.
        vm.expectRevert(abi.encodeWithSelector(Treasury.BelowMinimum.selector, 0, t.MIN_MOVE()));
        t.payDev();
    }

    /// @notice The wiring is in the log, not only in storage.
    ///
    /// @dev    All four destinations are `public immutable` and readable at any
    ///         time — but you have to know the contract exists to go and read
    ///         them. An event puts them in a journal an indexer already follows,
    ///         which makes the deployment reconstructible from the chain alone.
    function test_TheWiringIsAnnouncedAtBirth() public {
        vm.recordLogs();
        Treasury fresh = new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: dev,
                generationKey: generation,
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

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Wired(address,address,address)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (address tl, address d, address op) = abi.decode(logs[i].data, (address, address, address));
            assertEq(tl, timelock, "timelock");
            assertEq(d, dev, "dev");
            assertEq(op, generation, "generation key");
            found = true;
        }
        assertTrue(found, "the wiring is announced nowhere");
        assertEq(fresh.DEV_WALLET(), dev, "and it matches what storage says");
    }

    /// @notice **No wei reaches the dev without an event.**
    ///
    /// @dev    The tax invariant, tested in its most direct form: record the
    ///         logs, watch the balance move, and require the sum of the
    ///         `DevPaid`s to explain the movement exactly. A silent payment — a
    ///         transfer slipped into another function — would make the two
    ///         numbers diverge.
    function test_EveryWeiToTheDevIsLogged() public {
        vm.deal(address(this), 10 ether);

        vm.recordLogs();
        uint256 before = dev.balance;
        for (uint256 i; i < 3; ++i) {
            (bool ok,) = address(t).call{value: 1 ether}("");
            assertTrue(ok, "the Treasury refused a payment");
            t.payDev();
        }
        uint256 moved = dev.balance - before;
        assertGt(moved, 0, "the fixture assumes the dev share moved");

        bytes32 topic = keccak256("DevPaid(address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 logged;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), dev, "a DevPaid names a different address");
            logged += abi.decode(logs[i].data, (uint256));
        }
        assertEq(logged, moved, "the dev balance moved by more than the events account for");
    }

    /// @notice And the same reasoning on the way in: what was split is
    ///         announced, pocket by pocket.
    function test_EverySplitIsLogged() public {
        vm.deal(address(this), 1 ether);
        vm.recordLogs();
        (bool ok,) = address(t).call{value: 1 ether}("");
        assertTrue(ok, "the Treasury refused a payment");
        t.split();

        bytes32 topic = keccak256("Split(uint256,uint256,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (uint256 toDev, uint256 toBurn, uint256 toLp, uint256 toRewards) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            assertEq(toDev + toBurn + toLp + toRewards, 1 ether, "the announced split does not add up to the total");
            assertEq(toDev, t.devPool(), "and the announced dev share is the one in the pocket");
            found = true;
        }
        assertTrue(found, "a split happened without being announced");
    }
}
