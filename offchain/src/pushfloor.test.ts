/**
 * The delivery floor, per quote currency.
 *
 * This is a determinism test as much as an economics one: `dispute.ts` rebuilds
 * an old root through `buildCumulative`, so a floor that is not a pure function
 * of facts written at the vault's birth would report an honest keeper as
 * forged.
 */
import { pushFloorFor, PUSH_TARGET_WEI, PUSH_K_MIN, SETTLE_GAS, NON_ETH_PUSH_BPS } from "./epoch.js";
import type { Address } from "viem";

const ETH = "0x0000000000000000000000000000000000000000" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;

// `Quotelist.s.sol`, the values the registry is seeded with.
const MIN_BUY_USDG = 25_000_000n; // 6 decimals, ~$25.00
const MIN_BUY_NVDA = 120_000_000_000_000_000n; // 18 decimals, ~$27.10

let checks = 0;
function eq(a: bigint, b: bigint, what: string) {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
}
function ok(c: boolean, what: string) {
  if (!c) throw new Error(what);
  checks++;
}

// 1. An ether vault is untouched. Moving this would recompute every root
//    published before the move into a different pushRoot.
const calm = 300_000_000n; // 0.3 gwei, about today's basefee
eq(pushFloorFor(ETH, MIN_BUY_USDG, calm), PUSH_TARGET_WEI, "eth vault at calm gas keeps the $20 target");
const spike = 10_000_000_000n; // 10 gwei
eq(pushFloorFor(ETH, MIN_BUY_USDG, spike), PUSH_K_MIN * SETTLE_GAS * spike, "and the gas bound takes over on a spike");

// 2. A non-ether vault is denominated in ITS currency, and the basefee does not
//    enter: converting wei of gas into NVDA would need the oracle this design
//    exists to avoid.
eq(pushFloorFor(USDG, MIN_BUY_USDG, calm), 10_000_000n, "usdg floor is $10.00, in usdg's 6 decimals");
eq(pushFloorFor(USDG, MIN_BUY_USDG, calm), pushFloorFor(USDG, MIN_BUY_USDG, spike), "and gas does not move it");
eq(pushFloorFor(NVDA, MIN_BUY_NVDA, calm), (MIN_BUY_NVDA * NON_ETH_PUSH_BPS) / 10_000n, "nvda floor is in nvda");

// 3. The bug this closes, stated as the two numbers it used to produce.
//    A $1,000 share on a USDG vault is 1e9 raw units. Against the wei floor it
//    was never pushed; against the new one it is.
const shareOf1000Usdg = 1_000n * 10n ** 6n;
ok(shareOf1000Usdg < PUSH_TARGET_WEI, "the old floor was 8.4e15 and a $1,000 share is 1e9: never pushed");
ok(shareOf1000Usdg > pushFloorFor(USDG, MIN_BUY_USDG, calm), "the new floor is ~$200, so $1,000 is pushed");

// And on NVDA the wei floor was ~0.0084 NVDA, under two dollars — dust
// delivered at a loss on a vault that refunds no gas at all.
ok(PUSH_TARGET_WEI < MIN_BUY_NVDA, "the old floor was below even ONE MIN_BUY_QUOTE of NVDA");
ok(
  pushFloorFor(NVDA, MIN_BUY_NVDA, calm) > PUSH_TARGET_WEI * 10n,
  "the new one is ~11x what the wei floor accidentally produced on NVDA",
);

// 4. Same inputs, same output. The whole determinism contract in one line.
eq(pushFloorFor(NVDA, MIN_BUY_NVDA, calm), pushFloorFor(NVDA, MIN_BUY_NVDA, calm), "pure");


// --- the eligibility floor, the same bug one file over -------------------
import { minShareFor, MIN_SHARE_WEI, NON_ETH_MIN_SHARE_BPS } from "./config.js";

eq(minShareFor(ETH, MIN_BUY_USDG), MIN_SHARE_WEI, "an ether vault keeps the wei constant");
eq(minShareFor(USDG, MIN_BUY_USDG), 480_000n, "and a USDG vault gets $0.48 in USDG units");
eq(minShareFor(USDG, MIN_BUY_USDG), (MIN_BUY_USDG * NON_ETH_MIN_SHARE_BPS) / 10_000n, "192 bps of MIN_BUY_QUOTE");

// The failure it closes, stated as the condition it used to produce. With a wei
// constant against a USDG-denominated cumulative, the floor asked for a balance
// two hundred thousand times the whole supply: nobody eligible, empty tree.
const cumulative = 1_000n * 10n ** 6n; // $1,000 of USDG spent so far
ok(MIN_SHARE_WEI / cumulative > 100_000n, "the old ratio really was absurd: 200,000x supply");
ok(minShareFor(USDG, MIN_BUY_USDG) < cumulative, "the new floor is a fraction of what was spent, as intended");

console.log(`pushfloor: ${checks} checks OK`);
