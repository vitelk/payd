/**
 * One rule, shared by the app and the SDK: **an unexpected decode degrades, it
 * never throws and it never shows a wrong number.**
 *
 * It lives here rather than in either surface because both read the same
 * contracts and both had the same defect. `sdk/src/payd.ts` imports it the way
 * it already imports `merkle.ts` and `cid.ts` — a module that depends on
 * nothing but the language, so the library build inlines it and the published
 * package stays self-contained.
 *
 * Why it is needed at all: an ABI is a promise about an address, and the wrong
 * address keeps the promise's shape while breaking its meaning. Pointed at the
 * v1 vault, `getAllocations()` decodes a word holding an ADDRESS into the
 * tuple's `uint24 poolFee`, and viem — rightly — refuses:
 *
 *     Number "1189613467694738019150202360368048557920044818156n"
 *     is not in safe integer range
 *
 * That single rejection took the whole card down, because it was the one read
 * in `info()` with no fallback. The two halves of the answer are here:
 * `soft()` for a read that throws, `toNum()` for a read that succeeds and
 * returns nonsense.
 *
 * The choice between hiding and clamping is settled and it is **hide**
 * (`docs/SDK.md` §8, `docs/WEB_READINESS.md` §0.2): a card missing a line says
 * "we could not read this", a clamped card says something false with the same
 * confidence as the truth. Callers render their empty state on `null`.
 */

/** The largest integer a `number` carries without losing a unit. */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A decoded unsigned integer as a `number`, or `null` when it cannot be one.
 *
 * `null` means UNAVAILABLE, and the caller hides the block. It covers the three
 * ways a read lies without failing: a value above 2^53 (an address, a hash or a
 * balance landing in a field meant to hold a count), a negative one, and
 * `undefined` from a tuple that decoded shorter than its ABI said.
 */
export function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== "bigint") return null;
  return v >= 0n && v <= SAFE ? Number(v) : null;
}

/**
 * `toNum` with an upper bound the caller knows: a value inside the safe range
 * but outside what the field can mean is just as false.
 *
 * `bps` is the case that matters — 10 001 decodes perfectly and is not a share
 * of anything.
 */
export function toNumMax(v: unknown, max: number): number | null {
  const n = toNum(v);
  return n === null || n > max ? null : n;
}

/**
 * A read that must not take the page down with it.
 *
 * The reason it exists rather than a bare `.catch(() => x)` at each call site
 * is that the call sites are the thing that was wrong: four of the eight reads
 * in `info()` had a fallback and the fifth, `getAllocations`, did not. A named
 * wrapper makes the missing one visible in review.
 */
export function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback);
}
