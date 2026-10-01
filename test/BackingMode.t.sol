// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/distribution/DistributionFactory.sol";
import {FeeVaultV2} from "../contracts/distribution/v2/FeeVaultV2.sol";
import {BackingRedeemer} from "../contracts/backing/BackingRedeemer.sol";
import {BackingFactory} from "../contracts/backing/BackingFactory.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {IERC20, IPonsV2LaunchFactory, IPonsV2BondingCurve} from "../contracts/interfaces/IExternal.sol";
import {IPonsLaunch} from "./Launch.t.sol";

interface IBurnableToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @dev A stock that is DOWN: `redeem` prices it (the constant balance) and
///      then fails to move it. Etched over a real stock's address — our code,
///      at an address the basket genuinely names, exactly the sanctioned use.
contract PausedStock {
    function balanceOf(address) external pure returns (uint256) {
        return 1e18;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("paused");
    }
}

/// @dev The same stock, back up.
contract RevivedStock {
    function balanceOf(address) external pure returns (uint256) {
        return 1e18;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// @notice **The "backing" mode, end to end against real Pons state.** The
///         vault is a plain `FeeVaultV2` clone — the mode changes where the
///         stocks go, never how they are bought — and the `BackingRedeemer`
///         holds them until a holder burns launch tokens to take their
///         pro-rata. No keeper, no root: the token is the claim ticket.
///
/// @dev    Nothing is mocked: real Pons factory, real escrow, real curve, real
///         USDG/NVDA/QQQ pools. The two `vm.etch` fixtures put OUR code at a
///         stock's address to simulate the one thing a fork cannot produce on
///         demand — a Robinhood pause — and only after every real purchase in
///         that test is done.
contract BackingModeTest is Test {
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

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant EPOCH_LENGTH = 30 minutes;

    Payd pad;
    BackingFactory backingFactory;

    address timelock = makeAddr("timelock");
    address generationKey = makeAddr("generation key");
    address treasury = makeAddr("platform");
    address keeper = makeAddr("keeper");
    address launcher = makeAddr("launcher");
    address holder = makeAddr("holder");

    function setUp() public {
        pad = _newPad(address(0));
        backingFactory = new BackingFactory(address(new FeeVaultV2()), address(new BackingRedeemer()));
    }

    // ---- fixtures ----------------------------------------------------------

    function _newPad(address coSigner) internal returns (Payd p) {
        p = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: treasury,
                keeper: keeper,
                coSigner: coSigner,
                escrow: ESCROW,
                ponsFactory: PONS_FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: 100,
                ethUsdFeed: ETH_USD,
                generationKey: generationKey,
                factory: address(new DistributionFactory())
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
        p.allowStocks(s, f, d);
    }

    /// @dev The two keys, in the order `script/DeployMode.s.sol` uses them.
    function _enable(Payd p, address f_) internal {
        vm.prank(generationKey);
        p.approve(f_, true);
        vm.prank(timelock);
        p.enableFactory(f_);
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
        a[1] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);
    }

    /// @dev A backing vault born through the registry, quoted in native ETH.
    function _backingVault(Payd p) internal returns (FeeVaultV2 vault, BackingRedeemer redeemer) {
        _enable(p, address(backingFactory));
        vm.prank(launcher);
        (address v,) =
            p.createVaultWith(address(backingFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), "");
        vault = FeeVaultV2(payable(v));
        redeemer = BackingRedeemer(payable(vault.DISTRIBUTOR()));
    }

    /// @dev A real ETH-quoted Pons launch naming `recipient`. `launchFee()` is
    ///      read BEFORE the prank — inside `{value: ...}` it is still a CALL
    ///      and the prank would attach to it (`test/ModeVault.t.sol`).
    function _launch(address recipient, string memory sym, bytes32 salt) internal returns (address) {
        IPonsLaunch f = IPonsLaunch(PONS_FACTORY);
        bytes32 eco = f.previewLaunchEconomics(0, address(0));
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
        (address t,) = f.launchToken{value: fee}(p, 0, address(0));
        return t;
    }

    /// @dev A real trade on the real curve, in native ETH, past the 3 s snipe
    ///      tax. `holder` keeps the tokens — they are the redemption fixture.
    function _trade(address token, uint256 amountIn) internal {
        IPonsV2BondingCurve curve =
            IPonsV2BondingCurve(IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(token).curve);
        vm.deal(holder, amountIn * 2);
        vm.warp(block.timestamp + 10);
        vm.prank(holder);
        curve.buy{value: amountIn}(amountIn, 0, holder);
    }

    /// @dev The whole cycle: launch, trade, harvest, buy — the redeemer ends
    ///      up holding both stocks and `holder` ends up holding tokens.
    function _fundedCycle(bytes32 salt) internal returns (FeeVaultV2 vault, BackingRedeemer redeemer, address token) {
        (vault, redeemer) = _backingVault(pad);

        vm.deal(launcher, 10 ether);
        token = _launch(address(vault), "BACK", salt);
        require(token != address(0), "fixture: an ETH-quoted launch must be possible");
        vault.bind(token);
        _trade(token, 1 ether);

        uint256 gross = vault.harvest();
        assertGt(gross, 0, "fixture: the trade must leave a real fee to harvest");

        // A reserve worth buying with, on top of the harvested fee: the
        // purchase math is pinned elsewhere, this file needs stocks to land.
        vm.deal(address(this), 2 ether);
        vault.fundRewards{value: 1 ether}();
        vm.warp(block.timestamp + 2 * EPOCH_LENGTH + 1);
        vault.buyBasket(new uint256[](2));
    }

    // ---- admission and wiring ----------------------------------------------

    function test_TheFactoryIsAdmittedAndBuildsAWiredPair() public {
        (FeeVaultV2 vault, BackingRedeemer redeemer) = _backingVault(pad);

        assertTrue(pad.isVault(address(vault)), "the vault is in the registry");
        assertEq(pad.modeOf(address(vault)), bytes32("backing"), "stamped with its factory's mode");
        assertEq(redeemer.FEE_VAULT(), address(vault), "the redeemer answers to its vault");
        assertEq(vault.DISTRIBUTOR(), address(redeemer), "and the vault funds the redeemer");
        assertEq(redeemer.TIMELOCK(), timelock, "under the same timelock");
        assertEq(vault.LEGS(), address(0), "a backing vault has no legs");
        assertEq(redeemer.allStocks().length, 0, "and nothing funded at birth");
    }

    function test_ModeDataIsRefusedAtTheDoor() public {
        _enable(pad, address(backingFactory));
        vm.prank(launcher);
        vm.expectRevert(BackingFactory.UnexpectedModeData.selector);
        pad.createVaultWith(
            address(backingFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), hex"deadbeef"
        );
    }

    /// @notice The registry's hard co-signer stamp lands on the redeemer even
    ///         though nothing here publishes: the invariant is "every second
    ///         contract remembers the second key", and a factory whose second
    ///         contract cannot take it does not mint (`Payd._create`).
    function test_TheCoSignerStampLandsOnTheRedeemer() public {
        address coSigner = makeAddr("co-signer");
        Payd p2 = _newPad(coSigner);
        (, BackingRedeemer redeemer) = _backingVault(p2);
        assertEq(redeemer.coSigner(), coSigner, "stamped at birth, no CoSignerStampFailed");
    }

    function test_FundWindowTakesOnlyTheVault() public {
        (, BackingRedeemer redeemer) = _backingVault(pad);
        address[] memory s = new address[](1);
        s[0] = NVDA;
        uint256[] memory a = new uint256[](1);
        a[0] = 1;
        vm.expectRevert(BackingRedeemer.NotFeeVault.selector);
        redeemer.fundWindow(0, s, a, a);
    }

    // ---- the cycle ---------------------------------------------------------

    function test_ABasketPurchaseLandsOnTheRedeemerAndStays() public {
        (, BackingRedeemer redeemer,) = _fundedCycle(bytes32(uint256(0xB001)));

        assertGt(redeemer.nextEpoch(), 0, "the window was funded");
        address[] memory stocks = redeemer.allStocks();
        assertEq(stocks.length, 2, "both legs ever funded");
        for (uint256 i; i < stocks.length; ++i) {
            uint256 held = IERC20(stocks[i]).balanceOf(address(redeemer));
            assertGt(held, 0, "the stocks land on the redeemer");
            assertEq(held, redeemer.totalFunded(stocks[i]), "and the ledger matches the balance exactly");
        }
    }

    /// @notice **The mode's one sentence: burn the token, take the slice.**
    ///         Exact pro-rata against the pre-burn supply, both legs, one
    ///         transaction, nothing published in between.
    function test_ABurnRedeemsTheProRataOfEveryStockHeld() public {
        (, BackingRedeemer redeemer, address token) = _fundedCycle(bytes32(uint256(0xB002)));

        uint256 bal = IERC20(token).balanceOf(holder);
        assertGt(bal, 0, "fixture: the trader holds tokens");
        uint256 amount = bal / 2;
        uint256 supply = IBurnableToken(token).totalSupply() - IBurnableToken(token).balanceOf(DEAD);

        (address[] memory stocks, uint256[] memory preview) = redeemer.redeemPreview(amount);

        vm.startPrank(holder);
        IERC20(token).approve(address(redeemer), amount);
        redeemer.redeem(amount, preview);
        vm.stopPrank();

        for (uint256 i; i < stocks.length; ++i) {
            uint256 expected = (redeemer.totalFunded(stocks[i]) * amount) / supply;
            assertEq(preview[i], expected, "the preview is the formula");
            assertEq(IERC20(stocks[i]).balanceOf(holder), expected, "and the holder received exactly it");
        }
        assertEq(IERC20(token).balanceOf(holder), bal - amount, "the tokens left the holder");
        assertEq(
            IBurnableToken(token).totalSupply() + amount,
            supply + IBurnableToken(token).balanceOf(DEAD),
            "and left the supply: burned, not parked"
        );
    }

    /// @notice A pro-rata burn is NEUTRAL for everyone else; what ratchets the
    ///         backing per token is supply that can never redeem — `0xdead` is
    ///         struck from the denominator, so parking there is a gift to the
    ///         holders who stayed.
    function test_ADeadBalanceRatchetsTheBackingPerToken() public {
        (, BackingRedeemer redeemer, address token) = _fundedCycle(bytes32(uint256(0xB003)));

        uint256 probe = 1e18;
        (, uint256[] memory before_) = redeemer.redeemPreview(probe);

        // The balance is read BEFORE the prank: inside `transfer(...)` it is
        // still a CALL and the prank would attach to it, not the transfer —
        // the same trap as `launchFee()` in `_launch`.
        uint256 half = IERC20(token).balanceOf(holder) / 2;
        vm.prank(holder);
        IERC20(token).transfer(DEAD, half);

        (, uint256[] memory after_) = redeemer.redeemPreview(probe);
        assertGt(after_[0], before_[0], "less redeemable supply, more backing per token");
        assertGt(after_[1], before_[1], "on every leg");
    }

    function test_ARefusedMinimumCostsTheHolderNothing() public {
        (, BackingRedeemer redeemer, address token) = _fundedCycle(bytes32(uint256(0xB004)));

        uint256 bal = IERC20(token).balanceOf(holder);
        uint256 amount = bal / 2;
        (address[] memory stocks, uint256[] memory preview) = redeemer.redeemPreview(amount);
        uint256[] memory minOuts = preview;
        minOuts[0] = preview[0] + 1;

        vm.startPrank(holder);
        IERC20(token).approve(address(redeemer), amount);
        vm.expectRevert(
            abi.encodeWithSelector(BackingRedeemer.BelowMinimum.selector, stocks[0], preview[0] - 1, minOuts[0])
        );
        redeemer.redeem(amount, minOuts);
        vm.stopPrank();

        assertEq(IERC20(token).balanceOf(holder), bal, "the refusal burned nothing");
    }

    function test_TheDoorsRefuseTheEmptyAndTheMalformed() public {
        (, BackingRedeemer redeemer, address token) = _fundedCycle(bytes32(uint256(0xB005)));

        vm.expectRevert(BackingRedeemer.BadInput.selector);
        redeemer.redeem(0, new uint256[](2));

        vm.expectRevert(BackingRedeemer.BadInput.selector);
        redeemer.redeem(1e18, new uint256[](1));

        // A fresh vault has no launch yet, and the more precise refusal wins:
        // there is no token to burn before there is nothing to redeem.
        (, BackingRedeemer empty) = _backingVault(pad);
        vm.expectRevert(BackingRedeemer.NotBound.selector);
        empty.redeem(1e18, new uint256[](0));

        // Silence the unused-variable lint honestly: the token exists.
        assertTrue(token != address(0));
    }

    // ---- deferral ----------------------------------------------------------

    /// @notice A paused stock defers, never burns the entitlement — the
    ///         `Distributor._one` rule carried to the mode where the claim
    ///         ticket is already destroyed by the time the transfer runs.
    function test_APausedStockDefersAndCollectStockRetries() public {
        (, BackingRedeemer redeemer, address token) = _fundedCycle(bytes32(uint256(0xB006)));

        // NVDA goes down AFTER every real purchase in this test is done. Our
        // code, at the address the basket names.
        vm.etch(NVDA, address(new PausedStock()).code);

        uint256 amount = IERC20(token).balanceOf(holder) / 2;
        uint256 supply = IBurnableToken(token).totalSupply() - IBurnableToken(token).balanceOf(DEAD);
        uint256 expected = (1e18 * amount) / supply; // the etched pot is a constant 1e18

        vm.startPrank(holder);
        IERC20(token).approve(address(redeemer), amount);
        redeemer.redeem(amount, new uint256[](2));
        vm.stopPrank();

        assertEq(redeemer.stockPending(holder, NVDA), expected, "the NVDA leg deferred, not lost");
        assertEq(redeemer.pendingStockTotal(NVDA), expected, "and reserved out of the pot");
        assertGt(IERC20(QQQ).balanceOf(holder), 0, "the healthy leg still delivered");

        // Still paused: the retry reverts and the credit survives.
        vm.prank(holder);
        vm.expectRevert(BackingRedeemer.TransferFailed.selector);
        redeemer.collectStock(NVDA);
        assertEq(redeemer.stockPending(holder, NVDA), expected, "a failed retry keeps the entitlement");

        // Back up: the retry pays and the reservation clears.
        vm.etch(NVDA, address(new RevivedStock()).code);
        vm.prank(holder);
        uint256 collected = redeemer.collectStock(NVDA);
        assertEq(collected, expected, "the deferred leg pays in full");
        assertEq(redeemer.pendingStockTotal(NVDA), 0, "and frees its reservation");
    }

    // ---- plumbing ----------------------------------------------------------

    /// @notice The delivery budget an ETH vault's harvest skims for its
    ///         distributor has nothing to deliver here; the sweep books it
    ///         back into `rewardsPool`, where the next purchase spends it.
    function test_TheSweepReturnsTheGasBudgetToTheRewardsPool() public {
        (FeeVaultV2 vault, BackingRedeemer redeemer, address token) = _fundedCycle(bytes32(uint256(0xB007)));
        assertTrue(token != address(0));

        // A second trade and harvest, so the skim is fresh and measurable.
        _trade(token, 1 ether);
        vault.harvest();

        uint256 stray = address(redeemer).balance;
        assertGt(stray, 0, "the ETH vault's harvest skims a delivery budget to its distributor");

        uint256 poolBefore = vault.rewardsPool();
        uint256 swept = redeemer.sweepToVault();
        assertEq(swept, stray, "the sweep takes everything");
        assertEq(address(redeemer).balance, 0, "nothing lingers");
        assertEq(vault.rewardsPool(), poolBefore + stray, "booked into the rewards pool, not merely received");
    }
}
