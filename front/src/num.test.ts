/**
 * The degrade-don't-throw rule, checked. `pnpm --filter front test`
 *
 * The value in `V1_POOL_FEE` is not invented: it is what the live v1 vault
 * `0xF688…2346` puts in the tuple field the v2 ABI calls `uint24 poolFee`,
 * read on 2026-09-09. It is an address, which is why it is 2^160-shaped. Every
 * regression this file guards against starts by treating it as a number.
 */
import assert from "node:assert/strict";
import { toNum, toNumMax, soft } from "./num.js";

const V1_POOL_FEE = 1189613467694738019150202360368048557920044818156n;

// --- what a good read gives ------------------------------------------------
assert.equal(toNum(0n), 0);
assert.equal(toNum(1800n), 1800);
assert.equal(toNum(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
assert.equal(toNum(400), 400);

// --- what a bad one gives: null, and never a wrong number -------------------
assert.equal(toNum(V1_POOL_FEE), null, "the v1 word must read as unavailable");
assert.equal(toNum(BigInt(Number.MAX_SAFE_INTEGER) + 1n), null);
assert.equal(toNum(-1n), null, "a uint that decoded negative is not a uint");
assert.equal(toNum(undefined), null, "a tuple shorter than its ABI");
assert.equal(toNum(null), null);
assert.equal(toNum("400"), null, "a string is not a decoded uint");
assert.equal(toNum(1.5), null);

// The clamp that was NOT chosen: had we coerced, this would be a finite number
// and the card would show it. It is the whole point of the decision.
assert.notEqual(Number(V1_POOL_FEE), null);
assert.equal(Number.isFinite(Number(V1_POOL_FEE)), true);

// --- a bound the caller knows ----------------------------------------------
assert.equal(toNumMax(10_000n, 10_000), 10_000, "a full basket is 10 000 bps");
assert.equal(toNumMax(10_001n, 10_000), null, "10 001 bps is not a share");
assert.equal(toNumMax(V1_POOL_FEE, 10_000), null);
assert.equal(toNumMax(3n, 3), 3, "hookStatus 3 is 'fees lost', a real state");
assert.equal(toNumMax(4n, 3), null);

// --- a read that throws -----------------------------------------------------
const boom = () => Promise.reject(new Error("Number \"…\" is not in safe integer range"));
assert.deepEqual(await soft(boom(), []), [], "a failed read falls back");
assert.equal(await soft(Promise.resolve(7), 0), 7, "a good read passes through");

// `soft` swallows the rejection rather than deferring it: an unhandled
// rejection here would be a crash one tick later, which is the defect it fixes.
await soft(boom(), null);

console.log("num.test.ts ok");
