/**
 * The basket's rules, and the fold that turns the Payd's events into the
 * current allowlist.
 *
 * A module of its own with NO import from `config.js` or `chain.js`, so it can
 * be run under node — the same reason `curve.ts` and `merkle.ts` are separate.
 * Everything here is pure: the DOM and the wallet live in `create.ts`.
 */
import type { Address } from "viem";

/** Mirrors `FeeVault._setAllocations` and `Payd.createVault`. Duplicated
 *  here ON PURPOSE and named after the constants it copies: the contract is the
 *  authority, this only spares the creator a reverted transaction. */
export const MIN_BASKET = 2,
  MAX_BASKET = 8,
  MIN_ALLOC_BPS = 1_000,
  BPS = 10_000,
  MIN_REWARDS_BPS = 5_000,
  MIN_EPOCH_MIN = 30,
  MAX_EPOCH_MIN = 1_440;

export interface Draft { on: boolean; bps: number }

/**
 * bps for the contract, PERCENT for the reader.
 *
 * `createVault` takes `uint16 bps` and every rule here is written in it, so bps
 * stays the unit this module computes in — it is the only one that is exact,
 * and a form that rounds before it submits is a form that reverts on the sum.
 * But nothing outside a solidity file thinks in ten-thousandths: "each at least
 * 1000 bps, summing to 10000" asks the creator to do arithmetic before they can
 * tell whether they have filled the form in. Every label below goes through
 * here instead, and the inputs in `create.ts` carry a `%` and convert on the
 * way in.
 *
 * Trailing zeros are dropped because the weights that actually occur are 50 %,
 * 12.5 % and 33.34 %: "50.00 %" spends two characters announcing a precision
 * the number does not have, and it is the common case.
 */
export function pct(bps: number): string {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))} %`;
}

/** The way back in, for the form's `%` inputs. Rounds to the nearest bp: the
 *  step is 0.01 %, so every value a reader can enter is exact, and anything
 *  pasted in that is not lands on the nearest weight the contract can hold. */
export const bpsFromPct = (v: number): number => Math.round(v * 100);
/**
 * What `MIN_REWARDS_BPS` actually bounds, said in the creator's unit.
 *
 * **The floor is on `rewardsBps`, and on a vault with legs that is NOT what
 * holders receive.** `FeeVaultV2` funds the burn and the locked LP out of the
 * basket purchase, which is itself funded out of `rewardsBps` — so 30 % held
 * beside 10 % burnt and 10 % locked passes a 50 % floor while holders get 30.
 * The line used to read "50 % to holders" over a split bar saying 30 % on the
 * same screen. The guard is right — the contract reverts on `rewardsBps`, not
 * on the net — so only the words change, and only when there are legs to
 * change them for.
 */
/**
 * The holders' field's own floor, in percent, and it moves with the legs.
 *
 * `MIN_REWARDS_BPS` is on `rewardsBps` — holders PLUS the legs — so in the unit
 * the form asks in it reads `holders >= 50 - burnt - locked`. The field carried
 * a static `min="1"` and left the refusal to `validate`, which is the one bound
 * of the four this screen did not express: `max` has moved with the legs since
 * the three fields were put in one unit, and this is its other half. It matters
 * most for the SLIDER, which is the control that cannot be reasoned with — a
 * `min` it can actually enforce is the difference between a state refused after
 * the fact and a state that was never reachable.
 */
export const holdersFloorPct = (legsBps: number): number =>
  Math.max(1, (MIN_REWARDS_BPS - legsBps) / 100);

const heldWho = (legsBps: number): string => (legsBps > 0 ? "holders and their legs" : "holders");
const heldNet = (rewardsBps: number, legsBps: number): string =>
  (legsBps > 0 ? `, of which ${pct(Math.max(0, rewardsBps - legsBps))} reaches holders` : "");

/**
 * Every rule the contracts enforce, checked here so a creator sees the problem
 * instead of a reverted transaction.
 *
 * Reports the FIRST thing wrong rather than all of them: a list of six
 * complaints about a half-filled form is noise, and the creator fixes them one
 * at a time anyway.
 */
export function validate(
  picks: Map<string, Draft>,
  rewardsBps: number,
  epochMin: number,
  platformBps: number,
  legsBps = 0,
): string | null {
  const chosen = [...picks.values()].filter((p) => p.on);
  if (chosen.length < MIN_BASKET) {
    return `pick at least ${MIN_BASKET} stocks — with one, a plain Pons launch already pays its holders the paired token`;
  }
  if (chosen.length > MAX_BASKET) return `at most ${MAX_BASKET} stocks`;
  for (const c of chosen) {
    if (c.bps < MIN_ALLOC_BPS) return `each weight must be at least ${pct(MIN_ALLOC_BPS)}`;
  }
  const sum = chosen.reduce((a, c) => a + c.bps, 0);
  if (sum !== BPS) {
    return sum < BPS
      ? `weights add up to ${pct(sum)} — ${pct(BPS - sum)} left to give out`
      : `weights add up to ${pct(sum)} — ${pct(sum - BPS)} too much`;
  }
  if (rewardsBps < MIN_REWARDS_BPS) {
    return `${heldWho(legsBps)} must get at least ${pct(MIN_REWARDS_BPS)}`
      + " — it is the floor the contract enforces";
  }
  if (rewardsBps + platformBps > BPS) {
    return `${pct(rewardsBps)} to holders plus ${pct(platformBps)} to the platform is more than everything`;
  }
  if (!Number.isInteger(epochMin) || epochMin < MIN_EPOCH_MIN || epochMin > MAX_EPOCH_MIN) {
    return "the epoch must be between 30 minutes and 1 day";
  }
  return null;
}

/** One of the form's conditions, as it is displayed. */
export interface Check { ok: boolean; label: string }

/**
 * The same conditions as `validate`, but ALL of them, with their state.
 *
 * **Why both exist.** `validate` stops at the first fault and that is
 * deliberate: as an error message, six complaints about a half-filled form are
 * noise. But as a CHECKLIST, showing what is already satisfied beats showing
 * only what is missing -- you see what is left to do instead of discovering the
 * faults one at a time.
 *
 * Two uses, two shapes, one source of constants. `validate` stays the guard;
 * this is only the display, and the contract decides anyway.
 */
export function checks(
  picks: Map<string, Draft>,
  rewardsBps: number,
  epochMin: number,
  platformBps: number,
  legsBps = 0,
): Check[] {
  const chosen = [...picks.values()].filter((p) => p.on);
  const sum = chosen.reduce((a, c) => a + c.bps, 0);
  return [
    {
      ok: chosen.length >= MIN_BASKET && chosen.length <= MAX_BASKET,
      label: `${chosen.length} stock${chosen.length === 1 ? "" : "s"} — between ${MIN_BASKET} and ${MAX_BASKET}`,
    },
    {
      ok: chosen.length > 0 && chosen.every((c) => c.bps >= MIN_ALLOC_BPS),
      label: `every weight at least ${pct(MIN_ALLOC_BPS)}`,
    },
    {
      ok: sum === BPS,
      // "weights add up to 100 % of 100 %" is what the mechanical translation
      // of "${sum} of ${BPS}" produced, and it reads as a stutter.
      label: sum === BPS ? "weights add up to 100 %" : `weights add up to ${pct(sum)}, not 100 %`,
    },
    {
      ok: rewardsBps >= MIN_REWARDS_BPS && rewardsBps + platformBps <= BPS,
      label: `${pct(rewardsBps)} to ${heldWho(legsBps)}${heldNet(rewardsBps, legsBps)}`
        + ` — floor ${pct(MIN_REWARDS_BPS)}, and that plus the platform at most 100 %`,
    },
    {
      ok: Number.isInteger(epochMin) && epochMin >= MIN_EPOCH_MIN && epochMin <= MAX_EPOCH_MIN,
      label: `epoch of ${epochMin} min — between ${MIN_EPOCH_MIN} and ${MAX_EPOCH_MIN}`,
    },
  ];
}

/**
 * Splits `BPS` as evenly as integers allow, handing the remainder out one unit
 * at a time.
 *
 * It has to land on exactly `BPS` or `createVault` reverts on the sum. An
 * earlier version rounded each share down to a whole percent first, which made
 * three legs 3400/3300/3300 — tolerable — but eight legs 1600/1200×7, which is
 * not a split anyone asked for. Exact division gives 1250 each.
 */
export function spread(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(BPS / n);
  const out: number[] = new Array(n).fill(base);
  const left = BPS - base * n;
  for (let i = 0; i < left; ++i) out[i] = base + 1;
  return out;
}
