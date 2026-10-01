/** Keeper economics helpers. `pnpm --filter offchain test` */
import assert from "node:assert/strict";
import { l1PricerAlert, L1_WARN_EVERY_TICKS, gasRunwayAlert, GAS_WARN_TICKS, GAS_CRITICAL_TICKS } from "./epoch.js";
import { reclaimUndeliverable } from "./epoch.js";
import { key, type Entry } from "./merkle.js";
import type { Address } from "viem";

// L1 PRICER — the one chain setting that would break the push economics in
// silence.
//
// This is the half of the control a fork test cannot give us. On-chain the
// value is 0 and will stay 0 as long as the operator leaves it alone, so a test
// against the real precompile can only ever exercise the branch that says
// "nothing to report" — it would pass for the wrong reason, forever. The branch
// worth proving is the one no environment we can reach will produce.
{
  // Off: silent, whatever the history. The common case, every tick, for months.
  assert.ok(!l1PricerAlert(null, 0n, 0), "off on the first read must be silent");
  assert.ok(!l1PricerAlert(0n, 0n, 10_000), "off and long silent must stay silent");
  assert.ok(!l1PricerAlert(7n, 0n, 0), "switching back OFF is not itself a warning");

  // On: the flip must speak immediately, from either starting point.
  assert.ok(l1PricerAlert(0n, 1n, 0), "off -> on must warn at once, even at one wei");
  assert.ok(l1PricerAlert(null, 5n, 0), "already on at startup must warn: a restart re-announces it");

  // Still on: hourly, so a `tail` of the log shows it and not only the log of
  // the hour it started.
  assert.ok(!l1PricerAlert(5n, 5n, L1_WARN_EVERY_TICKS - 1), "still on, under the hour: no spam");
  assert.ok(l1PricerAlert(5n, 5n, L1_WARN_EVERY_TICKS), "still on, at the hour: repeat");
  assert.ok(l1PricerAlert(5n, 9n, L1_WARN_EVERY_TICKS + 40), "still on and overdue: repeat");
}

// KEEPER GAS RUNWAY — the failure that is invisible from outside. Out of gas
// the container does not crash: it loops, every send fails, and roots stop
// being published while the process looks alive. The branches worth proving are
// the two that must stay SILENT, because a warning nobody trusts is a warning
// nobody reads.
{
  // Nothing observed yet, or nothing burnt at all: silent. The second case is
  // the good one -- every call fully refunded -- and it must never look like an
  // alarm.
  assert.ok(!gasRunwayAlert(null, 0), "no burn observed yet must be silent");
  assert.ok(!gasRunwayAlert(null, 10_000), "a long stretch of full refunds must stay silent");

  // Comfortable: silent, whatever the tick count.
  assert.ok(!gasRunwayAlert(GAS_WARN_TICKS + 1, 0), "above the threshold must be silent");
  assert.ok(!gasRunwayAlert(100_000, L1_WARN_EVERY_TICKS * 100), "a huge runway must never warn");

  // Low: hourly, so a tail of the log shows it and not only the hour it started.
  assert.ok(!gasRunwayAlert(GAS_WARN_TICKS - 1, L1_WARN_EVERY_TICKS - 1), "low, under the hour: no spam");
  assert.ok(gasRunwayAlert(GAS_WARN_TICKS - 1, L1_WARN_EVERY_TICKS), "low, at the hour: repeat");

  // Critical: every tick, rate limit ignored. At this point the cost of one
  // more log line is nothing against the cost of missing it.
  assert.ok(gasRunwayAlert(GAS_CRITICAL_TICKS, 0), "critical must warn immediately");
  assert.ok(gasRunwayAlert(0, 0), "empty must warn immediately");
}

// RECLAIM — what the Pons locker accrued goes back to the holders, and the
// per-stock total does not move.
//
// This is the only rule in the file that moves money BETWEEN rows, so the
// property worth proving is conservation, not the arithmetic of one share: a
// leg that comes out heavier than it went in is a root that promises more than
// the Distributor holds, and `_one` would settle it by truncating whoever
// claims last, in silence.
//
// The PONS row is the whole reason this function is not "delete the entry".
// 6.17 PONS really did leave the contract on launch night, to an address that
// cannot send them back; a row stepped down to zero would promise those units
// to somebody else.
{
  const L = "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952" as Address;
  const A = "0x00000000000000000000000000000000000000a1" as Address;
  const B = "0x00000000000000000000000000000000000000b2" as Address;
  const NVDA = "0x00000000000000000000000000000000000000cc" as Address;
  const PONS = "0x00000000000000000000000000000000000000ee" as Address;
  const SPY = "0x00000000000000000000000000000000000000dd" as Address;
  const QQQ = "0x00000000000000000000000000000000000000ff" as Address;

  const totals = new Map<string, Entry>();
  const put = (holder: Address, stock: Address, cumulative: bigint) =>
    totals.set(key(holder, stock), { holder, stock, cumulative });
  const put2 = (m: Map<string, Entry>, holder: Address, stock: Address, cumulative: bigint) =>
    m.set(key(holder, stock), { holder, stock, cumulative });

  // Nothing delivered: the whole row goes back to A and B.
  put(L, NVDA, 100n); put(A, NVDA, 60n); put(B, NVDA, 40n);
  // 25 already delivered to the locker: only the remaining 75 moves.
  put(L, PONS, 100n); put(A, PONS, 30n); put(B, PONS, 10n);
  // The locker is the only row of this leg. Nobody to hand it to.
  put(L, SPY, 50n);
  // Delivered exactly what it is owed: nothing to reclaim, nothing regresses.
  put(L, QQQ, 10n);

  const before = new Map<string, bigint>();
  for (const e of totals.values()) {
    const leg = e.stock.toLowerCase();
    before.set(leg, (before.get(leg) ?? 0n) + e.cumulative);
  }

  const paid = new Map([[key(L, PONS), 25n], [key(L, QQQ), 10n]]);
  const atGate = new Map([...totals].map(([k, e]) => [k, e.cumulative]));
  const reduced = reclaimUndeliverable(totals, atGate, paid, L);

  // 1. The rows that went backwards, and ONLY those. `preflight` waives
  //    exactly this set and blocks on anything else, so a key too many here is
  //    a hole in the monotonicity check.
  assert.deepEqual(
    [...reduced].sort(),
    [key(L, NVDA), key(L, PONS)].sort(),
    "only the rows actually stepped down are reported",
  );

  // 2. Conservation, per leg. Never heavier than it went in.
  for (const [leg, was] of before) {
    let now = 0n;
    for (const e of totals.values()) if (e.stock.toLowerCase() === leg) now += e.cumulative;
    assert.ok(now <= was, `${leg}: ${was} -> ${now}, a leg came out heavier`);
  }

  // 3. Nothing delivered -> the row is gone and the leg is whole.
  assert.equal(totals.get(key(L, NVDA)), undefined, "a row with nothing delivered is dropped");
  assert.equal(totals.get(key(A, NVDA))!.cumulative, 120n, "A takes 60 % of the reclaimed 100");
  assert.equal(totals.get(key(B, NVDA))!.cumulative, 80n, "B takes 40 %");

  // 4. Something delivered -> the row survives at exactly that amount, and the
  //    rounding remainder stays unpromised rather than being forced onto the
  //    last row.
  assert.equal(totals.get(key(L, PONS))!.cumulative, 25n, "the row keeps what was really delivered");
  assert.equal(totals.get(key(A, PONS))!.cumulative, 86n, "30 + 75x30/40, truncated");
  assert.equal(totals.get(key(B, PONS))!.cumulative, 28n, "10 + 75x10/40, truncated");
  assert.equal(before.get(PONS.toLowerCase())! - 139n, 1n, "the remainder is left unpromised");

  // 5. Untouched cases: no peers, and nothing left to reclaim.
  assert.equal(totals.get(key(L, SPY))!.cumulative, 50n, "a leg with no other holder is left alone");
  assert.equal(totals.get(key(L, QQQ))!.cumulative, 10n, "a row already fully delivered is left alone");

  // 6. Reproducible. The keeper rebuilds the root every 30 minutes and the
  //    co-signer rebuilds it again on another host, each from its OWN fresh
  //    totals — two builds that disagreed would be two roots for one epoch.
  //    (Calling this twice on the SAME map is not that, and is not a path:
  //    the second call would see rows it had already stepped down.)
  const rebuild = new Map<string, Entry>();
  put2(rebuild, L, NVDA, 100n); put2(rebuild, A, NVDA, 60n); put2(rebuild, B, NVDA, 40n);
  put2(rebuild, L, PONS, 100n); put2(rebuild, A, PONS, 30n); put2(rebuild, B, PONS, 10n);
  put2(rebuild, L, SPY, 50n); put2(rebuild, L, QQQ, 10n);
  const again = reclaimUndeliverable(rebuild, atGate, paid, L);
  assert.deepEqual([...again].sort(), [...reduced].sort(), "a second build reduces the same rows");
  for (const [k, e] of totals) {
    assert.equal(rebuild.get(k)!.cumulative, e.cumulative, `a second build differs on ${k}`);
  }
}

// RECLAIM, THE SECOND TIME — the split is FROZEN at the gate, and this is the
// test that was missing.
//
// Production, 2026-09-16: the reclaim shipped computing `excess x cumulative /
// sum(cumulative)` against the LIVE totals on every build. The tree then grew
// from 3 139 rows to 3 199. For a holder who had stopped accruing — sold, so
// their own cumulative is frozen — the numerator held still while the
// denominator grew, so their increment SHRANK and their cumulative went
// backwards. `preflight` caught it and refused to publish for 21 epochs, which
// is the system working; the defect is that nothing here failed first.
//
// The rule: an increment is decided once, at `LOCKER_RECLAIM_FROM_EPOCH`, and
// never moves again. Rebuilding an old root must also reproduce it exactly, or
// `dispute.ts` reports an honest keeper as forged.
{
  const L = "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952" as Address;
  const A = "0x00000000000000000000000000000000000000a1" as Address;
  const B = "0x00000000000000000000000000000000000000b2" as Address;
  const C = "0x00000000000000000000000000000000000000c3" as Address;
  const NVDA = "0x00000000000000000000000000000000000000cc" as Address;

  const build = (rows: [Address, bigint][]) => {
    const m = new Map<string, Entry>();
    for (const [h, c] of rows) m.set(key(h, NVDA), { holder: h, stock: NVDA, cumulative: c });
    return m;
  };
  const paid = new Map<string, bigint>();

  // At the gate: the locker owes 100, A and B hold 60 and 40.
  const gate = build([[L, 100n], [A, 60n], [B, 40n]]);
  const atGate = new Map([...gate].map(([k, e]) => [k, e.cumulative]));
  reclaimUndeliverable(gate, atGate, paid, L);
  const aAtGate = gate.get(key(A, NVDA))!.cumulative;   // 60 + 100x60/100 = 120
  const bAtGate = gate.get(key(B, NVDA))!.cumulative;
  assert.equal(aAtGate, 120n, "the gate root splits on the state at the gate");

  // Twenty epochs later. A sold and is frozen at 60. B kept accruing. C is new
  // and was not in the tree at the gate at all.
  const later = build([[L, 100n], [A, 60n], [B, 400n], [C, 900n]]);
  reclaimUndeliverable(later, atGate, paid, L);

  // 1. THE regression. A must not lose a wei because other people bought.
  assert.ok(later.get(key(A, NVDA))!.cumulative >= aAtGate,
    `A went backwards: ${aAtGate} -> ${later.get(key(A, NVDA))!.cumulative}`);
  assert.equal(later.get(key(A, NVDA))!.cumulative, aAtGate, "a frozen holder keeps exactly its gate value");

  // 2. B accrued on top of an increment that did not move.
  assert.equal(later.get(key(B, NVDA))!.cumulative - 400n, bAtGate - 40n, "B's increment is the same as at the gate");

  // 3. A holder absent at the gate takes no part of the split: it was owed
  //    none of this when the correction was decided.
  assert.equal(later.get(key(C, NVDA))!.cumulative, 900n, "a newcomer gets nothing from the reclaim");

  // 4. The whole excess still lands, and not a unit more.
  assert.equal(later.get(key(L, NVDA)), undefined, "the locker row is still dropped");
}

console.log("epoch: 32 checks OK");
