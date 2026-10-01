/**
 * dispute.ts — the verdict, against a root the fixture knows to be forged.
 *
 * **T-OFF-01.** `AUDIT_PLAN.md` §5 records that `dispute.ts` had no dedicated
 * test at all, and that it is the ONLY verification left after §S29 removed the
 * bond and the challenge window. The whole keeper model rests on a third party
 * being able to contradict us; a script that says so has to be known to say so.
 *
 * The recomputation itself is covered elsewhere — `determinism.test.ts` pins
 * that the same input gives the same root, and `test/MerkleCompat.t.sol` pins
 * that our tree agrees with the contract's verifier. What is checked here is
 * the part nothing else touches: put a published root next to an honest replay
 * and name what differs.
 *
 *   pnpm --filter offchain test
 */
import assert from "node:assert/strict";
import { disputeVerdict, DIVERGENCE_MEANING } from "./dispute.js";

let checks = 0;
function ok(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

const honest = {
  claimRoot: "0x1111111111111111111111111111111111111111111111111111111111111111",
  pushRoot: "0x2222222222222222222222222222222222222222222222222222222222222222",
  cid: "bafyHONEST",
};

// 1. An honest root agrees with its replay, and says nothing else.
{
  const v = disputeVerdict(honest, { ...honest });
  ok(v.matches === true, "an honest root matches its own recomputation");
  ok(v.differs.length === 0, "and names no divergence");
}

// 2. A FORGED root — the attack of AUDIT_PLAN.md §1.1: the keeper publishes a
//    claimRoot awarding itself the undelivered balance. The pushRoot and the
//    cid can be left alone; the claim tree is where the money is.
{
  const forged = { ...honest, claimRoot: "0xdead".padEnd(66, "0") };
  const v = disputeVerdict(forged, honest);
  ok(v.matches === false, "a forged claimRoot must NOT match");
  ok(v.differs.join() === "claimRoot", "and the report must name claimRoot, and only claimRoot");
  ok(
    DIVERGENCE_MEANING.claimRoot!.includes("entitlements or cumulative amounts were altered"),
    "and say what that means to somebody who did not write it",
  );
}

// 3. A manipulated DELIVERY FLOOR: same entitlements, a pushRoot that excludes
//    the holders the keeper would rather not pay. Nothing in the claim tree
//    moves, so a check that only looked at claimRoot would call this honest.
{
  const forged = { ...honest, pushRoot: "0xbeef".padEnd(66, "0") };
  const v = disputeVerdict(forged, honest);
  ok(v.matches === false, "a manipulated pushRoot must NOT match");
  ok(v.differs.join() === "pushRoot", "and it is the pushRoot that is named");
}

// 4. The roots agree and the DATA behind them does not — a cid pointing at a
//    file that does not produce these roots. The proofs come from that file, so
//    this is a root nobody can claim against.
{
  const forged = { ...honest, cid: "bafySOMETHINGELSE" };
  const v = disputeVerdict(forged, honest);
  ok(v.matches === false, "a cid that does not match the roots must NOT match");
  ok(v.differs.join() === "cid", "and the cid is what is named");
}

// 5. All three at once: everything is named, in a fixed order, so two people
//    running this on two machines write the same report.
{
  const v = disputeVerdict({ claimRoot: "0xa", pushRoot: "0xb", cid: "x" }, honest);
  ok(v.matches === false, "three divergences are still a divergence");
  ok(v.differs.join(",") === "claimRoot,pushRoot,cid", "all three named, in a fixed order");
  ok(
    v.differs.every((d) => typeof DIVERGENCE_MEANING[d] === "string"),
    "and every name the verdict can produce has a sentence explaining it",
  );
}

console.log(`dispute: ${checks} checks OK`);
