/**
 * dispute.ts — recomputes a published root and reports any divergence.
 *
 * **This script is what makes the keeper model accountable.** The whole design
 * rests on the assumption that a third party can check; if nobody can, "anyone
 * can contradict us" is just a sentence. It is built to run on the machine of
 * someone who trusts us not at all:
 *
 *   - it takes NO computation parameter. The epoch bounds, the
 *     exclusion list, the token, the ETH spent: everything is read on-chain;
 *   - it goes through exactly the same code as the keeper (`epoch.ts`), so a
 *     reported divergence is a real one, not an implementation difference;
 *   - it works on the free public RPC — no archive node required
 *     (docs/ARCHITECTURE.md §S13).
 *
 * Usage:
 *   pnpm --filter offchain dispute [rootId]
 *
 * With no argument, it checks the most recently published root.
 *
 * It never signs anything and holds no key: it can be audited and run without
 * any risk.
 */
import { createPublicClient, http, type Address } from "viem";
import { RPC_URL, CHAIN_ID } from "./config.js";
import { distributorAbi } from "./abis.js";
import { buildCumulative, canonicalJson } from "./epoch.js";

const chain = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 5, retryDelay: 500 }) });

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** What was published, and what an independent replay produced. */
export interface RootTriple {
  claimRoot: string;
  pushRoot: string;
  cid: string;
}

/**
 * **The verdict, as a pure function — which is the point (T-OFF-01).**
 *
 * `dispute.ts` is the ONLY verification left after §S29 removed the challenge
 * window: the whole keeper model rests on a third party being able to
 * contradict us. It had no test of any kind. The recomputation itself is
 * covered by `determinism.test.ts` and by `test/MerkleCompat.t.sol`; what was
 * not covered is the thing this script exists to do — look at a published root
 * next to an honest replay and SAY that they differ, naming which part.
 *
 * A `false` here is what a forged root looks like from the outside.
 */
export function disputeVerdict(onchain: RootTriple, mine: RootTriple): { matches: boolean; differs: string[] } {
  const differs: string[] = [];
  if (onchain.claimRoot !== mine.claimRoot) differs.push("claimRoot");
  if (onchain.pushRoot !== mine.pushRoot) differs.push("pushRoot");
  if (onchain.cid !== mine.cid) differs.push("cid");
  return { matches: differs.length === 0, differs };
}

/** What each divergence means, in the terms a reader of the report needs. */
export const DIVERGENCE_MEANING: Record<string, string> = {
  claimRoot: "claimRoot differs: entitlements or cumulative amounts were altered",
  pushRoot: "pushRoot differs: the delivery floor was manipulated",
  cid: "cid differs: the published data does not match the roots",
};

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from the environment`);
  return v;
}

async function main() {
  const distributor = env("DISTRIBUTOR") as Address;
  const vault = env("FEE_VAULT") as Address;

  const rootId = process.argv[2] ? BigInt(process.argv[2])
    : await pub.readContract({ address: distributor, abi: distributorAbi, functionName: "rootCount" });
  if (rootId === 0n) { console.log("no root published, nothing to check"); return; }

  const r = await pub.readContract({ address: distributor, abi: distributorAbi, functionName: "roots", args: [rootId] });
  const [publisher, publishedAt, claimRoot, pushRoot, upToEpoch, cid] = r;
  if (claimRoot === ZERO32) { console.log(`root ${rootId} does not exist`); return; }

  console.log(`root #${rootId} published by ${publisher}, covers through epoch ${upToEpoch}`);
  console.log("  on-chain  claimRoot", claimRoot);
  console.log("  on-chain  pushRoot ", pushRoot);
  console.log("  on-chain  cid      ", cid);

  console.log("independent recomputation running (replaying every covered epoch)…");
  const mine = await buildCumulative(distributor, vault, Number(upToEpoch));

  console.log("  recomputed claimRoot", mine.claimRoot);
  console.log("  recomputed pushRoot ", mine.pushRoot);
  console.log("  recomputed cid      ", mine.cid);
  console.log(`  ${mine.entries.length} entries (holder x stock), ${mine.pushKeys.size} above the push floor`);

  const verdict = disputeVerdict({ claimRoot, pushRoot, cid }, mine);
  if (verdict.matches) {
    console.log("\nMATCHES — the published root agrees with the independent recomputation.");
    return;
  }

  console.log("\n*** DIVERGENCE DETECTED ***");
  for (const d of verdict.differs) console.log(`  ${DIVERGENCE_MEANING[d]}`);

  const fs = await import("node:fs");
  const path = `root-${rootId}-recomputed.json`;
  fs.writeFileSync(path, canonicalJson(mine.artifact));
  console.log(`\nrecomputation written to ${path} — compare it with the keeper's data`);

  console.log(`
This root was published by the keeper and took effect IMMEDIATELY. There is no
bond to seize, no challenge window and no on-chain arbitration: the contract
offers no automatic remedy.

What this report is worth is a PUBLIC, reproducible proof. Anyone can re-run
this script without asking the operator for anything and reach the same verdict
— everything it consumes is on-chain.

What is left to do:
  1. publish this file and the divergence you found;
  2. ask the timelock to rotate the keeper (setKeeper, 48 h delay);
  3. check quoteAtRisk(): that is the amount exposed while the key is live.
`);
}

// Only when RUN, not when imported: `dispute.test.ts` loads the verdict above,
// and a `main()` that fires on import would need a chain to do it.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0")) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
