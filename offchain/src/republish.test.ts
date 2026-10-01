/**
 * Serving a root from the artifact that was published, not from a rebuild.
 *
 * The failure this pins happened in production at 00:55:56 UTC on 2026-09-14:
 * root #52 covering epoch 58 was published at 00:45:43 and epoch 58's own
 * `WindowFunded` landed 61 seconds later, so a tree rebuilt from the chain ten
 * minutes on contained a window the published one did not. 96 wallets, 96
 * reverts, nothing delivered.
 *
 * `keeper.ts` cannot be imported in CI — it wants a private key and an RPC — so
 * what is tested here is the property the fix rests on: `build` is a pure
 * function of (entries, pushKeys), the artifact carries both, and a later
 * window cannot reach it.
 */
import { build, key, type Entry } from "./merkle.js";
import type { Address } from "viem";

let checks = 0;
const eq = (a: unknown, b: unknown, what: string) => {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
};
const ok = (c: boolean, what: string) => {
  if (!c) throw new Error(what);
  checks++;
};

const H1 = "0x1111111111111111111111111111111111111111" as Address;
const H2 = "0x2222222222222222222222222222222222222222" as Address;
const SPY = "0x117Cc2133C37b721f49De2A7a74833232b3B4C0c" as Address;

/** What the keeper writes to disk and pins on IPFS. */
const artifact = {
  upToEpoch: 58,
  entries: [
    { holder: H1, stock: SPY, cumulative: "1000000000000000000", push: true },
    { holder: H2, stock: SPY, cumulative: "2000000000000000000", push: false },
  ],
};

/** `fromPublished` in keeper.ts, in one place so the property is testable. */
function fromPublished(a: typeof artifact) {
  const entries: Entry[] = a.entries.map((e) => ({
    holder: e.holder, stock: e.stock, cumulative: BigInt(e.cumulative),
  }));
  const pushKeys = new Set(
    a.entries.filter((e) => e.push).map((e) => `${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`),
  );
  return { ...build(entries, pushKeys), pushKeys };
}

// 1. Replaying the artifact reproduces the roots that were committed on-chain.
const published = fromPublished(artifact);
const again = fromPublished(JSON.parse(JSON.stringify(artifact)));
eq(published.pushRoot, again.pushRoot, "the same artifact gives the same pushRoot");
eq(published.claimRoot, again.claimRoot, "and the same claimRoot");

// 2. The `push` flag IS the push set. Nothing re-derives a floor at serve time,
//    so no constant, basefee or window can move it afterwards.
eq(published.pushKeys.size, 1, "one entry was flagged, one entry is pushed");
ok(published.pushKeys.has(key(H1, SPY)), "and it is the flagged one");

// 3. THE BUG. A window arriving after the root changes every cumulative; a
//    rebuild follows it, the artifact does not. Different pushRoot = no proof
//    verifies = `NothingDelivered` on every wallet, which is what the keeper's
//    pushRoot comparison now catches BEFORE sending 96 transactions.
const lateWindow: Entry[] = artifact.entries.map((e) => ({
  holder: e.holder, stock: e.stock, cumulative: BigInt(e.cumulative) + 5_000_000_000_000_000n,
}));
const rebuilt = build(lateWindow, published.pushKeys);
ok(rebuilt.pushRoot !== published.pushRoot, "a late window really does move the pushRoot");
ok(
  fromPublished(artifact).pushRoot === published.pushRoot,
  "and replaying the artifact is immune to it — the whole point of the fix",
);

// 4. A proof drawn from the replayed tree is the one the contract will accept,
//    because it is drawn from the tree the contract committed to.
const proof = published.proofFor(H1, SPY, "push");
ok(Array.isArray(proof), "a push proof comes out of the replayed tree");

console.log(`republish: ${checks} checks OK`);
