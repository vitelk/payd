/**
 * The registry index: every vault, what it takes, and whether its fees still
 * arrive.
 *
 * A MODE of the single page, not a second page. Two HTML entry points would
 * make Rollup split the shared code into its own chunk, and
 * `inlineDynamicImports` — which is what guarantees one JS file, one CID to
 * pin, and no import that could fail depending on the IPFS gateway — only
 * works with a single input. So `?registry=0x…` renders this instead of the
 * claim page, and the build keeps its one-file property.
 *
 * Read-only, like the claim page. Everything shown comes from a contract call
 * made in the visitor's browser — there is no server, no indexer and no cached
 * list that could drift from the chain.
 */
import {
  createWalletClient, custom, parseAbi, formatEther, formatUnits,
  type Address, type Hex,
} from "viem";
import { COLLECTOR, EXPLORER, REGISTRY as REGISTRY_ADDR } from "./config.js";
// The client is THE ONE from `chain.ts`, not a second one: this page used to
// build an identical one, which duplicated the config and -- above all -- made
// it invisible to `mock.ts`'s fixture world, which patches only that one.
import { pub, chain, provider, ensureChain, distributorAbi } from "./chain.js";
import { fetchArtifact, buildClaim } from "./artifact.js";
import { FORM, mountCreate } from "./create.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const q = new URLSearchParams(location.search);
// From the config, which already applies the `?registry=` override. Reading the
// query string a second time here is how the constant and the URL come apart:
// the constant would be filled at deployment and this view would still only
// ever see the parameter.
export const REGISTRY: Address | null = REGISTRY_ADDR === ZERO_ADDR ? null : REGISTRY_ADDR;
/** `?create` switches to the creation screen. In the mockup it is a SCREEN of
 *  its own that the button navigates to, not a form pushed under the grid -- an
 *  index of fifty launches would otherwise end in a form nobody asked for. */
export const CREATING = q.has("create");
/** `?mock` carried across the hop to a vault's page.
 *
 *  Dev-only and empty in a build, but without it the fixture world stops at
 *  this screen: every `Open` left it and went to the real chain, which is why
 *  the per-vault page reached FROM the index had never been looked at. A link
 *  that silently changes worlds is worse than no link. */
const KEEP = q.has("mock") ? "&mock" : "";


const registryAbi = parseAbi([
  "function vaults() view returns (address[])",
  // The Payd carries the Treasury's address as an IMMUTABLE: it is the source,
  // and it is what makes the platform token's page reachable without copying an
  // address anywhere.
  "function PLATFORM() view returns (address)",
]);
const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function DISTRIBUTOR() view returns (address)",
  "function rewardsBps() view returns (uint256)",
  "function PLATFORM_BPS() view returns (uint256)",
  "function hookStatus() view returns (uint8 status, address current, uint64 effectiveAt)",
  "function economics() view returns (uint256 taxBps, uint256 curveFeeBps, uint256 ponsShareBps, uint256 grossOfVolumeBps, uint256 rewardsOfVolumeBps, uint256 creatorOfVolumeBps, uint256 platformOfVolumeBps)",
  "function rewardsPool() view returns (uint256)",
]);
const collectorAbi = parseAbi([
  "function collect(address account, address[] distributors, address[][] stocks, uint256[][] cumulative, bytes32[][][] proofs) returns (uint256)",
]);
const erc20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

/// The page's own markup, injected rather than served: keeping it here means
/// one HTML file in the build, which is the same reason as the single JS file.
/// The markup comes from `Payd Payd.dc.html`, styles included. The mockup's
/// values are replaced by our identifiers; NOTHING else is touched. A first
/// attempt had rebuilt these screens from a version of the file whose `style`
/// attributes had been stripped to make it readable -- but this design has no
/// stylesheet, its whole layout is in those attributes. Hence the rule: we copy,
/// we do not redraw.
const SHELL = `
  <style>
    .lp .hd { padding: 2.75rem 0 1.75rem; border-bottom: 1px solid var(--hair); }
    .lp .hd h1 { font: 600 clamp(1.75rem, 4vw, 2.5rem)/1.1 var(--sans);
      letter-spacing: -.025em; margin: 0; }
    .lp .hd p { color: var(--mut); max-width: 46rem; margin: .75rem 0 0; text-wrap: pretty; }
    .lp .lpbar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; }
    .lp .lpbar button, .lp .lpbar a.mkbtn { font: 500 .8125rem var(--sans); padding: .55rem .95rem;
      border-radius: 8px; cursor: pointer; text-decoration: none; }
    .lp .lpbar button.go { border: 1px solid var(--ok); background: var(--ok); color: var(--bg); }
    .lp .lpbar button.go:hover { background: #dbff3d; border-color: #dbff3d; }
    .lp .lpbar button.ghost, .lp .lpbar a.mkbtn { border: 1px solid var(--line); background: transparent;
      color: var(--fg); }
    .lp .lpbar button.ghost:hover, .lp .lpbar a.mkbtn:hover { background: var(--surface); border-color: var(--mut); }
    .lp .lpbar .sum { font: .8125rem/1.5 var(--mono); color: var(--mut); flex: 1; min-width: 14rem; }
    .lp .lpbar .count { font: .75rem var(--mono); color: var(--dim); }
    .lp .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
      gap: .75rem; margin-top: 1.25rem; }
    .lp .lpcard { border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
      padding: 1.125rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: .7rem; }
    .lp .row { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; }
    .lp .sym { font-size: 1.125rem; font-weight: 600; letter-spacing: -.01em; }
    .lp .pill { font: .6875rem var(--mono); padding: .15rem .5rem; border-radius: 6px;
      border: 1px solid var(--line); color: var(--mut); white-space: nowrap; }
    .lp .pill.ok { border-color: rgba(204,255,0,.45); color: var(--ok); }
    .lp .pill.warn { border-color: var(--warn); color: var(--warn); }
    .lp .pill.bad { border-color: var(--bad); color: var(--bad); }
    .lp .addr { font: .75rem var(--mono); color: var(--dim); }
    .lp .note { font-size: .78125rem; color: var(--mut); text-wrap: pretty; }
    .lp .split { display: flex; height: 6px; border-radius: 999px; overflow: hidden; background: var(--hair); }
    .lp .split i { display: block; }
    .lp table.lpleg { border-collapse: collapse; width: 100%; font-size: .8125rem; margin-top: .6rem; }
    .lp table.lpleg td { padding: .12rem 0; color: var(--mut); }
    .lp table.lpleg td:last-child { text-align: right; font-family: var(--mono);
      font-variant-numeric: tabular-nums; color: var(--fg); }
    .lp table.lpleg tr.tot td { padding: .3rem 0 0; font: 500 .6875rem var(--mono);
      letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }
    .lp .k { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .lp .lpv { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: .8125rem; }
    .lp .row.held { border-top: 1px solid var(--hair); padding-top: .55rem; }
    .lp .row.held .k { color: var(--ok); }
    .lp .row.held .lpv { font-weight: 600; }
    .lp a.cta { margin-top: .2rem; font: 600 .875rem var(--sans); padding: .5rem .8rem; border: 0;
      border-radius: 8px; background: var(--ok); color: var(--bg); text-align: center;
      text-decoration: none; }
    .lp a.cta[aria-disabled="true"] { background: var(--raised); color: var(--dim); pointer-events: none; }
    .lp .foot { margin: 1.5rem 0 0; font: .78125rem/1.6 var(--mono); color: var(--dim);
      max-width: 52rem; text-wrap: pretty; }
  </style>
  <div class="lp">
    <div class="hd">
      <h1>Launches</h1>
      <p>Every token here pays its holders in real tokenised stock, bought with its own trading fees.
      What each one takes is read from the chain, not from this page — including the share the platform
      takes, which is fixed at a vault's creation and can never be raised on it.</p>
    </div>

    <div class="lpbar">
      <button id="lp-collect" class="go" hidden>Collect everything</button>
      <button id="lp-connect" class="ghost">Connect wallet</button>
      <a class="mkbtn" id="lp-create" href="#">Create a vault</a>
      <a class="mkbtn" id="lp-plat" hidden>The platform token</a>
      <span class="sum" id="lp-sum"></span>
      <span class="count" id="lp-count"></span>
    </div>

    <div id="grid" class="grid"></div>
    <p id="status" class="note"></p>
    <p class="foot" id="lp-batch-note" hidden>One transaction settles every share you are owed across
    launches, and it refunds its own gas. A share below the automatic-delivery threshold is still
    fully claimable from its own launch page.</p>
  </div>`;

/// The creation screen, reached through `?create`. It carries its own way back
/// to the index: you no longer get there by scrolling, so it needs a way out.
const CREATE_SHELL = `
  <div class="lp">
    <a class="back" id="mk-back" style="display:inline-block;margin:2rem 0 0;font:.75rem var(--mono);color:var(--mut);text-decoration:none">&larr; all launches</a>
    ${FORM}
  </div>`;

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)} %`;

/** The four states of `hookStatus`, and what each means to a visitor. */
const HOOK: Record<number, { pill: string; label: string; note: string }> = {
  0: { pill: "", label: "not launched", note: "the vault exists, its token has not been launched yet" },
  1: { pill: "ok", label: "collecting", note: "" },
  2: { pill: "warn", label: "redirect scheduled", note: "Pons has proposed sending these fees elsewhere" },
  3: { pill: "bad", label: "fees lost", note: "the fees no longer come here — what it already holds stays claimable" },
};

interface Row {
  vault: Address;
  distributor: Address;
  token: Address;
  symbol: string;
  status: number;
  effectiveAt: bigint;
  rewardsOfVolume: bigint;
  creatorOfVolume: bigint;
  platformOfVolume: bigint;
  grossOfVolume: bigint;
  reserve: bigint;
  /** What the visitor holds of this token, and its precision. Zero while
   *  nobody is connected -- the page stays entirely readable with no wallet,
   *  which is the point: we do not ask anyone to connect in order to READ. */
  balance: bigint;
  decimals: number;
}

/** The connected address, or null. Filled in only if it is asked for. */
let viewer: Address | null = null;

async function read(vault: Address): Promise<Row> {
  const [token, distributor, hook, eco, reserve] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "token" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "DISTRIBUTOR" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "hookStatus" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "economics" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "rewardsPool" }),
  ]);
  // An unlaunched vault has no token, so no symbol to read.
  const live = token !== "0x0000000000000000000000000000000000000000";
  const symbol = live
    ? await pub.readContract({ address: token, abi: erc20, functionName: "symbol" }).catch(() => "?")
    : "—";

  // The visitor's position: two reads, and ONLY if they are connected. With no
  // wallet the page reads in full -- we do not charge a connection for
  // looking.
  let balance = 0n;
  let decimals = 18;
  if (live && viewer) {
    [balance, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [viewer] }).catch(() => 0n),
      pub.readContract({ address: token, abi: erc20, functionName: "decimals" }).catch(() => 18),
    ]);
  }

  return {
    vault,
    distributor,
    token,
    symbol,
    status: Number(hook[0]),
    effectiveAt: hook[2],
    grossOfVolume: eco[3],
    rewardsOfVolume: eco[4],
    creatorOfVolume: eco[5],
    platformOfVolume: eco[6],
    reserve,
    balance,
    decimals,
  };
}

function card(r: Row): string {
  const h = HOOK[r.status] ?? HOOK[0]!;
  const live = r.status === 1 || r.status === 2;
  // A vault whose economics could not be derived shows nothing rather than a
  // stale figure: `economics` returns zeros when a Pons getter moves.
  const known = r.grossOfVolume > 0n;
  const bar = (v: bigint, c: string) => `<i style="flex-grow:${Number(v)};background:${c}"></i>`;
  const held = r.balance > 0n;

  return `<div class="lpcard">
    <div class="row">
      <span class="sym">${esc(r.symbol)}</span>
      <span class="pill ${h.pill}">${esc(h.label)}</span>
    </div>
    <div class="addr">${esc(r.token.slice(0, 10))}…${esc(r.token.slice(-6))}</div>
    ${h.note ? `<div class="note">${esc(h.note)}</div>` : ""}
    ${
    r.status === 2
      ? `<div class="note">effective ${
        new Date(Number(r.effectiveAt) * 1000).toISOString().slice(0, 16).replace("T", " ")
      } UTC</div>`
      : ""
  }
    ${
    known
      ? `<div>
           <div class="split">${bar(r.rewardsOfVolume, "var(--ok)")}${
        bar(r.creatorOfVolume, "var(--mut)")
      }${bar(r.platformOfVolume, "var(--dim)")}</div>
           <table class="lpleg">
             <tr><td>to holders, in stock</td><td>${pct(r.rewardsOfVolume)}</td></tr>
             <tr><td>to the creator</td><td>${pct(r.creatorOfVolume)}</td></tr>
             <tr><td>to the platform</td><td>${pct(r.platformOfVolume)}</td></tr>
             <tr class="tot"><td>of trading volume</td><td>${pct(r.grossOfVolume)} total</td></tr>
           </table>
         </div>`
      : `<div class="note">economics unavailable — a Pons getter did not answer</div>`
  }
    <div class="row"><span class="k">waiting to buy</span><span class="lpv">${formatEther(r.reserve)} ETH</span></div>
    ${
    held
      ? `<div class="row held"><span class="k">you hold</span><span class="lpv">${
        esc(Number(formatUnits(r.balance, r.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 }))
      }</span></div>`
      : ""
  }
    <a class="cta" ${live ? "" : 'aria-disabled="true"'}
       href="./index.html?vault=${r.vault}&distributor=${r.distributor}&from=${REGISTRY}${KEEP}">${
    live ? "Open" : "Nothing to claim"
  }</a>
  </div>`;
}


/** The last render's rows: what the batch button needs to read back. */
let lastRows: Row[] = [];
let collecting = false;

/**
 * Claims, in ONE transaction, the visitor's share across every launch they
 * hold.
 *
 * **It is never a required step.** Every launch stays claimable from its own
 * page, and this function only saves signatures. A Collector that is missing,
 * broken or replaced deprives nobody of anything.
 *
 * **`distribute`, not `claim`, and it is not the same door.** The Collector
 * calls `distribute`, which checks against `pushRoot` -- the tree of shares
 * large enough to deserve a pushed delivery. A share below that threshold is not
 * in that tree: it stays entirely claimable, but from its own page, with
 * `claim`. The message says so rather than letting a transaction revert.
 *
 * In exchange, `distribute` REFUNDS its gas to the caller, which `claim` does
 * not: going through here costs less than signing each launch.
 */
async function collectAll(): Promise<void> {
  if (collecting) return;
  const btn = $("lp-collect") as HTMLButtonElement;
  const say = (m: string) => { $("lp-sum").textContent = m; };
  if (!viewer) return say("connect a wallet first");

  collecting = true;
  btn.disabled = true;
  try {
    // EVERY launch, not only those with a non-zero balance. A share is
    // CUMULATIVE and does not expire (§S18): somebody who held and then sold is
    // still owed everything the epochs they held credited them. Filtering on the
    // current balance is exactly how you miss those -- and they have no way of
    // knowing it from this page.
    //
    // ponytail: one IPFS fetch per launch, serially. Bearable while the list is
    // short; beyond thirty or so it will take an artifact-side index (which
    // holder appears where) rather than downloading everything.
    const all = lastRows;
    const distributors: Address[] = [], stocks: Address[][] = [],
      cumulative: bigint[][] = [], proofs: Hex[][][] = [];

    // Sequential: each round is one IPFS fetch and a batch of RPC reads;
    // launching them all together would bring the gateway down before the RPC.
    for (const [i, r] of all.entries()) {
      say(`reading launch ${i + 1} of ${all.length}…`);
      try {
        const active = (await pub.readContract({
          address: r.distributor, abi: distributorAbi, functionName: "activeRoot",
        })) as bigint;
        if (active === 0n) continue; // nothing has been published for this launch yet
        const root = (await pub.readContract({
          address: r.distributor, abi: distributorAbi, functionName: "roots", args: [active],
        })) as readonly [Address, number, Hex, Hex, number, Hex];
        const art = await fetchArtifact(r.distributor, root[5], active);
        if (!art) continue;
        const a = await buildClaim(r.distributor, viewer, art, undefined, "push");
        if (a.stocks.length === 0) continue;
        distributors.push(r.distributor);
        stocks.push(a.stocks);
        cumulative.push(a.cumulative);
        proofs.push(a.proofs);
      } catch { /* an unreadable launch does not cancel the others */ }
    }

    if (distributors.length === 0) {
      return say(
        "nothing to collect in one go — a share below the automatic-delivery "
        + "threshold is still fully claimable from its own launch page",
      );
    }

    const eth = provider();
    if (!eth) return say("no wallet detected");
    if (!(await ensureChain(eth, say))) return;

    say(`collecting ${distributors.length} launch${distributors.length > 1 ? "es" : ""}…`);
    const wallet = createWalletClient({ account: viewer, chain, transport: custom(eth) });
    const hash = await wallet.writeContract({
      address: COLLECTOR, abi: collectorAbi, functionName: "collect",
      args: [viewer, distributors, stocks, cumulative, proofs],
      account: viewer, chain,
    });
    say(`sent: ${hash.slice(0, 10)}…`);
    await pub.waitForTransactionReceipt({ hash });
    say(`collected ${distributors.length}. ${EXPLORER}/tx/${hash}`);
    await paint();
  } catch (e) {
    say("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 120));
  } finally {
    collecting = false;
    btn.disabled = false;
  }
}

/// Replaces the page with the index. Called from `main.ts` when the query
/// string names a Payd.
export async function renderLaunchpad(): Promise<void> {
  if (!REGISTRY) return;

  // The creation screen is a PAGE, not a footer under the grid.
  if (CREATING) {
    document.body.innerHTML = CREATE_SHELL;
    ($("mk-back") as HTMLAnchorElement).href = `./index.html?registry=${REGISTRY}`;
    await mountCreate(REGISTRY);
    return;
  }

  document.body.innerHTML = SHELL;
  ($("lp-create") as HTMLAnchorElement).href = `./index.html?registry=${REGISTRY}&create`;

  // The link to the platform token, if the Payd designates one.
  void pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "PLATFORM" })
    .then((t) => {
      if (!t || t === ZERO_ADDR) return;
      const a = $("lp-plat") as HTMLAnchorElement;
      a.href = `./index.html?treasury=${t}&registry=${REGISTRY}`;
      a.hidden = false;
    })
    .catch(() => { /* a missing link beats a wrong one */ });

  $("lp-collect").addEventListener("click", () => { void collectAll(); });

  const connect = $("lp-connect") as HTMLButtonElement;
  connect.addEventListener("click", async () => {
    const eth = provider();
    if (!eth) {
      $("lp-sum").textContent = "no wallet detected";
      return;
    }
    connect.disabled = true;
    try {
      const [a] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!a) return;
      // The network is required because the BALANCES come from our transport,
      // not from the wallet: without this guard the page would show perfectly
      // credible zeros to somebody connected to another chain.
      await ensureChain(eth, (m) => { $("lp-sum").textContent = m; });
      viewer = a;
      connect.textContent = `${a.slice(0, 6)}…${a.slice(-4)}`;
      await paint();
    } finally {
      connect.disabled = false;
    }
  });

  await paint();
}

async function paint(): Promise<void> {
  if (!REGISTRY) return;
  try {
    const vaults = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "vaults" });
    if (vaults.length === 0) {
      $("status").textContent = "no launch yet";
      $("grid").innerHTML = "";
      return;
    }

    // One at a time on purpose: a public RPC answers a burst of these with a
    // rate limit, and a page that renders half its cards is worse than one
    // that takes a second longer.
    const rows: Row[] = [];
    for (const v of vaults as readonly Address[]) rows.push(await read(v));

    // What you hold, first. A page listing fifty launches is unusable if the
    // three that concern you are buried in it.
    rows.sort((a, b) => (a.balance > 0n === b.balance > 0n ? 0 : a.balance > 0n ? -1 : 1));

    $("status").textContent = "";
    // Where these figures come from: no server, no indexer. It is the property
    // that sets this page apart, and it deserves to be written down.
    $("lp-count").textContent =
      `${rows.length} launch${rows.length > 1 ? "es" : ""} · read from the chain in your browser`;
    $("grid").innerHTML = rows.map(card).join("");
    lastRows = rows;

    // The batch button appears only when it has something to do AND the router
    // exists. An undeployed Collector leaves the page STRICTLY as it was -- it is
    // a shortcut, not a dependency.
    const held = rows.filter((r) => r.balance > 0n).length;
    // Not conditioned on the balance: a sold share is still owed, and
    // yesterday's holder would never see the button if holding were required.
    const canBatch = viewer !== null && COLLECTOR !== ZERO_ADDR;
    ($("lp-collect") as HTMLButtonElement).hidden = !canBatch;
    $("lp-batch-note").hidden = !canBatch;

    $("lp-sum").textContent = viewer
      ? held === 0
        ? canBatch
          ? "you hold none of these — a share you were owed before selling is still collectable"
          : "you hold none of these"
        : canBatch
        ? `you hold ${held} of ${rows.length} — one transaction settles every share you are owed, and it refunds its own gas`
        : `you hold ${held} of ${rows.length} — collecting is per launch, from its own page`
      : "connect to see which of these you hold";
  } catch (e) {
    $("status").textContent = `cannot read the chain: ${(e as Error).message}`;
  }
}
