// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployPaydVault} from "../script/DeployPaydVault.s.sol";
import {Allowlist} from "../script/Allowlist.s.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {TwapFloor} from "../contracts/libraries/TwapFloor.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

interface IEscrowCreditNative {
    function credit(address recipient) external payable;
}

interface IV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IPool {
    function liquidity() external view returns (uint128);
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice A dress rehearsal of the deployment, against the chain's REAL state.
///
///         `Deploy.s.sol` carries the final configuration: the ten stock
///         addresses, their pool tiers, their weights, their feeds. Nothing
///         checked it. A transposed digit in an address, a pool tier that does
///         not exist, weights that do not sum to 10,000 — we would have found
///         out at deployment, or worse, afterwards.
contract DeployForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    IV3Factory constant V3 = IV3Factory(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA);

    Deploy internal script;

    function setUp() public {
        script = new Deploy();
    }

    /// @notice Every line of V1's basket describes something that really exists.
    function test_BasketIsRealOnChain() public view {
        _assertBasketIsReal(script.allocations());
    }

    /// @notice **The same checks on $PAYD's basket — the one that ships.**
    ///
    /// @dev    `Deploy.s.sol` is V1's and had these assertions from the start;
    ///         `DeployPaydVault.allocations()` is the basket our OWN vault is
    ///         born with, and until 2026-09-10 nothing checked its shape at all.
    ///         It was noticed while adding $PONS to it: an edit to the one
    ///         basket that goes live tonight, with no sensor on it.
    function test_ThePaydBasketIsRealOnChain() public {
        _assertBasketIsReal(new DeployPaydVault().allocations());
    }

    /// @dev The body. A transposed digit, a tier with no pool, a weight that
    ///      rounds away, weights that do not sum to 10 000 — found here or found
    ///      after the deployment.
    function _assertBasketIsReal(VaultTypes.Allocation[] memory a) internal view {
        assertGe(a.length, 2, "a basket starts at two stocks");
        assertLe(a.length, 8, "a basket stops at eight");

        uint256 sum;
        for (uint256 i; i < a.length; ++i) {
            string memory at = string.concat("allocation ", vm.toString(i));

            assertTrue(a[i].stock != address(0), string.concat(at, ": stock nul"));
            assertGt(a[i].stock.code.length, 0, string.concat(at, ": the stock is not a contract"));
            assertEq(IERC20Meta(a[i].stock).decimals(), 18, string.concat(at, ": unexpected decimals"));

            // Duplicate: two lines on the same stock would pass the weight sum
            // without anyone noticing.
            for (uint256 j = i + 1; j < a.length; ++j) {
                assertTrue(a[i].stock != a[j].stock, string.concat(at, ": duplicate stock"));
            }

            // The pool must exist AT THE STATED TIER. That is where the most
            // likely error hides: the right address, the wrong tier.
            address pool = V3.getPool(a[i].stock, USDG, a[i].poolFee);
            assertTrue(pool != address(0), string.concat(at, ": no pool at this tier"));
            assertGt(IPool(pool).liquidity(), 0, string.concat(at, ": pool with no liquidity"));

            // A zero feed is a documented CHOICE (GLD, USO: TWAP-only floor).
            // If one is configured, it must answer with a positive price.
            if (a[i].feed != address(0)) {
                (, int256 price,, uint256 updatedAt,) = IFeed(a[i].feed).latestRoundData();
                assertGt(price, 0, string.concat(at, ": feed with no price"));
                assertGt(updatedAt, 0, string.concat(at, ": feed never updated"));
            }

            assertGe(a[i].bps, 1_000, string.concat(at, ": weight below the 10 pct floor"));
            sum += a[i].bps;
        }

        assertEq(sum, 10_000, "weights do not sum to 10,000");
    }

    /// @notice How much of $PAYD's basket runs on the TWAP alone, pinned.
    ///
    /// @dev    The counterpart of `test_OneStockRunsOnTwapAlone` for the basket
    ///         that ships. One line, and it is $PONS: no Chainlink feed exists
    ///         for it, which is a documented choice (`docs/allowlist.md`) and
    ///         over a weekend the better of the two floors. If a second appears
    ///         without anyone deciding it, this is where we find out.
    function test_OnePaydLegRunsOnTwapAlone() public {
        VaultTypes.Allocation[] memory a = new DeployPaydVault().allocations();
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (a[i].feed == address(0)) ++n;
        }
        assertEq(n, 1, "unexpected number of $PAYD legs without a Chainlink feed ($PONS)");
    }

    /// @notice The two stocks with no feed are the ones we decided to accept
    ///         that way, not an oversight. If a third appears, we want to know.
    /// @notice How many of the default basket run on the TWAP alone.
    ///
    /// @dev    A stock with no Chainlink feed is priced by the 30-minute TWAP
    ///         and nothing else. That is a documented choice, not an oversight
    ///         — but it must stay a SMALL, KNOWN number, so the count is pinned
    ///         here and a silent drift fails the suite.
    function test_OneStockRunsOnTwapAlone() public view {
        VaultTypes.Allocation[] memory a = script.allocations();
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (a[i].feed == address(0)) ++n;
        }
        assertEq(n, 1, "unexpected number of stocks without a Chainlink feed (GLD)");
    }

    /// @notice The whole script runs against the real chain without reverting,
    ///         and wires the contracts to each other.
    function test_ScriptRunsEndToEnd() public {
        vm.setEnv("SAFE_MULTISIG", "0x0000000000000000000000000000000000000A11");
        vm.setEnv("DEV_ADDRESS", "0x0000000000000000000000000000000000000DE1");
        vm.setEnv("KEEPER_ADDRESS", "0x000000000000000000000000000000000000CE1F");
        script.run();
    }

    // ------------------------------------------------------- audit, 2026-09-11

    /// @dev The number of `script/Allowlist.s.sol` lines shipping `feed = 0`,
    ///      counted 2026-09-11. Pinned so a drift fails the suite, exactly as
    ///      `test_OneStockRunsOnTwapAlone` pins the basket's own count.
    uint256 constant FEEDLESS_LINES = 27;

    /// @notice **T-TWAP-02 — on a majority of the allowlist the 30-minute TWAP
    ///         is the only price there is, and it answers.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property that SHOULD
    ///         hold and DOES: every line shipping without a Chainlink feed has a
    ///         pool that can serve `TWAP_WINDOW`, so the sole source is a live
    ///         one. Green. It exists to DOCUMENT the 27, not to catch them.
    ///
    ///         `docs/ARCHITECTURE.md` §S3 describes a Chainlink tightener over
    ///         the TWAP floor. `FeeVault._oracleOut:1375` returns 0 on its first
    ///         line when `a.feed == address(0)`, so on these lines the tightener
    ///         does not exist — the floor is `TWAP x (BPS - 300) / BPS` and
    ///         nothing else. That is a documented choice per stock; what §2.4
    ///         observes is that it is now the MAJORITY: 27 of 46, where
    ///         `docs/recon.md` §5 names three.
    ///
    ///         Two properties per feedless line, because "no feed" is only
    ///         acceptable while the substitute works: the pool exists at the
    ///         tier the list declares, and `tryMeanTick` answers the window. A
    ///         line failing the second would be listed with no floor at all and
    ///         would be skipped silently on every purchase for the vault's life.
    // T-TWAP-02
    function test_TwentySevenListedStocksArePricedByTheTwapAlone() public {
        Allowlist list = new Allowlist();
        (address[] memory stocks, uint24[] memory poolFees, address[] memory feeds) = list.listings();
        assertEq(stocks.length, 46, "the allowlist is 46 lines");

        uint256 feedless;
        for (uint256 i; i < stocks.length; ++i) {
            if (feeds[i] != address(0)) continue;
            ++feedless;

            string memory at = string.concat("feedless line ", IERC20Meta(stocks[i]).symbol());
            address pool = V3.getPool(stocks[i], USDG, poolFees[i]);
            assertTrue(pool != address(0), string.concat(at, ": no pool at the declared tier"));
            assertGt(IPool(pool).liquidity(), 0, string.concat(at, ": pool with no liquidity"));

            // The substitute has to work, or the line has no floor at all.
            (bool haveTwap,) = TwapFloor.tryMeanTick(pool, 1_800);
            assertTrue(haveTwap, string.concat(at, ": the only price source cannot serve the 30-minute window"));
        }

        emit log_named_uint("allowlist lines with no Chainlink feed", feedless);
        assertEq(feedless, FEEDLESS_LINES, "the number of TWAP-only lines moved without anyone deciding it");
    }

    /// @notice **T-TWAP-02, second half — every stock shipped without a feed is
    ///         recorded in `docs/recon.md`.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property that SHOULD
    ///         hold: the file the project designates as the dated, on-chain
    ///         record knows about every line whose only price source is a pool.
    ///         **RED before T-RECON-01**: `docs/recon.md` §5 named GLD, RDDT and
    ///         HIMS, and the shipped list is nine times that. The doc is the one
    ///         that was wrong, which is why T-RECON-01 adds the dated rows
    ///         rather than either list being "fixed".
    ///
    ///         Matched on the ADDRESS, lowercased on both sides, not on the
    ///         symbol: `F`, `BE` and `MU` would match ordinary prose anywhere in
    ///         a 1 300-line document and the test would report green on nothing.
    ///
    ///         `foundry.toml` already grants read access to `./docs`, and this
    ///         is the first test to use it.
    // T-TWAP-02
    function test_EveryFeedlessListedStockIsRecordedInRecon() public {
        Allowlist list = new Allowlist();
        (address[] memory stocks,, address[] memory feeds) = list.listings();
        string memory recon = vm.toLowercase(vm.readFile("docs/recon.md"));

        uint256 missing;
        for (uint256 i; i < stocks.length; ++i) {
            if (feeds[i] != address(0)) continue;
            if (vm.contains(recon, vm.toLowercase(vm.toString(stocks[i])))) continue;
            ++missing;
            emit log_named_string("not in docs/recon.md: feedless stock", IERC20Meta(stocks[i]).symbol());
            emit log_named_address("  address", stocks[i]);
        }
        assertEq(missing, 0, "a stock priced by the TWAP alone must have a dated row in docs/recon.md");
    }
}

/// @notice **T-TWAP-02, the observable half — with no feed, nothing tightens.**
///
/// @dev    Its own contract because it needs a vault and `DeployForkTest` is a
///         script rehearsal that has never built one. Nothing here is mocked:
///         the real escrow credits the vault, `harvest` really claims, and the
///         purchase really swaps on the real pools.
contract FeedlessFloorTest is CloneBase {
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// @dev Two `script/Allowlist.s.sol` lines shipping `feed = 0`: GLD at tier
    ///      3000 (`:` the row `docs/recon.md` §5 already names) and MRVL at tier
    ///      3000 (one of the 24 it does not).
    address constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e;
    address constant MRVL = 0x62fd0668e10D8B72339BE2DCF7643001688ff13B;

    /// @notice A basket in which no leg carries a feed emits no
    ///         `OracleDivergence`, and still buys.
    ///
    /// @dev    **ASSERTION DIRECTION.** The property that SHOULD hold and does:
    ///         on a feedless line the floor is the pure TWAP floor, so
    ///         `_legFloor:1362` never reaches its `emit`. Green — it documents
    ///         what the 27 lines actually run on, which a count cannot show.
    ///
    ///         The event is the only observable: `_legFloor` is internal and
    ///         emits `OracleDivergence(stock, twapOut, oracleOut)` exactly when
    ///         `_oracleOut` returned non-zero. No event, no tightener.
    // T-TWAP-02
    function test_ABasketWithNoFeedsIsFlooredByTheTwapAlone() public {
        _impls();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        Distributor d = _cloneDistributor(predicted, makeAddr("tl"), makeAddr("keeper"), block.timestamp, 30 minutes);

        VaultTypes.Allocation[] memory a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(GLD, 3000, 5_000, address(0));
        a[1] = VaultTypes.Allocation(MRVL, 3000, 5_000, address(0));

        FeeVault v = _cloneVault(
            VaultTypes.Config({
                escrow: ESCROW,
                factory: PONS_FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                creator: makeAddr("creator"),
                platform: makeAddr("platform"),
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: makeAddr("tl"),
                distributor: address(d),
                deployer: makeAddr("deployer"),
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            a
        );
        require(address(v) == predicted, "unexpected vault address");

        vm.deal(address(this), 2 ether);
        IEscrowCreditNative(ESCROW).credit{value: 2 ether}(address(v));
        v.harvest();

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        vm.recordLogs();
        uint256 legs = v.buyBasket(minOuts);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(legs, 0, "a feedless basket must still buy: the TWAP is a floor, not a blocker");

        bytes32 topic = keccak256("OracleDivergence(address,uint256,uint256)");
        uint256 tightened;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) ++tightened;
        }
        assertEq(tightened, 0, "no line carries a feed, so nothing can tighten the TWAP floor");
    }
}
