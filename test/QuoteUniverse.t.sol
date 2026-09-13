// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {CloneBase} from "./CloneBase.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Quotelist} from "../script/Quotelist.s.sol";
import {Allowlist} from "../script/Allowlist.s.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {
    IPonsV2LaunchFactory,
    IERC20,
    IPonsV2BondingCurve,
    IUniswapV3Factory,
    IUniswapV3PoolObserver
} from "../contracts/interfaces/IExternal.sol";

interface ISymbol {
    function symbol() external view returns (string memory);
}

interface IV3Observations {
    function slot0() external view returns (uint160, int24, uint16 index, uint16 cardinality, uint16, uint8, bool);
    function observations(uint256) external view returns (uint32 blockTimestamp, int56, uint160, bool initialized);
    function liquidity() external view returns (uint128);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice **Every currency `script/Quotelist.s.sol` lists, taken through the
///         whole cycle.**
///
/// @dev    `PairToken.t.sol` proves the three SHAPES of quote work — the pivot,
///         a stock, a currency reached through the detour — on one
///         representative each. It says nothing about the other forty. This
///         file runs the list itself: launch, `bind`, a real trade, `harvest`,
///         `buyBasket`, for each of the 43 rows, against the real factory, the
///         real escrow and the real pools.
///
///         What separates it from `test_EveryQuoteRouteCarriesEnoughDepth` and
///         `test_EveryQuoteRouteHasALiveThirtyMinuteTwap`: those read the pools
///         a row DECLARES. This one spends money through them, and adds the two
///         steps no pool measurement can reach — that Pons accepts the currency
///         as a `pairToken` at all, and that the fee lands on a ledger `harvest`
///         can read.
///
///         Each row runs inside an external self-call, so a currency that gives
///         way is NAMED with its revert data and the sweep carries on. Stopping
///         at the first one would mean re-running a two-minute build and a
///         fork campaign per culprit, and this list is made to rot.
///
///         The fixture helpers are copies of `PairToken.t.sol`'s rather than an
///         extraction: the two files measure different things, and factoring
///         them on the eve of a deployment would edit a suite that passes.
contract QuoteUniverseTest is CloneBase {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    address launcher = makeAddr("launcher");
    address timelock = makeAddr("timelock");
    address platform = makeAddr("platform");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");

    Quotelist quoteList = new Quotelist();
    Allowlist stockList = new Allowlist();

    // ------------------------------------------------------------------ 1.

    /// @notice **The whole list, end to end.**
    ///
    /// @dev    Native ETH is deliberately absent: it is the one quote that needs
    ///         no listing (`Payd._create`), and `Launch.t.sol` already takes it
    ///         through the same cycle on a real launch. What is under test here
    ///         is the 43 rows a timelock operation writes.
    function test_EveryListedQuoteRunsTheWholeCycle() public {
        (address[] memory q, uint24[] memory fees, uint24[] memory wethFees, uint256[] memory minBuys) =
            quoteList.quotes();
        vm.deal(launcher, 1_000 ether);

        uint256 broken;
        for (uint256 i; i < q.length; ++i) {
            try this.cycle(i, q[i], fees[i], wethFees[i], minBuys[i]) returns (uint256 legs) {
                console.log("cycle ran, legs bought:", legs);
                console.log("  quote:", q[i]);
            } catch (bytes memory err) {
                ++broken;
                emit log_named_address("the cycle failed on quote", q[i]);
                emit log_named_bytes("  revert data            ", err);
            }
        }
        assertEq(broken, 0, "a listed quote cannot run the cycle: delist it, or fix the route it declares");
    }

    /// @dev One row, launch to stocks-at-the-Distributor. `external` so the
    ///      caller can wrap it: a revert here rolls back this row's state and
    ///      leaves the sweep running.
    function cycle(uint256 i, address quote, uint24 fee, uint24 wethFee, uint256 minBuy)
        external
        returns (uint256 legs)
    {
        (FeeVault v, Distributor d) = _vault(quote, fee, wethFee, minBuy);

        address token = _launch(quote, address(v), bytes32(0xC0DE0000 + i));
        v.bind(token);

        // ~100x the minimum purchase. The creator tax is 400 bps and
        // `rewardsBps` 7 000, so what reaches `rewardsPool` is ~2.8x
        // `MIN_BUY_QUOTE` — enough for `buyBasket` to clear its floor rather
        // than defer, which is the step this test exists to reach.
        _trade(token, quote, minBuy * 100);

        require(v.harvest() > 0, "harvest reached no ledger");
        require(v.rewardsPool() >= v.MIN_BUY_QUOTE(), "the trade was too small to clear MIN_BUY_QUOTE");

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        legs = v.buyBasket(minOuts);
        require(legs > 0, "buyBasket bought no leg");
        require(
            IERC20(NVDA).balanceOf(address(d)) + IERC20(QQQ).balanceOf(address(d)) > 0,
            "no stock reached the Distributor"
        );
    }

    // ------------------------------------------------------------------ 2.

    /// @notice **Every listed currency leaves the Treasury as ETH.**
    ///
    /// @dev    `FeeVault._pay` sends the platform share in the VAULT'S OWN
    ///         currency, and the Treasury's four pockets are in native ETH. The
    ///         only way out is `sweepToEth`. So a listed quote the sweep cannot
    ///         serve is a currency the platform can be PAID in and never spend.
    ///
    ///         **This is what that test found on 2026-09-10.** The sweep was a
    ///         single hop `token -> WETH`, and ten of the 41 listed quotes have
    ///         no `token/WETH` pool on any of the four tiers — IBM, BABA, USO,
    ///         DELL, PLTR, FIG, PFE, RIVN, UPS, plus JNJ whose pool holds no
    ///         30-minute window. Their route in is `token/USDG`; there was no
    ///         route out. The way in and the way out did not agree, and no pool
    ///         measurement could see it, because both lists were individually
    ///         correct.
    ///
    ///         The remedy was the pivot hop, not ten delistings: `sweepToEth`
    ///         now takes `token -> PIVOT -> WETH` when that is the route the
    ///         row declares, on the same pools the quote already crosses.
    ///
    ///         Nothing is poked here. A real Treasury, seeded exactly the way
    ///         `DeployPayd._sweeps` seeds it, is made to hold each currency in
    ///         turn and told to sell it — 41 real swaps on real pools. A
    ///         measurement of the pools would have proved the fix compiles.
    function test_EveryListedQuoteCanLeaveTheTreasuryAsEth() public {
        (address[] memory q, uint24[] memory fees, uint24[] memory wethFees,) = quoteList.quotes();

        // The same derivation as the deploy script's, over the same list. If
        // the two ever disagree, the one that runs on the chain is that one.
        uint24[] memory sweepWeth = new uint24[](q.length);
        uint24[] memory sweepPivot = new uint24[](q.length);
        for (uint256 i; i < q.length; ++i) {
            if (q[i] == USDG) sweepWeth[i] = 100;
            else if (fees[i] != 0) sweepPivot[i] = fees[i];
            else sweepWeth[i] = wethFees[i];
        }

        Treasury t = new Treasury(
            Treasury.Wiring({
                timelock: timelock,
                devWallet: dev,
                generationKey: makeAddr("generation key"),
                predecessor: address(0),
                ponsFactory: FACTORY,
                poolManager: POOL_MANAGER,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                pivotWethFee: 100
            }),
            Treasury.Seed(q, sweepWeth, sweepPivot)
        );

        uint256 stuck;
        for (uint256 i; i < q.length; ++i) {
            deal(q[i], address(t), _aboutOneThousand(q[i]));
            try t.sweepToEth(q[i], 0) returns (uint256 out) {
                require(out > 0, "a sweep that returns nothing is not a sweep");
                console.log(ISymbol(q[i]).symbol(), "swept to wei:", out);
            } catch (bytes memory err) {
                ++stuck;
                console.log(ISymbol(q[i]).symbol(), "cannot leave the Treasury");
                emit log_named_address("  quote      ", q[i]);
                emit log_named_bytes("  revert data", err);
            }
        }
        assertEq(stuck, 0, "the platform share in this currency would stay in the Treasury");
    }

    /// @dev ~$1 000 in the token's own units, from the list's own ~$25
    ///      `minBuy`. Reusing that number is what keeps one line working across
    ///      three decimal scales without a table of its own.
    ///
    ///      **The size is part of the measurement.** A first pass swept ~$25 000
    ///      per currency and three rows reverted `Too little received` — which
    ///      reads exactly like a routing bug and was the test's fault: the
    ///      listing floor is $5 000 absorbable before +1 %, so $25 000 is five
    ///      times the depth the list promises and the 300 bps floor was right to
    ///      bite. What actually lands here is 10 % of one vault's fees over one
    ///      window. A sweep sized like a whale proves nothing about a sweep.
    function _aboutOneThousand(address quote) internal view returns (uint256) {
        (address[] memory q,,, uint256[] memory minBuys) = quoteList.quotes();
        for (uint256 i; i < q.length; ++i) {
            if (q[i] == quote) return minBuys[i] * 40;
        }
        revert("not a listed quote");
    }

    // ------------------------------------------------------------------ 3.

    /// @notice **How much room each route's TWAP window actually has.**
    ///
    /// @dev    `test_EveryQuoteRouteHasALiveThirtyMinuteTwap` asks whether
    ///         `observe(1800)` answers TODAY. This asks how close it is to
    ///         stopping, and the difference is the whole point: a pool's
    ///         observation ring is a FIXED number of slots, so the busier the
    ///         pool, the SHORTER the history it holds. Popularity is what kills
    ///         the window, not neglect — the exact opposite of the failure the
    ///         depth test looks for.
    ///
    ///         Measured on PFE/USDG (tier 3000) on 2026-09-10: 64 slots spanning
    ///         943 seconds — 15.7 minutes against the 30 required. It had been
    ///         green for weeks. Nothing about that pool got worse; it got busier.
    ///
    ///         **And the remedy is not a delisting.**
    ///         `increaseObservationCardinalityNext` is permissionless: anyone can
    ///         grow another pool's ring, once, for gas. A route named here is a
    ///         transaction to send, not a row to remove — which is why this
    ///         reports the span rather than asserting on it. The bar belongs
    ///         wherever the keeper's preflight puts it.
    function test_EveryQuoteRouteTwapWindowMargin() public view {
        (address[] memory q, uint24[] memory fees, uint24[] memory wethFees,) = quoteList.quotes();

        for (uint256 i; i < q.length; ++i) {
            if (q[i] == USDG) continue; // no hop, no pool to interrogate
            address pool = fees[i] != 0
                ? IUniswapV3Factory(V3_FACTORY).getPool(q[i], USDG, fees[i])
                : IUniswapV3Factory(V3_FACTORY).getPool(q[i], WETH, wethFees[i]);
            if (pool == address(0)) continue;

            (,, uint16 index, uint16 cardinality,,,) = IV3Observations(pool).slot0();
            // The oldest observation is the slot just after the newest, when the
            // ring has wrapped; before it wraps, slot 0 is the oldest.
            (uint32 oldest,,, bool wrapped) = IV3Observations(pool).observations((uint256(index) + 1) % cardinality);
            if (!wrapped) (oldest,,,) = IV3Observations(pool).observations(0);

            uint256 span = block.timestamp > oldest ? block.timestamp - oldest : 0;
            console.log(ISymbol(q[i]).symbol(), "holds seconds of history:", span);
            console.log("  slots:", cardinality);
        }
    }

    // ------------------------------------------------------------------ 4.

    /// @notice **Every stock on the allowlist is really bought, not merely
    ///         priceable.**
    ///
    /// @dev    The counterpart of `EveryListedQuoteRunsTheWholeCycle`, on the
    ///         other side of the pivot, and it closes the gap that one left.
    ///
    ///         What the allowlist already had were two sensors that read a POOL:
    ///         `Payd._allowStocks` demands it exist with liquidity at the stated
    ///         tier (at DEPLOYMENT, since the seed is in the constructor), and
    ///         `test_EveryListedStockHasALiveThirtyMinuteTwap` demands its
    ///         30-minute window answer. **Neither one spends anything.** Of the
    ///         47 listed stocks only the six in $PAYD's own basket were ever
    ///         actually swapped anywhere in the suite -- and $PONS joined that
    ///         list on a measurement, not on a purchase.
    ///
    ///         **Six vaults, not one, and the contract is why.** The first
    ///         version put all 47 stocks in a single basket and `init` answered
    ///         `BadWeights`: `MAX_BASKET` is 8 and `MIN_ALLOC_BPS` is 1 000, so
    ///         a basket can never hold more than eight lines nor a line less
    ///         than a tenth. Those are contract constants, not conventions --
    ///         worth knowing before promising anyone a wide basket.
    ///
    ///         Batching costs the test nothing in fidelity: `_buyLegs` spends
    ///         `PIVOT` and knows nothing of the vault's `QUOTE`, so which vault
    ///         a leg rides in changes nothing about the leg. Each vault is
    ///         quoted in the PIVOT so `_toPivot` is a no-op -- then a leg that
    ///         fails can only be that leg's own pool, with no first hop to
    ///         blame it on.
    ///
    ///         A skipped leg is SILENT by design: `_legFloor` returns 0, its
    ///         share goes to `pivotReserve` and the purchase succeeds. So the
    ///         verdict cannot be `buyBasket`'s return value -- it is
    ///         `Distributor.totalFunded` per stock, the only place the
    ///         difference between "bought" and "quietly deferred, for ever"
    ///         shows up.
    function test_EveryListedStockIsActuallyBought() public {
        (address[] memory stocks, uint24[] memory fees, address[] memory feeds) = stockList.listings();
        uint256 n = stocks.length;

        uint256 broken;
        uint256 waiting;
        for (uint256 from; from < n; from += 8) {
            uint256 size = n - from < 8 ? n - from : 8;
            // A trailing batch of one could not be a basket at all
            // (`MIN_BASKET` is 2), so it borrows a line from the batch before.
            if (size == 1) {
                --from;
                size = 2;
            }
            vm.recordLogs();
            (address[] memory got, uint256 bought, uint256 want) = _buyBatch(stocks, fees, feeds, from, size);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            console.log("batch legs bought:", bought, "of", want);

            for (uint256 i; i < got.length; ++i) {
                if (got[i] != address(0)) continue;
                address stock = stocks[from + i];
                (bool structural, string memory why) = _whyDead(stock, fees[from + i]);
                console.log(ISymbol(stock).symbol(), structural ? "CANNOT EVER convert:" : "did not convert now:");
                console.log("   ", why);
                emit log_named_address("    stock", stock);
                emit log_named_uint("    tier ", fees[from + i]);
                _reportDivergence(logs, stock);
                if (structural) ++broken;
                else ++waiting;
            }
        }

        if (waiting != 0) {
            console.log("");
            console.log("  lines held back by a PRICE condition, not a defect:", waiting);
            console.log("  the floor refused to buy above its reference, which is what it is for.");
            console.log("  they convert again when the gap closes; nothing is lost meanwhile.");
        }
        assertEq(broken, 0, "a listed stock can NEVER convert: its weight would sit in pivotReserve for ever");
    }

    /// @dev **Why the line did not convert, and whether that is permanent.**
    ///
    ///      The first version of this test failed on both alike, and the reflex
    ///      it produced was to delist — which on 2026-09-11 nearly removed `GME`,
    ///      a name with ~$3M across its tiers, because a Chainlink feed had
    ///      printed -5.6 % in one minute and frozen while all four of its pools
    ///      stayed put. The contract was right to refuse; the test was wrong to
    ///      call that a listing defect.
    ///
    ///      So: a pool that is missing, empty, or whose observation ring cannot
    ///      serve `TWAP_WINDOW` is a line that will NEVER convert — `BA` and
    ///      `PFE` both left the list for exactly that, and it must stay red. A
    ///      pool that answers all three is healthy, and the only thing left that
    ///      can hold the leg back is a price: the oracle floor, a pause at
    ///      Robinhood, a market that moved. Those clear on their own.
    function _whyDead(address stock, uint24 fee) internal view returns (bool structural, string memory why) {
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, stock, fee);
        if (pool == address(0)) return (true, "no pool at the pinned tier");
        if (IV3Observations(pool).liquidity() == 0) return (true, "the pool holds no liquidity");

        uint32[] memory window = new uint32[](2);
        window[0] = 1_800;
        try IV3Observations(pool).observe(window) returns (int56[] memory, uint160[] memory) {}
        catch {
            return (true, "the observation ring is shorter than the 30-minute window");
        }
        return (false, "pool healthy - a price condition: floor, pause, or a market that moved");
    }

    /// @dev The vault already emits the two numbers that explain a price
    ///      refusal, so the test reads them back rather than recomputing a
    ///      floor that could drift from the one `_legFloor` actually applied.
    function _reportDivergence(Vm.Log[] memory logs, address stock) internal pure {
        bytes32 topic = keccak256("OracleDivergence(address,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != topic) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != stock) continue;
            (uint256 twapOut, uint256 oracleOut) = abi.decode(logs[i].data, (uint256, uint256));
            console.log("    twap out  ", twapOut);
            console.log("    oracle out", oracleOut);
            if (twapOut != 0) {
                console.log("    oracle asks this many bps more than the pool quotes:");
                console.log("   ", oracleOut > twapOut ? ((oracleOut - twapOut) * 10_000) / twapOut : 0);
            }
            return;
        }
    }

    /// @dev One vault, one basket of `size` listed stocks starting at `from`,
    ///      one purchase. Returns the stocks that really reached the
    ///      Distributor, `address(0)` in the slot of each one that did not.
    function _buyBatch(
        address[] memory stocks,
        uint24[] memory fees,
        address[] memory feeds,
        uint256 from,
        uint256 size
    ) internal returns (address[] memory got, uint256 bought, uint256 want) {
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](size);
        uint256 sum;
        for (uint256 i; i < size; ++i) {
            uint16 bps = i == size - 1 ? uint16(10_000 - sum) : uint16(10_000 / size);
            sum += bps;
            basket[i] = VaultTypes.Allocation(stocks[from + i], fees[from + i], bps, feeds[from + i]);
        }

        (FeeVault v, Distributor d) = _vault(USDG, 0, 0, 25_000_000, basket);

        // `payoutBps` is 4 %, so the reserve is ~25x what one window spends.
        // Sized so each leg gets ~$1 000 -- the same reasoning as the Treasury
        // sweep: the listing floor promises $5 000 absorbed before +1 %, and a
        // probe bigger than the depth measures the probe.
        deal(USDG, address(v), 200_000e6);
        v.fundRewards();

        vm.warp(d.epochEnd(0) + 1);
        bought = v.buyBasket(new uint256[](size));
        want = size;

        got = new address[](size);
        for (uint256 i; i < size; ++i) {
            if (d.totalFunded(stocks[from + i]) != 0) got[i] = stocks[from + i];
        }
    }

    // ------------------------------------------------------------------ fixtures

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
    }

    function _vault(address quote, uint24 fee, uint24 wethFee, uint256 minBuy)
        internal
        returns (FeeVault v, Distributor d)
    {
        return _vault(quote, fee, wethFee, minBuy, _basket());
    }

    function _vault(address quote, uint24 fee, uint24 wethFee, uint256 minBuy, VaultTypes.Allocation[] memory basket)
        internal
        returns (FeeVault v, Distributor d)
    {
        _impls();
        Bootstrap boot = new Bootstrap(
            vaultImpl,
            distImpl,
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
                platform: platform,
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(0),
                deployer: launcher,
                registry: address(0),
                intendedToken: address(0),
                quote: quote,
                quoteFee: fee,
                quoteWethFee: wethFee,
                minBuy: minBuy
            }),
            basket,
            keeper,
            block.timestamp,
            30 minutes
        );
        return (boot.VAULT(), boot.DISTRIBUTOR());
    }

    /// @dev Launches with `pair` as the currency and `recipient` as the creator
    ///      fee recipient. **Nothing is caught around `launchToken`**: a refusal
    ///      is the finding, and swallowing it would report "Pons said no"
    ///      without saying what it said. The caller wraps the whole row.
    ///
    ///      `launchFee()` is read BEFORE the prank: inside `{value: ...}` it is
    ///      still a CALL, and `vm.prank` attaches to the next one.
    function _launch(address pair, address recipient, bytes32 salt) internal returns (address token) {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        bytes32 eco;
        try f.previewLaunchEconomics(0, pair) returns (bytes32 e) {
            eco = e;
        } catch {
            revert("previewLaunchEconomics refuses this currency");
        }

        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "QSWEEP",
            symbol: "QSWEEP",
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
        (token,) = f.launchToken{value: fee}(p, 0, pair);
    }

    /// @dev A real trade on the curve, past the 3 s snipe tax — inside it the
    ///      creator is credited ~70 % of the spend and nothing below means
    ///      anything.
    function _trade(address token, address quote, uint256 amountIn) internal {
        IPonsV2BondingCurve curve = IPonsV2BondingCurve(IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token).curve);
        address buyer = makeAddr("buyer");
        vm.warp(block.timestamp + 10);

        deal(quote, buyer, amountIn * 10);
        vm.startPrank(buyer);
        IERC20(quote).approve(address(curve), type(uint256).max);
        curve.buy(amountIn, 0, buyer);
        vm.stopPrank();
    }
}
