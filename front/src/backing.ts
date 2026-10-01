/**
 * The BACKING mode's screen: burn your tokens, take your share of the pot.
 *
 * **There is no claim here and no root.** `BackingRedeemer` holds every stock
 * the vault ever bought; `redeem(amount, minOuts)` burns `amount` of the launch
 * token and sends back `amount / supply` of each leg. That is the only payment
 * path the mode has — nothing is ever pushed, nothing accrues per holder — so
 * this screen is not a convenience, it is the product.
 *
 * Three things it must get right, because a burn cannot be undone:
 *
 *  1. **`minOuts` is not optional.** Every leg is priced against the pot at the
 *     instant the transaction lands, and any other redemption — or a purchase —
 *     moves it. `redeem` checks the whole array BEFORE burning, so a refusal
 *     costs the holder nothing; a `minOuts` of zero would instead let a sandwich
 *     take the pot and leave the burn standing.
 *  2. **The supply it divides by is `totalSupply - balanceOf(0xdead)`**, which
 *     is what the contract does: a balance parked at the burn address can never
 *     redeem, and counting it would strand its share. The preview shown here is
 *     the contract's own (`redeemPreview`), so the two cannot drift — the local
 *     arithmetic exists only to explain the number, never to replace it.
 *  3. **A paused stock defers rather than disappears** (`docs/recon.md` §2.3).
 *     The tokens are already burnt by then, so the credit IS the entitlement:
 *     it is shown here as its own row with the `collectStock` retry beside it.
 */
import { createWalletClient, custom, formatUnits, parseAbi, parseUnits, type Address } from "viem";
import { EXPLORER, DEAD } from "./config.js";
import { pub, chain, erc20Abi, provider, ensureChain } from "./chain.js";
import { connected, viewer } from "./viewer.js";

/** Identical to `offchain/src/abis.ts`'s, minus the keeper's sweep: `abi.test.ts`
 *  holds both to the compiled contract. */
const redeemerAbi = parseAbi([
  "function allStocks() view returns (address[])",
  "function redeemPreview(uint256 amount) view returns (address[] stocks, uint256[] outs)",
  "function redeem(uint256 amount, uint256[] minOuts) returns (uint256)",
  "function collectStock(address stock) returns (uint256)",
  "function stockPending(address holder, address stock) view returns (uint256)",
  "function TOKEN() view returns (address)",
]);
const vaultAbi = parseAbi([
  "function DISTRIBUTOR() view returns (address)",
  "function token() view returns (address)",
]);
const approveAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// --------------------------------------------------------------- arithmetic

/**
 * The supply a redemption divides by — `BackingRedeemer.redeem`'s own.
 *
 * Kept as a named function rather than written inline twice: it is the single
 * number that decides what a holder gets, and the `0xdead` deduction is the
 * part a reader would not think to check.
 */
export const redeemableSupply = (totalSupply: bigint, deadBalance: bigint): bigint =>
  totalSupply > deadBalance ? totalSupply - deadBalance : 0n;

/** What `amount` takes of one leg, at the pot the preview was read against. */
export const shareOf = (pot: bigint, amount: bigint, supply: bigint): bigint =>
  supply === 0n ? 0n : (pot * amount) / supply;

/**
 * The floor under every leg, from the preview and the slippage the holder set.
 *
 * Rounded DOWN, and never below zero: a floor one wei above what the pool can
 * serve reverts the whole redemption with `BelowMinimum`, which is a free
 * refusal but also a holder who cannot get paid at all. A leg the preview puts
 * at zero keeps a floor of zero — it is a stock the pot has none of yet, and
 * demanding something of it would block every other leg.
 */
export function minOutsFor(outs: readonly bigint[], slippageBps: number): bigint[] {
  const keep = BigInt(Math.max(0, Math.min(10_000, Math.round(10_000 - slippageBps))));
  return outs.map((o) => (o * keep) / 10_000n);
}

// ------------------------------------------------------------------- screen

interface Leg {
  stock: Address;
  symbol: string;
  decimals: number;
  /** What the redeemer holds of it, less what it owes to deferred credits. */
  pot: bigint;
  /** What the amount in the field would take of it, from `redeemPreview`. */
  out: bigint;
  /** Owed to this visitor from a leg that was paused when they redeemed. */
  deferred: bigint;
}

interface Book {
  redeemer: Address;
  token: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
  supply: bigint;
  legs: Leg[];
}

/** The amount in the field, in token units. `null` while it is empty or junk —
 *  which is a state, not an error: the preview simply shows the pot. */
let amount: bigint | null = null;
let slippageBps = 100;
let book: Book | null = null;
let busy = false;

const $ = (id: string) => document.getElementById(id);
const say = (m: string) => { const n = $("bk-say"); if (n) n.textContent = m; };

const STYLE = `<style>
  .bk { display: flex; flex-direction: column; gap: .875rem; margin-top: 1.25rem; }
  .bk .box { background: var(--surface); border-radius: var(--r-lg); padding: 1.25rem 1.375rem; }
  .bk h2 { font: 600 1.0625rem/1.2 var(--sans); letter-spacing: -.02em; margin: 0 0 .35rem; }
  .bk .note { color: var(--mut); font-size: .875rem; margin: 0; text-wrap: pretty; }
  .bk table { width: 100%; border-collapse: collapse; margin-top: .875rem; }
  .bk th { font: 500 .6875rem var(--mono); letter-spacing: .09em; text-transform: uppercase;
    color: var(--dim); text-align: left; padding: .35rem .5rem; }
  .bk td { padding: .45rem .5rem; border-top: 1px solid var(--hair); font-size: .875rem; }
  .bk td.num, .bk th.num { text-align: right; font-family: var(--mono); }
  .bk .out { color: var(--ok); }
  .bk .field { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-top: 1rem; }
  .bk .field input { flex: 0 0 12rem; width: 12rem; font: 500 1.0625rem var(--mono);
    background: var(--bg); color: var(--fg); border: 0; border-radius: 6px; padding: .45rem .6rem; }
  .bk .field .u { font: .8125rem var(--mono); color: var(--mut); }
  .bk .field button.even { font: 500 .75rem var(--sans); padding: .35rem .6rem; border: 0;
    border-radius: 6px; background: var(--raised); color: var(--mut); cursor: pointer; }
  .bk .acts { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-top: 1rem; }
  .bk .warn { color: var(--bad); }
  .bk #bk-say { font-size: .8125rem; color: var(--mut); min-height: 1.2em; }
</style>`;

const SHELL = `${STYLE}<div class="bk">
  <div class="box">
    <h2>Burn to redeem</h2>
    <p class="note">This launch does not distribute: the fees buy stocks and they stay in the
    contract, backing the token. Burning your tokens takes their exact share of everything the
    contract holds — <b>and the burn is irreversible</b>. Nobody can do it for you, and there is
    nothing to wait for.</p>
    <table>
      <thead><tr><th>Stock</th><th class="num">In the contract</th><th class="num">You would get</th></tr></thead>
      <tbody id="bk-legs"><tr><td colspan="3" class="muted">Reading the chain…</td></tr></tbody>
    </table>
    <div class="field">
      <input id="bk-amt" inputmode="decimal" spellcheck="false" autocomplete="off" placeholder="0.0">
      <span class="u" id="bk-sym">—</span>
      <button type="button" class="even" id="bk-max">All of it</button>
      <span class="u">slippage</span>
      <input id="bk-slip" inputmode="decimal" style="flex:0 0 4.5rem;width:4.5rem" value="1">
      <span class="u">%</span>
    </div>
    <div class="acts">
      <button id="bk-approve" class="primary" disabled>Allow the burn</button>
      <button id="bk-redeem" class="primary" disabled>Burn and redeem</button>
      <span class="u" id="bk-hold"></span>
    </div>
    <p class="note" id="bk-say" style="margin-top:.6rem"></p>
  </div>
  <div class="box" id="bk-deferred" hidden>
    <h2>Waiting for you</h2>
    <p class="note">A leg that could not be transferred when you redeemed — a stock Robinhood had
    paused. It is credited to you and nothing about it expires: retry whenever the stock trades
    again.</p>
    <table><tbody id="bk-defer-rows"></tbody></table>
  </div>
</div>`;

/**
 * Reads the pot, the position and the preview, and paints.
 *
 * One entry point, called by `main.ts` on the same 60-second tick as every
 * other screen: the pot moves with every purchase and every other holder's
 * burn, so a stale preview is a `BelowMinimum` revert waiting to happen.
 */
export async function renderBacking(host: HTMLElement, vault: Address): Promise<void> {
  if (host.innerHTML === "") {
    host.innerHTML = SHELL;
    host.hidden = false;
    wire();
  }
  const [redeemer, token] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "DISTRIBUTOR" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "token" }),
  ]);
  const me = viewer;
  const stocks = await pub.readContract({ address: redeemer, abi: redeemerAbi, functionName: "allStocks" });

  const [symbol, decimals, balance, totalSupply, dead] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    me ? pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] }).catch(() => 0n)
      : Promise.resolve(0n),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [DEAD] }).catch(() => 0n),
  ]);
  const supply = redeemableSupply(totalSupply as bigint, dead as bigint);

  // The preview is the CONTRACT's, for the amount in the field — or for the
  // whole of what this visitor holds, so the table says something before
  // anybody types. Zero asks for nothing: `redeemPreview(0)` returns zeros.
  const asked = amount ?? (balance as bigint);
  const [, outs] = await pub.readContract({
    address: redeemer, abi: redeemerAbi, functionName: "redeemPreview", args: [asked],
  }) as readonly [readonly Address[], readonly bigint[]];

  const legs: Leg[] = await Promise.all((stocks as readonly Address[]).map(async (stock, i) => {
    const [sym, dec, pot, deferred] = await Promise.all([
      pub.readContract({ address: stock, abi: erc20Abi, functionName: "symbol" }).catch(() => stock.slice(0, 8)),
      pub.readContract({ address: stock, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
      pub.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [redeemer] }).catch(() => 0n),
      me
        ? pub.readContract({ address: redeemer, abi: redeemerAbi, functionName: "stockPending", args: [me, stock] })
          .catch(() => 0n)
        : Promise.resolve(0n),
    ]);
    return {
      stock, symbol: sym as string, decimals: Number(dec),
      pot: pot as bigint, out: outs[i] ?? 0n, deferred: deferred as bigint,
    };
  }));

  book = {
    redeemer, token, symbol: symbol as string, decimals: Number(decimals),
    balance: balance as bigint, supply, legs,
  };
  paint();
}

function qty(v: bigint, decimals: number): string {
  return Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function paint(): void {
  const b = book;
  if (!b) return;
  const rows = $("bk-legs");
  if (rows) {
    rows.innerHTML = b.legs.length === 0
      ? `<tr><td colspan="3" class="muted">This token has not bought anything yet — there is nothing
         to redeem, and burning now would give you nothing.</td></tr>`
      : b.legs.map((l) => `<tr>
          <td>${esc(l.symbol)}</td>
          <td class="num">${qty(l.pot, l.decimals)}</td>
          <td class="num out">${l.out > 0n ? qty(l.out, l.decimals) : "—"}</td>
        </tr>`).join("");
  }
  const sym = $("bk-sym");
  if (sym) sym.textContent = b.symbol;
  const hold = $("bk-hold");
  if (hold) {
    hold.textContent = !viewer
      ? "connect a wallet, or paste an address, to see your share"
      : `you hold ${qty(b.balance, b.decimals)} ${b.symbol}`;
  }

  // Both buttons need a wallet that can SIGN: a pasted address can be read,
  // never burnt from. Said once, here, rather than discovered at the prompt.
  const asked = amount ?? 0n;
  const ok = connected && asked > 0n && asked <= b.balance && b.legs.some((l) => l.out > 0n);
  const redeem = $("bk-redeem") as HTMLButtonElement | null;
  const approve = $("bk-approve") as HTMLButtonElement | null;
  if (redeem) redeem.disabled = busy || !ok;
  if (approve) approve.disabled = busy || !connected || asked === 0n;
  if (asked > b.balance) say(`you hold ${qty(b.balance, b.decimals)} ${b.symbol} — that is less than the amount asked`);

  const deferred = b.legs.filter((l) => l.deferred > 0n);
  const panel = $("bk-deferred");
  const drows = $("bk-defer-rows");
  if (panel && drows) {
    panel.hidden = deferred.length === 0;
    drows.innerHTML = deferred.map((l) => `<tr>
      <td>${esc(l.symbol)}</td>
      <td class="num">${qty(l.deferred, l.decimals)}</td>
      <td class="num"><button class="even" data-collect="${l.stock}">Collect</button></td>
    </tr>`).join("");
  }
}

function wire(): void {
  const amt = $("bk-amt") as HTMLInputElement | null;
  amt?.addEventListener("input", () => {
    amount = parseAmount(amt.value, book?.decimals ?? 18);
    paint();
  });
  $("bk-max")?.addEventListener("click", () => {
    if (!book || !amt) return;
    amt.value = formatUnits(book.balance, book.decimals);
    amount = book.balance;
    paint();
  });
  const slip = $("bk-slip") as HTMLInputElement | null;
  slip?.addEventListener("input", () => {
    const v = Number(slip.value.replace(",", "."));
    // A slippage that is not a number leaves the last good one in place rather
    // than silently becoming zero, which would be the tightest possible floor.
    if (Number.isFinite(v) && v >= 0 && v <= 50) slippageBps = Math.round(v * 100);
  });
  $("bk-approve")?.addEventListener("click", () => void doApprove());
  $("bk-redeem")?.addEventListener("click", () => void doRedeem());
  // Delegated: the deferred rows are repainted wholesale on every refresh.
  $("bk-defer-rows")?.addEventListener("click", (ev) => {
    const at = (ev.target as HTMLElement).closest("[data-collect]");
    if (at) void doCollect(at.getAttribute("data-collect") as Address);
  });
}

/** Decimal text → token units, `null` on anything that is not a number. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  try {
    const v = parseUnits(t, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

async function wallet() {
  const eth = provider();
  if (!eth) { say("connect a wallet first — the Connect button, top right"); return null; }
  if (!(await ensureChain(eth, say))) return null;
  const me = viewer;
  if (!me || !connected) { say("connect that wallet — a pasted address can be read, not signed for"); return null; }
  return { client: createWalletClient({ account: me, chain, transport: custom(eth) }), me };
}

async function doApprove(): Promise<void> {
  const b = book;
  const w = await wallet();
  if (!b || !w || busy) return;
  const asked = amount ?? 0n;
  busy = true; paint();
  try {
    say("approving…");
    const hash = await w.client.writeContract({
      address: b.token, abi: approveAbi, functionName: "approve", args: [b.redeemer, asked],
      account: w.me, chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    say("approved — burn and redeem when ready");
  } catch (e) {
    say("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 120));
  } finally {
    busy = false; paint();
  }
}

async function doRedeem(): Promise<void> {
  const b = book;
  const w = await wallet();
  if (!b || !w || busy) return;
  const asked = amount ?? 0n;
  if (asked === 0n || asked > b.balance) return;
  busy = true; paint();
  try {
    // The allowance is checked HERE and not only at the button's state: an
    // approval given for a smaller amount is the likeliest way this reverts,
    // and `burnFrom` reverting costs the holder gas for nothing.
    const allowed = await pub.readContract({
      address: b.token, abi: approveAbi, functionName: "allowance", args: [w.me, b.redeemer],
    }) as bigint;
    if (allowed < asked) { say("allow the burn first — the contract may only burn what you let it"); return; }

    // Priced again, at the head, rather than from what the table was painted
    // with: between the two, somebody else's burn moves every leg.
    const [, outs] = await pub.readContract({
      address: b.redeemer, abi: redeemerAbi, functionName: "redeemPreview", args: [asked],
    }) as readonly [readonly Address[], readonly bigint[]];
    const floors = minOutsFor(outs, slippageBps);

    say("burning…");
    const hash = await w.client.writeContract({
      address: b.redeemer, abi: redeemerAbi, functionName: "redeem", args: [asked, floors],
      account: w.me, chain,
    });
    say(`sent: ${hash.slice(0, 10)}…`);
    await pub.waitForTransactionReceipt({ hash });
    say(`redeemed. ${EXPLORER}/tx/${hash}`);
    amount = null;
  } catch (e) {
    say("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 140));
  } finally {
    busy = false; paint();
  }
}

async function doCollect(stock: Address): Promise<void> {
  const b = book;
  const w = await wallet();
  if (!b || !w || busy) return;
  busy = true; paint();
  try {
    say("collecting the deferred leg…");
    const hash = await w.client.writeContract({
      address: b.redeemer, abi: redeemerAbi, functionName: "collectStock", args: [stock],
      account: w.me, chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    say(`collected. ${EXPLORER}/tx/${hash}`);
  } catch (e) {
    say("still refused — the stock is probably paused: " + String((e as Error).message).split("\n")[0]!.slice(0, 100));
  } finally {
    busy = false; paint();
  }
}
