/**
 * checkpoint.test.ts — the opening-balance checkpoint must be invisible.
 *
 * A snapshot seeded from a checkpoint and one replayed from the launch block
 * have to produce the SAME balances. If they ever stop doing so, the keeper and
 * its counter-computation disagree on every publication — which is the good
 * failure. The bad one is a checkpoint that is wrong in a way both halves
 * share, so the two properties tested here are the ones that would make it so:
 * a checkpoint used outside the range it stands for, and a page from the shared
 * store applied to a token that had already folded it in.
 */
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EPOCH_DIR = mkdtempSync(join(tmpdir(), "payd-checkpoint-"));
process.env.RPC_URL ??= "http://127.0.0.1:1";

const { foldTransfers, loadCheckpoint, saveCheckpoint } = await import("./snapshot.js");
type Addr = `0x${string}`;

const A = "0x1111111111111111111111111111111111111111" as Addr;
const B = "0x2222222222222222222222222222222222222222" as Addr;
const ZERO = "0x0000000000000000000000000000000000000000" as Addr;
const TOKEN = "0x9999999999999999999999999999999999999999" as Addr;

const pad = (a: Addr) => ("0x" + a.slice(2).padStart(64, "0")) as Addr;
const transfer = (block: number, from: Addr, to: Addr, value: bigint) => ({
  address: TOKEN,
  blockNumber: ("0x" + block.toString(16)) as Addr,
  topics: ["0xddf2" as Addr, pad(from), pad(to)],
  data: ("0x" + value.toString(16).padStart(64, "0")) as Addr,
});

// A short history: mint 100 to A, A sends 30 to B, then A sends 10 to B inside
// the period. The period is [blocks 10, 20], so only the last one is in it.
const history = [
  transfer(1, ZERO, A, 100n),
  transfer(5, A, B, 30n),
  transfer(12, A, B, 10n),
];

const fold = (logs: typeof history, scanFrom: number, seed: [Addr, bigint][] = []) => {
  const f = {
    bal: new Map<Addr, bigint>(seed),
    inPeriod: [] as { block: number; from: Addr; to: Addr; value: bigint }[],
    scanFrom,
    firstBlock: 10,
    lastBlock: 20,
  };
  foldTransfers(logs as never, f as never);
  return f;
};

// --- cold: replay everything from the launch block.
const cold = fold(history, 0);
assert.deepStrictEqual([...cold.bal].sort(), [[A, 70n], [B, 30n]].sort(), "cold opening balances");
assert.strictEqual(cold.inPeriod.length, 1, "one transfer inside the period");

// --- warm: the same period, seeded from a checkpoint standing at block 9.
// The checkpoint is exactly what the cold run would have written.
const warm = fold(history, 10, [[A, 70n], [B, 30n]]);
assert.deepStrictEqual(
  [...warm.bal].sort(),
  [...cold.bal].sort(),
  "a checkpointed run must reach the same opening balances as a cold one",
);
assert.deepStrictEqual(warm.inPeriod, cold.inPeriod, "and the same transfers inside the period");

// --- the shared store hands over pages older than THIS token's checkpoint.
// Applying them would count the pre-checkpoint history twice.
const shared = fold(history, 10, [[A, 70n], [B, 30n]]);
assert.deepStrictEqual([...shared.bal].sort(), [[A, 70n], [B, 30n]].sort(), "pre-checkpoint pages ignored");

// --- and pages beyond the period's last block, which belong to the next window.
const late = fold([...history, transfer(999, A, B, 70n)], 0);
assert.deepStrictEqual([...late.bal].sort(), [...cold.bal].sort(), "post-period pages ignored");
assert.strictEqual(late.inPeriod.length, 1, "a block past lastBlock is not in the period");

// --- checkpoint files: never used at or past the period, never moved backward.
saveCheckpoint(TOKEN, 9, new Map([[A, 70n], [B, 30n]]));
assert.strictEqual(loadCheckpoint(TOKEN, 10)?.block, 9, "a checkpoint behind the period is usable");
assert.strictEqual(loadCheckpoint(TOKEN, 9), null, "a checkpoint AT the period start is not");
assert.strictEqual(loadCheckpoint(TOKEN, 5), null, "nor one past it");

// Recomputing an older window must not drag the checkpoint back with it.
saveCheckpoint(TOKEN, 3, new Map([[A, 100n]]));
const kept = loadCheckpoint(TOKEN, 10)!;
assert.strictEqual(kept.block, 9, "a checkpoint never moves backward");
assert.strictEqual(kept.balances.get(B), 30n, "and keeps the balances it stood for");

// Zero balances are dropped rather than carried for ever.
saveCheckpoint(TOKEN, 20, new Map([[A, 60n], [B, 0n]]));
const pruned = loadCheckpoint(TOKEN, 21)!;
assert.strictEqual(pruned.balances.has(B), false, "a zero balance is not written");

console.log("checkpoint.test.ts ok");
