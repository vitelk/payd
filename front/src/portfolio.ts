/**
 * portfolio.ts — the row a holder writes, and the only screen in this app that
 * exists to WRITE rather than to read.
 *
 * **The row is the mode.** Under `portfolio` the vault converts the holders'
 * share into the pivot and stops; what each holder ends up holding is whatever
 * they named in that launch's `PortfolioBook`, converted in the delivery
 * itself, one swap per batch of holders who wanted the same stock. A holder who
 * names nothing is paid the creator's default basket — which is every holder on
 * day one, so the default is the mode's normal behaviour and not its fallback.
 *
 * **Nothing here can pay anybody, and that is worth saying because it is what
 * makes the screen safe.** `setPortfolio` writes one mapping under
 * `msg.sender`, reads no balance, and moves no value; the book holds no money
 * and has no privileged function. The worst a mistake here can do is have a
 * holder paid in a stock they did not mean to name, and `clearPortfolio` undoes
 * it.
 *
 * The rules below mirror `PortfolioBook._write`. Duplicated on purpose and
 * named after the constants they copy: the contract is the authority, this only
 * spares a holder a reverted transaction. `portfolio.test.ts` pins them.
 */
import { createWalletClient, custom, type Address } from "viem";
import { parseAbi } from "viem";
import { pub, chain, erc20Abi, provider, ensureChain } from "./chain.js";
import { connected, viewer } from "./viewer.js";
import { pct, bpsFromPct, spread } from "./basket.js";

/** `PortfolioBook.MAX_LINES`. A sanity bound on the loops that walk a row, not
 *  an economic one: what stops a holder naming a stock too small to be worth
 *  converting is the per-line delivery floor, off-chain. */
export const MAX_LINES = 64;
/** `PortfolioBook.MIN_LINE_BPS` — one per cent. It was five, which with a row
 *  summing to exactly `BPS` capped a holder at twenty stocks. */
export const MIN_LINE_BPS = 100;
export const BPS = 10_000;

export interface Line { stock: Address; bps: number }

/**
 * Is this row one the book will accept?
 *
 * Every clause is `_write`'s, in its order, so the message a holder reads here
 * is the revert they would otherwise have paid for. A rejection is returned
 * rather than thrown: this runs on every keystroke and the message belongs
 * next to the field.
 */
export function validateRow(lines: readonly Line[]): { ok: boolean; error?: string } {
  if (lines.length === 0) return { ok: false, error: "name at least one stock, or clear your choice entirely" };
  if (lines.length > MAX_LINES) return { ok: false, error: `at most ${MAX_LINES} stocks in one row` };

  const seen = new Set<string>();
  let sum = 0;
  for (const l of lines) {
    if (!l.stock || /^0x0+$/.test(l.stock)) return { ok: false, error: "a line names no stock" };
    const k = l.stock.toLowerCase();
    if (seen.has(k)) return { ok: false, error: "the same stock twice — give it one weight, not two" };
    seen.add(k);
    if (!Number.isInteger(l.bps) || l.bps < MIN_LINE_BPS) {
      return { ok: false, error: `every stock takes at least ${pct(MIN_LINE_BPS)} of your share` };
    }
    sum += l.bps;
  }
  // Exactly, not at most: a row always says what to do with the WHOLE of a
  // holder's share and never leaves a remainder nobody decided about.
  if (sum !== BPS) {
    return {
      ok: false,
      error: sum < BPS
        ? `${pct(BPS - sum)} of your share is unassigned`
        : `you have assigned ${pct(sum)} — ${pct(sum - BPS)} too much`,
    };
  }
  return { ok: true };
}

/** Even weights over `n` stocks, summing to exactly `BPS` — `basket.ts`'s own
 *  spread, so "split it evenly" lands on a row the book accepts. */
export const evenRow = (stocks: readonly Address[]): Line[] =>
  spread(stocks.length).map((bps, i) => ({ stock: stocks[i]!, bps }));

export const bookAbi = parseAbi([
  "function pivot() view returns (address)",
  "function linesOf(address) view returns ((address stock,uint16 bps)[])",
  "function defaultBasket() view returns ((address stock,uint16 bps)[])",
  "function setPortfolio((address stock,uint16 bps)[] lines)",
  "function clearPortfolio()",
  "function MAX_LINES() view returns (uint256)",
  "function MIN_LINE_BPS() view returns (uint256)",
]);

/** One call, and it is the reason the book is reached from the DISTRIBUTOR and
 *  not from the factory: the distributor is the address the launch page already
 *  holds, and `setBook` wrote this in the birth transaction and can never write
 *  it again. */
export const distAbi = parseAbi(["function book() view returns (address)"]);

/** Whose row is on screen, and whether it is theirs or the creator's default.
 *
 *  `linesOf` answers the holder's own row, or the default when they have
 *  written none — the contract makes no distinction, so the screen asks for
 *  both and compares. That is the difference between "you chose this" and "this
 *  is what you get until you choose", and a holder cannot read their own screen
 *  without it. */
export interface RowState {
  book: Address;
  /** The vault's settlement currency. A line naming it means "pay me in
   *  dollars" — the Distributor delivers it by transfer instead of swapping. */
  pivot: Address;
  mine: Line[];
  fallback: Line[];
  /** True when `mine` is the creator's default rather than the holder's choice. */
  isDefault: boolean;
}

export function isDefaultRow(mine: readonly Line[], fallback: readonly Line[]): boolean {
  if (mine.length !== fallback.length) return false;
  return mine.every((l, i) =>
    l.stock.toLowerCase() === fallback[i]!.stock.toLowerCase() && l.bps === fallback[i]!.bps);
}

/** Reads the book, the holder's row and the creator's default in one pass. */
export async function readRow(distributor: Address, holder: Address | null): Promise<RowState> {
  const book = await pub.readContract({
    address: distributor, abi: distAbi, functionName: "book",
  }) as Address;

  const [pivot, fallback, mine] = await Promise.all([
    pub.readContract({ address: book, abi: bookAbi, functionName: "pivot" }) as Promise<Address>,
    pub.readContract({ address: book, abi: bookAbi, functionName: "defaultBasket" })
      .catch(() => [] as readonly Line[]),
    holder
      ? pub.readContract({ address: book, abi: bookAbi, functionName: "linesOf", args: [holder] })
        .catch(() => [] as readonly Line[])
      : Promise.resolve([] as readonly Line[]),
  ]);

  const f = (fallback as readonly Line[]).map((l) => ({ stock: l.stock, bps: Number(l.bps) }));
  const m = (mine as readonly Line[]).map((l) => ({ stock: l.stock, bps: Number(l.bps) }));
  return { book, pivot, mine: m, fallback: f, isDefault: isDefaultRow(m, f) };
}

/**
 * A wallet that can sign, or the reason it cannot.
 *
 * `backing.ts`'s check verbatim, including the one that is easy to miss: a
 * PASTED address can be read all over this app and cannot be signed for, so
 * `connected` is checked and not only `viewer`. `ensureChain` takes the
 * reporter because switching networks is a conversation with the wallet, and
 * its steps belong on screen rather than in a console.
 */
async function wallet(
  say: (s: string) => void,
): Promise<{ client: ReturnType<typeof createWalletClient>; me: Address } | null> {
  const eth = await provider();
  if (!eth) { say("connect a wallet first — the Connect button, top right"); return null; }
  const me = viewer;
  if (!me || !connected) { say("connect that wallet — a pasted address can be read, not signed for"); return null; }
  if (!(await ensureChain(eth, say))) return null;
  return { client: createWalletClient({ account: me, chain, transport: custom(eth) }), me };
}

/** Writes the caller's row. Returns the transaction hash, or throws with what
 *  the wallet said — the caller puts it next to the button. */
export async function submitRow(
  book: Address,
  lines: readonly Line[],
  say: (s: string) => void,
): Promise<`0x${string}`> {
  const v = validateRow(lines);
  if (!v.ok) throw new Error(v.error);
  const w = await wallet(say);
  if (!w) throw new Error("no wallet that can sign");
  return w.client.writeContract({
    address: book, abi: bookAbi, functionName: "setPortfolio",
    args: [lines.map((l) => ({ stock: l.stock, bps: l.bps }))],
    account: w.me, chain,
  });
}

/** Goes back to the creator's default. */
export async function clearRow(book: Address, say: (s: string) => void): Promise<`0x${string}`> {
  const w = await wallet(say);
  if (!w) throw new Error("no wallet that can sign");
  return w.client.writeContract({
    address: book, abi: bookAbi, functionName: "clearPortfolio", account: w.me, chain,
  });
}

/** A stock's ticker, for the row's labels. Falls back to a short address:
 *  a line the reader cannot name is worse than an ugly one. */
export async function tickerOf(stock: Address): Promise<string> {
  try {
    return await pub.readContract({ address: stock, abi: erc20Abi, functionName: "symbol" }) as string;
  } catch {
    return `${stock.slice(0, 6)}…${stock.slice(-4)}`;
  }
}

export { pct, bpsFromPct };

// ----------------------------------------------------------------- the screen

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
const $ = (id: string) => document.getElementById(id);
const say = (m: string) => { const n = $("pf-say"); if (n) n.textContent = m; };

const SHELL = `
<div class="card" style="margin-top:1.25rem">
  <div class="k">What you are paid in</div>
  <p class="note" id="pf-state">Reading your row…</p>
  <table class="tbl" style="margin-top:.75rem">
    <thead><tr><th>Stock</th><th class="num">Share</th><th></th></tr></thead>
    <tbody id="pf-rows"></tbody>
    <tfoot><tr><th>Total</th><th class="num" id="pf-total">—</th><th></th></tr></tfoot>
  </table>
  <div class="row" style="margin-top:.75rem;gap:.5rem;flex-wrap:wrap">
    <select id="pf-add"><option value="">add a stock…</option></select>
    <button id="pf-even" type="button" class="ghost">split evenly</button>
  </div>
  <div class="row" style="margin-top:.75rem;gap:.5rem;flex-wrap:wrap">
    <button id="pf-save" type="button">Save my choice</button>
    <button id="pf-clear" type="button" class="ghost">Use the creator's basket</button>
  </div>
  <p class="note" id="pf-say"></p>
  <p class="note">Nothing here moves money. It records what your share is converted
     into when it is delivered, and you can change it whenever you like — or take the
     dollars directly with Claim, which never needs this row at all.</p>
</div>`;

/** What the screen holds between paints: the row being EDITED, which is not
 *  what the chain says until Save lands. Kept here rather than read back from
 *  the inputs so a redraw cannot lose a half-made edit. */
let draft: Line[] = [];
let state: RowState | null = null;
let universe: { stock: Address; symbol: string }[] = [];
let wired = false;

function total(): number {
  return draft.reduce((a, l) => a + l.bps, 0);
}

function paint(): void {
  const rows = $("pf-rows");
  if (!rows || !state) return;

  rows.innerHTML = draft.length === 0
    ? `<tr><td colspan="3" class="muted">No stocks named. Add one, or keep the
       creator's basket.</td></tr>`
    : draft.map((l, i) => {
      const sym = universe.find((u) => u.stock.toLowerCase() === l.stock.toLowerCase())?.symbol
        ?? `${l.stock.slice(0, 6)}…${l.stock.slice(-4)}`;
      return `<tr>
        <td>${esc(sym)}</td>
        <td class="num"><input id="pf-bps-${i}" type="number" inputmode="decimal"
            min="${MIN_LINE_BPS / 100}" max="100" step="0.01" value="${l.bps / 100}"
            style="width:5.5rem;text-align:right"> %</td>
        <td class="num"><button type="button" class="ghost" id="pf-del-${i}"
            aria-label="remove ${esc(sym)}">remove</button></td>
      </tr>`;
    }).join("");

  const t = $("pf-total");
  if (t) {
    t.textContent = pct(total());
    t.className = total() === BPS ? "num" : "num warn";
  }

  // Each row's two controls, bound after the HTML exists. Re-bound on every
  // paint because the rows themselves are rewritten — cheaper and less
  // error-prone than diffing a list this short.
  draft.forEach((_, i) => {
    const f = $(`pf-bps-${i}`) as HTMLInputElement | null;
    if (f) {
      f.oninput = () => {
        const v = bpsFromPct(Number(f.value));
        draft = draft.map((l, j) => (j === i ? { ...l, bps: Number.isFinite(v) ? v : 0 } : l));
        const tt = $("pf-total");
        if (tt) { tt.textContent = pct(total()); tt.className = total() === BPS ? "num" : "num warn"; }
        const v2 = validateRow(draft);
        say(v2.ok ? "" : v2.error!);
      };
    }
    const d = $(`pf-del-${i}`);
    if (d) d.onclick = () => { draft = draft.filter((_l, j) => j !== i); paint(); };
  });

  const add = $("pf-add") as HTMLSelectElement | null;
  if (add) {
    const taken = new Set(draft.map((l) => l.stock.toLowerCase()));
    add.innerHTML = `<option value="">add a stock…</option>`
      + universe.filter((u) => !taken.has(u.stock.toLowerCase()))
        .map((u) => `<option value="${esc(u.stock)}">${esc(u.symbol)}</option>`).join("");
    add.disabled = draft.length >= MAX_LINES;
  }

  const st = $("pf-state");
  if (st) {
    st.textContent = !viewer
      ? "Connect a wallet, or paste an address, to see and set your row."
      : state.isDefault
        ? state.fallback.length === 0
          ? "You have named nothing and this launch set no default basket, so your share stays in dollars. Name a stock below to change that."
          : "You are paid the creator's basket, because you have not chosen yet. Anything you save below replaces it, for you only."
        : "This is your own choice. It applies to every delivery from now on.";
  }
}

function wire(): void {
  if (wired) return;
  wired = true;

  const add = $("pf-add") as HTMLSelectElement | null;
  if (add) {
    add.onchange = () => {
      const stock = add.value as Address;
      if (!stock) return;
      // A new line arrives at whatever is unassigned, or at the floor — never
      // at zero, which `validateRow` would refuse and which reads as a bug.
      const left = BPS - total();
      draft = [...draft, { stock, bps: left >= MIN_LINE_BPS ? left : MIN_LINE_BPS }];
      add.value = "";
      paint();
      say("");
    };
  }

  const even = $("pf-even");
  if (even) {
    even.onclick = () => {
      if (draft.length === 0) return;
      draft = evenRow(draft.map((l) => l.stock));
      paint();
      say("");
    };
  }

  const save = $("pf-save");
  if (save) {
    save.onclick = () => {
      if (!state) return;
      const v = validateRow(draft);
      if (!v.ok) { say(v.error!); return; }
      say("confirm in your wallet…");
      void submitRow(state.book, draft, say)
        .then((hash) => {
          say(`sent — ${hash.slice(0, 10)}…  your next delivery uses this row`);
        })
        .catch((e: unknown) => say((e as Error).message || "the wallet refused"));
    };
  }

  const clear = $("pf-clear");
  if (clear) {
    clear.onclick = () => {
      if (!state) return;
      say("confirm in your wallet…");
      void clearRow(state.book, say)
        .then((hash) => say(`sent — ${hash.slice(0, 10)}…  back to the creator's basket`))
        .catch((e: unknown) => say((e as Error).message || "the wallet refused"));
    };
  }
}

/**
 * The row panel, drawn beside the claim table and never instead of it.
 *
 * @param host      `#mode-panel` — the same section the non-claim modes fill.
 *                  This mode uses BOTH halves of the launch page, which is why
 *                  it is drawn from `refresh()` and not from `refreshMode()`.
 * @param distributor this launch's `PortfolioDistributor`; the book is read off
 *                  it, because that is the address the caller already has.
 * @param stocks    the platform's allowlist, already folded and named by
 *                  `create.ts`'s `allowlist()`. Passed in rather than fetched
 *                  here: it is one log walk for the whole app and it is cached.
 */
export async function renderPortfolio(
  host: HTMLElement,
  distributor: Address,
  stocks: readonly { stock: Address; symbol: string }[],
): Promise<void> {
  if (host.innerHTML === "") {
    host.innerHTML = SHELL;
    host.hidden = false;
    wire();
  }
  const next = await readRow(distributor, viewer);
  // **Dollars first in the picker, and it is not in the allowlist.** The pivot
  // is not a stock the platform picked — it is the currency the vault already
  // owes — so `allowlist()` does not carry it and a holder would have no way to
  // ask for it. Named rather than tickered: "USDG" means nothing to somebody
  // deciding whether they want equities this month.
  universe = [{ stock: next.pivot, symbol: "Dollars (USDG)" }, ...stocks.filter(
    (u) => u.stock.toLowerCase() !== next.pivot.toLowerCase(),
  )];

  // **A refresh must not overwrite a half-made edit.** The 60-second tick lands
  // while somebody is typing a weight, and a paint from the chain would put
  // their row back to what it was before they started. The draft is seeded from
  // the chain ONCE per row identity and left alone after that.
  const sameRow = state
    && state.book.toLowerCase() === next.book.toLowerCase()
    && isDefaultRow(state.mine, next.mine);
  state = next;
  if (!sameRow) draft = next.mine.map((l) => ({ ...l }));
  paint();
}
