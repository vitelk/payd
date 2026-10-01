/** The basket's rules. `pnpm --filter front test` */
import assert from "node:assert/strict";
import { bpsFromPct, checks, holdersFloorPct, pct, spread, validate } from "./basket.js";
import type { Address } from "viem";

const A = "0xAAaAaAAAAaAAAAAAAAaaaaAaAAaaAaaAaAaAaAaA" as Address;
const B = "0xBbBbBBbBbbBBBbbbbbBbBBbbBBbbBBBbbbBBBBbB" as Address;
const FEED = "0xCcCCCcccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as Address;

// ---------------------------------------------------------------- the fold
//
// GONE, with the event replay it belonged to. Four cases used to be checked
// here — a delisted stock stays delisted, one delisted and RE-listed is live
// again, a re-listing carries the new tier and not the old one — and every one
// of them was a property of reconstructing state from two separately fetched
// log streams, where nothing ordered a removal against a later re-listing.
//
// The creation screen now reads `Payd.listing(stock)` for each shipped
// candidate (`config.ts`, `KNOWN_STOCKS`), so the chain answers all four
// directly: `allowed` is the current state and `poolFee` the current tier,
// with no history to order and nothing to get wrong. There is no fold left to
// regress, which is why these assertions are deleted rather than moved.

// ------------------------------------------------------------ the validator

const on = (bps: number) => ({ on: true, bps });
const basket = (...w: number[]) => new Map(w.map((b, i) => [`0x${i}`, on(b)]));

assert.match(validate(basket(10000), 7000, 30, 1000)!, /at least 2/, "one stock is a Pons launch, not a vault");
assert.equal(validate(basket(5000, 5000), 7000, 30, 1000), null, "the ordinary basket passes");
assert.match(validate(basket(5000, 4000), 7000, 30, 1000)!, /90 % — 10 % left/, "a short sum names what is left, in percent");
assert.match(validate(basket(6000, 5000), 7000, 30, 1000)!, /110 % — 10 % too much/, "and an over-full one says by how much");
assert.match(validate(basket(9500, 500), 7000, 30, 1000)!, /at least 10 %/, "a weight under the floor");
// No user-facing string may say "bps" any more: the form is entirely in
// percent, and one label in ten-thousandths is worse than all of them, because
// the reader cannot tell which unit the number in front of them is in.
for (const m of [
  validate(basket(10000), 7000, 30, 1000),
  validate(basket(9500, 500), 7000, 30, 1000),
  validate(basket(5000, 4000), 7000, 30, 1000),
  validate(basket(5000, 5000), 4000, 30, 1000),
  validate(basket(5000, 5000), 9500, 30, 1000),
]) assert.doesNotMatch(m!, /bps/i, `a message still speaks bps: ${m}`);
assert.match(validate(basket(5000, 5000), 4000, 30, 1000)!, /at least 50 %/, "under the rewards floor");
assert.match(validate(basket(5000, 5000), 9500, 30, 1000)!, /more than everything/, "rewards + platform over 100 %");
assert.match(validate(basket(5000, 5000), 7000, 29, 1000)!, /30 minutes/, "an epoch below the minimum");
assert.match(validate(basket(5000, 5000), 7000, 1441, 1000)!, /1 day/, "and above the maximum");
assert.equal(validate(basket(1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250), 5000, 1440, 5000), null, "eight stocks at the edges");
assert.match(validate(basket(...Array(9).fill(1111)), 7000, 30, 1000)!, /at most 8/, "nine is too many");

// THE HOLDERS' FIELD'S OWN FLOOR, which moves with the legs exactly as its
// ceiling does. `holders >= 50 - burnt - locked` is `MIN_REWARDS_BPS` restated
// in the unit the form asks in, and the field carried a static 1 until now: the
// slider could be dragged to a split the button would then refuse.
assert.equal(holdersFloorPct(0), 50, "no legs, and it is the contract's floor as written");
assert.equal(holdersFloorPct(2000), 30, "20 % of legs buys 20 points of room");
assert.ok(holdersFloorPct(5000) >= 1, "and it never reaches zero, whatever the legs take");
// The floor can never cross the ceiling: room is 90 - legs at a 10 % platform,
// the floor is 50 - legs, and the gap is a constant 40.
for (let legs = 0; legs <= 4500; legs += 100) {
  assert.ok(holdersFloorPct(legs) <= 100 - 10 - legs / 100,
    `floor over ceiling at ${legs / 100} % of legs`);
}

// THE FLOOR IS ON `rewardsBps`, AND WITH LEGS THAT IS NOT WHAT HOLDERS GET.
// 30 % held beside 10 % burnt and 10 % locked clears a 50 % floor and pays
// holders 30 — the checklist used to tick "50 % to holders" over a split bar
// saying 30 % on the same screen. The guard does not move; the words do.
{
  const line = (legs: number) =>
    checks(basket(5000, 5000), 5000, 30, 1000, legs).find((c) => /floor 50 %/.test(c.label))!;
  assert.ok(line(0).ok && /^50 % to holders —/.test(line(0).label),
    `no legs, no extra words: ${line(0).label}`);
  const withLegs = line(2000);
  assert.ok(withLegs.ok, "the contract still accepts it, so the check still ticks");
  assert.match(withLegs.label, /holders and their legs/, "and says what the floor bounds");
  assert.match(withLegs.label, /30 % reaches holders/, "beside what holders actually get");
  assert.match(validate(basket(5000, 5000), 4000, 30, 1000, 2000)!, /holders and their legs must get/,
    "the refusal names the same thing the checklist does");
}


// ------------------------------------------------------------- the split

// An even split has to land on 10 000 exactly, or `createVault` reverts on a
// sum of 9 999. Three is the case that exposes it.
assert.deepEqual(spread(2), [5000, 5000]);
assert.deepEqual(spread(3), [3334, 3333, 3333], "the remainder goes to the first, not into the void");
assert.deepEqual(spread(8), [1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250]);
for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  assert.equal(spread(n).reduce((a, b) => a + b, 0), 10000, `spread(${n}) must sum to 10000`);
  assert.ok(spread(n).every((w) => w >= 1000), `spread(${n}) must respect the per-leg floor`);
}

console.log("basket: ok");

// ---- checks(): the same conditions as validate, but all of them -----------
//
// The link between the two is what matters: if `validate` accepts, NO box may
// stay unticked, and if it refuses, at least one must be. Without that
// equivalence, the form would show five green ticks above a disabled button --
// or the other way round, which is worse.
{
  const mk = (n: number, bps: number[]) => {
    const m = new Map<string, { on: boolean; bps: number }>();
    for (let i = 0; i < n; i++) m.set(`0x${i}`, { on: true, bps: bps[i] ?? 0 });
    return m;
  };
  const cases: [Map<string, { on: boolean; bps: number }>, number, number][] = [
    [mk(2, [5000, 5000]), 7000, 30],
    [mk(1, [10000]), 7000, 30],            // trop peu de stocks
    [mk(2, [9500, 500]), 7000, 30],        // one leg below the floor
    [mk(2, [5000, 4000]), 7000, 30],       // somme fausse
    [mk(2, [5000, 5000]), 4000, 30],       // below the holders' floor
    [mk(2, [5000, 5000]), 9500, 30],       // holders + plateforme > 100 %
    [mk(2, [5000, 5000]), 7000, 10],       // epoque trop courte
    [mk(9, Array(9).fill(1111)), 7000, 30], // trop de stocks
  ];
  for (const [picks, rw, ep] of cases) {
    const bad = validate(picks, rw, ep, 1000) !== null;
    const unchecked = checks(picks, rw, ep, 1000).filter((c) => !c.ok).length;
    assert.equal(bad, unchecked > 0,
      `validate et checks divergent: validate=${bad ? "refuse" : "accepte"}, ${unchecked} case(s) decochee(s)`);
  }
  // The nominal case ticks everything.
  assert.deepEqual(checks(mk(2, [5000, 5000]), 7000, 30, 1000).filter((c) => !c.ok), []);
}

// ---- percent in, bps out -------------------------------------------------
//
// The form displays percent and the contract takes `uint16 bps`, so every
// weight makes the round trip on its way to `createVault`. A rounding error
// here does not show as a wrong label — it shows as a reverted transaction on
// a sum of 9 999, after the creator has signed.

assert.equal(pct(1000), "10 %", "a whole percent drops its zeros");
assert.equal(pct(1250), "12.5 %", "and a half keeps its half");
assert.equal(pct(3334), "33.34 %", "the remainder leg keeps both decimals");
assert.equal(pct(10000), "100 %");
assert.equal(pct(0), "0 %");

// The round trip has to be exact for every split the form can produce, or the
// sum lands off 10 000 the moment somebody opens a weight box and closes it
// again without typing. 33.34 * 100 is 3334.0000000000005 in binary floating
// point, which is why this goes through Math.round and not | 0.
for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  const w = spread(n);
  const back = w.map((b) => bpsFromPct(Number(pct(b).replace(" %", ""))));
  assert.deepEqual(back, w, `spread(${n}) must survive bps -> percent -> bps`);
  assert.equal(back.reduce((a, b) => a + b, 0), 10000, `and still sum to 10000`);
}

// The step the input offers is 0.01 %, so every value a reader can type lands
// on a whole bp.
for (const v of [0, 0.01, 10, 12.5, 33.34, 66.66, 99.99, 100]) {
  const b = bpsFromPct(v);
  assert.ok(Number.isInteger(b) && b >= 0 && b <= 10000, `${v} % -> ${b} is not a bp`);
}

console.log("basket: checks agrees with validate on 8 shapes, percent round-trips exactly");
