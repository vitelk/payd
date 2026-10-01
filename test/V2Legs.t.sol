// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {V2Legs} from "../contracts/distribution/v2/V2Legs.sol";
import {IERC20, IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";
import {IPonsLaunch} from "./Launch.t.sol";

/// @notice The burn and locked-LP legs, measured against real graduated Pons
///         pools in all three quote families — and in BOTH currency orders,
///         because with a non-ETH quote the launched token lands on either
///         side of the sorted key (`docs/recon.md` §13) and the direction,
///         the limit side and the settle path all follow from it.
contract V2LegsTest is Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    /// @dev Graduated witnesses, verified on-chain 2026-09-14 (`docs/recon.md`
    ///      §13). SQUEEZE is `test/V4Swap.t.sol`'s fixture, native ETH.
    ///      USDG_TOKEN_FIRST sorts BELOW USDG (token = currency0);
    ///      USDG_QUOTE_FIRST sorts ABOVE it (USDG = currency0).
    address constant SQUEEZE = 0xD0782C1358E20FF07A4d3b420221D78F3C160485;
    address constant USDG_TOKEN_FIRST = 0x3FA8c8E5C7DcFd33d2980C71A321698b4b5eD0Ab;
    address constant USDG_QUOTE_FIRST = 0x5fee14D7c27bB494c23CE5aDa050Fb6BCf54C653;
    address constant NVDA_QUOTED = 0x002779a788B38A215062e68d8D75dc098b23c201;

    uint256 constant MIN_MOVE_ETH = 0.005 ether;
    uint256 constant MIN_MOVE_USDG = 10e6; // 6 decimals: $10
    uint256 constant MIN_MOVE_NVDA = 0.05e18;

    /// @dev The test doubles as the vault: the legs read `token()` from their
    ///      funder, because a real vault is created before the launch exists.
    address private _boundToken;

    function token() external view returns (address) {
        return _boundToken;
    }

    function _legs(address token_, address quote, uint256 minMove, uint256 burnBps, uint256 lpBps)
        internal
        returns (V2Legs legs)
    {
        _boundToken = token_;
        legs = new V2Legs();
        legs.init(address(this), quote, PONS_FACTORY, POOL_MANAGER, minMove, burnBps, lpBps);
    }

    // ------------------------------------------------------------------ burn

    function test_ABurnLandsOnDeadAndAnchorsThePrice() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.deal(address(this), 1 ether);
        legs.fund{value: 0.05 ether}(0.05 ether);

        uint256 deadBefore = IERC20(SQUEEZE).balanceOf(DEAD);
        uint256 burned = legs.buyAndBurn();

        assertGt(burned, 0, "a burn must buy something");
        assertEq(IERC20(SQUEEZE).balanceOf(DEAD) - deadBefore, burned, "and it must land on the dead address");
        assertEq(IERC20(SQUEEZE).balanceOf(address(legs)), 0, "the legs never hold the token they burn");
        assertEq(legs.burnPool(), 0, "a full fill empties the pocket");
        assertGt(legs.lastBurnSqrtPrice(), 0, "the anchor must be written");
        assertGt(legs.lastFullBurnAt(), 0, "and a full fill stamps it");
    }

    function test_TheCooldownGatesTheBurn() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.deal(address(this), 1 ether);
        legs.fund{value: 0.1 ether}(0.1 ether);
        legs.buyAndBurn();

        legs.fund{value: 0.05 ether}(0.05 ether);
        vm.expectRevert(abi.encodeWithSelector(V2Legs.TooSoon.selector, legs.lastBurnAt() + legs.BURN_COOLDOWN()));
        legs.buyAndBurn();

        vm.warp(block.timestamp + legs.BURN_COOLDOWN());
        assertGt(legs.buyAndBurn(), 0, "after the cooldown it runs again");
    }

    function test_ABigBurnFillsPartiallyAndKeepsTheRest() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 1_000, 0);
        // Far more than a 10 % band lets through on this pool: the limit must
        // CAP the spend, never revert, and the remainder must wait its turn.
        vm.deal(address(this), 600 ether);
        legs.fund{value: 500 ether}(500 ether);

        legs.buyAndBurn();

        assertGt(legs.burnPool(), 0, "what the limit kept goes back to the pocket");
        assertEq(legs.lastFullBurnAt(), 0, "a partial fill does not stamp a full one");
        assertEq(address(legs).balance, legs.burnPool(), "and the pocket is exactly what is held");
    }

    function test_ABurnOnAUsdgPoolWhereTheTokenSortsFirst() public {
        V2Legs legs = _legs(USDG_TOKEN_FIRST, USDG, MIN_MOVE_USDG, 1_000, 0);
        deal(USDG, address(legs), 200e6);
        legs.fund(200e6);

        uint256 deadBefore = IERC20(USDG_TOKEN_FIRST).balanceOf(DEAD);
        uint256 burned = legs.buyAndBurn();

        assertGt(burned, 0, "an ERC-20-quoted burn must buy");
        assertEq(IERC20(USDG_TOKEN_FIRST).balanceOf(DEAD) - deadBefore, burned, "and land on the dead address");
        assertGt(legs.lastBurnSqrtPrice(), 0, "the anchor must be written");
    }

    function test_ABurnOnAUsdgPoolWhereTheQuoteSortsFirst() public {
        // The reversed key order: USDG is currency0, so selling the quote is
        // `zeroForOne = true` here where the sibling test runs it false — the
        // pair of them is what pins the direction logic.
        V2Legs legs = _legs(USDG_QUOTE_FIRST, USDG, MIN_MOVE_USDG, 1_000, 0);
        deal(USDG, address(legs), 200e6);
        legs.fund(200e6);

        uint256 deadBefore = IERC20(USDG_QUOTE_FIRST).balanceOf(DEAD);
        uint256 burned = legs.buyAndBurn();

        assertGt(burned, 0, "the reversed order must burn too");
        assertEq(IERC20(USDG_QUOTE_FIRST).balanceOf(DEAD) - deadBefore, burned, "on the dead address");
    }

    /// @notice **The burn does not wait for graduation.** Before the pool
    ///         exists it buys on the bonding curve, with the exact `x·y = k`
    ///         floor — a launch's very first fees already shrink its supply.
    function test_APreGraduationBurnBuysOnTheCurve() public {
        vm.deal(address(this), 5 ether);
        address tok = _launch(address(0), "V2LEGSA", bytes32(uint256(0xA1)));
        // Past the snipe tax: 99 % decaying over 3 s would put the curve's
        // real output under the normal-rate floor (recon.md §1.5).
        vm.warp(block.timestamp + 10);

        V2Legs legs = _legs(tok, address(0), MIN_MOVE_ETH, 1_000, 0);
        legs.fund{value: 0.05 ether}(0.05 ether);

        uint256 deadBefore = IERC20(tok).balanceOf(DEAD);
        uint256 burned = legs.buyAndBurn();

        assertGt(burned, 0, "a curve burn must buy");
        assertEq(IERC20(tok).balanceOf(DEAD) - deadBefore, burned, "and land on the dead address");
        assertEq(legs.burnPool(), 0, "the curve takes everything: always a full burn");
        assertGt(legs.lastFullBurnAt(), 0, "and stamped as one");
        assertEq(legs.lastBurnSqrtPrice(), 0, "no pool yet, so no anchor is written");
    }

    /// @notice **Inside the snipe-tax window the burn fails SAFE.** The 99 %
    ///         decaying tax makes the curve's real output fall under the
    ///         normal-rate floor, so the curve refuses the `minTokensOut` and
    ///         the whole call reverts — the pocket is intact and the next
    ///         cooldown retries at honest rates. The floor never learns the
    ///         snipe tax on purpose: a floor that adapted to it would BUY
    ///         through it, handing 99 % of the pocket to the creator.
    function test_ABurnInsideTheSnipeWindowRevertsAndKeepsThePocket() public {
        vm.deal(address(this), 5 ether);
        address tok = _launch(address(0), "V2LEGSC", bytes32(uint256(0xC3)));
        // No warp: we are inside the 3-second window on purpose.

        V2Legs legs = _legs(tok, address(0), MIN_MOVE_ETH, 1_000, 0);
        legs.fund{value: 0.05 ether}(0.05 ether);

        vm.expectRevert();
        legs.buyAndBurn();
        assertEq(legs.burnPool(), 0.05 ether, "a refused burn leaves the pocket exactly as it was");

        // And the same pocket burns once the window has passed.
        vm.warp(block.timestamp + 10);
        assertGt(legs.buyAndBurn(), 0, "past the window it runs at honest rates");
    }

    function test_APreGraduationBurnBuysOnTheCurveInUsdg() public {
        vm.deal(address(this), 5 ether);
        address tok = _launch(USDG, "V2LEGSB", bytes32(uint256(0xB2)));
        vm.warp(block.timestamp + 10);

        V2Legs legs = _legs(tok, USDG, MIN_MOVE_USDG, 1_000, 0);
        deal(USDG, address(legs), 200e6);
        legs.fund(200e6);

        uint256 deadBefore = IERC20(tok).balanceOf(DEAD);
        uint256 burned = legs.buyAndBurn();

        assertGt(burned, 0, "an ERC-20-quoted curve burn must buy");
        assertEq(IERC20(tok).balanceOf(DEAD) - deadBefore, burned, "on the dead address");
        assertEq(IERC20(USDG).balanceOf(address(legs)), 0, "the curve pulled the whole approval");
    }

    function test_ABurnOnAStockQuotedPool() public {
        V2Legs legs = _legs(NVDA_QUOTED, NVDA, MIN_MOVE_NVDA, 1_000, 0);
        deal(NVDA, address(legs), 1e18);
        legs.fund(1e18);

        uint256 deadBefore = IERC20(NVDA_QUOTED).balanceOf(DEAD);
        uint256 burned = legs.buyAndBurn();

        assertGt(burned, 0, "a stock-quoted burn must buy");
        assertEq(IERC20(NVDA_QUOTED).balanceOf(DEAD) - deadBefore, burned, "on the dead address");
    }

    // ------------------------------------------------------------------- LP

    function test_AddLiquidityLocksAPositionOnAnEthPool() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 0, 1_000);
        vm.deal(address(this), 2 ether);
        legs.fund{value: 1 ether}(1 ether);

        (uint256 quoteUsed, uint256 tokenUsed) = legs.addLiquidity();

        assertGt(quoteUsed, 0, "a position must consume the quote");
        assertGt(tokenUsed, 0, "and the token");
        assertGt(legs.lpLiquidity(), 0, "and the liquidity must be recorded");
        assertLt(legs.lpPool(), 1 ether, "the pocket was spent");
    }

    function test_AddLiquidityLocksAPositionOnAUsdgPool() public {
        V2Legs legs = _legs(USDG_TOKEN_FIRST, USDG, MIN_MOVE_USDG, 0, 1_000);
        deal(USDG, address(legs), 1_000e6);
        legs.fund(1_000e6);

        (uint256 quoteUsed, uint256 tokenUsed) = legs.addLiquidity();

        assertGt(quoteUsed, 0, "an ERC-20-quoted position must consume the quote");
        assertGt(tokenUsed, 0, "and the token");
        assertGt(legs.lpLiquidity(), 0, "and record the liquidity");
    }

    function test_ASecondAddCompoundsTheSameRange() public {
        V2Legs legs = _legs(USDG_QUOTE_FIRST, USDG, MIN_MOVE_USDG, 0, 1_000);
        deal(USDG, address(legs), 2_000e6);
        legs.fund(1_000e6);
        legs.addLiquidity();
        uint128 liq1 = legs.lpLiquidity();
        int24 lower1 = legs.lpLower();
        int24 upper1 = legs.lpUpper();

        legs.fund(1_000e6);
        legs.addLiquidity();

        assertGt(legs.lpLiquidity(), liq1, "the second round adds liquidity");
        assertEq(legs.lpLower(), lower1, "on the range already opened");
        assertEq(legs.lpUpper(), upper1, "never a second one");
    }

    // ------------------------------------------------------------- the guards

    function test_OnlyTheVaultFunds() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.deal(address(0xBEEF), 1 ether);
        vm.prank(address(0xBEEF));
        vm.expectRevert(V2Legs.NotVault.selector);
        legs.fund{value: 1 ether}(1 ether);
    }

    function test_AFundingMustCarryItsMoney() public {
        V2Legs ethLegs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 500, 500);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(V2Legs.BadFunding.selector);
        ethLegs.fund{value: 0.4 ether}(0.6 ether);

        V2Legs usdgLegs = _legs(USDG_TOKEN_FIRST, USDG, MIN_MOVE_USDG, 1_000, 0);
        vm.expectRevert(V2Legs.BadFunding.selector);
        usdgLegs.fund(100e6); // no transfer came first
    }

    function test_ALaunchTheFactoryNeverMadeBurnsNothing() public {
        // An address the factory never launched reads back `phase = 0` AND no
        // curve, so neither regime opens: the pocket just waits.
        V2Legs legs = _legs(address(0x1234), address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.deal(address(this), 1 ether);
        legs.fund{value: 0.05 ether}(0.05 ether);
        vm.expectRevert(V2Legs.NotGraduated.selector);
        legs.buyAndBurn();
        assertEq(legs.burnPool(), 0.05 ether, "the pocket keeps accumulating");
    }

    function test_BelowTheMinimumThePocketWaits() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.deal(address(this), 1 ether);
        legs.fund{value: 0.001 ether}(0.001 ether);
        vm.expectRevert(abi.encodeWithSelector(V2Legs.BelowMinimum.selector, 0.001 ether, MIN_MOVE_ETH));
        legs.buyAndBurn();
    }

    function test_StraysGoToTheBurnPocket() public {
        V2Legs legs = _legs(USDG_TOKEN_FIRST, USDG, MIN_MOVE_USDG, 1_000, 0);
        deal(USDG, address(legs), 55e6);
        uint256 credited = legs.fundStray();
        assertEq(credited, 55e6, "everything untracked is credited");
        assertEq(legs.burnPool(), 55e6, "to the burn pocket");

        vm.expectRevert(V2Legs.NothingToDo.selector);
        legs.fundStray();
    }

    /// @dev A real launch on the real factory, quoted in `pair` — the fee is
    ///      paid in ETH whatever the quote. The recipient is this test; the
    ///      legs never need to be the launch's fee recipient to buy its curve.
    function _launch(address pair, string memory sym, bytes32 salt) internal returns (address) {
        IPonsLaunch f = IPonsLaunch(PONS_FACTORY);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: sym,
            symbol: sym,
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(this),
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, pair),
            salt: salt
        });
        (address t,) = f.launchToken{value: f.launchFee()}(p, 0, pair);
        return t;
    }

    function test_InitRunsOnce() public {
        V2Legs legs = _legs(SQUEEZE, address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.expectRevert(V2Legs.AlreadyInit.selector);
        legs.init(address(this), address(0), PONS_FACTORY, POOL_MANAGER, MIN_MOVE_ETH, 1_000, 0);
    }

    function test_AnUnboundVaultAccumulatesToo() public {
        // Before `bind` the vault answers `token() = 0`, and the legs must
        // refuse to trade rather than cache the zero.
        V2Legs legs = _legs(address(0), address(0), MIN_MOVE_ETH, 1_000, 0);
        vm.deal(address(this), 1 ether);
        legs.fund{value: 0.05 ether}(0.05 ether);
        vm.expectRevert(V2Legs.NotGraduated.selector);
        legs.buyAndBurn();

        // The launch arrives, and the same pocket burns.
        _boundToken = SQUEEZE;
        assertGt(legs.buyAndBurn(), 0, "bound late is bound all the same");
        assertEq(legs.TOKEN(), SQUEEZE, "and the token is cached");
    }
}
