/**
 * custody.ts — the bisection lands on the exact block, and the pair check
 * catches the two ways §1.3 goes wrong.
 *
 * `docs/LAUNCH_2026_12_09.md` §1.2 and §1.3 were prose until 2026-09-12. What is
 * checked here is the only part of them that is logic rather than procedure:
 * the off-by-one in the bisection, and whether `verifyPair` actually refuses a
 * co-located pair instead of printing a reassuring line.
 *
 * The JSON-RPC stub is OUR transport, not Pons, Uniswap or a stock token.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

let checks = 0;
function ok(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

/** The block at which the address is first funded, in the stub's world. */
const FUNDED_AT = 41_337n;
const HEAD = 60_310_000n;
let balanceCalls = 0;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = JSON.parse(body);
    const one = (r: { id: number; method: string; params?: unknown[] }) => {
      if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
      if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: "0x" + HEAD.toString(16) };
      if (r.method === "eth_getBalance") {
        balanceCalls++;
        const at = BigInt((r.params?.[1] as string) ?? "0x0");
        return { jsonrpc: "2.0", id: r.id, result: at >= FUNDED_AT ? "0x1" : "0x0" };
      }
      return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unstubbed ${r.method}` } };
    };
    const out = Array.isArray(q) ? q.map(one) : one(q);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.RPC_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Imported AFTER RPC_URL is set: config.ts reads it once, at import.
const { firstFundedBlock, sameOrigin, attest, verifyPair, attestationPayload } = await import("./custody.js");
const { privateKeyToAccount } = await import("viem/accounts");

const A = "0x00000000000000000000000000000000000000aa" as const;

// 1. **The bisection lands on the exact block, not one either side.** This is
//    the whole reason the function is not written inline: an off-by-one names
//    the wrong funder, and the wrong funder is the answer §1.2 is asked for.
{
  const at = await firstFundedBlock(A, HEAD);
  ok(at === FUNDED_AT, `the first funded block is exact (got ${at}, want ${FUNDED_AT})`);
  // log2(60.31M) = 25.8, plus the two probes at the ends.
  ok(balanceCalls <= 30, `and it costs ~log2(head) calls, not a scan (${balanceCalls})`);
}

// 2. An address that never held anything is null, not block 0 — "funded at the
//    genesis block" would read as an answer.
{
  const before = balanceCalls;
  const at = await firstFundedBlock(A, FUNDED_AT - 1n);
  ok(at === null, "an address with nothing at the head reports null");
  ok(balanceCalls === before + 1, "and it says so in ONE call, without bisecting");
}

// 3. `sameOrigin` is the verdict §1.2 asks for, and it must not read two
//    unknowns as a match — that is the direction that passes a bad pair.
{
  const f = (funder: string | null) => ({ address: A, fundedAt: 1n, funder: funder as never });
  ok(sameOrigin(f("0xabc"), f("0xABC")), "the same funder is the same funder whatever the case");
  ok(!sameOrigin(f("0xabc"), f("0xdef")), "two funders are two funders");
  ok(!sameOrigin(f(null), f(null)), "two UNKNOWNS are not a match");
}

// 4. Every field of an attestation is in what gets signed. A field outside the
//    payload is a field an operator can change after signing.
{
  const base = {
    role: "keeper" as const, host: "h1", rpcHash: "0x01" as const,
    clientVersion: "v", chainId: 4663, at: "t",
  };
  const p = attestationPayload(base);
  for (const [k, v] of [["role", "cosigner"], ["host", "h2"], ["rpcHash", "0x02"], ["clientVersion", "w"], ["at", "u"]] as const) {
    ok(attestationPayload({ ...base, [k]: v } as never) !== p, `${k} is inside the signed payload`);
  }
}

// 5. **The pair check refuses the two ways §1.3 actually fails**, and accepts a
//    genuinely separated pair. Both keys are real, both signatures are real.
{
  const kPk = ("0x" + "11".repeat(32)) as `0x${string}`;
  const cPk = ("0x" + "22".repeat(32)) as `0x${string}`;
  const onChain = {
    keeper: privateKeyToAccount(kPk).address,
    coSigner: privateKeyToAccount(cPk).address,
  };

  const k = await attest("keeper", kPk);
  const c = await attest("cosigner", cPk);

  // Same process, so same host AND same RPC — the co-located case, which is what
  // "rebuilds one key with extra steps" means.
  const colocated = await verifyPair(k, c, onChain);
  ok(!colocated.ok, "a co-located pair is REFUSED");
  ok(colocated.problems.some((p) => p.includes("SAME HOST")), "and the host is named");
  ok(colocated.problems.some((p) => p.includes("SAME RPC")), "and so is the RPC");

  // Genuinely separated.
  const apart = await verifyPair(
    { ...k, host: "keeper-box", rpcHash: "0xaaaa" },
    { ...c, host: "cosigner-box", rpcHash: "0xbbbb" },
    onChain,
  );
  // Editing the fields breaks the signatures, which is the point of check 4 —
  // so what is asserted is that the HOST/RPC complaints are gone.
  ok(!apart.problems.some((p) => p.includes("SAME HOST")), "two hosts are not flagged");
  ok(!apart.problems.some((p) => p.includes("SAME RPC")), "two RPCs are not flagged");
  ok(
    apart.problems.some((p) => p.includes("does not recover")),
    "and an attestation edited after signing is caught, which is why the fields are inside it",
  );

  // A signature by the wrong key for the role it claims.
  const swapped = await verifyPair(k, { ...c, signer: onChain.keeper }, onChain);
  ok(!swapped.ok, "an attestation that does not recover to its claimed signer is refused");
}

server.closeAllConnections();
server.close();
console.log(`custody: ${checks} checks OK`);
