/**
 * recompute.ts — recomputes a root and prints it. Nothing else.
 *
 * This is the **counter-computation** in the keeper's preflight. It runs in a
 * SUBPROCESS, with `RPC_URL` pointing at the second node and `EPOCH_DIR` at an
 * empty directory.
 *
 * Both matter:
 *
 *   - **a different RPC**: a node truncating a page of logs is the most likely
 *     failure here, and the most silent one — the missing holders have their
 *     weight redistributed to the others, so the totals stay consistent;
 *   - **an empty cache**: without it the second pass would re-read the
 *     `data/shares-*.json` written by the first. It would agree with itself by
 *     construction, and verify **nothing**.
 *
 * A subprocess rather than an injected client: fresh module state, no shared
 * variable, no chance that an import's in-memory cache lingers. It is also what
 * makes the result comparable to what a third party would get.
 *
 *   tsx src/recompute.ts <distributor> <vault> <upToEpoch>
 */
import { buildCumulative } from "./epoch.js";
import type { Address } from "viem";

const [distributor, vault, upTo] = process.argv.slice(2);
if (!distributor || !vault || upTo === undefined) {
  console.error("usage: recompute <distributor> <vault> <upToEpoch>");
  process.exit(2);
}

const built = await buildCumulative(distributor as Address, vault as Address, Number(upTo));

// Machine-readable output on stdout, nothing else: the parent parses it.
process.stdout.write(
  JSON.stringify({
    claimRoot: built.claimRoot,
    pushRoot: built.pushRoot,
    cid: built.cid,
    entries: built.entries.length,
    pushed: built.pushKeys.size,
  }),
);
