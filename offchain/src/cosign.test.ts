/**
 * cosign.ts — the second opinion refuses what it does not reproduce.
 *
 * The recomputation itself is covered by `determinism.test.ts`; what is checked
 * here is the decision taken on top of it, which is the whole of what the second
 * key is for. A co-signer that signs whatever it is handed is a second secret,
 * not a second opinion, and the difference is this function.
 */
import assert from "node:assert/strict";
import { cosignVerdict } from "./cosign.js";

let checks = 0;
function ok(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

const mine = { claimRoot: "0xaa", pushRoot: "0xbb", cid: "bafyHONEST" };

// 1. What this node reproduces, it signs.
{
  const v = cosignVerdict({ ...mine }, mine);
  ok(v.sign === true, "an honest root is signed");
}

// 2. The attack of AUDIT_PLAN.md §1.1: a claimRoot awarding the publisher the
//    undelivered balance. The push tree and the cid can be left alone.
{
  const v = cosignVerdict({ ...mine, claimRoot: "0xdead" }, mine);
  ok(v.sign === false, "a forged claimRoot is refused");
  ok(v.sign === false && v.differs.join() === "claimRoot", "and the refusal names it");
  ok(v.sign === false && v.detail.includes("REFUSED"), "in words an operator reads as an incident");
}

// 3. The delivery floor manipulated: same entitlements, a push tree that leaves
//    out the holders the keeper would rather not pay.
{
  const v = cosignVerdict({ ...mine, pushRoot: "0xbeef" }, mine);
  ok(v.sign === false, "a manipulated pushRoot is refused");
  ok(v.sign === false && v.differs.join() === "pushRoot", "and named");
}

// 4. Roots that agree and data that does not: the proofs come from that file, so
//    this is a root nobody can claim against.
{
  const v = cosignVerdict({ ...mine, cid: "bafyOTHER" }, mine);
  ok(v.sign === false, "a cid that does not match the roots is refused");
}

// 5. No tolerance, on any field. Two honest replays of one chain state give the
//    same three values, so "close" is not a thing the co-signer may accept.
{
  ok(cosignVerdict({ ...mine, claimRoot: "0xaA" }, mine).sign === false, "case is not a match");
  ok(cosignVerdict({ ...mine, cid: "bafyHONEST " }, mine).sign === false, "nor is a trailing space");
  const all = cosignVerdict({ claimRoot: "1", pushRoot: "2", cid: "3" }, mine);
  ok(all.sign === false && all.differs.length === 3, "and three divergences are all reported, not the first");
}

console.log(`cosign: ${checks} checks OK`);
