/**
 * portfolio.ts — the personal-portfolio mode's off-chain half.
 *
 * **The root is the distribution mode's, unchanged, and that is the whole
 * point of this design.** The vault funds ONE line — the pivot — so a holder's
 * cumulative is denominated in USDG and `plainAccrual` builds it with no rule
 * of its own. Nothing about eligibility, exclusions, the delivery floor, the
 * trees or the CID differs from the default mode, so nothing about them had to
 * be audited again. `buildroot.ts` maps this mode straight onto `plainAccrual`.
 *
 * What lives here is the PUSH PLANNER: which holders are converted into which
 * stock, in which batch. The holders' choices are on-chain
 * (`PortfolioBook.linesOf`), the conversion is one swap per batch
 * (`PortfolioDistributor.distributeInto`), and the keeper's job is to group them
 * so each swap is shared by as many holders as possible — the same mutualisation
 * `buyBasket` gives the default mode, just over a batch instead of a launch.
 *
 * **The keeper cannot choose what a holder is paid in.** It names the stock and
 * the batch; the WEIGHT comes from the book, read on-chain inside
 * `distributeInto`. So a wrong or hostile plan costs latency and gas, never a
 * holder's choice. That is why this file may plan freely.
 */
import { createPublicClient, http, type Address } from "viem";
import { RPC_URL } from "./config.js";
import { portfolioBookAbi } from "./abis.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

/** `PortfolioDistributor.MAX_BATCH`, and it is the Distributor's own. */
export const MAX_BATCH = 64;
export const BPS = 10_000n;

/**
 * **What converting ONE line costs, measured on the fork**, by
 * `test_ConversionGasPerLineIsWhatTheFloorIsPricedOn`:
 *
 *     batch of  4   563,818 gas   ->  140,954 per line
 *     batch of 16 1,540,007 gas   ->   96,250 per line
 *     batch of 64 6,412,635 gas   ->  100,197 per line
 *
 * The small batch is the dear one, and that is the whole shape of this mode:
 * the swap is paid once and shared, so four holders each carry a quarter of it
 * where sixty-four carry a sixty-fourth. 140,954 is therefore the number to
 * price against — the worst case, not the average.
 */
export const LINE_GAS = 140_954n;

/**
 * **A line is converted once it is worth this much, and not before.**
 *
 * `epoch.ts` guarantees a holder keeps at least 95 % of a delivery
 * (`PUSH_K_MIN = 20`), off a measured cost of $0.0402 for the 93,000 gas of a
 * default-mode settle. At that price 140,954 gas is $0.0609, so the smallest
 * line that still leaves 95 % is **$1.22**. $1.00 was the number this mode was
 * designed around and it is right for a full batch ($0.87) and 1.1 points short
 * for a batch of four; $1.50 covers the worst case measured, with room for gas
 * to rise a quarter before the guarantee is at stake.
 *
 * **A line under the floor is deferred, never lost.** The contract's target on
 * a stock is `cumulative * bps / BPS` minus what has been converted into it —
 * cumulative, so a 1 % line simply waits until the holder's share has grown a
 * hundredfold and converts in full then. A holder who does not want to wait has
 * `claim`, which pays the pivot and is always open.
 *
 * **In PIVOT units, because that is what a slice is denominated in**, and the
 * pivot is the dollar crossroads this whole platform routes through — USDG, six
 * decimals (`CLAUDE.md`, `docs/recon.md` §4.1). It is a parameter rather than a
 * constant, so a successor vault could pivot elsewhere; if one ever pivots off
 * a dollar this number needs a feed, and until then it does not.
 */
export const LINE_FLOOR_CENTS = 150n;

/** `LINE_FLOOR_CENTS` in the pivot's own units. */
export function lineFloor(pivotDecimals: number): bigint {
  return (LINE_FLOOR_CENTS * 10n ** BigInt(pivotDecimals)) / 100n;
}

/** One line of a holder's row. */
export interface Line {
  stock: Address;
  bps: number;
}

/**
 * A holder due some conversion, in the exact terms
 * `PortfolioDistributor._take` reads.
 *
 * **`cumulative` and `converted`, not "what is owed".** The contract's target
 * on a stock is `cumulative * bps / BPS` minus what has already been converted
 * into it — a function of the ROOT and the holder's row, never of the order the
 * batches happened to run in. A planner working from the REMAINING entitlement
 * would plan amounts the chain does not spend, and would do it silently. That
 * exact distinction was a bug in this mode, caught by
 * `test_ASilentHolderIsServedThroughTheCreatorsDefault` and fixed by
 * `convertedInto`; this shape is what keeps the two halves agreeing about it.
 */
export interface Due {
  holder: Address;
  /** The holder's leaf value in the active root, in pivot units. */
  cumulative: bigint;
  /** `claimedSoFar[holder][PIVOT]` — the whole of their entitlement already
   *  converted, across every stock. */
  claimed: bigint;
  /** `convertedInto[holder][stock]`, keyed by lowercased stock. */
  converted: Readonly<Record<string, bigint>>;
  lines: readonly Line[];
}

/** One `distributeInto` call: a stock, and the holders converted into it. */
export interface Batch {
  stock: Address;
  holders: Address[];
  /** What the swap will spend, in pivot units — the sum of each holder's
   *  slice, computed exactly as the contract computes it. */
  pivotIn: bigint;
}

/**
 * A holder's slice on one stock, in the contract's own arithmetic.
 *
 * Pure, and it has to be: this is the one place the planner and
 * `PortfolioDistributor._take` are made to agree, and disagreeing costs a call
 * that spends less than it planned or reverts for nothing.
 */
export function sliceFor(d: Due, line: Line): bigint {
  const target = (d.cumulative * BigInt(line.bps)) / BPS;
  const already = d.converted[line.stock.toLowerCase()] ?? 0n;
  if (target <= already) return 0n;
  let part = target - already;
  // Never more than what is left of their whole entitlement.
  const left = d.cumulative > d.claimed ? d.cumulative - d.claimed : 0n;
  if (part > left) part = left;
  return part;
}

/**
 * The lines a batch can actually be built from, right now.
 *
 * **`distributeInto` refuses a stock the registry no longer allows, and the
 * planner used to plan it anyway.** The call then failed its gas estimate every
 * interval, for ever: no transaction is broadcast and no gas is burned, but the
 * log fills with a refusal nobody reads and the holder's line simply never
 * converts, with nothing saying so. Delisting must not reach backwards
 * (`FLOWS.md` §7.5) — what it does is stop the conversion, and the holder keeps
 * the pivot entitlement, claimable in full at any time.
 *
 * **The PIVOT is always convertible** and is deliberately not looked up: it is
 * not a stock the platform picked, it is the currency this contract already
 * owes, and a line naming it is settled by transfer rather than by swap.
 */
export function convertibleLines(
  lines: readonly Line[],
  allowed: ReadonlySet<string>,
  pivot: Address,
): Line[] {
  const p = pivot.toLowerCase();
  return lines.filter((l) => {
    const k = l.stock.toLowerCase();
    return k === p || allowed.has(k);
  });
}

/**
 * Groups the holders due for delivery into one batch per stock, dropping the
 * lines that are not yet worth converting.
 *
 * **`floor` is per LINE, and it is where this mode's delivery economics live.**
 * Everywhere else the bar is the push tree's: an entry is in it or it is not,
 * and being in it means being paid. Here an entry is a pivot balance that gets
 * cut into one slice per stock the holder named, and the tree cannot price
 * those slices — it does not know the rows, and must not, because a row can
 * change between two rebuilds of the same root and a root has to rebuild to the
 * same answer forever. So the tree grants permission at a tenth of the usual
 * target (`buildroot.ts`, `PORTFOLIO_PUSH_TARGET_DIV`) and the real gate is
 * here, against `lineFloor`, on live state the planner is allowed to read.
 *
 * A dropped line is deferred, not lost: see `LINE_FLOOR_CENTS`.
 *
 * **Sorted by pivot value, descending, and split at `MAX_BATCH`.** The biggest
 * conversions go first because the swap's gas is shared; splitting rather than
 * truncating means a stock with more than 64 takers is served by consecutive
 * calls instead of quietly losing its tail.
 *
 * Deterministic — ties broken by address — so the keeper, a dry run and anybody
 * auditing the plan reach the same batches from the same state.
 *
 * Every amount comes from `sliceFor`, which is the contract's own arithmetic,
 * so `pivotIn` is what the swap will actually spend and not an estimate of it.
 */
export function planBatches(due: readonly Due[], floor = 0n, maxBatch = MAX_BATCH): Batch[] {
  const byStock = new Map<string, { holder: Address; part: bigint }[]>();
  for (const d of due) {
    for (const l of d.lines) {
      const part = sliceFor(d, l);
      if (part === 0n || part < floor) continue;
      const k = l.stock.toLowerCase();
      const rows = byStock.get(k);
      if (rows) rows.push({ holder: d.holder, part });
      else byStock.set(k, [{ holder: d.holder, part }]);
    }
  }

  const out: Batch[] = [];
  for (const [stock, rows] of [...byStock].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    rows.sort((a, b) =>
      a.part === b.part ? (a.holder.toLowerCase() < b.holder.toLowerCase() ? -1 : 1) : a.part > b.part ? -1 : 1,
    );
    for (let i = 0; i < rows.length; i += maxBatch) {
      const slice = rows.slice(i, i + maxBatch);
      out.push({
        stock: stock as Address,
        holders: slice.map((r) => r.holder),
        pivotIn: slice.reduce((a, r) => a + r.part, 0n),
      });
    }
  }
  return out;
}

/**
 * This launch's book, read off its Distributor.
 *
 * The Distributor is where it is stored (`setBook`, once, in the birth
 * transaction) and the Distributor is the address every caller here already
 * has — so this is one read and no registry walk.
 */
export async function bookOf(distributor: Address): Promise<Address> {
  return (await client.readContract({
    address: distributor,
    abi: portfolioBookAbi,
    functionName: "book",
  })) as Address;
}

/** What `holder` asked to be paid in: their own row, or the creator's default. */
export async function linesOf(book: Address, holder: Address): Promise<Line[]> {
  const rows = (await client.readContract({
    address: book,
    abi: portfolioBookAbi,
    functionName: "linesOf",
    args: [holder],
  })) as readonly { stock: Address; bps: number }[];
  return rows.map((r) => ({ stock: r.stock.toLowerCase() as Address, bps: Number(r.bps) }));
}
