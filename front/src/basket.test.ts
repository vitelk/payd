/** The basket rules and the allowlist fold. `pnpm --filter front test` */
import assert from "node:assert/strict";
import { fold, validate, checks, spread } from "./basket.js";
import type { Address } from "viem";

const A = "0xAAaAaAAAAaAAAAAAAAaaaaAaAAaaAaaAaAaAaAaA" as Address;
const B = "0xBbBbBBbBbbBBBbbbbbBbBBbbBBbbBBBbbbBBBBbB" as Address;
const FEED = "0xCcCCCcccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" as Address;

// ---------------------------------------------------------------- the fold

// 1. The ordinary case.
{
  const live = fold([{ stock: A, at: 1n, poolFee: 3000, feed: FEED }], []);
  assert.equal(live.size, 1);
  assert.equal(live.get(A.toLowerCase())!.poolFee, 3000);
}

// 2. Delisted stays delisted.
{
  const live = fold([{ stock: A, at: 1n, poolFee: 3000, feed: FEED }], [{ stock: A, at: 2n }]);
  assert.equal(live.size, 0, "a removed stock must not be offered");
}

// 3. **The one that matters**: removed, then re-listed. The two streams are
//    fetched separately, so the removal arrives in its own array with no
//    ordering against the re-listing — deciding on presence rather than on
//    chain order would bury a stock that is live again. This is the assertion
//    that fails if `fold` ever goes back to a set-difference.
{
  const live = fold(
    [{ stock: A, at: 1n, poolFee: 3000, feed: FEED }, { stock: A, at: 9n, poolFee: 500, feed: FEED }],
    [{ stock: A, at: 5n }],
  );
  assert.equal(live.size, 1, "re-listed after removal must be live again");
  assert.equal(live.get(A.toLowerCase())!.poolFee, 500, "and carry the NEW tier, not the old one");
}

// 4. A re-listing at a different tier replaces the tier. Getting this wrong
//    sends `createVault` a tier the Payd refuses (`WrongPoolFee`).
{
  const live = fold([{ stock: B, at: 1n, poolFee: 3000, feed: FEED }, { stock: B, at: 4n, poolFee: 10000, feed: FEED }], []);
  assert.equal(live.get(B.toLowerCase())!.poolFee, 10000);
}

// ------------------------------------------------------------ the validator

const on = (bps: number) => ({ on: true, bps });
const basket = (...w: number[]) => new Map(w.map((b, i) => [`0x${i}`, on(b)]));

assert.match(validate(basket(10000), 7000, 30, 1000)!, /at least 2/, "one stock is a Pons launch, not a vault");
assert.equal(validate(basket(5000, 5000), 7000, 30, 1000), null, "the ordinary basket passes");
assert.match(validate(basket(5000, 4000), 7000, 30, 1000)!, /9000/, "a short sum must name the sum");
assert.match(validate(basket(9500, 500), 7000, 30, 1000)!, /at least 1000 bps/, "a weight under the floor");
assert.match(validate(basket(5000, 5000), 4000, 30, 1000)!, /at least 50 %/, "under the rewards floor");
assert.match(validate(basket(5000, 5000), 9500, 30, 1000)!, /more than everything/, "rewards + platform over 100 %");
assert.match(validate(basket(5000, 5000), 7000, 29, 1000)!, /30 minutes/, "an epoch below the minimum");
assert.match(validate(basket(5000, 5000), 7000, 1441, 1000)!, /1 day/, "and above the maximum");
assert.equal(validate(basket(1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250), 5000, 1440, 5000), null, "eight stocks at the edges");
assert.match(validate(basket(...Array(9).fill(1111)), 7000, 30, 1000)!, /at most 8/, "nine is too many");


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

console.log("basket: checks agrees with validate on 8 shapes");
