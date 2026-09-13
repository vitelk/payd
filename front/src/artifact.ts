/**
 * The epoch artifact: the fetch, its verification, and building the proofs a
 * settlement needs.
 *
 * **Why this file exists.** Everything that follows lived in `main.ts`, where
 * the distributor was the global constant. The registry page has to do the same
 * thing for N launches at once — one per vault held — so the distributor becomes
 * a PARAMETER. That is the only difference: nothing is added, the sha256
 * verification included.
 */
import { sha256, toHex, parseAbiItem, type Address, type Hex } from "viem";
import { GATEWAYS } from "./config.js";
import { pub, distributorAbi } from "./chain.js";
import { cidFromSha256 } from "./cid.js";
import { claimTree, type Entry } from "./merkle.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;

/** Carries the artifact's IPFS address. In the log rather than in storage:
 *  nothing on-chain reads it, and a byte of log costs 8 gas against 20 000 for
 *  an SSTORE. Must stay identical to `Distributor.RootPublished`. */
export const ROOT_PUBLISHED = parseAbiItem(
  "event RootPublished(uint256 indexed rootId, address indexed publisher, bytes32 claimRoot, bytes32 pushRoot, uint256 upToEpoch, bytes32 digest, string cid)",
);

/** The epoch artifact, exactly as `offchain/src/epoch.ts` serialises it. */
export interface Artifact {
  upToEpoch: number;
  /** `minBalance` is optional here and only here: every other field predates
   *  the deployed keeper, this one does not. */
  windows: {
    fromEpoch: number;
    toEpoch: number;
    stocks: string[];
    amounts: string[];
    periodStart: number;
    periodEnd: number;
    transferBlocks: number;
    minBalance?: string;
  }[];
  excluded: string[];
  entries: (Entry & { push: boolean })[];
}

/**
 * Fetches an epoch's JSON and VERIFIES it against the on-chain hash.
 *
 * The gateway is never taken at its word: if the content's sha256 does not match
 * the `cid` the contract published, it is rejected. So a hostile gateway can
 * only make the page unusable, never falsify an amount or an address.
 */
export async function fetchArtifact(
  distributor: Address,
  digest: Hex,
  rootId: bigint,
): Promise<Artifact | null> {
  if (digest === ZERO32) return null;

  // Two addresses to try, in order of trust -- it is the CONTENT check below
  // that makes trying several of them safe.
  //
  //  1. the CID the keeper published in `RootPublished`. The only one that works
  //     once the artifact exceeds one IPFS block, around 160 holders;
  //  2. the raw CIDv1 rebuilt from the digest. Correct while the artifact fits
  //     in one block, and the only option if the log is unreachable.
  const paths: string[] = [];
  try {
    const logs = await pub.getLogs({
      address: distributor,
      event: ROOT_PUBLISHED,
      args: { rootId },
      fromBlock: "earliest",
    });
    const reported = (logs.at(-1) as { args?: { cid?: string } } | undefined)?.args?.cid;
    if (reported) paths.push(reported);
  } catch { /* the chain may not serve logs this old; the fallback covers it */ }
  paths.push(cidFromSha256(digest));

  for (const path of paths) {
    for (const gw of GATEWAYS) {
      try {
        const res = await fetch(gw.trim() + path);
        if (!res.ok) continue;
        const text = await res.text();
        if (sha256(toHex(text)) !== digest) continue; // the content does not match what was published
        return JSON.parse(text) as Artifact;
      } catch { /* passerelle suivante */ }
    }
  }
  return null;
}

/** The three parallel arrays `claim` and `distribute` expect. */
export interface ClaimArgs {
  stocks: Address[];
  cumulative: bigint[];
  proofs: Hex[][];
}

/**
 * Builds the proofs for settling `account` on one launch.
 *
 * **`via` is not a detail, it is TWO DIFFERENT TREES.** The contract says so
 * itself (`Distributor._settle`, the line `viaClaimRoot ? claimRoot :
 * pushRoot`):
 *
 *   - `claim()`, which the holder signs for themselves, checks against
 *     `claimRoot` — every entry;
 *   - `distribute()`, which ANYONE calls for a third party and which refunds its
 *     gas, checks against `pushRoot` — only the entries marked `push`, the ones
 *     whose share is worth enough to deserve a pushed delivery.
 *
 * A proof built on the wrong tree clears every check in this page and reverts
 * on-chain with `InvalidProof`. That is exactly the kind of bug you only see by
 * paying for a transaction.
 *
 * `pick` filters by stock (lowercased) when the caller offers the choice; the
 * registry page does not and takes everything.
 *
 * A stock whose `owedTo` is zero is dropped HERE rather than by the contract: it
 * would pass the Merkle check while delivering nothing, and the caller would pay
 * for its branch anyway.
 */
export async function buildClaim(
  distributor: Address,
  account: Address,
  artifact: Artifact,
  pick?: Set<string>,
  via: "claim" | "push" = "claim",
): Promise<ClaimArgs> {
  // `claimTree` builds an OZ tree over the list it is given: the push tree is
  // the same code over the filtered entries. On the keeper's side it is
  // literally the same operation (`offchain/src/merkle.ts`, `sorted.filter`).
  const rows = via === "push" ? artifact.entries.filter((e) => e.push) : artifact.entries;
  if (rows.length === 0) return { stocks: [], cumulative: [], proofs: [] };
  const tree = claimTree(rows);
  const out: ClaimArgs = { stocks: [], cumulative: [], proofs: [] };

  for (const e of rows) {
    if (e.holder.toLowerCase() !== account.toLowerCase()) continue;
    if (pick && !pick.has(e.stock.toLowerCase())) continue;
    const owed = (await pub.readContract({
      address: distributor,
      abi: distributorAbi,
      functionName: "owedTo",
      args: [account, e.stock as Address, BigInt(e.cumulative)],
    })) as bigint;
    if (owed === 0n) continue;
    const proof = tree.proofFor(account, e.stock as Address);
    if (!proof) continue;
    out.stocks.push(e.stock as Address);
    out.cumulative.push(BigInt(e.cumulative));
    out.proofs.push(proof);
  }
  return out;
}
