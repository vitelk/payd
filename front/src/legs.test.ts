/**
 * `snapLeg` / `snapPot` / `toContract`, and the property that matters: what the
 * form produces is what the chain takes.
 *
 * **The form and the contracts count in two different units, and this file is
 * where they are reconciled.** `FeeVaultV2` funds the legs out of a basket
 * purchase, which is itself funded out of `rewardsBps` — so `MIN_LEG_BPS` and
 * `MAX_LEGS_BPS` are measured against the holders' share, while every figure
 * the creation form shows is measured against what the token collects. Asking
 * the creator in contract units is what let `90 % to holders` sit beside
 * `10 % burnt, 10 % locked`: all three were accepted, and holders got 72.
 *
 * So the form asks in one unit and `toContract` converts. The bounds convert
 * with it, into two sentences a creator can check by eye — the legs together
 * never exceed the holders' line, and a leg is off or at least a twentieth of
 * the three together — and the loop at the end proves the arithmetic rather
 * than the algebra: every pair reachable with the spinner must encode without
 * an error, or the form would disable its own button over a value it offered.
 */
import assert from "node:assert/strict";
import {
  MAX_LEGS_BPS, MAX_POT_BPS, MIN_LEG_BPS, MIN_POT_BPS, legCeiling, legFloor,
  modeDataFor, snapLegs, snapPot, toContract, toSplit,
} from "./modes.js";

// --- the two bounds, restated ----------------------------------------------

// The legs together never exceed the holders' line. That IS `MAX_LEGS_BPS`:
// `b + l` at most half of `h + b + l` rearranges to `b + l <= h`.
assert.equal(legCeiling(70), 70);
assert.equal(toContract({ holdersBps: 5000, burnBps: 2500, lpBps: 2500 }).burnBps
  + toContract({ holdersBps: 5000, burnBps: 2500, lpBps: 2500 }).lpBps, MAX_LEGS_BPS,
  "legs equal to the holders' line is exactly the cap, not over it");

// A leg is off, or at least a twentieth of the three together — `MIN_LEG_BPS`.
assert.equal(legFloor(70, 10), 5, "70 held and 10 on the other leg puts this one's floor at 5");
assert.equal(legFloor(95, 0), 5, "and at 95 held it is still 5");
{
  const c = toContract({ holdersBps: 7000, burnBps: 500, lpBps: 1000 });
  assert.ok(c.burnBps >= MIN_LEG_BPS, `a leg at its floor encodes at ${c.burnBps}, not under ${MIN_LEG_BPS}`);
}

// --- the snap, in the creator's unit ---------------------------------------

const burn = (b: number, l: number, h: number) => snapLegs(b, l, h, "burn");

assert.deepEqual(burn(0, 0, 70), { burnPct: 0, lpPct: 0 },
  "off stays off — that is a legal answer, not a small leg");
assert.deepEqual(burn(7, 0, 70), { burnPct: 7, lpPct: 0 },
  "a legal value is left alone; the floor and the cap are not a step");
// Under the floor comes back to it.
assert.equal(burn(1, 0, 70).burnPct, legFloor(70, 0));
assert.equal(burn(2, 10, 70).burnPct, legFloor(70, 10));
// Past the cap comes back to what the holders' line and the other leg leave.
assert.equal(burn(80, 0, 70).burnPct, 70, "a leg cannot exceed the holders' line");
assert.deepEqual(burn(60, 20, 70), { burnPct: 60, lpPct: 10 },
  "the edited leg keeps what was typed and the other yields the difference");

// THE COUPLING, which a one-leg-at-a-time snap cannot see: each floor is read
// against the other leg, so setting one can push the other under its own.
{
  // 2 is legal beside an empty LP at 37 held (the floor is 2)...
  assert.equal(burn(2, 0, 37).burnPct, 2);
  // ...and editing the LP to 3 lifts the burn's floor to 3, so the pair moves.
  const pair = snapLegs(2, 3, 37, "lp");
  assert.ok(pair.burnPct === 0 || pair.burnPct >= legFloor(37, pair.lpPct),
    `burn ${pair.burnPct} is under its floor beside an LP of ${pair.lpPct}`);
}

// Junk from a field somebody emptied or pasted into.
for (const junk of [NaN, -5, Infinity]) {
  assert.deepEqual(burn(junk, 0, 70), { burnPct: 0, lpPct: 0 }, `${junk} reads as off`);
}

// The pot has no "off" and is unaffected by any of this: a lottery's pot is a
// share of the pot, not of the holders' line.
assert.equal(snapPot(0), MIN_POT_BPS / 100, "under the floor comes back to it");
assert.equal(snapPot(99), MAX_POT_BPS / 100, "over the cap comes back to it");
assert.equal(snapPot(20), 20, "and a legal share is left alone");

// --- the round trip --------------------------------------------------------

// What the bar draws is `toSplit(toContract(typed))`, so the two must agree
// with what was typed wherever the arithmetic allows it.
for (const [h, b, l] of [[70, 10, 10], [50, 25, 25], [80, 10, 10], [60, 20, 0], [90, 5, 5]] as const) {
  const back = toSplit(toContract({ holdersBps: h * 100, burnBps: b * 100, lpBps: l * 100 }));
  assert.ok(Math.abs(back.holdersBps - h * 100) <= 2, `holders ${h} came back as ${back.holdersBps / 100}`);
  assert.ok(Math.abs(back.burnBps - b * 100) <= 2, `burn ${b} came back as ${back.burnBps / 100}`);
  assert.ok(Math.abs(back.lpBps - l * 100) <= 2, `lp ${l} came back as ${back.lpBps / 100}`);
}

// THE PROPERTY, over every combination a creator could reach with the spinner.
// What comes out of the snap, converted, encodes without an error — so the
// button is never disabled by a value the form itself produced. Two roundings
// happen in `toContract` and they can both go up, which is the one way a pair
// legal in the creator's unit could encode one bps past the cap.
let checked = 0;
for (let h = 5; h <= 95; h += 1) {
  for (let a = 0; a <= 95; a += 1) {
    for (let b = 0; b <= 95; b += 1) {
      const { burnPct, lpPct } = snapLegs(a, b, h, "burn");
      const c = toContract({ holdersBps: h * 100, burnBps: burnPct * 100, lpBps: lpPct * 100 });
      const { error } = modeDataFor("distribution", { burnBps: c.burnBps, lpBps: c.lpBps });
      assert.equal(error, undefined, `holders ${h}, snapped ${a}/${b} -> ${burnPct}/${lpPct} `
        + `-> ${c.burnBps}/${c.lpBps} bps of ${c.rewardsBps} was refused: ${error}`);
      checked++;
    }
  }
}

// AND THE OTHER SIDE OF IT: a pair the snap would never produce must be
// REFUSED, not quietly reproportioned. 10 held beside 10 burnt and 10 locked
// was reachable by dragging the holders' slider under legs already set — the
// slider wrote the field without snapping — and `toContract` handed back
// 1667 + 3333, which is 5 % burnt beside 10 % locked in the creator's unit.
// Neither figure was typed and nothing said so.
{
  const c = toContract({ holdersBps: 1000, burnBps: 1000, lpBps: 1000 });
  assert.ok(c.burnBps + c.lpBps > MAX_LEGS_BPS,
    "legs over the holders' line stay over the cap, so the encoder can refuse them");
  assert.equal(c.burnBps, c.lpBps, "and the two legs keep the ratio that was typed");
  assert.ok(modeDataFor("distribution", { burnBps: c.burnBps, lpBps: c.lpBps }).error,
    "which is what disables the button instead of launching a split nobody chose");
  // The snap is what the form owes that creator, and it is a legal answer.
  const snapped = snapLegs(10, 10, 10, "lp");
  assert.ok(snapped.burnPct + snapped.lpPct <= 10, "the snap brings the pair back under the line");
}

console.log(`legs: two units reconciled, ${checked} spinner-reachable combinations all encode`);
