/**
 * The personal-portfolio mode's push planner, with no chain in sight.
 *
 * **The root needs no test of its own here, and that is the design showing.**
 * A portfolio vault funds ONE line — the pivot — so its root is the
 * distribution mode's, built by `plainAccrual`, and everything about
 * eligibility, exclusions and the trees is already covered by `epoch.test.ts`
 * and `determinism.test.ts`. What is new is the PLAN: who is converted into
 * which stock, in which batch.
 *
 * Five properties:
 *
 *   1. **Mutualisation.** Holders who want the same stock land in ONE batch,
 *      because one batch is one swap and that is the whole economic claim of
 *      converting at delivery rather than per holder.
 *   2. **A split row is served across batches**, and each slice is the same
 *      integer division `PortfolioDistributor._take` performs — so `pivotIn` is
 *      what the swap will spend, never an estimate of it.
 *   3. **Nobody is lost past `MAX_BATCH`.** A stock with more takers than a
 *      batch holds is served by consecutive calls, not truncated.
 *   4. **Determinism.** Shuffle the input, get the same batches: the keeper, a
 *      dry run and anybody auditing the plan must agree.
 *   5. **No empty work.** A slice that rounds to zero produces no batch and no
 *      swap.
 */
import {
  BPS, MAX_BATCH, LINE_FLOOR_CENTS, lineFloor, planBatches, sliceFor, convertibleLines, type Due,
} from "./portfolio.js";
import type { Address } from "viem";

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as Address;
const QQQ = "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68" as Address;
const GLD = "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e" as Address;
const ANNA = "0x1111111111111111111111111111111111111111" as Address;
const BORIS = "0x2222222222222222222222222222222222222222" as Address;
const WHALE = "0x3333333333333333333333333333333333333333" as Address;

let checks = 0;
function eq(a: bigint, b: bigint, what: string) {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
}
function eqn(a: number, b: number, what: string) {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
}
function eqs(a: string, b: string, what: string) {
  if (a.toLowerCase() !== b.toLowerCase()) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
}
function ok(c: boolean, what: string) {
  if (!c) throw new Error(what);
  checks++;
}

const forStock = (bs: ReturnType<typeof planBatches>, s: Address) => bs.filter((b) => b.stock === s);

// ------------------------------------------------- 1. one swap, many holders

{
  const due: Due[] = [
    { holder: ANNA, cumulative: 1_000n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] },
    { holder: BORIS, cumulative: 3_000n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] },
  ];
  const b = planBatches(due);
  eqn(b.length, 1, "two holders wanting the same stock are ONE swap");
  eqn(b[0]!.holders.length, 2, "both of them in it");
  eq(b[0]!.pivotIn, 4_000n, "and the swap spends the sum of their slices");
  eqs(b[0]!.holders[0]!, BORIS, "the larger conversion leads, so a batch clears its own floor first");
}

{
  const due: Due[] = [
    { holder: ANNA, cumulative: 1_000n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] },
    { holder: BORIS, cumulative: 1_000n, claimed: 0n, converted: {}, lines: [{ stock: QQQ, bps: 10_000 }] },
  ];
  const b = planBatches(due);
  eqn(b.length, 2, "two stocks are two swaps: there is nothing to share");
  eqs(forStock(b, NVDA)[0]!.holders[0]!, ANNA, "each in their own");
  eqs(forStock(b, QQQ)[0]!.holders[0]!, BORIS, "and only their own");
}

// --------------------------------------- 2. a split row, across three batches

{
  // Deliberately indivisible: 1,001 split 50/30/20 floors to 500 + 300 + 200,
  // leaving one unit of pivot entitlement behind — which stays the holder's and
  // is converted by a later call. Nothing is promised twice.
  const due: Due[] = [{ holder: ANNA, cumulative: 1_001n, claimed: 0n, converted: {}, lines: [
    { stock: NVDA, bps: 5_000 }, { stock: QQQ, bps: 3_000 }, { stock: GLD, bps: 2_000 },
  ] }];
  const b = planBatches(due);
  eqn(b.length, 3, "three lines, three batches");
  eq(forStock(b, NVDA)[0]!.pivotIn, 500n, "each slice is owed * bps / BPS, floored");
  eq(forStock(b, QQQ)[0]!.pivotIn, 300n, "the same division the contract performs");
  eq(forStock(b, GLD)[0]!.pivotIn, 200n, "and never a rounding of our own");
  eq(
    b.reduce((a, x) => a + x.pivotIn, 0n),
    1_000n,
    "the remainder stays the holder's rather than being handed to somebody",
  );
  ok(b.every((x) => x.holders.length === 1 && x.holders[0] === ANNA), "one holder, in all three");
}

// ---------------------------------------------- 3. nobody is lost past MAX_BATCH

{
  const due: Due[] = [];
  for (let i = 0; i < MAX_BATCH + 5; i++) {
    due.push({
      holder: (`0x${(i + 1).toString(16).padStart(40, "0")}`) as Address,
      cumulative: BigInt(1_000 + i), claimed: 0n, converted: {},
      lines: [{ stock: NVDA, bps: 10_000 }],
    });
  }
  const b = planBatches(due);
  eqn(b.length, 2, "69 takers of one stock are two consecutive calls");
  eqn(b[0]!.holders.length, MAX_BATCH, "the first is full");
  eqn(b[1]!.holders.length, 5, "the tail is served, not truncated");
  const seen = new Set([...b[0]!.holders, ...b[1]!.holders]);
  eqn(seen.size, MAX_BATCH + 5, "every holder appears exactly once");
  eq(
    b.reduce((a, x) => a + x.pivotIn, 0n),
    due.reduce((a, d) => a + d.cumulative, 0n),
    "and the whole of what was due is planned",
  );
}

// ----------------------------------------------------------- 4. determinism

{
  const due: Due[] = [
    { holder: ANNA, cumulative: 7_777n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 6_000 }, { stock: GLD, bps: 4_000 }] },
    { holder: BORIS, cumulative: 333n, claimed: 0n, converted: {}, lines: [{ stock: QQQ, bps: 10_000 }] },
    { holder: WHALE, cumulative: 111_111n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] },
  ];
  const a = planBatches(due);
  const c = planBatches([...due].reverse());
  eqn(a.length, c.length, "shuffling the input does not change the number of swaps");
  for (let i = 0; i < a.length; i++) {
    eqs(a[i]!.stock, c[i]!.stock, `batch ${i}: same stock`);
    eq(a[i]!.pivotIn, c[i]!.pivotIn, `batch ${i}: same amount`);
    eqs(a[i]!.holders.join(","), c[i]!.holders.join(","), `batch ${i}: same holders, same order`);
  }
}

{
  // Equal slices tie-break by address, so the order is total and not the
  // input's.
  const due: Due[] = [
    { holder: WHALE, cumulative: 100n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] },
    { holder: ANNA, cumulative: 100n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] },
  ];
  eqs(planBatches(due)[0]!.holders[0]!, ANNA, "equal slices are ordered by address, not by arrival");
}

// -------------------------------------------------------- 5. no empty work

{
  // 3 pivot units on a 20 % line floors to zero: no batch, no swap, and the
  // entitlement stays whole for a later call.
  const due: Due[] = [{ holder: ANNA, cumulative: 3n, claimed: 0n, converted: {}, lines: [
    { stock: NVDA, bps: 8_000 }, { stock: QQQ, bps: 2_000 },
  ] }];
  const b = planBatches(due);
  eqn(b.length, 1, "a slice that rounds to zero produces no swap");
  eqs(b[0]!.stock, NVDA, "only the line that has something to convert");
  eq(b[0]!.pivotIn, 2n, "and it spends what it actually has");

  eqn(planBatches([{ holder: ANNA, cumulative: 0n, claimed: 0n, converted: {}, lines: [{ stock: NVDA, bps: 10_000 }] }]).length, 0,
    "a holder owed nothing is not planned at all");
  eqn(planBatches([{ holder: ANNA, cumulative: 1_000n, claimed: 0n, converted: {}, lines: [] }]).length, 0,
    "nor a holder whose row is empty - the creator left no default and they chose nothing");
}

// ------------------------------- 6. resuming, which is where the bug lived

{
  // A 50/50 holder, half of them already converted into NVDA. The remaining
  // plan must be the OTHER half into QQQ — not half of what is left.
  //
  // `sliceFor` is the contract's own arithmetic; getting this wrong is what
  // made a 50/50 holder settle 750 units of 1,000 across two calls, in 2:1
  // proportions, and it was invisible until a fork test counted.
  const d: Due = {
    holder: ANNA,
    cumulative: 1_000n,
    claimed: 500n,
    converted: { [NVDA]: 500n },
    lines: [{ stock: NVDA, bps: 5_000 }, { stock: QQQ, bps: 5_000 }],
  };
  eq(sliceFor(d, { stock: NVDA, bps: 5_000 }), 0n, "the line already converted asks for nothing more");
  eq(sliceFor(d, { stock: QQQ, bps: 5_000 }), 500n, "and the other takes its OWN half, not half the remainder");

  const b = planBatches([d]);
  eqn(b.length, 1, "only the unserved line is planned");
  eqs(b[0]!.stock, QQQ, "the right one");
  eq(b[0]!.pivotIn, 500n, "for the right amount");

  // And once both are done, nothing is planned at all.
  eqn(planBatches([{ ...d, converted: { [NVDA]: 500n, [QQQ]: 500n }, claimed: 1_000n }]).length, 0,
    "a fully converted holder is not planned again");
}

{
  // The whole of a row is planned across calls and never more than the
  // cumulative: the property the contract's two clamps enforce.
  const lines = [{ stock: NVDA, bps: 3_000 }, { stock: QQQ, bps: 3_000 }, { stock: GLD, bps: 4_000 }];
  const first = planBatches([{ holder: ANNA, cumulative: 9_999n, claimed: 0n, converted: {}, lines }]);
  const total = first.reduce((a, x) => a + x.pivotIn, 0n);
  ok(total <= 9_999n, "a plan never spends more than the holder's cumulative");
  eq(total, 2_999n + 2_999n + 3_999n, "and each line is its own floored share of it");
}

eq(BPS, 10_000n, "the planner's BPS is the contract's");

{
  // ---- the per-line floor -------------------------------------------------
  //
  // The gate that replaced `MAX_LINES = 8`. A line is converted once IT is
  // worth converting, so a holder may name as many stocks as they like and the
  // small lines simply wait.
  const floor = lineFloor(6); // USDG, six decimals
  eq(floor, 1_500_000n, "$1.50 in the pivot's own units");
  eq(lineFloor(18), 1_500_000_000_000_000_000n, "and it follows the pivot's scale, not a constant");
  eq(LINE_FLOOR_CENTS, 150n, "the measured floor: 20 x 140,954 gas at the cost epoch.ts records is $1.22");

  // $10 across two lines: $5 each, both over the floor.
  const rich: Due = {
    holder: ANNA, cumulative: 10_000_000n, claimed: 0n, converted: {},
    lines: [{ stock: NVDA, bps: 5_000 }, { stock: QQQ, bps: 5_000 }],
  };
  eqn(planBatches([rich], floor).length, 2, "both halves of a $10 holder are worth a swap");

  // $2 across the same two lines: $1 each, under the floor. Nothing is planned
  // — and nothing is lost, which is the next case.
  const poor: Due = { ...rich, cumulative: 2_000_000n };
  eqn(planBatches([poor], floor).length, 0, "a $1 slice does not pay for its own swap");
  eqn(planBatches([poor]).length, 2, "and without a floor the planner still plans it — the gate is the floor, not the shape");

  // A line under the floor is DEFERRED: the target is cumulative, so once the
  // holder's share has grown the whole of it converts in one go.
  const grown: Due = { ...poor, cumulative: 4_000_000n };
  const b = planBatches([grown], floor);
  eqn(b.length, 2, "grown past the floor, the same two lines are planned");
  eq(b[0]!.pivotIn, 2_000_000n, "and each takes its WHOLE share, the deferred part included");

  // A 1 % line on a holder big enough to carry it. The 5 % minimum this
  // replaced would have refused the row outright.
  const wide: Due = {
    holder: ANNA, cumulative: 1_000_000_000n, claimed: 0n, converted: {},
    lines: [{ stock: NVDA, bps: 100 }, { stock: QQQ, bps: 9_900 }],
  };
  const wb = planBatches([wide], floor);
  eqn(wb.length, 2, "a 1 % line of a $1,000 holder is $10 and is served");
  eq(wb.find((x) => x.stock === NVDA)!.pivotIn, 10_000_000n, "at exactly its one per cent");
}

{
  // ---- a stock the registry no longer allows -------------------------------
  //
  // `distributeInto` refuses it, and the planner used to plan it anyway: the
  // call failed its gas estimate every interval, for ever, with nothing telling
  // the holder their line had stopped converting. Nothing is lost — the pivot
  // entitlement stays claimable — but the silence was the defect.
  const PIVOT = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
  const row = [
    { stock: NVDA, bps: 4_000 },
    { stock: QQQ, bps: 4_000 },
    { stock: PIVOT, bps: 2_000 },
  ];
  const allowed = new Set([NVDA.toLowerCase()]); // QQQ has been delisted

  const kept = convertibleLines(row, allowed, PIVOT);
  eqn(kept.length, 2, "the delisted stock is dropped and the others are kept");
  ok(kept.some((l) => l.stock === NVDA), "an allowed stock stays");
  ok(!kept.some((l) => l.stock === QQQ), "a delisted one goes");
  ok(kept.some((l) => l.stock === PIVOT), "and the PIVOT is never looked up: it is always convertible");

  // Case-insensitively, because a node may answer either casing.
  eqn(convertibleLines(row, allowed, PIVOT.toUpperCase() as Address).length, 2,
    "the pivot matches whatever casing it arrives in");

  // The weights of the lines that survive are UNCHANGED: each target is
  // `cumulative * bps / BPS` on its own, so dropping a sibling does not
  // silently enlarge anybody.
  const d: Due = { holder: ANNA, cumulative: 10_000_000n, claimed: 0n, converted: {}, lines: kept };
  eq(sliceFor(d, kept[0]!), 4_000_000n, "a surviving line keeps its own share of the whole");

  // Every stock delisted: nothing is planned, rather than something refused.
  eqn(convertibleLines(row, new Set<string>(), NVDA).length, 1,
    "with nothing allowed, only a line naming the pivot survives");
}

console.log(`portfolio: ${checks} checks OK`);
