/**
 * The purchase thresholds, both quote shapes.
 *
 * Each block below is a bug that was live, not a hypothetical: the keeper read
 * `MIN_BUY` where the contract uses `MIN_BUY_QUOTE`, held back `MAX_REFUND` on
 * a vault that holds no wei, and compared a QUOTE amount to a wei gas cost.
 * Together they made it skip every non-ether vault on every tick, silently.
 */
import { buyDecision, payCreatorDecision, maxSpendForDepth, slotsForWindow, GAS_K_MIN_EPOCH, MAX_LEG_DEPTH_BPS, NON_ETH_BUY_TARGET_MULTIPLE, NON_ETH_BUY_MAX_WAIT_MS, BUY_BASKET_GAS } from "./buy.js";
import type { Address } from "viem";

const ETH = "0x0000000000000000000000000000000000000000" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;

const MAX_REFUND = 10n ** 16n; // 0.01 ether
const MIN_BUY_WEI = 10n ** 16n; // an ether vault's MIN_BUY_QUOTE
const MIN_BUY_USDG = 25_000_000n; // ~$25, 6 decimals
const BASEFEE = 129_856_000n; // 0.129856 gwei, 2026-09-11
const GAS = BUY_BASKET_GAS * BASEFEE;
const PAYOUT = 400n; // 4 %

let checks = 0;
const ok = (c: boolean, what: string) => {
  if (!c) throw new Error(what);
  checks++;
};

// `sinceLastBuyMs: 0` — just bought, so the DEADLINE never fires and every
// block below tests the size rule alone. Block 6 varies it on purpose.
const usdg = (pool: bigint) =>
  buyDecision({ pool, payoutBps: PAYOUT, maxRefund: MAX_REFUND, minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS, sinceLastBuyMs: 0 });
const eth = (pool: bigint) =>
  buyDecision({ pool, payoutBps: PAYOUT, maxRefund: MAX_REFUND, minBuyQuote: MIN_BUY_WEI, quote: ETH, gasCost: GAS });

// 1. THE BUG. A USDG vault with $1,000 of reserve used to fail `pool <=
//    maxRefund` — 1e9 against 1e16 — and return on every tick, for ever.
const thousandDollars = 1_000n * 10n ** 6n;
ok(thousandDollars <= MAX_REFUND, "1e9 really is under the wei constant: that is why it never fired");
// With the right unit it gets as far as the ECONOMIC test instead of failing a
// units one — and is declined there, because 4 % of $1,000 is a $39 purchase
// and $39 of basket does not pay for $0.841 of gas at a 70 bps bounty. The
// distinction matters: one is a bug, the other is the rule working.
const d0 = usdg(thousandDollars);
ok(d0.buy === false && d0.why.includes("gas/bounty"), "it reaches the economic test, and that one declines it");

// 2. The hold-back mirrors the contract: MIN_BUY_QUOTE on a non-ether vault,
//    MAX_REFUND on an ether one. Under it, there is nothing to do.
ok(usdg(MIN_BUY_USDG).buy === false, "a reserve at exactly the hold-back is not spendable");
ok(usdg(MIN_BUY_USDG - 1n).buy === false, "nor under it");

// 3. `gas / bounty`: a purchase under 5 x MIN_BUY_QUOTE is declined. At $25 of
//    basket for $0.841 of gas and $0.175 of bounty, it loses $0.67.
//
//    The fixtures are RESERVES, and the threshold applies to what the contract
//    would SPEND — `payoutBps` of the free reserve. At 4 % a reserve carries
//    twenty-five times the purchase, which is why the numbers below look large
//    beside a $125 threshold, and is the whole of what the wait costs.
const target = MIN_BUY_USDG * NON_ETH_BUY_TARGET_MULTIPLE; // $125 of purchase
const reserveFor = (spend: bigint) => (spend * 10_000n) / PAYOUT + MIN_BUY_USDG;

const d1 = usdg(reserveFor(target) - 10_000_000n);
ok(d1.buy === false && !d1.buy && d1.why.includes("gas/bounty"), "under the threshold, and for the stated reason");
const d2 = usdg(reserveFor(target));
ok(d2.buy === true, "and at it, the purchase goes");
ok(d2.buy === true && d2.amountIn >= target, "for at least the threshold");

// 4. The ether path is UNCHANGED — it is refunded at true cost, so its rule is
//    only about not spending a fixed-cost transaction on dust.
const ethBig = MAX_REFUND + GAS_K_MIN_EPOCH * GAS * 30n;
ok(eth(ethBig).buy === true, "a large ether reserve still buys");
ok(eth(MAX_REFUND).buy === false, "and MAX_REFUND is still what it holds back");

// 5. What the fraction does: 4 % of free, lifted to the floor, never above free.
const d3 = usdg(100_000n * 10n ** 6n); // $100,000 of reserve
ok(d3.buy === true && d3.amountIn === ((100_000n * 10n ** 6n - MIN_BUY_USDG) * PAYOUT) / 10_000n, "4 % of free");



// 6. THE DEADLINE. A vault under the target is held back — but only until it
//    has waited. The target is a goal, not a gate: as a gate it stranded every
//    token that never reaches $67,000 of lifetime volume, which is most of
//    them, and stranding means holders with nothing to CLAIM, not just no
//    airdrop.
const smallPool = MIN_BUY_USDG * 3n; // $75: the contract would buy $25 of it
const held = buyDecision({
  pool: smallPool, payoutBps: PAYOUT, maxRefund: MAX_REFUND,
  minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS, sinceLastBuyMs: 60_000,
});
ok(held.buy === false, "a minute after the last purchase, it waits for a bigger one");

const due = buyDecision({
  pool: smallPool, payoutBps: PAYOUT, maxRefund: MAX_REFUND,
  minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS,
  sinceLastBuyMs: NON_ETH_BUY_MAX_WAIT_MS + 1,
});
ok(due.buy === true, "a day later it buys anyway, rather than strand the holders");
ok(due.buy === true && due.amountIn === MIN_BUY_USDG, "at the contract's own floor, which is $25 and not $3,150");

// A vault that has never bought is never held back: its first purchase is the
// moment its holders stop having nothing.
const first = buyDecision({
  pool: smallPool, payoutBps: PAYOUT, maxRefund: MAX_REFUND,
  minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS, sinceLastBuyMs: Number.POSITIVE_INFINITY,
});
ok(first.buy === true, "and the first purchase of a vault's life is never delayed");


// 7. `payCreator`, the fifth place the same mismatch was written. A $500
//    residue on a USDG vault is 5e8; the wei bar is 1.04e14. The creator was
//    never paid, on any non-ether vault, ever.
const DEV_BAR_WEI = 20n * 40_000n * BASEFEE;
ok(500n * 10n ** 6n < DEV_BAR_WEI, "a $500 residue really is under the wei bar");
ok(payCreatorDecision(500n * 10n ** 6n, USDG, MIN_BUY_USDG, DEV_BAR_WEI) === true, "and with a currency it pays");
ok(payCreatorDecision(1n, USDG, MIN_BUY_USDG, DEV_BAR_WEI) === false, "dust still waits");
ok(payCreatorDecision(0n, USDG, MIN_BUY_USDG, DEV_BAR_WEI) === false, "and zero is never a payment");
// The ether path keeps the real gas bar, which is the thing it can measure.
ok(payCreatorDecision(DEV_BAR_WEI, ETH, MIN_BUY_WEI, DEV_BAR_WEI) === true, "an ether vault pays at its gas bar");
ok(payCreatorDecision(DEV_BAR_WEI - 1n, ETH, MIN_BUY_WEI, DEV_BAR_WEI) === false, "and not under it");


// 8. T-TWAP-01 — the depth clamp. `FeeVault._legFloor` tolerates a CONSTANT
//    300 bps while the leg scales with the reserve, and the on-chain fix does
//    not fit (+876 bytes, 24 842 against a 24 576 cap). So the bound is here.
{
  // MRVL's depth at +1 %, as re-measured at block 60310000: 841.86 USDG, not
  // the allowlist's 2026-09-08 photograph of $5 312. A 90 % leg may spend one
  // whole depth, so the purchase caps at depth * 10_000 / 9_000.
  const MRVL_DEPTH = 841_864_408n;
  const cap = maxSpendForDepth([{ bps: 9_000n, depth: MRVL_DEPTH }, { bps: 1_000n, depth: 0n }]);
  ok(cap === (MRVL_DEPTH * MAX_LEG_DEPTH_BPS) / 9_000n, "the thinnest leg sets the cap");
  ok(cap !== undefined && cap > MRVL_DEPTH, "a 90 % leg means the PURCHASE may exceed one leg's depth");
  // The steady-state purchase of AUDIT_PLAN.md 2.4 -- ~$333, a $300 leg at
  // 35.6 % of this depth, filling 11 bps off -- must pass untouched, or the
  // clamp slices every ordinary window to buy nothing.
  ok(333n * 10n ** 6n < cap!, "the steady-state purchase is not clamped");

  // A leg with no measurable depth is skipped, not read as zero: otherwise one
  // unreadable pool clamps every purchase to the floor for ever.
  ok(maxSpendForDepth([{ bps: 10_000n, depth: 0n }]) === undefined, "an unmeasurable pool clamps nothing");
  ok(maxSpendForDepth([]) === undefined, "and neither does an empty basket");

  // The clamp SHRINKS the purchase rather than refusing it. §2.4's own figure:
  // a $177k free reserve at MAX_PAYOUT_BPS asks for a $17.7k purchase.
  const BIG = 177_000n * 10n ** 6n;
  const unclamped = buyDecision({
    pool: BIG, payoutBps: 1_000n, maxRefund: MAX_REFUND,
    minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS, sinceLastBuyMs: Number.POSITIVE_INFINITY,
  });
  ok(unclamped.buy === true && unclamped.amountIn > cap!, "unclamped, the contract would spend past the cap");

  const clamped = buyDecision({
    pool: BIG, payoutBps: 1_000n, maxRefund: MAX_REFUND,
    minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS, sinceLastBuyMs: Number.POSITIVE_INFINITY,
    maxAmountIn: cap,
  });
  ok(clamped.buy === true, "clamped, it still buys -- refusing would strand a reserve that only grows");
  ok(clamped.buy === true && clamped.amountIn === cap, "at exactly the cap");

  // And never under the contract's own floor, which is what `spent_` would
  // take anyway.
  const tiny = buyDecision({
    pool: BIG, payoutBps: 1_000n, maxRefund: MAX_REFUND,
    minBuyQuote: MIN_BUY_USDG, quote: USDG, gasCost: GAS, sinceLastBuyMs: Number.POSITIVE_INFINITY,
    maxAmountIn: 1n,
  });
  ok(tiny.buy === true && tiny.amountIn === MIN_BUY_USDG, "a cap under MIN_BUY_QUOTE buys at MIN_BUY_QUOTE");
}


// 9. T-HYP-02 — the ring, and the fact that BUSY is what breaks it.
{
  const WINDOW = 1_800n;

  // The measurement that settled the hypothesis: PFE/USDG, a LISTED QUOTE, 64
  // slots spanning 943 seconds on 2026-09-10. Green for weeks; nothing got
  // worse, it got busier.
  const need = slotsForWindow(943n, 64n, WINDOW);
  ok(need > 64n, "a ring that spans 943 s of a 1 800 s window has to grow");
  // 64 slots per 943 s -> 2 160 s wanted (1 800 + 20 %) needs ~147.
  ok(need === (64n * 2_160n + 942n) / 943n, "and it grows in proportion to the density it is showing");

  // A ring with room to spare is left alone: growing it costs gas and buys
  // nothing, and the call is permissionless so somebody pays for it.
  ok(slotsForWindow(3_600n, 200n, WINDOW) === 0n, "a ring with twice the window needs nothing");
  ok(slotsForWindow(2_160n, 200n, WINDOW) === 0n, "exactly at the margin is enough");
  ok(slotsForWindow(2_159n, 200n, WINDOW) > 0n, "one second under it is not");

  // Degenerate rings: a pool that has never traded has no density to scale
  // from, so ask for the window at one observation a second — v3's densest.
  ok(slotsForWindow(0n, 100n, WINDOW) === 2_160n, "no history: ask for the window at one observation a second");
  ok(slotsForWindow(1n, 0n, WINDOW) === 0n, "and a pool with no ring at all is not ours to fix");

  // The pool takes a uint16, so the ask is capped rather than reverting.
  ok(slotsForWindow(1n, 60_000n, WINDOW) === 65_535n, "the ask is capped at what the pool can hold");
}

console.log(`buy: ${checks} checks OK`);
