// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice What a creator may put in a basket, and the timelock operation that
///         lists it.
///
///         Almost all of it is tokenised stocks. **$PONS is in it and is not
///         one** — see its row. Nothing here ever required an equity: the two
///         measurements below ask about a pool, and the word "stock" in this
///         file is a habit rather than a rule.
///
///   forge script script/Allowlist.s.sol --sig "run()" --rpc-url $RPC_URL
///       prints what the Safe has to schedule, and what anyone executes 48 h later
///
///   forge script script/Allowlist.s.sol --sig "execute()" --rpc-url $RPC_URL --broadcast
///       runs it, once the delay has elapsed
///
/// @dev **Two measurements decide this list, and a stock has to pass both.**
///
///      1. **Depth** — at least $5 000 absorbed before the price moves 1 %.
///         49 of the 194 tokenised stocks pass (`docs/allowlist.md`).
///
///      2. **A 30-minute TWAP that answers.** This one was added during the
///         rehearsal and it removes stocks the depth test had passed. The floor
///         on every leg comes from `TwapFloor.meanTick(pool, 1800)`, which
///         REVERTS when the pool's observation history is shorter than the
///         window. A stock in that state is not "slightly worse": `_swapLeg`
///         catches the revert and skips the leg, so the weight a creator gave it
///         simply never converts, quietly, for as long as the vault lives.
///         Listing it would be handing out a basket with a dead slot in it.
///
///      Both were re-measured against live pools on the date in
///      `docs/allowlist.md`, and this list is generated from that measurement
///      rather than transcribed.
///
///      The `feed` is Chainlink's, `address(0)` where the chain has none — and
///      **that is a supported state, not a hole**: `ARCHITECTURE.md` §S3 already
///      makes the TWAP the primary source, because equity feeds go stale over
///      the weekend and the TWAP never does. Every feed address below was read
///      back through `description()` and `decimals()` before being written
///      here; one of them turned out to be a token address on the first pass.
contract Allowlist is Script {
    /// @dev 46 rows: 45 stocks and $PONS. Generated from the measurement, not
    ///      typed by hand.
    ///
    ///      Two changes on 2026-09-10, in opposite directions. **PFE left**: its
    ///      USDG/3000 pool holds a 64-slot observation ring that spans 10.7 min,
    ///      so it cannot answer a 30-minute window and the leg's weight would
    ///      never convert. Not a depth problem — the pool is too BUSY for its
    ///      buffer. See the note in script/Quotelist.s.sol, which delisted it as
    ///      a quote the same day. **$PONS arrived**, on purpose and on the same
    ///      two measurements as everything else; the note at its row says what
    ///      was read, and why its tier is 10000 rather than 3000.
    ///
    ///      **BA left on 2026-09-11, for PFE's reason exactly.** Its USDG/3000
    ///      pool carries a **32-slot** ring spanning **20.6 min** (measured at
    ///      block 59 798 432: oldest observation 1 489 s old against the 1 800 s
    ///      the window asks for), so `observe([1800, 0])` reverts `OLD`. Not
    ///      depth — $30 031, six times the floor — and BA has NO Chainlink feed,
    ///      so the TWAP is the only floor it has: the leg would be skipped every
    ///      time and its weight would sit in `pivotReserve` for ever.
    ///
    ///      **And it is repairable, which is why this note says how.**
    ///      `increaseObservationCardinalityNext` is permissionless on a v3 pool:
    ///      taking this ring from 32 to 64 slots costs ~640 k gas, and the
    ///      cardinality then grows one slot per swap until the span clears 30
    ///      min on its own. The same holds for PFE. Neither was re-listed here,
    ///      because growing a third party's ring is an on-chain transaction from
    ///      an address of ours and that is a decision, not a fix — see
    ///      DECISIONS.md. Re-listing afterwards is a timelock operation.
    function listings()
        public
        pure
        returns (address[] memory stocks, uint24[] memory poolFees, address[] memory feeds)
    {
        stocks = new address[](46);
        poolFees = new uint24[](46);
        feeds = new address[](46);
        (stocks[0], poolFees[0], feeds[0]) =
        (0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5, 3000, 0xa7a18Ca3F19E17FfA28F92302B817Ca8c1A94b06); // SGOV
        (stocks[1], poolFees[1], feeds[1]) =
        (0xD5f3879160bc7c32ebb4dC785F8a4F505888de68, 500, 0x41ed2c58611790af0760e31e80Bb427e4e83D603); // QQQ
        (stocks[2], poolFees[2], feeds[2]) =
        (0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 500, 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15); // NVDA
        (stocks[3], poolFees[3], feeds[3]) =
        (0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e, 3000, 0x0000000000000000000000000000000000000000); // GLD  // TWAP-only floor
        (stocks[4], poolFees[4], feeds[4]) =
        (0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa, 500, 0x42a95341ff361e81fd934F39943c5C98F6991844); // SPCX
        (stocks[5], poolFees[5], feeds[5]) =
        (0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 3000, 0x4A1166a659A55625345e9515b32adECea5547C38); // TSLA
        (stocks[6], poolFees[6], feeds[6]) =
        (0xCceE82fE024c36fA15E1005edE3E9e4787e23D09, 3000, 0x0000000000000000000000000000000000000000); // HIMS  // TWAP-only floor
        (stocks[7], poolFees[7], feeds[7]) =
        (0x1D11f0496982706C5e14A514D4E79F2e6BdE4516, 10000, 0x0000000000000000000000000000000000000000); // DJT  // TWAP-only floor
        (stocks[8], poolFees[8], feeds[8]) =
        (0x1b0E319c6A659F002271B69dB8A7df2F911c153E, 500, 0x27C71df6A64fB476468EdF256CF72c038baB5B67); // GME
        (stocks[9], poolFees[9], feeds[9]) =
        (0x12f190a9F9d7D37a250758b26824B97CE941bF54, 3000, 0x9244830430bC7D9C9A48dd47603F24AD61f7c56e); // AMZN
        (stocks[10], poolFees[10], feeds[10]) =
        (0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD, 3000, 0x0000000000000000000000000000000000000000); // MU  // TWAP-only floor
        (stocks[11], poolFees[11], feeds[11]) =
        (0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B, 3000, 0x0000000000000000000000000000000000000000); // AMC  // TWAP-only floor
        (stocks[12], poolFees[12], feeds[12]) =
        (0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C, 10000, 0x0000000000000000000000000000000000000000); // RDDT  // TWAP-only floor
        (stocks[13], poolFees[13], feeds[13]) =
        (0x4e62068525Ab11FE768e29dfD00ef909B9803016, 3000, 0x0000000000000000000000000000000000000000); // LULU  // TWAP-only floor
        (stocks[14], poolFees[14], feeds[14]) =
        (0x5e81213613b6B86EaB4c6c50d718d34359459786, 3000, 0x0000000000000000000000000000000000000000); // TTWO  // TWAP-only floor
        (stocks[15], poolFees[15], feeds[15]) =
        (0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619, 3000, 0x0000000000000000000000000000000000000000); // IBM  // TWAP-only floor
        (stocks[16], poolFees[16], feeds[16]) =
        (0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2, 3000, 0x0000000000000000000000000000000000000000); // COST  // TWAP-only floor
        // **Re-pinned 10000 -> 500 on 2026-09-11, and it is the largest saving
        // on the list.** `script/CheckTiers.s.sol` at the quoter, over 500 USDG:
        // tier 10000 returns 439050991224525348, tier 500 returns
        // 444809176743369313 — **+131.2 bps on every purchase**, for ever, paid
        // by the holders while it stood. LLY carries **no Chainlink feed**, so
        // the ring is its only floor: tier 500 holds 1 800 observations and
        // answers `observe([1800, 0])`, which is what made the move safe rather
        // than merely cheap.
        (stocks[17], poolFees[17], feeds[17]) =
        (0x8005d266423c7ea827372c9c864491e5786600ea, 500, 0x0000000000000000000000000000000000000000); // LLY  // TWAP-only floor
        (stocks[18], poolFees[18], feeds[18]) =
        (0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4, 3000, 0x0000000000000000000000000000000000000000); // BABA  // TWAP-only floor
        (stocks[19], poolFees[19], feeds[19]) =
        (0xe93237C50D904957Cf27E7B1133b510C669c2e74, 3000, 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E); // MSFT
        (stocks[20], poolFees[20], feeds[20]) =
        (0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f, 3000, 0x209b73908e92Ae021826eD79609845451Ecba2ce); // SLV
        (stocks[21], poolFees[21], feeds[21]) =
        (0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344, 3000, 0x6D054DECb74Cf8ef3675B0Abc100e02921176EdF); // USO
        (stocks[22], poolFees[22], feeds[22]) =
        (0x117cc2133c37B721F49dE2A7a74833232B3B4C0C, 500, 0x319724394D3A0e3669269846abE664Cd621f9f6A); // SPY
        (stocks[23], poolFees[23], feeds[23]) =
        (0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 500, 0xF6f373a037c30F0e5010d854385cA89185AE638b); // GOOGL
        (stocks[24], poolFees[24], feeds[24]) =
        (0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8, 3000, 0x0000000000000000000000000000000000000000); // RBLX  // TWAP-only floor
        (stocks[25], poolFees[25], feeds[25]) =
        (0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd, 10000, 0x0000000000000000000000000000000000000000); // DELL  // TWAP-only floor
        (stocks[26], poolFees[26], feeds[26]) =
        (0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8, 3000, 0x0000000000000000000000000000000000000000); // NFLX  // TWAP-only floor
        (stocks[27], poolFees[27], feeds[27]) =
        (0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5, 3000, 0x025Ba3B3569Ca7d15Da7BFC1648F13F06A072851); // CRCL
        (stocks[28], poolFees[28], feeds[28]) =
        (0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A, 3000, 0x820ABedFF239034956B7A9d2F0a331f9F075eB4c); // PLTR
        (stocks[29], poolFees[29], feeds[29]) =
        (0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 500, 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0); // AAPL
        (stocks[30], poolFees[30], feeds[30]) =
        (0x41F4267525a8AFf329540eF24fD83d9044758B33, 3000, 0x0000000000000000000000000000000000000000); // FIG  // TWAP-only floor
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
        (stocks[31], poolFees[31], feeds[31]) =
        (0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80, 3000, 0x0000000000000000000000000000000000000000); // JNJ  // TWAP-only floor
        (stocks[32], poolFees[32], feeds[32]) =
        (0xec262a75e413fAfD0dF80480274532C79D42da09, 10000, 0x2521a77F42098357e83bDea7fBb2A38745bf9280); // MSTR
        (stocks[33], poolFees[33], feeds[33]) =
        (0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B, 10000, 0x0000000000000000000000000000000000000000); // RIVN  // TWAP-only floor
        (stocks[34], poolFees[34], feeds[34]) =
        (0x86923f96303D656E4aa86D9d42D1e57ad2023fdC, 3000, 0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72); // AMD
        (stocks[35], poolFees[35], feeds[35]) =
        (0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 3000, 0x5cBC53D382E56cBb223f118CF8Eefb6c9c2759f5); // META
        (stocks[36], poolFees[36], feeds[36]) =
        (0xF6589F11Bc40b669e584073F428B05562F568733, 3000, 0x0000000000000000000000000000000000000000); // SNAP  // TWAP-only floor
        (stocks[37], poolFees[37], feeds[37]) =
        (0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E, 3000, 0x0000000000000000000000000000000000000000); // WYFI  // TWAP-only floor
        // Re-pinned 10000 -> 3000 on 2026-09-11, same measurement: 4954232596511997539
        // against 4976839323608067841 at the quoter over 500 USDG, **+45.6 bps**.
        // TWAP-only like LLY, and tier 3000 carries 1 400 observations and serves
        // the window.
        (stocks[38], poolFees[38], feeds[38]) =
        (0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2, 3000, 0x0000000000000000000000000000000000000000); // UPS  // TWAP-only floor
        (stocks[39], poolFees[39], feeds[39]) =
        (0xd917B029C761D264c6A312BBbcDA868658eF86a6, 3000, 0x0000000000000000000000000000000000000000); // USAR  // TWAP-only floor
        (stocks[40], poolFees[40], feeds[40]) =
        (0x25C288E6D899b9BC30160965aD9644c67e73bE0C, 10000, 0x0000000000000000000000000000000000000000); // F  // TWAP-only floor
        (stocks[41], poolFees[41], feeds[41]) =
        (0x822CC93fFD030293E9842c30BBD678F530701867, 3000, 0x0000000000000000000000000000000000000000); // BE  // TWAP-only floor
        (stocks[42], poolFees[42], feeds[42]) =
        (0x58FfE4a942d3885bAa22D7520691F611EF09e7AA, 10000, 0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F); // TSM
        (stocks[43], poolFees[43], feeds[43]) =
        (0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8, 3000, 0x0000000000000000000000000000000000000000); // SKHY  // TWAP-only floor
        (stocks[44], poolFees[44], feeds[44]) =
        (0x62fd0668e10D8B72339BE2DCF7643001688ff13B, 3000, 0x0000000000000000000000000000000000000000); // MRVL  // TWAP-only floor
        // **$PONS, and it is not a stock.** Added 2026-09-10, deliberately: it
        // is the token of the launchpad that hosts every vault here, and a
        // creator who wants their holders paid partly in it should be able to
        // say so. Nothing in this list ever required an equity -- the two
        // measurements above ask about a POOL, and it passes both.
        //
        // Measured the same day on the real pools, tier by tier:
        //   tier   3000 : L 1.78e16, `observe([1800, 0])` REVERTS -- no window
        //   tier  10000 : L 6.42e18, window alive, depth $24 384 before +1 %
        // and at the quoter over 500 USDG the 1 % tier returns 853.5 PONS
        // against 831.1 at 0.3 % -- **deeper AND cheaper**, which is exactly the
        // case `script/CheckTiers.s.sol` was written to catch. Pinning 3000
        // because it is the smaller fee would have handed out a basket whose
        // $PONS leg is skipped in silence for the vault's whole life.
        //
        // No Chainlink feed exists for it, so the floor is the 30-minute TWAP --
        // the supported state, not a hole, and here it is the BETTER one: the
        // equity feeds go stale from Friday night to Monday and this pool does
        // not.
        //
        // This is not `Quotelist`, and that difference is the whole point of
        // adding it here. $PONS was DELISTED as a quote the same day because
        // Pons's factory refuses its own token as a `pairToken` -- nobody can
        // LAUNCH paired against it. Buying it for holders asks nothing of Pons.
        (stocks[45], poolFees[45], feeds[45]) =
        (0x39dBED3a2bd333467115dE45665cC57F813C4571, 10000, 0x0000000000000000000000000000000000000000); // PONS  // TWAP-only floor
    }

    /// @notice What the timelock will call on the Payd.
    function payload() public pure returns (bytes memory) {
        (address[] memory stocks, uint24[] memory poolFees, address[] memory feeds) = listings();
        return abi.encodeCall(Payd.allowStocks, (stocks, poolFees, feeds));
    }

    /// @dev A fixed salt, so the operation id is reproducible: anybody can
    ///      recompute it from this repository and check that what the Safe
    ///      scheduled is what this file says. A random salt would make the
    ///      proposal unverifiable by a third party, which is the whole point of
    ///      a 48-hour delay.
    bytes32 public constant SALT = keccak256("payd.registry.allowlist.v1");

    function run() external view {
        address pad = vm.envAddress("REGISTRY");
        address timelock = vm.envAddress("TIMELOCK");
        bytes memory data = payload();

        (address[] memory stocks,,) = listings();
        console.log("stocks in this operation", stocks.length);
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

        (address[] memory stocks,,) = listings();
        console.log("listed", stocks.length);
    }
}
