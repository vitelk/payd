/**
 * preflight.ts — the keeper refuses to publish what it cannot verify.
 *
 * **The contract cannot prove a root is correct**: doing so would mean replaying
 * the token's history for every holder. With no challenge window, nothing
 * catches a wrong root after the fact — it takes effect immediately and the
 * stocks go out.
 *
 * So the only defence left is upstream: **a battery of checks the keeper can run
 * on its own, blocking publication at the slightest doubt.** Publishing a
 * doubtful root is far worse than publishing nothing: publishing nothing delays
 * rewards, publishing wrongly misdirects them.
 *
 * What makes these checks useful rather than decorative: they target the
 * failures that are ACTUALLY plausible here, not imaginary attacks.
 *
 *   - an RPC returning an incomplete page of logs -> missing holders, whose
 *     shares are silently redistributed to the others;
 *   - an epoch cache corrupted or truncated on disk;
 *   - a regression in the share computation;
 *   - a stock appearing in the tree without ever having been funded.
 *
 * None of these is malicious. All of them produce a wrong root that nobody could
 * then correct.
 */
import { createPublicClient, http, type Address } from "viem";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RPC_URL } from "./config.js";
import { distributorAbi } from "./abis.js";
import type { BuiltCumulative, CumulativeArtifact } from "./epoch.js";

const RPC_FALLBACK = process.env.RPC_URL_FALLBACK ?? "";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

export interface PreflightResult {
  ok: boolean;
  /** `skipped` means the check did not RUN, and `ok: true` beside it means it
   *  fails OPEN. The two are different facts and a report that prints only the
   *  second reads as coverage that is not there — which is what happened to
   *  the cross-check for as long as an operator could lose their second
   *  endpoint and see nothing but an "ok" line (T-OFF-03). */
  checks: { name: string; ok: boolean; detail: string; skipped?: boolean }[];
}

/**
 * Check 1 — CONSERVATION. For each stock, the sum of promised cumulative amounts
 * cannot exceed what the Distributor actually received.
 *
 * This is the most important check: it catches any root promising more than
 * exists. The contract also protects itself at settlement (`_one` caps at
 * `totalFunded - totalDistributed`), but it does so by truncating SILENTLY — the
 * last to claim receive less. Better not to publish.
 */
export function checkConservation(
  entries: { stock: string; cumulative: bigint }[],
  fundedByStock: Map<string, bigint>,
): { ok: boolean; detail: string } {
  const promised = new Map<string, bigint>();
  for (const e of entries) {
    const k = e.stock.toLowerCase();
    promised.set(k, (promised.get(k) ?? 0n) + e.cumulative);
  }
  for (const [stock, sum] of promised) {
    const funded = fundedByStock.get(stock) ?? 0n;
    if (sum > funded) {
      return { ok: false, detail: `${stock}: ${sum} promised against ${funded} received` };
    }
  }
  return { ok: true, detail: `${promised.size} stocks, none over-committed` };
}

/**
 * Check 2 — MONOTONICITY. A holder's cumulative amount can never go backwards.
 *
 * Roots are cumulative: a cumulative amount that drops means taking away a share
 * someone already earned. The contract would not let it pay out negatively, but
 * it would freeze that holder forever — `claimedSoFar` would stay above the new
 * cumulative amount, and they would never receive anything again.
 *
 * This is exactly what an RPC returning incomplete logs produces.
 */
export function checkMonotonic(
  previous: CumulativeArtifact | null,
  current: { holder: string; stock: string; cumulative: bigint }[],
): { ok: boolean; detail: string } {
  if (!previous) return { ok: true, detail: "first root, nothing to compare against" };

  const now = new Map<string, bigint>();
  for (const e of current) now.set(`${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`, e.cumulative);

  let checked = 0;
  for (const p of previous.entries) {
    const k = `${p.holder.toLowerCase()}:${p.stock.toLowerCase()}`;
    const before = BigInt(p.cumulative);
    const after = now.get(k) ?? 0n;
    if (after < before) {
      return { ok: false, detail: `${k}: ${before} -> ${after}, a cumulative amount went backwards` };
    }
    ++checked;
  }
  return { ok: true, detail: `${checked} previous entries, none regressed` };
}

/**
 * Check 3 — POPULATION. The tree must not empty out all at once.
 *
 * A sharp drop in the number of entitled holders never comes from the market: it
 * comes from an incomplete log replay. The missing holders do not just lose
 * their share — their weight is REDISTRIBUTED to the others, so the error is
 * doubly wrong and perfectly invisible in the totals.
 */
export function checkPopulation(
  previous: CumulativeArtifact | null,
  currentCount: number,
  maxDropBps = 5_000, // -50 %
): { ok: boolean; detail: string } {
  if (!previous || previous.entries.length === 0) {
    return { ok: currentCount > 0, detail: `${currentCount} entries, no history` };
  }
  const before = previous.entries.length;
  const floor = (before * (10_000 - maxDropBps)) / 10_000;
  if (currentCount < floor) {
    return { ok: false, detail: `${before} -> ${currentCount} entries, drop beyond the threshold` };
  }
  return { ok: true, detail: `${before} -> ${currentCount} entries` };
}

/**
 * Check 4 — PROVENANCE. Every stock present in the tree must have been funded by
 * an epoch that is actually covered.
 *
 * A stock appearing with no matching epoch means a tree built from a state that
 * is not the chain's.
 */
export function checkProvenance(
  entries: { stock: string }[],
  windows: { stocks: string[] }[],
): { ok: boolean; detail: string } {
  const funded = new Set(windows.flatMap((w) => w.stocks.map((s) => s.toLowerCase())));
  const seen = new Set(entries.map((e) => e.stock.toLowerCase()));
  for (const s of seen) {
    if (!funded.has(s)) return { ok: false, detail: `${s} is in the tree with no purchase behind it` };
  }
  return { ok: true, detail: `${seen.size} stocks, all funded` };
}

/**
 * The full preflight. Reads on-chain state for the bounds, then runs the checks
 * in order.
 *
 * `previous` is the active root's artifact — the keeper keeps it cached. When it
 * is absent the checks that depend on it pass, which is the right behaviour on
 * the very first round.
 */
export async function preflight(
  distributor: Address,
  vault: Address,
  built: BuiltCumulative,
  previous: CumulativeArtifact | null,
): Promise<PreflightResult> {
  const entries = built.entries.map((e) => ({
    holder: e.holder as string,
    stock: e.stock as string,
    cumulative: e.cumulative,
  }));

  // What the Distributor ACTUALLY received, per stock. Read on-chain, not
  // derived from our own computation — otherwise the check would validate its
  // own error.
  const stocks = [...new Set(entries.map((e) => e.stock.toLowerCase()))];
  const funded = new Map<string, bigint>();
  await Promise.all(
    stocks.map(async (s) => {
      const v = await client.readContract({
        address: distributor,
        abi: distributorAbi,
        functionName: "totalFunded",
        args: [s as Address],
      });
      funded.set(s, v);
    }),
  );

  const checks = [
    { name: "conservation", ...checkConservation(entries, funded) },
    { name: "monotonicity", ...checkMonotonic(previous, entries) },
    { name: "population", ...checkPopulation(previous, entries.length) },
    { name: "provenance", ...checkProvenance(entries, built.artifact.windows) },
  ];

  // Last: it is by far the slowest, no point paying for it if a consistency
  // check has already settled the matter.
  if (checks.every((c) => c.ok)) {
    checks.push({
      name: "cross-check",
      ...crossCheck(distributor, vault, built.artifact.upToEpoch, {
        claimRoot: built.claimRoot,
        pushRoot: built.pushRoot,
        cid: built.cid,
      }),
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/** True if a second RPC is configured: the cross-check is then possible. */
export const hasFallbackRpc = RPC_FALLBACK.length > 0;
export const fallbackRpcUrl = RPC_FALLBACK;

/**
 * Check 5 — CROSS-CHECK. Rebuild the root from a DIFFERENT node, with an empty
 * cache, and require that it be identical.
 *
 * This is the only check that catches a DATA error rather than a consistency
 * one. The other four verify that the result holds together; this one verifies
 * that we started from the right state.
 *
 * Two conditions, and both are indispensable:
 *
 *   - **a different RPC.** A node truncating a page of logs is the most likely
 *     and most silent failure: the missing holders have their weight
 *     redistributed to the others, so nothing looks wrong in the totals.
 *   - **an empty cache.** Without it the second pass would re-read the files
 *     written by the first: it would agree with itself by construction and
 *     verify nothing at all.
 *
 * Run as a SUBPROCESS: fresh module state, no shared variable. The result is
 * therefore comparable to what a third party would get.
 *
 * **What it costs**: the second pass replays every epoch without a cache. It is
 * by far the slowest check, and that is the price of a verification that really
 * verifies something.
 */
export function crossCheck(
  distributor: Address,
  vault: Address,
  upToEpoch: number,
  expected: { claimRoot: string; pushRoot: string; cid: string },
): { ok: boolean; detail: string; skipped?: boolean } {
  if (!hasFallbackRpc) {
    // **Fails open, and says so loudly (T-OFF-03).** Failing open is
    // deliberate: this check used to fail closed and bricked publishing when
    // its own loader was broken, which is the comment below. But an operator
    // who LOSES their second endpoint lost the only check that catches a data
    // error rather than a consistency one, and saw an "ok" line for it. The
    // `skipped` flag is what the keeper turns into a warning per round.
    return { ok: true, skipped: true, detail: "NOT RUN: no RPC_URL_FALLBACK configured, the data check is skipped" };
  }
  const dir = mkdtempSync(join(tmpdir(), "keeper-xcheck-"));
  try {
    // Loaded through tsx, NOT `--experimental-strip-types`. Stripping only
    // removes annotations from the entry file; it does not map the `./x.js`
    // specifiers this codebase uses onto their `.ts` sources, so the child died
    // on ERR_MODULE_NOT_FOUND every single time. Since the check fails CLOSED,
    // that turned "set RPC_URL_FALLBACK" — which .env.example recommends —
    // into "never publish another root again".
    //
    // `cwd` is pinned to this package so `tsx` resolves wherever the keeper
    // was launched from.
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./recompute.ts", import.meta.url)),
        distributor, vault, String(upToEpoch)],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        // EMPTY cache and a DIFFERENT node: without both, the check is decorative.
        env: { ...process.env, RPC_URL: RPC_FALLBACK, EPOCH_DIR: dir },
        encoding: "utf8",
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const got = JSON.parse(out) as { claimRoot: string; pushRoot: string; cid: string; entries: number };
    const diff: string[] = [];
    if (got.claimRoot !== expected.claimRoot) diff.push("claimRoot");
    if (got.pushRoot !== expected.pushRoot) diff.push("pushRoot");
    if (got.cid !== expected.cid) diff.push("cid");
    if (diff.length) {
      return { ok: false, detail: `divergence on ${diff.join(", ")} — the two nodes do not see the same state` };
    }
    return { ok: true, detail: `${got.entries} entries, identical from the second node` };
  } catch (e) {
    // A cross-check that FAILS is not a cross-check that PASSES. We block:
    // better to delay publication than to publish blind.
    //
    // The child's stderr is what says WHY. Reporting only the parent's
    // "Command failed" left a check that blocks every publication while
    // explaining nothing — the reason its own loader bug went unnoticed.
    const err = e as Error & { stderr?: string | Buffer };
    const why = String(err.stderr ?? "").trim().split("\n").filter(Boolean).slice(-6).join(" | ");
    return { ok: false, detail: `cross-check impossible: ${why || err.message.slice(0, 200)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
