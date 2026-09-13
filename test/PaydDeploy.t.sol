// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {Allowlist} from "../script/Allowlist.s.sol";
import {Quotelist} from "../script/Quotelist.s.sol";
import {DeployPayd} from "../script/DeployPayd.s.sol";
import {Collector} from "../contracts/Collector.sol";
import {TwapFloor} from "../contracts/libraries/TwapFloor.sol";
import {IUniswapV3Factory, IUniswapV3PoolObserver, IAggregatorV3} from "../contracts/interfaces/IExternal.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

interface IV3PoolState {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
}

/// @notice The rehearsal, run as a test: deploy the platform, list the stocks
///         through the timelock, and create a vault from the list.
///
/// @dev    A runbook that has never been executed is a wish. This runs the
///         whole of `docs/PAYD_RUNBOOK.md` against a fork of the real
///         chain, in order, with the real 48-hour delay — so the order itself
///         is what is under test, not just the contracts.
contract PaydDeployTest is Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    Timelock timelock;
    Treasury treasury;
    Payd pad;
    Allowlist list;
    Quotelist quoteList;

    /// @dev The second authority -- `Payd.setFactory`, `Treasury.bindPlatform`,
    ///      `Treasury.migrateTreasury`. It approves, it never triggers. A
    ///      separate address, because on the same key as the Safe it would close
    ///      nothing.
    address generationKey = makeAddr("generation key");
    DistributionFactory factory = new DistributionFactory();
    address safe = makeAddr("safe");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");
    address creator = makeAddr("creator");

    /// @dev **The same seed `DeployPayd._sweeps` builds, and it used to be
    ///      empty here.**
    ///
    ///      The fixture handed the Treasury `Seed(0, 0, 0)` and then ran the
    ///      quote runbook against it — validating, for as long as it existed, a
    ///      deployment whose till could not convert a single currency back into
    ///      ether. It passed because nothing checked, and `Payd._requireSweepable`
    ///      is what stopped it passing: the guard caught the fixture, not the
    ///      other way round.
    function _sweepSeed() internal returns (Treasury.Seed memory) {
        (address[] memory quotes, uint24[] memory qFees, uint24[] memory qWethFees,) = new Quotelist().quotes();
        uint24[] memory wethFees = new uint24[](quotes.length);
        uint24[] memory pivotFees = new uint24[](quotes.length);
        for (uint256 i; i < quotes.length; ++i) {
            // The pivot reaches WETH through its own deep pool; everything else
            // takes whichever single route it was measured on.
            if (quotes[i] == USDG) wethFees[i] = 100;
            else if (qFees[i] != 0) pivotFees[i] = qFees[i];
            else wethFees[i] = qWethFees[i];
        }
        return Treasury.Seed(quotes, wethFees, pivotFees);
    }

    function setUp() public {
        list = new Allowlist();
        quoteList = new Quotelist();

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new Timelock(proposers, executors);

        // $PAYD's vault is an `immutable` of the Treasury. This test is only
        // about the Payd, so any address will do here -- the real wiring is
        // played out by `LaunchTonight` and by `DeployPayd`.
        treasury = new Treasury(
            Treasury.Wiring({
                timelock: address(timelock),
                devWallet: dev,
                generationKey: safe,
                predecessor: address(0),
                ponsFactory: PONS_FACTORY,
                poolManager: POOL_MANAGER,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                pivotWethFee: 100
            }),
            _sweepSeed()
        );
        pad = new Payd(
            Payd.Wiring({
                timelock: address(timelock),
                platform: address(treasury),
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
    }

    /// @notice A fresh registry lists nothing, and says so by refusing.
    ///
    /// @dev    The state between step 1 and step 3 of the runbook. Worth a test
    ///         because it is the state the platform sits in for 48 hours after
    ///         deployment, and "deployed" reads like "open" to everyone who is
    ///         not holding the runbook.
    function test_ADeployedLaunchpadListsNothingUntilTheTimelockSpeaks() public {
        (address[] memory stocks, uint24[] memory fees, address[] memory feeds) = list.listings();

        (,, bool allowed) = pad.listing(stocks[0]);
        assertFalse(allowed, "nothing may be listed at deployment");

        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(stocks[0], fees[0], 5_000, feeds[0]);
        basket[1] = VaultTypes.Allocation(stocks[1], fees[1], 5_000, feeds[1]);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.StockNotAllowed.selector, stocks[0]));
        pad.createVault(basket, 7_000, 30 minutes, address(0));
    }

    /// @notice The whole runbook: schedule, wait, execute, launch.
    function test_TheRunbookRunsEndToEnd() public {
        (address[] memory stocks, uint24[] memory fees, address[] memory feeds) = list.listings();
        bytes memory data = list.payload();
        bytes32 salt = list.SALT();

        // --- step 3a: the Safe schedules. Nothing is listed yet.
        //
        // `delay` is read BEFORE the prank on purpose. `vm.prank` attaches to
        // the next CALL, and an argument expression is a call: written inline,
        // `getMinDelay()` eats the prank and `schedule` runs as the test
        // contract, which holds no role. That is how this first failed.
        uint256 delay = timelock.getMinDelay();
        vm.prank(safe);
        timelock.schedule(address(pad), 0, data, bytes32(0), salt, delay);

        (,, bool allowed) = pad.listing(stocks[0]);
        assertFalse(allowed, "scheduling must not list anything");

        // --- and it cannot be rushed.
        vm.expectRevert();
        timelock.execute(address(pad), 0, data, bytes32(0), salt);

        // --- step 3b: 48 hours later, ANYBODY executes. Not the Safe: the
        //     executor role is open, and this is where that gets proven.
        vm.warp(block.timestamp + delay);
        vm.prank(makeAddr("a passer-by"));
        timelock.execute(address(pad), 0, data, bytes32(0), salt);

        for (uint256 i; i < stocks.length; ++i) {
            (uint24 fee, address feed, bool ok) = pad.listing(stocks[i]);
            assertTrue(ok, "every measured stock must end up listed");
            assertEq(fee, fees[i], "at the tier it was measured at");
            assertEq(feed, feeds[i], "and the feed it was verified with");
        }

        // --- step 4: a creator makes a vault from the list.
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(stocks[0], fees[0], 5_000, feeds[0]);
        basket[1] = VaultTypes.Allocation(stocks[1], fees[1], 5_000, feeds[1]);

        vm.prank(creator);
        (address vault, address dist) = pad.createVault(basket, 7_000, 30 minutes, address(0));

        assertTrue(pad.isVault(vault), "the pair must be registered");
        assertEq(FeeVault(payable(vault)).PLATFORM(), address(treasury), "the platform share goes to the Treasury");
        assertEq(FeeVault(payable(vault)).PLATFORM_BPS(), 1_000, "stamped with the rate of the day");
        assertEq(Distributor(payable(dist)).keeper(), keeper, "and the keeper of the day");
    }

    /// @notice The operator's own command runs.
    ///
    /// @dev    `run()` is the only thing a human types on launch day, and it is
    ///         the one path the other tests never touch: they call `payload()`
    ///         directly. A script that reverts on its environment reads exactly
    ///         like a broken deployment at the worst possible moment.
    function test_TheOperatorCommandProducesTheCalldata() public {
        vm.setEnv("REGISTRY", vm.toString(address(pad)));
        vm.setEnv("TIMELOCK", vm.toString(address(timelock)));
        list.run();

        // And what it would have the Safe schedule is what the timelock accepts.
        //
        // EVERY read is hoisted, not just the obvious one: `payload()` and
        // `SALT()` are external calls too, and either of them in the argument
        // list swallows the prank exactly as `getMinDelay()` did.
        bytes memory data = list.payload();
        bytes32 salt = list.SALT();
        uint256 delay = timelock.getMinDelay();
        bytes32 id = timelock.hashOperation(address(pad), 0, data, bytes32(0), salt);

        vm.prank(safe);
        timelock.schedule(address(pad), 0, data, bytes32(0), salt, delay);
        assertTrue(timelock.isOperationPending(id), "the printed operation must be the one that lands");

        // The same for the second list. `run()` is the only thing a human types
        // on launch day, and both scripts have one: covering only one would
        // leave the other unexecuted until the evening it matters.
        quoteList.run();
        bytes memory qData = quoteList.payload();
        bytes32 qSalt = quoteList.SALT();
        bytes32 qId = timelock.hashOperation(address(pad), 0, qData, bytes32(0), qSalt);
        assertTrue(qId != id, "two distinct salts, hence two distinct operations");

        vm.prank(safe);
        timelock.schedule(address(pad), 0, qData, bytes32(0), qSalt, delay);
        assertTrue(timelock.isOperationPending(qId), "and the currency one lands too");
    }

    /// @notice **Every listed stock's 30-minute TWAP answers.**
    ///
    /// @dev    This is the check that shortened the list, and it belongs in the
    ///         suite rather than in a one-off script because it can rot: a pool
    ///         whose observation history is trimmed stops answering, and the
    ///         failure is SILENT — `_swapLeg` catches the revert and skips the
    ///         leg, so a creator's weight on that stock quietly never converts.
    ///
    ///         Depth alone does not imply this. Stocks that passed the $5 000
    ///         depth bar and failed here are named in `docs/allowlist.md`.
    function test_EveryListedStockHasALiveThirtyMinuteTwap() public {
        (address[] memory stocks, uint24[] memory fees,) = list.listings();

        uint32[] memory window = new uint32[](2);
        (window[0], window[1]) = (1_800, 0);

        uint256 dead;
        for (uint256 i; i < stocks.length; ++i) {
            address pool = IUniswapV3Factory(V3_FACTORY).getPool(stocks[i], USDG, fees[i]);
            assertTrue(pool != address(0), "a listed tier must have a pool");

            // `observe` directly rather than `TwapFloor.meanTick`, so the revert
            // can be caught and the offender NAMED. The first version of this
            // test asserted the same property and failed with a bare `OLD`,
            // which says a pool went stale without saying which — and this
            // check exists precisely because it is expected to rot.
            try IUniswapV3PoolObserver(pool).observe(window) returns (int56[] memory, uint160[] memory) {
                continue;
            } catch {
                ++dead;
                emit log_named_address("no 30-min TWAP: stock", stocks[i]);
                emit log_named_address("  its pool          ", pool);
            }
        }
        assertEq(dead, 0, "a listed stock lost its 30-minute TWAP: delist it or its weight never converts");
    }

    /// @notice The deployment SCRIPT really executes, and returns six contracts
    ///         wired to each other.
    ///
    /// @dev    The rest of this file REPLAYS the deployment by hand
    ///         (`new Timelock`, `new Payd`...) so it can move through time
    ///         between the steps. That is useful and it is not the same thing:
    ///         it tests the contracts, not the script. A line added to
    ///         `DeployPayd.s.sol` used to clear compilation and nothing else --
    ///         which is exactly the kind of file you run once, under pressure, on
    ///         launch night.
    function test_TheDeployScriptItselfRuns() public {
        vm.setEnv("SAFE_MULTISIG", "0x0000000000000000000000000000000000000A11");
        vm.setEnv("DEV_ADDRESS", "0x0000000000000000000000000000000000000DE1");
        vm.setEnv("KEEPER_ADDRESS", "0x000000000000000000000000000000000000CE1F");
        vm.setEnv("GENERATION_KEY", "0x0000000000000000000000000000000000006E11");

        DeployPayd script = new DeployPayd();
        (Timelock tl, Treasury tr, Payd p, Collector col, FeeVault paydVault,) = script.run();

        // Wired, not merely deployed: it is the script's ordering that is at stake.
        assertEq(p.TIMELOCK(), address(tl), "registry not wired to its timelock");
        assertEq(p.PLATFORM(), address(tr), "registry not wired to its treasury");

        // **The order the script had to reverse, and the cycle it cuts.**
        //
        // Three immutable addresses stood in a circle: the registry points at
        // the Treasury, the Treasury at the platform vault, and the vault at its
        // registry. The cycle is cut by having the vault born INSIDE the
        // registry's constructor -- `address(this)` is known there.
        assertEq(paydVault.REGISTRY(), address(p), "the vault knows its registry from birth");
        assertTrue(p.isVault(address(paydVault)), "and it is IN the registry, not beside it");
        assertEq(paydVault.PLATFORM(), address(tr), "and it knows the Treasury");
        assertEq(paydVault.PLATFORM_BPS(), 0, "$PAYD does not tax itself");
        assertEq(paydVault.LAUNCHER(), 0x0000000000000000000000000000000000000a11, "the Safe is the one who launches");

        // The Treasury, on the other hand, is not wired yet -- and that waits on
        // nothing: it is EMPTY at genesis, it only fills with the platform shares
        // of third-party launches. Its two doors take BOTH keys.
        assertEq(address(tr.platformVault()), address(0), "nothing is wired until both keys have spoken");
        assertEq(tr.GENERATION_KEY(), 0x0000000000000000000000000000000000006e11, "the Treasury carries the second key");

        vm.expectRevert(Treasury.NotGenerationKey.selector);
        tr.approvePlatform(address(1), address(2));

        vm.prank(address(tl));
        vm.expectRevert(Treasury.NotApproved.selector);
        tr.bindPlatform(address(1), address(2));

        assertTrue(DistributionFactory(address(p.factory())).VAULT_IMPL() != address(0), "no vault implementation");
        assertTrue(DistributionFactory(address(p.factory())).DIST_IMPL() != address(0), "no distributor implementation");

        // The Collector: deployed, and with no link at all to the rest. If it
        // gained one, that would be a dependency to document.
        assertTrue(address(col).code.length > 0, "collector has no code");
        assertEq(address(col).balance, 0, "collector starts holding something");

        // **And OPEN at the first block.** That is what the seed buys: the
        // platform no longer spends 48 h deployed, visible and closed, asking the
        // timelock for permission for a list the deployer had just written. The
        // delay protects CHANGES, not the initial state.
        (address[] memory stocks, uint24[] memory fees, address[] memory feeds) = list.listings();
        for (uint256 i; i < stocks.length; ++i) {
            (uint24 fee, address feed, bool ok) = p.listing(stocks[i]);
            assertTrue(ok, "a measured stock must be listed from deployment");
            assertEq(fee, fees[i], "at the tier it was measured on");
            assertEq(feed, feeds[i], "and with the verified feed");
        }
        (address[] memory q, uint24[] memory qFees, uint24[] memory qWeth, uint256[] memory minBuys) =
            quoteList.quotes();
        for (uint256 i; i < q.length; ++i) {
            (uint24 fee, uint24 wethFee, uint256 minBuy, bool ok) = p.quoteListing(q[i]);
            assertTrue(ok, "a measured currency too");
            assertEq(fee, qFees[i], "at the measured tier");
            assertEq(wethFee, qWeth[i], "with its fallback route if it has one");
            assertEq(minBuy, minBuys[i], "with its minimum");
        }

        // The proof that matters: a creator launches the same day, with no
        // timelock operation scheduled at all.
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(stocks[0], fees[0], 5_000, feeds[0]);
        basket[1] = VaultTypes.Allocation(stocks[1], fees[1], 5_000, feeds[1]);
        vm.prank(creator);
        (address vault,) = p.createVaultQuoted(basket, 7_000, 30 minutes, address(0), USDG);
        assertEq(FeeVault(payable(vault)).QUOTE(), USDG, "and it can already quote it in USDG");
        assertEq(FeeVault(payable(vault)).ETH_PIVOT_FEE(), 100, "the WETH/PIVOT tier is stamped, no longer welded");
    }

    /// @notice **Every quote route carries >= $5 000 of depth, on each of its
    ///         hops.**
    ///
    /// @dev    This test REPLACES the subset rule ("a currency must already be a
    ///         listed stock"). That rule inherited the measurement by descent: a
    ///         stock had passed the depth bar, so the currency carrying the same
    ///         address had passed it too. It was convenient and it was wrong in
    ///         principle -- a currency is not a stock, and the list now contains
    ///         three that are not: COIN and cbBTC through the detour, $PONS
    ///         directly.
    ///
    ///         Measuring beats inheriting. The criterion is the one from
    ///         `docs/allowlist.md`, applied to the pools ACTUALLY declared rather
    ///         than to those of a neighbouring list, and it covers both hops of
    ///         the detour -- including the second, shared with every ETH-quoted
    ///         vault.
    function test_EveryQuoteRouteCarriesEnoughDepth() public {
        (address[] memory q, uint24[] memory qFees, uint24[] memory qWeth, uint256[] memory minBuys) =
            quoteList.quotes();

        uint256 thin;
        for (uint256 i; i < q.length; ++i) {
            assertGt(minBuys[i], 0, "a zero minBuy would make `init` fail on BadQuote");

            if (q[i] == USDG) {
                assertEq(qFees[i], 0, "the pivot lists with no route, and it alone");
                assertEq(qWeth[i], 0, "with no fallback route either");
                continue;
            }
            // Exactly one route per currency.
            assertTrue((qFees[i] == 0) != (qWeth[i] == 0), "one route and only one");

            // The culprit is NAMED rather than stopping the campaign at the
            // first one: this list is made to rot -- a pool thins without
            // warning -- and "too thin" without saying which forces the
            // measurement to be redone by hand. That is the lesson of
            // `EveryListedStockHasALiveThirtyMinuteTwap`, taken up here.
            uint256 d;
            if (qFees[i] != 0) {
                d = _depthUsd(IUniswapV3Factory(V3_FACTORY).getPool(q[i], USDG, qFees[i]), USDG);
            } else {
                uint256 hop2 = _depthUsd(IUniswapV3Factory(V3_FACTORY).getPool(WETH, USDG, 100), USDG);
                d = _depthUsd(IUniswapV3Factory(V3_FACTORY).getPool(q[i], WETH, qWeth[i]), WETH);
                if (hop2 < d) d = hop2; // the route is worth its thinnest link
            }
            if (d < MIN_DEPTH_USD) {
                ++thin;
                emit log_named_address("depth < $5 000: quote", q[i]);
                emit log_named_uint("  measured depth, in $     ", d);
            }
        }
        assertEq(thin, 0, "a quote currency slipped below the threshold: delist it or change its tier");

        // No duplicate: `allowQuotes` would overwrite the row silently, and the
        // list would then say something other than what it applies.
        for (uint256 i; i < q.length; ++i) {
            for (uint256 j; j < i; ++j) {
                assertTrue(q[i] != q[j], "duplicate currency");
            }
        }
    }

    /// @notice **Every `minBuy` prices into the band the whole calibration rests
    ///         on (T2-CAP-01).**
    ///
    /// @dev    `minBuy` is the one field of a quote listing that is **not**
    ///         measured against the chain. `Payd._allowQuotes` checks it for
    ///         zero and nothing else, and it cannot do better: the figure is in
    ///         the quote's own units and nothing on that path knows what one is
    ///         worth. Putting an oracle on `allowQuotes` to catch a timelock
    ///         typo is a worse trade than the typo — so the band is enforced
    ///         here, before the operation is ever scheduled, which is the same
    ///         division of labour `MIN_ROUTE_DEPTH` and `docs/allowlist.md`
    ///         already make for depth.
    ///
    ///         **What a wrong one costs, and why it is worth a test of its own.**
    ///         `FeeVault` stamps `MIN_BUY_QUOTE` at birth and `removeQuotes`
    ///         reaches no vault already minted, exactly as T-QUOTE-01. It then
    ///         sets BOTH ends of every purchase that vault will ever make: the
    ///         floor below which nothing buys, and — through
    ///         `MAX_BUY_MULTIPLE` — the ceiling that makes `FLOWS.md` §7.e's
    ///         bound hold against anyone. Three extra zeros take one purchase
    ///         from ~$1 000 to ~$1 000 000, which is §7.e's 278 bps case
    ///         restored, and strand the vault until its reserve clears $25 000.
    ///
    ///         **This one is NOT a live measurement, unlike its neighbour.**
    ///         `test_EveryQuoteRouteCarriesEnoughDepth` sits in the scheduled
    ///         job because active liquidity at the tick swung 4.5x inside one
    ///         hour with the pool's deposits unchanged (`docs/AUDIT_EXECUTION.md`).
    ///         A PRICE does not do that: a 10x band on a stock token is stable
    ///         across any day, so this belongs in the main suite where it can
    ///         actually stop a deployment.
    function test_EveryQuoteMinBuyPricesIntoTheBand() public {
        (address[] memory q, uint24[] memory qFees, uint24[] memory qWeth, uint256[] memory minBuys) =
            quoteList.quotes();

        uint256 offBand;
        for (uint256 i; i < q.length; ++i) {
            uint256 usd = _minBuyUsd(q[i], minBuys[i], qFees[i], qWeth[i]);
            // The culprit is NAMED rather than stopping at the first, the rule
            // this file already follows for depth.
            if (usd < MIN_BUY_USD_FLOOR || usd > MIN_BUY_USD_CEILING) {
                ++offBand;
                emit log_named_address("minBuy outside the band: quote", q[i]);
                emit log_named_uint("  priced at, in $              ", usd);
                emit log_named_uint("  raw minBuy                   ", minBuys[i]);
            }
        }
        assertEq(offBand, 0, "a minBuy prices outside [$5, $250]: it is a typo, or the token moved 10x");

        // **The positive control, and it is not optional here.** A gate that
        // cannot fire reads as "covered" when it is not — the class T-SIZE-01
        // found in an `awk` line that could never match. So the same pricing
        // path is driven against the mistake it exists for: the USDG row with
        // three extra zeros, which is what T2-CAP-01 listed and the registry
        // accepted. Deterministic, taken from the real row rather than invented.
        uint256 honest = _minBuyUsd(USDG, minBuys[0], qFees[0], qWeth[0]);
        uint256 fatFingered = _minBuyUsd(USDG, minBuys[0] * 1_000, qFees[0], qWeth[0]);
        assertEq(q[0], USDG, "fixture: row 0 is the pivot");
        assertGe(honest, MIN_BUY_USD_FLOOR, "fixture: the real row is inside the band");
        assertLe(honest, MIN_BUY_USD_CEILING, "fixture: on both sides");
        assertGt(fatFingered, MIN_BUY_USD_CEILING, "three extra zeros are OUTSIDE the band this test enforces");

        // And the other direction, which strands rather than over-spends: a row
        // three orders too SMALL buys nothing and pays no bounty.
        assertLt(honest / 1_000, MIN_BUY_USD_FLOOR, "three missing zeros are outside it too");
    }

    /// @dev The band, and it is deliberately wide. Every shipped row is ~$25
    ///      (`script/Quotelist.s.sol` writes the dollar value in a comment per
    ///      line, which is the intent this test turns into a check). 0.2x to 10x
    ///      of that catches the three-zeros typo — the failure that actually
    ///      happens — without failing the day a stock doubles. A tighter band
    ///      would have to be re-measured like `docs/allowlist.md`'s depth
    ///      figures; this one does not, which is the point of choosing it wide.
    uint256 constant MIN_BUY_USD_FLOOR = 5;
    uint256 constant MIN_BUY_USD_CEILING = 250;

    /// @dev `minBuy` in dollars, through the route the listing itself declares.
    ///      USDG is the pivot and a dollar, so it needs no pool — the same
    ///      exception `_toUsdg` makes.
    function _minBuyUsd(address quote, uint256 minBuy, uint24 poolFee, uint24 wethFee) internal view returns (uint256) {
        if (quote == USDG) return minBuy / 1e6;
        if (poolFee != 0) {
            return _spotOut(IUniswapV3Factory(V3_FACTORY).getPool(quote, USDG, poolFee), quote, minBuy) / 1e6;
        }
        uint256 inWeth = _spotOut(IUniswapV3Factory(V3_FACTORY).getPool(quote, WETH, wethFee), quote, minBuy);
        return _spotOut(IUniswapV3Factory(V3_FACTORY).getPool(WETH, USDG, 100), WETH, inWeth) / 1e6;
    }

    /// @dev What `amountIn` of `tokenIn` is worth in the pool's other token, at
    ///      the current tick. Spot and not a TWAP on purpose: a band of 10x is
    ///      not a number a single block can move, and a TWAP here would make the
    ///      check depend on an observation ring that `docs/AUDIT_FIXES.md`
    ///      records decaying on busy pools.
    function _spotOut(address pool, address tokenIn, uint256 amountIn) internal view returns (uint256) {
        if (pool == address(0) || amountIn == 0) return 0;
        (uint160 sqrtP,,,,,,) = IV3PoolState(pool).slot0();
        if (sqrtP == 0) return 0;
        // price of token0 in token1, scaled by 2**96. `sqrtP` is uint160, so the
        // square is up to 2**320 and needs `FullMath`'s 512-bit intermediate.
        uint256 priceX96 = FullMath.mulDiv(sqrtP, sqrtP, 2 ** 96);
        if (priceX96 == 0) return 0;
        return IV3PoolState(pool).token0() == tokenIn
            ? FullMath.mulDiv(amountIn, priceX96, 2 ** 96)
            : FullMath.mulDiv(amountIn, 2 ** 96, priceX96);
    }

    /// @dev The threshold from `docs/allowlist.md`, in dollars.
    uint256 constant MIN_DEPTH_USD = 5_000;
    /// @dev sqrt(1.01) - 1, en 1e9.
    uint256 constant K_NUM = 4_987_562;
    uint256 constant K_DEN = 1_000_000_000;

    /// @dev Depth absorbable before +1 %, expressed in `other`, brought back to
    ///      dollars. Raw `L`s are NOT comparable between two pairs -- the mistake
    ///      `CheckTiers` documents -- so we convert.
    function _depthUsd(address pool, address other) internal view returns (uint256) {
        if (pool == address(0)) return 0;
        (uint160 sqrtP,,,,,,) = IV3PoolState(pool).slot0();
        uint128 liq = IV3PoolState(pool).liquidity();
        if (sqrtP == 0 || liq == 0) return 0;

        uint256 raw = IV3PoolState(pool).token0() == other
            ? FullMath.mulDiv(FullMath.mulDiv(liq, 2 ** 96, sqrtP), K_NUM, K_DEN)
            : FullMath.mulDiv(FullMath.mulDiv(liq, sqrtP, 2 ** 96), K_NUM, K_DEN);

        if (other == USDG) return raw / 1e6; // 6 decimales, 1 $
        (, int256 ethUsd,,,) = IAggregatorV3(ETH_USD).latestRoundData();
        return FullMath.mulDiv(raw, uint256(ethUsd), 1e8) / 1e18;
    }

    /// @notice The currency runbook, end to end: schedule, wait, execute, then
    ///         create a quoted vault.
    ///
    /// @dev    Two timelock operations, not one. A quoted vault needs BOTH lists
    ///         -- the stocks for its basket, the currencies for its quote -- and
    ///         they cost 48 h each. Scheduling them together runs them in
    ///         parallel; discovering them one after the other on launch night
    ///         costs four days.
    function test_TheQuoteRunbookRunsEndToEnd() public {
        uint256 delay = timelock.getMinDelay();

        // Both operations leave in the SAME window.
        vm.startPrank(safe);
        timelock.schedule(address(pad), 0, list.payload(), bytes32(0), list.SALT(), delay);
        timelock.schedule(address(pad), 0, quoteList.payload(), bytes32(0), quoteList.SALT(), delay);
        vm.stopPrank();

        (address[] memory q, uint24[] memory qFees, uint24[] memory qWeth, uint256[] memory minBuys) =
            quoteList.quotes();
        (,,, bool allowedBefore) = pad.quoteListing(q[0]);
        assertFalse(allowedBefore, "scheduling lists nothing");

        vm.warp(block.timestamp + delay);
        vm.startPrank(makeAddr("a passer-by"));
        timelock.execute(address(pad), 0, list.payload(), bytes32(0), list.SALT());
        timelock.execute(address(pad), 0, quoteList.payload(), bytes32(0), quoteList.SALT());
        vm.stopPrank();

        for (uint256 i; i < q.length; ++i) {
            (uint24 fee, uint24 wethFee, uint256 minBuy, bool ok) = pad.quoteListing(q[i]);
            assertTrue(ok, "every measured currency ends up listed");
            assertEq(fee, qFees[i], "at the tier its pool was measured on");
            assertEq(wethFee, qWeth[i], "and the fallback route with it");
            assertEq(minBuy, minBuys[i], "with the minimum its decimals impose");
        }

        // And a creator makes a vault out of it. USDG: the most used currency
        // after ETH, and the only one that makes no hop at all.
        (address[] memory stocks, uint24[] memory fees, address[] memory feeds) = list.listings();
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(stocks[0], fees[0], 5_000, feeds[0]);
        basket[1] = VaultTypes.Allocation(stocks[1], fees[1], 5_000, feeds[1]);

        vm.prank(creator);
        (address vault,) = pad.createVaultQuoted(basket, 7_000, 30 minutes, address(0), USDG);

        assertEq(FeeVault(payable(vault)).QUOTE(), USDG, "the vault speaks the chosen currency");
        assertEq(FeeVault(payable(vault)).QUOTE_FEE(), 0, "and USDG has no hop to name");
        assertEq(FeeVault(payable(vault)).MIN_BUY_QUOTE(), minBuys[0], "with the list's minimum");

        // An unlisted currency stays refused, after as before.
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Payd.QuoteNotAllowed.selector, WETH));
        pad.createVaultQuoted(basket, 7_000, 30 minutes, address(0), WETH);
    }

    /// @notice **Every quote route has a 30-minute TWAP that answers, on EACH
    ///         of its pools.**
    ///
    /// @dev    The counterpart of `EveryListedStockHasALiveThirtyMinuteTwap` for
    ///         the first conversion, and it matters more than that one: a leg
    ///         whose floor reverts is caught and skipped, whereas `_toPivot`
    ///         brings the WHOLE purchase down. A currency whose pool loses its
    ///         window is a vault that stops buying anything.
    ///
    ///         It covers both routes, including the detour's two pools -- that is
    ///         what replaces the subset rule for them.
    function test_EveryQuoteRouteHasALiveThirtyMinuteTwap() public {
        (address[] memory q, uint24[] memory qFees, uint24[] memory qWeth,) = quoteList.quotes();

        uint32[] memory window = new uint32[](2);
        (window[0], window[1]) = (1_800, 0);

        uint256 dead;
        for (uint256 i; i < q.length; ++i) {
            if (q[i] == USDG) continue; // no hop, no pool to interrogate

            address[] memory pools = new address[](qFees[i] != 0 ? 1 : 2);
            if (qFees[i] != 0) {
                pools[0] = IUniswapV3Factory(V3_FACTORY).getPool(q[i], USDG, qFees[i]);
            } else {
                pools[0] = IUniswapV3Factory(V3_FACTORY).getPool(q[i], WETH, qWeth[i]);
                // The detour's second hop, shared with every ETH-quoted vault:
                // if it dies, it is not one currency that falls.
                pools[1] = IUniswapV3Factory(V3_FACTORY).getPool(WETH, USDG, 100);
            }

            for (uint256 j; j < pools.length; ++j) {
                assertTrue(pools[j] != address(0), "a declared route must have its pool");
                try IUniswapV3PoolObserver(pools[j]).observe(window) returns (int56[] memory, uint160[] memory) {
                    continue;
                } catch {
                    ++dead;
                    emit log_named_address("no 30-min TWAP: quote", q[i]);
                    emit log_named_address("  its pool           ", pools[j]);
                }
            }
        }
        assertEq(dead, 0, "a currency lost its 30-min TWAP: delist it or its vaults stop buying");
    }
}
