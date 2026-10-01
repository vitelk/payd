/**
 * **T2-OFF-01 / T2-OFF-02 — the two cursors, and what they do with a block
 * range they failed to read. FIXED 2026-09-12; this is the regression guard.**
 *
 * `docs/AUDIT_PLAN_2.md` §5 says to treat `cosign.ts` and `watch.ts` as
 * production code that happens to be TypeScript. With a co-signer named, no
 * root is published without one, and `policeRequests` is the half that refuses
 * a root nobody asked this node about — a compromised keeper does not ask over
 * HTTP, it posts on-chain and waits out `CO_SIGNER_GRACE`.
 *
 * The property asserted here is the one a watcher owes: **a cursor advances
 * over what it READ, never over what it failed to read.** Both functions catch
 * the `eth_getLogs` rejection into an empty array and then move the cursor to
 * `head + 1` regardless, so one failed query blinds them to that range for ever
 * — on a chain whose own `CLAUDE.md` records 429s as routine.
 *
 * Nothing external is simulated: the stub below is an HTTP JSON-RPC endpoint,
 * i.e. OUR transport, not Pons, Uniswap or a stock token. It answers
 * `eth_blockNumber` and fails `eth_getLogs`, which is exactly what a rate-limited
 * node does.
 *
 * Both properties now hold, and both are cheap to lose again: the fix is the
 * absence of a `.catch(() => [])`, which is exactly the kind of line somebody
 * adds back to quieten a noisy log.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

let checks = 0;
/** Every red assertion is collected, so one failure does not hide the others. */
const failed: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) failed.push(msg);
}
/** Fixture assertions still abort: a broken fixture proves nothing either way. */
function fixture(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

const HEAD = 0x1000n;
/** Every `eth_getLogs` this node is asked for. */
const asked: Array<{ from: string; to: string }> = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = JSON.parse(body);
    const one = (r: { id: number; method: string; params?: unknown[] }) => {
      if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: "0x" + HEAD.toString(16) };
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
      if (r.method === "eth_getLogs") {
        const p = (r.params?.[0] ?? {}) as { fromBlock?: string; toBlock?: string };
        asked.push({ from: p.fromBlock ?? "?", to: p.toBlock ?? "?" });
        // What a rate-limited node answers. HTTP 200, a JSON-RPC error: viem
        // does not retry this, it rejects — and `policeRequests` catches it.
        return { jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "query returned more than 10000 results" } };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unstubbed ${r.method}` } };
    };
    const out = Array.isArray(q) ? q.map(one) : one(q);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
process.env.RPC_URL = `http://127.0.0.1:${port}`;

// Imported AFTER `RPC_URL` is set: `config.ts` reads it once, at import.
const { policeRequests } = await import("./cosign.js");

const DIST = "0x00000000000000000000000000000000000000d1" as const;
const VAULT = "0x00000000000000000000000000000000000000v1".replace("v", "a") as `0x${string}`;
const KEY = ("0x" + "11".repeat(32)) as `0x${string}`;

const from = 0n;
const next = await policeRequests(DIST, VAULT, KEY, from);

console.log(`cursor.audit2: eth_getLogs asked for ${JSON.stringify(asked)}`);
console.log(`cursor.audit2: fromBlock ${from} -> returned cursor ${next}, head ${HEAD}`);

fixture(asked.length > 0, "fixture: the query was actually attempted");
// The property. A range that failed to load has not been policed, so the next
// round has to try it again; `CoSignatureRequested` is the one event that turns
// a three-hour clock into three hours of notice, and a request inside the lost
// range is never refused.
ok(
  next <= from,
  `a cursor must not advance over a block range that failed to load (got ${next}, from ${from})`,
);

// ---------------------------------------------------------------------------
// T2-OFF-02 — `watch.ts`, and the width of the window it looks back over.
//
// `watchGovernance` and the per-round `CoSignatureRequested` scan are module
// private, so they cannot be driven from here; what CAN be checked is the one
// number both depend on, and it is inline in the file. Measured at the pinned
// block 60 310 000 with `cast block`:
//
//     60 310 000.timestamp - 60 305 000.timestamp = 515 s over 5 000 blocks
//                                                 = 0.103 s per block
//
// so `head - 5_000n` is a window of **8 min 35 s**. Two consequences, and both
// are the "watcher with a gap" AUDIT_PLAN_2.md 4 names:
//
//   - the cold start (`watch.ts:161`) replays 8 min 35 s of history. `govCursor`
//     is module state, so every restart of the process re-enters this branch: a
//     watcher down for ten minutes has lost every `CallScheduled` in between,
//     and that event fires ONCE per operation, 48 h before it lands;
//   - the `CoSignatureRequested` scan (`watch.ts:226`) re-reads the same 8 min
//     35 s every round against a **three-hour** grace, so a root put on the
//     record is shouted about for 4.8 % of the time it has left and is silent
//     for the other 95.2 % — including the last hour before it publishes on one
//     key.
const SECONDS_PER_BLOCK = 515 / 5000;
const GRACE_SECONDS = 3 * 60 * 60;
const { LOOKBACK_BLOCKS } = await import("./watch.js");
const seconds = Math.round(Number(LOOKBACK_BLOCKS) * SECONDS_PER_BLOCK);
console.log(`cursor.audit2: watch.ts look-back = ${LOOKBACK_BLOCKS} blocks = ${seconds} s (grace ${GRACE_SECONDS} s)`);
ok(
  seconds >= GRACE_SECONDS,
  `a look-back window must cover at least CO_SIGNER_GRACE (${seconds} s < ${GRACE_SECONDS} s)`,
);
// And it must not be a round number that happens to pass: the width is derived
// from the grace, so a change to the grace has to move it.
const source = await (await import("node:fs/promises")).readFile(new URL("./watch.ts", import.meta.url), "utf8");
fixture(/LOOKBACK_BLOCKS\s*=\s*BigInt\(/.test(source), "the width is computed, not written out");
ok(!/fromBlock:\s*\w*\s*-?\s*5_000n/.test(source), "no literal 5 000-block window survives in watch.ts");

// viem's HTTP agent keeps a socket alive, so closing the listener is not enough
// to let the process exit — and a test that hangs is a test nobody runs.
server.closeAllConnections();
server.close();
if (failed.length) {
  for (const f of failed) console.error(`cursor.audit2: RED - ${f}`);
  throw new assert.AssertionError({
    message: `${failed.length} of ${checks} assertions RED`,
    actual: failed.length,
    expected: 0,
  });
}
console.log(`cursor.audit2: ${checks} checks OK`);
