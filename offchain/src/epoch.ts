/**
 * epoch.ts — computing the CUMULATIVE root.
 *
 * **One code path, two callers.** `keeper.ts` uses it to publish, `dispute.ts`
 * to verify. If the two went through different implementations, a serialisation
 * difference would look like fraud and raise a groundless alarm.
 *
 * Each epoch is computed independently (one snapshot, one stock, one amount),
 * then shares are **summed per (holder, stock)**. That sum is what the leaf
 * carries: the contract remembers what it already paid and settles only the
 * difference (docs/ARCHITECTURE.md §S18).
 */
import { createPublicClient, http, keccak256, sha256, toHex, type Address } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RPC_URL, minShareFor } from "./config.js";
import { distributorAbi, feeVaultAbi } from "./abis.js";
import { snapshot, excludedAt, blockAtOrAfter, windows, type PurchaseWindow } from "./snapshot.js";
import { build, shareOf, key, type Entry } from "./merkle.js";
import { scanLogs } from "./logs.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

/**
 * FULL cost of settling one (holder, stock) pair, measured on-chain: Merkle
 * proof verification + writing `claimedSoFar` + transferring the stock token.
 * 93,000 gas, not 40,000 — the transfer alone pays only a third of the bill, and
 * underestimating here means airdropping dust at a loss (docs/recon.md §6).
 */
export const SETTLE_GAS = 93_000n;
/**
 * Delivery threshold: TWO bounds, we keep the higher one.
 *
 *     pushFloor = max( PUSH_TARGET_WEI , PUSH_K_MIN x SETTLE_GAS x basefee )
 *
 * **`PUSH_TARGET_WEI` — the target.** ~$20 of value per delivery. This is what
 * drives in normal operation: at the measured gas price (0.4177 gwei) a delivery
 * costs $0.0927, so the holder keeps **99.54 %**.
 *
 * **`PUSH_K_MIN` — the floor.** Guarantees the holder **at least 95 %** whatever
 * happens. It only binds if gas spikes so far that $20 would no longer leave
 * 95 % — from ~$1.00 per delivery on, i.e. 10.8x the current gas. The threshold
 * then rises with gas instead of letting the holder's share fall.
 *
 * What that gives, by gas price:
 *
 *     delivery $0.09  ->  threshold $20.00  ->  the holder keeps 99.5 %
 *     delivery $0.25  ->  threshold $20.00  ->  the holder keeps 98.8 %
 *     delivery $0.50  ->  threshold $20.00  ->  the holder keeps 97.5 %
 *     delivery $1.00  ->  threshold $20.00  ->  the holder keeps 95.0 %  <- crossover
 *     delivery $2.00  ->  threshold $40.00  ->  the holder keeps 95.0 %
 *
 * Doubled from $10 to $20 on 2026-09-06 to halve the cycle's push gas, and put
 * BACK to $10 on 2026-09-11. Three things retired that doubling:
 *
 *   - **the cost it was buying against has fallen 56.7 %.** Gas was 0.294 gwei
 *     when the doubling was argued and is 0.1299 gwei today (`ESTIMATIONS.md`
 *     §0). At $10 the reserve now has more room than $20 had then;
 *   - **the reserve was never close to binding.** A holder under the floor is
 *     not delivered, so deliveries are bounded by `rewards / floor` — the cost
 *     is a guarantee, not an average. The 3 % reserve is self-funding from a
 *     floor of **$1.34**. At $20 it was oversized fifteen times over;
 *   - **the wait is the product.** Holders of a launch want to receive, and at
 *     $20 a 0.1 % holder of a token doing $50k a day waited ten days for it.
 *
 * $10 and not lower because of the rule this file already had and
 * `determinism.test.ts` already enforced: **at normal gas, the delivery must
 * eat less than 1 %**. That is what picks the number — $0.0927 a delivery at
 * the 0.4177 gwei the test calls normal is 0.93 % of $10, and would be 1.85 %
 * of $5. The rule chose, not taste.
 *
 * Nothing is withheld either way: the share keeps accruing and `claim` stays
 * open for whoever does not want to wait their turn.
 *
 * ⚠️ **CHANGE IT BEFORE A LAUNCH OR NOT AT ALL.** `dispute.ts` recomputes an old
 * root with the constant it finds in this file, so moving it makes every root
 * published before the move recompute to a different `pushRoot` — an honest
 * keeper reported as forged, exactly the failure the `claimedSoFar` fix of the
 * same day removed. Moving it after launch needs the treatment the exclusion
 * list already has (§S23): a dated log, replayed up to the covered epoch.
 *
 * PUSH_TARGET_WEI is denominated in WEI, not dollars: reading a USD price would
 * require the historical state of a Chainlink feed, which the public RPC does not
 * serve. The target therefore drifts with the ETH price — a published constant,
 * to be readjusted if the price moves sharply.
 *
 * Raising the threshold WITHHOLDS nothing: the total distributed is identical,
 * only the batch size changes. A holder in a hurry does not wait: `claim` stays
 * open.
 */
export const PUSH_TARGET_WEI = 4_192_000_000_000_000n; // ~$10 at $2,386/ETH
export const PUSH_K_MIN = 20n; // 1 - 1/20 = 95 % guaranteed to the holder

/**
 * **On a vault that is not quoted in ether, none of the two bounds above can be
 * used, and the reason is a units bug this constant exists to close.**
 *
 * `quoteSpent` is not in wei there. `FeeVault._buyLegs` computes it as
 * `legPivot * quoteIn / pivot`, and `quoteIn` is what the vault SPENT — in its own
 * currency. The name is V1's, from when `QUOTE` was always ether. So
 * `pushSet` was comparing a value in raw QUOTE units against a floor in wei,
 * and it failed in opposite directions depending on the quote:
 *
 *     USDG  (6 decimals, $25 = 25e6)     a $1,000 share is 1e9 raw units
 *                                        against a floor of 8.384e15
 *                                        -> NOTHING was ever pushed
 *     NVDA  (18 decimals, $25 = 0.12e18) 8.384e15 raw units is 0.0084 NVDA
 *                                        -> a floor of $1.89, not $20, i.e.
 *                                           dust delivered at a loss, on a
 *                                           vault that refunds no gas at all
 *
 * **The floor has to be denominated in the vault's own currency, and one
 * already is.** `MIN_BUY_QUOTE` is about $25 in the quote's raw units, written
 * at the vault's birth from `Payd.quoteListing` and never written again — so it
 * is deterministic for `dispute.ts`, which is the binding constraint here, and
 * it needs no price feed. The bounty cap uses the same unit for the same
 * reason.
 *
 * **40 % of it, i.e. ~$10 — the same floor an ether vault has, in another
 * currency.** There is no reason for the two to differ: the number is a product
 * decision about how often a holder receives, and which currency the fees
 * happened to arrive in is not a holder's concern.
 *
 * It was set at 8x (~$200) for an afternoon, on the argument that a non-ETH
 * vault refunds no delivery gas, so fewer deliveries meant an affordable bill.
 * The arithmetic did not support rationing anything:
 *
 *     floor   deliveries cost   + purchase   the keeper fronts
 *     $200        0.020 %         0.250 %         27 bps
 *     $100        0.040 %         0.250 %         29 bps
 *     $10         0.402 %         0.250 %         65 bps
 *
 * — all of it against the **3.00 %** of rewards an ETHER vault already takes as
 * `distGasBps` for that delivery service alone. At $10 a non-ether vault's
 * holders pay 65 bps for the whole cycle, basket included: four times less than
 * what the protocol already charges its ether holders for delivery on its own.
 * `FeeVault` seeds `keeperBountyBps` at 70 to cover it.
 *
 * The gas bound still cannot come along — `PUSH_K_MIN x SETTLE_GAS x basefee`
 * is in wei, and converting it into NVDA needs the oracle this design avoids.
 * At $10 the floor carries the 95 % guarantee by itself up to $0.50 a delivery,
 * i.e. **12x today's $0.0402**, and the holder keeps 99.6 % at today's gas.
 *
 * In bps of `MIN_BUY_QUOTE` rather than a whole multiple, because ~$25 is the
 * granularity the chain hands us and the product question does not care.
 */
export const NON_ETH_PUSH_BPS = 4_000n;

/**
 * The delivery floor for one vault, in the units its shares are denominated in.
 *
 * Derived only from facts written at the vault's birth — `QUOTE` and
 * `MIN_BUY_QUOTE`, neither of which has a setter — plus the anchor block's
 * basefee, which `buildCumulative` already pins. `dispute.ts` and
 * `recompute.ts` reach it through `buildCumulative`, so there is one
 * definition and an honest keeper cannot be reported as forged for it.
 */
export function pushFloorFor(quote: Address, minBuyQuote: bigint, basefee: bigint): bigint {
  if (quote !== "0x0000000000000000000000000000000000000000") return (minBuyQuote * NON_ETH_PUSH_BPS) / 10_000n;
  const gasFloor = PUSH_K_MIN * SETTLE_GAS * basefee;
  return gasFloor > PUSH_TARGET_WEI ? gasFloor : PUSH_TARGET_WEI;
}

/**
 * How often to repeat the L1-pricer warning while it stays on. The keeper ticks
 * every 60 s, so 60 ticks is hourly.
 *
 * Not one line and done: a keeper runs unattended for months, and a single
 * warning at the moment of the flip is a line nobody will ever scroll back to.
 * Repeating it hourly means any `tail` of the log shows the problem, not just
 * the log of the exact hour it started.
 */
export const L1_WARN_EVERY_TICKS = 60;

/** Ticks of runway below which the keeper's gas balance is worth saying out loud. */
export const GAS_WARN_TICKS = 200;
/** And below which it is worth repeating every tick rather than hourly. */
export const GAS_CRITICAL_TICKS = 40;

/**
 * Should the keeper announce its gas balance?
 *
 * **Runway is MEASURED, not modelled.** The keeper sends seven kinds of
 * transaction -- harvest, fundRewards, buyBasket, publishRoot, distribute (once
 * per holder), payCreator, flagHookLost -- most of them refunded, some of them
 * not, and the mix changes with the number of vaults and holders. Any formula
 * for "gas per tick" would be wrong the day a vault is added. The balance delta
 * between two ticks is the truth, and it costs one `getBalance` to read.
 *
 * @param runway ticks the current balance affords at the measured burn, or
 *        `null` while no burn has been observed yet (the first tick, or a
 *        stretch where every call was fully refunded -- which is the good case
 *        and must stay silent).
 */
export function gasRunwayAlert(runway: number | null, ticksSinceWarn: number): boolean {
  if (runway === null) return false;
  if (runway <= GAS_CRITICAL_TICKS) return true;
  if (runway > GAS_WARN_TICKS) return false;
  return ticksSinceWarn >= L1_WARN_EVERY_TICKS;
}

/**
 * Should this tick warn that the L1 pricer is on?
 *
 * Everything the push economics rest on assumes a transaction here pays for its
 * execution and **nothing for its calldata** — `getL1BaseFeeEstimate() = 0`,
 * measured in `docs/recon.md` §10.7. If that changes, ArbOS starts charging the
 * L1 posting of calldata by ADDING to the transaction's gas used, above what the
 * EVM ran. `gasleft()` cannot see it, so `_refund` cannot price it, and the miss
 * grows with calldata — worst exactly on `distribute`, which is 64 Merkle proofs
 * of it. `REFUND_OVERHEAD` is a flat 40,000 and an `internal constant`: the fix
 * is a redeploy, not a setter.
 *
 * A WARNING, deliberately, and never a gate. A live pricer does not make a root
 * wrong — it makes pushing unprofitable. Refusing to publish would punish
 * holders for a change none of them caused.
 *
 * Edge-triggered, then repeated: warn when it is on and was not (or on the first
 * read of the process, so a restart re-announces it), then once an hour while it
 * stays on.
 */
export function l1PricerAlert(previous: bigint | null, current: bigint, ticksSinceWarn: number): boolean {
  if (current === 0n) return false;
  if (previous === null || previous === 0n) return true;
  return ticksSinceWarn >= L1_WARN_EVERY_TICKS;
}
const CACHE_DIR = process.env.EPOCH_DIR ?? "data";

/** One purchase: the epochs it covers, the stocks it bought, and who gets what. */
export interface WindowShares {
  fromEpoch: number;
  toEpoch: number;
  /** The basket bought, and the amount of each. Aligned arrays. */
  stocks: Address[];
  amounts: string[];
  quoteSpent: string;
  periodStart: number;
  periodEnd: number;
  transferBlocks: number;
  eligibleSupply: string;
  minBalance: string;
  /** Weight per holder over the window. One split, applied to every stock. */
  weights: Record<Address, string>;
}

/**
 * What each (holder, stock) had actually been delivered as of `toBlock`,
 * replayed from the `Delivered` logs.
 *
 * Deterministic where `claimedSoFar` is not: the counter on the contract is the
 * value NOW, so it moves as the very deliveries this root authorises land, and
 * a verifier replaying the root an hour later reads a different number. The
 * logs, cut at a fixed height, always say the same thing.
 *
 *   event Delivered(address indexed holder, address indexed stock,
 *                   address indexed caller, uint256 amount)
 *
 * Scanned from the Distributor's genesis: nothing can have been delivered
 * before the contract's first epoch existed.
 */
const DELIVERED_TOPIC = keccak256(toHex("Delivered(address,address,address,uint256)"));

export async function deliveredUpTo(distributor: Address, toBlock: number): Promise<Map<string, bigint>> {
  const genesis = await client.readContract({ address: distributor, abi: distributorAbi, functionName: "GENESIS" });
  const from = await blockAtOrAfter(Number(genesis));

  const paid = new Map<string, bigint>();
  await scanLogs(
    client,
    { address: distributor, fromBlock: from, toBlock, topics: [DELIVERED_TOPIC] },
    (logs) => {
      for (const l of logs) {
        const holder = ("0x" + l.topics[1]!.slice(26)).toLowerCase() as Address;
        const stock = ("0x" + l.topics[2]!.slice(26)).toLowerCase() as Address;
        const k = key(holder, stock);
        paid.set(k, (paid.get(k) ?? 0n) + BigInt(l.data));
      }
    },
  );
  return paid;
}

/**
 * Who is worth an actual delivery. **Pure**, and that is the point.
 *
 * `paid` must be what had been delivered AS OF THE BLOCK THE ROOT IS CUT AT —
 * `deliveredUpTo(distributor, anchorBlock)` — never the live `claimedSoFar`.
 * Passing live state makes the result depend on when it is computed: the
 * deliveries this very root authorises land, every holder becomes settled, and
 * a verifier replaying it afterwards derives an empty push set and reports the
 * root as forged. That happened, on the fork rehearsal of 2026-09-06, and it is
 * why this takes a map instead of reading one.
 */
export function pushSet(
  entries: { holder: Address; stock: Address; cumulative: bigint }[],
  paid: Map<string, bigint>,
  totalQuote: bigint,
  totalCum: bigint,
  pushFloor: bigint,
): Set<string> {
  const keys = new Set<string>();
  for (const e of entries) {
    const already = paid.get(key(e.holder, e.stock)) ?? 0n;
    if (e.cumulative <= already) continue;
    // Approximate value of the outstanding share, in wei of ETH spent.
    const valueWei = ((e.cumulative - already) * totalQuote) / totalCum;
    if (valueWei >= pushFloor) keys.add(key(e.holder, e.stock));
  }
  return keys;
}

export interface CumulativeArtifact {
  upToEpoch: number;
  /** Covered purchases, each with the period its average covers — what a
   *  verifier replays. There is nothing else to record: the period comes from
   *  the epoch calendar, so it cannot have been chosen.
   *
   *  `minBalance` is the eligibility bar that epoch: the front reads the last
   *  one to tell a visitor how many tokens they need to be in the next tree,
   *  rather than reimplementing `applyFloor` in the browser. */
  windows: {
    fromEpoch: number;
    toEpoch: number;
    stocks: Address[];
    amounts: string[];
    periodStart: number;
    periodEnd: number;
    transferBlocks: number;
    minBalance: string;
  }[];
  excluded: Address[];
  entries: { holder: Address; stock: Address; cumulative: string; push: boolean }[];
}

export interface BuiltCumulative {
  artifact: CumulativeArtifact;
  claimRoot: `0x${string}`;
  pushRoot: `0x${string}`;
  cid: `0x${string}`;
  entries: Entry[];
  pushKeys: Set<string>;
  proofFor(holder: Address, stock: Address, tree: "claim" | "push"): string[];
}

/**
 * Canonical serialisation: THIS string is what gets hashed on-chain.
 *
 * It sorts by itself; it does not trust its caller. The Merkle root is already
 * order-insensitive — `StandardMerkleTree` sorts leaves by hash internally — but
 * the CID was not: two honest machines receiving the entries in different orders
 * would have published the same roots and DIFFERENT CIDs, and a verifier
 * comparing CIDs would have read that as fraud. The sort was already done
 * upstream in `buildCumulative`, so by convention; doing it here makes it
 * structural.
 *
 * See `determinism.test.ts`, which fails if it is removed.
 */
export function canonicalJson(a: CumulativeArtifact): string {
  const byEpoch = [...a.windows].sort((x, y) => x.fromEpoch - y.fromEpoch);
  const byKey = [...a.entries].sort((x, y) => {
    const kx = `${x.holder.toLowerCase()}:${x.stock.toLowerCase()}`;
    const ky = `${y.holder.toLowerCase()}:${y.stock.toLowerCase()}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  return JSON.stringify({
    upToEpoch: a.upToEpoch,
    windows: byEpoch.map((w) => ({
      fromEpoch: w.fromEpoch,
      toEpoch: w.toEpoch,
      stocks: w.stocks.map((x) => x.toLowerCase()),
      amounts: w.amounts,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      transferBlocks: w.transferBlocks,
      minBalance: w.minBalance,
    })),
    excluded: a.excluded.map((x) => x.toLowerCase()).sort(),
    entries: byKey.map((e) => ({
      holder: e.holder.toLowerCase(), stock: e.stock.toLowerCase(), cumulative: e.cumulative, push: e.push,
    })),
  });
}

/**
 * Shares for ONE epoch. Cached on disk: a settled epoch never changes again, and
 * recomputing it on every publication would make the cost quadratic in time.
 *
 * The file name carries the DISTRIBUTOR, not just the epoch number. A redeployed
 * Distributor starts its own epoch numbering from its own genesis, so `shares-0`
 * would otherwise mean two different things in the same directory: a keeper
 * reusing its data volume after a redeploy would rebuild the new deployment's
 * roots from the old one's shares. The preflight's cross-check runs on an empty
 * cache and would diverge, so it fails safe rather than publishing — but it would
 * block every publication until someone worked out why. Keying by deployment
 * removes the collision instead of relying on the check to catch it.
 */
export async function windowShares(
  distributor: Address,
  token: Address,
  w: PurchaseWindow,
  /** `minShareFor(QUOTE, MIN_BUY_QUOTE)`, the eligibility floor in the vault's
   *  own units. Threaded in rather than read here so the whole root derives
   *  from one place a verifier can agree with. */
  minShare: bigint,
): Promise<WindowShares | null> {
  mkdirSync(CACHE_DIR, { recursive: true });
  // The floor is IN the key. A cached window computed under a different
  // threshold is a different tree, and silently reusing it is how a verifier
  // and a keeper end up disagreeing for a reason neither can see.
  const path = `${CACHE_DIR}/shares-${distributor.toLowerCase()}-${w.fromEpoch}-${w.toEpoch}-${minShare}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as WindowShares;

  const quoteSpent = w.quoteSpent.reduce((a: bigint, b: bigint) => a + b, 0n);
  if (quoteSpent === 0n) return null;

  // ONE snapshot for the whole purchase. Payd needed one per epoch because an
  // epoch bought one stock; a window buys the basket, so the same split applies
  // to every leg — which is exactly what makes "you own a slice of the basket"
  // true rather than a figure of speech.
  //
  // **A window that predates the token has nobody to pay, and skipping it is
  // what lets every later root exist.** `GENESIS` is the vault's birth, not the
  // launch: on 2026-09-12 the vault was created at 19:13 and $PAYD's first
  // transfer landed at 22:15, so epochs 0-5 closed with the token not yet in
  // existence. The first purchase funded that range all the same — `fundWindow`
  // covers every epoch closed since the last one — and `snapshot` threw "no
  // candidates" on it. Because the cumulative build replays from epoch 0 and
  // cannot step over a funded window, that one throw stopped EVERY root, for
  // good: three hours after genesis the vault had bought three baskets and
  // published nothing.
  //
  // Skipping is deterministic — the window is holder-less on chain, so the
  // keeper, the co-signer and `dispute.ts` all reach the same verdict — and it
  // is the same branch `quoteSpent === 0` already takes. What it costs is that
  // the window's stocks stay in the Distributor, funded and owed to nobody.
  // They can be carried into a later window afterwards if that is judged worth
  // it: roots are cumulative and only ever grow.
  let snap;
  try {
    snap = await snapshot(distributor, token as Address, w.fromEpoch, w.toEpoch, quoteSpent, minShare);
  } catch (e) {
    if ((e as Error).message !== "no candidates") throw e;
    // stderr, NOT stdout. `recompute.ts` — the cross-check's subprocess — writes
    // the rebuilt root to stdout and the parent does `JSON.parse` on it, so one
    // informative line here failed the fifth preflight with `Unexpected token
    // 'w'` and cancelled the publication just as thoroughly as the throw it
    // replaced. Anything this library ever says goes to stderr.
    console.error(`window ${w.fromEpoch}-${w.toEpoch}: no holder existed, skipped`);
    return null;
  }
  const weights: Record<Address, string> = {};
  for (const [holder, bal] of Object.entries(snap.balances) as [Address, bigint][]) {
    if (bal > 0n) weights[holder] = bal.toString();
  }

  const out: WindowShares = {
    fromEpoch: w.fromEpoch,
    toEpoch: w.toEpoch,
    stocks: w.stocks,
    amounts: w.amounts.map((a: bigint) => a.toString()),
    quoteSpent: quoteSpent.toString(),
    periodStart: snap.periodStart,
    periodEnd: snap.periodEnd,
    transferBlocks: snap.transferBlocks,
    eligibleSupply: snap.eligibleSupply.toString(),
    minBalance: snap.minBalance.toString(),
    weights,
  };
  writeFileSync(path, JSON.stringify(out));
  return out;
}

/**
 * Merge one epoch's shares into the running totals.
 *
 * This `+=` IS the cumulative model. Overwrite instead of add and a holder's
 * entry collapses to their LAST epoch, silently erasing everything earned
 * before it. Pulled out of `buildCumulative` — which needs an RPC and so
 * cannot run in CI — because mutation testing showed the single most
 * important property of the design had no test that could fail.
 */
export function accumulate(
  totals: Map<string, Entry>,
  shares: Record<string, string>,
  stock: Address,
): void {
  for (const [holder, amount] of Object.entries(shares) as [Address, string][]) {
    const k = key(holder, stock);
    const cur = totals.get(k);
    if (cur) cur.cumulative += BigInt(amount);
    else totals.set(k, { holder, stock, cumulative: BigInt(amount) });
  }
}

/** Sums every window up to `upToEpoch`, and builds the matching trees. */
export async function buildCumulative(distributor: Address, vault: Address, upToEpoch: number): Promise<BuiltCumulative> {
  const [token, quote, minBuyQuote] = await Promise.all([
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }),
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "QUOTE" }),
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
  ]);
  if (token === "0x0000000000000000000000000000000000000000") throw new Error("vault is not bound to a token");
  // Both floors come from the same two facts, and both are written at the
  // vault's birth and never written again — which is what lets `dispute.ts`
  // rebuild an old root and get the same answer.
  const minShare = minShareFor(quote as string, minBuyQuote as bigint);

  const totals = new Map<string, Entry>();
  const covered: CumulativeArtifact["windows"] = [];
  let quoteTotal = 0n;
  let excluded: Address[] = [];

  for (const w of await windows(distributor)) {
    if (w.toEpoch > upToEpoch) break;
    const sh = await windowShares(distributor, token as Address, w, minShare);
    if (!sh) continue;
    covered.push({
      fromEpoch: sh.fromEpoch, toEpoch: sh.toEpoch, stocks: sh.stocks, amounts: sh.amounts,
      periodStart: sh.periodStart, periodEnd: sh.periodEnd, transferBlocks: sh.transferBlocks,
      minBalance: sh.minBalance,
    });
    quoteTotal += BigInt(sh.quoteSpent);
    // ONE weighting, applied to EVERY stock of the purchase. That is the whole
    // difference D8 makes: a holder of the window gets a slice of the basket,
    // not a slice of whichever stock the rotation reached while they held.
    const supply = BigInt(sh.eligibleSupply);
    for (let i = 0; i < sh.stocks.length; i++) {
      const amount = BigInt(sh.amounts[i]!);
      if (amount === 0n) continue;
      const shares: Record<string, string> = {};
      for (const [holder, weight] of Object.entries(sh.weights)) {
        const part = shareOf(BigInt(weight), supply, amount);
        if (part > 0n) shares[holder] = part.toString();
      }
      accumulate(totals, shares, sh.stocks[i]!);
    }
  }
  if (totals.size === 0) throw new Error("no shares to distribute");

  // The set in force at `upToEpoch`, replayed from the dated log — never the
  // current state, which would make the artifact depend on when it was built.
  excluded = await excludedAt(distributor, upToEpoch);

  // Push floor: the share NOT YET DELIVERED has to be worth enough to justify
  // delivering it. What was already paid is replayed from the `Delivered` logs
  // **up to `anchorBlock`** — not read from `claimedSoFar` at the head.
  //
  // That read is what the rehearsal of 2026-09-06 caught, and it is the same
  // defect as the basefee one below, one line further down. `claimedSoFar` is
  // live state: at publication every holder was owed their share and went into
  // `pushRoot`; once the airdrop had gone out the same computation found them
  // settled and put NOBODY in it. So `pushRoot` and the artifact's `push` flags
  // — hence the cid — changed the moment the root's own deliveries landed, and
  // `dispute.ts` answered "DIVERGENCE DETECTED · the delivery floor was
  // manipulated" on a root that was perfectly honest. That command is the one
  // the README hands to holders to check us with.
  //
  // Replayed at a fixed block it is deterministic, and it is the same quantity:
  // what a holder was owed at the moment the root was cut. It also replaces one
  // RPC round trip PER ENTRY with a single log scan.
  //
  // WARNING: the basefee is read at the LAST BLOCK OF THE COVERED EPOCH, not at
  // the current block. The first version read `client.getBlock()` — the head —
  // which made `pushRoot` depend on WHEN the computation ran: two verifiers ten
  // minutes apart got different push sets, hence different roots. Under the
  // keeper model `dispute.ts` is the only check left: it would have reported a
  // divergence on every run.
  const epochEndTs = Number(
    await client.readContract({ address: distributor, abi: distributorAbi, functionName: "epochEnd", args: [BigInt(upToEpoch)] }),
  );
  const anchorBlock = (await blockAtOrAfter(epochEndTs)) - 1;
  const basefee = (await client.getBlock({ blockNumber: BigInt(anchorBlock) })).baseFeePerGas ?? 1n;

  // On an ether vault, two bounds, keep the higher one:
  //   - PUSH_TARGET_WEI: the ~$20-of-value-per-delivery target;
  //   - PUSH_K_MIN x gas: the floor guaranteeing the holder at least 95 %.
  // At normal gas the target dominates and the holder keeps ~99 %. If gas spikes
  // so far that $20 would no longer leave 95 %, the floor takes over and the
  // threshold rises — the holder never drops below 95 %.
  //
  // On any other vault neither applies: the shares are not in wei. See
  // `pushFloorFor`.
  const paidAt = await deliveredUpTo(distributor, anchorBlock);

  const pushFloor = pushFloorFor(quote as Address, minBuyQuote as bigint, basefee);
  const totalQuote = quoteTotal === 0n ? 1n : quoteTotal;
  const totalCum = [...totals.values()].reduce((a, e) => a + e.cumulative, 0n) || 1n;

  const pushKeys = pushSet([...totals.values()], paidAt, totalQuote, totalCum, pushFloor);

  const entries = [...totals.values()];
  const tree = build(entries, pushKeys);

  const artifact: CumulativeArtifact = {
    upToEpoch,
    windows: covered,
    excluded,
    entries: tree.entries.map((e) => ({
      holder: e.holder, stock: e.stock, cumulative: e.cumulative.toString(), push: pushKeys.has(key(e.holder, e.stock)),
    })),
  };

  return {
    artifact,
    claimRoot: tree.claimRoot,
    pushRoot: tree.pushRoot,
    // sha256, not keccak: the digest is that of a raw IPFS block, so the CIDv1
    // can be rebuilt from the chain. The committed hash IS the address.
    cid: sha256(toHex(canonicalJson(artifact))),
    entries: tree.entries,
    pushKeys,
    proofFor: tree.proofFor,
  };
}
