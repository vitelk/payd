/**
 * The tontine rule, with no chain in sight.
 *
 * The mode adds no contract, so this file is where its correctness lives. Four
 * properties, and the first two are the ones a holder would ask about:
 *
 *   1. **Nobody who holds is worse off.** A window where nobody sold produces
 *      exactly the distribution mode's totals, to the wei.
 *   2. **Nothing already delivered is ever clawed back.** The forfeit is taken
 *      out of the UNDELIVERED part, so a cumulative never falls under what its
 *      holder was paid — the leaf the contract would refuse to honour anyway.
 *   3. **Conservation.** What leaves the sellers arrives at the stayers, minus
 *      integer-division dust that stays unallocated. `Σ cumulative` never grows
 *      beyond what the windows funded, which is what keeps the on-chain clamp
 *      out of the way.
 *   4. **Determinism.** The order holders arrive in changes nothing: the keeper,
 *      the co-signer and `dispute.ts` all read the same chain in different
 *      orders and must publish the same root.
 */
import { plainAccrual, type Delivery, type WindowShares } from "./epoch.js";
import { extremeBalances } from "./snapshot.js";
import { key, type Entry } from "./merkle.js";
import { forfeitOf, tontineAccrual } from "./tontine.js";
import type { Address } from "viem";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const QQQ = "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68" as Address;
const SELLER = "0x1111111111111111111111111111111111111111" as Address;
const STAYER = "0x2222222222222222222222222222222222222222" as Address;
const WHALE = "0x3333333333333333333333333333333333333333" as Address;

let checks = 0;
function eq(a: bigint, b: bigint, what: string) {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
}
function ok(c: boolean, what: string) {
  if (!c) throw new Error(what);
  checks++;
}

/** A window that bought `amounts` of `stocks` and weighs holders as given. */
function window_(
  weights: Record<string, bigint>,
  decreases: Record<string, { open: bigint; min: bigint }>,
  stocks: Address[] = [NVDA],
  amounts: bigint[] = [1_000n],
): WindowShares {
  const supply = Object.values(weights).reduce((a, b) => a + b, 0n);
  return {
    fromEpoch: 0, toEpoch: 0, stocks, amounts: amounts.map(String), quoteSpent: "1",
    periodStart: 0, periodEnd: 1800, transferBlocks: 0, lastBlock: 100,
    eligibleSupply: supply.toString(), minBalance: "0",
    weights: Object.fromEntries(Object.entries(weights).map(([h, w]) => [h, w.toString()])) as Record<Address, string>,
    decreases: Object.fromEntries(
      Object.entries(decreases).map(([h, d]) => [h, { open: d.open.toString(), min: d.min.toString() }]),
    ) as WindowShares["decreases"],
  };
}

function totalsOf(rows: [Address, Address, bigint][]): Map<string, Entry> {
  const m = new Map<string, Entry>();
  for (const [holder, stock, cumulative] of rows) m.set(key(holder, stock), { holder, stock, cumulative });
  return m;
}

const sum = (t: Map<string, Entry>) => [...t.values()].reduce((a, e) => a + e.cumulative, 0n);
const at = (t: Map<string, Entry>, h: Address, s: Address) => t.get(key(h, s))?.cumulative ?? 0n;

// ---------------------------------------------------------------- forfeitOf

eq(forfeitOf(100n, 1_000n, 500n), 50n, "half the balance sold forfeits half the undelivered share");
eq(forfeitOf(100n, 1_000n, 1_000n), 0n, "a holder who never dipped forfeits nothing");
eq(forfeitOf(100n, 1_000n, 0n), 100n, "selling everything forfeits everything undelivered");
eq(forfeitOf(1_000_000n, 1_000_000_000n, 999_999_999n), 0n, "one wei off a billion is no cliff");
eq(forfeitOf(0n, 1_000n, 0n), 0n, "nothing undelivered, nothing to forfeit");
eq(forfeitOf(100n, 0n, 0n), 0n, "a holder who opened at zero cannot decrease");
eq(forfeitOf(100n, 1_000n, 1_500n), 0n, "buying more is not a decrease");

// ------------------------------------------------------------ extremeBalances

{
  const opening = new Map<Address, bigint>([[SELLER, 1_000n], [STAYER, 1_000n], [WHALE, 0n]]);
  const out = extremeBalances(opening, [
    // The seller sells 400 and buys 400 back: closes flat, still let go.
    { from: SELLER, to: WHALE, value: 400n },
    { from: WHALE, to: SELLER, value: 400n },
  ]);
  ok(out.has(SELLER), "a sell-and-rebuy inside the window is caught");
  eq(out.get(SELLER)!.open, 1_000n, "open is the balance at the period's start");
  eq(out.get(SELLER)!.min, 600n, "min is the low, not the close");
  ok(!out.has(STAYER), "a holder who did nothing is not in the map");
  ok(!out.has(WHALE), "and neither is one who only received");
}

// ---------------------------------------------------- 1. nobody sold: parity

{
  const rows: [Address, Address, bigint][] = [[SELLER, NVDA, 500n], [STAYER, NVDA, 500n]];
  const w = window_({ [SELLER]: 1n, [STAYER]: 1n }, {});
  const plain = totalsOf(rows);
  const tontine = totalsOf(rows);
  plainAccrual(plain, w, []);
  tontineAccrual(tontine, w, []);
  for (const [k, e] of plain) eq(tontine.get(k)!.cumulative, e.cumulative, `no seller: ${k} is unchanged`);
  eq(sum(tontine), 2_000n, "and the window's 1,000 was accrued exactly once");
}

// -------------------------------------- 2/3. the seller pays the stayer

{
  // Both are owed 400 from earlier windows, nothing delivered. The seller
  // halves their balance during the window; this window buys 1,000 more.
  const totals = totalsOf([[SELLER, NVDA, 400n], [STAYER, NVDA, 400n]]);
  const before = sum(totals);
  const w = window_({ [SELLER]: 1n, [STAYER]: 1n }, { [SELLER]: { open: 1_000n, min: 500n } });
  tontineAccrual(totals, w, []);

  // Forfeit 200 of the seller's 400; accrue 500 each; split the 200 pool by
  // this window's weights, which are equal.
  eq(at(totals, SELLER, NVDA), 400n - 200n + 500n + 100n, "the seller keeps what they did not forfeit");
  eq(at(totals, STAYER, NVDA), 400n + 500n + 100n, "and the stayer is paid the rest of it");
  eq(sum(totals), before + 1_000n, "conservation: the pool moved, it did not grow");
}

{
  // The forfeiter still takes part, by their REDUCED weight: 1/5 here.
  const totals = totalsOf([[SELLER, NVDA, 1_000n]]);
  const w = window_({ [SELLER]: 1n, [STAYER]: 4n }, { [SELLER]: { open: 100n, min: 0n } }, [NVDA], [0n]);
  tontineAccrual(totals, w, []);
  eq(at(totals, SELLER, NVDA), 200n, "a full exit still earns its slice of its own forfeiture");
  eq(at(totals, STAYER, NVDA), 800n, "the stayers take the rest");
  eq(sum(totals), 1_000n, "nothing created, nothing destroyed");
}

// ------------------------------------ 2. what was delivered is untouchable

{
  // 400 owed, 400 already delivered before this window closed: nothing left to
  // forfeit, whatever they sold.
  const delivered: Delivery[] = [{ block: 50, holder: SELLER, stock: NVDA, amount: 400n }];
  const totals = totalsOf([[SELLER, NVDA, 400n], [STAYER, NVDA, 400n]]);
  const w = window_({ [SELLER]: 1n, [STAYER]: 1n }, { [SELLER]: { open: 1_000n, min: 0n } });
  tontineAccrual(totals, w, delivered);
  eq(at(totals, SELLER, NVDA), 400n + 500n, "a settled holder forfeits nothing: the claim escape, priced");
  eq(at(totals, STAYER, NVDA), 400n + 500n, "so there is nothing to redistribute either");
}

{
  // A delivery that lands AFTER the window's last block does not protect what
  // was outstanding while the window ran.
  const late: Delivery[] = [{ block: 101, holder: SELLER, stock: NVDA, amount: 400n }];
  const totals = totalsOf([[SELLER, NVDA, 400n], [STAYER, NVDA, 400n]]);
  const w = window_({ [SELLER]: 1n, [STAYER]: 1n }, { [SELLER]: { open: 1_000n, min: 0n } }, [NVDA], [0n]);
  tontineAccrual(totals, w, late);
  eq(at(totals, SELLER, NVDA), 200n, "the window is judged at its own boundary, not at the head");
  ok(at(totals, SELLER, NVDA) < 400n, "which is a cumulative BELOW what was later delivered");
}

// -------------------------------------------- the multi-leg case, unchanged

{
  const totals = totalsOf([[SELLER, NVDA, 100n], [SELLER, QQQ, 100n], [STAYER, NVDA, 0n]]);
  const w = window_({ [STAYER]: 1n }, { [SELLER]: { open: 10n, min: 0n } }, [NVDA, QQQ], [0n, 0n]);
  tontineAccrual(totals, w, []);
  eq(at(totals, SELLER, NVDA), 0n, "every leg is forfeited");
  eq(at(totals, SELLER, QQQ), 0n, "including one this window did not buy");
  eq(at(totals, STAYER, NVDA), 100n, "and each lands on the stayers IN ITS OWN LEG");
  eq(at(totals, STAYER, QQQ), 100n, "never pooled across legs, which would pay in the wrong stock");
}

// ------------------------------------------------- 4. order changes nothing

{
  const rows: [Address, Address, bigint][] = [
    [SELLER, NVDA, 777n], [STAYER, NVDA, 333n], [WHALE, NVDA, 121n],
  ];
  const w = (order: string[]) => {
    const weights: Record<string, bigint> = {};
    for (const h of order) weights[h] = h === WHALE ? 7n : 3n;
    return window_(weights, { [SELLER]: { open: 999n, min: 111n } });
  };
  const a = totalsOf(rows);
  const b = totalsOf([...rows].reverse());
  tontineAccrual(a, w([SELLER, STAYER, WHALE]), []);
  tontineAccrual(b, w([WHALE, STAYER, SELLER]), []);
  for (const [k, e] of a) eq(b.get(k)!.cumulative, e.cumulative, `shuffled: ${k} is identical`);
  ok(sum(a) <= 777n + 333n + 121n + 1_000n, "and the dust of a two-step division is never created");
}

// --------------------------------------------- a stale cache is not silent

{
  const w = window_({ [STAYER]: 1n }, {});
  delete (w as { decreases?: unknown }).decreases;
  let threw = false;
  try {
    tontineAccrual(totalsOf([[STAYER, NVDA, 1n]]), w, []);
  } catch (e) {
    threw = (e as Error).message.includes("decreases");
  }
  ok(threw, "a window cached without `decreases` refuses to build rather than forfeiting nothing");
}

console.log(`tontine: ${checks} checks OK`);
