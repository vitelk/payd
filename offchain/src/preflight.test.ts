/** Preflight checks. `pnpm --filter offchain test` */
import assert from "node:assert/strict";
import { checkConservation, checkMonotonic, checkPopulation, checkProvenance } from "./preflight.js";
import type { CumulativeArtifact } from "./epoch.js";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const NVDA = "0x00000000000000000000000000000000000000cc";
const SPY = "0x00000000000000000000000000000000000000dd";

const prev = (entries: [string, string, string][]): CumulativeArtifact => ({
  upToEpoch: 5,
  windows: [],
  excluded: [],
  entries: entries.map(([holder, stock, cumulative]) => ({
    holder: holder as `0x${string}`,
    stock: stock as `0x${string}`,
    cumulative,
    push: false,
  })),
});

// 1. CONSERVATION — promising more than was received must block.
//
//    The contract protects itself too, but by TRUNCATING silently at
//    settlement: the last to claim receive less, with nothing to flag it.
//    Better to refuse to publish.
{
  const funded = new Map([[NVDA, 100n]]);
  assert.ok(checkConservation([{ stock: NVDA, cumulative: 60n }, { stock: NVDA, cumulative: 40n }], funded).ok,
    "exactly the funded amount must pass");
  assert.ok(!checkConservation([{ stock: NVDA, cumulative: 60n }, { stock: NVDA, cumulative: 41n }], funded).ok,
    "one wei too many must block");
  assert.ok(!checkConservation([{ stock: SPY, cumulative: 1n }], funded).ok,
    "a never-funded stock must block");
}

// 2. MONOTONICITY — a cumulative amount going backwards freezes the holder
//    FOREVER.
//
//    `claimedSoFar` would stay above the new cumulative amount, and they would
//    never receive anything again. This is exactly what an RPC returning
//    incomplete logs produces.
{
  const before = prev([[A, NVDA, "100"], [B, NVDA, "50"]]);
  assert.ok(checkMonotonic(before, [
    { holder: A, stock: NVDA, cumulative: 120n },
    { holder: B, stock: NVDA, cumulative: 50n },
  ]).ok, "cumulative amounts that rise or hold must pass");

  assert.ok(!checkMonotonic(before, [
    { holder: A, stock: NVDA, cumulative: 99n },
    { holder: B, stock: NVDA, cumulative: 50n },
  ]).ok, "a cumulative amount going backwards must block");

  // The nasty case: the holder DISAPPEARS from the tree. Their cumulative
  // amount falls to zero with no line saying so.
  assert.ok(!checkMonotonic(before, [{ holder: A, stock: NVDA, cumulative: 120n }]).ok,
    "a vanished holder must block");

  assert.ok(checkMonotonic(null, []).ok, "with no history, nothing to compare");
}

// 3. POPULATION — the tree does not empty out all at once on its own.
//
//    A sharp drop does not come from the market: it comes from an incomplete log
//    replay. And the missing holders do not just lose their share — their weight
//    is REDISTRIBUTED to the others, so the totals stay consistent and the error
//    is invisible.
{
  const before = prev(Array.from({ length: 100 }, (_, i) => [A, NVDA, String(i)] as [string, string, string]));
  assert.ok(checkPopulation(before, 100).ok, "stable must pass");
  assert.ok(checkPopulation(before, 60).ok, "-40 % must pass");
  assert.ok(!checkPopulation(before, 40).ok, "-60 % must block");
  // T-OFF-02 — the BOUNDARY, where `<` and `<=` differ and neither side of it
  // was covered. `floor` is `before * (10_000 - maxDropBps) / 10_000` = 50 here,
  // and the guard is `currentCount < floor`: exactly the floor passes, one under
  // it blocks. Asserting both is what stops a future edit from silently turning
  // "half the holders vanished" into an accepted round.
  assert.ok(checkPopulation(before, 50).ok, "exactly at the floor must pass: the guard is <, not <=");
  assert.ok(!checkPopulation(before, 49).ok, "one under the floor must block");
  // The same boundary at another threshold, so the property is about the
  // comparison and not about the number 50.
  assert.ok(checkPopulation(before, 90, 1_000).ok, "-10 % at a -10 % threshold passes");
  assert.ok(!checkPopulation(before, 89, 1_000).ok, "one under it does not");
  assert.ok(!checkPopulation(before, 0).ok, "an empty tree must block");
  assert.ok(!checkPopulation(null, 0).ok, "an empty first root must block");
}

// 4. PROVENANCE — a stock in the tree with no purchase behind it means the tree
//    was built on a state that is not the chain's.
{
  assert.ok(checkProvenance([{ stock: NVDA }], [{ stocks: [NVDA] }]).ok, "a funded stock must pass");
  assert.ok(!checkProvenance([{ stock: SPY }], [{ stocks: [NVDA] }]).ok, "an unfunded stock must block");
  assert.ok(checkProvenance([], [{ stocks: [NVDA] }]).ok, "empty tree, nothing to complain about here");
  // A window carries the WHOLE basket, so one purchase funds several stocks.
  assert.ok(
    checkProvenance([{ stock: SPY }, { stock: NVDA }], [{ stocks: [NVDA, SPY] }]).ok,
    "both legs of one purchase must count as funded",
  );
}


// 5. CROSS-CHECK — the check that verifies the DATA, not the consistency.
//
//    The previous four verify that the result holds together. This one verifies
//    we started from the right state, by redoing everything from a DIFFERENT
//    node with an EMPTY cache. Without both conditions it would be decorative:
//    re-reading the first pass's cache amounts to agreeing with yourself.
{
  // With no second RPC configured, the check skips cleanly rather than failing
  // — otherwise a keeper without a fallback would never publish anything.
  const savedFallback = process.env.RPC_URL_FALLBACK;
  delete process.env.RPC_URL_FALLBACK;
  const fresh = await import(`./preflight.js?nofallback=${Date.now()}`);
  const r = fresh.crossCheck(
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    0,
    { claimRoot: "0xaa", pushRoot: "0xbb", cid: "0xcc" },
  );
  assert.ok(r.ok, "with no fallback RPC, the check must skip");
  assert.match(r.detail, /skipped/, "and say so explicitly");
  // T-OFF-03 — it fails OPEN, and an `ok` with no other mark reads as coverage
  // that is not there. `skipped` is the flag `keeper.ts` turns into a WARNING
  // per round: this is the only check of the five that catches a DATA error, and
  // an operator who loses their second endpoint has to be told, not left with a
  // green line.
  assert.equal(r.skipped, true, "a check that did not RUN must be marked as such, not merely as ok");
  assert.match(r.detail, /NOT RUN/, "and the detail must say NOT RUN in words an operator will notice");
  if (savedFallback !== undefined) process.env.RPC_URL_FALLBACK = savedFallback;
}

console.log("preflight: 5 checks OK");
