// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {CloneBase} from "./CloneBase.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {IPonsV2LaunchFactory, IERC20, IPonsV2BondingCurve} from "../contracts/interfaces/IExternal.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {IAggregatorV3} from "../contracts/interfaces/IExternal.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

interface IEscrowBoth {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claim() external returns (uint256);
}

/// @notice **`PLAN.md` §8bis Q1 — what a launch quoted in something other than
///         ETH does to a vault.**
///
/// @dev    `launchToken(params, configId, pairToken)` takes the pair token as an
///         argument, so a creator may quote a launch in an ERC-20. Every number
///         a vault holds is native wei, and `_toUsdg` swaps ETH. Three guards
///         already refuse a non-zero `pairToken` — `_poolKey`,
///         `Treasury.buyAndBurn` and the off-chain rehearsal — but **`bind` is
///         not one of them**.
///
///         This file measures rather than argues. Nothing is mocked: the real
///         factory, the real escrow, the real Uniswap pools.
contract PairTokenTest is CloneBase {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    /// @dev NVDA's Chainlink aggregator (`docs/recon.md` §5), for T-ORACLE-01.
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    /// @dev Coinbase: NO pool at all against the pivot, $33 144 of depth
    ///      against WETH. The most used out-of-reach pair of the week of
    ///      2026-09-08, and the reason the fallback route exists.
    address constant COIN = 0x6330D8C3178a418788dF01a47479c0ce7CCF450b;

    address launcher = makeAddr("launcher");
    address timelock = makeAddr("timelock");
    address platform = makeAddr("platform");
    address dev = makeAddr("dev");
    address keeper = makeAddr("keeper");

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
    }

    function _vault(address deployer_) internal returns (FeeVault v, Distributor d) {
        return _vault(deployer_, address(0), 0, 0);
    }

    function _vault(address deployer_, address quote_, uint24 quoteFee_, uint256 minBuy_)
        internal
        returns (FeeVault v, Distributor d)
    {
        return _vault(deployer_, quote_, quoteFee_, 0, minBuy_, _basket());
    }

    function _vault(
        address deployer_,
        address quote_,
        uint24 quoteFee_,
        uint24 quoteWethFee_,
        uint256 minBuy_,
        VaultTypes.Allocation[] memory basket
    ) internal returns (FeeVault v, Distributor d) {
        return _vaultInner(deployer_, quote_, quoteFee_, quoteWethFee_, minBuy_, basket);
    }

    function _vault(
        address deployer_,
        address quote_,
        uint24 quoteFee_,
        uint256 minBuy_,
        VaultTypes.Allocation[] memory basket
    ) internal returns (FeeVault v, Distributor d) {
        return _vaultInner(deployer_, quote_, quoteFee_, 0, minBuy_, basket);
    }

    function _vaultInner(
        address deployer_,
        address quote_,
        uint24 quoteFee_,
        uint24 quoteWethFee_,
        uint256 minBuy_,
        VaultTypes.Allocation[] memory basket
    ) internal returns (FeeVault v, Distributor d) {
        _impls();
        Bootstrap boot = new Bootstrap(
            vaultImpl,
            distImpl,
            _cfg(deployer_, quote_, quoteFee_, quoteWethFee_, minBuy_),
            basket,
            keeper,
            block.timestamp,
            30 minutes
        );
        return (boot.VAULT(), boot.DISTRIBUTOR());
    }

    /// @dev The config on its own, so that `vm.expectRevert` can attach to the
    ///      `new Bootstrap` itself: the cheatcode aims at the NEXT call, and an
    ///      internal helper steals it from it.
    function _cfg(address deployer_, address quote_, uint24 quoteFee_, uint24 quoteWethFee_, uint256 minBuy_)
        internal
        view
        returns (VaultTypes.Config memory)
    {
        return VaultTypes.Config({
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
            deployer: deployer_,
            registry: address(0),
            intendedToken: address(0),
            quote: quote_,
            quoteFee: quoteFee_,
            quoteWethFee: quoteWethFee_,
            minBuy: minBuy_
        });
    }

    /// @dev Returns the token, or address(0) if Pons refused this pair.
    function _try(address pair, address recipient, string memory sym, bytes32 salt) internal returns (address token) {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        bytes32 eco;
        try f.previewLaunchEconomics(0, pair) returns (bytes32 e) {
            eco = e;
        } catch {
            console.log("  previewLaunchEconomics refused this pair");
            return address(0);
        }

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

        // `launchFee()` is read BEFORE the prank. Inside `{value: ...}` it is
        // still a CALL, and `vm.prank` attaches to the next one — written
        // inline it eats the prank, the launch goes out as the test contract,
        // and `bind` then refuses with `NotOurLaunch`. That is exactly how this
        // failed the first time.
        uint256 fee = f.launchFee();
        vm.prank(launcher);
        try f.launchToken{value: fee}(p, 0, pair) returns (address t, address) {
            return t;
        } catch (bytes memory err) {
            console.log("  launchToken reverted");
            console.logBytes(err);
            return address(0);
        }
    }

    // ------------------------------------------------------------------ 1.

    /// @notice Which pair tokens does Pons actually accept?
    ///
    /// @dev    The plan asked for "every possibility". This enumerates the ones
    ///         that exist on this chain and reports, rather than assuming that a
    ///         field being an argument means every value is allowed.
    function test_WhichPairTokensPonsAccepts() public {
        vm.deal(launcher, 100 ether);

        address[5] memory pairs = [address(0), USDG, WETH, NVDA, address(0xdead)];
        string[5] memory names = ["native ETH", "USDG", "WETH", "NVDA (a stock)", "0xdead (not a token)"];

        uint256 accepted;
        for (uint256 i; i < pairs.length; ++i) {
            console.log(names[i]);
            address t = _try(pairs[i], makeAddr(names[i]), "PAIR", bytes32(i + 1));
            if (t != address(0)) {
                ++accepted;
                IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(t);
                console.log("  ACCEPTED, recorded pairToken:", l.pairToken);
            }
        }
        console.log("accepted pairs:", accepted, "of", pairs.length);
        assertGt(accepted, 0, "native ETH at least must launch, or the harness is broken");
    }

    // ------------------------------------------------------------------ 2.

    /// @notice **Why a non-ETH launch is refused: its fees land in a ledger no
    ///         vault can read.**
    ///
    /// @dev    Measured end to end on a real USDG-quoted launch with a real
    ///         trade on the real curve. The recipient here is a plain address,
    ///         not a vault — `bind` now refuses these outright (the test below),
    ///         so this one exists to record WHAT it refuses and why.
    function test_ANonEthLaunchCreditsALedgerNoVaultCanRead() public {
        vm.deal(launcher, 10 ether);
        address recipient = makeAddr("a would-be vault");

        address token = _try(USDG, recipient, "USDGP", bytes32(uint256(0x420)));
        require(token != address(0), "fixture: a USDG-quoted launch must be possible");

        IPonsV2BondingCurve curve = IPonsV2BondingCurve(IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token).curve);

        // --- 2. A real trade, so a real creator fee accrues on the curve.
        uint256 one = 10 ** IDecimals(USDG).decimals();
        address buyer = makeAddr("buyer");
        deal(USDG, buyer, 100_000 * one);
        // Past the 3 s snipe tax BEFORE buying, not after. Trading inside that
        // window credits the creator ~70 % of the spend, which would make the
        // number below look like a colossal fee instead of a 4 % one — a
        // measurement that reads like a finding and is only an artefact.
        vm.warp(block.timestamp + 10);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(curve), type(uint256).max);
        curve.buy(1_000 * one, 0, buyer);
        vm.stopPrank();

        // --- 3. The tax accrues ON THE CURVE and only reaches the escrow
        //        through `sweepFees`. Reading the escrow before sweeping would
        //        measure nothing and read like a finding, so we sweep first —
        //        as the vault, which is what the curve calls its `deployer`.
        uint256 onCurve = IERC20(USDG).balanceOf(address(curve));
        vm.prank(recipient); // the curve calls the fee recipient its `deployer`
        curve.sweepFees(0);

        uint256 native_ = IEscrowBoth(ESCROW).balanceOf(recipient);
        uint256 inUsdg = IEscrowBoth(ESCROW).balanceOfToken(recipient, USDG);
        console.log("USDG held by the curve :", onCurve);
        console.log("escrow, native ledger  :", native_);
        console.log("escrow, USDG ledger    :", inUsdg);

        // The money is NOT lost by Pons — it is credited, at the normal rate,
        // on a ledger the vault has no function to read and none to claim.
        // `harvest` calls `claim()`, which reads `_balances[msg.sender]`, the
        // NATIVE ledger. That is the whole defect in two numbers.
        assertGt(inUsdg, 0, "the fee IS credited, on the ERC-20 ledger");
        assertEq(native_, 0, "and nothing reaches the ledger harvest reads");

        // 4.70 % of the trade, the same rate Payd measures on an ETH launch.
        // Asserted as a band, not a constant: the point is the ORDER, and
        // pinning it would make this test fail on a Pons fee change that is
        // none of its business.
        assertGt(inUsdg, (1_000 * one * 40) / 1_000, "a real creator fee, not dust");
        assertLt(inUsdg, (1_000 * one * 60) / 1_000, "and not a snipe-tax artefact");
    }

    /// @notice **The fix: `bind` refuses anything not quoted in native ETH.**
    ///
    /// @dev    Mutation check — remove the guard and this is the test that
    ///         fails; every other one in the repository launches against ETH
    ///         and never notices.
    function test_BindRefusesALaunchQuotedInAnythingButEth() public {
        vm.deal(launcher, 10 ether);
        (FeeVault v, Distributor d) = _vault(launcher);

        address token = _try(USDG, address(v), "USDGR", bytes32(uint256(0x422)));
        require(token != address(0), "fixture");

        vm.expectRevert(abi.encodeWithSelector(FeeVault.UnsupportedPair.selector, USDG));
        v.bind(token);

        // And the vault stays INERT rather than half-alive: unbound, holding
        // nothing, with the stock path shut. That is the outcome the guard
        // buys — a creator who finds out now instead of never.
        assertEq(address(v.token()), address(0), "the vault must stay unbound");
        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        vm.expectRevert(FeeVault.NothingToDo.selector);
        v.buyBasket(minOuts);
    }

    // ------------------------------------------------------------------ 3.

    /// @notice The control: the same vault and the same basket, quoted in ETH,
    ///         buys stocks. So the refusal above is the pair token and nothing
    ///         else — without this, `UnsupportedPair` could be hiding a broken
    ///         fixture and the suite would look just as green.
    function test_TheSameVaultQuotedInEthBuysStocks() public {
        vm.deal(launcher, 10 ether);
        (FeeVault v, Distributor d) = _vault(launcher);

        address token = _try(address(0), address(v), "ETHOK", bytes32(uint256(0x423)));
        require(token != address(0), "fixture");
        v.bind(token);
        assertEq(address(v.token()), token, "an ETH-quoted launch binds");

        vm.deal(address(v), 1 ether);
        v.fundRewards{value: 0.5 ether}();
        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        assertGt(v.buyBasket(minOuts), 0, "and the stock path runs");
    }

    // ------------------------------------------------------------------ 4.
    //
    // **v2 — the vault follows the launch's quote instead of refusing it.**
    //
    // 40.9 % of Pons's volume is quoted in native ETH, 22.0 % in USDG and
    // 37.2 % in stock tokens (measured 2026-09-08 over seven days of
    // `V2FeeEscrow` credits). Refusing everything but ETH left three fifths of
    // the market unreachable. These tests are the contract of the change:
    // ONE quote per vault, declared at birth, and `bind` still refuses every
    // other one.

    /// @dev A real trade on the curve, so a real creator fee accrues. Past the
    ///      3 s snipe tax first — inside it the creator is credited ~70 % of
    ///      the spend and the numbers below stop meaning anything.
    function _trade(address token, address quote, uint256 amountIn) internal {
        IPonsV2BondingCurve curve = IPonsV2BondingCurve(IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token).curve);
        address buyer = makeAddr("buyer");
        deal(quote, buyer, amountIn * 10);
        vm.warp(block.timestamp + 10);
        vm.startPrank(buyer);
        IERC20(quote).approve(address(curve), type(uint256).max);
        curve.buy(amountIn, 0, buyer);
        vm.stopPrank();
    }

    /// @notice **Phase 1 — a USDG-quoted launch, end to end.** +22.0 points of
    ///         the market, and the cheapest possible path: the vault's first
    ///         hop disappears entirely, because what arrives IS the USDG the
    ///         legs spend.
    function test_AUsdgQuotedVaultHarvestsAndBuysStocks() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v, Distributor d) = _vault(launcher, USDG, 0, 10 * one);

        address token = _try(USDG, address(v), "USDGV", bytes32(uint256(0x501)));
        require(token != address(0), "fixture: a USDG-quoted launch must be possible");
        v.bind(token);
        assertEq(address(v.token()), token, "a USDG-quoted launch binds to a USDG vault");

        _trade(token, USDG, 1_000 * one);

        uint256 gross = v.harvest();
        assertGt(gross, 0, "harvest must reach the ERC-20 ledger");
        assertGt(v.rewardsPool(), 0, "and credit the holders' share");

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        assertGt(v.buyBasket(minOuts), 0, "and the stock path runs on USDG alone");
        assertGt(IERC20(NVDA).balanceOf(address(d)), 0, "stocks land on the Distributor");
    }

    /// @notice **Phase 2 — a launch quoted in a STOCK.** +37.2 points, and the
    ///         one that writes itself: a vault that buys stocks for holders of
    ///         a token already priced in stocks.
    function test_AStockQuotedVaultHarvestsAndBuysStocks() public {
        vm.deal(launcher, 10 ether);
        (FeeVault v, Distributor d) = _vault(launcher, NVDA, 500, 0.05 ether);

        address token = _try(NVDA, address(v), "NVDAV", bytes32(uint256(0x502)));
        require(token != address(0), "fixture: a stock-quoted launch must be possible");
        v.bind(token);

        _trade(token, NVDA, 10 ether); // 10 raw NVDA units, 18 decimals

        assertGt(v.harvest(), 0, "harvest claims the NVDA ledger");

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        assertGt(v.buyBasket(minOuts), 0, "NVDA -> USDG -> basket");
        assertGt(IERC20(QQQ).balanceOf(address(d)), 0, "stocks land on the Distributor");
    }

    /// @notice **One quote per vault, and `bind` is where that is enforced.**
    ///         The v1 guard refused everything but ETH; the v2 guard refuses
    ///         everything but the vault's OWN quote — which is the same
    ///         sentence for an ETH vault and a stronger one for the others.
    function test_AQuotedVaultRefusesEveryOtherPair() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v,) = _vault(launcher, USDG, 0, 10 * one);

        address ethToken = _try(address(0), address(v), "WRONG", bytes32(uint256(0x503)));
        require(ethToken != address(0), "fixture");
        vm.expectRevert(abi.encodeWithSelector(FeeVault.UnsupportedPair.selector, address(0)));
        v.bind(ethToken);

        (FeeVault w,) = _vault(launcher, NVDA, 500, 0.05 ether);
        address usdgToken = _try(USDG, address(w), "WRONG2", bytes32(uint256(0x504)));
        require(usdgToken != address(0), "fixture");
        vm.expectRevert(abi.encodeWithSelector(FeeVault.UnsupportedPair.selector, USDG));
        w.bind(usdgToken);
    }

    /// @notice **A non-ETH vault pays its own harvest, in its own currency.**
    ///
    /// @dev    This test used to assert the opposite, and the reason it did is
    ///         still true: `_refundAmount` computes WEI, and a vault holding
    ///         USDG has none. What changed is that the refund stopped being
    ///         priced in gas. `keeperBountyBps` pays a share of what the call
    ///         MOVED, which is already denominated in `QUOTE` — so no oracle
    ///         enters the money path, and the caller is paid in USDG.
    ///
    ///         On `harvest` the bounty is the residue cap itself: 50 bps of the
    ///         creator's own residue, the same ceiling the ether path has
    ///         always had. Three things must therefore hold at once — the
    ///         caller is paid, the HOLDERS are not the ones paying, and not a
    ///         single wei moves.
    function test_ANonEthVaultPaysItsHarvestBountyInItsOwnCurrency() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v, Distributor d) = _vault(launcher, USDG, 0, 10 * one);

        address token = _try(USDG, address(v), "USDGG", bytes32(uint256(0x505)));
        require(token != address(0), "fixture");
        v.bind(token);
        _trade(token, USDG, 1_000 * one);

        uint256 wei0 = keeper.balance;
        uint256 usdg0 = IERC20(USDG).balanceOf(keeper);
        vm.prank(keeper);
        uint256 gross = v.harvest();

        uint256 paid = IERC20(USDG).balanceOf(keeper) - usdg0;
        assertGt(paid, 0, "the caller is paid, and in the vault's own currency");
        assertEq(keeper.balance, wei0, "and not a wei moves: there is none to move");

        // Two ceilings meet here and the tighter one must win: the bounty is
        // `keeperBountyBps` of the GROSS, the cap is 50 bps of the RESIDUE, and
        // the residue is a small fraction of the gross — so on any ordinary
        // split it is the cap that binds, and the creator's guard holds.
        uint256 residue = v.creatorPool() + paid;
        uint256 cap = (residue * v.HARVEST_REFUND_BPS()) / 10_000;
        uint256 rate = (gross * v.keeperBountyBps()) / 10_000;
        assertEq(paid, cap < rate ? cap : rate, "the tighter of the two ceilings");
        assertLt(cap, rate, "and on this split it is the creator's cap that binds");

        // The two things the bounty must NOT touch.
        assertEq(v.rewardsPool(), (gross * v.rewardsBps()) / 10_000, "rewards keep their whole share");
        assertEq(IERC20(USDG).balanceOf(address(d)), 0, "and no delivery budget is skimmed: it would be unspendable");
    }

    /// @notice **And its own purchase, capped at `MIN_BUY_QUOTE`.**
    ///
    /// @dev    `buyBasket`'s bounty comes out of `rewardsPool`, which is where
    ///         the ether path takes its refund from too — same pocket, same
    ///         incidence, so nothing new has to be explained to a holder.
    ///
    ///         The ceiling is what makes it safe on a large purchase: 2 % of a
    ///         big spend would be a large payment to whoever got there first,
    ///         and `MIN_BUY_QUOTE` (~$25) bounds it to the same order as
    ///         `MAX_REFUND` (0.01 ETH, ~$24) on the other path.
    /// @notice **The platform is paid in the vault's own currency, and that
    ///         branch of `_pay` had never run.**
    ///
    /// @dev    `payPlatform` was called by no test at all, and on a non-ether
    ///         vault it takes `_pay`'s OTHER arm — `_sendQuote` rather than a
    ///         `call{value:}` — which had never executed either. That matters
    ///         beyond coverage: ~59 % of Pons volume is quoted in something
    ///         other than ether, so this arm is the common case for the
    ///         platform's revenue, not the exotic one. It is also what
    ///         `Treasury.sweepToEth` and `Treasury.collectFrom` exist to
    ///         receive.
    function test_ANonEthVaultPaysThePlatformInItsOwnCurrency() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v,) = _vault(launcher, USDG, 0, 10 * one);

        address token = _try(USDG, address(v), "USDGP", bytes32(uint256(0x9a1)));
        require(token != address(0), "fixture");
        v.bind(token);
        _trade(token, USDG, 1_000 * one);
        v.harvest();

        uint256 owed = v.platformPool();
        assertGt(owed, 0, "fixture: the harvest must have set a platform share aside");
        uint256 wei0 = platform.balance;
        uint256 usdg0 = IERC20(USDG).balanceOf(platform);

        vm.prank(makeAddr("a passer-by"));
        uint256 paid = v.payPlatform();

        assertEq(paid, owed, "it pays what it had set aside");
        assertEq(IERC20(USDG).balanceOf(platform) - usdg0, owed, "in USDG, the currency the vault actually holds");
        assertEq(platform.balance, wei0, "and not a wei moves: there is none to move");
        assertEq(v.platformPool(), 0, "the pocket is emptied");
    }

    function test_ANonEthVaultPaysItsPurchaseBountyOutOfRewards() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v, Distributor d) = _vault(launcher, USDG, 0, 10 * one);

        address token = _try(USDG, address(v), "USDGB", bytes32(uint256(0x506)));
        require(token != address(0), "fixture");
        v.bind(token);
        _trade(token, USDG, 1_000 * one);
        v.harvest();

        vm.warp(d.epochEnd(0) + 1);
        uint256 pool0 = v.rewardsPool();
        uint256 usdg0 = IERC20(USDG).balanceOf(keeper);
        uint256[] memory minOuts = new uint256[](2);
        vm.prank(keeper);
        assertGt(v.buyBasket(minOuts), 0, "the purchase itself still runs");

        uint256 paid = IERC20(USDG).balanceOf(keeper) - usdg0;
        assertGt(paid, 0, "the caller is paid for the purchase too");
        assertLe(paid, v.MIN_BUY_QUOTE(), "and never more than the ceiling");

        // Spent plus bounty, both out of the same pocket.
        uint256 moved = pool0 - v.rewardsPool();
        assertGt(moved, paid, "the purchase moved more than the bounty it paid");
        assertEq(paid, (moved - paid) * v.keeperBountyBps() / 10_000, "exactly the bounty on what was spent");
    }

    /// @notice **The bounty has a ceiling the timelock cannot lift.**
    ///
    /// @dev    `distGasBps` has `MAX_DIST_GAS_BPS` so rewards cannot be
    ///         diverted into a reserve under cover of gas. This is the same
    ///         sentence, one pocket over: without the cap, reimbursing a keeper
    ///         and taxing the holders are the same function with a different
    ///         number in it. The floor matters too — set to zero, a non-ETH
    ///         vault's cycle goes straight back onto whoever runs the keeper.
    function test_TheBountyRateIsBoundedOnBothSides() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v,) = _vault(launcher, USDG, 0, 10 * one);

        assertEq(v.keeperBountyBps(), 70, "seeded at what the cycle measures, 65 bps plus basefee margin");

        // Read BEFORE arming: `expectRevert` catches the next call, and a
        // getter in the argument list is a call.
        uint256 tooMuch = v.MAX_KEEPER_BOUNTY_BPS() + 1;
        uint256 tooLittle = v.MIN_KEEPER_BOUNTY_BPS() - 1;

        vm.startPrank(v.TIMELOCK());
        vm.expectRevert(FeeVault.BadPayoutRate.selector);
        v.setKeeperBountyBps(tooMuch);
        vm.expectRevert(FeeVault.BadPayoutRate.selector);
        v.setKeeperBountyBps(tooLittle);
        v.setKeeperBountyBps(60);
        vm.stopPrank();
        assertEq(v.keeperBountyBps(), 60, "and inside the bounds it moves");

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FeeVault.NotTimelock.selector);
        v.setKeeperBountyBps(60);
    }

    /// @notice **The reserve holds the bounty back, or the smallest vaults
    ///         would be the ones paying nothing.**
    ///
    /// @dev    `buyBasket` used to hold back `MAX_REFUND` on an ether vault and
    ///         nothing at all elsewhere — correct while a non-ETH vault paid
    ///         nothing. It now holds `MIN_BUY_QUOTE`, and this is what that
    ///         line buys: a vault spending its whole reserve would otherwise
    ///         pay its bounty out of what the purchase left behind, which is
    ///         zero. The caps would truncate it in silence.
    function test_TheNonEthReserveKeepsEnoughToPayItsCaller() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();
        (FeeVault v, Distributor d) = _vault(launcher, USDG, 0, 10 * one);

        address token = _try(USDG, address(v), "USDGR", bytes32(uint256(0x507)));
        require(token != address(0), "fixture");
        v.bind(token);
        _trade(token, USDG, 1_000 * one);
        v.harvest();

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        v.buyBasket(minOuts);
        assertGe(v.rewardsPool(), v.MIN_BUY_QUOTE(), "the ceiling stays behind, always");
    }

    // ------------------------------------------------------------------ 5.
    //
    // Two round trips the USDG routing imposed for no reason.

    /// @notice **A USDG line is paid without going through a pool.**
    ///
    /// @dev    Before, a USDG allocation looked for `getPool(USDG, USDG)`, found
    ///         `address(0)`, returned a null floor and its share went into
    ///         `usdgReserve` — at every purchase, forever. No revert, no error
    ///         event: a vault that looks alive and a line nobody ever receives.
    ///         That is the worst of the three possible failures, and it is the
    ///         one this test kills.
    function test_AUsdgLegIsPaidWithoutASwap() public {
        vm.deal(launcher, 10 ether);
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        // Tier 0: there is no pool to name, and this is the only case where
        // that means anything.
        basket[0] = VaultTypes.Allocation(USDG, 0, 5_000, address(0));
        basket[1] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        (FeeVault v, Distributor d) = _vault(launcher, address(0), 0, 0, basket);

        address token = _try(address(0), address(v), "STABL", bytes32(uint256(0x601)));
        require(token != address(0), "fixture");
        v.bind(token);

        vm.deal(address(v), 1 ether);
        v.fundRewards{value: 0.5 ether}();
        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        assertEq(v.buyBasket(minOuts), 2, "both legs must go through, not one");

        uint256 held = IERC20(USDG).balanceOf(address(d));
        assertGt(held, 0, "the USDG line must reach the holders");
        assertEq(d.totalFunded(USDG), held, "and be counted for what it is worth");
        assertGt(IERC20(NVDA).balanceOf(address(d)), 0, "without breaking anything on the other leg");
        // The reserve must keep nothing but rounding dust -- not half the
        // purchase, which is what it kept before.
        assertLt(v.pivotReserve(), held / 100, "usdgReserve is no longer where the USDG line lands");
    }

    /// @notice **The leg that IS the vault's currency does not make the round
    ///         trip.**
    ///
    /// @dev    An NVDA-quoted vault with NVDA in its basket converted everything
    ///         into USDG then bought NVDA back: two pool fees and two slippages
    ///         to end up in the same place. Its share is now set aside BEFORE the
    ///         hop.
    ///
    ///         The assertion is an EXACT EQUALITY, and that is what makes it
    ///         probative: no round trip through a pool can make the numbers come
    ///         out round. `spent_` is `MIN_BUY_QUOTE` here — a young vault's
    ///         reserve is below the floor — so the leg at 5 000 bps is worth
    ///         exactly half of `minBuy`.
    function test_TheQuoteLegSkipsTheRoundTrip() public {
        vm.deal(launcher, 10 ether);
        uint256 minBuy = 0.05 ether; // 0,05 unite brute de NVDA
        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(NVDA, 500, 5_000, address(0));
        basket[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
        (FeeVault v, Distributor d) = _vault(launcher, NVDA, 500, minBuy, basket);

        address token = _try(NVDA, address(v), "NVDAQ", bytes32(uint256(0x602)));
        require(token != address(0), "fixture");
        v.bind(token);
        _trade(token, NVDA, 10 ether);
        v.harvest();

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        assertEq(v.buyBasket(minOuts), 2, "both legs go through");

        assertEq(d.totalFunded(NVDA), minBuy / 2, "the NVDA leg is worth its share of the purchase, to the wei");
        assertEq(IERC20(NVDA).balanceOf(address(d)), minBuy / 2, "and it really is at the Distributor");
        assertGt(IERC20(QQQ).balanceOf(address(d)), 0, "the other leg still goes through USDG");
    }

    /// @notice **A leg that gives way no longer brings the purchase down.**
    ///
    /// @dev    The bug was two steps from here and nobody had seen it, because
    ///         nothing in the suite ever skipped a leg: `Legs` is sized for the
    ///         WHOLE basket, a skipped leg leaves its slot at zero, and
    ///         `Distributor.fundWindow` refuses a zero amount (`BadInput`). So
    ///         ONE unavailable stock reverted the purchase of the WHOLE basket --
    ///         the exact opposite of `docs/CONVENTIONS.md`'s non-negotiable rule, and of
    ///         what `_swapLeg`'s `try/catch` thought it was buying.
    ///
    ///         The caller's floor is what forces the skip here: it can only
    ///         TIGHTEN, so `type(uint256).max` makes a leg unbuyable without
    ///         touching a pool or assuming anything about the market. It is also
    ///         `_swapLeg`'s `catch` path, which had never once been executed.
    function test_AFailedLegNoLongerTakesTheBasketDown() public {
        vm.deal(launcher, 10 ether);
        (FeeVault v, Distributor d) = _vault(launcher);

        address token = _try(address(0), address(v), "SKIPL", bytes32(uint256(0x603)));
        require(token != address(0), "fixture");
        v.bind(token);

        vm.deal(address(v), 1 ether);
        v.fundRewards{value: 0.5 ether}();
        vm.warp(d.epochEnd(0) + 1);

        uint256[] memory minOuts = new uint256[](2);
        minOuts[0] = type(uint256).max; // NVDA devient inachetable

        assertEq(v.buyBasket(minOuts), 1, "the other leg goes through, and the purchase succeeds");
        assertEq(IERC20(NVDA).balanceOf(address(d)), 0, "the skipped leg delivered nothing");
        assertGt(IERC20(QQQ).balanceOf(address(d)), 0, "the one that could go through delivered");
        // Its share waits for the next purchase instead of being lost -- that is
        // half the basket, not dust.
        assertGt(v.pivotReserve(), 0, "the skipped leg's share is kept");
        assertEq(d.totalFunded(NVDA), 0, "and nothing is credited to it");
    }

    // ------------------------------------------------------------------ 6.

    /// @notice **The fallback route: a currency with no pool against the pivot,
    ///         reached through WETH.**
    ///
    /// @dev    The pivot is not a wall, it is a crossroads -- and a crossroads can
    ///         have two entrances. COIN has NO pool at all against USDG and
    ///         $33 144 of depth against WETH; cbBTC, $158 774. Between them, 198
    ///         of the ~220 weekly credits of the pairs v2 still refused.
    ///
    ///         The detour's second hop is the WETH/PIVOT pool an ETH-quoted vault
    ///         already takes -- tier 100, $2.7 M of depth. One pool, two uses,
    ///         nothing more to measure.
    ///
    ///         This test is what separates "we wrote some routing code" from "a
    ///         token the pivot cannot see becomes a vault that buys stocks".
    function test_AQuoteWithNoPivotPoolIsReachedThroughWeth() public {
        vm.deal(launcher, 10 ether);
        // poolFee = 0, wethFee = 3000: the route is declared, not guessed.
        (FeeVault v, Distributor d) = _vault(launcher, COIN, 0, 3000, 0.14 ether, _basket());

        assertEq(v.QUOTE_FEE(), 0, "no direct route");
        assertEq(v.QUOTE_WETH_FEE(), 3000, "and the detour carries its own");

        address token = _try(COIN, address(v), "COINV", bytes32(uint256(0x701)));
        require(token != address(0), "fixture: a COIN-quoted launch must be possible");
        v.bind(token);

        _trade(token, COIN, 10 ether);
        assertGt(v.harvest(), 0, "the fees land on the COIN ledger");

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        assertGt(v.buyBasket(minOuts), 0, "COIN -> WETH -> USDG -> panier");
        assertGt(IERC20(NVDA).balanceOf(address(d)), 0, "and the stocks land with the holders");
    }

    /// @notice A currency cannot declare two routes, nor none at all.
    ///
    /// @dev    Both tiers non-zero would be the contract choosing in place of
    ///         whoever did the measuring; both zero would be a vault that gets
    ///         created, binds, and reverts `NoPool` at every purchase forever.
    ///         `init` runs only once: it is here or never.
    function test_AQuoteDeclaresExactlyOneRoute() public {
        VaultTypes.Allocation[] memory b = _basket();
        _impls();

        // Both routes at once.
        vm.expectRevert(FeeVault.BadQuote.selector);
        new Bootstrap(
            vaultImpl, distImpl, _cfg(launcher, COIN, 3000, 3000, 0.14 ether), b, keeper, block.timestamp, 30 minutes
        );

        // Neither of the two.
        vm.expectRevert(FeeVault.BadQuote.selector);
        new Bootstrap(
            vaultImpl, distImpl, _cfg(launcher, COIN, 0, 0, 0.14 ether), b, keeper, block.timestamp, 30 minutes
        );
    }

    // ------------------------------------------------- audit phase 2, 2026-09-11

    /// @notice **T-ORACLE-01 — on a non-ether vault the Chainlink tightener
    ///         actually runs, and its number is in the right units.**
    ///
    /// @dev    **ASSERTION DIRECTION.** The property that SHOULD hold, and does:
    ///         green. `AUDIT_PLAN.md` §3b calls this row *partial* —
    ///         `test_AStockQuotedVaultHarvestsAndBuysStocks` and
    ///         `test_AUsdgQuotedVaultHarvestsAndBuysStocks` run the
    ///         `_oracleOutPivot` path and neither asserts the oracle produced
    ///         anything. This closes that.
    ///
    ///         **Why the assertion is "the units are right" and not "the floor
    ///         went up".** `_legFloor:1364` takes the oracle only when it is
    ///         HIGHER than the TWAP — it tightens or it does nothing — and which
    ///         of the two happens on a given block is the market's business, not
    ///         the contract's. Asserting `oracleOut > twapOut` would be
    ///         asserting today's price. What IS the contract's business, and
    ///         what the ether-quoted mirror
    ///         (`FeeVault.t.sol::test_TheOracleFloorPricesRawUnitsNotShares`)
    ///         pins on the other path, is that the number is DENOMINATED
    ///         correctly: `_oracleOutPivot:1402-1418` scales a 6-decimal pivot
    ///         amount up to 18 and crosses it through `stockUsd x uiMultiplier`.
    ///         A units slip there does not move the floor by a few per cent, it
    ///         moves it by a factor of 1e12 — so a band around the TWAP is the
    ///         assertion that catches the failure that can actually happen.
    ///
    ///         Only the feeds' FRESHNESS is mocked, and nothing else: their real
    ///         answers are read on-chain and handed back with a current
    ///         timestamp. Equity feeds go quiet outside market hours, so without
    ///         it this test would report green all weekend without executing a
    ///         line of what it claims to cover. The swap, the pool, the curve
    ///         and the escrow are all real. Same treatment, same reason, as
    ///         `FeeVault.t.sol::test_TheOracleFloorPricesRawUnitsNotShares`.
    // T-ORACLE-01
    function test_ANonEthVaultsOracleFloorIsDenominatedInRawPivotUnits() public {
        vm.deal(launcher, 10 ether);
        uint256 one = 10 ** IDecimals(USDG).decimals();

        // A USDG-quoted vault whose basket carries a stock WITH a feed, so
        // `_oracleOutPivot` has something to read.
        VaultTypes.Allocation[] memory b = new VaultTypes.Allocation[](2);
        b[0] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        b[1] = VaultTypes.Allocation(QQQ, 500, 5_000, address(0));
        (FeeVault v, Distributor d) = _vault(launcher, USDG, 0, 10 * one, b);

        address token = _try(USDG, address(v), "ORCL1", bytes32(uint256(0x701)));
        require(token != address(0), "fixture: a USDG-quoted launch must be possible");
        v.bind(token);
        _trade(token, USDG, 5_000 * one);
        v.harvest();

        // The feed's REAL answer, handed back with a current timestamp.
        (, int256 stockUsd,,,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        assertGt(stockUsd, 0, "fixture: the NVDA feed must carry a price");
        vm.mockCall(
            NVDA_FEED,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(uint80(1), stockUsd, block.timestamp, block.timestamp, uint80(1))
        );

        vm.warp(d.epochEnd(0) + 1);
        uint256[] memory minOuts = new uint256[](2);
        vm.recordLogs();
        assertGt(v.buyBasket(minOuts), 0, "the purchase must run");

        // `OracleDivergence(stock, twapOut, oracleOut)` is emitted exactly when
        // `_oracleOut*` returned non-zero. It is the only observable.
        bytes32 topic = keccak256("OracleDivergence(address,uint256,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 twapOut;
        uint256 oracleOut;
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != NVDA) continue;
            (twapOut, oracleOut) = abi.decode(logs[i].data, (uint256, uint256));
            ++seen;
        }

        assertEq(seen, 1, "the tightener must run exactly once on the leg that carries a feed");
        assertGt(oracleOut, 0, "the Chainlink branch produced no number on a non-ether vault");

        emit log_named_uint("TWAP says, raw NVDA     ", twapOut);
        emit log_named_uint("Chainlink says, raw NVDA", oracleOut);
        emit log_named_uint("ratio x10000            ", (oracleOut * 10_000) / twapOut);

        // Within 10 % of the TWAP in both directions. A units slip in
        // `_oracleOutPivot` misses by twelve orders of magnitude, not by ten per
        // cent, so this band is wide enough to survive an ordinary market and
        // narrow enough to catch the failure that matters.
        assertGt(oracleOut, (twapOut * 9_000) / 10_000, "the oracle floor is denominated in the wrong units (too low)");
        assertLt(
            oracleOut, (twapOut * 11_000) / 10_000, "the oracle floor is denominated in the wrong units (too high)"
        );

        // And the leg with no feed gets no tightener at all, in the same call.
        uint256 feedless;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) == QQQ) ++feedless;
        }
        assertEq(feedless, 0, "a line with no feed cannot tighten anything");
    }
}
