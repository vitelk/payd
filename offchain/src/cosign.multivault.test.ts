/**
 * **The co-signer covers every vault the registry names it on, not the one an
 * environment variable remembered.** Regression guard for the gap found on
 * launch night, 2026-09-12.
 *
 * `Payd._create` stamps the registry's co-signer into each new Distributor at
 * birth (`contracts/Payd.sol`, `distributor.call(setCoSigner(coSigner))`), so a
 * third-party launch names this key without anybody touching this process.
 * `cosign.ts` read a single `DISTRIBUTOR` from the environment, which made the
 * failure precise and quiet: `setCoSigner` primes `coSignerHeartbeat`, so such a
 * vault DOES require the second signature — for `CO_SIGNER_GRACE`, three hours,
 * and then `coSignerRequired()` goes false and that launch is single-key for
 * good. No revert, no alert. The keeper had already been moved to `vaults()`
 * for the same reason.
 *
 * Nothing external is simulated: the stub is an HTTP JSON-RPC endpoint, i.e.
 * OUR transport. It answers three `eth_call`s — `vaults()`, `DISTRIBUTOR()` and
 * `coSigner()` — which is the whole of what `watched()` asks a node for.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

let checks = 0;
const failed: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) failed.push(msg);
}

const ME = "0xbdacfd9c51bec20eeb490bf3c99682929b57dd6c";
const OTHER = "0x000000000000000000000000000000000000dead";

/** vault -> [its distributor, the co-signer that distributor names] */
const WORLD: Record<string, [string, string]> = {
  "0x4dba57f2e1b9afe02ca091916f98dd7b4a248a64": ["0xe765f074650b83d95e09a22f0b87a992792705fb", ME],
  "0x1111111111111111111111111111111111111111": ["0xaaaa000000000000000000000000000000000001", ME],
  // A launch whose Distributor was rotated to somebody else. Heartbeating it
  // would revert on `msg.sender != coSigner`, so it must be skipped, not tried.
  "0x2222222222222222222222222222222222222222": ["0xaaaa000000000000000000000000000000000002", OTHER],
};
const VAULTS = Object.keys(WORLD);

const sel = (s: string) => s.slice(0, 10);
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addrFromWord = (w: string) => "0x" + w.slice(24);

/** ABI-encodes `address[]`. */
function encodeAddressArray(list: string[]): string {
  const head = word("20") + word(list.length.toString(16));
  return "0x" + head + list.map((a) => word(a)).join("");
}

const SEL_VAULTS = "0x8220ef5b"; // vaults()
const SEL_DISTRIBUTOR = "0x9c26149f"; // DISTRIBUTOR()
const SEL_COSIGNER = "0x312c66cd"; // coSigner()

let selectorsSeen = new Set<string>();

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = JSON.parse(body);
    const one = (r: { id: number; method: string; params?: unknown[] }) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
      if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: "0x1000" };
      if (r.method === "eth_call") {
        const p = (r.params?.[0] ?? {}) as { to?: string; data?: string };
        const to = (p.to ?? "").toLowerCase();
        const s = sel(p.data ?? "");
        selectorsSeen.add(s);
        if (s === SEL_VAULTS) return { jsonrpc: "2.0", id: r.id, result: encodeAddressArray(VAULTS) };
        if (s === SEL_DISTRIBUTOR) {
          const e = WORLD[to];
          if (!e) return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
          return { jsonrpc: "2.0", id: r.id, result: "0x" + word(e[0]) };
        }
        if (s === SEL_COSIGNER) {
          const e = Object.values(WORLD).find((v) => v[0].toLowerCase() === to);
          if (!e) return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted" } };
          return { jsonrpc: "2.0", id: r.id, result: "0x" + word(e[1]) };
        }
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
    };
    const out = Array.isArray(q) ? q.map(one) : one(q);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
process.env.RPC_URL = `http://127.0.0.1:${port}`;

// Imported AFTER RPC_URL is set: config.js reads it at module load.
const { watched } = await import("./cosign.js");

const REGISTRY = "0x54c90f5dbbe310f71bc3b10dd87eff284ac63b03" as `0x${string}`;
const got = await watched(REGISTRY, ME as `0x${string}`);

ok(got.length === 2, `two vaults name this key, got ${got.length}`);

const covered = got.map((w) => w.vault.toLowerCase()).sort();
ok(
  covered.join() === [VAULTS[0], VAULTS[1]].sort().join(),
  `the two vaults naming this key are the ones returned, got ${covered.join()}`,
);

ok(
  !got.some((w) => w.vault.toLowerCase() === VAULTS[2]),
  "a vault whose Distributor names ANOTHER co-signer is skipped, not attempted",
);

ok(
  got.every((w) => w.distributor.toLowerCase() === WORLD[w.vault.toLowerCase()]?.[0]),
  "each vault is paired with its own Distributor, read off the vault",
);

ok(selectorsSeen.has(SEL_VAULTS), "the registry's vaults() is what enumerates them");

// The property that made the old shape wrong: coverage must not depend on
// DISTRIBUTOR/FEE_VAULT being set. Nothing above read them.
ok(
  process.env.DISTRIBUTOR === undefined && process.env.FEE_VAULT === undefined,
  "coverage was derived with no DISTRIBUTOR/FEE_VAULT in the environment",
);

// An unreadable vault blinds the process to itself and to nothing else.
WORLD["0x3333333333333333333333333333333333333333"] = ["0x0", ME];
VAULTS.push("0x3333333333333333333333333333333333333333");
const withBroken = await watched(REGISTRY, ME as `0x${string}`);
ok(
  withBroken.length === 2,
  `a vault that cannot be read is dropped, the others survive, got ${withBroken.length}`,
);

server.close();

if (failed.length) {
  for (const f of failed) console.error("  FAIL:", f);
  assert.fail(`cosign.multivault: ${failed.length} of ${checks} checks failed`);
}
console.log(`cosign.multivault: ${checks} checks OK`);
