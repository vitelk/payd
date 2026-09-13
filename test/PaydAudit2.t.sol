// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

interface IV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice **`docs/AUDIT_PLAN_2.md` §4 — T2-DEPTH-01, and the registry half of
///         the role-collapse that §2 closed on the Distributor only.**
contract PaydAudit2Test is Test {
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    /// @dev The two detour quotes `script/Quotelist.s.sol:234-237` ships: no
    ///      pivot pool at all, reached `QUOTE -> WETH -> PIVOT`.
    address constant COIN = 0x6330D8C3178a418788dF01a47479c0ce7CCF450b;

    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;

    uint256 internal constant Q96 = 2 ** 96;
    /// @dev `Payd.DEPTH_K_NUM / DEPTH_K_DEN`, checked rather than assumed: the
    ///      +1 % band is `sqrt(1.01) - 1 = 0.00498756...`, i.e. 4 987 562 / 1e9.
    uint256 internal constant K_NUM = 4_987_562;
    uint256 internal constant K_DEN = 1_000_000_000;

    Payd internal pad;
    DistributionFactory internal factory = new DistributionFactory();
    address internal timelock = makeAddr("timelock");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal generationKey = makeAddr("generation key");
    address internal creator = makeAddr("creator");

    function setUp() public {
        pad = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: treasury,
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
        address[] memory s = new address[](2);
        uint24[] memory f = new uint24[](2);
        address[] memory d = new address[](2);
        (s[0], f[0], d[0]) = (QQQ, 500, QQQ_FEED);
        (s[1], f[1], d[1]) = (NVDA, 500, NVDA_FEED);
        vm.prank(timelock);
        pad.allowStocks(s, f, d);
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation({stock: QQQ, bps: 5_000, poolFee: 500, feed: QQQ_FEED});
        a[1] = VaultTypes.Allocation({stock: NVDA, bps: 5_000, poolFee: 500, feed: NVDA_FEED});
    }

    // ---- the registry half of the role collapse ----------------------------

    /// @notice **`docs/AUDIT_PLAN_2.md` §2 closed the role collapse on
    ///         `Distributor`, on both sides. This is the same mistake one level
    ///         up, where nothing refuses it.**
    ///
    ///         Property asserted: naming a co-signer on the registry means the
    ///         vaults it creates are born with one. `Payd.coSigner` reading
    ///         non-zero must mean the protection is on.
    ///
    /// @dev    RED. `Payd.setCoSigner` accepts any address, including
    ///         `Payd.keeper`; `Payd.setKeeper` accepts `Payd.coSigner` the same
    ///         way. `_create` then stamps the vault with the keeper and calls
    ///         `setCoSigner` on the fresh Distributor — which refuses the
    ///         collapse, correctly. But the call is SOFT
    ///         (`contracts/Payd.sol:750-751`), and the justification written
    ///         above it is about a different failure: "a mode with no second
    ///         contract returns its own vault here and has no `setCoSigner`,
    ///         which is not an error". It swallows this one too.
    ///
    ///         So every vault created from that moment is born **single-key,
    ///         silently**: no revert, no event, `VaultCreated` as usual, and
    ///         `Payd.coSigner()` reading the co-signer's address. The operator
    ///         check `docs/LAUNCH_2026_12_09.md` §1.1 prescribes is run on the
    ///         Distributor, so it would catch this — on the vaults that existed
    ///         when it was run, and on no later one.
    ///
    ///         `rotateCoSigner` is the loud twin: it emits
    ///         `CoSignerRotationSkipped` per vault. Only the birth path is
    ///         silent, and the birth path is the one `AUDIT_FIXES.md` §3.14
    ///         added because "a per-vault call after the fact is one nobody
    ///         makes".
    function test_AVaultIsNeverBornSingleKeyWhileTheRegistryNamesACoSigner() public {
        // The mistake is now refused at the door, on both setters, the way
        // `Distributor` has always refused it on its own two.
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.RoleCollapse.selector, keeper));
        pad.setCoSigner(keeper);
        vm.stopPrank();
        assertEq(pad.coSigner(), address(0), "nothing was written");

        // And a legitimate co-signer reaches the vault at birth, which is the
        // property the soft call exists to provide and used to drop silently.
        address second = makeAddr("co-signer");
        vm.prank(timelock);
        pad.setCoSigner(second);
        (, address dist) = pad.createVault(_basket(), 7_000, 30 minutes, address(0));
        assertEq(Distributor(payable(dist)).coSigner(), second, "a vault born under a named co-signer carries it");
        assertGt(Distributor(payable(dist)).coSignerNamedAt(), 0, "and its grace is running from birth");
    }

    /// @notice **The genesis vault is born co-signed, and it is the only vault
    ///         that cannot be fixed afterwards in under 48 hours.**
    ///
    /// @dev    `Payd` mints the platform's own vault **inside its constructor**
    ///         (`g.launcher != 0`), so there is no moment between "the registry
    ///         exists" and "the first vault exists" in which a governance call
    ///         could run. `setCoSigner` is `onlyTimelock` and `Timelock.MIN_DELAY`
    ///         is 48 h, and it reaches no vault already minted — that takes
    ///         `rotateCoSigner`, another timelock call. So without the `Wiring`
    ///         field this asserts, the platform's own Distributor is single-key
    ///         for two days: the window in which the keeper risk has no answer
    ///         at all.
    ///
    ///         What makes this cheap is that the path was already proven — the
    ///         soft stamp in `_create` works from the constructor because
    ///         `Distributor.setCoSigner` accepts `_registry()`, and during the
    ///         constructor `address(this)` is already the final address.
    function test_TheGenesisVaultIsBornWithTheRegistrysCoSigner() public {
        address second = makeAddr("genesis co-signer");
        Payd born = _withGenesis(second);

        address dist = Distributor(payable(born.platformDistributor())).coSigner() == address(0)
            ? address(0)
            : born.platformDistributor();
        assertTrue(born.platformVault() != address(0), "fixture: the genesis vault exists");
        assertEq(born.coSigner(), second, "the registry carries it");
        assertEq(Distributor(payable(born.platformDistributor())).coSigner(), second, "and so does the first vault");
        assertTrue(dist != address(0), "at the first block, with no timelock operation in between");
        assertTrue(
            Distributor(payable(born.platformDistributor())).coSignerRequired(),
            "and the requirement is in force from birth"
        );
    }

    /// @notice The collapse is refused at CONSTRUCTION too, not only on the two
    ///         setters. A registry deployed with one address in both roles would
    ///         mint a genesis vault that no later guard can reach.
    function test_TheRegistryCannotBeDeployedWithOneAddressInBothRoles() public {
        // **Every argument is resolved BEFORE the cheatcode is armed.** The
        // helper below does a `new DistributionFactory()`, and a CREATE consumes
        // `vm.expectRevert` exactly as a call does — the test would then report
        // "did not revert" about a line that reverts perfectly well
        // (`test/CheatcodeOrder.t.sol`). Third time this trap has fired in this
        // repository, which is why it is written out here rather than avoided.
        Payd.Wiring memory w = Payd.Wiring({
            timelock: timelock,
            platform: treasury,
            keeper: keeper,
            coSigner: keeper,
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
        });
        Payd.Seed memory seed = Payd.Seed(
            _stockSeed(), _feeSeed(), _feedSeed(), new address[](0), new uint24[](0), new uint24[](0), new uint256[](0)
        );
        Payd.Genesis memory g = Payd.Genesis(creator, 7_000, 30 minutes, _basket());

        vm.expectRevert(abi.encodeWithSelector(Payd.RoleCollapse.selector, keeper));
        new Payd(w, 1_000, seed, g);
    }

    /// @dev A registry that mints its genesis vault, with `who` as the co-signer.
    function _withGenesis(address who) internal returns (Payd) {
        VaultTypes.Allocation[] memory basket = _basket();
        return new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: treasury,
                keeper: keeper,
                coSigner: who,
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
                _stockSeed(),
                _feeSeed(),
                _feedSeed(),
                new address[](0),
                new uint24[](0),
                new uint24[](0),
                new uint256[](0)
            ),
            Payd.Genesis(creator, 7_000, 30 minutes, basket)
        );
    }

    function _stockSeed() internal pure returns (address[] memory a) {
        a = new address[](2);
        (a[0], a[1]) = (QQQ, NVDA);
    }

    function _feeSeed() internal pure returns (uint24[] memory a) {
        a = new uint24[](2);
        (a[0], a[1]) = (500, 500);
    }

    function _feedSeed() internal pure returns (address[] memory a) {
        a = new address[](2);
        (a[0], a[1]) = (QQQ_FEED, NVDA_FEED);
    }

    /// @notice **A vault that cannot take the stamp is not born.**
    ///
    /// @dev    This asserted the opposite until 2026-09-12: the vault was
    ///         created and `CoSignerStampSkipped` was emitted, on the argument
    ///         that a mode whose second contract has no `setCoSigner` must not
    ///         be stopped. That mode never reached the line — `ModeFactory`
    ///         returns its own vault as `distributor` and `_create` excludes
    ///         that before the call — so the softness only ever covered the
    ///         dangerous half: a vault born SINGLE-KEY while `Payd.coSigner()`
    ///         reads as set. An event made that observable and nothing
    ///         subscribed; reverting makes it unreachable.
    function test_AVaultThatCannotTakeTheStampIsNotBorn() public {
        address second = makeAddr("co-signer");
        vm.prank(timelock);
        pad.setCoSigner(second);

        // A factory whose "distributor" has no `setCoSigner` — our own code, at
        // the address the registry genuinely receives from the factory.
        NoCoSignerFactory f = new NoCoSignerFactory();
        vm.prank(generationKey);
        pad.approve(address(f), true);
        vm.prank(timelock);
        pad.enableFactory(address(f));

        uint256 before = pad.vaultCount();
        vm.expectRevert();
        pad.createVaultWith(address(f), _basket(), 7_000, 30 minutes, address(0), address(0), "");
        assertEq(pad.vaultCount(), before, "and nothing was registered on the way out");
    }

    /// @dev The positive control for the test above: with NO co-signer named,
    ///      the very same factory still builds. The revert has to be about the
    ///      second key that could not be stamped, not about the factory being
    ///      unusual — otherwise the guard reads as a ban on a whole mode.
    function test_ControlTheSameFactoryBuildsWhenNoCoSignerIsNamed() public {
        assertEq(pad.coSigner(), address(0), "fixture: this registry names none");

        NoCoSignerFactory f = new NoCoSignerFactory();
        vm.prank(generationKey);
        pad.approve(address(f), true);
        vm.prank(timelock);
        pad.enableFactory(address(f));

        (address vault, address dist) =
            pad.createVaultWith(address(f), _basket(), 7_000, 30 minutes, address(0), address(0), "");
        assertTrue(vault != address(0) && dist != address(0), "nothing to stamp, nothing to refuse");
        assertTrue(pad.isVault(vault), "and it is registered");
    }

    /// @notice The same from the other side, and it is the likelier operator
    ///         error of the two: rotating the keeper onto the address that is
    ///         already the co-signer.
    ///
    /// @dev    RED, same line. `Payd.setKeeper` checks only `address(0)`.
    function test_TheRegistryRefusesToRotateTheKeeperOntoItsOwnCoSigner() public {
        address second = makeAddr("co-signer");
        vm.startPrank(timelock);
        pad.setCoSigner(second);
        vm.expectRevert(abi.encodeWithSelector(Payd.RoleCollapse.selector, second));
        pad.setKeeper(second);
        vm.stopPrank();
        assertEq(pad.keeper(), keeper, "the hot key did not move onto the second one");
    }

    // ---- T2-CAP-01 ---------------------------------------------------------

    /// @notice **`MIN_BUY_QUOTE` is the floor AND, times forty, the ceiling.**
    ///         `FeeVault.MAX_BUY_MULTIPLE` is what makes `FLOWS.md` §7.e's bound
    ///         hold "against anyone", and it is expressed entirely in a number
    ///         the timelock types into `allowQuotes`.
    ///
    ///         Property asserted: a listing cannot set `minBuy` far from the
    ///         ~$25 the whole calibration rests on.
    ///
    /// @dev    RED. `Payd._allowQuotes` checks `minBuys[i] == 0` and nothing
    ///         else (`contracts/Payd.sol:878`). Every other field of a listing
    ///         is measured against the chain — `_requirePool`, `MIN_ROUTE_DEPTH`,
    ///         `_requireSweepable` — and this one, which prices both ends of
    ///         every purchase the vault will ever make, is taken on trust.
    ///
    ///         The consequence is multiplicative and one-way. `MIN_BUY_QUOTE` is
    ///         stamped at birth (`FeeVault.init` copies it out of the listing)
    ///         and `removeQuotes` reaches no vault already minted, exactly as
    ///         T-QUOTE-01. USDG is a dollar token with six decimals, so the row
    ///         `script/Quotelist.s.sol` would ship is `25_000_000`; the fixture
    ///         below lists `25_000_000_000` — three zeros, the shape of a real
    ///         typo — and the cap goes from $1 000 to $1 000 000. At that
    ///         ceiling the bound §7.e measures at ~34 bps of impact is the
    ///         278 bps case it was added to remove, and the floor moves with it:
    ///         nothing buys until the reserve clears $25 000.
    ///
    ///         Medium, like its two siblings: the timelock, 48 h announced, and
    ///         no attacker. What makes it worth a row is that the number has no
    ///         plausible range written anywhere in the contract, while the two
    ///         listings beside it do.
    /// @notice **T2-CAP-01 — ACCEPTED, and the bound is stated rather than
    ///         asserted away.** `minBuy` is the one field of a listing that is
    ///         not measured against the chain, and `FeeVault.MAX_BUY_MULTIPLE`
    ///         turns it into both the floor and the ceiling of every purchase
    ///         the vault will ever make.
    ///
    /// @dev    **Not fixed on-chain, and the reason is that there is no price to
    ///         fix it against.** `MIN_ROUTE_DEPTH`'s rule — the contract refuses
    ///         the typo, the policy stays off-chain — inverts here: the contract
    ///         cannot see this typo, because `minBuy` is denominated in the
    ///         quote's own units and nothing on this path knows what one is
    ///         worth. Putting an oracle on `allowQuotes` to catch a timelock
    ///         typo is a worse trade than the typo.
    ///
    ///         So the band is enforced where it can be measured — `script/`
    ///         and the launch checklist — and what is pinned here is the
    ///         MULTIPLICATION, so the consequence is a number somebody can read:
    ///         three extra zeros on the shipped row take one purchase from
    ///         ~$1 000 to ~$1 000 000, which is `FLOWS.md` §7.e's 278 bps case
    ///         restored.
    function test_AMisListedMinBuyScalesBothEndsOfEveryPurchase() public {
        uint256 intended = 25_000_000; // what `script/Quotelist.s.sol` ships for USDG, ~$25
        uint256 fatFingered = intended * 1_000;

        address[] memory q = new address[](1);
        uint24[] memory pf = new uint24[](1);
        uint24[] memory wf = new uint24[](1);
        uint256[] memory mb = new uint256[](1);
        (q[0], pf[0], wf[0], mb[0]) = (USDG, 0, 0, fatFingered);
        vm.prank(timelock);
        pad.allowQuotes(q, pf, wf, mb);

        (,, uint256 minBuy,) = pad.quoteListing(USDG);
        uint256 multiple = 40; // FeeVault.MAX_BUY_MULTIPLE
        console.log("minBuy listed, raw USDG     :", minBuy);
        console.log("purchase cap it implies     :", minBuy * multiple);
        console.log("the cap the design intends  :", intended * multiple);
        console.log("factor                      :", (minBuy * multiple) / (intended * multiple));

        // 1. The registry takes it, and this is the accepted part.
        assertEq(minBuy, fatFingered, "allowQuotes measures every field of a listing except this one");
        // 2. Both ends move together, which is why it is worth a row at all: the
        //    floor strands the vault until the reserve clears $25 000 and the
        //    ceiling stops binding at the same moment.
        assertEq((minBuy * multiple) / (intended * multiple), 1_000, "floor and ceiling scale together, 1 000x");
    }

    // ---- T2-DEPTH-01 -------------------------------------------------------

    /// @notice `Payd._routeDepth` says of the detour: "**a pool moved far enough
    ///         to flatter this number is a pool that fails it on the other
    ///         side**" (`contracts/Payd.sol:1018-1024`).
    ///
    ///         Property asserted: the two hops of a detour move in OPPOSITE
    ///         directions with the pivot pool's price, so `min(hopOne, hopTwo)`
    ///         cannot be inflated by moving that one pool.
    ///
    /// @dev    RED, and it is arithmetic rather than an attack. Read off the
    ///         live `WETH/USDG` pool at the pinned block:
    ///
    ///           hopOne = depth(quote/WETH, WETH side) x pivotSide / wethSide
    ///           hopTwo = depth(ethPool, PIVOT side)
    ///
    ///         `pivotSide / wethSide` is the pool's price, and `pivotSide` is
    ///         one of the two terms of it — so both hops are monotone in the
    ///         same direction in `sqrtP`. Whichever way the pool is pushed, the
    ///         minimum moves that way too. What actually defends the bar is
    ///         economics, measured in the second half of this test, not the
    ///         cancellation the comment claims.
    function test_BothHopsOfADetourMoveWithThePivotPoolAndTheBarHoldsOnCost() public {
        address ethPool = IV3Factory(V3_FACTORY).getPool(WETH, USDG, 100);
        address coinPool = IV3Factory(V3_FACTORY).getPool(COIN, WETH, 3000);
        assertTrue(ethPool != address(0) && coinPool != address(0), "fixture: both hops exist");

        (uint160 sqrtP,,,,,,) = IPool(ethPool).slot0();
        uint256 liq = IPool(ethPool).liquidity();

        uint256 base = _routeDepth(coinPool, sqrtP, liq);
        uint256 up = _routeDepth(coinPool, uint160((uint256(sqrtP) * 110) / 100), liq);
        uint256 down = _routeDepth(coinPool, uint160((uint256(sqrtP) * 90) / 100), liq);

        console.log("route depth at the live price, raw USDG :", base);
        console.log("  with sqrtP +10 %                      :", up);
        console.log("  with sqrtP -10 %                      :", down);
        console.log("MIN_ROUTE_DEPTH, raw USDG               :", pad.MIN_ROUTE_DEPTH());

        // 1. The measurement is MONOTONE in the pivot pool's price. `hopOne` is
        //    proportional to `pivotSide / wethSide` and `hopTwo` to `pivotSide`,
        //    so both terms move the same way and so does their minimum. The
        //    comment claiming one hop fails when the other is flattered is
        //    corrected rather than the code (there is nothing wrong with the
        //    code — the cancellation was never what held the bar).
        assertGt(up, base, "pushing the pivot pool up raises BOTH hops");
        assertLt(down, base, "and pushing it down lowers both");

        // 2. What holds the bar is the distance. Pinned so a thinning of the
        //    shared hop is read here rather than discovered at a listing.
        assertGt(base, pad.MIN_ROUTE_DEPTH() * 10, "the live detour clears the bar by an order of magnitude");
    }

    /// @notice The companion, and it is what actually holds the bar: the cost.
    ///         GREEN.
    ///
    /// @dev    The bar is $500 on the thinnest hop and the shared `WETH/USDG`
    ///         hop is three orders of magnitude deeper, so the factor a
    ///         manipulator would need on a sub-bar route is printed here rather
    ///         than asserted from a table. `allowQuotes` is the timelock's, 48 h
    ///         announced, so an attacker would also have to hold the price
    ///         across a scheduled execution.
    function test_TheSharedPivotHopIsOrdersOfMagnitudeAboveTheBar() public view {
        address ethPool = IV3Factory(V3_FACTORY).getPool(WETH, USDG, 100);
        (uint160 sqrtP,,,,,,) = IPool(ethPool).slot0();
        uint256 liq = IPool(ethPool).liquidity();
        uint256 hopTwo = FullMath.mulDiv(_side(sqrtP, liq, USDG < WETH), K_NUM, K_DEN);
        console.log("WETH/USDG tier 100, PIVOT-side depth +1 %, raw USDG :", hopTwo);
        console.log("MIN_ROUTE_DEPTH, raw USDG                          :", pad.MIN_ROUTE_DEPTH());
        assertGt(hopTwo, pad.MIN_ROUTE_DEPTH() * 100, "the shared hop clears the bar by two orders of magnitude");
    }

    /// @dev `Payd._routeDepth`'s detour arm, reimplemented against a chosen
    ///      `sqrtP` on the pivot pool. Not a copy for its own sake: the point is
    ///      to vary the one input the contract reads live.
    function _routeDepth(address firstHop, uint160 sqrtP, uint256 liq) internal view returns (uint256) {
        uint256 pivotSide = _side(sqrtP, liq, USDG < WETH);
        uint256 wethSide = _side(sqrtP, liq, WETH < USDG);
        if (wethSide == 0) return 0;

        (uint160 p1,,,,,,) = IPool(firstHop).slot0();
        uint256 l1 = IPool(firstHop).liquidity();
        uint256 firstWeth = FullMath.mulDiv(_side(p1, l1, WETH < COIN), K_NUM, K_DEN);

        uint256 hopOne = FullMath.mulDiv(firstWeth, pivotSide, wethSide);
        uint256 hopTwo = FullMath.mulDiv(pivotSide, K_NUM, K_DEN);
        return hopOne < hopTwo ? hopOne : hopTwo;
    }

    /// @dev One side of a pool's active liquidity. `isToken0` decides which of
    ///      the two formulas Uniswap's address ordering selects.
    function _side(uint160 sqrtP, uint256 liq, bool isToken0) internal pure returns (uint256) {
        if (sqrtP == 0 || liq == 0) return 0;
        return isToken0 ? FullMath.mulDiv(liq, Q96, sqrtP) : FullMath.mulDiv(liq, sqrtP, Q96);
    }
}

/// @dev A factory whose second contract has no `setCoSigner` — the legitimate
///      reason `Payd._create`'s stamp is a soft call. Our own code, returned to
///      the registry the way a real factory returns its pair.
contract NoCoSignerFactory {
    bytes32 public constant MODE = "no-cosigner";

    function create(VaultTypes.Config memory, VaultTypes.Allocation[] memory, address, uint256, uint256, bytes memory)
        external
        returns (address vault, address distributor)
    {
        vault = address(new Deaf());
        distributor = address(new Deaf());
    }
}

/// @dev Answers nothing and reverts on everything, which is what a second
///      contract of another mode looks like to `setCoSigner(address)`.
contract Deaf {
    fallback() external payable {
        revert("no");
    }
}
