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
export interface Ev { stock: string; at: bigint; poolFee?: number; feed?: Address }

const ZERO = ("0x" + "0".repeat(40)) as Address;

/** Where a log sits in chain order, as one comparable number. */
export const at = (l: { blockNumber: bigint | null; logIndex: number | null }): bigint =>
  (l.blockNumber ?? 0n) * 100_000n + BigInt(l.logIndex ?? 0);

/**
 * Folds the two event streams into the current allowlist.
 *
 * The interesting case is the one nobody hits by accident: a stock delisted and
 * later RE-listed is listed. The two streams are fetched separately, so the
 * removal arrives in its own array with no ordering against the re-listing —
 * deciding on presence in the removed set rather than on chain order would bury
 * a stock that is live again.
 */
export function fold(allowed: Ev[], removed: Ev[]): Map<string, { poolFee: number; feed: Address }> {
  const state = new Map<string, { when: bigint; poolFee: number; feed: Address; live: boolean }>();
  for (const e of allowed) {
    const k = e.stock.toLowerCase();
    const cur = state.get(k);
    if (!cur || e.at >= cur.when) {
      state.set(k, { when: e.at, poolFee: e.poolFee ?? 0, feed: e.feed ?? ZERO, live: true });
    }
  }
  for (const e of removed) {
    const k = e.stock.toLowerCase();
    const cur = state.get(k);
    if (cur && e.at >= cur.when) state.set(k, { ...cur, when: e.at, live: false });
  }
  const out = new Map<string, { poolFee: number; feed: Address }>();
  for (const [k, v] of state) if (v.live) out.set(k, { poolFee: v.poolFee, feed: v.feed });
  return out;
}

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
): string | null {
  const chosen = [...picks.values()].filter((p) => p.on);
  if (chosen.length < MIN_BASKET) {
    return `pick at least ${MIN_BASKET} stocks — with one, a plain Pons launch already pays its holders the paired token`;
  }
  if (chosen.length > MAX_BASKET) return `at most ${MAX_BASKET} stocks`;
  for (const c of chosen) {
    if (c.bps < MIN_ALLOC_BPS) return `each weight must be at least ${MIN_ALLOC_BPS} bps (${MIN_ALLOC_BPS / 100} %)`;
  }
  const sum = chosen.reduce((a, c) => a + c.bps, 0);
  if (sum !== BPS) return `weights add up to ${sum}, they must add up to ${BPS}`;
  if (rewardsBps < MIN_REWARDS_BPS) {
    return `holders must get at least ${MIN_REWARDS_BPS / 100} % — it is the floor the vault enforces`;
  }
  if (rewardsBps + platformBps > BPS) {
    return `${rewardsBps / 100} % to holders plus ${platformBps / 100} % to the platform is more than everything`;
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
      label: `every weight at least ${MIN_ALLOC_BPS / 100} %`,
    },
    { ok: sum === BPS, label: `weights add up to ${sum} of ${BPS}` },
    {
      ok: rewardsBps >= MIN_REWARDS_BPS && rewardsBps + platformBps <= BPS,
      label: `${rewardsBps / 100} % to holders — floor ${MIN_REWARDS_BPS / 100} %, and holders + platform at most 100 %`,
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
