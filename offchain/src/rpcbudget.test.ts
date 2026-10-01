/**
 * **What one round asks the node for, and what it stops asking.**
 *
 * The RPC bill of this repository is two long-running processes calling a paid
 * endpoint every minute, and almost all of it was spent re-reading state that
 * cannot change: `FeeVault.init` writes `DISTRIBUTOR`, `QUOTE` and
 * `MIN_BUY_QUOTE` exactly once (`test_InitHappensOnceAndOnlyOnce`), the factory
 * stamps `modeOf` at birth, and `bind` sets `token` once. The keeper asked all
 * five of them, per vault, 1 440 times a day.
 *
 * Two properties are asserted here, and both are cheap to lose again — a cache
 * is one `delete` away from being a leak, and a batched client is one stray
 * `chain` literal away from not being batched at all.
 *
 *   1. a described vault is described ONCE, and a vault that is not yet bound
 *      is re-described until it is — the one field that legitimately moves;
 *   2. `policeRequests` handed a scan somebody else already did makes no
 *      `eth_getLogs` and no `eth_blockNumber` of its own, and reads only the
 *      requests of the Distributor it was asked about.
 *
 * Nothing external is simulated: the stub is an HTTP JSON-RPC endpoint, i.e.
 * OUR transport. It speaks Multicall3 because the client does, which is also how
 * this file proves the batching is live rather than configured.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  decodeFunctionData,
  encodeFunctionResult,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { distributorAbi, feeVaultAbi, registryAbi } from "./abis.js";
import { answerEthCall } from "./rpcstub.js";

let checks = 0;
const failed: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) failed.push(msg);
}
function fixture(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

const REGISTRY = "0x00000000000000000000000000000000000000e1" as Address;
const VAULT_A = "0x00000000000000000000000000000000000000a1" as Address;
const VAULT_B = "0x00000000000000000000000000000000000000b1" as Address;
const DIST_A = "0x00000000000000000000000000000000000000d1" as Address;
const DIST_B = "0x00000000000000000000000000000000000000d2" as Address;
const TOKEN_A = "0x00000000000000000000000000000000000000c1" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MODE_DISTRIBUTION = ("0x" + Buffer.from("distribution").toString("hex").padEnd(64, "0")) as Hex;
const KEY = ("0x" + "11".repeat(32)) as Hex;
const REJECTED = 2n ** 256n - 1n;

/** `token()` on vault B, flipped by the test the way `bind` flips it: once. */
let tokenB: Address = ZERO;

/** Every contract read the node was asked to perform, in order. */
const reads: Array<{ to: string; fn: string }> = [];
/** Requests by JSON-RPC method, i.e. what the endpoint actually bills for. */
const methods = new Map<string, number>();

function answer(to: string, data: Hex): Hex {
  const at = to.toLowerCase();
  const abi = (at === REGISTRY.toLowerCase() ? registryAbi
    : at === DIST_A.toLowerCase() || at === DIST_B.toLowerCase() ? distributorAbi
      : feeVaultAbi) as Abi;
  const { functionName, args } = decodeFunctionData({ abi, data });
  reads.push({ to: at, fn: functionName });

  const result = (() => {
    switch (functionName) {
      case "vaults": return [VAULT_A, VAULT_B];
      case "modeOf": return MODE_DISTRIBUTION;
      case "DISTRIBUTOR": return at === VAULT_A.toLowerCase() ? DIST_A : DIST_B;
      case "token": return at === VAULT_A.toLowerCase() ? TOKEN_A : tokenB;
      case "QUOTE": return ZERO;
      case "MIN_BUY_QUOTE": return 10_000_000_000_000_000n;
      // The sentinel the contract writes on a refusal: `policeRequests` skips
      // such a request, which keeps this test off the `buildRoot` path.
      case "coSignatureRequestedAt": return REJECTED;
      default: throw new Error(`unstubbed ${functionName}(${String(args)})`);
    }
  })();
  return encodeFunctionResult({ abi, functionName, result } as never);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = JSON.parse(body);
    const one = (r: { id: number; method: string; params?: unknown[] }) => {
      methods.set(r.method, (methods.get(r.method) ?? 0) + 1);
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      if (r.method === "eth_chainId") return reply("0x1237");
      if (r.method === "eth_blockNumber") return reply("0x1000");
      if (r.method === "eth_call") {
        const p = (r.params?.[0] ?? {}) as { to?: string; data?: Hex };
        try {
          return reply(answerEthCall(p.to!, p.data!, answer));
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } };
        }
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unstubbed ${r.method}` } };
    };
    const out = Array.isArray(q) ? q.map(one) : one(q);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// Set BEFORE the imports below: `config.ts` reads the environment once, at
// import, and `keeper.ts` requires its key at module scope.
process.env.RPC_URL = `http://127.0.0.1:${port}`;
process.env.REGISTRY = REGISTRY;
process.env.KEEPER_PRIVATE_KEY = KEY;

const { registry } = await import("./keeper.js");
const { policeRequests, policeAll } = await import("./cosign.js");

// ---------------------------------------------------------------------------
// 1. A vault is described once — except the one field that can still move.

const perVault = () => reads.filter((r) => r.fn !== "vaults");
const roundReads = async () => {
  reads.length = 0;
  methods.clear();
  const out = await registry();
  return { vaults: out, reads: [...perVault()], calls: methods.get("eth_call") ?? 0 };
};

const first = await roundReads();
fixture(first.vaults.length === 2, "fixture: both vaults are described");
fixture(first.reads.length === 10, `fixture: a cold round reads 5 fields per vault (got ${first.reads.length})`);
// Batching is live, not merely configured: `vaults()` then the ten fields of two
// vaults is TWO calls, where an unbatched client would send eleven.
ok(first.calls <= 2, `a cold round must batch its reads into at most 2 eth_call (got ${first.calls})`);

const second = await roundReads();
ok(
  second.reads.every((r) => r.to === VAULT_B.toLowerCase() || r.fn === "modeOf"),
  `a bound vault must not be described twice (re-read: ${JSON.stringify(second.reads)})`,
);
ok(
  second.reads.length === 5,
  `an unbound vault must be re-described until it is bound (got ${second.reads.length} read(s))`,
);

// `bind`, once, exactly as the contract does it.
tokenB = "0x00000000000000000000000000000000000000c2" as Address;
const third = await roundReads();
ok(third.reads.length === 5, `the binding round re-reads the vault once (got ${third.reads.length})`);
ok(
  third.vaults[1]!.token === tokenB,
  "the newly bound token must be picked up, not served from the cache",
);

const fourth = await roundReads();
ok(fourth.reads.length === 0, `a fully bound registry costs no per-vault read (got ${fourth.reads.length})`);
ok(fourth.calls <= 1, `...and one eth_call for the registry itself (got ${fourth.calls})`);

// ---------------------------------------------------------------------------
// 2. A shared scan is not re-read, and it is read by address.

const shared = {
  head: 0x1000n,
  logs: [
    { address: DIST_A, blockNumber: 0x100n, args: { rootKey: ("0x" + "aa".repeat(32)) as Hex, upToEpoch: 7n } },
    { address: DIST_B, blockNumber: 0x101n, args: { rootKey: ("0x" + "bb".repeat(32)) as Hex, upToEpoch: 8n } },
  ],
};

reads.length = 0;
methods.clear();
const next = await policeRequests(DIST_A, VAULT_A, KEY, 0n, shared);

ok(next === shared.head + 1n, `a fully policed range advances the cursor to head + 1 (got ${next})`);
ok(
  (methods.get("eth_getLogs") ?? 0) === 0,
  "a shared scan must not be walked again per vault — that was 2N requests every two minutes",
);
ok((methods.get("eth_blockNumber") ?? 0) === 0, "the head is read once for the whole group, not once per vault");
// The filter is the whole safety of the merge: one Distributor must never be
// policed against another's requests, and `eth_getLogs` over a list of
// addresses demultiplexes nothing by itself.
const policed = reads.filter((r) => r.fn === "coSignatureRequestedAt");
ok(policed.length === 1, `only this Distributor's requests are settled (got ${policed.length})`);
ok(policed[0]?.to === DIST_A.toLowerCase(), `...and they are its own (got ${policed[0]?.to})`);

// ---------------------------------------------------------------------------
// 3. One policing round at a time.
//
// The timer fires every two minutes whether or not the previous round came
// back, and a cold cache makes a round take six. Three overlapped in production
// on 2026-09-16; they converged, but each holds a full cumulative table on a
// 256 MB machine. The skipped round loses nothing: the cursors have not moved,
// so the next round reads exactly the range it would have read.

const cursors = new Map<Address, bigint>();
const watching = [{ vault: VAULT_A, distributor: DIST_A }];

// The guard is checked BEFORE the first `await`, so the second call is already
// inside an unfinished round: it must come back without having read anything.
const inFlight = policeAll(watching, KEY, cursors, 0n);
reads.length = 0;
methods.clear();
await policeAll(watching, KEY, cursors, 0n);
ok(
  (methods.get("eth_blockNumber") ?? 0) === 0 && (methods.get("eth_getLogs") ?? 0) === 0,
  "a round overlapping another must read nothing — not even the head",
);
await inFlight;

// And the guard releases: the round after it runs normally. Asserted on
// `eth_getLogs` and not on the head — viem caches `getBlockNumber` for its
// polling interval, so counting that would be measuring viem's cache.
methods.clear();
await policeAll(watching, KEY, cursors, 0n);
ok(
  (methods.get("eth_getLogs") ?? 0) >= 1,
  "...and the next round is not blocked by the one that finished",
);

server.closeAllConnections();
server.close();
if (failed.length) {
  for (const f of failed) console.error(`rpcbudget: RED - ${f}`);
  throw new assert.AssertionError({
    message: `${failed.length} of ${checks} assertions RED`,
    actual: failed.length,
    expected: 0,
  });
}
console.log(`rpcbudget: ${checks} checks OK`);
