/**
 * logs.test.ts — scanLogs must halve its span on EVERY way the node says
 * "that range was too wide", not just the one we met first.
 *
 * The timeout case is not hypothetical: it is what killed selfcheck against
 * a real token on 2026-09-04 (see logs.ts).
 */
import assert from "node:assert";
import { scanLogs } from "./logs.js";

let checks = 0;
const ok = (c: boolean, m: string) => {
  assert.ok(c, m);
  checks++;
};

/** A node that refuses any span wider than `limit` with `message`. */
function pickyNode(limit: number, message: string) {
  const spans: number[] = [];
  const client = {
    request: async ({ params }: never) => {
      const p = (params as unknown as [{ fromBlock: string; toBlock: string }])[0];
      const span = Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1;
      spans.push(span);
      if (span > limit) throw Object.assign(new Error("RPC failed"), { details: message });
      return [];
    },
  } as never;
  return { client, spans };
}

for (const message of [
  "logs matched by query exceeds limit of 10000",
  "log query timed out",
  "query timeout exceeded",
  "block range exceeds maximum allowed (max=10000, requested=50000)",
  // drpc, launch night: the status code IS the whole message.
  "Bad Request",
]) {
  const { client, spans } = pickyNode(6_250, message);
  const res = await scanLogs(client, { address: "0xabc", fromBlock: 0, toBlock: 49_999, topics: [] }, () => {});
  ok(spans.some((s) => s > 6_250), `${message}: the wide attempt happened`);
  ok(spans.every((s) => s <= 50_000), `${message}: never widened past maxSpan`);
  ok(res.requests > 0, `${message}: the scan completed instead of throwing`);
}

// Throttling is NOT a too-wide range: the span must survive it. Halving on a 429
// would shrink the pages for ever and never fix the thing that was wrong.
{
  let refusals = 3;
  const spans: number[] = [];
  const client = {
    request: async ({ params }: never) => {
      const p = (params as unknown as [{ fromBlock: string; toBlock: string }])[0];
      spans.push(Number(BigInt(p.toBlock) - BigInt(p.fromBlock)) + 1);
      if (refusals-- > 0) {
        // The exact shape blockmachine returns when it throttles (2026-09-07).
        throw Object.assign(new Error("RPC failed"), {
          details: "Cannot read properties of undefined (reading 'error')",
        });
      }
      return [];
    },
  } as never;
  const res = await scanLogs(
    client,
    { address: "0xabc", fromBlock: 0, toBlock: 9_999, topics: [] },
    () => {},
    { maxSpan: 10_000, backoffMs: 1 },
  );
  ok(res.requests === 1, "the scan completed once the node stopped refusing");
  ok(spans.length === 4, "it retried the throttled range rather than giving up");
  ok(spans.every((s) => s === 10_000), "a 429 must never shrink the span");
}

// ...but throttling that never ends is a dead node, not a slow one.
{
  const client = {
    request: async () => {
      throw Object.assign(new Error("RPC failed"), { details: "429 Too Many Requests" });
    },
  } as never;
  await assert.rejects(
    () => scanLogs(client, { address: "0xabc", fromBlock: 0, toBlock: 10, topics: [] }, () => {},
      { maxStalls: 2, backoffMs: 1 }),
    /429|RPC failed/,
    "the backoff is bounded — a node that is gone must surface, not hang",
  );
  checks++;
}

// A real error must still propagate — halving forever would hide it.
{
  const client = {
    request: async () => {
      throw Object.assign(new Error("RPC failed"), { details: "execution reverted" });
    },
  } as never;
  await assert.rejects(
    () => scanLogs(client, { address: "0xabc", fromBlock: 0, toBlock: 10, topics: [] }, () => {}),
    /execution reverted|RPC failed/,
    "an unrelated error is not swallowed as a too-wide range",
  );
  checks++;
}

console.log(`logs: ${checks} checks OK`);
