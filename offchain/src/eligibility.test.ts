/** Eligibility-threshold checks. `pnpm --filter offchain test` */
import assert from "node:assert/strict";
import { applyFloor } from "./eligibility.js";

const SUPPLY = 1_000_000_000n * 10n ** 18n; // 1 B tokens
const MIN = 200_000_000_000_000n; // 0.0002 ETH
const START = 1_000_000n * 10n ** 18n; // start cap: 1 M tokens
const NOCAP = SUPPLY; // cap neutralised, to test the formula alone

function holders(...bps: bigint[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  bps.forEach((b, i) => m.set(`0x${String(i).padStart(40, "0")}`, (SUPPLY * b) / 1_000_000n));
  return m;
}

// 1. The threshold LOOSENS as revenue rises — that is the whole point of
//    moving from a %-of-supply threshold to a value threshold.
{
  const c = holders(100n, 1000n, 10_000n); // 0.01 % / 0.1 % / 1 % of supply
  const poor = applyFloor(c, 10n ** 17n, MIN, NOCAP); // 0.1 ETH cumulative
  const rich = applyFloor(c, 10n ** 19n, MIN, NOCAP); // 10 ETH cumulative
  assert.ok(rich.minBalance < poor.minBalance, "the threshold must fall as the ETH spent rises");
  assert.ok(rich.dusted <= poor.dusted, "a richer epoch cannot exclude more people");
}

// 2. A holder above the threshold is kept, one below is dropped, and the
//    eligible sum counts only those kept.
{
  const c = holders(1n, 500_000n); // 0.0001 % and 50 %
  const r = applyFloor(c, 10n ** 18n, MIN, NOCAP);
  assert.equal(r.dusted, 1, "the tiny one must be dropped");
  assert.equal(Object.keys(r.balances).length, 1);
  assert.equal(r.eligibleSupply, [...c.values()][1], "the eligible sum must count only the kept holder");
}

// 3. Determinism: insertion order must change nothing.
{
  const a = holders(100n, 1000n, 10_000n);
  const b = new Map([...a].reverse());
  const ra = applyFloor(a, 10n ** 18n, MIN, NOCAP);
  const rb = applyFloor(b, 10n ** 18n, MIN, NOCAP);
  assert.deepEqual(JSON.stringify(ra, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
                   JSON.stringify(rb, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
                   "the output depends on iteration order");
}

// 4. A zero cumulative must fail loudly rather than produce a zero threshold
//    that would let every speck of dust through.
{
  assert.throws(() => applyFloor(holders(1000n), 0n, MIN, START), /quoteCumulative/);
}

// --- The checks below use a candidate set whose sum is the whole supply: the
// --- threshold derives from the sum of CANDIDATES, so a tiny test set would
// --- give a tiny threshold and prove nothing.
const REAL = () => holders(1n, 10n, 100n, 1000n, 10_000n, 988_889n); // = 1,000,000 ppm

// 5. The start cap binds while little ETH has come in: without it the formula
//    would demand 20 M tokens on day one and nobody would be eligible at launch.
{
  const day1 = applyFloor(REAL(), 10n ** 16n, MIN, START); // 0.01 ETH cumulative
  assert.equal(day1.minBalance, START, "at the start the threshold must be the cap");
  assert.ok(day1.capped, "capped must signal that the formula is harsher than the cap");
  assert.equal(day1.dusted, 3, "only the 3 holders >= 1 M tokens pass at launch");
}

// 6. The cap stops binding at 0.2 ETH cumulative — the crossover point
//    documented in config.ts — and the threshold then falls without ever rising
//    again, down to the values announced to holders.
{
  const expected: [bigint, bigint][] = [
    [2n * 10n ** 17n, 1_000_000n], // 0.2 ETH -> 1 M tokens, exactly the cap
    [10n ** 18n, 200_000n],        //   1 ETH -> 200 k
    [5n * 10n ** 18n, 40_000n],    //   5 ETH ->  40 k
    [20n * 10n ** 18n, 10_000n],   //  20 ETH ->  10 k
    [100n * 10n ** 18n, 2_000n],   // 100 ETH ->   2 k
  ];
  let previous = START + 1n;
  for (const [eth, tokens] of expected) {
    const r = applyFloor(REAL(), eth, MIN, START);
    assert.equal(r.minBalance, tokens * 10n ** 18n, `wrong threshold at ${eth} cumulative wei`);
    assert.ok(r.minBalance <= previous, "the threshold must never rise again");
    previous = r.minBalance;
  }
  assert.ok(!applyFloor(REAL(), 10n ** 18n, MIN, START).capped, "at 1 ETH the cap no longer binds");
}

// 8. The crossover scales with the CANDIDATE supply, not the total supply. The
//    pool, the bonding curve, the vault, the distributor and `excluded[]` are all
//    out of the sum, so at launch — most of the token still in the curve — the
//    cap stops binding long before check 6's 0.2 ETH. Reported once as a bug
//    ("the threshold fell and we never passed 0.2 ETH"); it is the intended
//    behaviour, and this pins it so the figure cannot drift back into being read
//    as a date rather than as a function of what circulates.
{
  const tenth = holders(1n, 10n, 100n, 1000n, 10_000n, 88_889n); // 100,000 ppm = 10 % circulating
  const crossover = 2n * 10n ** 16n; // 0.02 ETH — a tenth of check 6's 0.2 ETH

  assert.equal(applyFloor(tenth, crossover, MIN, START).minBalance, START,
    "a tenth of the supply circulating must move the crossover to a tenth of the ETH");
  assert.ok(applyFloor(tenth, 2n * crossover, MIN, START).minBalance < START,
    "past its own crossover the formula must take over from the cap");
  assert.equal(applyFloor(REAL(), 2n * crossover, MIN, START).minBalance, START,
    "the same ETH on a fully circulating supply is still capped — the figure is not a date");
}

// 7. The threshold does NOT depend on how time is sliced into epochs — the
//    regression this whole change fixes. With ONE epoch's ETH as the
//    denominator, moving from one-day epochs to 30-minute ones made the
//    threshold 48x harsher without anyone touching a parameter (§S17).
{
  const totalQuote = 48n * 10n ** 18n; // same ETH collected, two slicings
  const cumulative = applyFloor(REAL(), totalQuote, MIN, START);
  const perEpoch = applyFloor(REAL(), totalQuote / 48n, MIN, START); // the old computation
  assert.equal(perEpoch.minBalance / cumulative.minBalance, 48n,
    "the old threshold really was 48x harsher — that is what we are removing");
  assert.ok(cumulative.dusted < perEpoch.dusted, "the new threshold must include more holders");
}

// 8. LIVENESS. An early epoch where nobody has yet crossed the start cap must
//    still be payable. Before the waiver this returned eligibleSupply = 0,
//    which `snapshot` throws on — and one such FUNDED epoch stopped every
//    future root, because the cumulative build replays from epoch 0.
{
  const c = holders(500n, 400n, 300n); // 0.05 % / 0.04 % / 0.03 % — all under the 0.1 % cap
  // 0.0001 ETH cumulative — what the FIRST runEpoch actually spends:
  // rewardsPool crosses MAX_REFUND (0.02) and payoutBps is 400, so at a pool
  // of 0.022 amountIn = (0.022 - 0.02) * 4 % = 0.00008 ETH, below MIN_SHARE_WEI
  // (0.0002) — which it stays for any pool under 0.025.
  const r = applyFloor(c, 10n ** 14n, MIN, START);
  assert.notEqual(r.eligibleSupply, 0n, "an epoch nobody clears must not be fatal");
  assert.equal(r.eligibleSupply, [...c.values()].reduce((a, b) => a + b, 0n),
    "with the floor waived every candidate is in the tree");
  assert.equal(r.dusted, 0, "nobody is dusted when the floor is waived");
  assert.equal(r.minBalance, 0n, "the waiver must be visible to a verifier replaying it");
}

// 9. The waiver is a LAST RESORT: one holder above the bar is enough to keep
//    the floor doing its job, so it must not fire then.
{
  const c = holders(500n, 400n, 2000n); // the last one is 0.2 %, above the cap
  const r = applyFloor(c, 10n ** 14n, MIN, START);
  assert.equal(r.dusted, 2, "the two small ones must still be dropped");
  assert.equal(r.eligibleSupply, (SUPPLY * 2000n) / 1_000_000n, "only the big one counts");
}

console.log("eligibility: 9 checks OK");
