/**
 * The check that matters: an IPFS gateway CANNOT lie.
 *
 * `fetchArtifact` accepts the first content whose sha256 equals the `digest`
 * published on-chain. Removing that comparison breaks nothing visible — the page
 * works, the figures show — and lets any gateway fabricate amounts. It is
 * exactly the kind of regression no display test catches.
 *
 *   node --experimental-strip-types src/payd.test.ts   (or `pnpm test`)
 */
import assert from "node:assert/strict";
import { sha256, toHex, type Address, type Hex } from "viem";
import { createPayd } from "./payd.js";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const DIST = "0x2222222222222222222222222222222222222222" as Address;
const HOLDER = "0x3333333333333333333333333333333333333333" as Address;
const NVDA = "0x4444444444444444444444444444444444444444" as Address;

const artifact = {
  upToEpoch: 7,
  excluded: [],
  entries: [{ holder: HOLDER, stock: NVDA, cumulative: "1000", push: true }],
};
const body = JSON.stringify(artifact);
const digest = sha256(toHex(body)) as Hex;

/** The minimum of chain `shares()` queries. `roots` follows `Distributor.Root`
 *  field for field: the digest is the SIXTH, not the fifth. */
function fakeClient(rootDigest: Hex) {
  return {
    async readContract({ address, functionName, args }: any) {
      if (address === VAULT && functionName === "DISTRIBUTOR") return DIST;
      if (address === DIST) {
        if (functionName === "activeRoot") return 1n;
        if (functionName === "roots") return [VAULT, 0n, "0x", "0x", 7n, rootDigest];
        if (functionName === "owedTo") return 250n;
        if (functionName === "claimedSoFar") return 750n;
      }
      if (address === NVDA && functionName === "symbol") return "NVDAx";
      if (address === NVDA && functionName === "decimals") return 18;
      throw new Error(`unexpected read ${functionName} ${String(args)}`);
    },
    async getLogs() { return []; },
  } as never;
}

async function run() {
  const served: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (url: string) => {
    served.push(url);
    return { ok: true, text: async () => body } as never;
  };

  // 1. The digest matches: the share is read and returned.
  const ok = createPayd({ vault: VAULT, client: fakeClient(digest), gateways: ["ipfs://test/"] });
  const shares = await ok.shares(HOLDER);
  assert.equal(shares.length, 1);
  assert.equal(shares[0]!.symbol, "NVDAx");
  assert.equal(shares[0]!.owed, 250n);
  assert.equal(shares[0]!.cumulative, 1000n);
  assert.ok(served[0]!.startsWith("ipfs://test/bafkrei"), `CID reconstruit attendu, recu ${served[0]}`);

  // 2. ONE BIT of difference in the on-chain digest, and the same content is
  //    refused. Without the sha256 check this case would return the same share
  //    as case 1.
  const tampered = (digest.slice(0, -1) + (digest.endsWith("0") ? "1" : "0")) as Hex;
  const bad = createPayd({ vault: VAULT, client: fakeClient(tampered), gateways: ["ipfs://test/"] });
  assert.deepEqual(await bad.shares(HOLDER), []);

  // 3. Boundary: an invalid address throws immediately rather than letting an
  //    `eth_call` return `0x` and a card show mute zeros.
  assert.throws(() => createPayd({ vault: "0xnope" as Address }), /invalid vault address/);
  await assert.rejects(ok.shares("0xnope" as Address), /invalid holder address/);

  console.log("payd sdk: ok");
}

run().catch((e) => { console.error(e); process.exit(1); });
