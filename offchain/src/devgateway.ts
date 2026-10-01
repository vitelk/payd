/**
 * devgateway.ts — a local stand-in for an IPFS gateway. **Rehearsal only.**
 *
 * The keeper refuses to publish a root until it has re-read the artifact back
 * through a gateway and matched its sha256 (`publish.ts`). That is the right
 * rule — a root whose JSON nobody can fetch is an epoch nobody can claim — but
 * it also means the keeper cannot run at all without IPFS, which made the one
 * component nobody had ever exercised the hardest one to exercise.
 *
 * A gateway, from `publish.ts`'s point of view, is exactly one thing:
 *
 *     GET <gateway><cid>  ->  bytes whose sha256 rebuilds that same cid
 *
 * So this serves the keeper's own `data/` directory, indexed by content. It
 * hashes each file, rebuilds the CIDv1, and answers the request whose CID
 * matches. Nothing is trusted: the keeper still verifies the digest it gets
 * back, and would reject a wrong answer exactly as it would from ipfs.io.
 *
 *   EPOCH_DIR=data pnpm --filter offchain devgateway     # listens on :8090
 *   IPFS_GATEWAYS=http://127.0.0.1:8090/ pnpm --filter offchain keeper
 *
 * **Never point a production keeper at this.** It proves the artifact exists on
 * the machine that just wrote it, which is precisely the thing a real gateway
 * check is supposed to rule out. Its only job is to let a fork rehearsal
 * exercise the publication path offline.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { cidFromSha256 } from "./publish.js";

const DIR = process.env.EPOCH_DIR ?? "data";
const PORT = Number(process.env.DEV_GATEWAY_PORT ?? 8090);

function findByCid(wanted: string): Buffer | null {
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith(".json")) continue;
    const bytes = readFileSync(`${DIR}/${name}`);
    const digest = ("0x" + createHash("sha256").update(bytes).digest("hex")) as `0x${string}`;
    if (cidFromSha256(digest) === wanted) return bytes;
  }
  return null;
}

createServer((req, res) => {
  const cid = (req.url ?? "/").replace(/^\/+/, "").split("?")[0] ?? "";
  const body = cid ? findByCid(cid) : null;

  if (!body) {
    res.writeHead(404).end("not found");
    console.log(`  404 ${cid}`);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(body);
  console.log(`  200 ${cid} (${body.length} bytes)`);
}).listen(PORT, () => {
  console.log(`dev gateway on http://127.0.0.1:${PORT}/ serving ${DIR}/ by content hash`);
  console.log("REHEARSAL ONLY — this proves the file is on this machine, nothing more.");
});
