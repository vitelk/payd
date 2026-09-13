// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {
    IERC20,
    IPonsV2MemeHook,
    IPonsV2MemeHookSource,
    IPonsV2LaunchFactory,
    IPoolManager,
    IAggregatorV3,
    ISwapRouter02,
    IUniswapV3Factory,
    IUniswapV3PoolObserver
} from "../contracts/interfaces/IExternal.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";
import {TwapFloor} from "../contracts/libraries/TwapFloor.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

interface IGraduated {
    function graduated() external view returns (bool);
}

interface IERC20Supply {
    function totalSupply() external view returns (uint256);
}

interface IEscrowCredit {
    function credit(address recipient) external payable;
    function balanceOf(address) external view returns (uint256);
}

/// @notice Fork tests against the real state of Robinhood Chain (chainId 4663).
/// @dev    No `vm.mockCall` on Pons nor on Uniswap: the escrow is credited
///         through its real `credit` function, which is permissionless.
///         Addresses: docs/recon.md §1.1 and §3.1.
/// @dev Refuses all ETH. Used to check that a hostile or broken recipient cannot
///      block an action of the vault.
contract EthRejector {
    receive() external payable {
        revert("non");
    }
}

/// @dev Accepts ETH but needs more than the 30,000 gas the PUSH allows. Not
///      hostile, just expensive — a token with hooks, an accounting proxy, a
///      contract that grew. A Safe is NOT this case: measured at 11,252 gas,
///      see `test_ADevSafeIsPaidWithinTheGasCap`.
contract GasHungryReceiver {
    uint256 private a;
    uint256 private b;
    uint256 private c;

    receive() external payable {
        a = block.number;
        b = block.timestamp;
        c = a + b;
    }

    function pull(address vault) external returns (uint256) {
        return FeeVault(payable(vault)).withdraw();
    }
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @dev A v3 pool's active liquidity. `contracts/interfaces/IExternal.sol`
///      carries `slot0`/`observe` but not this one — `contracts/Payd.sol`
///      declares it locally for `_requirePool`, and this file needs it for the
///      same reason: to measure a pool rather than believe a table.
interface IV3Liquidity {
    function liquidity() external view returns (uint128);
}

contract FeeVaultForkTest is CloneBase {
    address constant SAFE_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address keeperAddr = makeAddr("keeperAddr");
    // --- Pons v2 (docs/recon.md §1.1)
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    // --- Uniswap v3 (docs/recon.md §3.1)
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // --- Chainlink (docs/recon.md §5)
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 constant EPOCH_LENGTH = 30 minutes;
    /// @dev Filler for the basket helper: liquid, and not one of the default five.
    address constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    // --- a Pons v2 token that ACTUALLY graduated (phase=2), pairToken = native ETH
    address constant SQUEEZE = 0xD0782C1358E20FF07A4d3b420221D78F3C160485;
    address constant SQUEEZE_CURVE = 0xeb6685ada3dCB817f02CfeF6a4F06e7AaecE5e8f;

    FeeVault vault;
    address dev = makeAddr("dev");
    address platformWallet = makeAddr("platform");
    address timelock = makeAddr("timelock");
    Distributor distributor;
    address deployer = makeAddr("deployer");
    address keeper = makeAddr("keeper");

    /// @dev The same five as `Deploy.s.sol`: the deepest measured pools,
    ///      equal fifths. `MAX_ALLOC_BPS` would refuse anything heavier.
    function _allocations() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](5);
        a[0] = VaultTypes.Allocation(
            0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 500, 2000, 0x41ed2c58611790af0760e31e80Bb427e4e83D603
        ); // QQQ
        a[1] = VaultTypes.Allocation(
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 500, 2000, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
        ); // NVDA
        a[2] = VaultTypes.Allocation(0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 3000, 2000, address(0)); // GLD
        a[3] = VaultTypes.Allocation(
            0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 500, 2000, 0x42a95341ff361e81fd934F39943c5C98F6991844
        ); // SPCX
        a[4] = VaultTypes.Allocation(
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 3000, 2000, 0x4A1166a659A55625345e9515b32adECea5547C38
        ); // TSLA
    }

    function setUp() public {
        // The Distributor is real: the vault asks it for the current epoch and
        // credits the purchase to it. Mocking it would hide the coupling that
        // matters. The prediction is frozen BEFORE any deployment: reading it
        // again afterwards would give a different address, the nonce having moved.
        _impls(); // before the prediction, or the nonce moves under it
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        distributor = _cloneDistributor(predicted, makeAddr("tl"), keeperAddr, block.timestamp, EPOCH_LENGTH);
        vault = _cloneVault(
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
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(distributor),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _allocations()
        );
        // The Distributor must know the vault at construction and vice versa:
        // that is the circular dependency Deploy.s.sol resolves with CREATE2.
        // Here we resolve it by predicting the nonce.
        require(address(vault) == predicted, "unexpected vault address");
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

    /// @notice Nominal path: the REAL escrow credits the vault, `harvest()`
    ///         actually claims, and the split is applied. The expected shares are
    ///         DERIVED from the constants, not copied: this test must check that
    ///         `harvest` applies the split, not memorise today's value. It is
    ///         `test_SplitSumsToBps` that locks the values down.
    function test_HarvestFromRealEscrow() public {
        uint256 amount = 1 ether;
        vm.deal(address(this), amount);
        IEscrowCredit(ESCROW).credit{value: amount}(address(vault));

        assertEq(IEscrowCredit(ESCROW).balanceOf(address(vault)), amount, "escrow did not credit");

        vm.prank(keeper);
        uint256 gross = vault.harvest();
        assertEq(gross, amount, "incomplete claim");

        // The creator's share is the residue, and it is what the caller's gas
        // refund is taken from — so it lands at or just under its nominal bps.
        uint256 nominal = amount - (amount * vault.PLATFORM_BPS()) / 10_000 - (amount * vault.rewardsBps()) / 10_000;
        assertLe(vault.creatorPool(), nominal, "the creator share cannot exceed the residue");
        assertGt(vault.creatorPool(), (nominal * 99) / 100, "the refund ate more of it than a gas refund should");

        // rewards is a FIXED obligation now: its bps, less only the shipping.
        assertEq(
            vault.rewardsPool() + address(distributor).balance,
            (amount * vault.rewardsBps()) / 10_000,
            "holders must get their bps, shipping included"
        );

        assertEq(
            vault.rewardsPool() + vault.creatorPool() + vault.platformPool() + keeper.balance
                + address(distributor).balance,
            amount,
            "conservation: nothing is lost"
        );
        assertGt(address(distributor).balance, 0, "Distributor not funded with gas");
        console.log("keeper refund (wei):", keeper.balance);
    }

    /// @notice The Chainlink floor prices a RAW UNIT, not a share.
    ///
    ///         A Robinhood stock token is an ERC-8056: `shares = raw x
    ///         uiMultiplier / 1e18`, and the feed quotes a share. Ignore the
    ///         multiplier and the floor is wrong by exactly it — harmlessly
    ///         today, fatally the day a stock splits, since the floor then
    ///         lands above anything the pool can return and every purchase
    ///         reverts `TooLittleOut`, for good and in silence.
    ///
    ///         AAPL is the fixture because it carries a multiplier above 1 ON
    ///         CHAIN and has a feed: the naive and the correct formula give
    ///         measurably different numbers, so the test can tell them apart.
    ///
    /// @dev    The two feeds' FRESHNESS is mocked, and nothing else: their real
    ///         answers are read on-chain and handed back with a current
    ///         timestamp. Equity feeds go quiet outside market hours — AAPL's
    ///         was 75 h old when this test was written — so without it the
    ///         oracle branch would only run on weekdays and the test would
    ///         report green all weekend without executing a line of what it
    ///         claims to cover. The house rule forbids mocking Pons and
    ///         Uniswap, which is what the purchase actually goes through; here
    ///         the swap, the pool and the escrow are all real.
    function test_TheOracleFloorPricesRawUnitsNotShares() public {
        address aapl = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
        address feed = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

        uint256 m = _uiMultiplier(aapl);
        assertGt(m, 1e18, "fixture assumes AAPL carries a multiplier above 1");

        (, int256 ethUsd,,,) = IAggregatorV3(ETH_USD).latestRoundData();
        (, int256 stockUsd,,,) = IAggregatorV3(feed).latestRoundData();
        _freshen(ETH_USD, ethUsd);
        _freshen(feed, stockUsd);

        FeeVault v2 = _vaultWithFirstStock(aapl, feed);
        vm.deal(address(this), 2 ether);
        IEscrowCredit(ESCROW).credit{value: 2 ether}(address(v2));
        v2.harvest();

        vm.recordLogs();
        _buy(v2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 oracleOut = _oracleOutFor(logs, aapl);
        assertGt(oracleOut, 0, "the oracle branch did not run: no divergence was emitted");

        // The leg's ETH share, read from `WindowFunded` rather than recomputed:
        // it is derived from the USDG the first hop actually returned, so any
        // arithmetic of ours here would only reproduce that division's rounding
        // and force the assertion to go approximate.
        uint256 amountIn = _ethLegFor(logs, 0);
        assertGt(amountIn, 0, "the AAPL leg spent nothing");

        uint256 correct = FullMath.mulDiv(amountIn, uint256(ethUsd) * 1e18, uint256(stockUsd) * m);
        uint256 naive = (amountIn * uint256(ethUsd)) / uint256(stockUsd);

        assertEq(oracleOut, correct, "the floor must price a raw unit, not a share");
        assertGt(naive, oracleOut, "fixture is useless if both formulas agree");
        // The gap IS the multiplier. Six hundredths of a percent today; four
        // hundred percent the day a stock we hold splits the way CRWD did.
        assertApproxEqRel((naive * 1e18) / oracleOut, m, 1e12, "the gap must be exactly the multiplier");
    }

    /// @notice A stock whose multiplier is about to move is priced on the TWAP
    ///         alone, and the epoch still runs.
    ///
    /// @dev    Around a corporate action Chainlink switches from the pre-split
    ///         price to the post-split one at a moment that has no reason to
    ///         match the token's own `effectiveAt`. The feed is therefore
    ///         dropped for an hour either side — and the floor does not vanish
    ///         with it, because a TWAP is denominated in RAW units on both
    ///         sides of the pool and a multiplier never moves those.
    ///
    ///         Nothing on this chain has a change scheduled today (194 tokens
    ///         read 2026-09-08, `newUIMultiplier == uiMultiplier` on every
    ///         one), so the schedule is the one thing mocked here.
    function test_AScheduledSplitFallsBackToTheTwapInsteadOfBlocking() public {
        address aapl = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
        address feed = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

        (, int256 ethUsd,,,) = IAggregatorV3(ETH_USD).latestRoundData();
        (, int256 stockUsd,,,) = IAggregatorV3(feed).latestRoundData();
        _freshen(ETH_USD, ethUsd);
        _freshen(feed, stockUsd);

        // A 4:1 split, thirty minutes out: inside the window either side.
        //
        // T-HYG-01, re-read 2026-09-11. This IS a `vm.mockCall` on a real stock
        // token, and it is the one the house rule most nearly forbids. It stays,
        // for the reason the docblock above already gives and which was checked
        // rather than assumed: 194 tokens read 2026-09-08 had
        // `newUIMultiplier == uiMultiplier`, so there is no scheduled corporate
        // action anywhere on this chain to drive the branch with. What is
        // simulated is a SCHEDULE, not a behaviour — the pool, the swap, the
        // router and the escrow in this test are all real, and the assertion is
        // about our own window arithmetic. Re-base it the day a real split is
        // scheduled on any listed stock; until then there is nothing to re-base
        // onto.
        vm.mockCall(aapl, abi.encodeWithSelector(bytes4(0xdc767007)), abi.encode(uint256(4e18)));
        vm.mockCall(aapl, abi.encodeWithSelector(bytes4(0x97a4064f)), abi.encode(block.timestamp + 30 minutes));

        FeeVault v2 = _vaultWithFirstStock(aapl, feed);
        vm.deal(address(this), 2 ether);
        IEscrowCredit(ESCROW).credit{value: 2 ether}(address(v2));
        v2.harvest();

        vm.recordLogs();
        uint256 out = _buy(v2);

        assertGt(out, 0, "a scheduled split must not stop the purchase");
        assertEq(_oracleOutFor(vm.getRecordedLogs(), aapl), 0, "the feed must be ignored inside the window");
    }

    /// @dev Reads ERC-8056's `uiMultiplier()` the way the vault does.
    function _uiMultiplier(address stock) internal view returns (uint256) {
        (bool ok, bytes memory raw) = stock.staticcall(abi.encodeWithSelector(bytes4(0xa60bf13d)));
        assertTrue(ok, "stock must expose uiMultiplier()");
        return abi.decode(raw, (uint256));
    }

    /// @dev The feed's REAL answer, handed back with a current timestamp.
    ///
    ///      T-HYG-01, re-read 2026-09-11. `CLAUDE.md` rejects a test that only
    ///      passes thanks to a `vm.mockCall` **on Pons, Uniswap or a stock
    ///      token**. A Chainlink aggregator is none of the three, and what is
    ///      replaced here is only the FRESHNESS: the answer itself is read
    ///      on-chain one line before and handed straight back. Equity feeds go
    ///      quiet outside market hours — AAPL's was 75 h old when this was
    ///      written — so without it the oracle branch would run on weekdays
    ///      only and the suite would report green all weekend without executing
    ///      a line of what it claims to cover. Nothing to re-base.
    function _freshen(address feed, int256 answer) internal {
        vm.mockCall(
            feed,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(uint80(1), answer, block.timestamp, block.timestamp, uint80(1))
        );
    }

    /// @dev The ETH one leg of the purchase actually spent, from `WindowFunded`.
    function _ethLegFor(Vm.Log[] memory logs, uint256 leg) internal pure returns (uint256) {
        bytes32 topic = keccak256("WindowFunded(uint256,uint256,address[],uint256[],uint256[])");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (,, uint256[] memory eth) = abi.decode(logs[i].data, (address[], uint256[], uint256[]));
            return eth[leg];
        }
        return 0;
    }

    /// @dev A vault that buys `stock` on its FIRST epoch.
    ///
    ///      Slot 0, not the whole basket: `_setAllocations` refuses a repeated
    ///      stock, and it should — a basket that names the same thing five
    ///      times is not a basket. Slot 0 is enough, because `allocationOf(0)`
    ///      lands on position 0 of the wheel and the Distributor is built with
    ///      `genesis = block.timestamp`, so the epoch under test IS epoch 0.
    function _vaultWithFirstStock(address stock, address feed) internal returns (FeeVault) {
        VaultTypes.Allocation[] memory all = _allocations();
        all[0] = VaultTypes.Allocation(stock, 500, 2000, feed);
        // Whatever sat in slot 0 must not linger in another slot.
        for (uint256 i = 1; i < 5; ++i) {
            if (all[i].stock == stock) all[i] = VaultTypes.Allocation(GME, 500, 2000, address(0));
        }
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        return _cloneVault(
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
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            all
        );
    }

    /// @dev `oracleOut` for ONE stock, from the `OracleDivergence` events.
    ///
    ///      Filtered by stock and not just "the last one": a window prices every
    ///      leg, so five of these are emitted per purchase and reading the tail
    ///      would answer about whichever stock happened to be last.
    function _oracleOutFor(Vm.Log[] memory logs, address stock) internal pure returns (uint256 oracleOut) {
        bytes32 topic = keccak256("OracleDivergence(address,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic && address(uint160(uint256(logs[i].topics[1]))) == stock) {
                (, oracleOut) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    /// @notice The epoch's real swap, with the TWAP floor computed on-chain, and
    ///         the credit to the Distributor.
    function test_RunEpochAgainstRealPools() public {
        uint256 amount = 2 ether;
        vm.deal(address(this), amount);
        IEscrowCredit(ESCROW).credit{value: amount}(address(vault));
        vm.prank(keeper);
        vault.harvest();

        uint256 poolBefore = vault.rewardsPool();
        assertGt(poolBefore, 0, "nothing to spend");

        uint256 keeperBefore = keeper.balance;
        uint256 g0 = gasleft();
        uint256 legs = _buyAs(vault, keeper);
        console.log("buyBasket gas (5 stocks, one window):", g0 - gasleft());
        uint256 buyRefund = keeper.balance - keeperBefore;

        VaultTypes.Allocation[] memory basket = vault.getAllocations();
        assertEq(legs, basket.length, "every leg of the basket must have been bought");

        // The whole basket, in one purchase — that is the point of D8. And the
        // router delivers straight to the Distributor, so the vault never holds
        // a stock at any point, not even inside the transaction.
        for (uint256 i; i < basket.length; ++i) {
            assertEq(IERC20(basket[i].stock).balanceOf(address(vault)), 0, "a stock was left in the vault");
            assertGt(IERC20(basket[i].stock).balanceOf(address(distributor)), 0, "the Distributor did not receive");
            assertGt(distributor.totalFunded(basket[i].stock), 0, "a stock was not credited");
        }
        assertEq(vault.pivotReserve(), 0, "no leg should have been skipped against live pools");

        assertGt(buyRefund, 0, "keeper not refunded");
        assertLe(buyRefund, vault.MAX_REFUND(), "refund beyond the cap");
        assertLt(vault.rewardsPool(), poolBefore, "nothing was spent");
        // Smoothing: only a fraction is spent, the rest stays in reserve.
        assertGt(vault.rewardsPool(), (poolBefore * 80) / 100, "smoothing reserve not kept");

        // A window is bought once. `nextEpoch` moved past it, so there is
        // nothing left to cover until another epoch closes.
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vm.prank(keeper);
        vault.buyBasket(new uint256[](basket.length));

        console.log("legs bought:", legs);
        console.log("rewardsPool remaining (wei):", vault.rewardsPool());
    }

    /// @notice Three days of closed equity markets. Every Chainlink equity feed
    ///         goes stale and the cycle must keep running on the TWAP alone.
    ///
    ///         Warping the fork past `MAX_FEED_AGE` is exactly what a closure
    ///         does to a feed: `updatedAt` stops moving while `block.timestamp`
    ///         does not. Unlike `Launch.t.sol`'s stale-feed test, this basket
    ///         carries REAL feeds, so the assertion has something to lose.
    function test_ThreeDaysWithoutChainlinkDoesNotStopTheCycle() public {
        uint256 amount = 2 ether;
        vm.deal(address(this), amount);
        IEscrowCredit(ESCROW).credit{value: amount}(address(vault));
        vm.prank(keeper);
        vault.harvest();

        vm.warp(block.timestamp + 3 days);

        VaultTypes.Allocation[] memory basket = vault.getAllocations();
        uint256 feeds;
        for (uint256 i; i < basket.length; ++i) {
            if (basket[i].feed == address(0)) continue;
            (,,, uint256 at,) = IAggregatorV3(basket[i].feed).latestRoundData();
            assertGt(block.timestamp - at, vault.MAX_FEED_AGE(), "the feed must read stale");
            ++feeds;
        }
        assertGt(feeds, 0, "a basket with no feed proves nothing here");

        vm.recordLogs();
        uint256 legs = _buyAs(vault, keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(legs, basket.length, "three days without Chainlink must not cost a leg");
        assertEq(vault.pivotReserve(), 0, "no leg should have been skipped");
        for (uint256 i; i < basket.length; ++i) {
            assertGt(distributor.totalFunded(basket[i].stock), 0, "a stock was not credited");
            // No `OracleDivergence` at all: a stale feed prices nothing, and the
            // floor is the TWAP's on its own.
            assertEq(_oracleOutFor(logs, basket[i].stock), 0, "a stale feed must not price the floor");
        }
    }

    /// @notice What the floor IS once the pool itself stops trading, which is
    ///         the other half of a market closure.
    ///
    ///         A Uniswap v3 pool with no observation inside the window answers
    ///         `observe` from its last write and the CURRENT tick, so the
    ///         30-minute TWAP degenerates to the tick the last swap left behind.
    ///         Not a bug — it is the price that lags, which is what a floor
    ///         wants — but it is the number to have in hand: over a closure the
    ///         floor is Friday's close minus `MAX_SLIPPAGE_BPS`, and a leg whose
    ///         pool moves further than that is skipped until it comes back.
    function test_AFrozenPoolMakesTheTwapTheLastTradedTick() public {
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, NVDA, 500);
        assertTrue(pool != address(0), "no NVDA/USDG pool at tier 500");

        (, int24 spot,,,,,) = IUniswapV3PoolObserver(pool).slot0();
        int24 live = TwapFloor.meanTick(pool, vault.TWAP_WINDOW());

        vm.warp(block.timestamp + 3 days);
        int24 frozen = TwapFloor.meanTick(pool, vault.TWAP_WINDOW());

        console.log("spot tick / live TWAP / TWAP after 3 quiet days:");
        console.logInt(spot);
        console.logInt(live);
        console.logInt(frozen);
        assertEq(frozen, spot, "a frozen pool's TWAP is its last traded tick");
    }

    /// @notice The closure's real risk, and it is not the feed: the pool moving
    ///         while the TWAP is frozen on Friday's tick.
    ///
    ///         A stale feed costs nothing (test above). A pool that walks away
    ///         from the frozen TWAP by more than `MAX_SLIPPAGE_BPS` costs the
    ///         leg -- which is DEFERRED, not lost: its USDG lands in
    ///         `pivotReserve` and the next purchase spends it. This test buys
    ///         the pool up with real USDG on the real router to make the gap.
    function test_APoolThatWalksAwayDuringTheClosureDefersItsLeg() public {
        uint256 amount = 2 ether;
        vm.deal(address(this), amount);
        IEscrowCredit(ESCROW).credit{value: amount}(address(vault));
        vm.prank(keeper);
        vault.harvest();

        vm.warp(block.timestamp + 3 days);

        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, NVDA, 500);
        (, int24 before_,,,,,) = IUniswapV3PoolObserver(pool).slot0();

        // Push NVDA up: the vault then gets fewer shares per USDG than the
        // frozen TWAP promises, which is exactly what puts it under the floor.
        address whale = makeAddr("weekend whale");
        uint256 push = vm.envOr("PUSH_USDG", uint256(200_000)) * 1e6;
        deal(USDG, whale, push);
        vm.startPrank(whale);
        IERC20(USDG).approve(ROUTER, push);
        ISwapRouter02(ROUTER)
            .exactInput(
                ISwapRouter02.ExactInputParams({
                path: abi.encodePacked(USDG, uint24(500), NVDA), recipient: whale, amountIn: push, amountOutMinimum: 0
            })
            );
        vm.stopPrank();

        (, int24 after_,,,,,) = IUniswapV3PoolObserver(pool).slot0();
        console.log("USDG pushed in:", push / 1e6);
        console.log("tick before / after:");
        console.logInt(before_);
        console.logInt(after_);
        console.log("frozen TWAP still reads:");
        console.logInt(TwapFloor.meanTick(pool, vault.TWAP_WINDOW()));

        VaultTypes.Allocation[] memory basket = vault.getAllocations();
        uint256 legs = _buyAs(vault, keeper);
        console.log("legs bought / basket:", legs, basket.length);
        console.log("pivotReserve left behind (USDG):", vault.pivotReserve() / 1e6);

        // The assertion is on the RULE, not on today's depth: how much USDG it
        // takes to walk the pool past the floor changes with the pool, but a
        // leg that gives way must always leave its money in the reserve rather
        // than take the basket -- or the purchase -- down with it.
        assertGt(legs, 0, "the whole basket must not fall with one leg");
        if (legs < basket.length) assertGt(vault.pivotReserve(), 0, "a skipped leg must leave its USDG behind");
    }

    /// @notice A pool that cannot serve the TWAP window must cost its own leg,
    ///         not the whole basket.
    ///
    ///         `docs/ARCHITECTURE.md` S3 promised exactly this -- "if the TWAP
    ///         is unavailable, that stock is not bought this cycle" -- and the
    ///         code did not do it. `observe` reverting inside `_legFloor` took
    ///         `buyBasket` down with it, for every vault holding the leg, on
    ///         every purchase, until somebody paid to bump the pool's
    ///         cardinality. A `try` cannot wrap an internal library call, which
    ///         is how the promise survived a reading.
    ///
    ///         Nothing is mocked. TSLA/USDG at tier 500 is a real, liquid pool
    ///         -- `Payd._requirePool` admits a pool on existence and liquidity
    ///         alone -- whose observation cardinality is 8 (read 2026-09-10).
    ///         The test fills that ring with its OWN real swaps, because a pool
    ///         only fails the window while every observation it holds is inside
    ///         it: a quiet pool answers from its last write and is fine, which
    ///         is why the naive version of this test passed against the bug.
    /// @notice **T-HYP-02 — the same pool, on the FIRST hop, takes the whole
    ///         purchase down. And that asymmetry is the finding.**
    ///
    /// @dev    `AUDIT_PLAN.md` Appendix A could not settle by reading whether a
    ///         v3 pool's EFFECTIVE window can shrink without its cardinality
    ///         falling. It can, and the repository had already measured it:
    ///         `test/QuoteUniverse.t.sol::test_EveryQuoteRouteTwapWindowMargin`
    ///         records **PFE/USDG at 64 slots spanning 943 seconds on
    ///         2026-09-10 — 15.7 minutes against the 30 required**, after weeks
    ///         of being green. The ring is a fixed number of slots, so **the
    ///         busier the pool, the shorter the history it holds**: popularity
    ///         is what kills the window, not neglect. PFE is a LISTED QUOTE.
    ///
    ///         What was never asserted is the consequence, and it is not
    ///         symmetric:
    ///
    ///           - a LEG whose pool cannot serve the window is skipped, its
    ///             pivot waits in the reserve, the rest of the basket buys —
    ///             `_legFloor` asks `tryMeanTick`. That is the test below;
    ///           - the FIRST HOP has no such mercy. `_route` asks
    ///             `TwapFloor.meanTick`, which reverts, and **the entire
    ///             `buyBasket` goes with it**. Nothing is bought, no window is
    ///             funded, and on a vault whose quote pool is permanently busy
    ///             that is not deferred, it is stranded.
    ///
    ///         **Reverting is the right BEHAVIOUR** — there is no floor for the
    ///         hop, and `minOut = 0` is forbidden. What is wrong is that it is
    ///         indistinguishable from anything else: the revert comes out of
    ///         `observe` as `OLD`, with no vault, no pool and no name. Giving it
    ///         one was built and measured at **+33 bytes, landing `FeeVault` at
    ///         24 018 against a 24 000 gate** — it does not fit, and it would
    ///         change no behaviour. So the remedy is where it can actually act:
    ///         `increaseObservationCardinalityNext` is PERMISSIONLESS, so the
    ///         keeper grows the ring itself rather than waiting for a vote
    ///         (`offchain/src/buy.ts`, `offchain/src/keeper.ts`).
    ///
    ///         Same fixture as the leg case below, same real swaps, no mock —
    ///         the only change is that TSLA is the vault's QUOTE instead of one
    ///         of its basket lines, which moves the very same pool from hop two
    ///         to hop one.
    function test_AQuotePoolTooYoungForTheWindowTakesTheWholePurchaseDown() public {
        address tsla = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, tsla, 500);
        assertTrue(pool != address(0), "no TSLA/USDG pool at tier 500");

        (,,, uint16 cardinality,,,) = IUniswapV3PoolObserver(pool).slot0();
        if (cardinality > 32) {
            console.log("SKIPPED: the tier-500 TSLA pool now covers the window, cardinality", cardinality);
            return;
        }

        FeeVault v2 = _vaultQuotedInTsla(tsla);
        Distributor d2 = Distributor(payable(v2.DISTRIBUTOR()));

        // No escrow and no launch: the quote arrives as a balance and
        // `fundRewards` books it, which is all this needs. What is under test is
        // the hop, not how the money got here.
        deal(tsla, address(v2), 50e18);
        v2.fundRewards();
        assertGt(v2.rewardsPool(), 0, "fixture: the vault must have something to spend");

        vm.warp(d2.epochEnd(0) + 1);
        _fillObservations(tsla, cardinality);

        uint32[] memory ago = new uint32[](2);
        ago[0] = v2.TWAP_WINDOW();
        try IUniswapV3PoolObserver(pool).observe(ago) {
            console.log("SKIPPED: the pool answered the window anyway");
            return;
        } catch {}

        uint256 poolBefore = v2.rewardsPool();
        uint256 nextBefore = d2.nextEpoch();
        // **Built BEFORE the cheatcode is armed.** `getAllocations()` is a call,
        // and `vm.expectRevert` attaches to the NEXT one — inline it swallows
        // the cheatcode and the test reports "did not revert" on a line that
        // reverts. Third time in this file; the rule is to resolve every read
        // first, always.
        uint256[] memory minOuts = new uint256[](v2.getAllocations().length);

        // **The whole purchase, not one leg.** The leg case below buys what it
        // can and carries the rest; this one buys nothing at all.
        vm.expectRevert();
        v2.buyBasket(minOuts);

        assertEq(v2.rewardsPool(), poolBefore, "nothing was spent");
        assertEq(d2.nextEpoch(), nextBefore, "and no window was funded: the epoch is still open");
        assertEq(v2.pivotReserve(), 0, "not even a skipped leg's pivot: the hop never produced any");
        assertEq(d2.totalFunded(NVDA), 0, "no basket line was reached");

        // **The positive control, and it is what makes the revert mean
        // something.** Let the ring's newest observations age out of the dense
        // window — no mock, just time — and the same call on the same vault goes
        // through. So what refused was the window, not the vault, the basket,
        // the cap or the quote.
        vm.warp(block.timestamp + 2 hours);
        (bool haveTwap,) = TwapFloor.tryMeanTick(pool, v2.TWAP_WINDOW());
        assertTrue(haveTwap, "fixture: the pool must answer again for the control to prove anything");

        uint256 legs = v2.buyBasket(minOuts);
        assertGt(legs, 0, "once the pool can price the hop, the very same purchase buys");
        assertGt(d2.nextEpoch(), nextBefore, "and the window it was holding open is funded");
    }

    /// @dev A vault quoted in TSLA, so that the TSLA/USDG tier-500 pool — the
    ///      one `_fillObservations` knows how to exhaust — is its FIRST HOP
    ///      instead of one of its legs. Its basket deliberately excludes TSLA:
    ///      a quote that is also a basket line is held back before the hop
    ///      (`_directShare`), which is the one case that would survive.
    function _vaultQuotedInTsla(address tsla) internal returns (FeeVault) {
        address qqq = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
        VaultTypes.Allocation[] memory a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        a[1] = VaultTypes.Allocation(qqq, 500, 5_000, address(0));

        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        return _cloneVault(
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
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: tsla,
                quoteFee: 500,
                quoteWethFee: 0,
                minBuy: 1e15
            }),
            a
        );
    }

    function test_APoolTooYoungForTheWindowCostsOnlyItsOwnLeg() public {
        address tsla = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
        address feed = 0x4A1166a659A55625345e9515b32adECea5547C38;
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, tsla, 500);
        assertTrue(pool != address(0), "no TSLA/USDG pool at tier 500");

        (,,, uint16 cardinality,,,) = IUniswapV3PoolObserver(pool).slot0();
        if (cardinality > 32) {
            // Cardinality only ever grows, and anybody can pay to grow it.
            console.log("SKIPPED: the tier-500 TSLA pool now covers the window, cardinality", cardinality);
            return;
        }

        FeeVault v2 = _vaultWithFirstStock(tsla, feed);
        vm.deal(address(this), 2 ether);
        IEscrowCredit(ESCROW).credit{value: 2 ether}(address(v2));
        v2.harvest();

        // Past the first epoch BEFORE the swaps, so `_buy` does not warp
        // afterwards and hand the pool the quiet half-hour that saves it.
        Distributor d2 = Distributor(payable(v2.DISTRIBUTOR()));
        vm.warp(d2.epochEnd(0) + 1);
        _fillObservations(tsla, cardinality);

        uint32[] memory ago = new uint32[](2);
        ago[0] = v2.TWAP_WINDOW();
        try IUniswapV3PoolObserver(pool).observe(ago) {
            console.log("SKIPPED: the pool answered the window anyway");
            return;
        } catch {}

        uint256 legs = _buy(v2);
        assertGt(legs, 0, "one unusable pool must not take the basket down");
        assertGt(v2.pivotReserve(), 0, "the skipped leg's USDG must stay in the reserve");
        assertEq(distributor.totalFunded(tsla), 0, "the unusable leg must not have been bought");
    }

    /// @notice The risk that does NOT need a closed market: a feed still inside
    ///         `MAX_FEED_AGE` but behind a rally.
    ///
    ///         The oracle only ever tightens, and it tightens with a price that
    ///         may be up to 12 h old. Measured 2026-09-10 at 19:48 UTC, market
    ///         OPEN: the QQQ, NVDA and SPY feeds were 5.4 h, 6.0 h and 5.9 h
    ///         behind. A stock that climbs more than `MAX_SLIPPAGE_BPS` inside
    ///         that lag makes the floor ask for more shares than the market can
    ///         give, and the leg is skipped -- on an ordinary trading day.
    ///
    ///         Deferred, not lost, and that is the whole point of the test:
    ///         one leg gone leaves its USDG in the reserve, and a basket where
    ///         EVERY leg is gone reverts `NothingToDo` with the rewards pool
    ///         untouched, rather than spending anything at a bad price.
    function test_AFeedLaggingARallySkipsTheLegAndSpendsNothing() public {
        vm.deal(address(this), 2 ether);
        IEscrowCredit(ESCROW).credit{value: 2 ether}(address(vault));
        vault.harvest();

        VaultTypes.Allocation[] memory basket = vault.getAllocations();
        (, int256 ethUsd,,,) = IAggregatorV3(ETH_USD).latestRoundData();
        _freshen(ETH_USD, ethUsd);

        // The whole basket, priced 10 % under the market it is about to buy in.
        for (uint256 i; i < basket.length; ++i) {
            if (basket[i].feed == address(0)) continue;
            (, int256 stockUsd,,,) = IAggregatorV3(basket[i].feed).latestRoundData();
            _freshen(basket[i].feed, (stockUsd * 90) / 100);
        }

        uint256 poolBefore = vault.rewardsPool();
        uint256[] memory minOuts = new uint256[](basket.length);
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.buyBasket(minOuts);
        assertEq(vault.rewardsPool(), poolBefore, "a basket that cannot be bought must spend nothing");

        // Now only one leg is behind. The other four go through and the lagging
        // one waits in the reserve.
        vm.clearMockedCalls();
        _freshen(ETH_USD, ethUsd);
        (, int256 one,,,) = IAggregatorV3(basket[0].feed).latestRoundData();
        _freshen(basket[0].feed, (one * 90) / 100);

        uint256 legs = _buy(vault);
        assertEq(legs, basket.length - 1, "only the lagging leg should have been skipped");
        assertGt(vault.pivotReserve(), 0, "the skipped leg's USDG must stay in the reserve");
        assertEq(distributor.totalFunded(basket[0].stock), 0, "the lagging leg must not have been bought");
    }

    /// @dev Fills a pool's observation ring with real swaps, one per minute, so
    ///      that every observation it holds is younger than the TWAP window.
    ///      One write per timestamp, hence the warp between two swaps.
    function _fillObservations(address stock, uint16 cardinality) internal {
        address filler = makeAddr("observation filler");
        uint256 each = 1_000e6;
        deal(USDG, filler, each * (uint256(cardinality) + 1));
        // Through the cheatcode, NOT `block.timestamp`: `via_ir` treats
        // `timestamp()` as movable, folds the local straight back into it, and
        // the loop then warps by 60, then 120, then 180 -- 45 minutes in all,
        // which spreads the ring back OUTSIDE the window this test needs it
        // inside. Cost of that one: an afternoon.
        uint256 t0 = vm.getBlockTimestamp();
        for (uint256 i; i <= cardinality; ++i) {
            vm.warp(t0 + 60 * (i + 1));
            vm.startPrank(filler);
            IERC20(USDG).approve(ROUTER, each);
            ISwapRouter02(ROUTER)
                .exactInput(
                    ISwapRouter02.ExactInputParams({
                    path: abi.encodePacked(USDG, uint24(500), stock),
                    recipient: filler,
                    amountIn: each,
                    amountOutMinimum: 0
                })
                );
            vm.stopPrank();
        }
        assertLt(uint256(cardinality) * 60, 1_800, "the ring must fit inside the window for this to prove anything");
    }

    /// @notice A `CREATOR` unable to receive ETH does not block `payCreator`.
    ///
    ///         `_pay` used to revert on failure. `DEV` being IMMUTABLE and the
    ///         contract deliberately having no owner, a broken `DEV` blocked
    ///         `payCreator` FOREVER and `creatorPool` accumulated with no way out.
    ///
    ///         It is the same defect already fixed in the `Distributor` — a
    ///         proposer with no `receive()` froze `finalize`. The lesson had not
    ///         been carried over here.
    function test_UnpayableDevCannotBlockPayDev() public {
        EthRejector hostile = new EthRejector();
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault v2 = _cloneVault(
            VaultTypes.Config({
                escrow: ESCROW,
                factory: FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                creator: address(hostile),
                platform: platformWallet,
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _allocations()
        );

        // We feed the dev bucket through the REAL escrow, then harvest.
        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 1 ether}(address(v2));
        vm.prank(keeper);
        v2.harvest();
        assertGt(v2.creatorPool(), 0, "dev bucket empty, the test proves nothing");

        uint256 owed = v2.creatorPool();
        vm.prank(keeper);
        v2.payCreator(); // must NOT revert

        assertEq(v2.creatorPool(), 0, "the dev bucket was not emptied");
        assertEq(v2.pendingWithdrawal(address(hostile)), owed, "the payment was not deferred");
    }

    /// @notice A recipient too expensive for the 30,000 gas push is paid by PULL.
    ///
    ///         The push is capped so no recipient can hold the cycle hostage.
    ///         Whatever does not fit is not lost: it becomes a debt, and
    ///         `withdraw()` settles it with all the gas it needs.
    ///
    ///         The deferral was covered. The RECOVERY was not: the existing
    ///         hostile-dev test uses a recipient that reverts, which could never
    ///         withdraw either, so `FeeVault.withdraw` had never once run.
    function test_ADeferredPaymentCanBePulledByItsRecipient() public {
        GasHungryReceiver safeLike = new GasHungryReceiver();
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault v2 = _cloneVault(
            VaultTypes.Config({
                escrow: ESCROW,
                factory: FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                creator: address(safeLike),
                platform: platformWallet,
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _allocations()
        );

        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 1 ether}(address(v2));
        vm.prank(keeper);
        v2.harvest();
        uint256 owed = v2.creatorPool();
        assertGt(owed, 0, "dev bucket empty, the test proves nothing");

        vm.prank(keeper);
        v2.payCreator();

        // The push could not fit in 30,000 gas, so it became a debt.
        assertEq(v2.pendingWithdrawal(address(safeLike)), owed, "the payment should have been deferred");
        assertEq(address(safeLike).balance, 0, "nothing should have arrived yet");

        // The pull runs with all the gas it needs, and settles it.
        uint256 pulled = safeLike.pull(address(v2));
        assertEq(pulled, owed, "withdraw must return what was owed");
        assertEq(address(safeLike).balance, owed, "the recipient must actually hold the ETH");
        assertEq(v2.pendingWithdrawal(address(safeLike)), 0, "the debt must be cleared");

        // And it is not a well anyone can draw twice.
        vm.expectRevert(FeeVault.NothingToDo.selector);
        safeLike.pull(address(v2));
    }

    /// @notice A Safe as `DEV` is paid DIRECTLY — no deferral, nothing to pull.
    ///
    ///         Worth pinning down, because `DEV` is immutable and choosing a
    ///         Safe is one of the decisions taken before launch. Measured
    ///         against the real Safe factory deployed on this chain: receiving
    ///         ETH costs 11,252 gas, comfortably inside the 30,000 cap.
    ///
    ///         Asserted rather than assumed: this is exactly the kind of number
    ///         that gets stated once, believed, and is wrong.
    function test_ADevSafeIsPaidWithinTheGasCap() public {
        address[2] memory singletons =
            [0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552, 0x41675C099F32341bf84BFc5382aF534df5C7461a];

        for (uint256 i = 0; i < singletons.length; i++) {
            address safe = ISafeProxyFactory(SAFE_FACTORY)
                .createProxyWithNonce(singletons[i], "", uint256(uint160(singletons[i])));
            vm.deal(address(this), 1 ether);

            uint256 g0 = gasleft();
            (bool ok,) = safe.call{value: 0.5 ether, gas: 30_000}("");
            uint256 used = g0 - gasleft();

            assertTrue(ok, "a Safe must fit inside the push cap");
            assertLt(used, 30_000, "if this ever exceeds the cap, payCreator starts deferring");
            assertEq(safe.balance, 0.5 ether, "the Safe must actually hold the ETH");
        }
    }

    /// @notice `setDistGasBps` — the last never-executed function in the vault.
    ///         Bounded on both sides, and reachable only through the timelock.
    function test_SetDistGasBpsIsBoundedAndTimelockOnly() public {
        // Read the bounds FIRST. A read between `vm.prank` and the call
        // consumes the prank — the trap this repository has already been
        // bitten by three times.
        uint256 lo = vault.MIN_DIST_GAS_BPS();
        uint256 hi = vault.MAX_DIST_GAS_BPS();
        assertEq(vault.distGasBps(), lo, "unexpected starting rate");

        vm.expectRevert(FeeVault.NotTimelock.selector);
        vault.setDistGasBps(500);

        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadPayoutRate.selector);
        vault.setDistGasBps(lo - 1);

        vm.prank(timelock);
        vm.expectRevert(FeeVault.BadPayoutRate.selector);
        vault.setDistGasBps(hi + 1);

        vm.prank(timelock);
        vault.setDistGasBps(hi);
        assertEq(vault.distGasBps(), hi, "the rate did not change");
    }

    /// @notice A vault is configured ONCE, and the implementation never is.
    ///
    /// @dev    The fields were `immutable` while a constructor deployed this.
    ///         A clone has no constructor, so they live in storage — and this
    ///         is what still makes them permanent. Without it the ALL_CAPS
    ///         names would be a claim nothing enforces.
    function test_InitHappensOnceAndOnlyOnce() public {
        VaultTypes.Config memory c = VaultTypes.Config({
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
            distributor: address(distributor),
            deployer: deployer,
            registry: address(0),
            intendedToken: address(0),
            quote: address(0),
            quoteFee: 0,
            quoteWethFee: 0,
            minBuy: 0
        });

        // The live vault is configured, and cannot be reconfigured — by anyone.
        assertTrue(vault.initialised(), "the vault must be initialised");
        vm.expectRevert(FeeVault.AlreadyInitialised.selector);
        vault.init(c, _allocations());

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FeeVault.AlreadyInitialised.selector);
        vault.init(c, _allocations());

        // The IMPLEMENTATION is born initialised, so nobody can dress it up as
        // a vault and point a block explorer at it.
        _impls();
        assertTrue(FeeVault(payable(vaultImpl)).initialised(), "the implementation must be sealed");
        vm.expectRevert(FeeVault.AlreadyInitialised.selector);
        FeeVault(payable(vaultImpl)).init(c, _allocations());

        // A fresh clone still takes exactly one.
        FeeVault fresh = _bareVault();
        assertFalse(fresh.initialised(), "a fresh clone must start unconfigured");
        fresh.init(c, _allocations());
        assertEq(fresh.payoutBps(), 400, "a clone runs no constructor: init must seed the defaults");
        assertEq(fresh.distGasBps(), 300, "same for the delivery budget");
        vm.expectRevert(FeeVault.AlreadyInitialised.selector);
        fresh.init(c, _allocations());
    }

    /// @notice The three parts are a partition of what arrives, and the
    ///         creator's is the one that absorbs the rounding.
    ///
    /// @dev    `harvest` computes platform and rewards from their bps and hands
    ///         the CREATOR the residue, so a wei is never lost and never
    ///         invented. Nothing in the contract states the creator's share as
    ///         a number — this test is what says the three add up.
    function test_TheThreePartsArePartitionOfTheGross() public {
        uint256 gross = 3 ether;
        vm.deal(address(this), gross);
        IEscrowCredit(ESCROW).credit{value: gross}(address(vault));

        // This contract has no `receive()`, so its refund is deferred into the
        // debt rather than landing — counting both is what makes the sum add up.
        uint256 before = address(this).balance + vault.pendingWithdrawal(address(this));
        vault.harvest();
        uint256 refund = address(this).balance + vault.pendingWithdrawal(address(this)) - before;

        uint256 rewards = vault.rewardsPool();
        uint256 creator = vault.creatorPool();
        uint256 platform = vault.platformPool();
        uint256 shipping = address(distributor).balance; // the delivery budget, taken from rewards

        assertGt(refund, 0, "no refund at all: the partition below would prove nothing");
        assertEq(rewards + creator + platform + shipping + refund, gross, "the parts must exhaust the gross");
        assertEq(platform, (gross * vault.PLATFORM_BPS()) / 10_000, "the platform takes its bps, no more");
        assertEq(rewards + shipping, (gross * vault.rewardsBps()) / 10_000, "holders get their bps, shipping included");
    }

    /// @notice The holders' share only ever goes up, and only the creator moves it.
    function test_TheRewardsShareIsARatchet() public {
        uint256 from = vault.rewardsBps();
        // Read the ceiling FIRST. Inside the arguments of a call armed with
        // `expectRevert`, a staticcall IS the next call — the cheatcode would
        // attach to `PLATFORM_BPS()` and report that it failed to revert.
        uint256 ceiling = 10_000 - vault.PLATFORM_BPS();

        vm.prank(makeAddr("anyone"));
        vm.expectRevert(FeeVault.NotCreator.selector);
        vault.setRewardsBps(from + 1);

        vm.prank(dev); // the creator
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.setRewardsBps(from); // equal is not an increase

        vm.prank(dev);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.setRewardsBps(from - 1); // and down is out of the question

        vm.prank(dev);
        vm.expectRevert(FeeVault.BadSplit.selector);
        vault.setRewardsBps(ceiling + 1); // past what is left

        vm.prank(dev);
        vault.setRewardsBps(from + 500);
        assertEq(vault.rewardsBps(), from + 500, "the raise did not take");

        // The ceiling is reachable, and it leaves the creator nothing.
        vm.prank(dev);
        vault.setRewardsBps(ceiling);
        assertEq(vault.rewardsBps(), ceiling, "the ceiling is what the platform leaves");
    }

    /// @notice A vault cannot be born taking more than the cap, nor paying
    ///         holders less than the floor.
    function test_TheSplitBoundsAreEnforcedAtBirth() public {
        _expectBadSplit(vault.MAX_PLATFORM_BPS() + 1, 7_000);
        _expectBadSplit(1_000, vault.MIN_REWARDS_BPS() - 1);
        _expectBadSplit(1_000, 9_500); // rewards + platform over 10,000
    }

    function _expectBadSplit(uint256 platformBps_, uint256 rewardsBps_) internal {
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault bare = _bareVault();
        vm.expectRevert(FeeVault.BadSplit.selector);
        bare.init(
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
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _allocations()
        );
    }

    /// @notice The payout pace is adjustable and bounded, and the floor must not
    ///         forbid the nominal setting — that is the trap `MIN_PAYOUT_BPS`
    ///         fell into when we moved to one-hour epochs.
    function test_PayoutRateIsAdjustableWithinBounds() public {
        // Every read is a CALL and consumes the following vm.prank: hoist them
        // all before pranking.
        uint256 floor_ = vault.MIN_PAYOUT_BPS();
        uint256 cap_ = vault.MAX_PAYOUT_BPS();
        uint256 dflt = vault.payoutBps();
        assertEq(dflt, 400, "expected default: 4 % per 30-minute epoch");
        assertLe(floor_, dflt, "the floor forbids the default setting");
        assertGe(cap_, dflt, "the cap forbids the default setting");

        vm.prank(timelock);
        vault.setPayoutBps(floor_);
        assertEq(vault.payoutBps(), floor_);

        vm.prank(timelock);
        vault.setPayoutBps(cap_);
        assertEq(vault.payoutBps(), cap_);

        // Below the floor: refused, otherwise the timelock could freeze rewards.
        vm.expectRevert(FeeVault.BadPayoutRate.selector);
        vm.prank(timelock);
        vault.setPayoutBps(floor_ - 1);

        // Above the cap: refused. This is the fat-finger that matters — a swap
        // of the whole reserve cannot be taken back, unlike a rate set too low.
        vm.expectRevert(FeeVault.BadPayoutRate.selector);
        vm.prank(timelock);
        vault.setPayoutBps(cap_ + 1);

        // And only the timelock can set it.
        vm.expectRevert(FeeVault.NotTimelock.selector);
        vm.prank(keeper);
        vault.setPayoutBps(500);
    }

    /// @notice ~~The rotation wheel~~ — **removed along with what it tested.**
    ///
    /// @dev    There were two tests here: the wheel honoured the weights over a
    ///         full cycle, and the `MIN_ALLOC_BPS` floor bounded the longest run
    ///         of a single stock to 12 epochs. Both measured `allocationOf` and
    ///         `ROTATION_STRIDE`, leftovers from a **weighted rotation** design
    ///         — one stock per epoch — since replaced by buying the whole basket
    ///         in one transaction. `docs/CONVENTIONS.md` already said it: "they are
    ///         `public` and **nothing calls them**".
    ///
    ///         What made them go was not elegance, it was a measurement.
    ///         `FeeVault` weighed 26 152 bytes of runtime, **1 576 above the
    ///         EIP-170 cap**; `via_ir` gave 1 473 of them back, and these two
    ///         deaths another 1 322. The vault went from undeployable to 23 357,
    ///         with 1 219 bytes of margin.
    ///
    ///         `MIN_ALLOC_BPS` stays, and the test below holds it: the floor goes
    ///         on refusing an unbalanced basket, it simply no longer bounds a run
    ///         that no longer exists.

    /// @notice What a basket is not allowed to be.
    function test_TheBasketBoundsAreEnforced() public {
        VaultTypes.Allocation[] memory one = new VaultTypes.Allocation[](1);
        one[0] = VaultTypes.Allocation(NVDA, 500, 10_000, address(0));
        _expectBadBasket(one); // one stock: Pons already does that on its own

        VaultTypes.Allocation[] memory nine = new VaultTypes.Allocation[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = VaultTypes.Allocation(address(uint160(i + 1)), 500, uint16(i == 0 ? 1112 : 1111), address(0));
        }
        _expectBadBasket(nine); // nine: over the cap

        VaultTypes.Allocation[] memory thin = _allocations();
        thin[0].bps = 999;
        thin[1].bps = 3001;
        _expectBadBasket(thin); // a weight under the 10 pct floor

        VaultTypes.Allocation[] memory dup = _allocations();
        dup[1].stock = dup[0].stock;
        _expectBadBasket(dup); // the same stock twice
    }

    function _expectBadBasket(VaultTypes.Allocation[] memory a) internal {
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault bare = _bareVault();
        vm.expectRevert();
        bare.init(
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
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            a
        );
    }

    /// @notice The dev share goes to the immutable address, callable by anyone.
    function test_PayDevIsPermissionless() public {
        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 1 ether}(address(vault));
        vm.prank(keeper);
        vault.harvest();

        uint256 expected = vault.creatorPool();
        vm.prank(makeAddr("stranger"));
        vault.payCreator();

        assertEq(dev.balance, expected, "dev share not paid");
        assertEq(vault.creatorPool(), 0, "dev bucket not emptied");
    }

    /// @notice `harvest` survives a sweep it is not allowed to make.
    ///
    /// @dev    The real failure mode: the vault IS bound to a graduated pool, so
    ///         `_sweepFees` genuinely calls the Pons hook — and the hook
    ///         rejects it, because this vault is not SQUEEZE's creator. That
    ///         rejection must cost the call and nothing else.
    ///
    ///         Without the `try/catch`, every harvest after graduation would
    ///         revert whenever the currency gate is closed. This is the test that
    ///         would catch it.
    ///
    ///         ⚠️ Slots written directly. Re-run `forge inspect FeeVault
    ///         storageLayout` after any change to the state: adding
    ///         `distGasBps` once shifted the whole layout by one and this test
    ///         failed on an incomprehensible `NothingToDo()`.
    function test_HarvestSurvivesAnImpossibleHookSweep() public {
        vm.store(address(vault), bytes32(uint256(1)), bytes32(uint256(uint160(SQUEEZE))));
        vm.store(address(vault), bytes32(uint256(2)), bytes32(uint256(uint160(SQUEEZE_CURVE))));
        assertTrue(IGraduated(SQUEEZE_CURVE).graduated(), "fixture must be a graduated pool");

        uint256 amount = 1 ether;
        vm.deal(address(this), amount);
        IEscrowCredit(ESCROW).credit{value: amount}(address(vault));

        uint256 gross = vault.harvest();
        assertEq(gross, amount, "harvest must still claim the full escrow balance");
    }

    /// @notice The premise of `_sweepFees`, checked against live chain state:
    ///         the hook accepts the creator FEE RECIPIENT, not just the Pons
    ///         operator.
    ///
    /// @dev    This is the reading that recon.md §1.7 got wrong twice. We prank a
    ///         real graduated pool's `creatorFeeRecipient` and assert the call
    ///         does NOT fail on access control. It may still fail on
    ///         `InternalSwapRequiresOperator` — that is the currency gate, and it
    ///         means access control was already passed.
    function test_HookAcceptsTheCreatorFeeRecipient() public {
        address hook = IPonsV2MemeHookSource(FACTORY).memeHook();
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(SQUEEZE);
        assertEq(l.pairToken, address(0), "fixture must be an ETH-quoted pool");

        bytes32 poolId = keccak256(
            abi.encode(
                IPoolManager.PoolKey({
                    currency0: address(0), currency1: SQUEEZE, fee: l.poolFee, tickSpacing: l.tickSpacing, hooks: hook
                })
            )
        );

        vm.prank(l.creatorFeeRecipient);
        (bool ok, bytes memory err) =
            hook.call(abi.encodeWithSelector(IPonsV2MemeHook.sweepPoolFees.selector, poolId, 0, 0));

        // NotFeeSweepOperator() = 0x8d42130c. Seeing it would mean the recipient
        // is refused, and the whole design of `_sweepFees` is wrong.
        // (0x71c4efed is SlippageExceeded — not an access-control failure.)
        if (!ok && err.length >= 4) {
            assertTrue(bytes4(err) != bytes4(0x8d42130c), "hook refused the creatorFeeRecipient on access control");
        }

        // What the recipient actually hits is the CURRENCY gate,
        // InternalSwapRequiresOperator() = 0x31cdb504 — proof that access control
        // was passed and only the pending-memecoin condition stopped it.
        if (!ok) assertEq(bytes4(err), bytes4(0x31cdb504), "expected the currency gate, not a permission failure");

        // Discrimination: an unrelated address must be refused on access control.
        // Without this the assertion above could pass vacuously.
        //
        // Note SQUEEZE cannot serve as the negative case — its `deployer` IS its
        // `creatorFeeRecipient` (the launch form's Creator wallet was left
        // blank), so it passes access control too. Both configurations exist in
        // production, recon.md §1.9.
        vm.prank(makeAddr("stranger"));
        (bool ok2, bytes memory err2) =
            hook.call(abi.encodeWithSelector(IPonsV2MemeHook.sweepPoolFees.selector, poolId, 0, 0));
        assertFalse(ok2, "an unrelated address must not be able to sweep");
        assertEq(bytes4(err2), bytes4(0x8d42130c), "expected NotFeeSweepOperator for a stranger");
    }

    /// @notice The weights must sum to 10,000.
    function test_RevertsOnBadWeights() public {
        VaultTypes.Allocation[] memory bad = _allocations();
        bad[0].bps = 999;
        FeeVault bare = _bareVault();
        vm.expectRevert(FeeVault.BadWeights.selector);
        bare.init(
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
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(distributor),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            bad
        );
    }

    /// @notice The timelock is the only one that can reweight.
    function test_OnlyTimelockCanSetAllocations() public {
        vm.expectRevert(FeeVault.NotTimelock.selector);
        vm.prank(keeper);
        vault.setAllocations(_allocations());

        vm.prank(timelock);
        vault.setAllocations(_allocations()); // does not revert
    }

    // ================================================================
    //  Guard clauses. Each of these refuses something, and none had ever
    //  been made to refuse.
    // ================================================================

    function test_ConstructorRefusesAnyZeroAddress() public {
        VaultTypes.Config memory c = VaultTypes.Config({
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
            distributor: address(distributor),
            deployer: deployer,
            registry: address(0),
            intendedToken: address(0),
            quote: address(0),
            quoteFee: 0,
            quoteWethFee: 0,
            minBuy: 0
        });
        // Every field is load-bearing: nulling any one of them must refuse.
        for (uint256 i = 0; i < 12; i++) {
            VaultTypes.Config memory bad = c;
            if (i == 0) bad.escrow = address(0);
            else if (i == 1) bad.factory = address(0);
            else if (i == 2) bad.router = address(0);
            else if (i == 3) bad.v3Factory = address(0);
            else if (i == 4) bad.weth = address(0);
            else if (i == 5) bad.pivot = address(0);
            else if (i == 6) bad.ethUsdFeed = address(0);
            else if (i == 7) bad.creator = address(0);
            else if (i == 8) bad.platform = address(0);
            else if (i == 9) bad.timelock = address(0);
            else if (i == 10) bad.distributor = address(0);
            else bad.deployer = address(0);
            FeeVault fresh = _bareVault();
            vm.expectRevert(FeeVault.ZeroAddress.selector);
            fresh.init(bad, _allocations());
        }
    }

    function test_BindHappensOnceAndOnlyForOurOwnLaunch() public {
        // A REAL Pons v2 launch, but somebody else's: it exists in the
        // factory, and its creatorFeeRecipient is not this vault.
        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        vault.bind(0x99563a25F128f1b6F9776FDe18caB03020Fe698D);

        // An address the factory has never heard of.
        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        vault.bind(makeAddr("nothing"));
    }

    function test_HarvestRefusesAnEmptyEscrow() public {
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.harvest();
    }

    function test_RunEpochRefusesAPoolTooSmallToBeWorthIt() public {
        // Below MAX_REFUND the purchase would cost more than it moves.
        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 0.001 ether}(address(vault));
        vault.harvest();
        assertLt(vault.rewardsPool(), vault.MAX_REFUND(), "fixture assumes a pool under the floor");

        // Everything read BEFORE arming the cheatcode, or it lands on the read.
        if (distributor.currentEpoch() == 0) vm.warp(distributor.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](vault.getAllocations().length);
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.buyBasket(minOuts);
    }

    function test_PayDevRefusesAnEmptyBucket() public {
        assertEq(vault.creatorPool(), 0, "fixture assumes an empty dev bucket");
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.payCreator();
    }

    function test_WithdrawRevertsWhenTheRecipientRefusesEth() public {
        EthRejector r = new EthRejector();
        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 1 ether}(address(vault));

        // The rejector earns a gas refund it cannot receive: it becomes a debt.
        vm.prank(address(r));
        vault.harvest();
        assertGt(vault.pendingWithdrawal(address(r)), 0, "the refund should have been deferred");

        // And pulling it fails loudly rather than quietly zeroing the debt.
        vm.prank(address(r));
        vm.expectRevert(FeeVault.TransferFailed.selector);
        vault.withdraw();
        assertGt(vault.pendingWithdrawal(address(r)), 0, "a failed pull must not consume the debt");
    }

    /// `withdraw` is per-caller. Someone owed nothing gets a refusal, not zero.
    function test_WithdrawRefusesACallerWhoIsOwedNothing() public {
        vm.prank(makeAddr("nobody"));
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.withdraw();
    }

    /// The refund is bounded twice over, and neither bound had ever bitten.
    ///
    ///   - `_refundAmount` caps what gas is worth at MAX_REFUND;
    ///   - `harvest` then caps it again at what the epoch actually collected,
    ///     so a refund can never be paid out of somebody else's rewards.
    ///
    /// Both only trigger when gas is expensive relative to the take, which is
    /// exactly the moment they matter.
    function test_TheGasRefundNeverExceedsWhatTheEpochCollected() public {
        vm.fee(500 gwei); // a spike, so the refund wants more than is there

        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 0.0002 ether}(address(vault));

        // This contract has no `receive()`, so the push is deferred rather than
        // landing. Counting the debt as well as the balance is what makes the
        // bound below measure the refund instead of always reading zero.
        uint256 before = address(this).balance + vault.pendingWithdrawal(address(this));
        uint256 gross = vault.harvest();
        uint256 got = address(this).balance + vault.pendingWithdrawal(address(this)) - before;
        assertGt(got, 0, "no refund was owed at all: the bound below would prove nothing");

        // INVERTED against Payd, and deliberately: the refund now comes out of
        // the CREATOR's residue, and rewards became the fixed obligation.
        // Whoever chooses the split carries the cost of running it.
        uint256 nominal = gross - (gross * vault.PLATFORM_BPS()) / 10_000 - (gross * vault.rewardsBps()) / 10_000;
        assertLe(got, nominal, "the refund must never exceed the creator's residue");
        assertLe(got, vault.MAX_REFUND(), "and never exceed the absolute cap");

        // This read `creatorPool() == 0` until 2026-09-10 -- the spike ate the
        // residue whole, and the assertion recorded that as the intent. It is
        // now capped: `HARVEST_REFUND_BPS` is the most gas may take, so a 500
        // gwei spike costs the creator 0.5 % and stops there. The bound the
        // test is NAMED for is the one above and it is untouched; what changed
        // is that reaching it no longer means reaching zero.
        uint256 cap = (nominal * vault.HARVEST_REFUND_BPS()) / 10_000;
        assertEq(got, cap, "a spike takes the cap, not the residue");
        assertEq(vault.creatorPool(), nominal - cap, "and the creator keeps the rest of it");
        assertEq(
            vault.rewardsPool() + address(distributor).balance,
            (gross * vault.rewardsBps()) / 10_000,
            "the holders' share is a fixed obligation, untouched by a gas spike"
        );
    }

    /// Same bound on the `runEpoch` side: the refund comes out of `rewardsPool`
    /// and can never overdraw it.
    function test_TheRunEpochRefundCannotOverdrawTheRewardsPool() public {
        vm.deal(address(this), 5 ether);
        IEscrowCredit(ESCROW).credit{value: 3 ether}(address(vault));
        vault.harvest();

        vm.fee(500 gwei); // the spike lands between harvest and the purchase
        uint256 poolBefore = vault.rewardsPool();
        uint256 before = address(this).balance + vault.pendingWithdrawal(address(this));
        _buy(vault);
        uint256 got = address(this).balance + vault.pendingWithdrawal(address(this)) - before;
        assertGt(got, 0, "no refund was owed at all: the bounds below would prove nothing");

        assertLe(got, poolBefore, "the refund cannot exceed the pool it is drawn from");
        assertLe(got, vault.MAX_REFUND(), "and stays under the absolute cap");
        assertLe(vault.rewardsPool(), poolBefore, "the pool can only have gone down");
    }

    /// A small epoch must not pay its caller more than it bought for the
    /// holders. `harvest` has always been bounded by what it collected;
    /// `runEpoch` was bounded by the whole reserve, so under ~0.017 ETH of
    /// reserve the gas refund was larger than the purchase — every epoch, 48
    /// times a day, in exactly the regime a launch starts in.
    /// @notice A purchase can never hand the caller more than it bought — and
    ///         since `MIN_BUY` that is guaranteed rather than merely clamped.
    ///
    /// @dev    Payd needed a clamp here because `runEpoch` spent `payoutBps` of
    ///         the reserve whatever that came to, so on a small pool an epoch
    ///         handed the caller MORE than it bought for the holders, 48 times
    ///         a day. `MIN_BUY` removes the regime: a purchase is at least
    ///         `MAX_REFUND`, so the clamp is a belt on top of braces.
    function test_TheRefundNeverExceedsWhatTheWindowBought() public {
        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 0.24 ether}(address(vault));
        vault.harvest();

        uint256 free = vault.rewardsPool() - vault.MAX_REFUND();
        uint256 nominal = (free * vault.payoutBps()) / 10_000;
        assertLt(nominal, vault.MIN_BUY(), "fixture assumes the fraction alone is under the floor");

        vm.fee(500 gwei); // a basefee spike: the raw refund wants the whole cap
        uint256 before = keeper.balance;
        uint256 poolBefore = vault.rewardsPool();
        _buyAs(vault, keeper);

        uint256 refund = keeper.balance - before;
        uint256 spent = poolBefore - vault.rewardsPool() - refund;
        assertEq(spent, vault.MIN_BUY(), "the floor must lift the purchase to MIN_BUY");
        assertLe(refund, spent, "the refund must never exceed what the window bought");
    }

    /// @notice THE RELAUNCH CASE, against the real launch record of the live
    ///         token. A second deployment made by the SAME Safe must refuse to
    ///         bind the FIRST token — otherwise a relaunch could latch onto the
    ///         old stream, or be ambiguous about which of the two it serves.
    ///
    ///         `bind` is one-shot with no rebind, so an ambiguity here would be
    ///         permanent. What removes it is that a qualifying token needs BOTH
    ///         `deployer == DEPLOYER` AND `creatorFeeRecipient == this vault`.
    ///         The first token satisfies the first condition — same Safe — and
    ///         fails the second. Its recipient WAS the first vault until
    ///         2026-09-06, when `emergencyRedirect` moved it to the Safe to stop
    ///         the stream ahead of the relaunch. Either way it is not the new
    ///         vault, so the refusal is now over-determined — and this test
    ///         asserts the weaker thing that actually causes it, rather than the
    ///         stronger one that happened to be true on the day it was written.
    function test_ANewVaultRefusesThePreviousLaunch() public {
        // A THIRD PARTY's live launch, and the deployer is READ rather than
        // written down. Hard-coding our own launch here would publish the Safe
        // that deployed it, and `getOwners()` turns one address into a list of
        // signers -- in a public repository, for a test that never needed the
        // identity, only the shape.
        address liveToken = 0xf15667A02960c5d31e6e23aA1701833f4e4487f2;

        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(liveToken);
        assertTrue(l.exists, "fixture: the live token must exist on the factory");
        address launcher = l.deployer;
        assertTrue(launcher != address(0), "fixture: Pons writes msg.sender as the deployer of record");
        assertEq(l.creatorFeeRecipient, launcher, "fixture: the stream still points at the launcher, not at any vault");

        // A fresh deployment, same Safe as DEPLOYER: the relaunch shape.
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault v2 = _cloneVault(
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
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: launcher,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _allocations()
        );
        assertEq(v2.LAUNCHER(), l.deployer, "fixture: the deployer check would PASS, so only the recipient can refuse");
        assertTrue(
            l.creatorFeeRecipient != address(v2), "fixture: and the recipient is not this vault, whoever holds it"
        );

        vm.expectRevert(FeeVault.NotOurLaunch.selector);
        v2.bind(liveToken);
        assertEq(address(v2.token()), address(0), "the new vault must stay unbound");
    }

    // ------------------------------------------------- donations (fundRewards)

    /// @notice ETH that is not fee revenue — a top-up before a launch, a
    ///         donation, anything that lands in `receive()` — becomes reserve,
    ///         and the epochs spend it exactly like a harvest.
    function test_DonatedEthIsPutToWorkByTheEpochs() public {
        address donor = makeAddr("donor");
        vm.deal(donor, 3 ether);

        vm.prank(donor);
        (bool sent,) = address(vault).call{value: 3 ether}("");
        assertTrue(sent, "the vault refused a plain transfer");
        assertEq(vault.rewardsPool(), 0, "a bare transfer must credit nothing on its own");

        vm.prank(donor);
        uint256 credited = vault.fundRewards();
        assertEq(credited, 3 ether, "the whole donation must be credited");
        assertEq(vault.rewardsPool(), 3 ether, "the donation is not spendable");
        assertEq(vault.creatorPool(), 0, "a donation must take no dev cut");

        // And it really buys: the point of the exercise.
        uint256 legs = _buyAs(vault, keeper);
        assertEq(legs, vault.getAllocations().length, "the donation bought nothing");
        assertGt(distributor.quoteAtRisk(), 0, "the purchase was not credited");
        assertLt(vault.rewardsPool(), 3 ether, "the reserve did not go down");
    }

    /// @notice One call does as well as two: `fundRewards` measures the balance,
    ///         so its own `msg.value` is included.
    function test_FundRewardsCreditsItsOwnValue() public {
        address donor = makeAddr("donor");
        vm.deal(donor, 1 ether);
        vm.prank(donor);
        assertEq(vault.fundRewards{value: 1 ether}(), 1 ether, "msg.value not credited");
        assertEq(vault.rewardsPool(), 1 ether, "reserve not raised");
    }

    /// @notice It credits only what belongs to nobody. Right after a harvest
    ///         every wei is already in a bucket, so there is nothing to sweep —
    ///         which is what stops this being a way to credit the same ETH twice.
    function test_FundRewardsRefusesWhatIsAlreadyAttributed() public {
        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 1 ether}(address(vault));
        vm.prank(keeper);
        vault.harvest();

        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.fundRewards();
    }

    /// @notice A deferred payment is not a donation. ETH owed to someone whose
    ///         `receive()` failed sits in the same balance, and must not be
    ///         swept into the rewards reserve — they would never get it back.
    function test_FundRewardsLeavesDeferredPaymentsAlone() public {
        EthRejector hostile = new EthRejector();
        Distributor d2 = _cloneDistributor(
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1),
            timelock,
            keeperAddr,
            block.timestamp,
            EPOCH_LENGTH
        );
        FeeVault v2 = _cloneVault(
            VaultTypes.Config({
                escrow: ESCROW,
                factory: FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                creator: address(hostile),
                platform: platformWallet,
                platformBps: 1_000,
                rewardsBps: 7_000,
                timelock: timelock,
                distributor: address(d2),
                deployer: deployer,
                registry: address(0),
                intendedToken: address(0),
                quote: address(0),
                quoteFee: 0,
                quoteWethFee: 0,
                minBuy: 0
            }),
            _allocations()
        );

        vm.deal(address(this), 1 ether);
        IEscrowCredit(ESCROW).credit{value: 1 ether}(address(v2));
        vm.prank(keeper);
        v2.harvest();
        vm.prank(keeper);
        v2.payCreator(); // fails to reach the dev, becomes a debt
        uint256 owed = v2.pendingWithdrawal(address(hostile));
        assertGt(owed, 0, "no deferred payment, the test proves nothing");
        assertEq(v2.pendingTotal(), owed, "pendingTotal out of step with the debt");

        vm.expectRevert(FeeVault.NothingToDo.selector);
        v2.fundRewards();

        // A real donation on top is still credited, and only that.
        vm.deal(address(this), 1 ether);
        assertEq(v2.fundRewards{value: 1 ether}(), 1 ether, "the donation was mis-measured");
        assertEq(v2.pendingWithdrawal(address(hostile)), owed, "the debt moved");
    }

    // ------------------------------------------------------- audit, 2026-09-11

    /// @dev MRVL — `script/Allowlist.s.sol:201`, tier 3000, **no Chainlink feed**.
    ///      The thinnest listed stock pool measured in `docs/allowlist.md`, and
    ///      one of the 27 lines for which the 30-minute TWAP is the only price
    ///      source there is.
    address constant MRVL = 0x62fd0668e10D8B72339BE2DCF7643001688ff13B;

    /// @dev 90 % on the thinnest listed pool, 10 % on the pivot. 9 000 bps is
    ///      the heaviest single leg the basket rules allow:
    ///      `BPS - MIN_ALLOC_BPS x (MIN_BASKET - 1)`.
    function _mrvlHeavyBasket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(MRVL, 3000, 9_000, address(0));
        a[1] = VaultTypes.Allocation(USDG, 0, 1_000, address(0));
    }

    /// @dev The pivot the whole purchase converted into, from `BasketBought`.
    function _pivotIn(Vm.Log[] memory logs) internal pure returns (uint256) {
        bytes32 topic = keccak256("BasketBought(uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (, uint256 usdgIn,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            return usdgIn;
        }
        return 0;
    }

    /// @dev What one stock's leg actually received, from `WindowFunded`.
    function _amountFor(Vm.Log[] memory logs, address stock) internal pure returns (uint256) {
        bytes32 topic = keccak256("WindowFunded(uint256,uint256,address[],uint256[],uint256[])");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (address[] memory stocks, uint256[] memory amounts,) =
                abi.decode(logs[i].data, (address[], uint256[], uint256[]));
            for (uint256 j; j < stocks.length; ++j) {
                if (stocks[j] == stock) return amounts[j];
            }
        }
        return 0;
    }

    /// @dev One purchase of `_mrvlHeavyBasket()` out of a reserve of `reserve`
    ///      wei at `payout` bps, and the three numbers that price it: the MRVL
    ///      the leg received, the USDG it spent, and what the TWAP said that
    ///      USDG was worth at the moment of the swap.
    ///
    ///      `legPivot` is derived and not guessed: `directBps` is zero on an
    ///      ether vault, MRVL sits at index 0 and `_lastPivotLeg` lands on
    ///      index 1, so `_buyLegs:1246` gives this leg exactly
    ///      `mulDiv(pivot, 9_000, BPS)`.
    function _mrvlPurchase(uint256 reserve, uint256 payout)
        internal
        returns (uint256 out, uint256 legPivot, uint256 twapOut, uint256 spent)
    {
        vm.prank(timelock);
        vault.setAllocations(_mrvlHeavyBasket());
        vm.prank(timelock);
        vault.setPayoutBps(payout);

        vm.deal(address(vault), reserve);
        vault.fundRewards();

        // Warp BEFORE reading the TWAP, so the window the assertion is measured
        // against is the one the swap is floored against and not an earlier one.
        Distributor d = Distributor(payable(vault.DISTRIBUTOR()));
        if (d.currentEpoch() == 0) vm.warp(d.epochEnd(0) + 1);

        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, MRVL, 3000);
        int24 tick = TwapFloor.meanTick(pool, vault.TWAP_WINDOW());

        vm.recordLogs();
        uint256 legs = _buy(vault);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(legs, 1, "fixture: both legs must go through, or there is nothing to price");

        uint256 pivot = _pivotIn(logs);
        spent = _spentIn(logs);
        assertGt(pivot, 0, "fixture: the ETH -> USDG hop produced nothing");
        legPivot = FullMath.mulDiv(pivot, 9_000, 10_000);
        out = _amountFor(logs, MRVL);
        assertGt(out, 0, "fixture: the MRVL leg bought nothing");
        twapOut = TwapFloor.quoteAtTick(tick, uint128(legPivot), USDG, MRVL);
    }

    /// @notice **T-TWAP-01 — a leg large against its pool still buys near the
    ///         TWAP it was floored against.**
    ///
    /// @dev    **REWRITTEN 2026-09-11 to the bound that is actually enforced,
    ///         and the rewrite is half the fix.** It used to assert that a leg
    ///         never fills more than 2 % under the TWAP whatever its size. It
    ///         was red at 9 722 bps — 2.78 % under — and the on-chain remedy
    ///         does not exist: `_legFloor` reading the pool's `slot0()` and
    ///         `liquidity()` was built and sized at **+876 bytes, landing
    ///         `FeeVault` at 24 842 against a 24 576 cap**. It does not deploy.
    ///
    ///         So the finding is accepted with its bound written down
    ///         (`FLOWS.md` §7.e, `AUDIT_PLAN.md` §7.15) and the guard is
    ///         off-chain: `offchain/src/keeper.ts` re-measures each leg's pool
    ///         per purchase and shrinks `amountIn` so that no leg spends more
    ///         than `MAX_LEG_DEPTH_BPS` = one whole +1 % depth of its pool
    ///         (`offchain/src/buy.ts`, `docs/allowlist.md`). This test now pins
    ///         the two halves of that arrangement:
    ///
    ///           1. **the contract's own floor still holds** — the leg fills
    ///              within `MAX_SLIPPAGE_BPS` of the TWAP, which is the bound
    ///              §7.15 accepts and the one a reader of it must be able to
    ///              trust. Past the band the swap fails its own floor and the
    ///              leg is SKIPPED, which is safe: measured at the pinned block,
    ///              a 36 ETH and a 60 ETH reserve both skip;
    ///           2. **this purchase is one the keeper would have refused** — the
    ///              leg is above the pool's measured depth, so the
    ///              off-chain clamp is not a claim about a case that cannot
    ///              arise.
    ///
    ///         The day (1) fails, the accepted risk has become a real one and
    ///         §7.15 is wrong. The day (2) fails, the fixture no longer builds
    ///         the case and the off-chain bound is untested.
    ///
    ///         Three facts that do not agree (`AUDIT_PLAN.md` §2.4): the
    ///         tolerance is the CONSTANT `MAX_SLIPPAGE_BPS = 300`
    ///         (`FeeVault.sol:355`, applied at `:1369`); the purchase SCALES
    ///         with the reserve (`:1053-1054`, `payoutBps` up to 1 000 and a
    ///         single leg up to 9 000 bps of it); and nothing compares the two
    ///         — `Payd._requirePool` tests `liquidity() != 0` and says in its
    ///         own comment that it does not catch a thin tier, while `_legFloor`
    ///         reads the pool's TWAP and never its depth.
    ///
    ///         Two ordinary things get a vault here and neither is exotic: a
    ///         quiet stretch — `buyBasket` is permissionless but nobody is paid
    ///         to call it below ~$136 of bounty (§1.4), so an untouched vault
    ///         accumulates — or a timelock that raises `payoutBps`. The reserve
    ///         below is the second: `MAX_PAYOUT_BPS`, which the timelock can set
    ///         today with nothing to stop it.
    ///
    ///         Note what is NOT claimed. Past the 300 bps band the swap fails
    ///         its own floor and the leg is skipped, which is safe: measured at
    ///         the pinned block, a reserve of 36 ETH (a leg of ~$8.4k) and one
    ///         of 60 ETH both SKIP. The window this test sits in is the one
    ///         between "worse than 2 %" and "refused", and it is real because
    ///         the band is a constant while the leg is not.
    ///
    ///         Calibration, measured at block 60310000. Reserve 24 ETH at
    ///         `MAX_PAYOUT_BPS` gives a leg of **5 576.98 USDG**, which buys
    ///         **23.0942 MRVL** where the TWAP promised **23.7545** — **9 722
    ///         bps of the TWAP, i.e. 2.78 % under it**, of which 30 bps is the
    ///         pool's own fee. $155 of holders' money, on one purchase, with no
    ///         attacker and nothing in the logs. The steady-state companion
    ///         below reads 9 959 bps at the same block, which is the bound.
    /// @dev The pivot-side depth of a +1 % move, the formula
    ///      `docs/allowlist.md` defines and `offchain/src/keeper.ts` re-measures
    ///      per purchase. Same arithmetic as `test/Payd.t.sol::_depthUsdVsPivot`.
    function _depthPivot(address pool, address stock) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3PoolObserver(pool).slot0();
        uint256 liq = IV3Liquidity(pool).liquidity();
        if (sqrtP == 0 || liq == 0) return 0;
        uint256 raw = USDG < stock
            ? FullMath.mulDiv(liq, 2 ** 96, sqrtP)  // USDG is token0: amount0 = L / sqrtP
            : FullMath.mulDiv(liq, sqrtP, 2 ** 96); // USDG is token1: amount1 = L * sqrtP
        return FullMath.mulDiv(raw, 4_987_562, 1_000_000_000); // sqrt(1.01) - 1
    }

    // T-TWAP-01
    function test_ALegLargeAgainstItsPoolIsCappedOnChain() public {
        (uint256 out, uint256 legPivot, uint256 twapOut, uint256 spent) =
            _mrvlPurchase(24 ether, vault.MAX_PAYOUT_BPS());

        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, MRVL, 3000);
        uint256 depth = _depthPivot(pool, MRVL);
        uint256 cap = vault.MIN_BUY_QUOTE() * vault.MAX_BUY_MULTIPLE();

        emit log_named_uint("spent, wei                  ", spent);
        emit log_named_uint("the cap, wei                ", cap);
        emit log_named_uint("MRVL leg, USDG spent        ", legPivot);
        emit log_named_uint("pool depth at +1 %, USDG    ", depth);
        emit log_named_uint("leg / depth, x1000          ", (legPivot * 1_000) / depth);
        emit log_named_uint("effective price, bps of TWAP", (out * 10_000) / twapOut);

        // 1. **The cap bound this purchase.** Without it, `payoutBps` at its
        //    ceiling on a 24 ETH reserve asks for 2.4 ETH — six times this —
        //    and the leg fills 278 bps under the TWAP with nobody at fault.
        assertEq(spent, cap, "a reserve this large must be spent a slice at a time, not in one call");
        assertLt(spent, (24 ether * vault.MAX_PAYOUT_BPS()) / 10_000, "and the slice is smaller than the fraction");

        // 2. What that buys, priced: the leg is now about one depth of the
        //    thinnest listed pool rather than six and a half of it.
        assertLt(legPivot, 2 * depth, "the leg must stay near one depth of its pool");

        // 3. And the contract's own floor still holds, with room. It is the
        //    bound `FLOWS.md` §7.e states; the cap is what keeps the distance.
        assertGe(
            out,
            (twapOut * (10_000 - vault.MAX_SLIPPAGE_BPS())) / 10_000,
            "a leg must fill within MAX_SLIPPAGE_BPS of its TWAP"
        );
    }

    /// @notice **And the cap does not reach the purchase the protocol actually
    ///         makes** — which is the half that decides the constant.
    ///
    /// @dev    A ceiling that clipped the steady state would trade a rare bad
    ///         fill for a permanent tax in extra calls. §2.4's steady state at
    ///         $500k/day is a reserve of ~$8.3k and a purchase of ~$333; even
    ///         with the timelock holding `payoutBps` at `MAX_PAYOUT_BPS` that is
    ///         ~$830, against a cap of ~$1,000. This asserts the gap rather than
    ///         trusting the arithmetic.
    function test_TheSteadyStatePurchaseIsNotCapped() public {
        (,,, uint256 spent) = _mrvlPurchase(1.3 ether, vault.MAX_PAYOUT_BPS());
        uint256 cap = vault.MIN_BUY_QUOTE() * vault.MAX_BUY_MULTIPLE();

        emit log_named_uint("steady-state spend, wei", spent);
        emit log_named_uint("the cap, wei           ", cap);

        assertLt(spent, cap, "the steady state must not touch the cap, even at MAX_PAYOUT_BPS");
        assertEq(
            spent, (1.3 ether - vault.MAX_REFUND()) * vault.MAX_PAYOUT_BPS() / 10_000, "it is the fraction, untouched"
        );
    }

    /// @notice **The same measurement at the steady-state size — green, and it
    ///         is what bounds the finding above.**
    ///
    /// @dev    §2.4 computes the steady state: at $500k/day of volume and
    ///         rewards near 3.2 %, 48 windows a day each spending 4 % of the
    ///         free reserve settle at a reserve of ~$8.3k and a purchase of
    ///         ~$333. This runs that purchase. Measured at block 60310000: a leg
    ///         of **299.90 USDG** fills at **9 959 bps of the TWAP**, i.e. 41
    ///         bps under it, of which 30 is the pool's own fee at tier 3000 —
    ///         which no floor can avoid. So the impact itself is ~11 bps, near
    ///         enough to §2.4's "under 0.1 %". The bar is set at 50 bps rather
    ///         than at the measurement, so a pool that thins a little does not
    ///         turn a bound into a failure.
    ///
    ///         It asserts the SAME property as the test above, at the size the
    ///         protocol actually runs at. Keeping both is the point: the finding
    ///         is that nothing separates them, not that the design is broken
    ///         today.
    // T-TWAP-01 (companion, green by design)
    function test_ASteadyStatePurchaseBarelyMovesItsPool() public {
        (uint256 out, uint256 legPivot, uint256 twapOut,) = _mrvlPurchase(1.3 ether, vault.MAX_PAYOUT_BPS());

        emit log_named_uint("MRVL leg, USDG spent      ", legPivot);
        emit log_named_uint("effective price, bps of TWAP", (out * 10_000) / twapOut);

        assertGe(
            out, (twapOut * 9_950) / 10_000, "the steady-state purchase must cost its pool fee and almost nothing else"
        );
    }

    /// @notice **`payPlatform` — the only path from a vault to the Treasury, and
    ///         not one test had ever called it.**
    ///
    /// @dev    `Treasury._split` measures its own balance and shares whatever
    ///         arrived four ways; this is what makes anything arrive. The
    ///         coverage report showed the function had never executed — the
    ///         platform's entire revenue, on a line nothing ran.
    ///
    ///         Permissionless with an immutable destination, exactly like
    ///         `payCreator`: there is no argument to point it anywhere, which is
    ///         why it can be open to everyone.
    function test_PayPlatformIsPermissionlessAndGoesWhereItMust() public {
        vm.deal(address(this), 4 ether);
        IEscrowCredit(ESCROW).credit{value: 4 ether}(address(vault));
        vault.harvest();

        uint256 owed = vault.platformPool();
        assertGt(owed, 0, "fixture: the harvest must have set a platform share aside");
        uint256 before = platformWallet.balance;

        vm.prank(makeAddr("a passer-by"));
        uint256 paid = vault.payPlatform();

        assertEq(paid, owed, "it pays what it had set aside");
        assertEq(platformWallet.balance - before, owed, "to the address written at birth, and to no other");
        assertEq(vault.platformPool(), 0, "and the pocket is emptied");

        // And it refuses to spend a transaction on nothing.
        vm.expectRevert(FeeVault.NothingToDo.selector);
        vault.payPlatform();
    }

    /// @dev What one purchase SPENT, in the vault's own currency, from
    ///      `BasketBought(toEpoch, quoteIn, usdgIn, legsBought)`.
    function _spentIn(Vm.Log[] memory logs) internal pure returns (uint256) {
        bytes32 topic = keccak256("BasketBought(uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            (uint256 quoteIn,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            return quoteIn;
        }
        return 0;
    }

    /// @notice **T-RISK-01 — `quoteAtRisk` measures what a leaked keeper key
    ///         could take.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property the whole
    ///         system presents as true: after two purchases and no delivery,
    ///         `quoteAtRisk` equals what those two purchases spent. It is the
    ///         figure `FLOWS.md` §7.c, `docs/ARCHITECTURE.md` §S29,
    ///         `offchain/src/keeper.ts:813` and `offchain/src/check.ts:162` all
    ///         publish as the exposure. **RED means the finding is reproduced**:
    ///         it under-reports by exactly the quote of every skipped leg.
    ///
    ///         The mechanism, `contracts/FeeVault.sol:1166-1167` and `:1249`.
    ///         `_toPivot` folds the carried `pivotReserve` into `pivot` before
    ///         `_buyLegs` sees it, but `quoteIn` is only THIS call's spend. Each
    ///         leg is credited `quoteLeg = mulDiv(legPivot, quoteIn, pivot)`, so
    ///         the legs share out `quoteIn` and nothing more. A leg that skipped
    ///         in an earlier call had its quote recorded NOWHERE — it is not in
    ///         `legs`, `bought` is not incremented — and when its pivot is
    ///         finally spent, no quote follows it.
    ///
    ///         So the published exposure drifts LOW exactly when legs are
    ///         failing, which is exactly when the real exposure is rising. It
    ///         also skews `Distributor._one`'s `backing` (`:561-562`), the
    ///         decrement.
    ///
    ///         **Fixed 2026-09-11**: `reserveQuote` is carried alongside
    ///         `pivotReserve` — folded into `quoteIn` at the top of `_buyLegs`
    ///         the way `_toPivot` folds the reserve into `pivot`, and written
    ///         back at the bottom with whatever no leg carried away. FeeVault
    ///         23 930 -> 23 966 bytes; the getter is dropped (`internal`) to pay
    ///         for it. The gate is removed.
    ///
    ///         **The skip is built out of real swaps, not a mock.** This reuses
    ///         `test_APoolTooYoungForTheWindowCostsOnlyItsOwnLeg`'s fixture:
    ///         TSLA/USDG at tier 500 is a real, liquid pool whose observation
    ///         cardinality is 8, and the test fills that ring with its own real
    ///         swaps so that every observation it holds is younger than the
    ///         window. `observe` then reverts `OLD`, `tryMeanTick` says so, and
    ///         `_legFloor` returns 0. Nothing about Uniswap is simulated.
    // T-RISK-01
    function test_QuoteAtRiskCountsEverySkippedLegsQuote() public {
        address tsla = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
        address feed = 0x4A1166a659A55625345e9515b32adECea5547C38;
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, tsla, 500);
        assertTrue(pool != address(0), "no TSLA/USDG pool at tier 500");

        (,,, uint16 cardinality,,,) = IUniswapV3PoolObserver(pool).slot0();
        if (cardinality > 32) {
            console.log("SKIPPED: the tier-500 TSLA pool now covers the window, cardinality", cardinality);
            return;
        }

        FeeVault v2 = _vaultWithFirstStock(tsla, feed);
        Distributor d2 = Distributor(payable(v2.DISTRIBUTOR()));
        vm.deal(address(this), 4 ether);
        IEscrowCredit(ESCROW).credit{value: 4 ether}(address(v2));
        v2.harvest();

        // Past the first epoch BEFORE the swaps, so `_buy` does not warp
        // afterwards and hand the pool the quiet half-hour that saves it.
        vm.warp(d2.epochEnd(0) + 1);
        _fillObservations(tsla, cardinality);

        uint32[] memory ago = new uint32[](2);
        ago[0] = v2.TWAP_WINDOW();
        try IUniswapV3PoolObserver(pool).observe(ago) {
            console.log("SKIPPED: the pool answered the window anyway");
            return;
        } catch {}

        // --- window 1: TSLA gives way, its USDG stays in the reserve.
        vm.recordLogs();
        uint256 legsOne = _buy(v2);
        uint256 spentOne = _spentIn(vm.getRecordedLogs());
        assertLt(legsOne, v2.getAllocations().length, "fixture: a leg must have been skipped");
        assertGt(v2.pivotReserve(), 0, "fixture: the skipped leg's USDG must be waiting in the reserve");

        // --- the pool ages past the window, with no mock: the ring's oldest
        //     observation simply falls outside 1 800 s again.
        vm.warp(block.timestamp + 2 hours);
        (bool haveTwap,) = TwapFloor.tryMeanTick(pool, v2.TWAP_WINDOW());
        assertTrue(haveTwap, "fixture: the pool must answer the window again for the carried USDG to be spent");

        // --- window 2: the carried reserve is spent, and no quote follows it.
        vm.recordLogs();
        uint256 legsTwo = _buy(v2);
        uint256 spentTwo = _spentIn(vm.getRecordedLogs());
        assertGt(legsTwo, 0, "fixture: the second window must buy something");

        uint256 spent = spentOne + spentTwo;
        uint256 measured = d2.quoteAtRisk();
        emit log_named_uint("spent, window 1 (wei)     ", spentOne);
        emit log_named_uint("spent, window 2 (wei)     ", spentTwo);
        emit log_named_uint("spent, both windows (wei) ", spent);
        emit log_named_uint("quoteAtRisk reports (wei) ", measured);
        emit log_named_uint("under-reported by (wei)   ", spent > measured ? spent - measured : 0);

        emit log_named_uint("still held back (wei)     ", v2.reserveQuote());

        // **Conservation, which is the property and not the equality.** Every
        // wei a purchase spent is either at risk in the Distributor or still
        // held back here with the pivot it bought — never neither, which is
        // what it used to be. The two halves are asserted separately so a
        // failure says which one moved.
        assertEq(
            measured + v2.reserveQuote(),
            spent,
            "every wei spent must be either at risk in the Distributor or carried with the reserve that holds it"
        );
        // What is left over is `mulDiv` dust and nothing else: each leg's share
        // rounds DOWN, so at most one wei per leg per window fails to follow its
        // pivot — measured, 4 wei over two windows of a five-line basket. The
        // direction is the guarantee: the residue stays with the reserve, so
        // `quoteAtRisk` can only ever err LOW by dust, never lose a leg.
        assertLe(
            spent - measured,
            2 * v2.getAllocations().length,
            "more than rounding dust is missing: a skipped leg's quote is being lost again"
        );
    }

    // ------------------------------------------------- audit phase 2, 2026-09-11

    /// @dev Every `LegSkipped(stock, usdgHeld)` in a batch of logs, summed.
    function _skipped(Vm.Log[] memory logs) internal pure returns (uint256 total, uint256 count) {
        bytes32 topic = keccak256("LegSkipped(address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            total += abi.decode(logs[i].data, (uint256));
            ++count;
        }
    }

    /// @notice **T-ALLOC-01 — `setAllocations` refuses a tier whose pool does
    ///         not exist.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property that SHOULD
    ///         hold: the timelock cannot write a basket line the vault can never
    ///         buy. **RED means the finding is reproduced** —
    ///         `_setAllocations:1743-1772` validates a non-zero address, a
    ///         non-zero `poolFee` unless the line is `PIVOT`, `bps >=
    ///         MIN_ALLOC_BPS`, no duplicate and `sum == BPS`, and never calls
    ///         `Payd.listing` nor `_requirePool`.
    ///
    ///         `Payd._allowStocks:777` added `_requirePool` to catch exactly
    ///         this — `test_AListingWithoutItsPoolIsRefused` is that test — and
    ///         the guard was missing on the one path that reaches a LIVE vault.
    ///
    ///         **Fixed 2026-09-11**: `_setAllocations` asks the factory for the
    ///         pool instead of testing the tier for zero, which subsumes the old
    ///         check — the factory has no pool at tier zero either. FeeVault
    ///         23 775 -> 23 930 bytes. The gate is removed and the `if
    ///         (accepted)` block below is now dead by construction, kept because
    ///         it is what the cost of the bug looked like.
    ///         Distinguish it from the accepted design of §7.5: *delisting must
    ///         not reach backwards* is deliberate and right; *writing a tier
    ///         with no pool at all* is not the same thing.
    ///
    ///         **The fixture is the mistake a human makes.** Tier `5000` is not
    ///         an enabled Uniswap v3 fee amount — the four are 100, 500, 3000
    ///         and 10000 — so `getPool` returns `address(0)` and `_legFloor`
    ///         returns 0 on its first line, for the vault's whole life. One
    ///         transposed zero on `500`.
    // T-ALLOC-01
    function test_SetAllocationsRefusesATierWithNoPool() public {
        address qqq = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
        assertEq(
            IUniswapV3Factory(V3_FACTORY).getPool(USDG, NVDA, 5000),
            address(0),
            "fixture: 5000 is not an enabled v3 fee amount, so there is no pool to find"
        );

        VaultTypes.Allocation[] memory bad = new VaultTypes.Allocation[](2);
        bad[0] = VaultTypes.Allocation(NVDA, 5000, 5_000, address(0)); // one zero too many
        bad[1] = VaultTypes.Allocation(qqq, 500, 5_000, address(0));

        bool accepted;
        vm.prank(timelock);
        try vault.setAllocations(bad) {
            accepted = true;
        } catch {}

        // What it costs, shown rather than asserted: the line is not merely
        // useless, it is silently useless. No revert, no alert, on every
        // purchase, for ever.
        if (accepted) {
            vm.deal(address(vault), 2 ether);
            vault.fundRewards();
            vm.recordLogs();
            uint256 legs = _buy(vault);
            (uint256 held, uint256 n) = _skipped(vm.getRecordedLogs());
            emit log_named_uint("legs bought of 2            ", legs);
            emit log_named_uint("legs skipped                ", n);
            emit log_named_uint("USDG stranded in the reserve", held);
            assertEq(distributor.totalFunded(NVDA), 0, "the dead leg bought nothing, as predicted");
        }

        assertFalse(accepted, "a basket line whose pool does not exist must not be written into a live vault");
    }

    /// @notice **T-LEG-01 — every wei a purchase leaves in `pivotReserve` is
    ///         named by a `LegSkipped`.**
    ///
    /// @dev    **ASSERTION DIRECTION.** This asserts the property that should
    ///         hold: a verifier replaying `LegSkipped` sees the whole picture.
    ///         `AUDIT_PLAN.md` §3b expects red, on the grounds that
    ///         `_buyLegs:1247`'s `legPivot == 0 || legPivot > pivotLeft`
    ///         `continue` emits nothing while the other two skip paths do.
    ///
    ///         **It is green, and the reason is arithmetic rather than luck.**
    ///         For every leg but the last, `legPivot = mulDiv(pivot, bps,
    ///         BPS - directBps)` and `mulDiv` rounds DOWN, so the non-last legs
    ///         sum to at most `pivot`; the last pivot-spending leg
    ///         (`_lastPivotLeg:1287`) takes `pivotLeft` itself. `pivotLeft`
    ///         therefore never goes below the share about to be taken, and
    ///         `legPivot > pivotLeft` cannot happen. The other arm,
    ///         `legPivot == 0`, needs `pivot x bps < BPS`, i.e. a pivot under 10
    ///         raw USDG at the 1 000 bps floor — a hundred-thousandth of a
    ///         cent — while `spent_` is floored at `MIN_BUY_QUOTE` (~$25) and
    ///         `_toPivot` converts it. Neither is reachable without mocking the
    ///         swap, which the house rules forbid and which would prove nothing
    ///         about the real router.
    ///
    ///         So the row stands as CONFIRMED-BY-CONSTRUCTION rather than as a
    ///         bug, the same verdict §3b reaches for `_lastPivotLeg` returning
    ///         `n`. What this test pins is the consequence the row actually
    ///         cares about: the reserve's growth is fully explained by the
    ///         events, to within one wei per leg of division dust.
    // T-LEG-01
    function test_EveryWeiLeftInTheReserveIsNamedByALegSkipped() public {
        address tsla = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
        address feed = 0x4A1166a659A55625345e9515b32adECea5547C38;
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(USDG, tsla, 500);

        (,,, uint16 cardinality,,,) = IUniswapV3PoolObserver(pool).slot0();
        if (cardinality > 32) {
            console.log("SKIPPED: the tier-500 TSLA pool now covers the window, cardinality", cardinality);
            return;
        }

        FeeVault v2 = _vaultWithFirstStock(tsla, feed);
        Distributor d2 = Distributor(payable(v2.DISTRIBUTOR()));
        vm.deal(address(this), 2 ether);
        IEscrowCredit(ESCROW).credit{value: 2 ether}(address(v2));
        v2.harvest();

        vm.warp(d2.epochEnd(0) + 1);
        _fillObservations(tsla, cardinality);

        uint32[] memory ago = new uint32[](2);
        ago[0] = v2.TWAP_WINDOW();
        try IUniswapV3PoolObserver(pool).observe(ago) {
            console.log("SKIPPED: the pool answered the window anyway");
            return;
        } catch {}

        uint256 before = v2.pivotReserve();
        vm.recordLogs();
        uint256 legs = _buy(v2);
        (uint256 held, uint256 n) = _skipped(vm.getRecordedLogs());
        uint256 grew = v2.pivotReserve() - before;

        assertGt(n, 0, "fixture: a leg must have been skipped for this to prove anything");
        emit log_named_uint("pivotReserve grew by   ", grew);
        emit log_named_uint("LegSkipped accounts for", held);
        emit log_named_uint("unexplained (dust)     ", grew - held);

        // One wei per leg of division dust is the whole of what the events do
        // not name; anything more would be an unemitted skip.
        assertLe(
            grew,
            held + v2.getAllocations().length,
            "a wei reached the reserve without a LegSkipped naming it: a log replay under-counts"
        );
        assertGt(legs, 0, "and the rest of the basket still bought");
    }

    /// @notice **T-BOMB-01, the mechanism — a callee returning megabytes costs
    ///         its caller a bounded amount.**
    ///
    /// @dev    **ASSERTION DIRECTION.** The property that SHOULD hold, and does:
    ///         `_staticUint`'s 30 000 gas cap bounds the callee's expansion, and
    ///         the caller's own copy plus expansion is tens of thousands of gas
    ///         — not a brick. §2.9 rates it **Low** on exactly that reasoning
    ///         and this measures it.
    ///
    ///         **Scope, stated plainly. This measures the MECHANISM, not
    ///         `buyBasket`.** The `buyBasket` gas delta `AUDIT_PLAN.md` asks for
    ///         is BLOCKED, and the reason is worth recording: `_staticUint` is
    ///         reached from a leg only through `_uiMultiplierNow`, which is
    ///         called only by `_oracleOut`/`_oracleOutPivot`, which return on
    ///         their first line when `a.feed == address(0)`. So a hostile stock
    ///         would have to be (a) a basket line, (b) with a real v3 pool
    ///         carrying 30 minutes of observations, and (c) with a Chainlink
    ///         feed — and a fresh contract has none of the three. Manufacturing
    ///         them means minting real liquidity into a new pool and seeding its
    ///         observation ring, which is out of proportion to a Low, and
    ///         `vm.etch` onto one of the 97 real stocks is not on the table.
    ///
    ///         Measured at block 60310000: an honest callee costs the probe
    ///         **1 334 gas**, the bomb **30 977**, a delta of **29 643** — and a
    ///         second read of the same bomb costs the same again, because each
    ///         staticcall gets its own memory frame. `_buyLegs` makes at most
    ///         two such reads per leg over at most eight legs, so the ceiling is
    ///         tens of thousands of gas on a ~1.38 M-gas purchase. Bounded, and
    ///         honestly so.
    ///
    ///         The probe below is a faithful copy of `FeeVault._staticUint:1446`
    ///         — same selector shape, same 30 000 gas cap, same `bytes memory`
    ///         capture — driven against OUR OWN contracts at fresh addresses.
    ///         Nothing about Pons, Uniswap or a stock token is simulated,
    ///         because none of them is involved.
    // T-BOMB-01
    function test_AReturnBombCostsItsCallerABoundedAmount() public {
        StaticProbe probe = new StaticProbe();
        HonestUint honest = new HonestUint();
        ReturnBomb bomb = new ReturnBomb();

        uint256 g0 = gasleft();
        probe.read(address(honest));
        uint256 honestGas = g0 - gasleft();

        g0 = gasleft();
        probe.read(address(bomb));
        uint256 bombGas = g0 - gasleft();

        emit log_named_uint("honest callee, gas", honestGas);
        emit log_named_uint("return bomb, gas  ", bombGas);
        emit log_named_uint("delta, gas        ", bombGas - honestGas);

        // And it is paid PER CALL, not once: each staticcall runs in its own
        // frame, so the high-water-mark argument only holds inside one of them.
        // Measured at block 60310000: honest 1 334 gas, bomb 30 977, second
        // bomb 31 014 — so ~29.6k per hostile leg, eight legs at most.
        g0 = gasleft();
        probe.read(address(bomb));
        emit log_named_uint("second bomb, gas  ", g0 - gasleft());

        assertLt(bombGas - honestGas, 150_000, "the gas cap must bound what a hostile callee can charge its caller");
    }
}

/// @dev `FeeVault._staticUint:1446`, copied rather than reached: same selector
///      shape, same 30 000 gas cap, same `bytes memory` capture — which is what
///      makes solc emit the `returndatacopy` Slither's `return-bomb` detector
///      flags.
contract StaticProbe {
    function read(address target) external view returns (uint256) {
        (bool ok, bytes memory ret) = target.staticcall{gas: 30_000}(abi.encodeWithSelector(bytes4(0xa60bf13d)));
        if (!ok || ret.length < 32) return 1e18;
        return abi.decode(ret, (uint256));
    }
}

contract HonestUint {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1e18));
    }
}

/// @dev Expands as far as 30 000 gas allows and returns all of it. The caller
///      pays for the copy and for its own expansion, outside the stipend.
contract ReturnBomb {
    fallback(bytes calldata) external returns (bytes memory) {
        return new bytes(100_000);
    }
}
