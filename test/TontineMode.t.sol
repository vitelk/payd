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
import {TontineFactory} from "../contracts/tontine/TontineFactory.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {IERC20} from "../contracts/interfaces/IExternal.sol";

/// @notice **The "tontine" mode, on-chain half.** The mode adds no contract
///         but a factory: the vault, the legs, the distributor and the
///         bootstrap are the distribution mode's V3 implementations, reused
///         verbatim, and what makes a vault a tontine is the `MODE` its
///         factory stamps on it — the one fact the off-chain reads to pick the
///         accrual rule (`offchain/src/tontine.ts`).
///
/// @dev    Two things are asserted here, and the second is the one that gates
///         the whole design:
///
///         1. **Carrier parity.** A tontine vault is byte-for-byte the pair a
///            `DistributionFactoryV3` builds from the same wiring — same
///            implementations, same clones, same seeded exclusion. A mode that
///            changed the carrier would have to prove the carrier again.
///         2. **A lowered cumulative is a no-op, never a clawback.** The
///            tontine's rule is "shares not yet delivered are forfeited when
///            you sell", which the off-chain expresses by publishing a SMALLER
///            cumulative for the seller and a larger one for the stayers.
///            `Distributor` already tolerates exactly that (`_one`:
///            `if (cumulative <= paid) return 0`), and `claimedSoFar` already
///            protects what was delivered. This file proves it against the
///            real contract instead of against the reading of it.
///
///         Nothing is mocked. `deal` writes a standard ERC-20 balance on a
///         real stock so the window has something to fund — the same posture
///         as `test/Distributor.t.sol`, and no behaviour of Pons or Uniswap is
///         simulated anywhere here.
contract TontineModeTest is Test {
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

    uint256 constant EPOCH_LENGTH = 30 minutes;
    uint256 constant QUOTE_SPENT = 1 ether;

    Payd pad;
    TontineFactory tontineFactory;
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
        tontineFactory = new TontineFactory(vaultImpl, distImpl, legsImpl, POOL_MANAGER, PONS_LOCKER);
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

    function _tontineVault(Payd p) internal returns (FeeVaultV2 vault, DistributorV3 dist) {
        _enable(p, address(tontineFactory));
        return _vaultFrom(p, address(tontineFactory), "");
    }

    // ---- root helpers, the same shapes `test/Distributor.t.sol` uses --------

    /// @dev The leaf does NOT carry the epoch: (holder, stock, cumulative).
    function _leaf(address holder, address stock, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, stock, cumulative))));
    }

    function _pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    function _publish(DistributorV3 dist, uint256 upToEpoch, bytes32 leafA, bytes32 leafB) internal {
        bytes32 root = _pair(leafA, leafB);
        vm.prank(keeper);
        dist.publishRoot(upToEpoch, root, root, bytes32("cid"), "bafyTEST");
    }

    /// @dev One window funded with a real stock. `deal` writes a standard
    ///      ERC-20 balance; every Pons and Uniswap call in this file stays
    ///      real, there simply are none on this path.
    function _fund(FeeVaultV2 vault, DistributorV3 dist, uint256 epoch, uint256 amount) internal {
        deal(NVDA, address(dist), IERC20(NVDA).balanceOf(address(dist)) + amount);
        if (block.timestamp < dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
        address[] memory stocks = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory spent = new uint256[](1);
        stocks[0] = NVDA;
        amounts[0] = amount;
        spent[0] = QUOTE_SPENT;
        vm.prank(address(vault));
        dist.fundWindow(epoch, stocks, amounts, spent);
    }

    /// @dev A root may only cover a FINISHED epoch, and a window that bought
    ///      nothing is not funded at all — `fundWindow` refuses a zero amount.
    ///      The tontine's second root says exactly that: nothing new was
    ///      bought, only the rule was applied.
    function _close(DistributorV3 dist, uint256 epoch) internal {
        if (block.timestamp < dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
    }

    function _claim(DistributorV3 dist, address who, uint256 cumulative, bytes32 sibling) internal returns (uint256) {
        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        bytes32[] memory p = new bytes32[](1);
        p[0] = sibling;
        stocks[0] = NVDA;
        cum[0] = cumulative;
        proofs[0] = p;
        vm.prank(who);
        return dist.claim(stocks, cum, proofs);
    }

    // ---- admission and wiring ----------------------------------------------

    function test_TheFactoryIsAdmittedAndStampsItsOwnMode() public {
        (FeeVaultV2 vault, DistributorV3 dist) = _tontineVault(pad);

        assertEq(tontineFactory.MODE(), bytes32("tontine"), "a name no other factory carries");
        assertTrue(pad.isVault(address(vault)), "the vault is in the registry");
        assertEq(pad.modeOf(address(vault)), bytes32("tontine"), "stamped with its factory's mode");
        assertEq(dist.FEE_VAULT(), address(vault), "the distributor answers to its vault");
        assertEq(vault.DISTRIBUTOR(), address(dist), "and the vault funds the distributor");
        assertEq(dist.TIMELOCK(), timelock, "under the same timelock");
        assertEq(dist.keeper(), keeper, "with the registry's pinned keeper");
        assertEq(vault.LEGS(), address(0), "no legs unless the launch asked for any");
    }

    /// @notice **A tontine vault is born with the V3 seed**, because it IS a
    ///         V3: the locker never accrues, so it never forfeits and never
    ///         receives a forfeiture.
    function test_ATontineIsBornWithTheLockerInItsDatedLog() public {
        (, DistributorV3 dist) = _tontineVault(pad);

        Distributor.ExclusionChange[] memory log = dist.exclusionLog();
        assertEq(log.length, 1, "one entry, the seed, nothing else");
        assertEq(log[0].account, PONS_LOCKER, "the seed is the locker");
        assertTrue(log[0].state, "excluded, not the other thing");
        assertEq(log[0].fromEpoch, 0, "dated epoch 0: in force from the first root");
        assertTrue(dist.isExcludedAt(PONS_LOCKER, 0), "and the epoch-0 replay agrees");
    }

    /// @notice **The carrier is V3's, to the byte.** Same implementations,
    ///         same clone code, same legs wiring — the mode's difference is
    ///         the stamp and what the off-chain does with it, and this test is
    ///         what keeps that sentence true after an edit.
    function test_ATontineVaultIsAVerbatimV3Carrier() public {
        _enable(pad, address(tontineFactory));
        _enable(pad, address(v3Factory));

        bytes memory legs = abi.encode(uint256(1_000), uint256(500));
        (FeeVaultV2 tVault, DistributorV3 tDist) = _vaultFrom(pad, address(tontineFactory), legs);
        (FeeVaultV2 dVault, DistributorV3 dDist) = _vaultFrom(pad, address(v3Factory), legs);

        assertEq(address(tVault).code, address(dVault).code, "the vault clone is the same code");
        assertEq(address(tDist).code, address(dDist).code, "and so is the distributor clone");
        assertEq(tVault.LEGS().code, dVault.LEGS().code, "and the legs");
        assertEq(tontineFactory.VAULT_IMPL(), v3Factory.VAULT_IMPL(), "one vault implementation for both modes");
        assertEq(tontineFactory.DIST_IMPL(), v3Factory.DIST_IMPL(), "one distributor implementation");
        assertEq(tontineFactory.LEGS_IMPL(), v3Factory.LEGS_IMPL(), "one legs implementation");

        assertEq(tVault.rewardsBps(), dVault.rewardsBps(), "the same split");
        assertEq(tVault.MIN_BUY_QUOTE(), dVault.MIN_BUY_QUOTE(), "the same minimum move");
        assertEq(tDist.epochEnd(0), dDist.epochEnd(0), "the same calendar");
        assertEq(pad.modeOf(address(dVault)), bytes32("distribution"), "only the stamp differs");
    }

    /// @notice The legs are orthogonal to the payout rule, and so is their
    ///         validation: the tontine refuses exactly what V3 refuses.
    function test_TheLegsValidationIsV3s() public {
        _enable(pad, address(tontineFactory));

        vm.prank(launcher);
        vm.expectRevert(TontineFactory.BadModeData.selector);
        pad.createVaultWith(
            address(tontineFactory),
            _basket(),
            7_000,
            EPOCH_LENGTH,
            address(0),
            address(0),
            abi.encode(uint256(400), uint256(0)) // under MIN_LEG_BPS
        );

        vm.prank(launcher);
        vm.expectRevert(TontineFactory.BadModeData.selector);
        pad.createVaultWith(
            address(tontineFactory),
            _basket(),
            7_000,
            EPOCH_LENGTH,
            address(0),
            address(0),
            abi.encode(uint256(3_000), uint256(3_000)) // over MAX_LEGS_BPS
        );
    }

    function test_TheCoSignerStampLandsOnTheDistributor() public {
        address coSigner = makeAddr("co-signer");
        Payd p2 = _newPad(coSigner);
        (, DistributorV3 dist) = _tontineVault(p2);
        assertEq(dist.coSigner(), coSigner, "stamped at birth, no CoSignerStampFailed");
    }

    // ---- the rule, against the real contract -------------------------------

    /// @notice **The tontine, in one transaction sequence.** Root A owes the
    ///         seller and the stayer 2 NVDA each, undelivered. The seller then
    ///         halves their launch-token balance, so root B forfeits three
    ///         quarters of what was still owed to them and hands it to the
    ///         stayer — a smaller cumulative for one, a larger for the other,
    ///         and the sum still exactly what was funded.
    ///
    /// @dev    This is the conservation proof the "no new distributor" claim
    ///         rests on: `Σ_h cumulative(h, s) ≤ totalFunded(s)`, so the
    ///         on-chain clamp (`totalFunded − totalDistributed`) is never the
    ///         thing standing between a holder and their share — it stays the
    ///         untouched backstop it is for every other mode.
    function test_AForfeitedShareMovesToTheStayerAndNothingIsOverpaid() public {
        (FeeVaultV2 vault, DistributorV3 dist) = _tontineVault(pad);
        _fund(vault, dist, 0, 4e18);

        bytes32 aSeller = _leaf(seller, NVDA, 2e18);
        bytes32 aStayer = _leaf(stayer, NVDA, 2e18);
        _publish(dist, 0, aSeller, aStayer);

        // The seller sold; neither of them claimed. Their 2 NVDA are still
        // undelivered, so 1.5 of it is forfeitable and lands on the stayer.
        _close(dist, 1); // nothing new bought, only the rule applied
        bytes32 bSeller = _leaf(seller, NVDA, 0.5e18);
        bytes32 bStayer = _leaf(stayer, NVDA, 3.5e18);
        _publish(dist, 1, bSeller, bStayer);

        assertEq(_claim(dist, seller, 0.5e18, bStayer), 0.5e18, "the seller keeps what they did not forfeit");
        assertEq(_claim(dist, stayer, 3.5e18, bSeller), 3.5e18, "and the stayer receives it");

        assertEq(IERC20(NVDA).balanceOf(seller), 0.5e18, "delivered, to the wei");
        assertEq(IERC20(NVDA).balanceOf(stayer), 3.5e18, "delivered, to the wei");
        assertEq(dist.totalDistributed(NVDA), 4e18, "exactly what was funded left the contract");
        assertEq(IERC20(NVDA).balanceOf(address(dist)), 0, "and nothing stayed behind");
    }

    /// @notice **Forfeiture never touches what was delivered.** The seller
    ///         claims first, then sells; a root lowering their cumulative
    ///         below what they already hold owes them nothing and claws back
    ///         nothing — the contract has no clawback, and the off-chain rule
    ///         is written knowing it.
    ///
    /// @dev    This is also the mode's disclosed ceiling: claiming does not
    ///         change a launch-token balance, so a holder can take their
    ///         undelivered share out of reach before selling. Bounded to
    ///         roughly one window of accrual (the automatic push delivers most
    ///         of it to whoever still held), documented rather than fixed —
    ///         closing it means gating `claim` on a current-holding check,
    ///         which changes who can call what and needs its own sign-off.
    function test_ALoweredCumulativeOwesNothingAndClawsBackNothing() public {
        (FeeVaultV2 vault, DistributorV3 dist) = _tontineVault(pad);
        _fund(vault, dist, 0, 4e18);

        bytes32 aSeller = _leaf(seller, NVDA, 2e18);
        bytes32 aStayer = _leaf(stayer, NVDA, 2e18);
        _publish(dist, 0, aSeller, aStayer);
        assertEq(_claim(dist, seller, 2e18, aStayer), 2e18, "delivered before the sale");

        // Root B tries to take it back anyway: the seller's cumulative drops
        // under `claimedSoFar`.
        _close(dist, 1);
        bytes32 bSeller = _leaf(seller, NVDA, 0.5e18);
        bytes32 bStayer = _leaf(stayer, NVDA, 2e18);
        _publish(dist, 1, bSeller, bStayer);

        // Zero owed is not a zero transfer: `claim` refuses the call rather
        // than paying nothing, which is the same answer read from the other
        // side — there is nothing left for this holder to be delivered.
        address[] memory stocks = new address[](1);
        uint256[] memory cum = new uint256[](1);
        bytes32[][] memory proofs = new bytes32[][](1);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bStayer;
        stocks[0] = NVDA;
        cum[0] = 0.5e18;
        proofs[0] = proof;
        vm.prank(seller);
        vm.expectRevert(Distributor.NothingDelivered.selector);
        dist.claim(stocks, cum, proofs);

        assertEq(IERC20(NVDA).balanceOf(seller), 2e18, "and it takes nothing back");
        assertEq(dist.claimedSoFar(seller, NVDA), 2e18, "the ledger is unchanged");
        assertEq(_claim(dist, stayer, 2e18, bSeller), 2e18, "the stayer is unaffected");
    }
}
