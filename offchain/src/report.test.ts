/** The draft's arithmetic and words — no network. */
import assert from "node:assert/strict";
import { draft, money, type Snapshot } from "./report.js";

const snap = (eth: number, usd: number, date = "2026-10-08"): Snapshot => ({
  date, block: "1", epoch: "1", ethUsd: 4000, eth, usd,
  rows: [
    { symbol: "NVDA", usd: usd * 0.4 }, { symbol: "TSLA", usd: usd * 0.3 },
    { symbol: "SPY", usd: usd * 0.2 }, { symbol: "QQQ", usd: usd * 0.1 },
  ],
});

assert.equal(money(9242.4), "$9,242");
assert.equal(money(99.024), "$99.02");

// The week is the ETH that became stock, priced today — not the value change.
const week = draft(snap(2.5, 9242), snap(2.0, 9500, "2026-10-01"));
assert.match(week, /This week 0\.5000 ETH .*\(\$2,000 at today's price\)/);
assert.match(week, /\$9,242 of stock/);
assert.match(week, /\$NVDA \$3,697/);

// First run: no week to speak of, only the total.
const first = draft(snap(2.5, 9242), null);
assert.doesNotMatch(first, /This week/);
assert.match(first, /bought with 2\.50 ETH/);

// A week with no purchase does not invent one.
assert.doesNotMatch(draft(snap(2.0, 9000), snap(2.0, 9500, "2026-10-01")), /This week/);

for (const p of [week, first]) {
  assert.ok(p.length <= 280, `draft is ${p.length} characters`);
  // .githooks/pre-commit's vocabulary, HARD and SOFT, plus OPSEC.md §7.
  assert.doesNotMatch(p, /APY|APR|dividend|yield|earn|promise|invest|guarantee|\bwe\b/i);
}

console.log("report: week from ETH spent, first run total-only, 280 max, vocabulary clean");
