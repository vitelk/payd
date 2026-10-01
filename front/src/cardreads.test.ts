/**
 * The Tokens cards' read pipeline, in node. `pnpm --filter front test`
 *
 * `cards.test.ts` checks the arithmetic with no chain in the way. This checks
 * the part that cannot be pure, and the property that decides whether the index
 * still works at fifty launches: **the count of ROUND TRIPS must not grow with
 * the length of the list.** Measured here: twelve launches, 116 calls, FIVE
 * rounds — basket+age+logo, decimals, getPool, slot0+token0, totalDistributed.
 * The stub answers nothing until the event loop turns, so a `Promise.all`
 * quietly turned into a `for await` pays a round per launch here exactly as it
 * would against a node, and fails rather than reaching a visitor with a
 * fifty-launch registry and an endpoint that throttles at 25 requests a second.
 *
 * It also pins the deduplication: twelve launches drawing their baskets from the
 * same five equities must price five stocks and not sixty.
 */
import assert from "node:assert/strict";
import type { Address } from "viem";

(globalThis as { location?: unknown }).location = new URL("http://localhost/");

const { pub } = await import("./chain.js");
const { readExtras } = await import("./cardreads.js");
const { paidOf } = await import("./cards.js");

const N = 12;
const vaultAt = (i: number) => `0x${(i + 1).toString(16).padStart(4, "0")}${"7a".repeat(18)}` as Address;
const distAt = (i: number) => `0x${(i + 1).toString(16).padStart(4, "0")}${"d1".repeat(18)}` as Address;
const tokenAt = (i: number) => `0x${(i + 1).toString(16).padStart(4, "0")}${"c3".repeat(18)}` as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Five stocks, two tiers, shared by every launch — which is the real shape:
 *  the allowlist is a dozen equities however many launches draw from it. */
const STOCKS = [0, 1, 2, 3, 4].map((i) => `0x${(0xd0000 + i * 0x1111).toString(16).padStart(40, "0")}` as Address);
const TIER = [500, 500, 3000, 500, 3000];
const PRICE = [487.20, 178.45, 312.80, 26.15, 402.60];
const DECIMALS = [18, 18, 6, 18, 18]; // one of them is NOT eighteen, on purpose
const GENESIS = BigInt(Math.floor(Date.now() / 1000) - 3 * 24 * 3600); // three days old
const poolAt = (i: number) => `0x${(0x9000 + i).toString(16).padStart(4, "0")}${"b1".repeat(18)}` as Address;
const sqrtX96 = (u: number) => BigInt(Math.floor(Math.sqrt(u / 1e12) * 2 ** 96));

/** One whole unit of stock 0 and two of stock 1 delivered, per launch. Stock 2
 *  has delivered nothing, and stocks 3 and 4 a round amount each. */
const DELIVERED = [10n ** 18n, 2n * 10n ** 18n, 0n, 10n ** 18n, 10n ** 18n];

const calls: string[] = [];
/** Which ROUND each call landed in, and the model that decides what a round is.
 *
 * Nothing resolves until the event loop turns: every call issued before then
 * queues, and one `setTimeout` flush answers all of them at once. That is
 * exactly what `batch.multicall` does to a tick of `readContract`s — fold them
 * into one `eth_call` — so the flush count IS the round-trip count, and code
 * that awaits one launch before asking about the next pays a round per launch
 * here just as it would against a node.
 */
let rounds = 0;
const roundOf: number[] = [];
let queue: (() => void)[] = [];
let scheduled = false;
function later<T>(v: T): Promise<T> {
  return new Promise<T>((res) => {
    queue.push(() => res(v));
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        rounds++;
        const q = queue;
        queue = [];
        for (const r of q) r();
      }, 0);
    }
  });
}

pub.readContract = ((p: { address: Address; functionName: string; args?: readonly unknown[] }) => {
  calls.push(p.functionName);
  roundOf.push(rounds);
  const fn = p.functionName;
  const addr = p.address.toLowerCase();
  if (fn === "getAllocations") {
    return later(STOCKS.map((stock, i) => ({ stock, poolFee: TIER[i]!, bps: 2000, feed: ZERO })));
  }
  if (fn === "GENESIS") return later(GENESIS);
  if (fn === "logo") return later(addr === tokenAt(1).toLowerCase() ? "" : "ipfs://bafkreitest");
  if (fn === "decimals") return later(DECIMALS[STOCKS.findIndex((s) => s.toLowerCase() === addr)] ?? 18);
  if (fn === "getPool") {
    const i = STOCKS.findIndex((s) => s.toLowerCase() === String(p.args?.[0]).toLowerCase());
    return later(i < 0 ? ZERO : poolAt(i));
  }
  if (fn === "token0") return later(STOCKS[[0, 1, 2, 3, 4].find((i) => poolAt(i).toLowerCase() === addr)!]!);
  if (fn === "slot0") {
    const i = [0, 1, 2, 3, 4].find((k) => poolAt(k).toLowerCase() === addr)!;
    return later([sqrtX96(PRICE[i]!), 0, 0, 0, 0, 0, true]);
  }
  if (fn === "totalDistributed") {
    const i = STOCKS.findIndex((s) => s.toLowerCase() === String(p.args?.[0]).toLowerCase());
    return later(DELIVERED[i] ?? 0n);
  }
  throw new Error(`no stub for ${fn}`);
}) as typeof pub.readContract;

const launches = Array.from({ length: N }, (_, i) => ({
  vault: vaultAt(i), distributor: distAt(i), token: tokenAt(i),
}));
// One launch that has not launched: no token, so nothing to read on it at all.
const withCurve = [...launches, { vault: vaultAt(99), distributor: distAt(99), token: ZERO }];

const extras = await readExtras(withCurve);

// --- every live launch got an entry, and the unlaunched one got none ---------
assert.equal(extras.size, N, "one entry per LAUNCHED vault");
assert.equal(extras.get(vaultAt(99).toLowerCase()), undefined,
  "a vault with no token is not read: there is no distributor history to price");

// --- the headline, computed the same way `cards.test.ts` says it should be ---
const want = paidOf(DELIVERED.map((units, i) => ({ units, decimals: DECIMALS[i]!, price: PRICE[i]! })));
assert.ok(want !== null && want > 0);
const got = extras.get(vaultAt(0).toLowerCase())!;
assert.ok(Math.abs(got.paidUsd! - want) < 0.01, `headline ${got.paidUsd} should be ${want}`);
// The decimals are the STOCK's own: stock 2 has six of them. Reading eighteen
// everywhere is a factor of 1e12 on that line, and it is the kind of error that
// shows up as a plausible number rather than as a crash.
assert.equal(DECIMALS[2], 6);

// --- the age comes from GENESIS, not from a log walk ------------------------
assert.ok(got.ageSeconds! >= 3 * 24 * 3600, "three days old, from the Distributor's epoch zero");
assert.ok(got.ageSeconds! < 3 * 24 * 3600 + 60, "and not a second more");
assert.ok(!calls.includes("getLogs"), "no log walk: it cannot reach the head on this chain");

// --- the logo resolves through a gateway, and an empty one stays empty -------
assert.ok(got.logo.startsWith("https://"), "ipfs:// is resolved to a gateway URL");
assert.ok(got.logo.endsWith("bafkreitest"));
assert.equal(extras.get(vaultAt(1).toLowerCase())!.logo, "",
  "a token with no logo gets no URL, so the card falls back to its ticker");

// --- THE COST. This is what the file is for. --------------------------------
const count = (fn: string) => calls.filter((c) => c === fn).length;
assert.equal(count("getAllocations"), N, "the basket is per launch");
assert.equal(count("GENESIS"), N, "so is the age");
assert.equal(count("logo"), N, "so is the logo");
assert.equal(count("totalDistributed"), N * STOCKS.length, "and what was delivered is per leg");
// The dedup: five stocks priced once each, not sixty.
assert.equal(count("decimals"), STOCKS.length, "one decimals read per DISTINCT stock");
assert.equal(count("getPool"), STOCKS.length, "one pool per distinct (stock, tier)");
assert.equal(count("slot0"), STOCKS.length, "and one price read on it");
assert.equal(count("token0"), STOCKS.length);
// 12 launches × 5 legs would be 60 pool reads if this were priced per leg.
assert.ok(count("slot0") * 12 === 60, "which is the 60 requests the dedup saves");

// --- and the shape of the walk: a bounded number of ROUNDS, not one per launch.
//
// The launches are read together, so the tick a call lands in must not be a
// function of which launch it belongs to. `getAllocations` for launch 0 and for
// launch 11 are in the same round or the index is serialised.
const roundsOf = (fn: string) =>
  new Set(calls.map((c, i) => (c === fn ? roundOf[i]! : -1)).filter((t) => t !== -1));
assert.equal(roundsOf("getAllocations").size, 1, "every launch's basket is asked for in ONE round");
assert.equal(roundsOf("GENESIS").size, 1, "and so is every age");
assert.equal(roundsOf("logo").size, 1, "and every logo");
assert.equal(roundsOf("totalDistributed").size, 1, "and every leg's delivered amount");
assert.equal(roundsOf("decimals").size, 1, "the prices are one round for the decimals…");
assert.equal(roundsOf("getPool").size, 1, "…one for the pools…");
assert.equal(roundsOf("slot0").size, 1, "…and one for what is in them");
// FIVE rounds for twelve launches: basket+age+logo, decimals, getPool,
// slot0+token0, totalDistributed. The number that matters is that it does not
// mention N — a walk of one launch at a time would be 12 × that.
assert.ok(rounds <= 5, `the whole pipeline is ${rounds} rounds, which should be at most 5`);

console.log(
  `cardreads: ${N} launches cost ${calls.length} calls in ${rounds} rounds, five stocks priced once each`,
);
