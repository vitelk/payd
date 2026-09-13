/** Keeper economics helpers. `pnpm --filter offchain test` */
import assert from "node:assert/strict";
import { l1PricerAlert, L1_WARN_EVERY_TICKS, gasRunwayAlert, GAS_WARN_TICKS, GAS_CRITICAL_TICKS } from "./epoch.js";

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

console.log("epoch: 16 checks OK");
