/**
 * The launch form: `createVault`, from the browser.
 *
 * A section of the registry index rather than a page of its own — same reason
 * as everything else here, one HTML entry point keeps the build to one JS file
 * and one CID to pin.
 *
 * **This is step one of three, and the form says so.** Creating a vault
 * launches nothing: the creator then launches on Pons themselves with this
 * vault as `creatorFeeRecipient`, and anybody calls `bind` afterwards. A form
 * that implied otherwise would leave people waiting for fees that were never
 * pointed at them.
 */
import { createWalletClient, custom, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { pub, chain, provider, ensureChain } from "./chain.js";
import { EXPLORER, GATEWAYS } from "./config.js";
import { checkLogo, diagnose } from "./launchlog.js";
import { launchOnPons, bindVault, factoryAbi, ponsRegistryAbi, vaultBindAbi, type LaunchInput } from "./pons.js";
import {
  at, fold, validate, checks, spread, MIN_BASKET, MAX_BASKET, MIN_ALLOC_BPS, BPS,
  MIN_REWARDS_BPS, type Draft,
} from "./basket.js";

const padAbi = parseAbi([
  "function platformBps() view returns (uint256)",
  "function PONS_FACTORY() view returns (address)",
  "function createVault((address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken) returns (address vault, address distributor)",
  "function createVaultQuoted((address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken, address quote) returns (address vault, address distributor)",
  // FOUR fields, not three. `wethFee` arrived with the detour route
  // (`QUOTE -> WETH -> PIVOT`) and this declaration never followed: viem then
  // decoded `wethFee` as `minBuy` and `minBuy` as `allowed`, and a bool that
  // is neither 0 nor 1 throws — so every row was skipped by the `.catch`
  // below and the selector offered nothing but native ETH.
  "function quoteListing(address) view returns (uint24 poolFee, uint24 wethFee, uint256 minBuy, bool allowed)",
]);
const STOCK_ALLOWED = parseAbiItem("event StockAllowed(address indexed stock, uint24 poolFee, address feed)");
const STOCK_REMOVED = parseAbiItem("event StockRemoved(address indexed stock)");
// Same four fields. An event's signature IS its topic0, so a missing
// parameter does not mis-decode the log — it matches no log at all, and
// `getLogs` came back empty however many currencies the timelock had listed.
const QUOTE_ALLOWED = parseAbiItem(
  "event QuoteAllowed(address indexed quote, uint24 poolFee, uint24 wethFee, uint256 minBuy)",
);
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const erc20 = parseAbi(["function symbol() view returns (string)"]);

export interface Listed { stock: Address; poolFee: number; feed: Address; symbol: string }

/**
 * The current allowlist, folded from the Payd's own events.
 *
 * There is no array on-chain to read — `listing` is a mapping — and this page
 * has no server and no indexer by design. Folding `StockAllowed` /
 * `StockRemoved` in block order is exact rather than approximate: both are
 * emitted on every change, so the last event for an address IS its state.
 */
export async function allowlist(pad: Address): Promise<Listed[]> {
  const [allowedLogs, removedLogs] = await Promise.all([
    pub.getLogs({ address: pad, event: STOCK_ALLOWED, fromBlock: "earliest" }),
    pub.getLogs({ address: pad, event: STOCK_REMOVED, fromBlock: "earliest" }),
  ]);

  const live = [...fold(
    allowedLogs.map((l) => ({ stock: l.args.stock as string, at: at(l), poolFee: Number(l.args.poolFee), feed: l.args.feed as Address })),
    removedLogs.map((l) => ({ stock: l.args.stock as string, at: at(l) })),
  ).entries()];

  const out: Listed[] = [];
  for (const [stock, v] of live) {
    const symbol = await pub
      .readContract({ address: stock as Address, abi: erc20, functionName: "symbol" })
      .catch(() => stock.slice(0, 8));
    out.push({ stock: stock as Address, poolFee: v.poolFee, feed: v.feed, symbol });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export interface Quoted { quote: Address; symbol: string }

/**
 * The currencies a launch can be quoted in, plus native ETH.
 *
 * The events serve to FIND the addresses, the mapping to say their state.
 * `allowlist` folds two event streams because it needs a stock's tier and feed
 * as of the moment it was listed; here all three fields are in `quoteListing`,
 * and reading it is exact by construction -- a removed currency comes back
 * `allowed: false` with nothing to replay.
 *
 * Native ETH has no row: it is allowed by construction (`_create` only reads the
 * list for a non-zero quote) and it has neither a pool nor decimals to declare.
 * It is the form that adds it at the top.
 */
export async function quotelist(pad: Address): Promise<Quoted[]> {
  const logs = await pub.getLogs({ address: pad, event: QUOTE_ALLOWED, fromBlock: "earliest" });
  const seen = [...new Set(logs.map((l) => (l.args.quote as Address).toLowerCase()))] as Address[];

  const out: Quoted[] = [];
  for (const quote of seen) {
    const row = (await pub
      .readContract({ address: pad, abi: padAbi, functionName: "quoteListing", args: [quote] })
      .catch(() => null)) as readonly [number, number, bigint, boolean] | null;
    if (!row || !row[3]) continue;
    const symbol = await pub
      .readContract({ address: quote, abi: erc20, functionName: "symbol" })
      .catch(() => quote.slice(0, 8));
    out.push({ quote, symbol });
  }
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// Markup taken from `Payd Payd.dc.html`, styles included. The structure I had
/// lost by flattening it: TWO COLUMNS, the right one STICKY -- the split preview
/// and the conditions stay in view while the basket is filled on the left. That
/// is the whole point of the screen, and it does not survive being stacked into
/// one column.
export const FORM = `
  <style>
    .mk .hd { padding: 2.75rem 0 1.75rem; border-bottom: 1px solid var(--hair); max-width: 46rem; }
    .mk .hd h1 { font: 600 clamp(1.75rem,4vw,2.5rem)/1.1 var(--sans); letter-spacing: -.025em; margin: 0; }
    .mk .hd p { color: var(--mut); margin: .75rem 0 0; text-wrap: pretty; }
    .mk .stepcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,15rem),1fr));
      gap: .5rem; margin: 1.5rem 0 1.75rem; }
    .mk .stepcard { border: 1px solid var(--hair); border-radius: 10px; background: var(--surface);
      padding: .875rem 1rem; display: flex; flex-direction: column; gap: .35rem; }
    .mk .stepcard[data-now="1"] { border-color: var(--ok); }
    .mk .stepcard .top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .mk .stepcard .tag { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .mk .stepcard[data-now="1"] .tag { color: var(--ok); }
    .mk .stepcard .who { font: .6875rem var(--mono); color: var(--dim); }
    .mk .stepcard .label { font: 500 .875rem var(--sans); }
    .mk .stepcard p { margin: 0; font-size: .78125rem; line-height: 1.5; color: var(--mut);
      text-wrap: pretty; }
    .mk .stepcard code { font: .7rem var(--mono); color: var(--dim); }

    .mk .cols { display: flex; gap: .75rem; align-items: flex-start; flex-wrap: wrap; }
    .mk .left { flex: 1 1 24rem; min-width: 0; display: flex; flex-direction: column; gap: .75rem; }
    .mk .right { flex: 1 1 18rem; min-width: 0; position: sticky; top: 3.5rem;
      display: flex; flex-direction: column; gap: .75rem; }
    .mk .box { border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
      padding: 1.25rem 1.375rem; }
    .mk .box.tall { padding: 1.25rem 1.375rem 1.375rem; }
    .mk .boxhd { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
      flex-wrap: wrap; }
    .mk .boxt { font: 500 .875rem var(--sans); }
    .mk .boxt .opt { color: var(--dim); font-weight: 400; }
    .mk .hint { font: .75rem var(--mono); color: var(--dim); margin-top: .3rem; }
    .mk button.even { font: 500 .75rem var(--sans); padding: .3rem .6rem; border: 1px solid var(--line);
      border-radius: 6px; background: transparent; color: var(--mut); cursor: pointer; }
    .mk button.even:hover { color: var(--fg); border-color: var(--mut); }

    .mk .picks { display: grid; gap: .4rem; grid-template-columns: repeat(auto-fill, minmax(min(100%,13rem),1fr));
      margin-top: 1rem; }
    .mk .pick { display: flex; align-items: center; gap: .5rem; border: 1px solid var(--hair);
      border-radius: 8px; padding: .45rem .55rem; font-size: .875rem; cursor: pointer; }
    .mk .pick[data-on="1"] { border-color: var(--line); background: var(--bg); }
    .mk .pick input[type=checkbox] { margin: 0; cursor: pointer; accent-color: var(--ok); }
    .mk .pick .sym { font-weight: 500; }
    .mk .pick .tier { font: .65rem var(--mono); color: var(--dim); }
    .mk .pick input[type=number] { margin-left: auto; width: 4.4rem; font: .8125rem var(--mono);
      text-align: right; background: var(--bg); color: var(--fg); border: 1px solid var(--hair);
      border-radius: 6px; padding: .2rem .35rem; }
    .mk .sumrow { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      flex-wrap: wrap; margin-top: .875rem; padding-top: .875rem; border-top: 1px solid var(--hair); }
    .mk .sumrow .a { font: .8125rem var(--mono); color: var(--mut); }
    .mk .sumrow .b { font: .75rem var(--mono); color: var(--dim); }

    .mk .badge { font: .8125rem var(--mono); color: var(--ok); }
    .mk .field { display: flex; align-items: center; gap: .75rem; margin-top: .875rem; flex-wrap: wrap; }
    .mk .field input[type=number] { width: 6rem; font: 500 1.125rem var(--mono);
      font-variant-numeric: tabular-nums; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 6px; padding: .35rem .5rem; }
    .mk .field .u { font: .8125rem var(--mono); color: var(--mut); }
    .mk .field input[type=range] { flex: 1; min-width: 9rem; accent-color: var(--ok); }
    .mk .field .right { margin-left: auto; font: .75rem var(--mono); color: var(--dim); }
    .mk .box p.n { margin: .875rem 0 0; font-size: .78125rem; line-height: 1.55; color: var(--mut);
      text-wrap: pretty; }
    .mk .duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,15rem),1fr));
      gap: .75rem; }
    .mk input[type=text], .mk select { width: 100%; margin-top: .875rem; font: .8125rem var(--mono);
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px;
      padding: .45rem .55rem; }

    .mk .eyebrow { font: 500 .6875rem var(--mono); letter-spacing: .16em; text-transform: uppercase;
      color: var(--ok); }
    .mk .bars { display: flex; height: 34px; border-radius: 8px; overflow: hidden;
      border: 1px solid var(--line); margin-top: .875rem; }
    .mk .bars i { display: block; }
    .mk .mkleg { display: flex; flex-direction: column; gap: .45rem; margin-top: .875rem; }
    .mk .mkleg .r { display: flex; justify-content: space-between; gap: 1rem; font-size: .8125rem;
      align-items: baseline; }
    .mk .mkleg .r .k { display: flex; align-items: center; gap: .5rem; color: var(--mut); }
    .mk .mkleg .mkdot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    .mk .mkleg .mkv { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .mk .tot { display: flex; justify-content: space-between; gap: 1rem; font-size: .8125rem;
      margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--hair); }
    .mk .tot .k { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .mk .tot .mkv { font: 500 .8125rem var(--mono); font-variant-numeric: tabular-nums; }

    .mk .checks { display: flex; flex-direction: column; gap: .5rem; }
    .mk .checks .r { display: flex; gap: .55rem; align-items: flex-start; font-size: .8125rem; }
    .mk .checks .mkmark { font: .6875rem var(--mono); color: var(--dim); flex-shrink: 0; }
    .mk .checks .r[data-ok="1"] .mkmark { color: var(--ok); }
    .mk .checks .lab { color: var(--mut); text-wrap: pretty; }
    .mk button.cta { width: 100%; margin-top: 1.125rem; font: 600 .9375rem var(--sans);
      padding: .625rem 1rem; border: 0; border-radius: 8px; background: var(--ok); color: var(--bg);
      cursor: pointer; }
    .mk button.cta[disabled] { background: var(--raised); color: var(--dim); cursor: not-allowed; }
    .mk .ctan { margin: .75rem 0 0; font-size: .75rem; line-height: 1.55; color: var(--dim);
      text-wrap: pretty; }
    .mk .ctan code { font-family: var(--mono); color: var(--mut); }
    .mk .out { margin-top: .8rem; font-size: .875rem; }
    .mk .out.bad { color: var(--bad); }
    .mk table.hand { border-collapse: collapse; width: 100%; margin: .6rem 0; }
    .mk table.hand td { padding: .3rem .4rem; border-bottom: 1px solid var(--hair); vertical-align: baseline; }
    .mk table.hand td.k { color: var(--mut); white-space: nowrap; width: 1%; }
    .mk table.hand td.mkv { font-family: var(--mono); word-break: break-all; }
    .mk table.hand button { font: .75rem var(--sans); padding: .2rem .5rem; background: var(--raised);
      color: var(--fg); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
    .mk table.hand tr.critical td.mkv { color: var(--ok); font-weight: 600; }
    .mk label.f { display: block; font-size: .875rem; margin-top: .7rem; }
    .mk label.f input { width: 100%; }
    .mk summary { cursor: pointer; font-size: .875rem; color: var(--mut); margin-top: 1.2rem; }
  </style>
  <section class="mk" id="mk">
    <div class="hd">
      <h1>Create a vault</h1>
      <p id="mk-intro">This creates the vault and its distributor. It launches no token: you launch on
      Pons yourself, with the address it returns as the fee recipient. Until both are done the vault
      holds nothing and binds to nothing, so an unused one costs no one anything.</p>
    </div>

    <div class="stepcards" id="mk-stepcards"></div>

    <div class="cols">
      <div class="left">
        <div class="box tall">
          <div class="boxhd">
            <div class="boxt">Basket — ${MIN_BASKET} to ${MAX_BASKET} stocks, each at least ${MIN_ALLOC_BPS} bps, summing to ${BPS}</div>
            <button type="button" class="even" id="mk-even">Even the split</button>
          </div>
          <div class="hint" id="mk-listed">reading the allowlist…</div>
          <div class="picks" id="mk-picks"></div>
          <div class="sumrow">
            <span class="a" id="mk-sum"></span>
            <span class="b">ticking a stock re-evens the split; editing a weight never does</span>
          </div>
        </div>

        <div class="box">
          <div class="boxhd">
            <div class="boxt">Share of fees paid to holders, in stock</div>
            <span class="badge" id="mk-rewards-vol"></span>
          </div>
          <div class="field">
            <input type="number" id="mk-rewards" value="7000" min="${MIN_REWARDS_BPS}" max="9000" step="100">
            <span class="u">bps</span>
            <input type="range" id="mk-rewards-range" value="7000" min="${MIN_REWARDS_BPS}" max="9000" step="100">
          </div>
          <p class="n" id="mk-rewards-note"></p>
        </div>

        <div class="box">
          <div class="boxt">Currency the launch is quoted in</div>
          <select id="mk-quote"><option value="0x0000000000000000000000000000000000000000">native ETH</option></select>
          <p class="n" id="mk-quote-note">Written into the vault for good. Pons keeps <strong>one fee
          ledger per currency</strong>, so a vault claims exactly one and <code>bind</code> refuses a
          launch quoted in any other. Step 2 fills Pons's field from this by itself — you never type
          it twice.</p>
        </div>

        <div class="duo">
          <div class="box">
            <div class="boxt">Epoch length</div>
            <div class="field">
              <input type="number" id="mk-epoch" value="30" min="30" max="1440" step="30">
              <span class="u">minutes</span>
              <span class="right" id="mk-buys"></span>
            </div>
            <p class="n">How often the snapshot closes, and therefore how often the whole basket is
            bought. 30 minutes to 1 day.</p>
          </div>
          <div class="box">
            <div class="boxt">Intended token <span class="opt">— optional</span></div>
            <input type="text" id="mk-intended" placeholder="0x… leave empty to accept any">
            <p class="n">Pins the address this vault will accept at bind time. Left empty, the vault
            binds to whichever token names it <em>and</em> was deployed by you.</p>
          </div>
        </div>
      </div>

      <div class="right">
        <div class="box tall">
          <div class="eyebrow">What a trade will pay</div>
          <div class="bars" id="mk-bars"></div>
          <div class="mkleg" id="mk-preview"></div>
          <div class="tot"><span class="k">Of what reaches the vault</span>
            <span class="mkv">100.00 % total</span></div>
        </div>

        <div class="box tall">
          <div class="checks" id="mk-checks"></div>
          <button id="mk-go" class="cta" disabled>Connect a wallet</button>
          <p class="ctan">One transaction, and it launches nothing. You become this vault's
          <code>LAUNCHER</code> — step 3 checks the token's Pons deployer against it, so nobody else
          can bind a token to your vault.</p>
          <div class="out" id="mk-out"></div>
        </div>
      </div>
    </div>

    <div id="mk-s2" hidden>
      <div class="box tall" style="margin-top:1.5rem">
        <div class="boxt">Launch on Pons — the token itself</div>
        <p class="n">Three fields are <strong>not</strong> asked for, because they are not preferences:
        the fee recipient is set to your vault, the pair token is <span id="mk-s2-quote">read from the
        vault</span>, and the economics commitment is computed. Those are the three <code>bind</code>
        checks, and a launch that gets one wrong cannot be repaired.</p>
        <label class="f">Name <input id="mk-name" maxlength="64" placeholder="Payd"></label>
        <label class="f">Ticker <input id="mk-sym" maxlength="16" placeholder="PAYD"></label>
        <label class="f">Your creator tax
          <input type="number" id="mk-tax" value="300" min="0" max="1000" step="25">
          <span class="hint" id="mk-tax-note">on top of the curve fee; it is what funds your vault</span></label>
        <label class="f">Logo <input id="mk-logo" placeholder="ipfs://bafk… or https://…">
          <span class="hint" id="mk-logo-note">stored on the token forever — there is no setter to fix it later</span></label>
        <div id="mk-logo-prev" hidden><img alt="" id="mk-logo-img"
          style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--hair)"></div>
        <label class="f">Description <input id="mk-desc" maxlength="280" placeholder="one line"></label>
        <label class="f">Website <input id="mk-site" placeholder="https://…"></label>
        <label class="f">X <input id="mk-x" placeholder="https://x.com/…"></label>
        <label class="f">Telegram <input id="mk-tg" placeholder="https://t.me/…"></label>
        <button id="mk-launch" class="cta">Launch on Pons</button>
        <div class="out" id="mk-out2"></div>
      </div>
    </div>

    <details id="mk-hand" hidden>
      <summary>…or launch on the Pons site instead (keeps their image uploader)</summary>
      <div class="box tall" style="margin-top:.6rem">
        <p class="n" style="margin-top:0">Pons hosts the logo for you; its upload endpoint refuses calls
        from any other site, so that is the only way to use it. The cost is that you fill their form by
        hand — so here is every value, ready to copy. <strong>Creator wallet is the one that cannot be
        repaired.</strong></p>
        <table class="hand" id="mk-hand-rows"></table>
        <p class="n">Their “Creator tax” is in <strong>percent</strong>, not bps — the value above is
        already converted. Leave every other field of theirs alone.</p>
      </div>
    </details>

    <div id="mk-s3" hidden>
      <div class="box tall" style="margin-top:1.5rem">
        <div class="boxt">Point the fees at the vault</div>
        <label class="f">Token address
          <input id="mk-token" placeholder="0x… — filled in automatically if you launched above">
          <span class="hint">paste it if you launched on the Pons site</span></label>
        <div class="out" id="mk-diag"></div>
        <button id="mk-bind" class="cta">Bind</button>
        <div class="out" id="mk-out3"></div>
      </div>
    </div>
  </section>`;

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Mounts the form. Returns nothing: everything after this is event-driven. */
export async function mountCreate(pad: Address): Promise<void> {
  const out = (msg: string, bad = false) => {
    const el = $("mk-out");
    el.textContent = msg;
    el.className = bad ? "out bad" : "out";
  };

  let platformBps = 0;
  try {
    platformBps = Number(await pub.readContract({ address: pad, abi: padAbi, functionName: "platformBps" }));
  } catch { /* shown as unknown below; the contract still enforces it */ }

  $("mk-rewards-note").textContent = platformBps
    ? `the platform takes ${platformBps / 100} % of what reaches the vault, fixed at creation and never raisable on you; the rest is yours`
    : "the rest is yours, less the platform's fixed share";

  let listed: Listed[] = [];
  try {
    listed = await allowlist(pad);
  } catch (e) {
    $("mk-picks").innerHTML = `<p class="note">could not read the allowlist: ${esc((e as Error).message)}</p>`;
    return;
  }
  if (listed.length === 0) {
    $("mk-picks").innerHTML = `<p class="note">no stock is listed yet — the timelock has not run its first allowlist</p>`;
    return;
  }

  // The currencies are added to native ETH, which stays the first option and
  // the default. A read that fails leaves the form on ETH alone rather than
  // blocking it: that is the case v1 already served.
  const quoteSel = $("mk-quote") as HTMLSelectElement;
  let quoted: Quoted[] = [];
  try {
    quoted = await quotelist(pad);
  } catch { /* the select keeps its single option */ }
  for (const q of quoted) {
    const o = document.createElement("option");
    o.value = q.quote;
    o.textContent = `${q.symbol} — ${q.quote}`;
    quoteSel.appendChild(o);
  }
  const quoteName = () =>
    quoteSel.value === ZERO ? "native ETH" : (quoteSel.selectedOptions[0]?.textContent ?? quoteSel.value).split(" — ")[0]!;
  const syncQuote = () => {
    $("mk-s2-quote").textContent = quoteName();
    step(current);
    handoff();
  };
  quoteSel.addEventListener("change", syncQuote);
  // The initial call is further down, after `step`: `syncQuote` redraws the
  // cards, and an arrow const is not hoisted.

  const picks = new Map<string, Draft>();
  for (const l of listed) picks.set(l.stock, { on: false, bps: 0 });

  $("mk-listed").textContent =
    `${listed.length} listed by the timelock · pool fee tier and price feed come from the allowlist, not from you`;

  $("mk-picks").innerHTML = listed
    .map(
      (l) => `<label class="pick" data-on="0" data-stock="${l.stock}">
        <input type="checkbox" data-k="on">
        <span class="sym">${esc(l.symbol)}</span>
        <span class="tier">${(l.poolFee / 10_000).toFixed(2)} %</span>
        <input type="number" data-k="bps" min="0" max="${BPS}" step="100" value="0" disabled>
      </label>`,
    )
    .join("");

  /** THIS session's vault, once created. Steps 2 and 3 depend on it. */
  let mine: Address | null = null;
  let launched: Address | null = null;
  const out2 = (m: string, bad = false) => {
    const el = $("mk-out2"); el.textContent = m; el.className = bad ? "out bad" : "out";
  };
  const out3 = (m: string, bad = false) => {
    const el = $("mk-out3"); el.textContent = m; el.className = bad ? "out bad" : "out";
  };
  /** The three steps, and WHO signs each -- that is the column that matters:
   *  the third belongs to nobody, and a card that says so beats a paragraph that
   *  explains it. */
  const STEPS = [
    { tag: "01", who: "you", label: "Create the vault", n: "Nothing is launched. You become its LAUNCHER.", call: "Payd.createVault" },
    // Card 01 names the function actually called: a chosen currency sends
    // `createVaultQuoted`, and a card showing the other one would be wrong on
    // screen while the wallet displays the right one.
    { tag: "02", who: "you", label: "Launch on Pons", n: "Built here, so the three checked fields cannot be mistyped.", call: "PonsV2.launchToken" },
    { tag: "03", who: "anyone", label: "Point the fees at it", n: "Open to all: the destination is written in the launch, not in the caller.", call: "FeeVault.bind" },
  ];
  let current = 1;
  const step = (n: number) => {
    current = n;
    STEPS[0]!.call = quoteSel.value === ZERO ? "Payd.createVault" : "Payd.createVaultQuoted";
    $("mk-stepcards").innerHTML = STEPS.map((x, i) =>
      `<div class="stepcard" data-now="${i === n - 1 ? 1 : 0}">
         <div class="top"><span class="tag">${x.tag}</span><span class="who">${esc(x.who)}</span></div>
         <div class="label">${esc(x.label)}</div>
         <p class="note">${esc(x.n)}</p>
         <code>${esc(x.call)}</code>
       </div>`).join("");
  };
  step(1);
  syncQuote(); // step 2 has to say "native ETH" before anything is touched

  const go = $("mk-go") as HTMLButtonElement;

  /** The token this vault will accept, or zero for "any". Invalid input counts
   *  as zero rather than failing: the field is optional, and `validate` does not
   *  cover it. */
  const intended = (): Address => {
    const v = ($("mk-intended") as HTMLInputElement).value.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : "0x0000000000000000000000000000000000000000";
  };

  function recompute() {
    const chosen = [...picks.values()].filter((p) => p.on);
    const sum = chosen.reduce((a, c) => a + c.bps, 0);
    const rewards = Number(($("mk-rewards") as HTMLInputElement).value);
    const epochMin = Number(($("mk-epoch") as HTMLInputElement).value);

    $("mk-sum").textContent = chosen.length
      ? `${chosen.length} stock${chosen.length > 1 ? "s" : ""}, ${sum} / ${BPS} bps`
      : "";
    ($("mk-rewards-range") as HTMLInputElement).value = String(rewards);
    $("mk-rewards-vol").textContent = `${(rewards / 100).toFixed(2)} % of what reaches the vault`;
    // `Number(...)` drops a trailing `.0`: at the default 30 minutes the field
    // read "48.0 buys a day", which is a decimal announcing a precision the
    // figure does not have. 2.4 keeps its tenth.
    $("mk-buys").textContent = epochMin > 0
      ? `${Number((1440 / epochMin).toFixed(1))} buys a day`
      : "";

    // The share of VOLUME, not the share of the vault: it is what a trader
    // pays, and it is the only one of the two a creator can compare against
    // another launch. The real figure will come from `economics()` once the
    // token is bound -- here the creator tax is not known yet, so we announce
    // what we do know: the split of what ARRIVES at the vault.
    const creator = Math.max(0, BPS - rewards - platformBps);
    const parts: [string, number, string][] = [
      ["to holders, in stock", rewards, "var(--ok)"],
      ["to you, the creator", creator, "var(--mut)"],
      ["to the platform", platformBps, "var(--dim)"],
    ];
    $("mk-bars").innerHTML = parts
      .map(([, v, c]) => `<i style="flex-grow:${v};background:${c}"></i>`).join("");
    $("mk-preview").innerHTML = parts
      .map(([k, v, c]) =>
        `<div class="r"><span class="k"><span class="mkdot" style="background:${c}"></span>${esc(k)}</span>` +
        `<span class="mkv">${(v / 100).toFixed(2)} %</span></div>`).join("");

    $("mk-checks").innerHTML = checks(picks, rewards, epochMin, platformBps)
      .map((c) =>
        `<div class="r" data-ok="${c.ok ? 1 : 0}">` +
        `<span class="mkmark">${c.ok ? "\u2713" : "\u00b7"}</span>` +
        `<span class="lab">${esc(c.label)}</span></div>`).join("");

    const err = validate(picks, rewards, epochMin, platformBps);
    go.disabled = err !== null;
    go.textContent = err ? "Fix the basket" : "Create the vault";
    if (err) out(err, true);
    else out("");
  }

  /** Applies the even split to whatever is currently ticked. */
  function reweigh() {
    const on = listed.filter((l) => picks.get(l.stock)!.on);
    const w = spread(on.length);
    on.forEach((l, i) => { picks.get(l.stock)!.bps = w[i]!; });
    for (const l of listed) {
      const box = document.querySelector<HTMLInputElement>(`[data-stock="${l.stock}"] [data-k="bps"]`)!;
      box.value = String(picks.get(l.stock)!.bps);
    }
  }

  $("mk-picks").addEventListener("change", (ev) => {
    const el = ev.target as HTMLInputElement;
    const row = el.closest<HTMLElement>(".pick");
    if (!row) return;
    const stock = row.dataset.stock!;
    const d = picks.get(stock)!;
    if (el.dataset.k === "on") {
      d.on = el.checked;
      row.dataset.on = d.on ? "1" : "0";
      row.querySelector<HTMLInputElement>('[data-k="bps"]')!.disabled = !d.on;
      if (!d.on) d.bps = 0;
      reweigh(); // re-even the split whenever the SET changes, never on a manual edit
    } else {
      d.bps = Number(el.value);
    }
    recompute();
  });
  for (const id of ["mk-rewards", "mk-epoch"]) $(id).addEventListener("input", recompute);
  $("mk-rewards-range").addEventListener("input", (ev) => {
    ($("mk-rewards") as HTMLInputElement).value = (ev.target as HTMLInputElement).value;
    recompute();
  });
  $("mk-even").addEventListener("click", () => { reweigh(); recompute(); });

  go.addEventListener("click", async () => {
    const eth = provider();
    if (!eth) return out("no wallet detected", true);
    go.disabled = true;
    try {
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) return out("the wallet returned no account", true);
      if (!(await ensureChain(eth, (m) => out(m, true)))) return;

      const basket = listed
        .filter((l) => picks.get(l.stock)!.on)
        .map((l) => ({ stock: l.stock, poolFee: l.poolFee, bps: picks.get(l.stock)!.bps, feed: l.feed }));

      out("confirm in your wallet…");
      const wallet = createWalletClient({ account, chain, transport: custom(eth) });
      // Two functions rather than one more argument on a single one: it is the
      // Payd that made that choice, and following it here keeps the ETH path
      // exactly as it was -- same selector, same calldata, same gas.
      const quote = quoteSel.value as Address;
      const common = [
        basket,
        BigInt(Number(($("mk-rewards") as HTMLInputElement).value)),
        BigInt(Number(($("mk-epoch") as HTMLInputElement).value) * 60),
        intended(),
      ];
      const hash = (await wallet.writeContract({
        address: pad,
        abi: padAbi,
        functionName: quote === ZERO ? "createVault" : "createVaultQuoted",
        args: (quote === ZERO ? common : [...common, quote]) as never,
        account,
        chain,
      })) as Hex;

      out(`sent: ${hash}`);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      // The vault is the first contract the transaction created. Reading it
      // from the receipt rather than re-reading the registry keeps the answer
      // tied to THIS transaction — `vaults()` would also return one somebody
      // else created in the same block.
      const created = receipt.logs.find((l) => l.address.toLowerCase() === pad.toLowerCase());
      const vault = created?.topics?.[1] ? (`0x${created.topics[1].slice(26)}` as Address) : null;

      if (!vault) {
        $("mk-out").innerHTML = `<p>Created. <a href="${EXPLORER}/tx/${hash}">transaction</a></p>
          <p class="note">The vault address could not be read from the receipt, so the next two steps
          cannot be prefilled. Find it in the list above and launch on Pons with it as the creator fee
          recipient, native ETH as the pair.</p>`;
        return;
      }

      // The vault exists: we go straight on to step 2 rather than sending the
      // creator off to fill in a form elsewhere. That is the WHOLE point -- the
      // three fields `bind` checks are no longer asked of them.
      mine = vault;
      $("mk-out").innerHTML =
        `<p>Vault created: <span class="mono">${esc(vault)}</span> — <a href="${EXPLORER}/tx/${hash}">transaction</a></p>`;
      step(2);
      $("mk-s2").hidden = false;
      $("mk-hand").hidden = false;
      $("mk-s3").hidden = false; // the bind is reachable from now on: one may
                                 // have come back from a launch made at Pons
      handoff();
      // The cap comes from Pons, not from here. `launchOnPons` re-validates it
      // anyway -- this is only the visible version.
      try {
        const factory = (await pub.readContract({
          address: pad, abi: padAbi, functionName: "PONS_FACTORY",
        })) as Address;
        const max = await pub.readContract({
          address: factory, abi: factoryAbi, functionName: "maxCreatorTaxBps",
        });
        const tax = $("mk-tax") as HTMLInputElement;
        tax.max = String(max);
        $("mk-tax-note").textContent = `on top of the curve fee; Pons caps it at ${max} bps`;
      } catch { /* the field keeps its default bound; the contract decides */ }
    } catch (e) {
      out("failed: " + String((e as Error).message).split("\n")[0], true);
      go.disabled = false;
    }
  });

  // The preview is the real protection: the field is written ONCE on the token
  // and no known setter takes it back. A dead address has to be seen before the
  // signature, not after.
  $("mk-logo").addEventListener("input", () => {
    const r = checkLogo(($("mk-logo") as HTMLInputElement).value, GATEWAYS);
    const box = $("mk-logo-prev");
    const note = $("mk-logo-note");
    if (!r.ok) {
      box.hidden = true;
      note.textContent = r.why;
      note.className = "note bad";
      return;
    }
    note.textContent = "stored on the token forever — there is no setter to fix it later";
    note.className = "note";
    box.hidden = r.preview === "";
    if (r.preview) ($("mk-logo-img") as HTMLImageElement).src = r.preview;
  });

  /** The values to copy into Pons's form, under THEIR labels. The labels are
   *  the ones read on their page: a creator switching between tabs has to
   *  recognise the fields without translating. */
  function handoff(): void {
    if (!mine) return;
    const v = (id: string) => ($(id) as HTMLInputElement).value.trim();
    const tax = Number(v("mk-tax"));
    const rows: [string, string, boolean][] = [
      ["Creator wallet", mine, true], // the only unrepairable one: first, and in colour
      // The pair only shows when it is not ETH: on their form that is the
      // default, and a row saying "leave it as it is" reads as an action to
      // take. When it is NOT the default, it is as unrepairable as the creator
      // wallet -- hence in colour.
      ...(quoteSel.value === ZERO ? [] : [["Pair token", quoteSel.value, true] as [string, string, boolean]]),
      ["Name", v("mk-name"), false],
      ["Ticker", v("mk-sym"), false],
      ["Creator tax", Number.isFinite(tax) ? String(tax / 100) : "", false], // theirs: in %
      ["Description", v("mk-desc"), false],
      ["X profile", v("mk-x"), false],
      ["Telegram", v("mk-tg"), false],
    ];
    $("mk-hand-rows").innerHTML = rows
      .filter(([, val]) => val !== "")
      .map(([k, val, crit]) =>
        `<tr class="${crit ? "critical" : ""}"><td class="k">${esc(k)}</td>` +
        `<td class="mkv">${esc(val)}</td>` +
        `<td><button type="button" data-copy="${esc(val)}">copy</button></td></tr>`)
      .join("");
  }

  // Delegated: the rows are rebuilt on every keystroke.
  $("mk-hand-rows").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("button[data-copy]") as HTMLButtonElement | null;
    if (!b) return;
    void navigator.clipboard.writeText(b.dataset.copy!).then(
      () => { b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1200); },
      () => { b.textContent = "copy failed"; },
    );
  });
  for (const id of ["mk-name", "mk-sym", "mk-tax", "mk-desc", "mk-x", "mk-tg"]) {
    $(id).addEventListener("input", handoff);
  }

  // --- step 2: the launch on Pons ----------------------------------------
  const launchBtn = $("mk-launch") as HTMLButtonElement;
  launchBtn.addEventListener("click", async () => {
    if (!mine) return out2("create the vault first", true);
    const input: LaunchInput = {
      name: ($("mk-name") as HTMLInputElement).value.trim(),
      symbol: ($("mk-sym") as HTMLInputElement).value.trim(),
      logo: ($("mk-logo") as HTMLInputElement).value.trim(),
      description: ($("mk-desc") as HTMLInputElement).value.trim(),
      website: ($("mk-site") as HTMLInputElement).value.trim(),
      x: ($("mk-x") as HTMLInputElement).value.trim(),
      telegram: ($("mk-tg") as HTMLInputElement).value.trim(),
      creatorTaxBps: Number(($("mk-tax") as HTMLInputElement).value),
    };
    if (!input.name || !input.symbol) return out2("a name and a ticker are required", true);
    const logo = checkLogo(input.logo, GATEWAYS);
    if (!logo.ok) return out2(`logo: ${logo.why}`, true);

    launchBtn.disabled = true;
    try {
      const eth = provider();
      if (!eth) return out2("no wallet detected", true);
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) return out2("the wallet returned no account", true);

      const factory = (await pub.readContract({
        address: pad, abi: padAbi, functionName: "PONS_FACTORY",
      })) as Address;

      launched = await launchOnPons(factory, mine, account, input, out2);
      $("mk-out2").innerHTML = `<p>Launched: <span class="mono">${esc(launched)}</span></p>`;
      ($("mk-token") as HTMLInputElement).value = launched;
      step(3);
    } catch (e) {
      out2("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 160), true);
      launchBtn.disabled = false;
    }
  });

  // --- etape 3: bind -----------------------------------------------------
  const bindBtn = $("mk-bind") as HTMLButtonElement;
  bindBtn.addEventListener("click", async () => {
    if (!mine) return out3("create the vault first", true);
    const typed = ($("mk-token") as HTMLInputElement).value.trim();
    const target = (typed || launched || "") as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) return out3("paste the token address", true);

    bindBtn.disabled = true;
    try {
      const eth = provider();
      if (!eth) return out3("no wallet detected", true);
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) return out3("the wallet returned no account", true);

      // The same conditions as `bind`, read BEFORE sending. The contract
      // re-checks them -- this replaces nothing, it explains. A bare
      // `NotOurLaunch` in a wallet does not say WHICH of the four gave way, and
      // that is precisely what you need to know coming back from Pons's site.
      out3("checking the launch…");
      const factory = (await pub.readContract({
        address: pad, abi: padAbi, functionName: "PONS_FACTORY",
      })) as Address;
      const [l, launcher, vaultQuote] = await Promise.all([
        pub.readContract({ address: factory, abi: ponsRegistryAbi, functionName: "getLaunchedToken", args: [target] }),
        pub.readContract({ address: mine, abi: vaultBindAbi, functionName: "LAUNCHER" }) as Promise<Address>,
        // Read FROM THE VAULT and not taken from the selector: at step 3 the
        // vault may come from an earlier session, or from a launch made on
        // Pons's site. The selector only says what this browser chose; the vault
        // says what `bind` is going to compare.
        pub.readContract({ address: mine, abi: vaultBindAbi, functionName: "QUOTE" }) as Promise<Address>,
      ]);
      const problems = diagnose(l as never, mine, launcher, vaultQuote);
      if (problems.length > 0) {
        $("mk-diag").className = "out bad";
        $("mk-diag").innerHTML =
          `<p>This launch cannot be bound to this vault:</p><ul>${
            problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
        bindBtn.disabled = false;
        return;
      }
      $("mk-diag").className = "out";
      $("mk-diag").textContent = "";

      const hash = await bindVault(mine, target, account, out3);
      $("mk-out3").innerHTML =
        `<p>Bound. Fees now arrive at the vault. <a href="${EXPLORER}/tx/${hash}">transaction</a></p>`;
    } catch (e) {
      out3("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 160), true);
      bindBtn.disabled = false;
    }
  });

  recompute();
  go.textContent = "Create the vault";
}
