/**
 * **Two sends in one pass must not claim one nonce.**
 *
 * `beatAll` loops over every watched vault and sends a `heartbeat` to each.
 * Both sends came from a wallet client built inside the function, so viem
 * started from an empty nonce cache each time and fell back to the node's
 * `pending` count — which on this chain does not yet show a transaction sent
 * milliseconds earlier. The SECOND vault of the loop failed with
 * `nonce too low: tx 774 state 775`, always the same vault, roughly two beats
 * in five, measured on the live co-signer 2026-09-20.
 *
 * It had lapsed nothing — `CO_SIGNER_GRACE` is three hours against fifteen-minute
 * beats — but that margin is the only thing keeping a two-key publication
 * two-key, and `rejectCoSignature` leaves by the same door, where a send that
 * does not land is a refusal that does not land.
 *
 * The stub freezes `eth_getTransactionCount`, which is exactly the condition
 * the bug needs: a node whose answer does not move between two sends. A run
 * against the old code sends nonce 774 twice.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseTransaction, type Hex } from "viem";

let checks = 0;
const failed: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) failed.push(msg);
}

const DIST_A = "0xaaaa000000000000000000000000000000000001";
const DIST_B = "0xaaaa000000000000000000000000000000000002";

/** What the node reports, and whether it is willing to take a transaction. */
const node = { count: 774, rejectNext: false };
/** The nonce of every raw transaction that reached the stub, in order. */
const sent: number[] = [];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = JSON.parse(body);
    const one = (r: { id: number; method: string; params?: unknown[] }) => {
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      switch (r.method) {
        case "eth_chainId": return reply("0x1237"); // 4663
        case "eth_blockNumber": return reply("0x1000");
        case "eth_getBalance": return reply("0xde0b6b3a7640000"); // 1 ETH, enough for the gas check
        // **Frozen on purpose.** A node that already knew about the transaction
        // sent a moment ago would hide the bug this file is about.
        case "eth_getTransactionCount": return reply(`0x${node.count.toString(16)}`);
        case "eth_getBlockByNumber":
          return reply({ number: "0x1000", timestamp: "0x1000", baseFeePerGas: "0x1", hash: `0x${"11".repeat(32)}`, transactions: [] });
        case "eth_maxPriorityFeePerGas": return reply("0x1");
        case "eth_gasPrice": return reply("0x2");
        case "eth_sendRawTransaction": {
          const tx = parseTransaction(r.params![0] as Hex);
          if (node.rejectNext) {
            node.rejectNext = false;
            return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "intrinsic gas too low" } };
          }
          sent.push(Number(tx.nonce));
          return reply(`0x${"ab".repeat(32)}`);
        }
        default: return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: `unstubbed ${r.method}` } };
      }
    };
    const out = Array.isArray(q) ? q.map(one) : one(q);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
process.env.RPC_URL = `http://127.0.0.1:${port}`;
process.env.REGISTRY = "0x00000000000000000000000000000000000000e1";

// Imported only now: `config.ts` reads `RPC_URL` at module load, so a static
// import would bind the client to whatever the environment held before this.
const { heartbeat } = await import("./cosign.js");

const KEY = ("0x" + "11".repeat(32)) as Hex;

// **The property.** One pass, two vaults, one key, a node that has not caught up.
await heartbeat(DIST_A as `0x${string}`, KEY);
await heartbeat(DIST_B as `0x${string}`, KEY);
ok(sent.length === 2, "both heartbeats of the pass reached the node");
ok(sent[0] === 774, "the first takes the nonce the chain reports");
ok(sent[1] === 775, "and the second takes the next one, not the same one again");

// **A send that throws must not leave a gap.** `consume()` records the nonce
// before the transaction goes out, so a failed send burns one. Without the
// reset the manager hands out 777 next, the chain never reaches it, and every
// later transaction queues behind the hole — for the life of the process.
node.rejectNext = true;
await assert.rejects(() => heartbeat(DIST_A as `0x${string}`, KEY), "the failing send is not swallowed");
await heartbeat(DIST_B as `0x${string}`, KEY);
ok(sent.length === 3, "the pass after a failure still sends");
ok(sent[2] === 774, "...and goes back to what the chain reports, rather than skipping past the burnt nonce");

server.closeAllConnections();
server.close();
if (failed.length) {
  for (const f of failed) console.error(`cosign.nonce: RED - ${f}`);
  throw new assert.AssertionError({ message: `${failed.length} of ${checks} assertions RED` });
}
console.log(`cosign.nonce: ${checks} checks OK`);
