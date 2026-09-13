import {
  createWalletClient, custom, formatEther, formatUnits,
  type Address, type Hex,
} from "viem";
import { DISTRIBUTOR, FEE_VAULT, EXPLORER, PROJECT_NAME, RPC_URL, CHAIN_ID } from "./config.js";
import { REGISTRY, renderLaunchpad } from "./registry.js";
import { TREASURY, renderTreasury } from "./treasury.js";
import { pub, chain, distributorAbi, vaultAbi, escrowAbi, erc20Abi, curveAbi, provider, ensureChain } from "./chain.js";
import { fetchArtifact, buildClaim, type Artifact } from "./artifact.js";
import { curveProgress, GRADUATION_WEI } from "./curve.js";

const $ = (id: string) => document.getElementById(id)!;
const log = (m: string) => ($("log").textContent = m);
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const ZERO = "0x0000000000000000000000000000000000000000";
const HISTORY = 12;

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ------------------------------------------------------------------- format

const bps = (v: bigint | number) => `${(Number(v) / 100).toFixed(2)} %`;
const eth = (v: bigint, d = 4) => `${Number(formatEther(v)).toFixed(d)} ETH`;
const int = (v: bigint | number) => Number(v).toLocaleString("en-US");

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
    const elapsed = Number(s.epochLen) - Math.max(0, left);
    // The epoch number goes up into the card's header, as in the design: it
    // identifies the gauge, it is not one of its measurements.
    $("epoch-n").textContent = `#${s.epoch}`;
    $("epoch").innerHTML =
      `<div class="cell"><span class="k">Closes in</span><span class="v">${countdown(left)}</span></div>` +
      `<div class="sep"></div>` +
      `<div class="cell"><span class="k">Waiting to buy</span><span class="v sm">${s.pending} epoch${
        s.pending === 1n ? "" : "s"
      }</span></div>` +
      `<div class="sep"></div>` +
      `<div class="cell"><span class="k">Epoch length</span><span class="v sm">${
        duration(Number(s.epochLen))
      }</span></div>`;
    $("epoch-bar").setAttribute(
      "style",
      `width:${Math.min(100, Math.max(0, (elapsed / Number(s.epochLen)) * 100)).toFixed(1)}%`,
    );

    // The epoch has turned. Waiting for the next scheduled refresh would leave
    // "ended" on screen for up to a minute and then jump — so ask for the new
    // one now. Debounced, because this runs every second and `currentEpoch`
    // only moves when a block lands past the boundary.
    if (left <= 0 && Date.now() - lastRoll > 10_000) {
      lastRoll = Date.now();
      void refresh();
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
  $("rotation-hint").textContent = `${n} stocks · every purchase buys all of them, by weight`;
  // Each row carries its weight AND a bar to scale: in the mockup, the basket
  // reads at a glance because the widths compare, not because anyone reads eight
  // percentages.
  void Promise.all(s.allocations.map(async (a) => {
    const m = await tokenMeta(a.stock);
    const w = (Number(a.bps) / 100).toFixed(0);
    return `<div class="cell2">
      <div class="top"><span class="s">${esc(m.symbol)}</span> <span class="w">${bps(a.bps)}</span></div>
      <div class="barmini bw"><i style="width:${w}%"></i></div>
    </div>`;
  })).then((cards) => { $("rotation").innerHTML = cards.join(""); });
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
  const box = $("graduation");
  const bar = $("graduation-bar");

  if (!vaultCurve || vaultCurve === ZERO) {
    box.innerHTML = `<div class="cell"><span class="k">Bonding curve</span>` +
      `<span class="v">—</span></div>` +
      `<div class="right"><span class="note">the vault is not bound to a curve yet</span></div>`;
    return;
  }

  const [reserve, graduated] = await Promise.all([
    pub.readContract({ address: vaultCurve, abi: curveAbi, functionName: "quoteReserve" }),
    pub.readContract({ address: vaultCurve, abi: curveAbi, functionName: "graduated" }),
  ]);

  if (graduated) {
    bar.setAttribute("style", "width:100%");
    box.innerHTML =
      `<div class="cell"><span class="k">Bonding curve</span><span class="v big">graduated</span></div>` +
      `<div class="sep"></div>` +
      `<div class="cell"><span class="k">Trading on</span><span class="v">Uniswap v4</span></div>` +
      `<div class="right"><span class="note">the curve closed and its liquidity moved to the pool</span></div>`;
    return;
  }

  const { raised, left, pct } = curveProgress(reserve);

  bar.setAttribute("style", `width:${pct.toFixed(2)}%`);
  box.innerHTML =
    `<div class="cell"><span class="k">Raised on the curve</span>` +
    `<span class="v">${esc(Number(formatEther(raised)).toFixed(4))}</span></div>` +
    `<div class="sep"></div>` +
    `<div class="cell"><span class="k">Left to graduate</span>` +
    `<span class="big sym">${esc(Number(formatEther(left)).toFixed(4))}</span></div>` +
    `<div class="sep"></div>` +
    `<div class="cell"><span class="k">Progress</span>` +
    `<span class="v">${pct.toFixed(1)} %</span></div>` +
    `<div class="right"><span class="k">Threshold</span>` +
    `<span class="mono">${esc(Number(formatEther(GRADUATION_WEI)).toFixed(1))} ETH</span>` +
    `<span class="note">at the threshold the curve closes and the liquidity ` +
    `moves to a Uniswap v4 pool</span></div>`;
}

async function renderVault() {
  const [rewards, dev, payout, minPayout, token, escrow, curve] = await Promise.all([
    readV("rewardsPool") as Promise<bigint>,
    readV("creatorPool") as Promise<bigint>,
    readV("payoutBps") as Promise<bigint>,
    readV("MIN_PAYOUT_BPS") as Promise<bigint>,
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

  $("vault").innerHTML =
    cardHtml("Handed to holders", eth(handedOut), "ETH already turned into stock for holders") +
    cardHtml("Rewards reserve", eth(rewards), `paid out at ${bps(payout)} per epoch`) +
    cardHtml("To harvest", eth(pending), "waiting at the Pons escrow") +
    cardHtml("Dev share", eth(dev), "to a Safe fixed at deployment") +
    cardHtml("Paid per epoch", bps(payout), `timelock, never below ${bps(minPayout)}`);

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
        `<strong>${bps(gross)} of volume reaches the vault</strong> — the tax in full, plus ` +
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
    const [, , , gross, toHolders, toCreator, toPlatform] = e;
    if (gross && gross > 0n) {
      const parts: [string, bigint, string, string][] = [
        ["To holders, in stock", toHolders!, "var(--ok)", "bought every epoch and pushed or claimed"],
        ["To the creator", toCreator!, "var(--mut)", "their compensation, set at launch"],
        ["To the platform", toPlatform!, "var(--dim)", "fixed at the vault's creation, never raisable"],
      ];
      $("fee-split").innerHTML = parts
        .map(([, v, c]) => `<i style="flex-grow:${Number(v)};background:${c}"></i>`).join("");
      $("fee-legend").innerHTML = parts
        .map(([k, v, c, n]) =>
          `<tr><td><span class="dot-sq" style="background:${c}"></span>${esc(k)}` +
          `<span class="n">${esc(n)}</span></td><td>${bps(v)}</td></tr>`).join("")
        + `<tr class="total"><td>Of trading volume</td><td>${bps(gross)}</td></tr>`;
      $("fee-split").hidden = false;
    } else {
      // The bar is HIDDEN, not left empty. A bordered strip with nothing in it
      // reads as a measurement that came out at zero, which is a different
      // claim from "we could not read it" — and the wrong one.
      $("fee-split").hidden = true;
      $("fee-legend").innerHTML =
        `<tr><td class="muted">economics unavailable — a Pons getter did not answer</td></tr>`;
    }
  } catch {
    // Same rule on the throwing path: an unread split shows no bar at all.
    $("fee-split").hidden = true;
    $("fee-legend").innerHTML =
      `<tr><td class="muted">economics unavailable — a Pons getter did not answer</td></tr>`;
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
    $("title").innerHTML = `${esc(PROJECT_NAME)} <span>$${esc(m.symbol)}</span>`;
    $("launch-title").textContent = m.symbol;
    // §S41 replaced the weighted rotation with one purchase for the whole
    // basket, and this line still described the old design — two sections
    // below, the page said the opposite of itself.
    $("subtitle").textContent =
      "Every purchase buys the whole basket of Robinhood stock tokens, each line by its " +
      "weight, and distributes it to holders. No staking, no sign-up — just hold the token.";
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
    $("addresses").innerHTML = [
      ["token", token], ["vault", FEE_VAULT], ["distributor", DISTRIBUTOR],
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
    $("epochs").innerHTML = `<tr><td colspan="5" class="muted">no purchase yet</td></tr>`;
    return;
  }

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
      `<td><strong>${w.stocks.length} stocks</strong></td>` +
      `<td class="num mono">${esc(legs.join(" · "))}</td>` +
      `<td class="num mono">${esc(String(w.transferBlocks))}</td>` +
      `<td><span class="pill ok">bought</span></td></tr>`,
    );
  }
  $("epochs").innerHTML = rows.join("");
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
    ["Platform", pf, "var(--dim)", "fixed at this vault's creation, and never raisable on it"],
  ];
  $("flow").innerHTML = parts
    .map(([, v, c]) => `<i style="flex-grow:${Number(v)};background:${c}">${bps(v)}</i>`).join("");
  $("flow-legend").innerHTML = parts
    .map(([label, v, c, note]) =>
      `<div><span class="sq" style="background:${c}"></span><div class="stack">` +
      `<b style="font-size:.8125rem;font-weight:500">${label}</b>` +
      `<span class="note">${note}</span>` +
      `<span class="note mono" style="margin-top:.15rem">${int(v)} bps of what is collected</span></div></div>`)
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
      `<td class="num muted">${(al.poolFee / 10000).toFixed(2)} %</td>` +
      `<td><span class="pill${al.feed === ZERO ? " warn" : ""}">` +
        `${al.feed === ZERO ? "TWAP only" : "Chainlink + TWAP"}</span></td>` +
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
    cardHtml("Excluded addresses", a ? int(a.excluded.length) : "—", "pools, curve, contracts");

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
    `<div class="card"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:baseline">` +
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
 * "Am I in?" — the only question a visitor asks before buying.
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
 */
async function renderEligibility() {
  const s = state;
  if (!s) return;
  const box = $("eligibility");

  // `minBalance` is checked for presence, not just the epoch: the artifact comes
  // from a gateway, and this page is pinned on IPFS while the keeper that
  // produces the field lives in the repo. A keeper still on the previous format
  // would otherwise hand `BigInt(undefined)` a throw, and the startup catch
  // turns that into "cannot read the chain" across the WHOLE page.
  const last = s.artifact?.windows.at(-1);
  if (!s.token || !last || last.minBalance === undefined) {
    box.innerHTML =
      `<div class="summary"><div class="stack"><span class="k">Eligibility bar</span>` +
      `<span class="v warn">set at the first epoch</span></div>` +
      `<div class="grow"></div>` +
      `<span class="hint">hold the token before it is published and you are in it</span></div>`;
    return;
  }

  const m = await tokenMeta(s.token);
  const bar = BigInt(last.minBalance);
  const tok = (v: bigint) =>
    Number(formatUnits(v, m.decimals)).toLocaleString("en-US", { maximumFractionDigits: 0 });

  // `applyFloor` waives the bar when nobody clears it — early on, that is every
  // epoch. Announcing "0 tokens needed" would be true and unreadable.
  if (bar === 0n) {
    box.innerHTML =
      `<div class="summary"><div class="stack"><span class="k">Eligibility bar</span>` +
      `<span class="v ok">none right now</span></div>` +
      `<div class="grow"></div>` +
      `<span class="hint">too few holders for a bar — every holder is in the tree</span></div>`;
    return;
  }

  const balance = account
    ? ((await pub.readContract({
        address: s.token, abi: erc20Abi, functionName: "balanceOf", args: [account],
      })) as bigint)
    : null;

  const head =
    `<div class="summary">` +
    `<div class="stack"><span class="k">Bar at epoch #${last.toEpoch}</span>` +
    `<span class="v">${tok(bar)} $${esc(m.symbol)}</span></div>` +
    `<div class="stack"><span class="k">You hold</span>` +
    `<span class="v${balance === null ? " muted" : ""}">${balance === null ? "—" : tok(balance)}</span></div>`;

  if (balance === null) {
    box.innerHTML = head + `<div class="grow"></div>` +
      `<span class="hint">connect a wallet to see where you stand</span></div>`;
    return;
  }

  const ok = balance >= bar;
  const pct = Math.min(100, Number((balance * 1000n) / bar) / 10); // bar > 0n: waived case returned above
  box.innerHTML =
    head +
    `<div class="stack"><span class="k">Status</span>` +
    `<span class="v ${ok ? "ok" : "warn"}">${ok ? "in the next tree" : `${tok(bar - balance)} short`}</span></div>` +
    `<div class="grow"></div>` +
    `<span class="hint">${ok
      ? "your balance is counted in every epoch from here on"
      : "below the bar an epoch pays you nothing — the share goes to the holders above it"}</span>` +
    `</div>` +
    `<div class="bar" style="margin-top:.875rem"><i style="width:${pct.toFixed(1)}%"></i></div>` +
    `<div class="note" style="margin-top:.5rem">The bar is a VALUE, not a percentage of supply: it is ` +
    `whatever balance is worth ~$0.50 of share, so it falls on its own as fees come in. It never ` +
    `touches what has already been credited to you.</div>`;
}

async function renderClaims() {
  const s = state;
  if (!s) return;
  const btn = $("claim") as HTMLButtonElement;

  if (!account) {
    $("claims").innerHTML = `<tr><td colspan="4" class="muted">Connect a wallet to see your shares.</td></tr>`;
    $("claim-count").textContent = "—";
    $("claim-epochs").textContent = s.artifact ? `#${s.artifact.upToEpoch}` : "—";
    btn.disabled = true;
    return;
  }
  if (!s.artifact) {
    $("claims").innerHTML = `<tr><td colspan="4" class="muted">Epoch data unavailable from every gateway tried.</td></tr>`;
    btn.disabled = true;
    return;
  }

  const mine = s.artifact.entries.filter((e) => e.holder.toLowerCase() === account!.toLowerCase());
  if (mine.length === 0) {
    $("claims").innerHTML = `<tr><td colspan="4" class="muted">No share for this address in the active root.</td></tr>`;
    $("claim-count").textContent = "0";
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
    return {
      owed, backing, stock: e.stock as Address, cumulative: BigInt(e.cumulative),
      html: `<tr${due ? "" : ' class="off"'}>` +
        `<td class="pick"><input type="checkbox" data-stock="${esc(e.stock)}"` +
        `${due ? " checked" : " disabled"}></td>` +
        `<td><strong>${esc(m.symbol)}</strong></td>` +
        // The order follows the headers: already received, waiting, credited in
        // total. The figure that matters to the holder is the middle one.
        `<td class="num muted">${f(paid)}</td>` +
        `<td class="num${due ? "" : " muted"}">${f(owed)}</td>` +
        `<td class="num muted">${f(BigInt(e.cumulative))}</td></tr>`,
    };
  }));

  $("claims").innerHTML = rows.map((r) => r.html).join("");
  $("claim-epochs").textContent = `#${s.artifact.upToEpoch}`;
  selectable = rows.filter((r) => r.owed > 0n).map((r) => ({ stock: r.stock, backing: r.backing }));
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
  btn.disabled = rows.length === 0;
  ($("claim-all") as HTMLInputElement).checked =
    selectable.length > 0 && rows.length === selectable.length;

  const box = $("claim-cost");
  if (rows.length === 0 || baseFee === 0n) { box.textContent = ""; box.className = "hint"; return; }
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
    if (!eth1193) { log("no wallet detected"); btn.disabled = false; return; }
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

const VIEWS = ["app", "stats", "docs"];

/** The hash makes each view linkable: the vitrine at `paydprotocol.eth` points
 *  straight at `#docs`, and a shared link lands where it says. Anything else
 *  (the docs' own `#d1…#d7` anchors) is left alone. */
function show(view: string) {
  if (!VIEWS.includes(view)) return;
  for (const o of Array.from(document.querySelectorAll<HTMLButtonElement>("nav button"))) {
    const on = o.dataset.view === view;
    o.setAttribute("aria-selected", String(on));
    ($(`view-${o.dataset.view}`) as HTMLElement).hidden = !on;
  }
}

for (const b of Array.from(document.querySelectorAll<HTMLElement>("[data-view]"))) {
  b.addEventListener("click", () => {
    show(b.dataset.view!);
    history.replaceState(null, "", "#" + b.dataset.view);
  });
}
show(location.hash.slice(1));

// The way back to the index. `from` and not `registry`: the latter would switch
// this page into index MODE (see the start-up below), so it cannot serve to make
// a plain link.
{
  const from = new URLSearchParams(location.search).get("from");
  if (from && /^0x[0-9a-fA-F]{40}$/.test(from)) {
    const a = $("back-index") as HTMLAnchorElement;
    a.href = `./index.html?registry=${from}`;
    a.hidden = false;
  }
}

$("connect").addEventListener("click", async () => {
  const eth1193 = provider();
  if (!eth1193) return log("no wallet detected");
  const [a] = (await eth1193.request({ method: "eth_requestAccounts" })) as string[];
  await ensureChain(eth1193, log);
  account = a as Address;
  $("account").textContent = short(account);
  $("claim-account").textContent = short(account);
  log("");
  await renderClaims();
  await renderEligibility();
});

$("claim").addEventListener("click", doClaim);

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

  const [ep, roots] = await Promise.all([loadEpoch(), loadRoots()]);
  const previousRoot = state?.activeRoot ?? -1n;
  const keptArtifact = roots.activeRoot === previousRoot ? state?.artifact ?? null : null;
  state = { ...ep, ...roots, artifact: keptArtifact, token: state?.token ?? null };

  renderEpoch(state);
  renderNextPayout(state);
  renderRoot(state);
  const { token, curve } = await renderVault();
  state.token = token === ZERO ? null : token;
  void renderGraduation(curve);

  if (state.activeRoot > 0n && !state.artifact) {
    const active = (await readD("roots", [state.activeRoot])) as State["last"];
    const [, , , , , digest] = active!;
    state.artifact = await fetchArtifact(DISTRIBUTOR, digest, state.activeRoot);
  }
  // AFTER the fetch, not before. On a fresh load `keptArtifact` is null, so
  // called above this table announced "no purchase yet" over a full history —
  // and stayed wrong until the 60-second refresh came round with an artifact
  // in hand. The history is drawn from the artifact; it waits for it.
  void renderHistory(state.artifact ?? null);
  // One call for three: the block carries the number for the footer, the
  // timestamp the countdown needs to stop trusting the visitor's clock, and the
  // basefee the claim panel prices its gas with. It is read BEFORE the panels
  // because `renderClaims` quotes that basefee — read after, the first paint of
  // a fresh page would quote a gas cost of zero.
  const head = await pub.getBlock({ blockTag: "latest" });
  chainSkew = Number(head.timestamp) - Math.floor(Date.now() / 1000);
  baseFee = head.baseFeePerGas ?? 0n;
  $("foot-block").textContent = `block ${int(head.number ?? 0n)}`;

  await renderClaims();
  await renderEligibility();
  void renderStats(state);
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

  // An explicit `?vault=` comes FIRST, and it is the whole reason the order
  // moved. Once `REGISTRY` is a constant rather than a query parameter, the
  // registry is the default view — so without this, a link to ONE launch would
  // open on the list of all of them, and every link ever shared would break on
  // the day of the deployment.
  const asked = new URLSearchParams(location.search);
  const oneVault = asked.has("vault") || asked.has("distributor");

  // `?treasury=` comes BEFORE `?registry=`: the Treasury page accepts both (the
  // second is what lets it list the launches), so the more specific one has to
  // win. Tested the other way round, it would be unreachable as soon as it is
  // given enough to fill its table.
  if (TREASURY && !oneVault) {
    await renderTreasury();
    return;
  }
  if (REGISTRY && !oneVault) {
    await renderLaunchpad();
    return;
  }

  if (DISTRIBUTOR === ZERO || FEE_VAULT === ZERO) {
    // The notice goes in the app view, never in the header: the landing is
    // static and stays readable with no deployment, and a visitor should not
    // be met with a configuration error.
    log("Addresses not configured — pass ?distributor=0x…&vault=0x… or rebuild with the right values.");
    $("net-dot").className = "dot off";
    return;
  }
  try {
    await refresh();
    $("doc-epoch-len").textContent = duration(Number(state!.epochLen));
    // An epoch lasts 30 minutes and the page is meant to be left open, so
    // everything on it goes stale on its own. A minute is short against an
    // epoch and long against the RPC.
    setInterval(() => { void refresh(); }, 60_000);
  } catch (e) {
    $("subtitle").textContent = "Cannot read the chain: " + String((e as Error).message).slice(0, 140);
    $("net-dot").className = "dot off";
  }
})();
