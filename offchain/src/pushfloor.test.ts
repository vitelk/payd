/**
 * The delivery floor, per quote currency.
 *
 * This is a determinism test as much as an economics one: `dispute.ts` rebuilds
 * an old root through `buildCumulative`, so a floor that is not a pure function
 * of facts written at the vault's birth would report an honest keeper as
 * forged.
 */
import { pushFloorFor, pushFloorParts, PUSH_TARGET_WEI, PUSH_K_MIN, SETTLE_GAS, NON_ETH_PUSH_BPS } from "./epoch.js";
import { PORTFOLIO_PUSH_TARGET_DIV } from "./buildroot.js";
import { lineFloor } from "./portfolio.js";
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
eq(pushFloorFor(ETH, MIN_BUY_USDG, calm), PUSH_TARGET_WEI, "eth vault at calm gas keeps the $10 target");
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



// --- the floor overrides, the one-off sweeps ----------------------------
//
// Tested through `pushSetWhole` and not through the table alone: what matters
// is which shares actually land in the push set, which is a claim about the
// override replacing BOTH halves of the floor.
import { floorOverride, PUSH_FLOOR_OVERRIDES, pushSetWhole } from "./epoch.js";

eq(floorOverride(46) ?? -1n, 0n, "46 was swept at zero and is frozen there");
eq(floorOverride(58) ?? -1n, PUSH_TARGET_WEI / 10n, "58 is swept at ~$1");
eq(floorOverride(60) ?? -1n, PUSH_TARGET_WEI / 10n, "60 re-runs it, 58 having delivered nothing");
ok(floorOverride(57) === undefined && floorOverride(59) === undefined, "the standing floor either side");
ok(floorOverride(61) === undefined, "and back to $10 straight after 60");
eq(floorOverride(155) ?? -1n, PUSH_TARGET_WEI / 10n, "155 is the ~$1 sweep of 2026-09-16");
ok(floorOverride(154) === undefined && floorOverride(156) === undefined, "one epoch, and one only");

const H1 = "0x1111111111111111111111111111111111111111" as Address;
const H2 = "0x2222222222222222222222222222222222222222" as Address;
const H3 = "0x3333333333333333333333333333333333333333" as Address;
const H4 = "0x4444444444444444444444444444444444444444" as Address;
// One leg, 0.21 ETH spent on 3.34 units of it: root #38's SPCX line.
const SPCX = "0x4a0E65a3ECcEC6DBE60Ae065f2E7bB85fAE35EEA" as Address;
const quoteOf = new Map([[SPCX.toLowerCase(), 210_807_904_363_802_573n]]);
const cumOf = new Map([[SPCX.toLowerCase(), 3_336_353_184_592_785_000n]]);
const entries = [
  { holder: H1, stock: SPCX, cumulative: 190_000_000_000_000n }, // ~$0.03
  { holder: H2, stock: SPCX, cumulative: 30_000_000_000_000_000n }, // ~$4.7
  { holder: H3, stock: SPCX, cumulative: 76_000_000_000_000_000n }, // ~$12
  // ~$1.20: above the $1.05 row, below the $1.40 the gas bound would impose.
  // This holder is the whole point of the two assertions further down.
  { holder: H4, stock: SPCX, cumulative: 7_600_000_000_000_000n },
];
const paid = new Map<string, bigint>();
const k = (h: Address) => `${h.toLowerCase()}:${SPCX.toLowerCase()}`;

const floored = pushSetWhole(entries, paid, quoteOf, cumOf, PUSH_TARGET_WEI, PUSH_K_MIN * SETTLE_GAS * calm);
eq(BigInt(floored.size), 1n, "standing floor: only the $12 holder");

const swept = pushSetWhole(entries, paid, quoteOf, cumOf, 0n, 0n);
eq(BigInt(swept.size), 4n, "epoch 46's floor of zero: all four");

// The row this change exists for. $1 takes the middle holder and leaves the
// three-cent one, which is the entire economic argument in one assertion.
const dollar = pushSetWhole(entries, paid, quoteOf, cumOf, PUSH_TARGET_WEI / 10n, 0n);
eq(BigInt(dollar.size), 3n, "epoch 58's floor of ~$1: the $1.20, the $4.7 and the $12");
ok(dollar.has(k(H4)), "the $1.20 holder is exactly what this row is for");
ok(!dollar.has(k(H1)), "and the $0.03 share stays in the tail, where claim is open for it");

// Carrying the gas bound into an override would defeat it: at `calm` the bound
// is ~$0.39 a pair, so a $1 row would gate at $0.39-per-leg instead of $1.
ok(PUSH_K_MIN * SETTLE_GAS * calm > PUSH_TARGET_WEI / 10n, "the gas bound at calm exceeds the $1 row");
const withBound = pushSetWhole(entries, paid, quoteOf, cumOf, PUSH_TARGET_WEI / 10n, PUSH_K_MIN * SETTLE_GAS * calm);
eq(BigInt(withBound.size), 2n, "keeping the bound silently raises the $1.05 row to $1.40");
ok(!withBound.has(k(H4)), "and drops the holder the row was written for — hence the override replaces it");

// The overrides are WAIVERS, not amnesties: a pair already settled stays out.
const settled = new Map([[k(H3), 76_000_000_000_000_000n]]);
eq(BigInt(pushSetWhole(entries, settled, quoteOf, cumOf, 0n, 0n).size), 3n, "an already-paid pair is not re-pushed");

ok(PUSH_FLOOR_OVERRIDES.get(46) === 0n, "and 46's published value is never edited");

// ---------------------------------------------------------------------------
// The portfolio mode's target, and the one invariant it has to satisfy.
//
// This mode is the only one whose push tree grants PERMISSION rather than
// deciding the spend: an entry is a pivot balance that `stepConvert` then cuts
// into one swap per stock the holder named, and it is those slices that carry
// the gas. So the tree has to sit BELOW the per-line floor, or it becomes the
// binding gate in silence and the measured economics in `portfolio.ts` stop
// being what actually runs.

eq(PORTFOLIO_PUSH_TARGET_DIV, 10n, "a tenth of the standard target, i.e. ~$1 of outstanding pivot");

// 1. It divides the product target in BOTH currencies, which is why it is a
//    divisor and not an amount: the caller that knows the mode does not know
//    the vault's currency.
eq(
  pushFloorParts(ETH, MIN_BUY_USDG, calm, PORTFOLIO_PUSH_TARGET_DIV).target,
  PUSH_TARGET_WEI / 10n,
  "an ether portfolio vault targets a tenth of the wei target",
);
eq(
  pushFloorParts(USDG, MIN_BUY_USDG, calm, PORTFOLIO_PUSH_TARGET_DIV).target,
  1_000_000n,
  "and a usdg one targets $1.00 in usdg's 6 decimals",
);

// 2. **The gas bound does NOT follow the divisor.** A mode may decide its
//    holders are worth pushing at $1; it may not decide they are worth pushing
//    at a loss. On a spike the bound takes over for a portfolio vault exactly
//    as it does for any other, and the 95 % guarantee is untouched.
eq(
  pushFloorParts(ETH, MIN_BUY_USDG, spike, PORTFOLIO_PUSH_TARGET_DIV).perDelivery,
  PUSH_K_MIN * SETTLE_GAS * spike,
  "the gas bound is not divided",
);
eq(
  pushFloorFor(ETH, MIN_BUY_USDG, spike, PORTFOLIO_PUSH_TARGET_DIV),
  PUSH_K_MIN * SETTLE_GAS * spike,
  "so on a spike it is what the portfolio floor becomes, target or no target",
);

// 3. THE INVARIANT: the tree is under the planner, so the planner is the gate.
//    Comparable directly on a usdg-quoted vault, where the quote IS the pivot
//    and both numbers are in the same six decimals.
ok(
  pushFloorParts(USDG, MIN_BUY_USDG, calm, PORTFOLIO_PUSH_TARGET_DIV).target < lineFloor(6),
  "the push tree admits a holder for less than one line costs to convert",
);

// 4. And no other mode moved: passing no divisor is the number every root
//    published so far was built with.
eq(pushFloorFor(ETH, MIN_BUY_USDG, calm), PUSH_TARGET_WEI, "an ordinary vault is untouched by any of this");
eq(pushFloorFor(USDG, MIN_BUY_USDG, calm), 10_000_000n, "in either currency");

console.log(`pushfloor: ${checks} checks OK`);
