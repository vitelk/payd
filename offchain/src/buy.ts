/**
 * Whether a `buyBasket` is worth making, and for how much.
 *
 * Its own module, and a pure function, for two reasons. `keeper.ts` builds a
 * wallet from `KEEPER_PRIVATE_KEY` at import time, so nothing there can be
 * unit-tested; and this is money logic that was wrong in three places at once
 * — it earns a check that runs in a second rather than a fork.
 *
 * **It mirrors `FeeVault.buyBasket` exactly.** Every line below has a
 * counterpart in the contract, and the keeper's only job is to not send a
 * transaction the contract would refuse, or one that loses money.
 */
import type { Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Measured: 1,465,270 gas for five stocks. Rounded up. */
export const BUY_BASKET_GAS = 1_500_000n;
/** Buy at least five times what the purchase costs in gas. Ether vaults. */
export const GAS_K_MIN_EPOCH = 5n;

/**
 * On a vault that is NOT quoted in ether, a purchase must be worth at least
 * this many `MIN_BUY_QUOTE` before it is worth making.
 *
 * **Derived, not chosen: it is `gas / bounty`.** Such a vault refunds nothing;
 * its only income is `keeperBountyBps`, a share of what the purchase MOVED. So
 * a purchase pays for itself only above
 *
 *     gasCost / bountyBps  =  $0.841 / 0.0070  =  $120
 *
 * — $0.841 being a ten-leg basket at the 2026-09-11 basefee. `MIN_BUY_QUOTE` is
 * about $25 in the vault's own raw units, so the threshold is ~5 of them. That
 * detour through `MIN_BUY_QUOTE` is what keeps this oracle-free: it is the only
 * dollar-denominated quantity a vault carries.
 *
 * Without it the keeper buys at `MIN_BUY_QUOTE` itself — $25 of basket for
 * $0.841 of gas, earning $0.175 of bounty. **Every purchase at the floor loses
 * $0.67**, and on a vault at $20k of daily volume the reserve clears $25 often
 * enough to do that about forty times a day.
 *
 * Unlike the delivery floor this is a keeper heuristic, not part of the root:
 * nothing reconstructs it, so it can be retuned after launch without making an
 * honest keeper look forged.
 */
export const NON_ETH_BUY_TARGET_MULTIPLE = 5n;

/**
 * How long a non-ether vault may sit under that target before it is bought
 * anyway, at whatever the reserve holds.
 *
 * **The target is a goal, not a gate, and this is the difference.** As a gate
 * it strands: `spent_` is `max(payoutBps x free, MIN_BUY_QUOTE)`, so demanding
 * a $125 purchase demands a $3,150 reserve — a token that never reaches
 * $67,000 of lifetime volume would then convert NOTHING, ever, and its holders
 * would have no share to claim rather than a small one. The contract's own
 * floor asks for $50 of reserve, i.e. ~$1,064 of lifetime volume; a keeper
 * heuristic must not be the thing that undoes that.
 *
 * With a deadline the two cases separate themselves, and neither needs to be
 * detected:
 *
 *   - a vault with volume crosses the target within hours and is bought big,
 *     profitably, a few times a day rather than forty times at the floor;
 *   - a vault whose volume has died buys once a day at the floor. One purchase
 *     losing $0.67 instead of forty, and its holders are served.
 *
 * 24 h, the same cadence `stepDistribute` pushes on, and the same
 * lost-state-costs-one-extra-call shape: forgetting the timestamp buys once
 * more than needed, and nothing else.
 */
export const NON_ETH_BUY_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * The share of a pool's depth a single leg may spend.
 *
 * **This is the whole of T-TWAP-01's remedy, and it lives here because it could
 * not live on-chain.** `FeeVault._legFloor` tolerates a constant
 * `MAX_SLIPPAGE_BPS = 300` while the purchase SCALES with the reserve — a leg
 * may be 9 000 bps of `payoutBps` up to `MAX_PAYOUT_BPS` of the free reserve —
 * and nothing in the contract compares the two. Measured at block 60310000: a
 * 90 % MRVL leg of a 24 ETH reserve at `MAX_PAYOUT_BPS` is 5 576.98 USDG and
 * fills at **9 722 bps of the TWAP, i.e. 2.78 % under it**, inside the band,
 * with no revert and no event — about $155 of holders' money on one purchase.
 *
 * Putting the depth read in `_legFloor` was built and measured: **+876 bytes,
 * landing `FeeVault` at 24 842 against a 24 576 cap**. It does not deploy. So
 * the bound is here, and `FLOWS.md` §7.e records what that does and does not
 * buy: it binds the keeper, not a stranger, because `buyBasket` is
 * permissionless.
 *
 * **The value is derived from two measurements, not chosen.** At block 60310000
 * the MRVL/USDG tier-3000 pool's depth at +1 % reads **841.86 USDG** — the
 * allowlist's $5 312 is a 2026-09-08 photograph of a quantity that moves, which
 * is rule 3 of that file, and the keeper re-measures rather than reads it. The
 * two fills at that block:
 *
 *     leg   299.90 USDG   =   35.6 % of depth   ->  41 bps under the TWAP
 *                                                   (30 of which is the pool fee)
 *     leg 5 576.98 USDG   =    662 % of depth   -> 278 bps under
 *
 * Impact is near enough linear in the ratio, so **one whole depth of leg is
 * about 30 bps of impact** — a tenth of the 300 bps band, and the point at which
 * the steady-state purchase §2.4 describes is not clamped at all. A tighter
 * ceiling would slice every ordinary purchase to buy nothing: at 10 % the
 * harmless $300 leg above would already be cut to $84.
 */
export const MAX_LEG_DEPTH_BPS = 10_000n;

/**
 * The largest purchase whose worst leg stays inside `MAX_LEG_DEPTH_BPS` of its
 * pool's depth. `depth` and the result are in the same units — the caller
 * converts, because only it knows the vault's quote.
 *
 * A leg with no measurable depth is SKIPPED rather than treated as zero: a pool
 * that cannot be read must not silently clamp every purchase to nothing. The
 * contract skips such a leg on its own (`_legFloor` returns 0 when the pool is
 * absent or cannot serve the window), and the USDG waits in `pivotReserve`.
 */
export function maxSpendForDepth(legs: { bps: bigint; depth: bigint }[]): bigint | undefined {
  let cap: bigint | undefined;
  for (const l of legs) {
    if (l.bps === 0n || l.depth === 0n) continue;
    // leg = amountIn * bps / 10_000  <=  depth * MAX_LEG_DEPTH_BPS / 10_000
    const c = (l.depth * MAX_LEG_DEPTH_BPS) / l.bps;
    if (cap === undefined || c < cap) cap = c;
  }
  return cap;
}

/**
 * **How many observation slots a ring needs to span a window (T-HYP-02).**
 *
 * A Uniswap v3 pool's observation ring is a FIXED number of slots, so the
 * seconds of history it holds is `slots x (average gap between trades)`. The
 * busier the pool, the shorter that history: **popularity is what kills a TWAP
 * window, not neglect.** Measured in the repository on PFE/USDG, a LISTED
 * QUOTE — 64 slots spanning 943 seconds on 2026-09-10, 15.7 minutes against the
 * 30 required, after weeks of being green.
 *
 * What that costs is not symmetric. A basket LEG whose pool cannot serve the
 * window is skipped and its pivot waits; the FIRST HOP has no such mercy —
 * `FeeVault._route` asks `TwapFloor.meanTick`, which reverts, and the whole
 * `buyBasket` goes with it (`test/FeeVault.t.sol::test_AQuotePoolTooYoung-
 * ForTheWindowTakesTheWholePurchaseDown`). On a vault whose quote pool is
 * permanently busy that is not deferred, it is stranded.
 *
 * **And the remedy is a transaction, not a vote.**
 * `increaseObservationCardinalityNext` is permissionless: anyone may grow
 * another pool's ring, once, for gas. So the keeper grows it rather than
 * waiting for the timelock to delist a currency that is doing nothing wrong.
 *
 * Returns 0 when the ring already covers the window with its margin. Otherwise
 * the number of slots to ask for, scaled by the density the ring is showing
 * now, capped at the `uint16` the pool takes.
 */
export function slotsForWindow(span: bigint, slots: bigint, window: bigint, marginBps = 2_000n): bigint {
  const want = (window * (10_000n + marginBps)) / 10_000n;
  if (slots === 0n) return 0n;
  // A ring with no history to measure: nothing to scale from, so ask for enough
  // slots to cover the window at one observation a second, which is the densest
  // v3 can write. Erring high costs gas once and nothing after.
  if (span === 0n) return want > 65_535n ? 65_535n : want;
  if (span >= want) return 0n;
  const needed = (slots * want + span - 1n) / span; // ceil
  return needed > 65_535n ? 65_535n : needed;
}

export interface VaultBuyState {
  /** `rewardsPool`, in the vault's QUOTE units. */
  pool: bigint;
  payoutBps: bigint;
  /** `MAX_REFUND`, wei. Only an ether vault holds this back. */
  maxRefund: bigint;
  /** `MIN_BUY_QUOTE` — NOT `MIN_BUY`, which is the wei constant. */
  minBuyQuote: bigint;
  quote: Address | string;
  /** `BUY_BASKET_GAS * basefee`, wei. Meaningful on an ether vault only. */
  gasCost: bigint;
  /** Milliseconds since this vault last bought. Non-ether vaults only. */
  sinceLastBuyMs?: number;
  /** `maxSpendForDepth`, converted into this vault's QUOTE units. Absent when
   *  the depths could not be measured, in which case nothing is clamped. */
  maxAmountIn?: bigint;
}

export type BuyDecision =
  | { buy: true; amountIn: bigint }
  | { buy: false; why: string };

export function buyDecision(v: VaultBuyState): BuyDecision {
  const isEth = v.quote === ZERO;

  // `buyBasket` holds back what it may owe its caller: MAX_REFUND in wei on an
  // ether vault, MIN_BUY_QUOTE in its own units on any other. Reading the wrong
  // one here is what made the keeper skip every non-ether vault for ever — the
  // wei constant is larger than any plausible USDG reserve, so `pool <= held`
  // was true on every tick.
  const held = isEth ? v.maxRefund : v.minBuyQuote;
  if (v.pool <= held) return { buy: false, why: "reserve under what the vault holds back" };

  const free = v.pool - held;
  let amountIn = (free * v.payoutBps) / 10_000n;
  if (amountIn < v.minBuyQuote) amountIn = v.minBuyQuote;
  if (amountIn > free) return { buy: false, why: "reserve short of the floor, letting it build" };

  // **The depth clamp, and it SHRINKS rather than refuses.** Refusing would
  // strand: `spent_` is a fraction of the free reserve, so a purchase held back
  // for being too large comes back larger next window and never clears. Buying
  // in slices drains the same reserve at a price the pool can take, one window
  // at a time, and the epochs the slices cover are contiguous either way.
  //
  // Never below `MIN_BUY_QUOTE`: that is the contract's own floor and a pool
  // too thin for ~$25 is one `_legFloor` will skip on its own.
  if (v.maxAmountIn !== undefined && amountIn > v.maxAmountIn) {
    amountIn = v.maxAmountIn > v.minBuyQuote ? v.maxAmountIn : v.minBuyQuote;
  }

  // The `1 - 1/K` rule, in the currency the vault actually pays in.
  if (isEth) {
    // Refunded at true cost, so any purchase breaks even. This only declines to
    // spend a fixed-cost transaction on dust.
    if (amountIn < GAS_K_MIN_EPOCH * v.gasCost) return { buy: false, why: "purchase under 5x its gas" };
  } else {
    // Refunded by nothing; paid by a bounty on what moves. Under the target the
    // purchase loses money — but only until the deadline, after which a vault
    // that cannot reach the target is served anyway rather than stranded.
    const waited = v.sinceLastBuyMs ?? Number.POSITIVE_INFINITY;
    if (amountIn < NON_ETH_BUY_TARGET_MULTIPLE * v.minBuyQuote && waited < NON_ETH_BUY_MAX_WAIT_MS) {
      return { buy: false, why: "purchase under gas/bounty, letting it build" };
    }
  }
  return { buy: true, amountIn };
}


/**
 * Whether the creator's residue is worth a `payCreator`.
 *
 * **Same rule as everywhere, and the fifth place it was written in the wrong
 * currency.** `payCreator` is not refunded by the vault, so the `1 - 1/K` bar
 * applies: only spend the gas once it is at most 5 % of what moves. But
 * `creatorPool` is denominated in `QUOTE` and `DEV_GAS * basefee` is wei, so on
 * a USDG vault the test read
 *
 *     500_000_000 (a $500 residue)  >=  103_884_800_000_000  ->  false
 *
 * and **the creator was never paid at all**. On an 18-decimal stock quote the
 * bar landed at about $0.02 instead of $0.25, i.e. dust paid at a loss.
 *
 * `MIN_BUY_QUOTE` gives the bar a currency again: 1 % of it is ~$0.25, the same
 * figure the wei constant produces at today's basefee, in the units the vault
 * actually holds.
 */
export const NON_ETH_DEV_BAR_BPS = 100n;

export function payCreatorDecision(
  creatorPool: bigint,
  quote: Address | string,
  minBuyQuote: bigint,
  devGasCost: bigint,
): boolean {
  if (creatorPool === 0n) return false;
  const bar = quote === ZERO ? devGasCost : (minBuyQuote * NON_ETH_DEV_BAR_BPS) / 10_000n;
  return creatorPool >= bar;
}
