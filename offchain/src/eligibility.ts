/**
 * An epoch's eligibility threshold (docs/ARCHITECTURE.md §S14).
 *
 * A pure function: same inputs, same outputs, no network. That is what lets a
 * verifier replay the exclusion decision without taking our word for it.
 */
export interface FloorResult<A extends string> {
  balances: Record<A, bigint>;
  eligibleSupply: bigint;
  /** Minimum balance kept, in raw units. */
  minBalance: bigint;
  /** true while the start cap binds (the formula would demand more). */
  capped: boolean;
  /** Holders dropped because their share was worth nothing. */
  dusted: number;
}

/**
 * Keeps the holders whose share is worth at least `minShareWei`.
 *
 *     share(holder) = balance / candidateSupply * quoteCumulative >= minShareWei
 * <=> balance >= minShareWei * candidateSupply / quoteCumulative
 *
 * The denominator is the ETH CUMULATED since epoch 0, not the current epoch's.
 * That is the only difference that matters: with the epoch's ETH the threshold
 * would be divided by the epoch length, so 48x harsher on 30-minute epochs than
 * on one-day epochs — and changing the epoch length would silently redefine who
 * is owed what (§S17). With the cumulative figure the threshold falls on its own
 * as fees come in, and it is independent of how time is sliced.
 *
 * `startBalance` caps the threshold at the start: while little ETH has come in,
 * the formula would demand an absurd fraction of supply. The cap sets the
 * starting point ("you need X tokens"), and the formula takes over as soon as
 * the cumulative figure brings it below X.
 *
 * ONE SINGLE PASS, against the sum of candidates BEFORE filtering. Iterating to
 * a fixed point would be tempting — dropping holders lowers the sum, which
 * lowers the threshold, which lets some back in — but it oscillates instead of
 * converging. A single pass is deterministic, slightly conservative, and trivial
 * to replay.
 */
export function applyFloor<A extends string>(
  candidates: Map<A, bigint>,
  quoteCumulative: bigint,
  minShareWei: bigint,
  startBalance: bigint,
): FloorResult<A> {
  if (quoteCumulative <= 0n) throw new Error("quoteCumulative must be > 0");
  if (startBalance <= 0n) throw new Error("startBalance must be > 0");

  let candidateSupply = 0n;
  for (const v of candidates.values()) candidateSupply += v;
  if (candidateSupply === 0n) throw new Error("no candidates");

  const derived = (minShareWei * candidateSupply) / quoteCumulative;
  const minBalance = derived < startBalance ? derived : startBalance;

  // Sorted by address: a Map's iteration order follows insertion order, hence
  // the RPC. Sorting makes the output independent of the network.
  const sorted = [...candidates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  let balances = {} as Record<A, bigint>;
  let eligibleSupply = 0n;
  let dusted = 0;
  for (const [holder, bal] of sorted) {
    if (bal < minBalance) { dusted++; continue; }
    balances[holder] = bal;
    eligibleSupply += bal;
  }

  // If NOBODY clears the bar, the bar is wrong — not the holders. Returning an
  // empty set makes `snapshot` throw, and because the cumulative build replays
  // from epoch 0 and cannot skip a funded epoch, ONE such epoch would stop
  // every future root for good.
  //
  // Reachable early on, where the `startBalance` cap sets the bar at 0.1 % of
  // supply while nobody has bought that much yet: the keeper runs an epoch as
  // soon as `rewardsPool` passes MAX_REFUND, and at `payoutBps = 400` those
  // first purchases — `(pool - 0.02) * 4 %`, so under MIN_SHARE_WEI for any
  // pool below 0.025 ETH — buy less than one eligible share is worth.
  //
  // Waiving the floor costs nothing. It only widens who is in the tree; who is
  // worth an actual delivery is decided separately, by the push floor in
  // `buildCumulative`. Deterministic, so `dispute.ts` replays it identically.
  if (eligibleSupply === 0n) {
    balances = {} as Record<A, bigint>;
    for (const [holder, bal] of sorted) { balances[holder] = bal; eligibleSupply += bal; }
    return { balances, eligibleSupply, minBalance: 0n, dusted: 0, capped: false };
  }

  return { balances, eligibleSupply, minBalance, dusted, capped: minBalance === startBalance && derived > startBalance };
}
