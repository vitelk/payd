/**
 * yield.ts — the one number that answers "why would I hold this?".
 *
 * The page already said what the cycle DOES: epochs covered, purchases made,
 * stocks handed to holders in ETH. None of that is an answer to the only
 * question a visitor actually arrives with, which is what holding pays. "0.42
 * ETH handed to holders" is not that answer — it is a number with no
 * denominator, and a reader cannot tell from it whether their own hundred
 * dollars would have earned a dollar or a cent.
 *
 * So: dollars paid, over dollars held. The numerator is what the vault spent on
 * stocks for holders (`quoteFundedFor`, summed over the basket — the same
 * figure the hero already shows, priced). The denominator is the **eligible
 * float**: supply minus the seven structural exclusions, which is by
 * construction the set of tokens that actually receives a share. Using the
 * whole supply instead would divide by tokens sitting in the curve that earn
 * nothing, and understate what holding pays by whatever fraction has not been
 * sold yet — which at launch is most of it.
 *
 * Everything here is pure, and none of it imports `config.js` or `chain.js` —
 * the same rule `curve.ts` and `basket.ts` follow, for the same reason: this is
 * arithmetic a reader may act on, so it has to be checkable under node with no
 * chain in the way.
 */

/**
 * A Uniswap v3 pool's spot price of `a` in units of the other token.
 *
 * `sqrtPriceX96 ** 2` is the price of **token0 in token1**, in raw units. Which
 * of the two is token0 is decided by address order, not by what is being asked
 * for, so the answer has to be inverted half the time — and the decimal
 * adjustment inverts with it. Getting that backwards does not throw, it returns
 * a number off by ~1e12.
 *
 * Character for character the same function as `offchain/src/value.ts`. Copied
 * rather than shared: the two packages have no build step in common, and
 * `yield.test.ts` asserts the two agree on a real pool reading so the copy
 * cannot drift silently.
 */
export function spotPrice(
  sqrtPriceX96: bigint,
  aIsToken0: boolean,
  decA: number,
  decB: number,
): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const raw = sqrt * sqrt;
  return aIsToken0 ? raw * 10 ** (decA - decB) : 1 / (raw * 10 ** (decB - decA));
}

/** Everything the panel needs, in units that are already dollars and seconds. */
export interface YieldInput {
  /** Dollars the vault has turned into stock for holders, since genesis. */
  paidUsd: number;
  /** Supply that actually earns: total minus the structural exclusions, in
   *  whole tokens. */
  floatTokens: number;
  /** One token, in dollars. */
  priceUsd: number;
  /** How long the numerator took to accumulate. */
  ageSeconds: number;
}

export interface Yield {
  /** Dollars of stock earned by $100 held for the whole period. */
  per100: number;
  /** The same rate, extrapolated to a year. A PERCENTAGE, not a multiple. */
  perYear: number;
}

const YEAR = 365 * 24 * 3600;

/**
 * `null` when the rate cannot be computed rather than a zero that reads as
 * "this pays nothing". A float of zero (every token excluded), a price of zero
 * (no pool yet) and an age of zero (first block) are all "ask again later", and
 * the three are indistinguishable from a 0 % yield once rendered.
 *
 * The extrapolation is deliberately linear and deliberately not compounded: the
 * shares are paid in equities a holder keeps, not reinvested into the token, so
 * there is nothing compounding. Stretching a 3-day rate to a year is already the
 * optimistic reading — `ageSeconds` is returned to the caller's label so the
 * page can say how short the window is.
 */
export function yieldOf(i: YieldInput): Yield | null {
  const floatUsd = i.floatTokens * i.priceUsd;
  if (!(floatUsd > 0) || !(i.ageSeconds > 0) || !Number.isFinite(i.paidUsd)) return null;
  const fraction = i.paidUsd / floatUsd;
  return { per100: fraction * 100, perYear: fraction * (YEAR / i.ageSeconds) * 100 };
}

/**
 * The eligible float, in raw units.
 *
 * Takes the balances already read rather than reading them, so the caller keeps
 * its one batched multicall and this stays testable. Clamped at zero: a
 * duplicate in the exclusion set — the vault IS the `creatorFeeRecipient`, and
 * a launch where the curve and the token collide is not impossible — would
 * otherwise subtract the same balance twice and produce a negative float, which
 * `yieldOf` would then read as "no pool yet". De-duplicating is the caller's
 * job and `excludedBalances` should already be keyed by address; this is the
 * belt.
 */
export function floatOf(totalSupply: bigint, excludedBalances: bigint[]): bigint {
  const held = excludedBalances.reduce((a, b) => a + b, 0n);
  return held >= totalSupply ? 0n : totalSupply - held;
}
