// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice The currencies a launch may be quoted in, and the timelock operation
///         that lists them.
///
///   forge script script/Quotelist.s.sol --sig "run()" --rpc-url $RPC_URL
///       prints what the Safe has to schedule, and what anyone executes 48 h later
///
///   forge script script/Quotelist.s.sol --sig "execute()" --rpc-url $RPC_URL --broadcast
///       runs it, once the delay has elapsed
///
/// @dev **Native ETH is not here, and never will be.** It is allowed by
///      construction — `_create` only reads this list for a non-zero quote —
///      and it has neither a hop to price nor a decimal scale to declare. A row
///      for it would be a row nothing reads.
///
///      **The selection rule has TWO branches, one per route.**
///
///      **Direct route** — `QUOTE -> PIVOT`. The currency must already be a
///      listed STOCK, at the same tier. That is not tidiness, it is what makes the
///      guarantee transitive. `_toUsdg` prices its hop with
///      `TwapFloor.meanTick(pool, 1800)` on the QUOTE/USDG pool — the very pool
///      `Allowlist` measured for depth and for a live 30-minute TWAP. And the
///      stakes are HIGHER here than on a basket leg: a leg whose floor reverts
///      is caught and skipped (`_swapLeg`), while `_toUsdg` reverts the WHOLE
///      purchase. So the quotes are a subset of the stocks, and
///      `test_EveryListedStockHasALiveThirtyMinuteTwap` covers both lists at
///      once.
///
///      USDG is the one exception and it needs no pool: a USDG-quoted vault
///      makes no hop at all, `_toUsdg` returns its argument.
///
///      **What the list is worth, and what stays out of reach.** Seven days of
///      `V2FeeEscrow` credits, read on 2026-09-08:
///
///          77  tokens used as a pair on Pons
///          53  have a pivot pool                    96.0 % of the credits
///          45  are already listed as stocks         94.0 % of the credits
///          24  have NO pivot pool at all             4.0 % of the credits
///
///      **Four listed stocks have thinned below the threshold and are NOT
///      here**: WYFI ($1 838), SKHY ($359), MRVL ($2 585), USAR ($2 432),
///      measured 2026-09-09. USAR was listed here on the morning's measurement
///      and fell out the same day: its 3000 pool is the only one that carries
///      anything at all -- 500 and 10000 hold zero liquidity -- so no tier
///      rescues it.
///      The old rule -- "a currency must already be a listed stock" -- would
///      have accepted them by descent, because they had passed the measurement
///      on the day `docs/allowlist.md` was written. Measuring beats inheriting:
///      `test_EveryQuoteRouteCarriesEnoughDepth` named them. They stay in
///      `Allowlist` -- a basket leg that is too thin is skipped, a currency that
///      is too thin brings the whole purchase down -- but it is a signal worth
///      watching.
///
///      The 24 are no longer all out of reach: two of them -- COIN ($33 144 of
///      WETH depth) and cbBTC ($158 774) -- carry 198 of that set's ~220
///      credits, and the detour through WETH picks them up. The remaining 22 are
///      one-off launches whose tokens have liquidity nowhere: no route serves
///      them, and refusing them at creation is the same choice `bind` makes on
///      the pair token -- telling the creator now rather than never.
///
///      So the list is not a shortlist, it is **everything the routing can
///      serve**: **40 rows, USDG being the first.** The breakdown that used to
///      sit here ("USDG plus N of the listed stocks") is not restated: it never
///      once matched the count it stood beside, and it counted COIN and cbBTC
///      among the listed stocks, which they are not. The length is the only
///      figure this comment can hold honestly; the rest is re-derived from
///      docs/allowlist.md. The tokens with a USDG pool that never passed the
///      depth and TWAP measurement together carried $0.13 M over the week, and
///      listing them means measuring them first.
///
///      **Four delistings on 2026-09-10**, and no two for the same reason —
///      which is the argument for having four different sensors rather than one
///      list review. LULU: depth under the floor. PFE: an oracle ring too short
///      for a 30-minute window. BA and $PONS: refused by Pons as pair tokens,
///      found by launching in every row rather than by reading its pools.
///
///      The servable-coverage figure that used to sit here — "43 of the 53
///      servable tokens", with "nine remaining", which do not add up — is NOT
///      restated, because it cannot be decremented honestly: it comes from the
///      weekly credit measurement, not from this array's length. Re-derive it
///      with the procedure in docs/allowlist.md §"Replaying the measurement"
///      before quoting a number here again.
///
///      Length costs nothing: `allowQuotes` writes them in one call, and a row
///      nobody uses is a row nobody pays for. What length BUYS is the 48 hours
///      a creator would otherwise wait for a quote we could have listed on day
///      one.
///
///      **`minBuy` is the one number a vault cannot derive.** `MIN_BUY` is
///      0.01 ETH — $24.91 at the Chainlink read of 2026-09-08 — and it cannot
///      be one constant across three decimal scales: 0.01 ether of raw USDG is
///      ten billion dollars, of raw AMC about six cents. Each row below is that
///      same ~$25 in the quote's raw units, rounded UP to two significant
///      figures. Up, because the two errors are not symmetric: too large only
///      defers a young vault's first purchase (the reserve grows, the next
///      window covers every epoch that went by), while too small spends more
///      gas than the purchase moves.
///
///      Prices move and this list does not. A quote whose minimum has drifted
///      far from $25 is re-listed by the timelock — `allowQuotes` overwrites a
///      row — and it reaches only FUTURE vaults, exactly like `allowStocks`.
contract Quotelist is Script {
    /// @dev The pivot, the listed stocks that carry enough, and the two detour
    ///      currencies. Generated from the measurement, not typed by hand.
    ///
    ///      **A row must survive two kinds of measurement, and they see
    ///      different things.** `test_EveryQuoteRouteCarriesEnoughDepth` and
    ///      `test_EveryQuoteRouteHasALiveThirtyMinuteTwap` read the pools a row
    ///      DECLARES; `test_EveryListedQuoteRunsTheWholeCycle` launches in it,
    ///      binds, harvests and buys. BA and $PONS passed every pool test and
    ///      failed the launch -- Pons keeps its own pair-token allowlist, and a
    ///      pool says nothing whatever about it.
    ///
    ///      **SNAP removed on 2026-09-09**, measured at $4 844 of depth against
    ///      the $5 000 required -- 3 % below the threshold, found by
    ///      `test_EveryQuoteRouteCarriesEnoughDepth`. It stays in `Allowlist`,
    ///      where it is well above: a basket leg that is too thin is SKIPPED and
    ///      its share waits, a CURRENCY that is too thin brings the whole
    ///      purchase down. The threshold does not read the same on both sides.
    function quotes()
        public
        pure
        returns (address[] memory addrs, uint24[] memory poolFees, uint24[] memory wethFees, uint256[] memory minBuys)
    {
        addrs = new address[](40);
        poolFees = new uint24[](40);
        wethFees = new uint24[](40);
        minBuys = new uint256[](40);
        (addrs[0], poolFees[0], minBuys[0]) = (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, 0, 25_000_000); // USDG  ~$25.00
        (addrs[1], poolFees[1], minBuys[1]) =
        (0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5, 3000, 250_000_000_000_000_000); // SGOV  ~$25.28
        (addrs[2], poolFees[2], minBuys[2]) = (0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 500, 35_000_000_000_000_000); // QQQ  ~$25.13
        (addrs[3], poolFees[3], minBuys[3]) = (0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 500, 120_000_000_000_000_000); // NVDA  ~$27.10
        (addrs[4], poolFees[4], minBuys[4]) = (0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 3000, 63_000_000_000_000_000); // GLD  ~$25.28
        (addrs[5], poolFees[5], minBuys[5]) = (0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 500, 170_000_000_000_000_000); // SPCX  ~$25.98
        (addrs[6], poolFees[6], minBuys[6]) = (0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 3000, 68_000_000_000_000_000); // TSLA  ~$24.97
        (addrs[7], poolFees[7], minBuys[7]) =
        (0xCceE82fE024c36fA15E1005edE3E9e4787e23D09, 3000, 900_000_000_000_000_000); // HIMS  ~$25.15
        (addrs[8], poolFees[8], minBuys[8]) =
        (0x1D11f0496982706C5e14A514D4E79F2e6BdE4516, 10000, 2_800_000_000_000_000_000); // DJT  ~$25.58
        (addrs[9], poolFees[9], minBuys[9]) =
        (0x1b0E319c6A659F002271B69dB8A7df2F911c153E, 500, 1_400_000_000_000_000_000); // GME  ~$26.30
        (addrs[10], poolFees[10], minBuys[10]) =
        (0x12f190a9F9d7D37a250758b26824B97CE941bF54, 3000, 98_000_000_000_000_000); // AMZN  ~$25.12
        (addrs[11], poolFees[11], minBuys[11]) =
        (0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD, 3000, 25_000_000_000_000_000); // MU  ~$24.98
        (addrs[12], poolFees[12], minBuys[12]) =
        (0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B, 3000, 9_900_000_000_000_000_000); // AMC  ~$25.03
        (addrs[13], poolFees[13], minBuys[13]) =
        (0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C, 10000, 170_000_000_000_000_000); // RDDT  ~$25.40
        // LULU was listed here and was DELISTED on 2026-09-10, by measurement:
        // test_EveryQuoteRouteCarriesEnoughDepth read its USDG/3000 pool at
        // $4 454 against the $5 000 floor, 11 % under, and named it. It had
        // passed the same test at 17:12 the same day, so the pool thinned
        // within the hour -- which is the rot this list's own header warns
        // about. Re-list it only behind a fresh measurement, not from memory.
        (addrs[14], poolFees[14], minBuys[14]) =
        (0x5e81213613b6B86EaB4c6c50d718d34359459786, 3000, 120_000_000_000_000_000); // TTWO  ~$25.50
        (addrs[15], poolFees[15], minBuys[15]) =
        (0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619, 3000, 110_000_000_000_000_000); // IBM  ~$25.38
        (addrs[16], poolFees[16], minBuys[16]) =
        (0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2, 3000, 28_000_000_000_000_000); // COST  ~$25.36
        (addrs[17], poolFees[17], minBuys[17]) =
        (0x8005d266423c7ea827372c9c864491e5786600ea, 10000, 23_000_000_000_000_000); // LLY  ~$25.80
        (addrs[18], poolFees[18], minBuys[18]) =
        (0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4, 3000, 230_000_000_000_000_000); // BABA  ~$25.82
        (addrs[19], poolFees[19], minBuys[19]) =
        (0xe93237C50D904957Cf27E7B1133b510C669c2e74, 3000, 51_000_000_000_000_000); // MSFT  ~$25.06
        (addrs[20], poolFees[20], minBuys[20]) =
        (0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f, 3000, 420_000_000_000_000_000); // SLV  ~$24.99
        (addrs[21], poolFees[21], minBuys[21]) =
        (0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344, 3000, 180_000_000_000_000_000); // USO  ~$26.17
        (addrs[22], poolFees[22], minBuys[22]) =
        (0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 500, 33_000_000_000_000_000); // SPY  ~$25.32
        (addrs[23], poolFees[23], minBuys[23]) =
        (0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 500, 74_000_000_000_000_000); // GOOGL  ~$25.04
        (addrs[24], poolFees[24], minBuys[24]) =
        (0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8, 3000, 560_000_000_000_000_000); // RBLX  ~$25.05
        (addrs[25], poolFees[25], minBuys[25]) =
        (0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd, 10000, 48_000_000_000_000_000); // DELL  ~$25.30
        (addrs[26], poolFees[26], minBuys[26]) =
        (0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8, 3000, 330_000_000_000_000_000); // NFLX  ~$25.24
        (addrs[27], poolFees[27], minBuys[27]) =
        (0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5, 3000, 260_000_000_000_000_000); // CRCL  ~$24.94
        (addrs[28], poolFees[28], minBuys[28]) =
        (0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 3000, 150_000_000_000_000_000); // PLTR  ~$25.52
        (addrs[29], poolFees[29], minBuys[29]) =
        (0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 500, 79_000_000_000_000_000); // AAPL  ~$24.99
        (addrs[30], poolFees[30], minBuys[30]) =
        (0x41F4267525a8AFf329540eF24fD83d9044758B33, 3000, 1_100_000_000_000_000_000); // FIG  ~$24.92
        // PFE was listed here and was DELISTED on 2026-09-10. Not for being
        // thin -- for being too BUSY for its own oracle buffer. Read on-chain
        // on pool 0xC7d573Fcda6D2107C97fb582ae18411F9Db32E7f:
        //
        //     observationCardinality  64      (the ring is full)
        //     span of those 64 slots  644 s = 10.7 min
        //     cadence                 one observation every 10.1 s
        //     observe([1800, 0])      reverts OLD
        //
        // A 30-minute window needs ~179 slots at that cadence, so the pool
        // cannot serve TWAP_WINDOW however deep it is. The fix is the pool's
        // own parameter, not this list: `increaseObservationCardinalityNext`
        // is permissionless, ~360 slots gives 2x of margin, and
        // ARCHITECTURE.md S3 already priced it at ~20k gas per slot. Re-list
        // PFE once that is paid for and the ring spans the window -- behind a
        // fresh `observe([1800, 0])`, never from memory.
        (addrs[31], poolFees[31], minBuys[31]) =
        (0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80, 3000, 94_000_000_000_000_000); // JNJ  ~$25.12
        (addrs[32], poolFees[32], minBuys[32]) =
        (0xec262a75e413fAfD0dF80480274532C79D42da09, 10000, 190_000_000_000_000_000); // MSTR  ~$25.88
        (addrs[33], poolFees[33], minBuys[33]) =
        (0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B, 10000, 1_600_000_000_000_000_000); // RIVN  ~$25.64
        (addrs[34], poolFees[34], minBuys[34]) =
        (0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 3000, 50_000_000_000_000_000); // AMD  ~$25.17
        (addrs[35], poolFees[35], minBuys[35]) =
        (0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 3000, 41_000_000_000_000_000); // META  ~$25.08
        (addrs[36], poolFees[36], minBuys[36]) =
        (0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2, 10000, 250_000_000_000_000_000); // UPS  ~$25.06
        (addrs[37], poolFees[37], minBuys[37]) =
        (0x58FfE4a942d3885bAa22D7520691F611EF09e7AA, 10000, 58_000_000_000_000_000); // TSM  ~$25.12
        // BA was listed here and was DELISTED on 2026-09-10, by measurement:
        // test_EveryListedQuoteRunsTheWholeCycle launched against every row and
        // Pons's own factory refused this one as a `pairToken` with `0x49285dfb`
        // -- the error WETH and `0xdead` already get (docs/recon-launchpad.md).
        // Its pools are fine; Pons's allowlist is what it is not on, and no pool
        // test could ever have seen that.
        (addrs[38], poolFees[38], wethFees[38], minBuys[38]) =
        (0x6330D8C3178a418788dF01a47479c0ce7CCF450b, 0, 3000, 140_000_000_000_000_000); // COIN  ~$25.07, depth $33 144
        (addrs[39], poolFees[39], wethFees[39], minBuys[39]) =
        (0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4, 0, 3000, 32_000); // cbBTC  ~$25.03, 8 decimals, depth $158 774
        // $PONS was listed here and was DELISTED on 2026-09-10, for the same
        // reason as BA above and by the same test: `launchToken` refuses it with
        // `0x49285dfb`. **Pons does not accept its own token as a pair token.**
        // This row never meant "we buy $PONS" -- that is `Allowlist`, where it
        // has never been -- it meant "a creator may quote their launch in
        // $PONS", which Pons does not allow. A row nobody can launch in is a
        // creator handed a vault that binds to nothing.
    }

    /// @notice What the timelock will call on the Payd.
    function payload() public pure returns (bytes memory) {
        (address[] memory addrs, uint24[] memory poolFees, uint24[] memory wethFees, uint256[] memory minBuys) =
            quotes();
        return abi.encodeCall(Payd.allowQuotes, (addrs, poolFees, wethFees, minBuys));
    }

    /// @dev A fixed salt, so the operation id is reproducible: anybody can
    ///      recompute it from this repository and check that what the Safe
    ///      scheduled is what this file says.
    bytes32 public constant SALT = keccak256("payd.registry.quotelist.v1");

    function run() external view {
        address pad = vm.envAddress("REGISTRY");
        address timelock = vm.envAddress("TIMELOCK");
        bytes memory data = payload();

        (address[] memory addrs,,,) = quotes();
        console.log("quotes in this operation", addrs.length);
        console.log("target  ", pad);
        console.log("timelock", timelock);
        console.log("");
        console.log("1. From the Safe, call TIMELOCK.schedule with:");
        console.logBytes(
            abi.encodeCall(
                TimelockController.schedule, (pad, 0, data, bytes32(0), SALT, Timelock(payable(timelock)).getMinDelay())
            )
        );
        console.log("");
        console.log("2. After the delay, ANYONE calls TIMELOCK.execute with:");
        console.logBytes(abi.encodeCall(TimelockController.execute, (pad, 0, data, bytes32(0), SALT)));
    }

    /// @notice Step two, broadcastable by anyone once the delay has run.
    function execute() external {
        address pad = vm.envAddress("REGISTRY");
        Timelock timelock = Timelock(payable(vm.envAddress("TIMELOCK")));

        vm.startBroadcast();
        timelock.execute(pad, 0, payload(), bytes32(0), SALT);
        vm.stopBroadcast();

        (address[] memory addrs,,,) = quotes();
        console.log("quotes listed", addrs.length);
    }
}
