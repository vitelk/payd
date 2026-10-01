import {
  createWalletClient, custom, formatEther, formatUnits, parseAbi, parseAbiItem,
  type Address, type Hex,
} from "viem";
import { DISTRIBUTOR, FEE_VAULT, OWN_VAULT, EXPLORER, PROJECT_NAME, RPC_URL, CHAIN_ID, PONS_TOKEN_URL, TOKEN_ELSEWHERE } from "./config.js";
import { REGISTRY, loadRail, renderCreate, renderLaunchpad } from "./registry.js";
import { TREASURY, renderTreasury } from "./treasury.js";
import { addressFromQuery, connected, onViewer, parseAddress, setViewer, viewer } from "./viewer.js";
import { pub, chain, distributorAbi, vaultAbi, escrowAbi, erc20Abi, curveAbi, provider, ensureChain, useWallet, walletOptions, disconnect, logsBack, LOG_SPAN, onNetwork, onWrongNetwork, watchNetwork, type WalletOption, type Eth1193 } from "./chain.js";
import { fetchArtifact, buildClaim, type Artifact } from "./artifact.js";
import { curveProgress, GRADUATION_WEI } from "./curve.js";
import { pct } from "./basket.js";
import { yieldOf } from "./yield.js";
import { readMetrics, usdPrice, pairIdOf, type Metrics } from "./metrics.js";
import { spark, cumulative } from "./spark.js";
import { isView, route, type View } from "./route.js";
import { modeBlurb, payScreen, readMode, type Mode, type PayScreen } from "./modes.js";
import { renderBacking } from "./backing.js";
import { renderLottery } from "./lottery.js";

const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => ($("log").textContent = m);

/**
 * A panel allowed to fail on its own, without taking the page with it.
 *
 * The `void` at these call sites is the right decision -- a log range the node
 * refuses must not hold up the panels that only need `call` -- but a rejected
 * promise with NO handler surfaces as an uncaught error. On this chain that is
 * not rare: the public node answers a throttle with a 429 that carries no CORS
 * header (and sometimes a duplicated `Access-Control-Allow-Origin`), so the
 * browser kills the fetch before any status reaches us and viem reports "HTTP
 * request failed". Every throttled side read was therefore printing a stack
 * trace, and the page was reporting the node's rate limit as a fault of its
 * own. Measured 2026-09-16: 85 such events in one 28-second load.
 *
 * What it does NOT do is hide the failure. The panel keeps whatever it had,
 * the reason is written where the page writes its reasons, and the 60-second
 * refresh comes round and tries again.
 */
function aside(what: string, p: Promise<unknown>): void {
  void p.catch((e: Error) => {
    log(`${what} could not be read: ${String(e.message).split("\n")[0]!.slice(0, 120)}`
      + " — retrying on the next refresh");
  });
}
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const ZERO = "0x0000000000000000000000000000000000000000";
const HISTORY = 12;

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ------------------------------------------------------------------- format

const bps = (v: bigint | number) => `${(Number(v) / 100).toFixed(2)} %`;
const eth = (v: bigint, d = 4) => `${Number(formatEther(v)).toFixed(d)} ETH`;
const int = (v: bigint | number) => Number(v).toLocaleString("en-US");
/** Token counts run to nine figures — 402,194,169 is a number a reader counts
 *  digits on rather than reads. One decimal below 100M so a small supply does
 *  not round to a flat "0M". */
const millions = (v: number) => `${(v / 1e6).toFixed(v < 1e8 ? 1 : 0)}M`;

function duration(seconds: number): string {
  if (seconds % 86400 === 0 && seconds >= 86400) return `${seconds / 86400} d`;
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Seconds between the browser's clock and the chain's, measured on every
 * refresh. The countdown runs against `epochEnd`, which is a `block.timestamp`
 * — so counting with `Date.now()` alone shows the visitor's own clock error,
 * and a machine 40 s adrift displays an epoch that ends 40 s early. Nothing on
 * the page is wrong; the clock reading it is.
 */
let chainSkew = 0;

/** Now, in the chain's seconds. */
const chainNow = () => Math.floor(Date.now() / 1000) + chainSkew;

function countdown(left: number): string {
  if (left <= 0) return "ended";
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

const cardHtml = (k: string, v: string, note = "", cls = "") =>
  `<div class="card"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div>` +
  (note ? `<div class="note">${note}</div>` : "") + `</div>`;

// ------------------------------------------------------------------ metadata

const meta = new Map<Address, { symbol: string; decimals: number }>();
async function tokenMeta(token: Address) {
  if (!meta.has(token)) {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
      pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    meta.set(token, { symbol, decimals });
  }
  return meta.get(token)!;
}

// ------------------------------------------------------------------ lecture

const readD = <F extends string>(functionName: F, args?: readonly unknown[]) =>
  pub.readContract({ address: DISTRIBUTOR, abi: distributorAbi, functionName, args } as never);
const readV = <F extends string>(functionName: F, args?: readonly unknown[]) =>
  pub.readContract({ address: FEE_VAULT, abi: vaultAbi, functionName, args } as never);

type Alloc = { stock: Address; poolFee: number; bps: number; feed: Address };

interface State {
  epoch: bigint;
  epochLen: bigint;
  endsAt: bigint;
  allocations: readonly Alloc[];
  /** Epochs closed but not yet covered by a purchase. D8: a WINDOW buys the
   *  whole basket, so what a holder waits for is the window closing — not a
   *  wheel turning. */
  pending: bigint;
  rootCount: bigint;
  activeRoot: bigint;
  /** Most recent root, as the contract returns it. Field for field with the
   *  `roots(uint256)` signature in `chain.ts` — see the warning there. */
  last: readonly [Address, number, Hex, Hex, number, Hex] | null;
  keeper: `0x${string}`;
  quoteAtRisk: bigint;
  artifact: Artifact | null;
  /** Set by `renderVault`, which is the read that already fetches it. */
  token: Address | null;
}

let state: State | null = null;
/** Who the page is looking at. Shared with the index and the Treasury so the
 *  three screens never disagree, and settable WITHOUT a wallet — see
 *  `viewer.ts`. Only `doClaim` additionally requires `connected`. */
let account: Address | null = null;

/**
 * Gas for ONE stock delivered, measured, not guessed: the ERC-20 transfer is
 * only a third of it — the Merkle verification and the `claimedSoFar` write pay
 * the rest (docs/recon.md §6, and `offchain/src/epoch.ts` where the keeper uses
 * the same figure to decide what is worth pushing).
 */
const SETTLE_GAS = 93_000n;
/** Transaction, calldata and the batch's own bookkeeping, once per claim. */
const CLAIM_BASE_GAS = 50_000n;

/** Head basefee, from the block `refresh` already reads. 0 until it lands. */
let baseFee = 0n;

/**
 * WHICH PAYOUT MODE this launch was born under, read once at startup from
 * `Payd.modeOf` and never from what a contract answers.
 *
 * `distribution` and `tontine` are this page as it has always been. Anything
 * else pays through another contract entirely, and every read below — the
 * epoch, the roots, the claim table — would fail one by one against it, leaving
 * an empty table that reads as "you are owed nothing". So the whole
 * distribution half of the view is hidden and the mode's own screen is drawn in
 * its place (`modes.ts`).
 */
let mode: Mode = "distribution";
let pay: PayScreen = "claim";
const modeAbi = parseAbi(["function modeOf(address) view returns (bytes32)"]);

async function loadEpoch() {
  const [epoch, epochLen] = await Promise.all([
    readD("currentEpoch") as Promise<bigint>,
    readD("EPOCH_LENGTH") as Promise<bigint>,
  ]);
  const endsAt = (await readD("epochEnd", [epoch])) as bigint;
  const allocations = (await readV("getAllocations")) as readonly Alloc[];

  // Read from the Distributor rather than recomputed here: the page cannot
  // diverge from the contract, and this is the number that actually describes
  // what happens next.
  const pending = (await readD("pendingEpochs")) as bigint;

  return { epoch, epochLen, endsAt, allocations, pending };
}

let epochTimer: ReturnType<typeof setInterval> | null = null;
/** Last time the countdown asked for a refresh because the epoch ran out. */
let lastRoll = 0;

function renderEpoch(s: State) {
  const tick = () => {
    const left = Number(s.endsAt) - chainNow();

    // **The whole epoch card, in the badge.** It was a `.gauge` of its own down
    // in Advanced — three figures and a progress bar for facts a reader checks
    // at a glance and then leaves. Beside the name they are read without
    // scrolling and on both screens, and the card is gone rather than repeating
    // them. Written from this tick, so nothing can disagree by a second.
    $("epoch-badge").innerHTML =
      `<span class="bk">epoch #${s.epoch}</span>`
      + `<span class="bv hl">${esc(countdown(left))}</span>`
      + `<span class="bsep"></span>`
      + `<span class="bk">waiting</span>`
      + `<span class="bv sm">${s.pending} epoch${s.pending === 1n ? "" : "s"}</span>`
      + `<span class="bsep"></span>`
      + `<span class="bk">length</span>`
      + `<span class="bv sm">${esc(duration(Number(s.epochLen)))}</span>`;
    $("epoch-badge").className = "badge live";
    $("epoch-badge").hidden = false;

    // The epoch has turned. Waiting for the next scheduled refresh would leave
    // "ended" on screen for up to a minute and then jump — so ask for the new
    // one now. Debounced, because this runs every second and `currentEpoch`
    // only moves when a block lands past the boundary.
    if (left <= 0 && Date.now() - lastRoll > 10_000) {
      lastRoll = Date.now();
      void refresh().catch(() => { /* the 60-second tick tries again */ });
    }
  };
  tick();
  // One timer, not one per refresh. `renderEpoch` is called again on every
  // 60-second refresh, and each call used to leave another `setInterval`
  // behind: after an hour, sixty timers repainting the same node every second.
  if (epochTimer !== null) clearInterval(epochTimer);
  epochTimer = setInterval(tick, 1000);

  // The basket is 2 to 8 stocks and the vault says which: reading its length
  // beats hardcoding a number that stops being true the day it is reweighted.
  const n = s.allocations.length;
  // The dot is the same indicator the shop window's ribbon carries: a leg with
  // a Chainlink feed has its TWAP floor tightened by it, an unmarked leg is
  // priced by the 30-minute TWAP alone. Read from the same struct the vault
  // swaps with, so it cannot drift from what the money path actually does.
  const anyFeed = s.allocations.some((a) => a.feed !== ZERO);
  $("rotation-hint").textContent =
    `${n} stocks · one purchase buys all of them, by weight` +
    (anyFeed ? " · • = Chainlink-tightened floor" : "");
  // Each leg IS its bar: the fill is the weight, and the ticker and the figure
  // ride on top of it. The basket reads at a glance because the widths compare,
  // not because anyone reads eight percentages — and it costs one line each.
  // The fill is the weight AGAINST THE HEAVIEST LEG, not against the whole
  // basket: eight legs of 12.5 % each would otherwise be eight identical stubs
  // behind the ticker, which reads as a rendering fault and compares nothing.
  // Relative widths compare exactly the same, and the figure is written in the
  // chip for the absolute.
  const top = Math.max(...s.allocations.map((a) => Number(a.bps)), 1);
  void Promise.all(s.allocations.map(async (a) => {
    const m = await tokenMeta(a.stock);
    const w = Number(a.bps) / 100;
    const feed = a.feed !== ZERO;
    return `<div class="leg" title="${esc(m.symbol)} — ${bps(a.bps)} of every purchase${
      feed ? ", with a Chainlink feed tightening its TWAP floor" : ""
    }">
      <span class="fill" style="width:${((Number(a.bps) / top) * 100).toFixed(1)}%"></span>
      <span class="s">${esc(m.symbol)}${feed ? "<em> •</em>" : ""}</span>
      <span class="w">${w % 1 ? w.toFixed(1) : w.toFixed(0)} %</span>
    </div>`;
  })).then((cards) => { $("rotation").innerHTML = cards.join(""); })
    .catch(() => { /* the basket keeps what it had; the next refresh redraws it */ });
}

/**
 * Graduation gauge.
 *
 * The curve holds a VIRTUAL quote reserve — 1.68 ETH that is not money and was
 * never paid by anyone — so `quoteReserve` alone reads 1.68 on a curve nobody
 * has touched. What graduates is the part above it, and that is also the number
 * Pons itself displays: subtracting the virtual reserve reproduces the
 * interface to the wei.
 *
 * Not on the shop window: `site/` is one static file with no JS at all, and a
 * gauge is not worth turning it into an app.
 */
async function renderGraduation(vaultCurve: Address | null) {
  if (!vaultCurve || vaultCurve === ZERO) {
    $("grad-badge").hidden = true; // no curve to report on
    return;
  }

  const [reserve, graduated] = await Promise.all([
    pub.readContract({ address: vaultCurve, abi: curveAbi, functionName: "quoteReserve" }),
    pub.readContract({ address: vaultCurve, abi: curveAbi, functionName: "graduated" }),
  ]);

  if (graduated) {
    $("grad-badge").innerHTML =
      `<span class="bk">curve</span><span class="bv hl">graduated</span>`;
    $("grad-badge").title = "the curve closed and its liquidity moved to a Uniswap v4 pool";
    $("grad-badge").hidden = false;
    return;
  }

  const { raised, left, pct } = curveProgress(reserve);

  $("grad-badge").innerHTML =
    `<span class="bk">graduation</span><span class="bv">${pct.toFixed(1)} %</span>`;
  // What the card held beyond the percentage. On the badge rather than deleted:
  // three figures nobody reads twice a day still have to be reachable.
  $("grad-badge").title =
    `${Number(formatEther(raised)).toFixed(4)} ETH raised, ${
      Number(formatEther(left)).toFixed(4)} left of the ${
      Number(formatEther(GRADUATION_WEI)).toFixed(1)} ETH threshold — at it the curve closes `
    + "and the liquidity moves to a Uniswap v4 pool";
  $("grad-badge").hidden = false;
}

/**
 * The yield panel: dollars paid to holders, over dollars held.
 *
 * **Why this exists.** Everything the page showed about the cycle was a
 * numerator with no denominator — "0.42 ETH handed to holders", "6 purchases",
 * "36 holders in the tree". A visitor cannot tell from any of it whether their
 * own hundred dollars would have earned a dollar or a hundred, which is the
 * only question they arrived with. Measured on 2026-09-14 the answer was $176
 * per $100 held, and nothing on this page said so.
 *
 * The reads live in `metrics.ts` because the shop window shows the same three
 * numbers from its own bundle; this is only the rendering. The caller does the
 * reading and hands the result over — it also needs `pairId` off the same
 * object for the price chart, and two `readMetrics()` in one render would be
 * two walks of the same nine pools. A read that failed is `null` THERE and this
 * is simply not called; a rate that could not be computed is `null` here and
 * renders as nothing. It must never render as 0 %: "this pays nothing" and "I
 * could not read it" are different sentences, and only one of them is ever true.
 */
function renderYield(m: Metrics): string {
  const y = yieldOf(m);

  const usd = (v: number) =>
    v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
  const window = duration(m.ageSeconds);

  // A rate measured over 39 hours, multiplied by 224 to reach a year, is not a
  // yearly rate — it is a number that makes an honest protocol read like a fraud. It
  // only appears once the window is long enough to have survived a quiet day,
  // and until then the panel says what it actually measured and over how long.
  // **The rate is only shown once it means something.** Under a week of fees it
  // was a card explaining, at length, why its own number could not be
  // annualised — the kind of figure a reader either over-reads or has to be
  // talked out of. Past a week it is a yearly rate with a window behind it, and
  // it earns its place. The shop window quotes `per100` on its own terms and is
  // untouched by this.
  const WEEK = 7 * 24 * 3600;
  const rate = y && m.ageSeconds >= WEEK
    ? cardHtml("Yield", `${y.perYear.toFixed(0)} % / yr`,
        `${usd(y.per100)} per $100 held over the last ${esc(window)}, extrapolated. Paid in equities you keep — nothing is compounded.`)
    : "";

  return (
    cardHtml("Paid to holders", usd(m.paidUsd),
      "of real equities, bought with this token's trading fees and credited to holders — claimable at any time") +
    rate +
    // How many tokens share the dollars above — a count, not a valuation. It
    // showed the dollar value of the eligible supply for a while, which is a
    // number nobody needs: the rate per $100 already carries the division, and
    // restating its denominator in dollars only invites the reader to check
    // arithmetic instead of reading the answer. "Eligible supply" is what
    // `offchain/src/snapshot.ts` has always called this exact quantity.
    cardHtml("Eligible supply", `${millions(m.floatTokens)} tokens`,
      "the ones that actually receive a share. The rest of the supply sits in the Uniswap pool, is burnt, or belongs to the contracts, and earns nothing.") +
    cardHtml("Burnt by us", `${m.burntPct.toFixed(2)} %`,
      "sent to <code>0xdead</code>, where no key exists. Every token of it from the Safe, on 13 September 2026.")
  );
}

/**
 * The token's own price chart, which is the one thing on this page we do not
 * draw ourselves.
 *
 * **Why an embed and not a chart of our own.** An OHLC series means every
 * `Swap` the pool has emitted, and this node caps `eth_getLogs` at 10 000
 * blocks with a head fourteen million blocks past graduation
 * (`artifact.ts` carries the same bound and the bug it fixed). That is a
 * backfill, which is a server — and this app has none by design.
 *
 * DexScreener already indexes this chain, and indexes Uniswap v4 pools under
 * the **poolId itself**, which `metrics.ts` computed on the way to the spot
 * price. So the chart costs one URL and no read at all. Verified 2026-09-28:
 * their `pairAddress` for $PAYD is `0xc667622f…d8fc`, the poolId `v4.ts`
 * derives, to the character.
 *
 * **Every mode draws it**, from two callers: `renderVault` hands over the
 * `pairId` that came free with the metrics it reads, and `refreshMode` — the
 * backing and lottery pages, which build no metrics at all — pays for the one
 * launch read through `pairIdOf`. The section lives outside `#dist-only` for
 * this: that wrapper is hidden wholesale under any mode with no `Distributor`,
 * and a pool belongs to the launch rather than to whatever pays its holders.
 *
 * **It is behind a disclosure, and that is deliberate.** The page issues zero
 * third-party requests — the mark is inlined, the fonts are local, nothing
 * phones home — and an `<iframe>` that loads on sight would end that quietly
 * for every visitor who never wanted a chart. So the frame is built on the
 * first `toggle` and never before: closed, this still costs nothing and tells
 * nobody. The summary says whose site it is, because a reader agreeing to a
 * request should be able to read the name first.
 */
function renderPriceChart(pairId: Hex | null) {
  const host = $("price");
  // Before graduation there is no pool to chart: the token is on the bonding
  // curve, and the gauge above already says how far along it is. An empty
  // section headed "Price" would read as a chart that failed to load.
  host.hidden = !pairId;
  if (!pairId) return;

  // The toggle only ever fires on a `<details>` this function built, and it
  // builds one per render — so the frame is torn down with it and a second
  // render cannot leave two.
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const url = `https://dexscreener.com/robinhood/${pairId}?embed=1&theme=${theme}&info=0&trades=0`;

  host.innerHTML =
    `<div class="rule"><h2>Price</h2><span class="fill"></span>` +
    `<span class="hint">the pool, not the payout</span></div>` +
    `<details class="panel dexchart"><summary>` +
    `Load the price chart <span class="muted">— from dexscreener.com, the only ` +
    `request this page makes to anyone but the chain</span></summary>` +
    `<div class="embed"></div></details>` +
    `<p class="note">The chart is the token's market price. What this protocol ` +
    `pays is the line under <strong>Recent epochs</strong> — the two move for ` +
    `different reasons, and neither predicts the other. ` +
    `<a href="https://dexscreener.com/robinhood/${pairId}" target="_blank" rel="noopener noreferrer">Open it on dexscreener.com</a> instead.</p>`;

  const d = host.querySelector("details")!;
  d.addEventListener("toggle", () => {
    const frame = d.querySelector(".embed")!;
    if (!d.open || frame.firstChild) return;
    const f = document.createElement("iframe");
    f.src = url;
    f.loading = "lazy";
    f.title = "Price chart (dexscreener.com)";
    // The frame is a third party's page: it gets to draw, to script itself and
    // to open a link, and nothing else — no forms, no downloads, no top-level
    // navigation of OUR page.
    //
    // `allow-same-origin` is in the list and has to be. Without it the frame
    // runs in an opaque origin where `localStorage` THROWS, and their app
    // boots into it: measured 2026-09-28, the frame stayed blank for 25 s with
    // it left out. It is not the hole the usual warning describes either —
    // that warning is about framing a SAME-ORIGIN document, which can then
    // reach in and strip its own sandbox. dexscreener.com is cross-origin with
    // this page, so `allow-same-origin` restores their own origin and nothing
    // more; the same-origin policy is what separates us, as with any embed.
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    f.setAttribute("referrerpolicy", "no-referrer");
    frame.appendChild(f);
  });
}

async function renderVault() {
  const [rewards, dev, payout, token, escrow, curve] = await Promise.all([
    readV("rewardsPool") as Promise<bigint>,
    readV("creatorPool") as Promise<bigint>,
    readV("payoutBps") as Promise<bigint>,
    readV("token") as Promise<Address>,
    readV("ESCROW") as Promise<Address>,
    readV("curve") as Promise<Address>,
  ]);

  // What is still sitting at Pons: exactly what a `harvest()` would bring back.
  const pending = await pub
    .readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [FEE_VAULT] })
    .catch(() => 0n);

  // The number a visitor came for: ETH already converted into stock and owed to
  // holders. Summed over the basket rather than over epochs — 10 reads instead
  // of one per epoch since genesis.
  const handedOut = (
    await Promise.all(state!.allocations.map((a) => readD("quoteFundedFor", [a.stock]) as Promise<bigint>))
  ).reduce((x, y) => x + y, 0n);

  // The yield leads, because it is the only thing on this page a visitor can
  // act on. It is also the only panel that can fail without the rest failing —
  // three pools have to answer — so it is awaited separately and degrades to
  // nothing rather than taking the hero down with it.
  //
  // Read ONCE, for two panels: the cards below and the price chart, which needs
  // nothing from the chain that this has not already fetched.
  const metrics = await readMetrics().catch(() => null);
  const yieldCards = metrics ? renderYield(metrics) : "";
  renderPriceChart(metrics?.pairId ?? null);

  // The rate's own result, beside the rate: it answers "does this pay?", which
  // is not a question to leave at the bottom of Advanced.
  $("kpi-handed").textContent = eth(handedOut);
  // Beside it, and no longer in Advanced: what is waiting to become that.
  $("kpi-reserve").textContent = eth(rewards);
  $("kpi-reserve-n").textContent = `paid out at ${bps(payout)} per epoch`;

  // Up in the head, where they are read on both screens. "Paid per epoch" left
  // with them and did not follow: it is the note under "Rewards reserve" on
  // Simple, and the floor it quoted is still in the parameters panel below.
  const harvest = $("hb-harvest");
  harvest.textContent = eth(pending);
  harvest.title = "what a harvest() would bring back from the Pons escrow — anyone can call it";
  $("head-badge").hidden = false;

  $("vault").innerHTML =
    yieldCards +
    cardHtml("Dev share", eth(dev), "to a Safe fixed at deployment");

  // The docs view's figures come from the chain, not from the HTML: a launch
  // with a 4 % tax and one with 0.5 % do not share them, and the page cannot
  // engrave a single set.
  try {
    const e0 = (await readV("economics")) as readonly bigint[];
    const [tax, curveFee, ponsShare, gross] = e0;
    if (gross && gross > 0n) {
      $("doc-fees").innerHTML =
        `Every trade on this token pays <strong>${bps(tax! + curveFee!)}</strong>: ` +
        `${bps(curveFee!)} curve fee plus a ${bps(tax!)} creator tax. ` +
        `<strong>${bps(gross)} of volume is collected for this token</strong> — the tax in full, plus ` +
        `${bps(BigInt(10_000) - ponsShare!)} of the curve fee. Anyone can trigger the collection.`;
    }
  } catch { /* the generic prose stays, it is true of every launch */ }

  // --- Where THIS launch's fees go ----------------------------------------
  //
  // `economics()` returns shares OF TRADED VOLUME, not of the vault: it is what
  // a trader pays, and the only one of the two that compares from one launch to
  // another. The vault returns zeros when a Pons getter moves -- we then show
  // nothing rather than a stale figure.
  try {
    const e = (await readV("economics")) as readonly bigint[];
    const [tax, curveFee, ponsShare, gross, toHolders, toCreator, toPlatform] = e;
    if (gross && gross > 0n) {
      // **Pons's cut, so the bar accounts for everything a trade pays.**
      // `economics` reports it as a share OF THE CURVE FEE, not of volume, so
      // it is the one line here that has to be derived: `curveFee * ponsShare`.
      // The identity that makes this safe to show —
      // `holders + creator + platform + pons === tax + curveFee` — is the
      // contract's own (`gross` is the first three, and the vault takes the tax
      // in full plus what Pons leaves of the curve fee). Without this line the
      // bar summed to `gross` and quietly answered a different question: what
      // reaches the VAULT, not what a trader pays.
      const toPons = (curveFee! * ponsShare!) / 10_000n;
      const paid = tax! + curveFee!;
      const parts: [string, bigint, string, string][] = [
        ["To holders", toHolders!, "var(--ok)", "bought every epoch, in stock, and pushed or claimed"],
        ["To the creator", toCreator!, "var(--mut)", "their compensation, set at launch"],
        ["To the platform", toPlatform!, "var(--dim)", "fixed when this token launched, never raisable"],
        ["To Pons", toPons, "var(--edge)", "the launchpad's share of its own curve fee"],
      ];
      $("kpi-holders").textContent = bps(toHolders!);
      // Beside the name: the whole of what a trade pays, which is the sum this
      // legend ends on. Unhidden only here — a pill showing nothing would
      // claim a token charges nothing.
      const pill = $("tax-pill");
      pill.textContent = bps(paid);
      pill.title = "what every trade pays: the creator tax plus the curve fee";
      pill.hidden = false;
      $("fee-split").innerHTML = parts
        .map(([, v, c]) => `<i style="flex-grow:${Number(v)};background:${c}"></i>`).join("");
      // One line. The sentence each share carried underneath is its `title`:
      // three sub-notes stacked under three rows was four times the height for
      // the same three percentages.
      $("fee-legend").innerHTML = parts
        .map(([k, v, c, n]) =>
          `<span title="${esc(n)}"><span class="sq" style="background:${c}"></span>` +
          `${esc(k)}<span class="fv">${bps(v)}</span></span>`).join("")
        + `<span class="tot" title="the creator's tax in full plus the curve fee">`
        + `of every trade<span class="fv">${bps(paid)}</span></span>`;
      $("fee-split").hidden = false;
    } else {
      // The bar is HIDDEN, not left empty. A bordered strip with nothing in it
      // reads as a measurement that came out at zero, which is a different
      // claim from "we could not read it" — and the wrong one.
      $("fee-split").hidden = true;
      $("fee-legend").innerHTML =
        `<span class="muted">economics unavailable — a Pons getter did not answer</span>`;
    }
  } catch {
    // Same rule on the throwing path: an unread split shows no bar at all.
    $("fee-split").hidden = true;
    $("fee-legend").innerHTML =
      `<span class="muted">economics unavailable — a Pons getter did not answer</span>`;
  }

  // --- The hook's state, as a pill next to the title -----------------------
  try {
    const h = (await readV("hookStatus")) as readonly [number, Address, bigint];
    const HOOK = ["not launched", "collecting", "redirect scheduled", "fees lost"];
    const CLS = ["", "ok", "warn", "bad"];
    const i = Number(h[0]);
    const pill = $("hook-pill");
    pill.textContent = HOOK[i] ?? "";
    pill.className = `pill ${CLS[i] ?? ""}`;
    pill.hidden = false;
  } catch { /* a missing pill beats a wrong one */ }

  if (token !== ZERO) {
    const m = await tokenMeta(token);
    // The LAUNCH's identity goes in the launch's own header, never in the
    // page's. The two used to be the same element, from when this app had one
    // screen: with the index, the Treasury and the creation form now sharing
    // that header, a visitor reading "Launches" under "$PAYD" is being told
    // something false about five of the six views.
    $("launch-title").textContent = m.symbol;
    // The design's one-line summary: the holders' share AS A SHARE OF VOLUME,
    // the epoch length, the basket size. All three come from the chain -- none
    // of them is the same from one launch to another.
    try {
      const e = (await readV("economics")) as readonly bigint[];
      const rew = e[4] ?? 0n;
      $("launch-sub").textContent = rew > 0n
        ? `${bps(rew)} of every trade reaches ${m.symbol} holders as stock · epoch ${
          duration(Number(state!.epochLen))
        } · basket of ${state!.allocations.length}`
        : `epoch ${duration(Number(state!.epochLen))} · basket of ${state!.allocations.length}`;
    } catch { /* the summary is a convenience, not data */ }
    // The address a reader copies, and the one place they can buy. Written
    // here because this is where the token is finally known — the head draws
    // before `token()` has answered, and an empty pill offering "Buy" would be
    // a link to nowhere.
    $("ca-text").textContent = short(token);
    ($("ca-copy") as HTMLButtonElement).dataset.full = token;
    ($("pons-buy") as HTMLAnchorElement).href = PONS_TOKEN_URL + token;
    $("token-elsewhere").innerHTML = TOKEN_ELSEWHERE
      .map((s) => `<a href="${esc(s.url(token))}" rel="noopener" target="_blank">${esc(s.name)}</a>`)
      .join("");
    $("launch-ca").hidden = false;

    $("addresses").innerHTML = [
      ["token", token], ["fee vault", FEE_VAULT], ["distributor", DISTRIBUTOR],
    ].map(([k, a]) => `<a href="${EXPLORER}/address/${a}">${k} ${short(a as string)}</a>`).join("");
  }
  return { token, payout, curve };
}

/** State of the cumulative root — the thing that makes shares claimable. */
async function loadRoots() {
  const [rootCount, activeRoot, keeper, quoteAtRisk] = await Promise.all([
    readD("rootCount") as Promise<bigint>,
    readD("activeRoot") as Promise<bigint>,
    readD("keeper") as Promise<`0x${string}`>,
    readD("quoteAtRisk") as Promise<bigint>,
  ]);
  const last = rootCount === 0n
    ? null
    : ((await readD("roots", [rootCount])) as State["last"]);
  return { rootCount, activeRoot, keeper, quoteAtRisk, last };
}

/**
 * The banner the holder reads. It answers ONE question — when do I get paid —
 * and nothing else.
 *
 * The root cycle is a SETTLEMENT detail. The page used to show
 * `state: in challenge window` with a progress bar, which handed the holder a
 * vocabulary to learn for a mechanism that asks nothing of them.
 *
 * Since the move to the keeper model the root takes effect IMMEDIATELY: there
 * is no countdown left at all. What remains to announce is the end of the
 * current epoch, then the automatic airdrop.
 */
function renderNextPayout(s: State) {
  const box = $("next-payout");
  if (!s.last) {
    box.innerHTML =
      `<div class="summary"><div class="stack">` +
      `<span class="k">Next payout</span>` +
      `<span class="v warn">preparing the first one</span>` +
      `</div></div>`;
    return;
  }
  const [, publishedAt, , , upToEpoch] = s.last;
  const ago = Math.floor(Date.now() / 1000) - Number(publishedAt);
  box.innerHTML =
    `<div class="summary">` +
    `<div class="stack"><span class="k">Your shares</span><span class="v ok">ready to collect</span></div>` +
    `<div class="stack"><span class="k">Settled through</span><span class="v">epoch #${upToEpoch}</span></div>` +
    `<div class="stack"><span class="k">Last update</span><span class="v">${duration(ago)} ago</span></div>` +
    `<div class="grow"></div>` +
    `<span class="hint">they arrive on their own within 24 h — or collect them now below</span>` +
    `</div>`;
}

function renderRoot(s: State) {
  if (!s.last) {
    $("root").innerHTML = `<div class="k">Root</div><div class="v warn">none published yet</div>`;
    $("root-steps").innerHTML = "";
    return;
  }
  const [publisher, publishedAt, , , upToEpoch, digest] = s.last;
  const ago = Math.floor(Date.now() / 1000) - Number(publishedAt);

  $("root").innerHTML =
    `<div style="display:flex;gap:2.125rem;flex-wrap:wrap">` +
      `<div class="stack"><span class="k">Active root</span><span class="v ok">#${s.activeRoot}</span></div>` +
      `<div class="stack"><span class="k">Covers up to</span><span class="v">epoch #${upToEpoch}</span></div>` +
      `<div class="stack"><span class="k">Published</span><span class="v">${duration(ago)} ago</span></div>` +
    `</div>` +
    `<div style="margin-top:.875rem;padding-top:.875rem;border-top:1px solid var(--hair)">` +
      `<div class="k">Published by</div><div class="digest">${esc(publisher)}</div>` +
      `<div class="note" style="margin-top:.5rem">Only this address can publish a root, and the ` +
      `timelock is the only thing that can change it — with 48 h of public notice.</div>` +
    `</div>` +
    `<div style="margin-top:.875rem;padding-top:.875rem;border-top:1px solid var(--hair)">` +
      `<div class="k">At risk right now</div>` +
      `<div class="v">${(Number(s.quoteAtRisk) / 1e18).toFixed(6)} ETH</div>` +
      `<div class="note" style="margin-top:.25rem">Everything funded but not yet delivered — the ` +
      `exact amount a compromised keeper key could take. Deliveries run continuously, so it stays ` +
      `around one epoch.</div>` +
    `</div>` +
    `<div style="margin-top:.875rem;padding-top:.875rem;border-top:1px solid var(--hair)">` +
      `<div class="k">Published digest</div><div class="digest">${esc(digest)}</div>` +
      `<div class="note" style="margin-top:.25rem">Epoch data is fetched through a gateway, then checked ` +
      `against this sha256. A gateway serving anything else is rejected.</div>` +
    `</div>`;

  const pip = (color: string, filled: boolean) =>
    `<span class="pip" style="${filled ? `background:${color}` : `background:var(--surface);border:1.5px solid ${color}`}"></span>`;
  const steps: [string, string, string, boolean][] = [
    ["Epoch ends", "its balances are the time-weighted average over the whole epoch", "var(--ok)", true],
    ["Basket bought", "one purchase covers every epoch since the last one", "var(--ok)", true],
    ["Root published", `takes effect immediately · ${duration(ago)} ago`, "var(--ok)", true],
    ["Shares collectable", "claim any time, or wait for the automatic airdrop", "var(--ok)", true],
  ];
  $("root-steps").innerHTML = steps
    .map(([label, note, color, filled], i) =>
      `<div class="step"><div class="gut">${pip(color, filled)}` +
      `${i < steps.length - 1 ? '<span class="line"></span>' : ""}</div>` +
      `<div class="txt"><b${filled ? "" : ' class="muted"'}>${esc(label)}</b><span class="note">${esc(note)}</span></div></div>`)
    .join("");
}

/**
 * `Delivered`, field for field with `Distributor.sol`. `abi.test.ts` fails if it
 * drifts, which is the point of declaring it here rather than inline.
 */
const DELIVERED = parseAbiItem(
  "event Delivered(address indexed holder, address indexed stock, address indexed caller, uint256 amount)",
);

/** How far back "recent" reaches, in `LOG_SPAN` windows of ~15 min. Bounded on
 *  purpose — the whole history of deliveries is thousands of logs and this is a
 *  panel, not an archive. `claim` and the artifact are the archive.
 *
 *  **It used to be one query over 250 000 blocks, and the node refuses any
 *  range over 10 000** (`chain.ts`, `LOG_SPAN`): the panel had been showing
 *  "the node would not serve this block range" rather than the pushes. Six
 *  windows is ~1.5 h, read in parallel, and a window the node still refuses
 *  costs that window and not the panel. */
const PUSH_WINDOWS = 6;
const PUSH_LOOKBACK = LOG_SPAN * BigInt(PUSH_WINDOWS);

/**
 * Recent PUSHES, one row per `distribute` transaction.
 *
 * **"Recent epochs" says what was BOUGHT; this says what was DELIVERED, and the
 * whole of 2026-09-13 is the argument for showing both.** The purchases ran all
 * night and looked healthy while the five equities read `totalDistributed = 0`,
 * and nothing on this page would have shown it: a visitor could see their share
 * credited and had no way to see that nobody was being paid. Two defects hid
 * there for fourteen hours.
 *
 * Grouped by transaction because that is what a push IS since the floor became
 * the holder's: one call settles every line a wallet is owed, so one row is one
 * wallet being made whole.
 */
async function renderPushes() {
  let logs;
  try {
    logs = await logsBack(
      (fromBlock, toBlock) =>
        pub.getLogs({ address: DISTRIBUTOR, event: DELIVERED, fromBlock, toBlock }),
      PUSH_WINDOWS,
    );
  } catch {
    // A node that will not serve the range must not blank the panel with a lie:
    // "no push" and "I could not look" are different sentences.
    $("pushes").innerHTML = `<tr><td colspan="5" class="muted">the node would not serve this block range</td></tr>`;
    return;
  }
  if (logs.length === 0) {
    $("pushes").innerHTML = `<tr><td colspan="5" class="muted">no delivery in the last ${int(PUSH_LOOKBACK)} blocks</td></tr>`;
    return;
  }

  type Push = { block: bigint; holder: Address; lines: { stock: Address; amount: bigint }[] };
  const byTx = new Map<string, Push>();
  for (const l of logs) {
    const a = (l as { args?: { holder?: Address; stock?: Address; amount?: bigint } }).args;
    if (!a?.holder || !a.stock || a.amount === undefined) continue;
    const tx = l.transactionHash as string;
    const cur = byTx.get(tx) ?? { block: l.blockNumber ?? 0n, holder: a.holder, lines: [] };
    cur.lines.push({ stock: a.stock, amount: a.amount });
    byTx.set(tx, cur);
  }

  // Newest first, and only as many as the table shows: the timestamps below are
  // one read per distinct block and there is no reason to pay for rows nobody
  // will see.
  const shown = [...byTx.entries()].reverse().slice(0, HISTORY);
  const stamps = new Map<bigint, number>();
  for (const b of new Set(shown.map(([, p]) => p.block))) {
    try {
      stamps.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp));
    } catch { /* the row falls back to its block number */ }
  }

  const now = Math.floor(Date.now() / 1000) + chainSkew;
  const rows = await Promise.all(shown.map(async ([tx, p]) => {
    const legs = await Promise.all(p.lines.map(async (l) => {
      const m = await tokenMeta(l.stock);
      return `${esc(Number(formatUnits(l.amount, m.decimals)).toFixed(4))} ${esc(m.symbol)}`;
    }));
    const ts = stamps.get(p.block);
    return `<tr>` +
      `<td class="mono">${ts ? `${esc(duration(now - ts))} ago` : `block ${int(p.block)}`}</td>` +
      `<td class="mono"><a href="${EXPLORER}/address/${p.holder}">${esc(short(p.holder))}</a></td>` +
      `<td class="num">${p.lines.length}</td>` +
      `<td class="mono">${esc(legs.join(" · "))}</td>` +
      `<td class="mono"><a href="${EXPLORER}/tx/${tx}">${esc(short(tx))}</a></td></tr>`;
  }));
  $("pushes").innerHTML = rows.join("");
}

/**
 * The purchase history, read from the ARTIFACT rather than from the chain.
 *
 * It used to walk `epochStock` / `epochFunded` / `epochEthSpent`, one epoch at
 * a time. Those getters are gone with the per-epoch model: a purchase covers a
 * WINDOW of epochs and buys the whole basket, so there is no such thing as an
 * epoch's stock any more. The artifact carries exactly that shape, it is
 * already loaded, and it is verified against `Root.digest` — so this reads the
 * committed data instead of ten reads per row.
 */
async function renderHistory(a: Artifact | null) {
  if (!a || a.windows.length === 0) {
    $("epochs").innerHTML = `<tr><td colspan="4" class="muted">no purchase yet</td></tr>`;
    $("epochs-spark").innerHTML = "";
    return;
  }

  // Drawn before the rows and awaited after them: the table below is bounded at
  // twelve rows, the line covers every window since genesis, and neither waits
  // on the other.
  const line = historyLine(a);

  const rows: string[] = [];
  for (const w of [...a.windows].reverse().slice(0, HISTORY)) {
    const span = w.fromEpoch === w.toEpoch ? `#${w.fromEpoch}` : `#${w.fromEpoch}–${w.toEpoch}`;
    const legs = await Promise.all(
      w.stocks.map(async (stock, i) => {
        const m = await tokenMeta(stock as Address);
        return `${esc(Number(formatUnits(BigInt(w.amounts[i]!), m.decimals)).toFixed(4))} ${esc(m.symbol)}`;
      }),
    );
    rows.push(
      `<tr><td class="mono">${span}</td>` +
      // The amounts ARE the basket: a column repeating "5 stocks" beside them
      // said nothing the cell did not, and cost the width that made them wrap.
      `<td class="num mono">${esc(legs.join(" · "))}</td>` +
      `<td class="num mono">${esc(String(w.transferBlocks))}</td>` +
      `<td><span class="pill ok">bought</span></td></tr>`,
    );
  }
  $("epochs").innerHTML = rows.join("");
  $("epochs-spark").innerHTML = await line;
}

/**
 * `usdPrice` is three reads per stock. The basket repeats on every window, so
 * it is paid for once per (stock, tier) and not once per row — the same
 * memoisation, for the same reason, that `cards.ts` puts around the same call.
 * A pool that will not answer memoises as `NaN`, so it is not retried nine
 * times on the way to the same silence.
 */
const stockUsd = new Map<string, Promise<number>>();
function priceOf(stock: Address, poolFee: number, decimals: number): Promise<number> {
  const k = `${stock.toLowerCase()}:${poolFee}`;
  if (!stockUsd.has(k)) stockUsd.set(k, usdPrice(stock, poolFee, decimals).catch(() => NaN));
  return stockUsd.get(k)!;
}

/**
 * The purchase history as one line: dollars bought for holders, cumulative.
 *
 * **Why a chart at all, next to a table that has the same numbers.** The table
 * answers "what happened at epoch #212". It cannot answer "is this
 * accelerating", which is the question every reader of a series actually has,
 * and which twelve rows of five different tickers actively hide.
 *
 * **Why dollars.** The artifact carries per-stock amounts and no common unit —
 * `epoch.ts` forwards no `quoteSpent`, as the table's own headers note — so
 * four legs of NVDA, TSLA, COIN and USDG cannot be added up without a price.
 * Priced at TODAY's spot, like the "Paid to holders" card above, which is what
 * makes the line's last point that card's figure rather than a second opinion
 * on it. It is therefore what holders own now, not what each purchase cost on
 * the day — the caption says so, because those are different numbers and a
 * reader is entitled to know which one is drawn.
 *
 * Returns the empty string rather than a broken line whenever it cannot be
 * honest: fewer than two purchases (`spark` refuses), or a leg whose stock has
 * left the basket. That second one matters — with no allocation there is no
 * tier, and `usdPrice(t, 0)` answers "a dollar", which is right for USDG and
 * wrong for every other equity. A line quietly too low is worse than no line.
 */
async function historyLine(a: Artifact): Promise<string> {
  const fees = new Map(state!.allocations.map((al) => [al.stock.toLowerCase(), al.poolFee]));

  const per: number[] = [];
  for (const w of a.windows) {
    let usd = 0;
    for (let i = 0; i < w.stocks.length; i++) {
      const stock = w.stocks[i]! as Address;
      const fee = fees.get(stock.toLowerCase());
      if (fee === undefined) return "";
      const m = await tokenMeta(stock);
      usd += Number(formatUnits(BigInt(w.amounts[i]!), m.decimals)) * (await priceOf(stock, fee, m.decimals));
    }
    per.push(usd);
  }

  const series = cumulative(per);
  // The box the path is computed in. It is stretched to the panel's width by
  // `preserveAspectRatio="none"`, which is why the stroke carries
  // `vector-effect` and why the end dot is a CSS box and not a `<circle>`: an
  // unevenly scaled circle is an ellipse.
  const W = 720, H = 96;
  const s = spark(series, W, H);
  if (!s) return "";

  const total = series[series.length - 1]!;
  const money = (v: number) =>
    v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;

  return (
    `<figure class="spark"><div class="plot">` +
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${
      esc(`Cumulative value bought for holders over ${series.length} purchases, ending at ${money(total)}`)
    }">` +
    `<path d="${s.area}" fill="var(--accent)" fill-opacity=".09"/>` +
    `<polyline points="${s.points}" fill="none" stroke="var(--accent)" stroke-width="1.5"` +
    ` stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `</svg>` +
    `<span class="tip" style="left:${(s.last.x / W) * 100}%;top:${(s.last.y / H) * 100}%"></span></div>` +
    `<figcaption><strong>${esc(money(total))}</strong> of equities bought for holders over ${
      int(series.length)} purchase${series.length === 1 ? "" : "s"}, cumulative — valued at ` +
    `today's prices, not the price on the day of each purchase.</figcaption>` +
    `</figure>`
  );
}

// -------------------------------------------------------------------- stats

async function renderStats(s: State) {
  const a = s.artifact;
  $("stats-source").textContent = a
    ? `derived from the hash-verified data of root #${s.activeRoot}`
    : "epoch data unavailable — on-chain reads only";

  const holders = a ? new Set(a.entries.map((e) => e.holder.toLowerCase())).size : 0;
  const pushable = a ? a.entries.filter((e) => e.push).length : 0;
  const rewards = (await readV("rewardsPool")) as bigint;

  $("stats-hero").innerHTML =
    cardHtml("Epochs covered", a ? `#${a.upToEpoch}` : "—", "by the active root") +
    cardHtml("Purchases", a ? int(a.windows.length) : "—", "each one bought the whole basket") +
    cardHtml("Holders in the tree", a ? int(holders) : "—", "above the eligibility threshold") +
    cardHtml("Airdropped pairs", a ? int(pushable) : "—", "holder × stock, delivered for free") +
    cardHtml("Rewards reserve", eth(rewards), "waiting to be spent on stocks");

  // Split of what is collected. These are fractions of WHAT COMES IN, not
  // points of volume: the label has to say so (§S11).
  const [rw, pf] = await Promise.all([
    readV("rewardsBps") as Promise<bigint>,
    readV("PLATFORM_BPS") as Promise<bigint>,
  ]);
  // The creator's share is the RESIDUE — there is no getter for it because the
  // contract never stores it, so the front derives it the same way `harvest`
  // does. Reading a number that does not exist on chain would be the surest way
  // to display one that has drifted.
  const cr = 10_000n - rw - pf;
  const parts: [string, bigint, string, string][] = [
    ["Rewards", rw, "var(--ok)", "buying the stocks and distributing them to holders — this share can only go up"],
    // --mut and not --accent: --ok and --accent are the same lime, so the parts
    // of a split bar have to differ by something other than the brand.
    ["Creator", cr, "var(--mut)", "the residue, and what pays the gas of running the cycle"],
    ["Platform", pf, "var(--dim)", "fixed when this token launched, and never raisable on it"],
  ];
  // A segment carries its own label only when it is wide enough to hold it. At
  // `platformBps = 0` the last one has `flex-grow: 0` and no width at all, and
  // its "0.00 %" spilled over the segment beside it — a number printed on top
  // of a share it does not describe. The legend below says every figure
  // anyway, so the one that does not fit simply goes unlabelled.
  const total = parts.reduce((t, [, v]) => t + v, 0n);
  const wide = (v: bigint) => total > 0n && (v * 100n) / total >= 8n;
  $("flow").innerHTML = parts
    .map(([, v, c]) =>
      `<i style="flex-grow:${Number(v)};background:${c}">${wide(v) ? bps(v) : ""}</i>`).join("");
  $("flow-legend").innerHTML = parts
    .map(([label, v, c, note]) =>
      `<div><span class="sq" style="background:${c}"></span><div class="stack">` +
      `<b style="font-size:.8125rem;font-weight:500">${label}</b>` +
      `<span class="note">${note}</span>` +
      // Percent, like the rest of the product. This line said "8,109 bps of
      // what is collected" directly under a bar segment labelled "81.09 %" —
      // the same quantity twice, once in a unit only a solidity file thinks in.
      `<span class="note mono" style="margin-top:.15rem">${pct(Number(v))} of what is collected</span></div></div>`)
    .join("");

  // Basket: bought / distributed per stock, and which epoch it comes round again.
  const rows = await Promise.all(s.allocations.map(async (al, i) => {
    const [m, funded, dist] = await Promise.all([
      tokenMeta(al.stock),
      readD("totalFunded", [al.stock]) as Promise<bigint>,
      readD("totalDistributed", [al.stock]) as Promise<bigint>,
    ]);
    const pct = funded === 0n ? 0 : Number((dist * 10000n) / funded) / 100;
    return `<tr>` +
      `<td><strong>${esc(m.symbol)}</strong></td>` +
      `<td class="num">${bps(al.bps)}</td>` +
      // Tier 0 is the USDG line: transferred as-is, never swapped, so there is
      // no pool, no floor and no oracle to name (`FeeVault._setAllocations`
      // refuses tier 0 on anything else).
      `<td class="num muted">${al.poolFee === 0 ? "—" : `${(al.poolFee / 10000).toFixed(2)} %`}</td>` +
      `<td><span class="pill${al.poolFee !== 0 && al.feed === ZERO ? " warn" : ""}">` +
        `${al.poolFee === 0 ? "held as-is" : al.feed === ZERO ? "TWAP only" : "Chainlink + TWAP"}</span></td>` +
      `<td class="num">${esc(Number(formatUnits(funded, m.decimals)).toFixed(6))}</td>` +
      `<td class="num muted">${esc(Number(formatUnits(dist, m.decimals)).toFixed(6))}</td>` +
      `<td class="num muted">${pct.toFixed(1)} %</td>` +
      `</tr>`;
  }));
  $("stats-stocks").innerHTML = rows.join("");

  // `quoteAtRisk` is the whole exposure story now that there is no bond: it is
  // the ETH already funded but not yet delivered, i.e. exactly what a leaked
  // keeper key could misallocate. Nothing else is at stake, so nothing else is
  // shown here.
  $("stats-root").innerHTML =
    cardHtml("Active root", s.activeRoot === 0n ? "none" : `#${s.activeRoot}`) +
    cardHtml("Published so far", int(s.rootCount)) +
    cardHtml("Effect", "immediate", "no challenge window") +
    cardHtml("At risk right now", eth(s.quoteAtRisk, 3), "ETH funded but not yet delivered — the exact exposure if the keeper key leaks") +
    cardHtml("Publisher", `${s.keeper.slice(0, 6)}…${s.keeper.slice(-4)}`, "the only address that can publish; timelock can rotate it in 48 h");

  $("stats-elig").innerHTML =
    cardHtml("Holders in the tree", a ? int(holders) : "—") +
    cardHtml("Pairs in the tree", a ? int(a.entries.length) : "—", "holder × stock") +
    cardHtml("Above airdrop threshold", a ? int(pushable) : "—", "delivered without asking") +
    // `artifact.excluded` is the TIMELOCK's discretionary list and only that —
    // the seven structural exclusions (address 0, 0xdead, the v4 PoolManager,
    // the token, the Pons curve, the Distributor and the FeeVault) are applied
    // by `structuralExclusions` and never appear in it. The old label read
    // "pools, curve, contracts", which named exactly the addresses this number
    // does NOT count, so an empty discretionary list looked like the pool being
    // paid.
    cardHtml(
      "Excluded by the timelock",
      a ? int(a.excluded.length) : "—",
      "discretionary, 48 h of notice — on top of the seven structural ones (address 0, 0xdead, "
        + "the v4 PoolManager, the token, the Pons curve, the Distributor, the FeeVault), always excluded",
    );

  // `ROTATION_STRIDE` used to be read here and displayed as "unused". It no
  // longer is: the constant and `allocationOf` were removed from the vault on
  // 2026-09-09 -- 1 322 bytes for a rotation design replaced long ago, and the
  // vault was 1 576 bytes above the EIP-170 cap. Reading them would revert.
  const [maxBatch, maxRefund, twap, slip, payout, minPayout] =
    await Promise.all([
      readD("MAX_BATCH") as Promise<bigint>,
      readD("MAX_REFUND") as Promise<bigint>,
      readV("TWAP_WINDOW") as Promise<number>,
      readV("MAX_SLIPPAGE_BPS") as Promise<bigint>,
      readV("payoutBps") as Promise<bigint>,
      readV("MIN_PAYOUT_BPS") as Promise<bigint>,
    ]);

  const param = (k: string, v: string, tl = false) =>
    `<div class="card"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:baseline;flex-wrap:wrap">` +
    `<span class="mono note">${esc(k)}</span><span class="pill${tl ? " warn" : ""}">${tl ? "timelock" : "immutable"}</span></div>` +
    `<div class="v" style="font-size:1rem">${esc(v)}</div></div>`;

  $("stats-params").innerHTML =
    param("EPOCH_LENGTH", duration(Number(s.epochLen))) +
    // `distGasBps` appeared here as "3 %" and designated NO constant of the
    // Distributor -- a leftover from an earlier sizing, displayed as a real
    // parameter next to constants that are actually read. `MAX_REFUND` is the
    // real bound on the refund, and it is further down.
    param("payoutBps", bps(payout), true) +
    param(
      `allocations[${s.allocations.length}]`,
      s.allocations.every((a) => a.bps === s.allocations[0]!.bps)
        ? `${s.allocations.length} × ${bps(s.allocations[0]!.bps)}`
        : s.allocations.map((a) => bps(a.bps)).join(" · "),
      true,
    ) +
    param("MIN_PAYOUT_BPS", bps(minPayout)) +
    param("MAX_BATCH", int(maxBatch)) +
    param("MAX_REFUND", eth(maxRefund, 3)) +
    param("TWAP_WINDOW", duration(Number(twap))) +
    param("MAX_SLIPPAGE_BPS", bps(slip));
}

// -------------------------------------------------------------------- claim

/**
 * The smallest balance an epoch pays — half of the badge beside the
 * Simple/Advanced switch, read on both screens.
 *
 * The bar is NOT recomputed here. `applyFloor` lives in the keeper
 * (`offchain/src/eligibility.ts`) and a second implementation in the browser
 * would drift the day either side changed: the page would then advertise a
 * number of tokens that does not buy a share. We read the `minBalance` the
 * keeper ACTUALLY used for the last covered epoch, out of the artifact whose
 * sha256 the contract published — so it is as verified as the amounts.
 *
 * It is a HINT about the next epoch, not a promise: the bar moves with the
 * cumulative fees and with what the other holders hold. It only ever falls as
 * fees come in, so a holder who clears it today does not get pushed out by
 * revenue — only by other people buying more.
 *
 * It used to be a panel of its own — a bar, the viewer's balance and a status
 * line — beside "Next payout". Three figures and a progress bar to carry one
 * number the reader can act on, in a panel a wallet had to be connected to
 * read at all. Then a card in Advanced, which is one click too far for the
 * number that says whether this page pays you at all.
 */
async function renderEligibility() {
  const s = state;
  const v = document.getElementById("hb-bar");
  if (!s || !v) return;

  // The sentence the card carried underneath rides on the `title`: a badge has
  // room for the figure, and the explanation is read once.
  const say = (value: string, why: string, cls = "sm") => {
    v.textContent = value;
    v.className = `bv ${cls}`;
    v.title = why;
  };

  // `minBalance` is checked for presence, not just the epoch: the artifact comes
  // from a gateway, and this page is pinned on IPFS while the keeper that
  // produces the field lives in the repo. A keeper still on the previous format
  // would otherwise hand `BigInt(undefined)` a throw, and the startup catch
  // turns that into "cannot read the chain" across the WHOLE page.
  const last = s.artifact?.windows.at(-1);
  if (!s.token || !last || last.minBalance === undefined) {
    say("set at the first epoch", "hold the token before the first root is published and you are in it");
    return;
  }

  const m = await tokenMeta(s.token);
  const bar = BigInt(last.minBalance);

  // `applyFloor` waives the bar when nobody clears it — early on, that is every
  // epoch. Announcing "0 tokens needed" would be true and unreadable.
  if (bar === 0n) {
    say("none right now", "too few holders for a bar — every holder is in the tree", "hl");
    return;
  }

  const tok = Number(formatUnits(bar, m.decimals)).toLocaleString("en-US", { maximumFractionDigits: 0 });
  say(
    `${tok} $${m.symbol}`,
    `the smallest balance epoch #${last.toEpoch} paid. A VALUE — whatever is worth ~$0.50 of ` +
    `share — not a slice of supply, so it falls as fees come in.`,
    "",
  );
}

/** The head's first figure: what is waiting for this address, priced in ETH
 *  the way `_one` prices it, and how many lines that is. Every exit of
 *  `renderClaims` goes through it — a KPI left on "—" after a real answer is
 *  read as "nothing", which is the one thing this screen must not say by
 *  accident. */
function kpiYours(v: string, note: string) {
  $("kpi-yours").textContent = v;
  $("kpi-yours-n").textContent = note;
}

async function renderClaims() {
  const s = state;
  if (!s) {
    // Reachable before the first refresh lands. Leaving the table untouched
    // here is what made a failed load look like a settled "nothing owed".
    $("claims").innerHTML = `<p class="note">Reading the chain…</p>`;
    kpiYours("—", "reading the chain…");
    return;
  }
  const btn = $("claim") as HTMLButtonElement;

  if (!account) {
    $("claims").innerHTML =
      `<p class="note">Paste an address in the field at the top of this page — or connect a wallet — ` +
      `to see the shares it is owed. Reading asks for no signature.</p>`;
    $("claim-count").textContent = "—";
    $("claim-epochs").textContent = s.artifact ? `#${s.artifact.upToEpoch}` : "—";
    kpiYours("—", "paste an address above, or connect a wallet, to see what is waiting");
    btn.disabled = true;
    return;
  }
  if (!s.artifact) {
    $("claims").innerHTML = `<p class="note">Epoch data unavailable from every gateway tried.</p>`;
    kpiYours("—", "epoch data unavailable from every gateway tried");
    btn.disabled = true;
    return;
  }

  const mine = s.artifact.entries.filter((e) => e.holder.toLowerCase() === account!.toLowerCase());
  if (mine.length === 0) {
    $("claims").innerHTML = `<p class="note">No share for this address in the active root.</p>`;
    $("claim-count").textContent = "0";
    kpiYours(eth(0n), "no share for this address in the active root");
    btn.disabled = true;
    return;
  }

  const rows = await Promise.all(mine.map(async (e) => {
    const [m, paid, owed, ethIn, funded] = await Promise.all([
      tokenMeta(e.stock as Address),
      readD("claimedSoFar", [account, e.stock]) as Promise<bigint>,
      readD("owedTo", [account, e.stock, BigInt(e.cumulative)]) as Promise<bigint>,
      readD("quoteFundedFor", [e.stock]) as Promise<bigint>,
      readD("totalFunded", [e.stock]) as Promise<bigint>,
    ]);
    const f = (v: bigint) => Number(formatUnits(v, m.decimals)).toFixed(6);
    // What this share cost the vault in ETH — the same ratio `_one` uses to
    // decrement `quoteAtRisk`. Priced this way the claim needs no oracle: gas and
    // reward are both in ETH, and the comparison is exact rather than indicative.
    const backing = funded > 0n ? (owed * ethIn) / funded : 0n;
    const due = owed > 0n;
    const total = BigInt(e.cumulative);
    // How much of everything this stock has ever credited is already in the
    // wallet. The basket's cell uses its bar for the weight; here the same bar
    // answers "how far along am I", which is the only proportion in the numbers.
    const got = total > 0n ? Number((paid * 1000n) / total) / 10 : 0;
    return {
      owed, backing, stock: e.stock as Address, cumulative: total,
      html: `<label class="claimcell" data-due="${due ? 1 : 0}">` +
        `<input type="checkbox" data-stock="${esc(e.stock)}"${due ? " checked" : " disabled"}>` +
        `<span class="cs">${esc(m.symbol)}</span>` +
        `<span class="cw">${f(owed)}</span>` +
        `<span class="cbar"><i style="width:${got.toFixed(1)}%"></i></span>` +
        // "In your wallet" was this column's header and `claimedSoFar` was its
        // value — what the CONTRACT has paid out, which stops being the wallet's
        // balance the moment somebody sells. Named for what it is.
        `<span class="cn">${f(paid)} received · ${f(total)} earned</span>` +
        `</label>`,
    };
  }));

  $("claims").innerHTML = rows.map((r) => r.html).join("");
  $("claim-epochs").textContent = `#${s.artifact.upToEpoch}`;
  selectable = rows.filter((r) => r.owed > 0n).map((r) => ({ stock: r.stock, backing: r.backing }));
  kpiYours(
    eth(selectable.reduce((t, r) => t + r.backing, 0n)),
    selectable.length === 0
      ? "everything already paid out"
      : `${selectable.length} line${selectable.length > 1 ? "s" : ""} of stock ready`,
  );
  renderClaimCost();
  if (selectable.length === 0 && rows.length > 0) log("everything already paid out");
}

/** The stocks with something waiting, and what each is worth to the vault. */
let selectable: { stock: Address; backing: bigint }[] = [];

/** Addresses whose box is ticked, read from the table rather than mirrored. */
function selected(): Set<string> {
  const boxes = $("claims").querySelectorAll<HTMLInputElement>("input[data-stock]:checked");
  return new Set(Array.from(boxes, (b) => b.dataset.stock!.toLowerCase()));
}

/** Put the ticks back after a re-render, so the table shows what will be sent. */
function restoreSelection(pick: Set<string>) {
  for (const b of Array.from($("claims").querySelectorAll<HTMLInputElement>("input[data-stock]"))) {
    if (!b.disabled) b.checked = pick.has(b.dataset.stock!.toLowerCase());
  }
  renderClaimCost();
}

/**
 * Prices the ticked rows and says so plainly.
 *
 * Claiming ten stocks is ten transfers in one transaction, so the gas scales
 * with the number of boxes, not with the amount — and at this scale that bill
 * can be larger than what it collects. The page used to send all ten and let
 * the wallet quote a number with nothing to compare it against. Shares are
 * cumulative and nothing expires, so "wait" and "take three of them" are both
 * real answers; the holder can only pick one if they are shown the trade.
 */
function renderClaimCost() {
  const btn = $("claim") as HTMLButtonElement;
  const pick = selected();
  const rows = selectable.filter((r) => pick.has(r.stock.toLowerCase()));
  const worth = rows.reduce((sum, r) => sum + r.backing, 0n);
  const gas = (CLAIM_BASE_GAS + SETTLE_GAS * BigInt(rows.length)) * baseFee;

  $("claim-count").textContent = `${rows.length} of ${selectable.length}`;
  // A pasted address can be READ in full and signed for by nobody: the wallet
  // would refuse an account it does not hold, and a button that only ever
  // produces that refusal is worse than a disabled one that says why.
  btn.disabled = rows.length === 0 || !connected;
  btn.textContent = connected || !account ? "Collect now" : "Connect to collect";
  ($("claim-all") as HTMLInputElement).checked =
    selectable.length > 0 && rows.length === selectable.length;

  const box = $("claim-cost");
  if (rows.length === 0 || baseFee === 0n) { box.textContent = ""; box.className = "hint"; return; }
  if (!connected) {
    box.className = "hint";
    box.textContent = "reading only — connect this wallet to collect what it is owed";
    return;
  }
  // Warn from the point where the gas eats a quarter of the reward. The keeper
  // draws its own line at 5 % for a PUSHED delivery (PUSH_K_MIN, epoch.ts), but
  // it is spending the vault's money on a $10 share; here the holder is
  // spending their own, on whatever they have, and they may well accept a worse
  // ratio to be paid today. Warn, never block.
  const bad = worth === 0n || gas * 4n > worth;
  box.className = bad ? "hint warn" : "hint";
  box.textContent =
    `~${eth(gas, 5)} of gas to collect ${eth(worth, 5)} of stock` +
    (bad ? " — the gas costs more than a quarter of it. Shares are cumulative: waiting loses nothing." : "");
}

/** True while a claim is in flight. `refresh` replaces `state` wholesale, and
 *  doing that under a transaction being built would swap the artifact its
 *  proofs came from. The claim already re-reads the root itself, so it needs no
 *  help — it needs to be left alone. */
let claiming = false;

async function doClaim() {
  const s = state;
  if (!s || !account || !s.artifact) return;
  // The button is disabled without a wallet; this is the belt to that braces,
  // because `writeContract` below signs AS `account`.
  if (!connected) return log("connect this wallet to collect — a pasted address can only be read");
  const btn = $("claim") as HTMLButtonElement;
  btn.disabled = true;
  claiming = true;
  try {
    // The ticks, read FIRST and never re-read. Everything below can re-render
    // the table — the root check does, on purpose — and a fresh render ticks
    // every row again. Reading the selection afterwards would silently send the
    // stocks the holder had just unticked, and charge them for the gas.
    const pick = selected();

    // A proof is only valid against the root it was built from, and the keeper
    // publishes a new one every epoch — so a tab left open through a
    // publication holds proofs the contract will reject. `_settle` reverts the
    // WHOLE batch on the first `InvalidProof`, which means a stale page cannot
    // claim at all, and the wallet shows a bare "execution reverted" that
    // explains nothing. One read costs less than one failed transaction.
    const live = (await readD("activeRoot")) as bigint;
    if (live !== s.activeRoot) {
      log(`root #${live} was published since this page loaded — refreshing proofs`);
      const fresh = (await readD("roots", [live])) as State["last"];
      const [, , , , , freshDigest] = fresh!;
      s.artifact = await fetchArtifact(DISTRIBUTOR, freshDigest, live);
      s.activeRoot = live;
      s.last = fresh;
      renderRoot(s);
      await renderClaims();
      restoreSelection(pick);
    }
    if (!s.artifact) {
      log("the new root's data could not be fetched — nothing was sent");
      btn.disabled = false;
      return;
    }

    log("building proofs…");
    const { stocks, cumulative, proofs } = await buildClaim(DISTRIBUTOR, account, s.artifact, pick);
    if (stocks.length === 0) { log("nothing to claim"); btn.disabled = false; return; }

    log(`${stocks.length} stock(s) to claim — one transfer each, whatever the elapsed time`);
    const eth1193 = provider();
    if (!eth1193) { log("connect a wallet first — the Connect button, top right"); btn.disabled = false; return; }
    if (!(await ensureChain(eth1193, log))) { btn.disabled = false; return; }
    const wallet = createWalletClient({ account, chain, transport: custom(eth1193) });
    const hash = await wallet.writeContract({
      address: DISTRIBUTOR, abi: distributorAbi, functionName: "claim",
      args: [stocks, cumulative, proofs], account, chain,
    });
    log(`transaction sent: ${hash}`);
    await pub.waitForTransactionReceipt({ hash });
    log(`claimed. ${EXPLORER}/tx/${hash}`);
    await renderClaims();
  } catch (e) {
    log("failed: " + String((e as Error).message).split("\n")[0]);
    btn.disabled = false;
  } finally {
    claiming = false;
  }
}

// ---------------------------------------------------------------- interface

/**
 * The six views, and the ONE navigation over them.
 *
 * The index, the Treasury and the creation screen used to replace
 * `document.body` wholesale. That is what made three of the four screens look
 * like a different product: no header, no tabs, no footer, no way back except
 * a link each had invented for itself. They are views now, mounted into their
 * own `<section>` the first time they are opened, and the chrome above and
 * below them never moves.
 *
 * Which tabs exist depends on what the page has: a launch in scope reveals
 * "This launch" and "Protocol stats", a registry reveals "Launches" and
 * "Create a vault", a Treasury address reveals "Treasury". "Docs" is always
 * there because it needs nothing.
 */
/** Views whose markup is injected by their module, and the module that does
 *  it. Mounted lazily: opening the app must not make three sets of chain reads
 *  when the visitor asked for one screen. */
const MOUNT: Partial<Record<View, (host: HTMLElement) => Promise<void>>> = {
  index: renderLaunchpad,
  treasury: renderTreasury,
  create: renderCreate,
};
const mounted = new Set<View>();

/**
 * The views the launch READS are for, and the view on screen.
 *
 * `refresh()` is the expensive one — the epoch, the graduation curve, the fee
 * split, the basket, the vault's pockets, the root, the claims table, the two
 * log walks. It ran on load and every 60 s whatever was on screen, so opening
 * the registry index of a one-vault deployment cost 59 requests, most of them
 * for a `<section hidden>`. It is lazy now, like the index, the Treasury and
 * the creation screen already were, and the interval skips a tick that nobody
 * is looking at.
 *
 * `docs` is NOT in the set. It prints one number, the epoch length, and pulling
 * the whole launch state for it cost 23 requests where a single
 * `EPOCH_LENGTH()` costs one — which the start-up does directly, whatever view
 * is open.
 */
const LIVE = new Set<View>(["app", "stats"]);
let onScreen: View | null = null;
/** Set by the startup path once it is safe to read — a deployment with no vault
 *  configured must never reach `refresh`. */
let kick: (() => void) | null = null;

/** The hash makes each view linkable: the vitrine at `paydprotocol.eth` points
 *  straight at `#docs`, and a shared link lands where it says. Anything else
 *  (the docs' own `#d1…#d7` anchors) is left alone. */
/** The views that are about no vault in particular. The rail and the switcher
 *  chip are hidden on them: on the creation form a column of links throws away
 *  what is being typed, and on the docs it is furniture. */
const NO_RAIL = new Set<View>(["create", "docs"]);

/**
 * Whether the launch on screen is **$PAYD's own**, which is the only thing the
 * tab called "$PAYD" may mean.
 *
 * `?token=` points the same view at any launch in the registry — that is how
 * the list opens one — and the tab stayed selected and stayed named over
 * somebody else's page. So a reader walking the registry was, as far as the
 * navigation was concerned, permanently inside $PAYD's own page.
 *
 * A launch that is not $PAYD's belongs to the REGISTRY: the Tokens tab is the
 * one marked while its page is open, and "$PAYD" goes back to being a link to
 * $PAYD.
 */
const OWN = FEE_VAULT.toLowerCase() === OWN_VAULT.toLowerCase();
/** `?mock` has to survive the one navigation this file makes. */
const KEEP = new URLSearchParams(location.search).has("mock") ? "?mock" : "";

function show(view: string) {
  if (!isView(view)) return;
  // A tab this deployment never revealed — `#stats` on a backing vault, `#create`
  // with no registry — is refused rather than drawn: the section would come up
  // empty, with no tab to leave it by. `route.ts` makes the same decision for
  // the view that OPENS; this is the same rule for every hash after it.
  const own = document.querySelector<HTMLButtonElement>(`nav button[data-view="${view}"]`);
  if (own?.hidden) return;
  onScreen = view;
  const frame = document.getElementById("frame");
  if (frame) frame.setAttribute("data-rail", NO_RAIL.has(view) ? "0" : "1");
  const chip = document.getElementById("vchip");
  if (chip) chip.hidden = NO_RAIL.has(view) || !REGISTRY;
  if (LIVE.has(view)) kick?.();
  // Opening Stats with the state already in hand: draw it now rather than on
  // the next 60-second tick, which is what `kick` alone would have meant once
  // the launch view had already read.
  if (view === "stats" && state) aside("protocol stats", renderStats(state));
  // The section follows the view; the TAB follows what that view belongs to.
  // They are the same thing except on one page: another launch's, which is a
  // page of the registry and is marked as such.
  const marked = view === "app" && !OWN ? "index" : view;
  for (const o of Array.from(document.querySelectorAll<HTMLButtonElement>("nav button"))) {
    o.setAttribute("aria-selected", String(o.dataset.view === marked));
    const sec = document.getElementById(`view-${o.dataset.view}`);
    if (sec) sec.hidden = o.dataset.view !== view;
  }
  const mount = MOUNT[view];
  if (mount && !mounted.has(view)) {
    mounted.add(view);
    const host = $(`view-${view}`);
    host.innerHTML = `<p class="note" style="padding:2.75rem 0">reading the chain…</p>`;
    void mount(host).catch((e: Error) => {
      // A view that cannot load says so where it would have drawn. It must not
      // take the tabs or the other views down with it.
      mounted.delete(view);
      host.innerHTML =
        `<p class="note" style="padding:2.75rem 0">cannot read the chain: ${esc(e.message)}</p>`;
    });
  }
}

/** Reveals a tab. A tab nobody can reach is worse than no tab. */
function tab(view: View, label?: string): void {
  const b = document.querySelector<HTMLButtonElement>(`nav button[data-view="${view}"]`);
  if (!b) return;
  b.hidden = false;
  if (label) b.textContent = label;
}

/**
 * Every `data-view` element is a view switch, wherever it comes from.
 *
 * **Delegated on the document, and it used to be one listener per element bound
 * at import.** That reached the tabs and the back link, which are in
 * `index.html` — and nothing a view RENDERS, because those elements do not
 * exist yet when this file runs. The Tokens grid's "Launch a token" cell is
 * built by `registry.ts` on every paint and was a button that did nothing,
 * which is the shape of failure a static binding always has: the markup is
 * right, the attribute is right, and there is no handler.
 *
 * One listener also means a view can ship a `data-view` anywhere without a
 * second edit here, which is the only reason the attribute is a convention
 * rather than a function call.
 */
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-view]");
  if (!b) return;
  const view = b.dataset.view!;
  // From another launch's page, "$PAYD" means $PAYD's — and the address
  // a page reads is fixed at load (`?vault=`), so this one tab is a real
  // navigation rather than a view switch. Without it the tab redisplayed the
  // page it was already on.
  if (view === "app" && !OWN) { location.href = `./index.html${KEEP}#app`; return; }
  if (view === onScreen) return;
  show(view);
  // PUSH, not replace. Every tab used to overwrite the same entry, so the
  // browser's Back button left the app entirely from whatever view you had
  // reached — including the one case that matters, coming back to the list
  // after opening a launch. A view is a place; it gets an entry.
  history.pushState(null, "", "#" + view);
});

/**
 * Back, Forward, and a hash typed or pasted into the bar.
 *
 * `popstate` fires for the history entries above; `hashchange` covers the rest,
 * including the vitrine's `#docs` link arriving while the app is already open.
 * Without either, the URL moved and the screen did not — the page then showed
 * one view and claimed to be another, which survives a reload as the wrong
 * view.
 */
const fromHash = () => {
  const h = location.hash.slice(1);
  // The docs' own anchors (`#d1`…`#d7`) are not views and must scroll, not
  // navigate. A view whose tab this deployment never revealed is not one
  // either: `show` refuses it and the screen stays where it is.
  if (isView(h) && h !== onScreen) show(h);
};
addEventListener("popstate", fromHash);
addEventListener("hashchange", fromHash);

/**
 * Simple / Advanced, on the launch view.
 *
 * `Simple` is the screen a holder opens every day: four figures and what is
 * waiting for them. `Advanced` reveals the rest — the two gauges, the fee
 * split, the basket, the vault's pockets, the settlement details and the two
 * logs. Nothing is fetched by the switch: `#adv` is rendered either way, so
 * the figures are as fresh on the first click as on the tenth. Deleting that
 * content to match a mockup would have deleted the only place several of those
 * numbers exist.
 */
function advancedOpen(): boolean {
  return document.getElementById("adv")?.hidden === false;
}

/** The two log walks Advanced owns, run the moment it is revealed rather than
 *  on the next 60-second tick — a panel that opens empty and fills a minute
 *  later reads as a panel with nothing in it. */
function openAdvanced(): void {
  if (!state) return;
  aside("the purchase history", renderHistory(state.artifact ?? null));
  aside("recent pushes", renderPushes());
}

{
  const group = document.getElementById("app-mode");
  group?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    for (const o of Array.from(group.querySelectorAll("button"))) {
      o.setAttribute("aria-pressed", String(o === b));
    }
    const open = b.dataset.adv === "1";
    const was = advancedOpen();
    $("adv").hidden = !open;
    if (open && !was) openAdvanced();
  });
}

// ------------------------------------------------------- who we are looking at

/**
 * The paste-an-address checker.
 *
 * Every figure this app shows about an address is a `view` call, so a wallet
 * buys nothing but the ability to SIGN. Somebody who wants to know what a
 * launch owes them — or what it owes anybody — should not have to connect one,
 * and plenty of holders keep their keys somewhere that will never meet a
 * browser. `?address=0x…` does the same thing and makes a position linkable.
 */
{
  const form = document.getElementById("peek") as HTMLFormElement | null;
  const input = document.getElementById("peek-addr") as HTMLInputElement | null;
  const clear = document.getElementById("peek-clear") as HTMLButtonElement | null;

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const a = parseAddress(input!.value);
    if (!a) {
      // A mistyped address must fail HERE. Sent through, it reads as a
      // stranger who happens to hold nothing — which is a wrong answer
      // wearing the costume of a right one.
      input!.classList.add("bad");
      input!.setAttribute("title", "not an address — 0x followed by 40 hex characters");
      return;
    }
    input!.classList.remove("bad");
    setViewer(a, false);
  });
  input?.addEventListener("input", () => input.classList.remove("bad"));
  clear?.addEventListener("click", () => setViewer(null, false));
}

/**
 * The header's network state, and the strip that explains it.
 *
 * One painter for both, because they answer the same question and must never
 * disagree: a dot saying `--bad` over a page with no strip is a reader with
 * nowhere to go, and a strip over a green dot is nonsense.
 *
 * **Nothing is drawn while the answer is unknown.** `walletChain` is `null`
 * until a wallet has been chosen AND has answered `eth_chainId`, and a wrong
 * network is a claim about somebody's wallet — made on a guess it is worse
 * than silence. A pasted address has no network at all, which is why this reads
 * `connected` and not `viewer`.
 */
function paintNetwork(): void {
  const wrong = onWrongNetwork();
  const dot = document.getElementById("connect-dot");
  const lab = document.getElementById("connect-lab");
  const strip = document.getElementById("netnotice");
  if (dot) {
    dot.hidden = !connected;
    dot.className = `netdot${wrong ? " bad" : ""}`;
  }
  if (lab) {
    lab.textContent = !connected
      ? "Connect"
      : wrong
      ? `${short(viewer!)} · wrong network`
      : short(viewer!);
  }
  if (strip) strip.hidden = !(connected && wrong);
}

{
  // `ensureChain` is what the sign buttons already call, so the strip's button
  // is the same door reached earlier rather than a second implementation of
  // switching.
  const go = document.getElementById("netswitch") as HTMLButtonElement | null;
  go?.addEventListener("click", async () => {
    const eth = provider();
    if (!eth) return;
    go.disabled = true;
    try { await ensureChain(eth, log); } finally { go.disabled = false; }
    // `chainChanged` repaints on its own when the wallet obeys; this covers the
    // wallet that switched without telling us.
    await watchNetwork(eth);
  });
  // A network change is not a viewer change, so it needs its own subscription:
  // switching chains in MetaMask fires neither `accountsChanged` nor anything
  // this page listened to, and the header went on saying the old answer until
  // a reload.
  onNetwork(paintNetwork);
}

/** Every screen re-reads from here, so the header, the index and the launch
 *  page can never end up showing two different people. */
onViewer(() => {
  const a = viewer;
  account = a;
  const input = document.getElementById("peek-addr") as HTMLInputElement | null;
  const clear = document.getElementById("peek-clear") as HTMLButtonElement | null;
  if (input) input.value = a && !connected ? a : "";
  if (clear) clear.hidden = !a || connected;
  $("account").textContent = a ? short(a) : "";
  paintNetwork();

  const claimAcct = document.getElementById("claim-account");
  if (claimAcct) claimAcct.textContent = a ? short(a) : "";
  // The strip answers "who is this page looking at". A connected wallet has
  // already answered it, in the header, so the whole thing goes — field
  // included: offering to look somebody else up beside a Collect button that
  // would still sign as YOU is an invitation to a mistake.
  const strip = document.getElementById("viewing");
  if (strip) strip.hidden = connected;
  const banner = document.getElementById("peek-banner");
  if (banner) {
    banner.hidden = !a || connected;
    if (a && !connected) {
      banner.innerHTML =
        `Showing what this app can read about <b>${esc(a)}</b>. Everything below is a view call — ` +
        `no wallet was asked for anything. Collecting needs that wallet connected.`;
    }
  }
  // The way back, on a launch that is not $PAYD's: the marked tab says where
  // this page belongs, and this says it where the reader is looking.
  if (!OWN && REGISTRY) {
    const back = document.getElementById("launch-back");
    if (back) back.hidden = false;
  }

  if (pay !== "claim") { void refreshMode().catch(() => { /* the 60-second tick tries again */ }); return; }
  if (state) void renderClaims();
});

/**
 * Connecting, once a wallet has been chosen.
 *
 * `useWallet` first and everything else after: the account request, the chain
 * switch and every later signature all reach the wallet through `provider()`,
 * so the pick has to be recorded before any of them run — otherwise the
 * visitor approves a QR code and the next write goes to the extension they
 * did not choose.
 */
async function connectWith(opt: WalletOption): Promise<void> {
  const eth = await opt.open();
  useWallet(eth);
  // The OTHER side can end this. A WalletConnect session is closed from the
  // phone as often as from here, and an extension can revoke the permission
  // from its own UI — in both cases the header would go on showing an address
  // over a wallet that refuses the next signature, which is the connected
  // state's version of a button that does nothing. Listening costs one line
  // and is the only way this page hears about it.
  (eth as Eth1193 & { on?: (e: string, f: () => void) => void })
    .on?.("disconnect", () => { void forget(); });
  const [a] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!a) { log("the wallet returned no account"); return; }
  await ensureChain(eth, log);
  setViewer(a as Address, true);
  log("");
  await renderClaims();
}

/** Disconnecting: the session where there is one, then the page back to what a
 *  visitor who never connected sees. `setViewer` repaints every screen through
 *  its subscribers, so nothing else here has to know it happened. */
async function forget(): Promise<void> {
  // Nothing to let go of. This is the guard on a path with two callers and no
  // ordering between them: the button, and a `disconnect` event that our own
  // call to the button's path is what provokes. Without it every reconnection
  // leaves one more listener behind, and each of them repaints the claims.
  if (!connected) return;
  await disconnect();
  setViewer(null, false);
  log("");
  await renderClaims();
}

/**
 * The Connect button, and the menu it opens when there is a choice.
 *
 * One option is not a choice: a menu holding a single row is a second click
 * for nothing, so it connects straight away. The menu appears when several
 * extensions announced themselves, or when WalletConnect sits beside them.
 */
{
  const menu = $("wallets");
  const btn = $("connect") as HTMLButtonElement;
  const show = (open: boolean) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  // Outside click and Escape, because a menu that only closes by choosing from
  // it is a menu the visitor is stuck in.
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !(e.target as Element | null)?.closest?.(".wal")) show(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") show(false); });

  btn.addEventListener("click", async () => {
    if (!menu.hidden) return show(false);
    // The menu is wallets again, and nothing else. It held the address field
    // for a while — which made "Connect" the only way to reach the one control
    // a visitor with no wallet can use, and made the first row they saw a
    // WalletConnect QR code. The field is in the flow now, above every view.
    // Connected, so the button carries an address and the only thing left to
    // do to it is let it go. One row, and the rule above — a single option
    // connects straight away rather than opening a menu — deliberately does
    // NOT apply: that rule is about saving a click on the way IN. On the way
    // out the menu IS the confirmation, and the alternative is an address pill
    // that disconnects you when you mis-click it.
    if (connected) {
      return rows([{ name: "Disconnect", run: forget }]);
    }
    const options = walletOptions();
    if (options.length === 0) {
      // Nothing to choose from, so nothing to open. An empty menu was the
      // right answer only while it still held the address field; with the
      // field back in the flow it is a dead end again. Say what this visitor
      // CAN do — looking needs no wallet — and put the cursor in the field
      // that does it, which is the first thing under the tabs.
      show(false);
      log("No wallet detected in this browser. Reading needs none: check any address in the field at the top of the page.");
      ($("peek-addr") as HTMLInputElement).focus();
      return;
    }
    if (options.length === 1) {
      try { await connectWith(options[0]!); }
      catch (e) { log("failed: " + String((e as Error).message).split("\n")[0]); }
      return;
    }
    rows(options.map((o) => ({
      name: o.name,
      icon: o.icon,
      run: async () => { log(`opening ${o.name}…`); await connectWith(o); },
    })));
  });

  /** Fills the menu and opens it. Every row closes it first, then runs, then
   *  reports its own failure — a menu left open over an error message is a
   *  menu the visitor clicks again. */
  function rows(items: Array<{ name: string; icon?: string; run: () => Promise<void> }>) {
    const menu = $("wallet-rows");
    menu.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "menuitem");
      // The icon is a data URI the wallet announced about itself, so it costs
      // no request. A row that has none simply shows its name.
      row.innerHTML =
        (it.icon ? `<img src="${esc(it.icon)}" alt="" />` : "") + `<span>${esc(it.name)}</span>`;
      row.addEventListener("click", async () => {
        show(false);
        try { await it.run(); }
        catch (e) { log("failed: " + String((e as Error).message).split("\n")[0]); }
      });
      menu.appendChild(row);
    }
    show(true);
  }
}

$("claim").addEventListener("click", doClaim);

/**
 * Copying the token's address.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused
 * outright, and a button that silently does nothing is worse than no button —
 * so the failure falls back to selecting the text, which leaves the reader one
 * keystroke from the same result instead of empty-handed.
 */
$("ca-copy").addEventListener("click", () => {
  const btn = $("ca-copy") as HTMLButtonElement;
  const full = btn.dataset.full;
  if (!full) return;
  const said = (m: string) => {
    const el = $("ca-text");
    const was = el.textContent;
    el.textContent = m;
    btn.classList.add("done");
    setTimeout(() => { el.textContent = was; btn.classList.remove("done"); }, 1200);
  };
  navigator.clipboard?.writeText(full).then(() => said("copied"), () => select());
  function select() {
    const r = document.createRange();
    r.selectNodeContents($("ca-text"));
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
});

// Delegated: the rows are replaced wholesale on every refresh, so a listener
// bound to a checkbox would not survive the next minute.
$("claims").addEventListener("change", renderClaimCost);
$("claim-all").addEventListener("change", (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  const boxes = $("claims").querySelectorAll<HTMLInputElement>("input[data-stock]:not(:disabled)");
  for (const b of Array.from(boxes)) b.checked = on;
  renderClaimCost();
});

/**
 * Re-reads the chain and repaints. Called once at startup and then on a timer.
 *
 * The artifact is the one thing NOT refetched every time: it is an IPFS fetch
 * and its content cannot change without `activeRoot` changing, since the
 * contract publishes the digest of that exact bytes. So it is fetched when the
 * root moves, and only then.
 */
async function refresh() {
  if (claiming) return;
  // BEFORE `loadEpoch`, which is a `Distributor` call: a backing vault has no
  // distributor to answer it, and everything below would throw one read at a
  // time until `firstRead` gave up on a page that is perfectly readable.
  if (pay !== "claim") return refreshMode();

  const [ep, roots] = await Promise.all([loadEpoch(), loadRoots()]);
  const previousRoot = state?.activeRoot ?? -1n;
  const keptArtifact = roots.activeRoot === previousRoot ? state?.artifact ?? null : null;
  state = { ...ep, ...roots, artifact: keptArtifact, token: state?.token ?? null };

  renderEpoch(state);
  renderNextPayout(state);
  renderRoot(state);
  const { token, curve } = await renderVault();
  state.token = token === ZERO ? null : token;
  aside("graduation", renderGraduation(curve));

  // **The portfolio mode uses BOTH halves of this page**, which is why its
  // panel is drawn from here and not from `refreshMode()`. It claims like the
  // distribution mode — its tree names one stock, the pivot, so the table above
  // pays dollars — and it adds the one thing no other mode has: a row the
  // holder writes, saying what those dollars are converted into on delivery.
  //
  // Failures are swallowed to the panel's own message line rather than thrown:
  // the claim table above has already rendered, and a book that will not answer
  // must not take a page that pays down with it.
  if (mode === "portfolio") {
    const host = $("mode-panel");
    void (async () => {
      // Both dynamic: this mode's panel and the allowlist walk it needs are
      // dead weight on every launch page that is not a portfolio, and the
      // allowlist is `create.ts`'s — one cached log walk for the whole app
      // rather than a second one here.
      const [{ renderPortfolio }, { allowlist }] = await Promise.all([
        import("./portfolio.js"),
        import("./create.js"),
      ]);
      const stocks = REGISTRY ? await allowlist(REGISTRY) : [];
      await renderPortfolio(host, DISTRIBUTOR, stocks);
    })().catch(() => { /* the 60-second tick tries again */ });
  }

  if (state.activeRoot > 0n && !state.artifact) {
    const active = (await readD("roots", [state.activeRoot])) as State["last"];
    const [, , , , , digest] = active!;
    state.artifact = await fetchArtifact(DISTRIBUTOR, digest, state.activeRoot);
  }
  // AFTER the fetch, not before. On a fresh load `keptArtifact` is null, so
  // called above this table announced "no purchase yet" over a full history —
  // and stayed wrong until the 60-second refresh came round with an artifact
  // in hand. The history is drawn from the artifact; it waits for it.
  //
  // And only when Advanced is open. Both of these tables live down there, and
  // each is a walk of six log windows — twelve `eth_getLogs` every 60 seconds
  // for two `<div hidden>`. `openAdvanced` runs them the moment the panel is
  // revealed, so nothing is lost but the reading of what nobody is looking at.
  if (advancedOpen()) aside("the purchase history", renderHistory(state.artifact ?? null));
  // One call for three: the block carries the number for the footer, the
  // timestamp the countdown needs to stop trusting the visitor's clock, and the
  // basefee the claim panel prices its gas with. It is read BEFORE the panels
  // because `renderClaims` quotes that basefee — read after, the first paint of
  // a fresh page would quote a gas cost of zero.
  const head = await pub.getBlock({ blockTag: "latest" });
  chainSkew = Number(head.timestamp) - Math.floor(Date.now() / 1000);
  baseFee = head.baseFeePerGas ?? 0n;
  $("foot-block").textContent = `block ${int(head.number ?? 0n)}`;
  // `void` like the other tables: a log range the node refuses must not hold up
  // the panels that only need `call`. It reads its own head — the windows are
  // counted back from it, not from this one.
  if (advancedOpen()) aside("recent pushes", renderPushes());

  await renderClaims();
  await renderEligibility();
  // Same rule one view up: the Stats screen is a section of its own, and
  // reading it while the launch view is on screen pays for a hidden one.
  if (onScreen === "stats") aside("protocol stats", renderStats(state));
  // Green again. The dot is set red by any failed read, and only the read that
  // succeeds afterwards knows it is over — set only in the start-up loop, it
  // stayed red for the rest of the session on a page that had recovered.
  $("net-dot").className = "dot";
}

// ------------------------------------------------------------------ startup

(async () => {
  // `?registry=0x…` turns this into the index of every launch. A MODE and not
  // a second page: two HTML entry points would split the bundle, and the build
  // guarantees one JS file so there is one CID to pin and no import that can
  // fail depending on the gateway.
  // The fixture world installs BEFORE any routing: tested afterwards, the index
  // and Treasury modes went off to read the real chain and were not viewable
  // without a deployment. `import.meta.env.DEV` folds to false at build time, so
  // this branch and the module behind it are never shipped.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    (await import("./mock.js")).install();
  }

  const asked = new URLSearchParams(location.search);
  const hasVault = DISTRIBUTOR !== ZERO && FEE_VAULT !== ZERO;

  // The MODE first: it decides which tabs mean anything and which half of the
  // launch view is drawn. One call, and a failure leaves it `unknown` — which
  // draws a page that says so instead of a claim table that cannot work.
  if (hasVault) {
    mode = await readMode(
      (registry, vault) => pub.readContract({
        address: registry, abi: modeAbi, functionName: "modeOf", args: [vault],
      }) as Promise<Hex>,
      REGISTRY,
      FEE_VAULT,
    );
    pay = payScreen(mode);
  }

  // Reveal the tabs this deployment actually has, then choose which one opens.
  if (REGISTRY) { tab("index"); tab("create"); }
  if (TREASURY) tab("treasury");
  // `stats` reads the distribution root, stock by stock: there is none under
  // the other modes, so the tab is not offered rather than opened on errors.
  if (hasVault) { tab("app"); if (pay === "claim") tab("stats"); }

  if (pay !== "claim") {
    $("dist-only").hidden = true;
    $("app-kpis").hidden = true;
    // Simple / Advanced toggles `#adv`, which lives in the half just hidden.
    const seg = document.getElementById("app-mode");
    if (seg) seg.hidden = true;
  }

  // WHICH VIEW OPENS — the decision itself is in `route.ts`, held to its order
  // by `route.test.ts`, because the bug it replaces was one of order and no
  // type or build step sees an order.
  const opening: View = route({
    hash: location.hash.slice(1),
    query: asked,
    hasRegistry: REGISTRY !== null,
    hasTreasury: TREASURY !== null,
    hasVault,
    // Stats reads a distribution root, stock by stock. Under any other payout
    // mode there is none, which is why its tab is not revealed either.
    hasStats: hasVault && pay === "claim",
  });
  // Whatever opens is reachable by its own tab, even in a build that has
  // nothing configured: that page's only content is the line saying so, and
  // `show` refuses a view whose tab is hidden.
  tab(opening);
  show(opening);

  // The vault switcher, filled whatever view opened. The Vaults view fills it
  // itself when it paints; every other view — a shared link to ONE launch,
  // above all — used to leave it empty, which is exactly where a switcher is
  // the only way from one vault to another.
  if (REGISTRY && opening !== "index") {
    void loadRail().catch(() => { /* the rail says so itself; the view is not affected */ });
  }

  // An address in the query string makes a position linkable, and it is read
  // before any rendering so the first paint already has the right person.
  const fromUrl = addressFromQuery();
  if (fromUrl) setViewer(fromUrl, false);

  if (!hasVault) {
    // The notice goes in the app view, never in the header: the landing is
    // static and stays readable with no deployment, and a visitor should not
    // be met with a configuration error.
    if (opening === "app") {
      log("Addresses not configured — pass ?token=0x…&distributor=0x… or rebuild with the right values.");
      $("net-dot").className = "dot off";
    }
    return;
  }
  // An epoch lasts 30 minutes and the page is meant to be left open, so
  // everything on it goes stale on its own. A minute is short against an epoch
  // and long against the RPC.
  //
  // It is installed UNCONDITIONALLY, and BEFORE the first refresh is awaited.
  // It used to sit after `await refresh()` inside the `try` below — so one
  // transient failure at load (a 429 from the RPC, a gateway that took too
  // long) skipped it, and the page then never tried again. It stayed
  // half-rendered for as long as it was left open, with an empty "Your stocks"
  // table that is indistinguishable from "you are owed nothing", and the reason
  // in the header subtitle where nobody reading that table would look for it.
  // The recovery has to outlive the failure it exists to recover from.
  setInterval(() => {
    // Nothing on screen is derived from this read: skip the tick rather than
    // pay for a hidden section every minute, for as long as the tab is open.
    if (!onScreen || !LIVE.has(onScreen)) return;
    void refresh().catch(() => { /* the next tick tries again */ });
  }, 60_000);

  // The docs' one number, on its own. It is the only thing that view reads, and
  // it must not drag the launch view's twenty-odd requests behind it.
  void (readD("EPOCH_LENGTH") as Promise<bigint>)
    .then((len) => { $("doc-epoch-len").textContent = duration(Number(len)); })
    .catch(() => { /* the docs read fine without it */ });

  // The first load retries fast, because a minute of a blank page is a minute
  // the reader spends concluding the site is broken. It waits, though, until one
  // of the views that needs it is actually open.
  let first: Promise<void> | null = null;
  kick = () => { first ??= firstRead(); };
  if (onScreen && LIVE.has(onScreen)) kick();
  await first;
})();

/**
 * The launch page under a mode that does not pay by claim.
 *
 * It renders ONE panel and reads nothing else: the KPI row, the gauges and the
 * fee split are all derived from a `Distributor` (or, for the split, from a
 * vault read whose figures only mean anything next to a claim), so they are
 * hidden rather than half-filled. Each mode's panel carries the figures that
 * are true for it.
 */
async function refreshMode(): Promise<void> {
  const host = $("mode-panel");
  // The head, which `renderVault` writes on the claim path and which nothing
  // would write here: a launch page whose title stays "—" and whose subtitle is
  // blank reads as a page that failed, not as one whose mode is elsewhere.
  try {
    const token = (await readV("token")) as Address;
    if (token !== ZERO) {
      $("launch-title").textContent = (await tokenMeta(token)).symbol;
      // Every mode's token graduates into the same kind of pool, so every mode
      // gets the same chart. `renderVault` reads this id off the metrics it was
      // building anyway; here there are no metrics to build, so it costs the
      // one launch read `pairIdOf` makes.
      renderPriceChart(await pairIdOf(token));
    }
  } catch { /* the panels below say what could not be read */ }
  $("launch-sub").textContent = modeBlurb(mode);
  if (pay === "redeem") { await renderBacking(host, FEE_VAULT); return; }
  if (pay === "draw") { await renderLottery(host, FEE_VAULT); return; }
  // A mode this build has never heard of. Said plainly, with the addresses to
  // look at — not drawn as an empty version of somebody else's screen.
  host.hidden = false;
  host.innerHTML =
    `<div class="card" style="margin-top:1.25rem"><div class="k">Unknown payout mode</div>`
    + `<p class="note">${esc(modeBlurb("unknown"))} This page can read the contract at `
    + `<code>${esc(FEE_VAULT)}</code> on <a href="${EXPLORER}/address/${esc(FEE_VAULT)}">the explorer</a>, `
    + `and an updated build of this app will know how to draw it.</p></div>`;
}

async function firstRead(): Promise<void> {
  for (let attempt = 1;; attempt++) {
    try {
      await refresh();
      $("net-dot").className = "dot";
      break;
    } catch (e) {
      const why = String((e as Error).message).split("\n")[0]!.slice(0, 140);
      $("net-dot").className = "dot off";
      if (attempt >= 4) {
        $("subtitle").textContent = "Cannot read the chain: " + why;
        // AND where the reader is actually looking. A table that says nothing
        // is read as an answer, not as a failure.
        $("claims").innerHTML =
          `<tr><td colspan="4" class="muted">Could not read the chain — still retrying every minute. ` +
          `Nothing here means "not read yet", not "nothing owed". ${esc(why)}</td></tr>`;
        break;
      }
      await new Promise((r) => setTimeout(r, attempt * 1_500));
    }
  }
}
