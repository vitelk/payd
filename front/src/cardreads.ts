/**
 * cardreads.ts — the four reads the Tokens cards need that the table never made.
 *
 * The impure half of `cards.ts`, split off for that file's stated reason: the
 * arithmetic stays checkable under node, and everything that touches a node
 * lives here. Same division as `yield.ts` / `metrics.ts`, and this file reuses
 * that one's pricer rather than answering "what is NVDA worth" a second time.
 */
import { formatUnits, parseAbi, type Address, type Hex } from "viem";
import { pub, distributorAbi, vaultAbi, erc20Abi } from "./chain.js";
import { usdPrice } from "./metrics.js";
import { GATEWAYS } from "./config.js";
import { checkLogo } from "./launchlog.js";
import { fetchArtifact, buildClaim } from "./artifact.js";
import { paidOf } from "./cards.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** The launched token's own metadata. Pons writes `logo` into the token at
 *  launch and there is no setter — measured, `launchlog.ts` carries the note.
 *  It appears in no event, so the only way to it is this call. */
const tokenMetaAbi = parseAbi(["function logo() view returns (string)"]);

/** What `readExtras` adds to a row. */
export interface Extra {
  /** Dollars of equities delivered since launch. `null` is "could not be read"
   *  and 0 is "nothing yet" — the card says two different things. */
  paidUsd: number | null;
  /** Seconds since the Distributor's epoch zero. */
  ageSeconds: number | null;
  /** Resolved image URL, or "" for the ticker fallback. */
  logo: string;
  /** The basket, kept so `readOwed` can price a claim without reading it again. */
  legs: { stock: Address; decimals: number; price: number }[];
}

/**
 * The card's four reads, for every launch at once.
 *
 * **Three ticks, whatever the length of the list** — not three per launch. Each
 * `Promise.all` below is one tick, which `batch.multicall` folds into a single
 * `eth_call` (`chain.ts`), the same property the index's own two rounds have.
 * Issued per launch instead, a registry of fifty would pay ~150 serialised
 * round trips for what costs three.
 *
 *  1. the basket, the age and the logo, per launch;
 *  2. the decimals of every DISTINCT stock, and a price per distinct
 *     (stock, tier). Fifty launches draw their baskets from the same dozen
 *     equities, so this is where the deduplication pays: priced per launch-leg
 *     it would be 400 pool reads for 12 answers;
 *  3. `totalDistributed` per launch-leg, which is the headline.
 *
 * The age is `Distributor.GENESIS()` and NOT the `VaultCreated` log. Both mark
 * the same moment, and one of them is reachable: the forward log walk cannot
 * get to the head on this chain — 216 k blocks before the node throttles,
 * against a head that moves ~864 k a day (`config.ts`, `KNOWN_FACTORIES`) —
 * which is exactly how three payout modes stayed invisible in the launch form
 * for six days. A number every Distributor already exposes costs one batched
 * read and cannot go stale.
 */
export async function readExtras(
  launches: readonly { vault: Address; distributor: Address; token: Address }[],
): Promise<Map<string, Extra>> {
  const out = new Map<string, Extra>();
  const live = launches.filter((l) => l.token !== ZERO);

  // --- tick one: basket, age, logo.
  const heads = await Promise.all(live.map(async (l) => {
    const [alloc, genesis, logo] = await Promise.all([
      pub.readContract({ address: l.vault, abi: vaultAbi, functionName: "getAllocations" })
        .catch(() => null) as Promise<readonly { stock: Address; poolFee: number }[] | null>,
      pub.readContract({ address: l.distributor, abi: distributorAbi, functionName: "GENESIS" })
        .catch(() => null) as Promise<bigint | null>,
      pub.readContract({ address: l.token, abi: tokenMetaAbi, functionName: "logo" })
        .catch(() => "") as Promise<string>,
    ]);
    return { l, alloc, genesis, logo };
  }));

  // --- tick two: one price per distinct (stock, tier), one decimals per stock.
  const tiers = new Map<string, { stock: Address; fee: number }>();
  for (const h of heads) {
    for (const a of h.alloc ?? []) tiers.set(`${a.stock.toLowerCase()}:${a.poolFee}`, { stock: a.stock, fee: a.poolFee });
  }
  const addrs = new Map<string, Address>();
  for (const t of tiers.values()) addrs.set(t.stock.toLowerCase(), t.stock);

  const decimals = new Map<string, number>();
  await Promise.all([...addrs].map(async ([k, a]) => {
    decimals.set(k, Number(
      await pub.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ));
  }));
  const priced = new Map<string, number>();
  await Promise.all([...tiers].map(async ([k, t]) => {
    priced.set(k, await usdPrice(t.stock, t.fee, decimals.get(t.stock.toLowerCase()) ?? 18).catch(() => 0));
  }));

  // --- tick three: what has actually left the contract, per leg.
  await Promise.all(heads.map(async (h) => {
    const key = h.l.vault.toLowerCase();
    const age = h.genesis === null ? null : Math.floor(Date.now() / 1000) - Number(h.genesis);
    const logo = checkLogo(h.logo ?? "", GATEWAYS);
    const shown = logo.ok ? logo.preview : "";
    if (!h.alloc) {
      out.set(key, { paidUsd: null, ageSeconds: age, logo: shown, legs: [] });
      return;
    }
    const units = await Promise.all(h.alloc.map((a) =>
      pub.readContract({
        address: h.l.distributor, abi: distributorAbi, functionName: "totalDistributed", args: [a.stock],
      }).catch(() => null) as Promise<bigint | null>));
    const legs = h.alloc.map((a, i) => ({
      stock: a.stock,
      decimals: decimals.get(a.stock.toLowerCase()) ?? 18,
      price: priced.get(`${a.stock.toLowerCase()}:${a.poolFee}`) ?? 0,
      units: units[i] ?? null,
    }));
    out.set(key, {
      paidUsd: paidOf(legs),
      ageSeconds: age,
      logo: shown,
      legs: legs.map(({ stock, decimals: d, price }) => ({ stock, decimals: d, price })),
    });
  }));

  return out;
}

/**
 * What the viewer can still collect on each launch they hold, in dollars.
 *
 * The slow one, and the reason it runs LAST and alone: the amount owed is not
 * on the chain. `Distributor.owedTo` takes the holder's CUMULATIVE entitlement
 * as an argument, which only the published artifact carries — so this is one
 * IPFS fetch per held launch, whatever else it is batched with. Only launches
 * the viewer actually holds are walked (typically none to three), the fetches
 * are capped, and a launch that cannot be read keeps the rate line rather than
 * inventing a figure.
 *
 * `owedTo` and not `cumulative - claimedSoFar` computed here: the contract
 * clamps the answer to what remains funded, and a card promising units that
 * have already left the contract is the number a holder would chase.
 */
export async function readOwed(
  held: readonly { vault: Address; distributor: Address }[],
  me: Address,
  legsOf: (vault: Address) => readonly { stock: Address; decimals: number; price: number }[],
  at: number = 4,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(at, held.length) }, async () => {
    for (;;) {
      const h = held[next++];
      if (!h) return;
      try {
        const active = await pub.readContract({
          address: h.distributor, abi: distributorAbi, functionName: "activeRoot",
        }) as bigint;
        if (active === 0n) continue; // nothing published yet: not an error
        const root = await pub.readContract({
          address: h.distributor, abi: distributorAbi, functionName: "roots", args: [active],
        }) as readonly [Address, number, Hex, Hex, number, Hex];
        const art = await fetchArtifact(h.distributor, root[5], active);
        if (!art) continue;
        const claim = await buildClaim(h.distributor, me, art, undefined, "claim");
        if (claim.stocks.length === 0) continue;
        const owed = await Promise.all(claim.stocks.map((s, i) =>
          pub.readContract({
            address: h.distributor, abi: distributorAbi, functionName: "owedTo",
            args: [me, s, claim.cumulative[i]!],
          }).catch(() => 0n) as Promise<bigint>));
        const legs = legsOf(h.vault);
        let usdTotal = 0;
        for (const [i, s] of claim.stocks.entries()) {
          const leg = legs.find((l) => l.stock.toLowerCase() === s.toLowerCase());
          if (!leg || !(leg.price > 0)) continue;
          usdTotal += Number(formatUnits(owed[i] ?? 0n, leg.decimals)) * leg.price;
        }
        out.set(h.vault.toLowerCase(), usdTotal);
      } catch {
        // One launch's gateway, root or proof failing leaves the others alone
        // and leaves this card on its rate line. It is a figure, not a claim
        // path: collecting still works from the launch's own page.
      }
    }
  }));
  return out;
}
