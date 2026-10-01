/**
 * `symbolsOf`, and the one thing that can be wrong with it: WHEN it asks again.
 *
 * A ticker that cannot be read does not fail visibly — every caller falls back
 * to the address or to "?" — so a refused batch put 46 addresses on the
 * creation screen and nothing said why. The retry is what fixes that, and it
 * has to tell the two cases apart: a node that answered nothing is worth asking
 * again, a token with no `symbol()` is not, and asking again for that one costs
 * a round trip per screen for ever.
 */
import assert from "node:assert/strict";
import type { Address } from "viem";

(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { pub, symbolsOf } = await import("./chain.js");

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const THREE = [A(1), A(2), A(3)];

/** Replaces the read with `f`, counting the rounds it is asked in. */
function stub(f: (address: string, round: number) => Promise<string>) {
  let calls = 0;
  pub.readContract = (async (p: { address: string }) => {
    const round = Math.floor(calls++ / THREE.length) + 1;
    return await f(p.address, round);
  }) as typeof pub.readContract;
  return () => calls;
}

// A node that refuses the whole batch is asked again — and the second round is
// ONE batch too, not one call per token, which is what retrying inside the
// caller would have meant.
{
  const calls = stub(async (a, round) => {
    if (round === 1) throw new Error("HTTP request failed: Failed to fetch");
    return "TICK" + a.slice(-1);
  });
  const out = await symbolsOf(THREE);
  assert.deepEqual(out, ["TICK1", "TICK2", "TICK3"], "the retry recovers every ticker");
  assert.equal(calls(), 6, "two rounds of three, not three retries of one");
}

// A MIX means the reads went through: one token simply has no `symbol()`, and
// no amount of asking again will change that.
{
  const calls = stub(async (a) => {
    if (a === A(2)) throw new Error("execution reverted");
    return "OK";
  });
  const out = await symbolsOf(THREE);
  assert.deepEqual(out, ["OK", null, "OK"], "the broken token is null, the others are read");
  assert.equal(calls(), 3, "and the round is NOT retried — a revert is an answer");
}

// A node that never answers gives up, bounded, with nulls the caller can see.
{
  const calls = stub(async () => { throw new Error("Failed to fetch"); });
  const out = await symbolsOf(THREE);
  assert.deepEqual(out, [null, null, null], "the caller is told, rather than left waiting");
  assert.equal(calls(), 9, "three rounds of three, and then it stops");
}

// Nothing to ask for asks nothing.
{
  const calls = stub(async () => "NEVER");
  assert.deepEqual(await symbolsOf([]), []);
  assert.equal(calls(), 0);
}

console.log("symbols: a refused batch is retried, a revert is not, and the bound holds");
