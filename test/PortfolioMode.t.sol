// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Payd} from "../contracts/Payd.sol";
import {Distributor} from "../contracts/distribution/Distributor.sol";
import {DistributionFactory} from "../contracts/distribution/DistributionFactory.sol";
import {FeeVaultV2} from "../contracts/distribution/v2/FeeVaultV2.sol";
import {V2Legs} from "../contracts/distribution/v2/V2Legs.sol";
import {DistributorV3} from "../contracts/distribution/v3/DistributorV3.sol";
import {DistributionFactoryV3} from "../contracts/distribution/v3/DistributionFactoryV3.sol";
import {PortfolioFactory} from "../contracts/portfolio/PortfolioFactory.sol";
import {PortfolioBook} from "../contracts/portfolio/PortfolioBook.sol";
import {PortfolioVault} from "../contracts/portfolio/PortfolioVault.sol";
import {BaseModeVault} from "../contracts/modes/BaseModeVault.sol";
import {PortfolioDistributor} from "../contracts/portfolio/PortfolioDistributor.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @notice **The "personal portfolio" mode, on-chain half.** The creator posts
///         a default basket; each holder may declare freely what they want to
///         be paid in, over any stock the platform allows; and each is paid in
///         theirs automatically.
///
/// @dev    The mode buys NO basket. Its vault converts the holders' share into
///         the pivot and stops, so a holder's cumulative is denominated in USDG
///         and the root says nothing about stocks; the conversion happens at
///         DELIVERY, one swap per batch of holders who want the same stock.
///         That is what removes `MAX_BASKET`'s bound of 8 against a platform
///         allowlist of ~46, and it is why the mode adds no key.
///
///         What this file proves, in order of what matters:
///
///         1. **The weight is READ, never taken from the call.** A keeper names
///            a stock and a batch; it cannot decide what anybody is paid in.
///         2. **One swap serves the whole batch** — the economic claim of
///            converting at delivery rather than per holder.
///         3. **Nothing is ever burnt.** A transfer that fails lands in
///            `pending` and `collect` hands it over later.
///         4. The book is a register: no money, no privileged function.
///
///         Nothing is mocked. `deal` writes a standard ERC-20 balance on the
///         real pivot so a window has something to fund; the swap that follows
///         goes through the REAL Uniswap router against the REAL USDG pool.
contract PortfolioModeTest is Test {
    // --- Pons v2 (docs/recon.md §1.1)
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    /// @dev `PonsV2LaunchFactory.locker()` — 8.16 % of a graduated supply, and
    ///      it can never claim. Seeded into every V3 distributor at epoch 0.
    address constant PONS_LOCKER = 0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952;
    // --- Uniswap (docs/recon.md §3.1, §3.3)
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // --- Chainlink (docs/recon.md §5)
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;
    /// @dev Allowed by the registry and NOT one of the creator's lines — which
    ///      is what makes it the right stock to prove a holder chooses freely.
    ///      No Chainlink feed, by design: the TWAP floor carries it. Tier 3000.
    address constant GLD = 0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e;

    uint256 constant EPOCH_LENGTH = 30 minutes;
    uint256 constant QUOTE_SPENT = 1 ether;

    Payd pad;
    PortfolioFactory portfolioFactory;
    DistributionFactoryV3 v3Factory;

    /// @dev The shared implementations: BOTH factories are wired to the very
    ///      same three, which is what "reused verbatim" means and what the
    ///      parity test reads.
    address vaultImpl;
    address distImpl;
    address legsImpl;

    address timelock = makeAddr("timelock");
    address generationKey = makeAddr("generation key");
    address treasury = makeAddr("platform");
    address keeper = makeAddr("keeper");
    address launcher = makeAddr("launcher");
    address seller = makeAddr("seller");
    address stayer = makeAddr("stayer");

    function setUp() public {
        vaultImpl = address(new FeeVaultV2());
        distImpl = address(new DistributorV3());
        legsImpl = address(new V2Legs());
        pad = _newPad(address(0));
        portfolioFactory = new PortfolioFactory(
            address(new PortfolioVault()), address(new PortfolioDistributor()), legsImpl, POOL_MANAGER, PONS_LOCKER
        );
        v3Factory = new DistributionFactoryV3(vaultImpl, distImpl, legsImpl, POOL_MANAGER, PONS_LOCKER);
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

        address[] memory s = new address[](3);
        uint24[] memory f = new uint24[](3);
        address[] memory d = new address[](3);
        s[0] = NVDA;
        f[0] = 500;
        d[0] = NVDA_FEED;
        s[1] = QQQ;
        f[1] = 500;
        d[1] = QQQ_FEED;
        s[2] = GLD;
        f[2] = 3_000;
        d[2] = address(0);
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

    function _vaultFrom(Payd p, address factory_, bytes memory modeData)
        internal
        returns (FeeVaultV2 vault, DistributorV3 dist)
    {
        vm.prank(launcher);
        (address v, address d) =
            p.createVaultWith(factory_, _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), modeData);
        vault = FeeVaultV2(payable(v));
        dist = DistributorV3(payable(d));
    }

    function _portfolio(Payd p) internal returns (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) {
        _enable(p, address(portfolioFactory));
        vm.prank(launcher);
        (address v, address d) =
            p.createVaultWith(address(portfolioFactory), _basket(), 7_000, EPOCH_LENGTH, address(0), address(0), "");
        vault = PortfolioVault(payable(v));
        dist = PortfolioDistributor(payable(d));
        book = PortfolioBook(portfolioFactory.bookOf(v));
    }

    /// @dev The same launch, but declaring a burn leg and a locked-LP leg —
    ///      `abi.encode(burnBps, lpBps)`, V3's and the tontine's own parameter.
    function _portfolioWithLegs(Payd p, uint256 burnBps, uint256 lpBps)
        internal
        returns (PortfolioVault vault, PortfolioDistributor dist, V2Legs legs)
    {
        _enable(p, address(portfolioFactory));
        vm.prank(launcher);
        (address v,) = p.createVaultWith(
            address(portfolioFactory),
            _basket(),
            7_000,
            EPOCH_LENGTH,
            address(0),
            address(0),
            abi.encode(burnBps, lpBps)
        );
        vault = PortfolioVault(payable(v));
        dist = PortfolioDistributor(payable(vault.DISTRIBUTOR()));
        legs = V2Legs(payable(vault.LEGS()));
    }

    /// @dev What `_slice` holds back on an ether vault: ONE refund at this
    ///      block's gas, capped by the ceiling. Computed here rather than
    ///      written out in each test, so the rule lives in one place on both
    ///      sides.
    function _held(PortfolioVault vault) internal view returns (uint256 held) {
        held = 400_000 * block.basefee * 8;
        if (held > vault.MAX_REFUND()) held = vault.MAX_REFUND();
    }

    function _line(address stock, uint16 bps) internal pure returns (PortfolioBook.Line[] memory out) {
        out = new PortfolioBook.Line[](1);
        out[0] = PortfolioBook.Line(stock, bps);
    }

    function _lines(address a, uint16 ab, address b, uint16 bb)
        internal
        pure
        returns (PortfolioBook.Line[] memory out)
    {
        out = new PortfolioBook.Line[](2);
        out[0] = PortfolioBook.Line(a, ab);
        out[1] = PortfolioBook.Line(b, bb);
    }

    // ---- tree helpers: leaves are (holder, PIVOT, cumulative) --------------

    function _leaf(address holder, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, USDG, cumulative))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    function _proof(bytes32 sibling) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = sibling;
    }

    /// @dev One window, funded in the PIVOT — which is the only line this mode's
    ///      vault ever funds. `deal` writes a standard ERC-20 balance; the swap
    ///      that follows in `distributeInto` is real.
    function _fundPivot(PortfolioVault vault, PortfolioDistributor dist, uint256 epoch, uint256 amount) internal {
        deal(USDG, address(dist), IERC20(USDG).balanceOf(address(dist)) + amount);
        if (block.timestamp < dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory spent = new uint256[](1);
        stocks[0] = USDG;
        amounts[0] = amount;
        spent[0] = amount;
        vm.prank(address(vault));
        dist.fundWindow(epoch, stocks, amounts, spent);
    }

    /// @dev A two-leaf root over `a` and `b`, published by the keeper.
    function _publishTwo(PortfolioDistributor dist, uint256 epoch, address a, uint256 ca, address b, uint256 cb)
        internal
    {
        bytes32 root = _pair(_leaf(a, ca), _leaf(b, cb));
        vm.prank(keeper);
        dist.publishRoot(epoch, root, root, bytes32("cid"), "bafyTEST");
    }

    function _one(address who) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = who;
    }

    function _amt(uint256 v) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = v;
    }

    function _proofs(bytes32 sibling) internal pure returns (bytes32[][] memory out) {
        out = new bytes32[][](1);
        out[0] = _proof(sibling);
    }

    /// @dev A balanced tree over a power-of-two number of leaves, with every
    ///      proof. The two-leaf helpers above cover the behaviour tests; this
    ///      one exists for the MEASUREMENT below, which needs batches of 4, 16
    ///      and 64 and therefore cannot hand-roll its siblings.
    ///
    ///      Same sorted-pair hash `_pair` uses, which is OpenZeppelin's and
    ///      therefore the one `_verify` checks against.
    function _buildTree(bytes32[] memory leaves) internal pure returns (bytes32 root, bytes32[][] memory proofs) {
        uint256 n = leaves.length;
        uint256 depth;
        while ((1 << depth) < n) ++depth;
        require(1 << depth == n, "leaves must be a power of two");

        bytes32[][] memory levels = new bytes32[][](depth + 1);
        levels[0] = leaves;
        for (uint256 d; d < depth; ++d) {
            bytes32[] memory cur = levels[d];
            bytes32[] memory nxt = new bytes32[](cur.length / 2);
            for (uint256 i; i < nxt.length; ++i) {
                nxt[i] = _pair(cur[2 * i], cur[2 * i + 1]);
            }
            levels[d + 1] = nxt;
        }
        root = levels[depth][0];

        proofs = new bytes32[][](n);
        for (uint256 i; i < n; ++i) {
            bytes32[] memory pf = new bytes32[](depth);
            uint256 idx = i;
            for (uint256 d; d < depth; ++d) {
                pf[d] = levels[d][idx ^ 1];
                idx >>= 1;
            }
            proofs[i] = pf;
        }
    }

    /// @dev `n` holders, each owed `each` of the pivot, each paid in one stock,
    ///      with the root published and the window funded. Returns everything
    ///      `distributeInto` wants.
    function _batchOf(PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book, uint256 n, uint256 each)
        internal
        returns (address[] memory who, uint256[] memory cum, bytes32[][] memory proofs)
    {
        who = new address[](n);
        cum = new uint256[](n);
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            who[i] = address(uint160(0xB0B0000 + i));
            cum[i] = each;
            leaves[i] = _leaf(who[i], each);
            vm.prank(who[i]);
            book.setPortfolio(_line(NVDA, 10_000));
        }
        (bytes32 root, bytes32[][] memory pf) = _buildTree(leaves);
        proofs = pf;

        _fundPivot(vault, dist, 0, each * n);
        vm.prank(keeper);
        dist.publishRoot(0, root, root, bytes32("cid"), "bafyTEST");
    }

    // ---- admission, and what did NOT move ----------------------------------

    function test_TheFactoryIsAdmittedAndStampsItsOwnMode() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);

        assertEq(portfolioFactory.MODE(), bytes32("portfolio"), "a name no other factory carries");
        assertTrue(pad.isVault(address(vault)), "the vault is in the registry");
        assertEq(pad.modeOf(address(vault)), bytes32("portfolio"), "stamped with its factory's mode");
        assertEq(dist.FEE_VAULT(), address(vault), "the distributor answers to its vault");
        assertEq(vault.DISTRIBUTOR(), address(dist), "and the vault funds the distributor");
        assertEq(dist.book(), address(book), "the distributor knows the book");
        assertEq(book.vault(), address(vault), "and the book knows the vault");
    }

    /// @notice **No governance seat moved, and that is the point of this
    ///         design.** The first version of this mode made the vault buy the
    ///         aggregate of the holders' wishes, which meant reweighting the
    ///         basket every thirty minutes and putting the book in the vault's
    ///         timelock seat. Converting at delivery needs none of it.
    function test_TheModeAddsNoKeyAndMovesNoSeat() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);

        assertEq(vault.TIMELOCK(), timelock, "the vault answers to the platform timelock, like every other");
        assertEq(dist.TIMELOCK(), timelock, "and so does the distributor");
        assertEq(dist.keeper(), keeper, "with the registry's pinned keeper, unchanged");
    }

    function test_TheBookIsBoundOnceAndOnlyByItsFactory() public {
        (PortfolioVault vault,, PortfolioBook book) = _portfolio(pad);

        PortfolioBook.Line[] memory l = _line(NVDA, 10_000);
        vm.expectRevert(PortfolioBook.NotFactory.selector);
        book.bind(address(vault), l);

        vm.prank(address(portfolioFactory));
        vm.expectRevert(PortfolioBook.AlreadyBound.selector);
        book.bind(address(vault), l);
    }

    /// @notice The creator's basket becomes the DEFAULT portfolio — what a
    ///         holder who declares nothing is paid in, which is every holder on
    ///         day one.
    function test_TheCreatorsBasketBecomesTheDefaultPortfolio() public {
        (,, PortfolioBook book) = _portfolio(pad);

        PortfolioBook.Line[] memory d = book.defaultBasket();
        assertEq(d.length, 2, "the two lines the creator posted");
        assertEq(d[0].stock, NVDA, "in order");
        assertEq(d[0].bps, 5_000, "at their weights");
        assertEq(book.weightOf(makeAddr("nobody"), NVDA), 5_000, "and that is what a silent holder is owed in");
    }

    // ---- what a holder may write -------------------------------------------

    /// @notice **Free, and not confined to the creator's lines.** The universe
    ///         is `Payd.listing` — every stock the platform allows — read live,
    ///         so a retier or a delisting by the timelock reaches this mode with
    ///         no migration.
    function test_AHolderMayChooseAnyStockThePlatformAllows() public {
        (,, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");

        // GLD is allowed by the registry and is NOT one of the creator's lines.
        vm.prank(alice);
        book.setPortfolio(_line(GLD, 10_000));

        assertEq(book.weightOf(alice, GLD), 10_000, "a stock the creator never named");
        assertEq(book.weightOf(alice, NVDA), 0, "and none of the default any more");

        vm.prank(alice);
        book.clearPortfolio();
        assertEq(book.weightOf(alice, NVDA), 5_000, "cleared, and the creator's default is back");
    }

    function test_TheBookRefusesAStockThePlatformDoesNotAllow() public {
        (,, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address notAStock = makeAddr("not a stock");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PortfolioBook.NotListed.selector, notAStock));
        book.setPortfolio(_line(notAStock, 10_000));
    }

    function test_AMalformedRowIsRefusedWhereItIsWritten() public {
        (,, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");

        vm.prank(alice);
        vm.expectRevert(PortfolioBook.BadWeights.selector);
        book.setPortfolio(_lines(NVDA, 6_000, QQQ, 3_000)); // does not sum to BPS

        vm.prank(alice);
        vm.expectRevert(PortfolioBook.BadWeights.selector);
        book.setPortfolio(_lines(NVDA, 9_950, QQQ, 50)); // a line under MIN_LINE_BPS

        vm.prank(alice);
        vm.expectRevert(PortfolioBook.BadWeights.selector);
        book.setPortfolio(_lines(NVDA, 5_000, NVDA, 5_000)); // the same stock twice
    }

    /// @notice **A 1 % line is legal, and that is the freedom this mode is
    ///         named for.** `MIN_LINE_BPS` was 500, which with a row summing to
    ///         exactly `BPS` capped a holder at twenty stocks whatever
    ///         `MAX_LINES` said — so the real bound on a platform of ~46 was
    ///         never the 8 everyone read, it was the 5 %.
    ///
    /// @dev    What used to justify 500 was dust, and dust is now answered
    ///         where it arises: `offchain/src/portfolio.ts` converts a line only
    ///         once that line is worth the floor, so a 1 % line waits instead of
    ///         costing a swap to produce five cents of stock.
    function test_AOnePercentLineIsLegalAndAnythingUnderItIsNot() public {
        (,, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");

        PortfolioBook.Line[] memory row = new PortfolioBook.Line[](3);
        row[0] = PortfolioBook.Line(NVDA, 100); // MIN_LINE_BPS exactly
        row[1] = PortfolioBook.Line(QQQ, 100);
        row[2] = PortfolioBook.Line(GLD, 9_800);
        vm.prank(alice);
        book.setPortfolio(row);

        assertEq(book.MIN_LINE_BPS(), 100, "one per cent, not five");
        assertEq(book.MAX_LINES(), 64, "and the count is a sanity bound, not an economic one");
        assertEq(book.weightOf(alice, NVDA), 100, "the smallest line the book accepts is honoured");
        assertEq(book.weightOf(alice, GLD), 9_800, "and so is the largest");

        row[0] = PortfolioBook.Line(NVDA, 99);
        row[2] = PortfolioBook.Line(GLD, 9_801);
        vm.prank(alice);
        vm.expectRevert(PortfolioBook.BadWeights.selector);
        book.setPortfolio(row);
    }

    /// @notice **`weightOf` is keyed, and a row that is replaced or cleared
    ///         stops answering.** The keyed copy is what makes a long row cost
    ///         its author and not the batch it is settled in; the bug it can
    ///         have is the array and the mapping disagreeing, which is what
    ///         this reads.
    function test_AReplacedRowStopsAnsweringForTheStocksItDropped() public {
        (,, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");

        vm.prank(alice);
        book.setPortfolio(_lines(NVDA, 5_000, QQQ, 5_000));
        assertEq(book.weightOf(alice, QQQ), 5_000, "both lines answer");

        // Replaced by a row that does not name QQQ at all.
        vm.prank(alice);
        book.setPortfolio(_lines(NVDA, 7_000, GLD, 3_000));
        assertEq(book.weightOf(alice, QQQ), 0, "the dropped line answers nothing");
        assertEq(book.weightOf(alice, NVDA), 7_000, "and the kept one answers its NEW weight");
        assertEq(book.weightOf(alice, GLD), 3_000, "the added one answers too");
        assertEq(book.linesOf(alice).length, 2, "the array agrees with the mapping");

        // Cleared: back to the creator's default, which is NVDA/QQQ 50-50.
        vm.prank(alice);
        book.clearPortfolio();
        assertEq(book.weightOf(alice, GLD), 0, "nothing of the cleared row survives");
        assertEq(book.weightOf(alice, NVDA), 5_000, "and the default answers again");
        assertEq(book.weightOf(alice, QQQ), 5_000, "on both of its lines");
    }

    // ---- the conversion ----------------------------------------------------

    /// @notice **A holder is paid in what they asked for**, converted out of
    ///         the pivot in the delivery itself. This is the whole mode, end to
    ///         end, against the real Uniswap pool.
    function test_AHolderIsPaidInWhatTheyAskedFor() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_line(NVDA, 10_000));

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        assertEq(IERC20(NVDA).balanceOf(alice), 0, "she holds none of it yet");
        vm.prank(keeper);
        uint256 out = dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);

        assertGt(out, 0, "the batch's one swap returned something");
        assertEq(IERC20(NVDA).balanceOf(alice), out, "and all of it reached her");
        assertEq(dist.claimedSoFar(alice, USDG), 1_000e6, "her pivot entitlement is spent, exactly once");
    }

    /// @notice **The weight is READ from the book, never taken from the call.**
    ///         A keeper naming a stock a holder did not ask for converts
    ///         nothing — which is what bounds this mode to adding no power.
    function test_AKeeperCannotPayAHolderInAStockTheyDidNotChoose() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_line(QQQ, 10_000));

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        vm.expectRevert(PortfolioDistributor.NothingConverted.selector);
        dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);

        assertEq(dist.claimedSoFar(alice, USDG), 0, "and nothing of hers was spent trying");
    }

    /// @notice **One swap serves the whole batch.** The economic claim of
    ///         converting at delivery rather than per holder: two holders, one
    ///         `exactInput`, split pro-rata of what they each put in.
    function test_OneSwapServesTheWholeBatch() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address bob = makeAddr("bob");

        vm.prank(alice);
        book.setPortfolio(_line(NVDA, 10_000));
        vm.prank(bob);
        book.setPortfolio(_line(NVDA, 10_000));

        _fundPivot(vault, dist, 0, 4_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, bob, 3_000e6);

        address[] memory who = new address[](2);
        uint256[] memory cum = new uint256[](2);
        bytes32[][] memory pr = new bytes32[][](2);
        who[0] = alice;
        cum[0] = 1_000e6;
        pr[0] = _proof(_leaf(bob, 3_000e6));
        who[1] = bob;
        cum[1] = 3_000e6;
        pr[1] = _proof(_leaf(alice, 1_000e6));

        vm.prank(keeper);
        uint256 out = dist.distributeInto(NVDA, who, cum, pr, 0);

        uint256 got = IERC20(NVDA).balanceOf(alice) + IERC20(NVDA).balanceOf(bob);
        assertApproxEqAbs(got, out, 1, "the whole swap reached the two of them");
        // Bob put in three times what Alice did, so he takes three times as
        // much of what the one swap returned.
        assertApproxEqRel(
            IERC20(NVDA).balanceOf(bob), IERC20(NVDA).balanceOf(alice) * 3, 1e12, "pro-rata of what each put in"
        );
    }

    /// @notice A holder who declared nothing is served through the creator's
    ///         default — half their share into each of its two lines.
    function test_ASilentHolderIsServedThroughTheCreatorsDefault() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);
        address quiet = makeAddr("quiet");
        address other = makeAddr("other");

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, quiet, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        dist.distributeInto(NVDA, _one(quiet), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
        assertGt(IERC20(NVDA).balanceOf(quiet), 0, "half of it bought the default's first line");
        assertEq(dist.claimedSoFar(quiet, USDG), 500e6, "exactly half of the entitlement, and no more");

        vm.prank(keeper);
        dist.distributeInto(QQQ, _one(quiet), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
        assertGt(IERC20(QQQ).balanceOf(quiet), 0, "and the other half the second");
        assertEq(dist.claimedSoFar(quiet, USDG), 1_000e6, "the whole share is now converted, once");
    }

    /// @notice A second call over the same holder and stock converts nothing:
    ///         `claimedSoFar` is what forbids paying twice, exactly as it does
    ///         in the default mode.
    function test_TheSameBatchTwiceConvertsNothingTheSecondTime() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_line(NVDA, 10_000));
        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
        uint256 held = IERC20(NVDA).balanceOf(alice);

        vm.prank(keeper);
        vm.expectRevert(PortfolioDistributor.NothingConverted.selector);
        dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
        assertEq(IERC20(NVDA).balanceOf(alice), held, "and she is no richer for the attempt");
    }

    /// @notice A floor the caller sets above what the pool can give reverts the
    ///         call rather than delivering at a worse price. The caller can only
    ///         TIGHTEN the oracle's floor (§S3).
    function test_ACallerMayTightenTheFloorAndNeverLoosenIt() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_line(NVDA, 10_000));
        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        vm.expectRevert();
        dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), type(uint128).max);
        assertEq(dist.claimedSoFar(alice, USDG), 0, "a refused swap leaves the entitlement whole");
    }

    /// @notice A proof that does not verify against the active root is refused
    ///         before anything is spent.
    function test_AnInvalidProofConvertsNothing() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_line(NVDA, 10_000));
        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        vm.expectRevert();
        dist.distributeInto(NVDA, _one(alice), _amt(9_999e6), _proofs(_leaf(other, 1_000e6)), 0);
    }

    // ---- the vault's own money path ----------------------------------------

    /// @notice **`payout()` end to end, and this test exists because it did
    ///         not.** Every other test in this file funds the Distributor by
    ///         hand — `deal` plus a pranked `fundWindow` — which proves the
    ///         delivery side and nothing about the vault. The vault's half is
    ///         `_slice` (the `payoutBps` pacing, the held-back reserve) and
    ///         `_toPivot` / `_route`, which are PORTED from `FeeVault`: exactly
    ///         where a porting error would sit unnoticed.
    ///
    /// @dev    The swap is real: native ETH through WETH into USDG at
    ///         `ETH_PIVOT_FEE`, against the live pool, floored by its own
    ///         30-minute TWAP. Nothing is mocked and no cheatcode touches the
    ///         route.
    function test_TheVaultConvertsToThePivotAndCreditsTheWindow() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);
        address caller = makeAddr("anybody");

        vm.deal(address(this), 1 ether);
        vault.fundRewards{value: 1 ether}();
        assertEq(vault.rewardsPool(), 1 ether, "the reserve is the holders'");

        // A window needs a FINISHED epoch to cover.
        vm.warp(dist.epochEnd(0) + 1);

        uint256 before = IERC20(USDG).balanceOf(address(dist));
        vm.prank(caller);
        uint256 g0 = gasleft();
        uint256 pivotOut = vault.payout();
        // What the refund reserve is sized against. Printed rather than
        // asserted to the wei: it moves with the route the quote takes.
        emit log_named_uint("payout() gas          ", g0 - gasleft());

        assertGt(pivotOut, 0, "the hop returned pivot");
        assertEq(IERC20(USDG).balanceOf(address(dist)) - before, pivotOut, "all of it reached the distributor");
        assertEq(dist.totalFunded(USDG), pivotOut, "and the window was credited with exactly that");
        assertEq(dist.nextEpoch(), 1, "epoch 0 is now covered");

        // **The pacing, to the wei.** 1 ether in, ONE REFUND held back so a
        // refund is always payable, 4 % of the rest — under the
        // `MIN_BUY_QUOTE * MAX_BUY_MULTIPLE` cap, over the `MIN_BUY_QUOTE`
        // floor, so the fraction is what applies.
        //
        // It was `MAX_REFUND` — the ceiling — until 2026-09-22. See
        // `test_TheReserveHoldsOneRefundAndNotItsCeiling`.
        uint256 expectedSpend = ((1 ether - _held(vault)) * 400) / 10_000;
        assertEq(
            1 ether - vault.rewardsPool(), expectedSpend + (caller.balance), "spent the slice, refunded the caller"
        );
        assertGt(caller.balance, 0, "a permissionless call pays for itself");
    }

    /// @notice The reserve is never emptied: what the pacing leaves behind is
    ///         deferred, and the next window takes another slice.
    function test_ASecondWindowTakesAnotherSliceOfWhatIsLeft() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);

        vm.deal(address(this), 1 ether);
        vault.fundRewards{value: 1 ether}();
        vm.warp(dist.epochEnd(0) + 1);
        vault.payout();
        uint256 afterFirst = vault.rewardsPool();
        uint256 fundedFirst = dist.totalFunded(USDG);

        vm.warp(dist.epochEnd(1) + 1);
        vault.payout();

        assertLt(vault.rewardsPool(), afterFirst, "the second window spent again");
        assertGt(vault.rewardsPool(), 0, "and the reserve is never emptied by one call");
        assertGt(dist.totalFunded(USDG), fundedFirst, "the distributor holds more pivot than before");
        assertEq(dist.nextEpoch(), 2, "two windows covered, in order");
    }

    /// @notice A window with nothing finished to cover is refused rather than
    ///         credited empty — `fundWindow` would refuse a zero amount anyway,
    ///         and saying so at the top is cheaper than finding out at the end.
    function test_PayoutRefusesAWindowWithNothingToCover() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);

        vm.deal(address(this), 1 ether);
        vault.fundRewards{value: 1 ether}();
        vm.warp(dist.epochEnd(0) + 1);
        vault.payout();

        // Same epoch, nothing new has finished.
        vm.expectRevert(BaseModeVault.NothingToDo.selector);
        vault.payout();
    }

    /// @notice A reserve under the held-back floor buys nothing and strands
    ///         nothing: it waits for the next harvest.
    function test_AReserveUnderTheFloorDefersRatherThanSpending() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);

        vm.deal(address(this), 0.005 ether);
        vault.fundRewards{value: 0.005 ether}(); // under the purchase floor
        vm.warp(dist.epochEnd(0) + 1);

        // **`BelowMinBuy` and not `NothingToDo`, since the reserve stopped
        // freezing `MAX_REFUND`.** Both mean "deferred, nothing stranded"; this
        // one names the two numbers, which is the better of the two answers to
        // give somebody asking why their vault is quiet. The pool no longer
        // trips the "under what is held back" branch at all, because what is
        // held back is now one refund.
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioVault.BelowMinBuy.selector, 0.005 ether - _held(vault), vault.MIN_BUY_QUOTE()
            )
        );
        vault.payout();
        assertEq(vault.rewardsPool(), 0.005 ether, "and the money is still the holders'");
    }

    /// @notice The conversion pace is the timelock's, bounded, and nobody
    ///         else's. It is this mode's ONLY privileged function.
    function test_ThePaceIsTheTimelocksAndIsBounded() public {
        (PortfolioVault vault,,) = _portfolio(pad);

        assertEq(vault.payoutBps(), 400, "seeded at FeeVault's 4 %");

        vm.expectRevert(BaseModeVault.NotTimelock.selector);
        vault.setPayoutBps(600);

        vm.prank(timelock);
        vault.setPayoutBps(600);
        assertEq(vault.payoutBps(), 600, "the timelock moves it");

        // Read the bounds BEFORE arming the cheatcode: `vm.expectRevert`
        // applies to the very next call, and a getter is a call.
        uint256 tooHigh = vault.MAX_PAYOUT_BPS() + 1;
        uint256 tooLow = vault.MIN_PAYOUT_BPS() - 1;

        vm.prank(timelock);
        vm.expectRevert(PortfolioVault.BadPayoutRate.selector);
        vault.setPayoutBps(tooHigh);

        vm.prank(timelock);
        vm.expectRevert(PortfolioVault.BadPayoutRate.selector);
        vault.setPayoutBps(tooLow);
    }

    /// @notice `collect` on a holder who is owed nothing refuses rather than
    ///         emitting an empty delivery.
    ///
    /// @dev    **The branch this file does NOT cover, named so it is known
    ///         rather than discovered.** `pending` is written when the stock
    ///         transfer fails AFTER the batch's swap has already succeeded —
    ///         in practice a blocklisted recipient, since a paused stock would
    ///         take the swap down with it. Neither is reachable here:
    ///         `BLOCKER_ROLE` is not enumerable on the live token
    ///         (`getRoleMember` reverts) so there is no address to prank, and
    ///         the `vm.etch` recipe `test/BackingMode.t.sol` uses cannot apply
    ///         — there the purchase is over before the stock goes down, here
    ///         the swap and the transfer are one transaction, so etching the
    ///         stock replaces the very token the pool pays out and the test
    ///         would be measuring its own fixture.
    ///
    ///         The ABI was found since (`docs/recon.md` §2.3bis):
    ///         `blockAccounts(address[])` and `isBlocked(address)` live on the
    ///         shared access registry, not on the token. What is still missing
    ///         is an address that CURRENTLY holds `BLOCKER_ROLE` to prank — the
    ///         deployment admin was revoked, and finding the successor means
    ///         scanning ~68 M blocks in 10 000-block windows.
    ///
    ///         The shape is `BackingRedeemer.stockPending`'s, which IS covered
    ///         (`test_APausedStockDefersAndCollectStockRetries`).
    function test_CollectRefusesWhenNothingIsPending() public {
        (, PortfolioDistributor dist,) = _portfolio(pad);

        vm.expectRevert(Distributor.NothingDelivered.selector);
        dist.collect(makeAddr("alice"), NVDA);
    }

    // ---- the manual way out ------------------------------------------------

    /// @notice **A holder never has to wait for a conversion: `claim` pays them
    ///         the PIVOT, directly, at any time.**
    ///
    /// @dev    Inherited from `Distributor` and deliberately not overridden.
    ///         This mode's tree names ONE stock — the pivot — so the claim tree
    ///         a holder proves against pays USDG rather than equities, and the
    ///         row they wrote in the book is simply not consulted. It is the
    ///         escape hatch for every reason a conversion might not have
    ///         happened yet: a slice under the delivery floor, a delisted
    ///         stock, a keeper that has stopped, or a holder who would just
    ///         rather hold the dollars.
    ///
    ///         **And the two paths share ONE ledger**, which is the property
    ///         actually at risk here: `_one` and `_take` both debit
    ///         `claimedSoFar[holder][PIVOT]` and both credit
    ///         `totalDistributed[PIVOT]`. Nothing can be taken twice by taking
    ///         it two different ways.
    function test_AHolderMayClaimThePivotInsteadOfWaitingForTheConversion() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_line(NVDA, 10_000));

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        address[] memory pivotOnly = new address[](1);
        pivotOnly[0] = USDG;

        vm.prank(alice);
        uint256 got = dist.claim(pivotOnly, _amt(1_000e6), _proofs(_leaf(other, 1_000e6)));

        assertEq(got, 1_000e6, "the whole entitlement, in the pivot");
        assertEq(IERC20(USDG).balanceOf(alice), 1_000e6, "paid in USDG and not in what she asked for");
        assertEq(IERC20(NVDA).balanceOf(alice), 0, "her row was never consulted: claim does not convert");
        assertEq(dist.claimedSoFar(alice, USDG), 1_000e6, "and the shared ledger records it");

        // Nothing is left for the keeper to convert, and the batch says so
        // rather than swapping zero.
        vm.prank(keeper);
        vm.expectRevert(PortfolioDistributor.NothingConverted.selector);
        dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
    }

    /// @notice The reverse order, and the same single ledger: a share half
    ///         converted is half claimable, never wholly claimable.
    ///
    /// @dev    This is the direction a double-spend would take if the two paths
    ///         kept separate counters — convert into the stock, then claim the
    ///         pivot for the same units. `_take` writes `claimedSoFar` exactly
    ///         as `_one` does, so what has become NVDA is no longer owed.
    function test_AConvertedHalfCannotAlsoBeClaimed() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address alice = makeAddr("alice");
        address other = makeAddr("other");

        vm.prank(alice);
        book.setPortfolio(_lines(NVDA, 5_000, QQQ, 5_000));

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, alice, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        dist.distributeInto(NVDA, _one(alice), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
        assertGt(IERC20(NVDA).balanceOf(alice), 0, "half of it became NVDA");
        assertEq(dist.claimedSoFar(alice, USDG), 500e6, "and the shared ledger already says so");

        address[] memory pivotOnly = new address[](1);
        pivotOnly[0] = USDG;

        vm.prank(alice);
        uint256 got = dist.claim(pivotOnly, _amt(1_000e6), _proofs(_leaf(other, 1_000e6)));
        assertEq(got, 500e6, "claim pays the OTHER half and not the whole share");
        assertEq(dist.claimedSoFar(alice, USDG), 1_000e6, "the two paths together settle it exactly once");

        // And a second claim finds nothing, by the same counter.
        vm.prank(alice);
        vm.expectRevert(Distributor.NothingDelivered.selector);
        dist.claim(pivotOnly, _amt(1_000e6), _proofs(_leaf(other, 1_000e6)));
    }

    /// @notice **The reserve holds what a refund COSTS, not what one may ever
    ///         cost**, and the difference is three orders of magnitude.
    ///
    /// @dev    `MAX_REFUND` is 0.01 ether. A `payout()` is 352,341 gas measured,
    ///         and at the chain's 0.0574 gwei that is 0.0000202 ether — so the
    ///         ceiling is 495 refunds, and freezing it compounds with
    ///         `MIN_BUY_QUOTE`: a vault had to hold 0.02 ether before it could
    ///         spend anything. The live $PAYD vault is in exactly that state
    ///         today, which is what sent this looking.
    function test_TheReserveHoldsOneRefundAndNotItsCeiling() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);

        // A basefee this vault will actually see. `vm.fee` rather than the
        // fork's, so the arithmetic below is not at the mercy of the block the
        // test happened to pin.
        vm.fee(0.06 gwei);
        uint256 expectedHeld = 400_000 * 0.06 gwei * 8; // 0.000192 ether
        assertLt(expectedHeld, vault.MAX_REFUND() / 50, "fixture: the cost is far under the ceiling");

        // A pool that the OLD rule could not have spent from at all: over the
        // purchase floor, under floor + ceiling.
        uint256 pool = vault.MIN_BUY_QUOTE() + expectedHeld + 0.0005 ether;
        assertLt(pool, vault.MAX_REFUND() + vault.MIN_BUY_QUOTE(), "fixture: the old rule would refuse this");

        vm.deal(address(this), pool);
        vault.fundRewards{value: pool}();
        vm.warp(dist.epochEnd(0) + 1);

        vm.prank(keeper);
        uint256 pivotOut = vault.payout();
        assertGt(pivotOut, 0, "a vault that used to be stuck now converts");
        assertGe(vault.rewardsPool(), 0, "and never spends what it held back");

        // On a gas spike the ceiling takes over, which is the safe direction.
        vm.fee(10 gwei);
        assertGt(
            400_000 * uint256(10 gwei) * 8,
            vault.MAX_REFUND(),
            "at 10 gwei the computed reserve exceeds the ceiling, so the cap binds"
        );
    }

    // ---- the legs, and the dollars line ------------------------------------

    /// @notice **A portfolio launch can carry the burn and locked-LP legs**,
    ///         and they take their slice of the QUOTE before the pivot hop.
    ///
    /// @dev    This mode nearly shipped without them. Every other mode clones
    ///         the deployed `FeeVaultV2`, which carries the legs; this one is
    ///         built on `BaseModeVault` because it buys no basket — and in
    ///         leaving three quarters of `FeeVault` behind it left the legs
    ///         too, so a creator who wanted their holders to choose had to give
    ///         up buy-and-burn. Nothing made that trade necessary: the legs act
    ///         on the token's own pool and the payout acts on the pivot.
    function test_ALaunchMayCarryTheBurnAndLockedLpLegs() public {
        (PortfolioVault vault, PortfolioDistributor dist, V2Legs legs) = _portfolioWithLegs(pad, 1_000, 1_500);

        assertTrue(address(legs) != address(0), "the launch got its own V2Legs");
        assertEq(legs.burnBps(), 1_000, "the burn leg is the creator's");
        assertEq(legs.lpBps(), 1_500, "and so is the locked-LP leg");
        assertEq(pad.modeOf(address(vault)), bytes32("portfolio"), "still a portfolio vault");

        // A launch that asked for none gets none, and pays nothing for the
        // mode being able to carry them.
        (PortfolioVault bare,,) = _portfolio(_newPad(address(0)));
        assertEq(bare.LEGS(), address(0), "no modeData, no legs");
        dist; // the distributor is the same contract either way
    }

    /// @notice The legs are funded out of the conversion, in QUOTE, and the
    ///         pivot line is credited with what is LEFT.
    function test_TheLegsTakeTheirSliceBeforeThePivotHop() public {
        (PortfolioVault withLegs, PortfolioDistributor dist,) = _portfolioWithLegs(pad, 1_000, 0);

        vm.deal(address(this), 1 ether);
        withLegs.fundRewards{value: 1 ether}();
        vm.warp(dist.epochEnd(0) + 1);

        uint256 legsBefore = withLegs.LEGS().balance;
        vm.prank(keeper);
        withLegs.payout();

        // The slice `_slice()` computes is the same either way — 4 % of what is
        // left once `MAX_REFUND` is held back — and the legs take 10 % OF THAT,
        // in QUOTE, before the pivot hop ever happens.
        uint256 slice = ((1 ether - _held(withLegs)) * 400) / 10_000;
        assertEq(
            withLegs.LEGS().balance - legsBefore,
            (slice * 1_000) / 10_000,
            "the burn leg took its tenth of the conversion, in ether, not in pivot"
        );
    }

    /// @notice **A holder may ask to be paid in dollars, and that is a line
    ///         naming the PIVOT.** It is settled by transfer: there is no pool
    ///         of a currency against itself.
    ///
    /// @dev    Before this, a holder on a launch whose creator set a default
    ///         basket had NO WAY to opt out of it: `clearPortfolio` returns them
    ///         to that default and the next push converts them into it. Their
    ///         only escape was to claim before every delivery.
    function test_AHolderMayAskToBePaidInDollars() public {
        (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(pad);
        address saver = makeAddr("saver");
        address other = makeAddr("other");

        // USDG is NOT an allowed stock on this registry — and the book takes it
        // anyway, because the pivot is not a stock the platform picked.
        (,, bool allowed) = pad.listing(USDG);
        assertFalse(allowed, "fixture: the pivot is not in the stock allowlist");
        vm.prank(saver);
        book.setPortfolio(_line(USDG, 10_000));
        assertEq(book.weightOf(saver, USDG), 10_000, "the row names the pivot");

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, saver, 1_000e6, other, 1_000e6);

        uint256 before = IERC20(USDG).balanceOf(saver);
        vm.prank(keeper);
        uint256 out = dist.distributeInto(USDG, _one(saver), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);

        assertEq(out, 1_000e6, "what came out is what went in: no swap, no slippage");
        assertEq(IERC20(USDG).balanceOf(saver) - before, 1_000e6, "delivered in full, by transfer");
        assertEq(dist.claimedSoFar(saver, USDG), 1_000e6, "and the shared ledger records it once");
        assertEq(dist.convertedInto(saver, USDG), 1_000e6, "the pivot line is a line like any other");
    }

    /// @notice A stock the platform does not allow is still refused at
    ///         delivery — the pivot exemption is the pivot's alone.
    function test_TheDollarsLineDoesNotOpenTheDoorToAnythingElse() public {
        (PortfolioVault vault, PortfolioDistributor dist,) = _portfolio(pad);
        address quiet = makeAddr("quiet");
        address other = makeAddr("other");
        address notAStock = makeAddr("not a stock");

        _fundPivot(vault, dist, 0, 2_000e6);
        _publishTwo(dist, 0, quiet, 1_000e6, other, 1_000e6);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PortfolioDistributor.NotListedHere.selector, notAStock));
        dist.distributeInto(notAStock, _one(quiet), _amt(1_000e6), _proofs(_leaf(other, 1_000e6)), 0);
    }

    // ---- what one converted line actually costs ----------------------------

    /// @notice **The measurement the per-line delivery floor is derived from.**
    ///
    /// @dev    `epoch.ts` prices the default mode's floor off `SETTLE_GAS =
    ///         93,000` — proof + `claimedSoFar` + transfer, measured — and
    ///         `PUSH_K_MIN = 20`, i.e. the holder keeps at least 95 %. A
    ///         portfolio line costs MORE than that: one extra SSTORE
    ///         (`convertedInto`), the `weightOf` read, and a share of the
    ///         batch's ONE swap. The swap is the interesting term, because it
    ///         is amortised: it is what makes a small batch dearer per holder
    ///         than a full one.
    ///
    ///         So this does not assert a constant — it PRINTS the three numbers
    ///         the floor is set from, and fails only if the per-line cost
    ///         leaves the 95 % guarantee unreachable at the floor we picked.
    ///         Re-run it after touching `_take` or `_swap`:
    ///
    ///             forge test --fork-url $RPC_URL_FALLBACK --mt ConversionGas -vv
    function test_ConversionGasPerLineIsWhatTheFloorIsPricedOn() public {
        uint256[3] memory sizes = [uint256(4), 16, 64];
        uint256 worst;
        for (uint256 s; s < sizes.length; ++s) {
            (PortfolioVault vault, PortfolioDistributor dist, PortfolioBook book) = _portfolio(_newPad(address(0)));
            (address[] memory who, uint256[] memory cum, bytes32[][] memory pf) =
                _batchOf(vault, dist, book, sizes[s], 100e6);

            vm.prank(keeper);
            uint256 g0 = gasleft();
            dist.distributeInto(NVDA, who, cum, pf, 0);
            uint256 used = g0 - gasleft();

            uint256 perLine = used / sizes[s];
            if (perLine > worst) worst = perLine;
            emit log_named_uint("batch size            ", sizes[s]);
            emit log_named_uint("  total gas           ", used);
            emit log_named_uint("  gas per line        ", perLine);
        }

        // `SETTLE_GAS` is 93,000 and the default floor is 20x its cost. A
        // portfolio line may cost more, but if it cost several times more the
        // $1 per-line floor would stop guaranteeing 95 % and the number in
        // `offchain/src/portfolio.ts` would have to move with it. 250,000 is
        // the bound that keeps $1 honest at the basefee `epoch.ts` records.
        assertLt(worst, 250_000, "a converted line has become too dear for the floor it is priced against");
    }
}
