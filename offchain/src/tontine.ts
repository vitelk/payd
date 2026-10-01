/**
 * tontine.ts — the "diamond hands" payout rule.
 *
 * **The whole mode is this file.** On-chain a tontine vault is a V3
 * distribution vault with another word stamped on it
 * (`contracts/tontine/TontineFactory.sol`): the same `FeeVaultV2`, the same
 * `DistributorV3`, the same roots, the same claim. What changes is one rule
 * about what a root may say — and a root is built here.
 *
 * **The rule.** A share you have earned but NOT yet been delivered is
 * conditional on your still holding. Sell half your launch tokens and half of
 * everything still owed to you is forfeited, and handed to the holders who
 * stayed. What has already been delivered is untouchable: the contract has no
 * clawback, and this file never writes a cumulative below what a holder was
 * paid (`forfeit <= undelivered` by construction, which is the invariant the
 * whole design rests on).
 *
 * That overturns, FOR UNDELIVERED SHARES ONLY, `ARCHITECTURE.md`'s "a share
 * once earned is earned for good" — deliberately, and only for vaults whose
 * `Payd.modeOf` says `"tontine"`. Holders of such a launch bought that promise.
 *
 * **Granularity is the purchase window**, not the raw epoch: the snapshot
 * period the rest of the pipeline already computes, so there is no second
 * calendar to keep and no new on-chain read. Everything this needs —
 * `Transfer` (the balances), `WindowFunded` (the amounts), `Delivered` (what
 * was already paid) — is a log the pipeline was already reading, which is what
 * lets `dispute.ts` and the co-signer reach the same root from the chain alone.
 */
import type { Address } from "viem";
import {
  accumulate,
  buildCumulative,
  foldDelivered,
  plainAccrual,
  type BuiltCumulative,
  type Delivery,
  type WindowAccrual,
  type WindowShares,
} from "./epoch.js";
import { key, shareOf } from "./merkle.js";

/**
 * What fraction of a holder's undelivered share the window takes back:
 * `(open - min) / open`, applied as `undelivered * (open - min) / open` so the
 * single integer division lands at the end.
 *
 * **The MINIMUM, not the closing balance.** A holder who sells and buys back
 * inside one window closes where they opened and has still let go; `min` is
 * what says so. **No cliff**: a whale selling one wei forfeits about one wei's
 * worth, not everything.
 *
 * Pure, and it is the sentence a third party has to reimplement to check a
 * tontine root.
 */
export function forfeitOf(undelivered: bigint, open: bigint, min: bigint): bigint {
  if (undelivered <= 0n || open <= 0n || min >= open) return 0n;
  const kept = min < 0n ? 0n : min;
  return (undelivered * (open - kept)) / open;
}

/** `decreases` as the rule reads it: lowercased keys, bigints. */
function decreasesOf(sh: WindowShares): Map<string, { open: bigint; min: bigint }> {
  if (!sh.decreases) {
    // A window cached by a build that predates the field. Silently forfeiting
    // nothing would publish a DISTRIBUTION root under a tontine's name, which
    // is the one failure this mode cannot have.
    throw new Error(
      `window ${sh.fromEpoch}-${sh.toEpoch} was cached without \`decreases\`: delete the shares cache and rebuild`,
    );
  }
  const out = new Map<string, { open: bigint; min: bigint }>();
  for (const [holder, d] of Object.entries(sh.decreases)) {
    out.set(holder.toLowerCase(), { open: BigInt(d.open), min: BigInt(d.min) });
  }
  return out;
}

/**
 * The tontine's window rule: forfeit, then accrue, then redistribute.
 *
 * **The order is the design.** Forfeiting first means a holder cannot sell and
 * keep the very window they sold in; redistributing last means the pool is
 * frozen before it is split, so this is ONE pass and not a fixed point — the
 * same reason `eligibility.ts` computes its floor in one pass. The forfeiter
 * still takes part in the redistribution, by their reduced weight: they held
 * for part of the window and the TWAB already says exactly how much.
 *
 * **What `undelivered` is measured against.** `Delivered` folded at the
 * window's OWN boundary (`sh.lastBlock`), never at the head and never at the
 * root's anchor: a delivery that landed after this window closed was not
 * protected while the window was running, and a verifier replaying the root
 * next week must reach the same number as the keeper did.
 *
 * **Rounding is downwards, twice** — the forfeit taken and the share given —
 * so the redistribution can leave a few wei unallocated. They stay in the
 * Distributor, which is the safe side of the only arithmetic that matters here:
 * `Σ cumulative <= totalFunded`, hence the on-chain clamp is never what stands
 * between a holder and their share.
 */
export const tontineAccrual: WindowAccrual = (totals, sh, deliveries: readonly Delivery[]) => {
  const decreased = decreasesOf(sh);
  const paid = foldDelivered(deliveries, sh.lastBlock);

  // 1. Forfeit, BEFORE this window's accrual.
  const pool = new Map<string, { stock: Address; amount: bigint }>();
  for (const e of totals.values()) {
    const d = decreased.get(e.holder.toLowerCase());
    if (!d) continue;
    const undelivered = e.cumulative - (paid.get(key(e.holder, e.stock)) ?? 0n);
    const forfeit = forfeitOf(undelivered, d.open, d.min);
    if (forfeit === 0n) continue;
    e.cumulative -= forfeit;
    const leg = e.stock.toLowerCase();
    const cur = pool.get(leg);
    if (cur) cur.amount += forfeit;
    else pool.set(leg, { stock: e.stock, amount: forfeit });
  }

  // 2. Accrue exactly as the distribution mode does. The tontine changes what
  //    happens to a share afterwards, never how it is earned.
  plainAccrual(totals, sh, deliveries);

  // 3. Redistribute the frozen pool to the window's eligible holders, by the
  //    same weights and through the same `shareOf` the accrual just used — so
  //    a forfeited unit is split exactly like a bought one.
  const supply = BigInt(sh.eligibleSupply);
  for (const { stock, amount } of pool.values()) {
    const shares: Record<string, string> = {};
    for (const [holder, weight] of Object.entries(sh.weights)) {
      const part = shareOf(BigInt(weight), supply, amount);
      if (part > 0n) shares[holder] = part.toString();
    }
    accumulate(totals, shares, stock);
  }
};

/** The tontine root: `buildCumulative` with this mode's window rule. */
export function buildTontineCumulative(
  distributor: Address,
  vault: Address,
  upToEpoch: number,
): Promise<BuiltCumulative> {
  return buildCumulative(distributor, vault, upToEpoch, tontineAccrual);
}
