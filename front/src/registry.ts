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
  createWalletClient, custom, encodeFunctionData, parseAbi, formatEther, formatUnits,
  type Address, type Hex,
} from "viem";
import { CHAIN_ID, COLLECTOR, REGISTRY as REGISTRY_ADDR } from "./config.js";
// The client is THE ONE from `chain.ts`, not a second one: this page used to
// build an identical one, which duplicated the config and -- above all -- made
// it invisible to `mock.ts`'s fixture world, which patches only that one.
import { pub, chain, provider, ensureChain, distributorAbi, symbolsOf, type Eth1193 } from "./chain.js";
import { fetchArtifact, buildClaim, type ClaimArgs } from "./artifact.js";
import { connected, onViewer, setViewer, viewer } from "./viewer.js";
import { FORM, mountCreate } from "./create.js";
import { modeChip, modeName, payScreen, type Mode } from "./modes.js";
import { ago, cardHtml, launchCellHtml, usd, type Card } from "./cards.js";
import { readExtras, readOwed, type Extra } from "./cardreads.js";

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
/** The vault this page is already looking at, if any — what the rail marks as
 *  the current row and what the switcher chip names. Read from the query string
 *  for the same reason `REGISTRY` is read from the config: one source. */
const CURRENT = (q.get("token") ?? q.get("vault") ?? "").toLowerCase();


const registryAbi = parseAbi([
  "function vaults() view returns (address[])",
  // The mode a vault was STAMPED with at birth. Read from here and not from
  // the vault, because the registry is what decides it (`Payd._create`) and a
  // vault of another mode may answer anything at all.
  "function modeOf(address) view returns (bytes32)",
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
///
/// A surface carries the hierarchy now — a card is a `--surface` ground, not a
/// 1px `--line` outline — and the grid of cards is one table, because six
/// numbers read across a row and not down twenty cards. "Collect everything"
/// is NOT here any more: it lives in the shell's header, so the one action that
/// spans every launch is reachable from every view. Same id, same handler.
const SHELL = `
  <style>
    .lp .hd { padding: 0 0 1.25rem; }
    .lp .hd h1 { font: 600 2.25rem/1.05 var(--sans); letter-spacing: -.03em; margin: 0; }
    .lp .hd p { color: var(--mut); max-width: 34rem; margin: .75rem 0 0; text-wrap: pretty; }

    .lp .lpbar { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .lp .lpbar .grow { flex: 1; }
    .lp .segs { display: flex; gap: .2rem; padding: .2rem; border-radius: var(--r-md);
      background: var(--surface); }
    .lp .segs button { font: 500 .78125rem/1 var(--sans); padding: .45rem .75rem; border: 0;
      border-radius: 8px; cursor: pointer; white-space: nowrap; background: transparent;
      color: var(--mut); }
    .lp .segs button:hover:not(:disabled) { background: transparent; color: var(--fg); }
    .lp .segs button[aria-pressed="true"] { background: var(--raised); color: var(--fg); }
    .lp .sortlab { font: 500 .6875rem/1 var(--mono); letter-spacing: .12em;
      text-transform: uppercase; color: var(--dim); }
    .lp .lpfoot { display: flex; align-items: baseline; justify-content: space-between;
      gap: .75rem 1.5rem; flex-wrap: wrap; margin: .75rem 0 0; }
    .lp .count { font: .75rem var(--mono); color: var(--dim); }
    .lp .sum { font: .8125rem/1.5 var(--mono); color: var(--mut); }

    .lp .tablewrap { background: var(--surface); border-radius: var(--r-lg); overflow: hidden;
      margin-top: 1rem; }
    .lp table.lpt { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .8125rem; }
    .lp .lpt th { text-align: left; font: 500 .6875rem/1 var(--mono); letter-spacing: .12em;
      text-transform: uppercase; color: var(--dim); border: 0; padding: .65rem 1.125rem .75rem; }
    .lp .lpt td { border: 0; border-top: 1px solid var(--hair); padding: .9rem 1.125rem;
      font-variant-numeric: tabular-nums; }
    .lp .lpt th:first-child, .lp .lpt td:first-child { padding-left: 1.125rem; }
    .lp .lpt th:last-child, .lp .lpt td:last-child { padding-right: 1.125rem; }
    .lp .lpt th.num, .lp .lpt td.num { text-align: right; }
    .lp .lpt tbody tr:hover { background: var(--raised); }
    .lp .lpt tbody tr[aria-disabled="true"] { color: var(--dim); }
    .lp .lpt .sym { font: 600 1rem/1 var(--sans); letter-spacing: -.02em; }
    .lp .lpt a.sym { color: var(--fg); border-bottom: 0; }
    .lp .lpt .held { font: .625rem var(--mono); letter-spacing: .09em; text-transform: uppercase;
      color: var(--ok); margin-left: .5rem; }
    /* The payout mode, on the rows that are not the default one. Muted, not
       coloured: it is what this launch IS, not a warning about it. */
    .lp .lpt .mode { font: .625rem var(--mono); letter-spacing: .09em; text-transform: uppercase;
      color: var(--dim); margin-left: .5rem; }
    .lp .lpt .rate { font: 500 .9375rem var(--mono); color: var(--ok); }
    .lp .lpt .split { color: var(--mut); font-family: var(--mono); }
    .lp .lpt .mine { color: var(--ok); font-family: var(--mono); }
    .lp .lpt .none { color: var(--dim); }

    .lp .pill { font: 500 .625rem/1 var(--mono); letter-spacing: .09em; text-transform: uppercase;
      padding: .32rem .5rem; border: 0; border-radius: 6px; background: var(--raised);
      color: var(--dim); white-space: nowrap; }
    .lp .pill.ok { color: var(--ok); }
    .lp .pill.warn { color: var(--warn); }
    .lp .pill.bad { color: var(--bad); }

    /* --- THE CARDS. The inline-size container on each one is what lets the
       headline size itself to the CELL and not to the viewport: the grid is
       auto-fill, so the same card is 14rem on a phone and 22rem on a wide screen
       with four of them, and a viewport-sized figure overflowed at both ends. */
    .lp .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
      gap: .75rem; margin-top: 1rem; }
    .lp .tc { border: 0; border-bottom: 0; border-radius: var(--r-lg); background: var(--surface);
      padding: 1.125rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: .875rem;
      container-type: inline-size; color: var(--fg); text-align: left; font: inherit;
      cursor: pointer; }
    .lp .tc:hover { background: var(--raised); color: var(--fg); }
    .lp .tc.dim { opacity: .6; }
    .lp .tc.alarm { box-shadow: inset 0 0 0 1px rgba(226,133,122,.35); }
    .lp .tc .hdr { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .lp .tc .lg { width: 40px; height: 40px; border-radius: var(--r-md); background: var(--raised);
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      overflow: hidden; position: relative; }
    .lp .tc .lg i { font: 600 .75rem var(--sans); font-style: normal; letter-spacing: -.01em;
      color: var(--ok); }
    /* The image COVERS the fallback instead of replacing it, so the onerror
       that removes the image IS the whole fallback path: no second render, and
       no frame in which the square is empty. */
    .lp .tc .lg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .lp .tc .nm { display: flex; flex-direction: column; gap: .15rem; min-width: 0; flex: 1 1 8rem; }
    .lp .tc .t1 { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
    .lp .tc .t1 b { font: 600 1.0625rem/1 var(--sans); letter-spacing: -.02em; }
    .lp .tc .mt { font: .625rem var(--mono); letter-spacing: .09em; text-transform: uppercase;
      color: var(--dim); }
    .lp .tc .age { font: .75rem var(--mono); color: var(--dim); }
    .lp .tc .bdg { font: 500 .625rem/1 var(--mono); letter-spacing: .09em; text-transform: uppercase;
      padding: .36rem .5rem; border-radius: 6px; background: var(--raised); white-space: nowrap; }
    .lp .tc .fig { display: flex; flex-direction: column; gap: .3rem; }
    .lp .tc .fig b { font: 500 clamp(1.25rem, 11cqw, 2rem)/1 var(--mono); letter-spacing: -.03em;
      overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .lp .tc .fig b.soft { color: var(--mut); }
    .lp .tc .ft { display: flex; align-items: center; justify-content: space-between; gap: .75rem;
      margin-top: auto; padding-top: .75rem; border-top: 1px solid var(--hair); }
    /* The shell's global .k is a mono uppercase eyebrow, and this one is a
       sentence. Stated in full rather than trusting specificity: the global
       sets its font as a SHORTHAND plus a transform and a tracking, so
       overriding the size and the colour alone left "To holders, of a trade"
       rendered as TO HOLDERS, OF A TRADE, wrapped over two lines. */
    .lp .tc .ft .k { font: 400 .8125rem/1.3 var(--sans); letter-spacing: 0;
      text-transform: none; color: var(--mut); }
    .lp .tc .ft .v { font: 500 .875rem var(--mono); font-variant-numeric: tabular-nums; }
    .lp .tc .ft .v.ok { color: var(--ok); }

    .lp .newcell { box-shadow: inset 0 0 0 1px var(--okring); min-height: 13rem; }
    .lp .newcell:hover { background: var(--raised); }
    .lp .newcell .plus { width: 40px; height: 40px; border-radius: var(--r-md); background: var(--ok);
      color: var(--bg); display: flex; align-items: center; justify-content: center;
      font: 500 1.5rem/1 var(--sans); }
    .lp .newcell .nct { font: 600 1.0625rem/1.2 var(--sans); letter-spacing: -.02em; }
    .lp .newcell .ncp { font-size: .8125rem; color: var(--mut); text-wrap: pretty; flex: 1; }
    .lp .newcell .ncb { display: inline-flex; align-self: flex-start; align-items: center;
      padding: .55rem .9rem; min-height: 40px; border-radius: var(--r-md); background: var(--ok);
      color: var(--bg); font: 600 .8125rem var(--sans); }

    /* --- THE POSITION CARD, which replaced the batch footnote at the bottom of
       the page. The inset lime ring is the grammar's "this is the one you act
       on" and is used once per view. */
    .lp .poscard { border-radius: var(--r-lg); background: var(--surface); padding: 1.25rem 1.375rem;
      display: flex; align-items: center; gap: 1rem 2rem; flex-wrap: wrap;
      box-shadow: inset 0 0 0 1px var(--okring); margin: 0 0 1.25rem; }
    .lp .poscard .l { display: flex; flex-direction: column; gap: .35rem; flex: 1 1 14rem; }
    .lp .poscard .n { font: 500 1.5rem/1 var(--mono); letter-spacing: -.03em; }
    .lp .poscard .n span { font: 500 .875rem var(--sans); color: var(--mut); letter-spacing: 0; }
    .lp .poscard .w { font-size: .78125rem; color: var(--mut); text-wrap: pretty; }
    .lp .poscard button { background: var(--ok); color: var(--bg); border: 0;
      border-radius: var(--r-md); padding: .7rem 1.1rem; min-height: 44px;
      font: 600 .875rem var(--sans); cursor: pointer; }

    .lp .chip { display: inline-flex; align-items: center; gap: .45rem; min-height: 32px;
      padding: .35rem .6rem; border-radius: var(--r-md); background: var(--surface);
      font: 500 .78125rem var(--sans); color: var(--mut); cursor: pointer; }
    .lp .chip input { margin: 0; accent-color: var(--ok); }
    .lp .chip:has(input:checked) { color: var(--fg); }

    .lp .partial { font-size: .78125rem; color: var(--mut); margin: .75rem 0 0;
      display: flex; gap: .5rem; align-items: baseline; }
    .lp .partial i { width: .5rem; height: .5rem; border-radius: 2px; background: var(--warn);
      align-self: center; flex-shrink: 0; }

    /* Under 900px the table becomes a list: ticker and what you are owed on the
       first line, everything else on a second one. An ::after with a 100 %
       basis is what breaks the flex row in two -- the cells stay real table
       cells, so there is one rendering of a row and not two. */
    @media (max-width: 56.25rem) {
      .lp .hd h1 { font-size: 1.875rem; }
      .lp .lpt thead { display: none; }
      .lp .lpt tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: .15rem .6rem;
        padding: .8rem 1rem; border-top: 1px solid var(--hair); }
      .lp .lpt tbody tr:first-child { border-top: 0; }
      .lp .lpt td { display: block; border: 0; padding: 0; }
      .lp .lpt td.c-vault { order: 1; }
      .lp .lpt td.c-yours { order: 2; margin-left: auto; }
      .lp .lpt tr::after { content: ""; order: 3; flex-basis: 100%; height: 0; }
      .lp .lpt td.c-status { order: 4; }
      .lp .lpt td.c-rate { order: 5; }
      .lp .lpt td.c-split { order: 6; }
      .lp .lpt td.c-res { order: 7; }
      .lp .lpt td.c-rate, .lp .lpt td.c-split, .lp .lpt td.c-res {
        font: .75rem var(--mono); color: var(--dim); text-align: left; }
      .lp .lpt td.c-rate .rate { font: .75rem var(--mono); color: var(--dim); }
    }
  </style>
  <div class="lp">
    <div class="hd">
      <h1>Tokens</h1>
      <p>Every token here pays its holders in tokenised stock, bought with its own trading fees.
      Every figure is read from the chain when you open the page.</p>
    </div>

    <!-- The position card, and it is only here while a wallet is connected. It
         replaced the paragraph that used to sit at the BOTTOM of the page
         explaining what the batch button does: the explanation belonged beside
         the button, and the button belongs where a holder's eye lands. The
         count is launches and never ether, for paintBatch's reason — what the
         transaction will actually send is only known after one artifact fetch
         per launch, and a card is not the place to spend that. -->
    <div class="poscard" id="lp-pos" hidden>
      <div class="l">
        <span class="eyebrow">Your position</span>
        <span class="n"><b id="lp-pos-n">0</b> <span id="lp-pos-u">tokens held</span></span>
        <span class="w">What each one owes you is read from its payout root when you press the
        button; the launches past the delivery floor settle in one transaction that refunds its
        own gas, the rest from your wallet.</span>
      </div>
      <button type="button" id="lp-pos-go" class="pinme">Collect everything</button>
    </div>

    <!-- Filter and sort are a re-read of the rows already in memory, never a
         second chain read, and nothing here is persisted.

         "Cards" is the default and the table is one click away, not gone: six
         numbers compared across twenty launches is a real question, it is just
         not the one the page is opened with. The two checkboxes replaced four
         filter segments — "Collecting" and "On the curve" were the same question
         asked twice, and both are "Live only". -->
    <div class="lpbar">
      <div class="segs" id="lp-list" role="group" aria-label="How to show the list">
        <button type="button" data-l="cards" aria-pressed="true">Cards</button>
        <button type="button" data-l="table" aria-pressed="false">Table</button>
      </div>
      <label class="chip" id="lp-mine-chip" hidden>
        <input type="checkbox" id="lp-mine"> Yours
      </label>
      <label class="chip">
        <input type="checkbox" id="lp-live" checked> Live only
      </label>
      <span class="grow"></span>
      <span class="sortlab">Sort</span>
      <div class="segs" id="lp-sort" role="group" aria-label="Sort launches">
        <button type="button" data-s="Newest" aria-pressed="true">Newest</button>
        <button type="button" data-s="Paid" aria-pressed="false">Paid to holders</button>
        <button type="button" data-s="Yours" aria-pressed="false">Yours</button>
      </div>
    </div>
    <div class="lpfoot"><span class="sum" id="lp-sum"></span><span class="count" id="lp-count"></span></div>

    <div id="grid"></div>
    <p id="status" class="note"></p>
    <p class="partial" id="lp-partial" hidden><i></i><span></span></p>
  </div>`;

/// The creation screen. A VIEW, like the index and the Treasury: it used to
/// replace `document.body` and so lost the header, the tabs and the footer —
/// the "Create a vault" tab is the way back, and it needs no link of its own.
const CREATE_SHELL = `<div class="lp">${FORM}</div>`;

const $ = (id: string) => document.getElementById(id)!;
/** For the elements that live in a VIEW rather than in the shell: the index's
 *  footer does not exist until that view has been mounted, and the shell's
 *  button is clickable from every view. */
const maybe = (id: string) => document.getElementById(id);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)} %`;
// Four decimals, like every other ETH figure in the app. `formatEther` alone
// printed the full 18 ("1.189416411185888592 ETH"), which was the one number
// on the index that did not look like it belonged to the same page.
const eth = (v: bigint) => `${Number(formatEther(v)).toFixed(4)} ETH`;

/** The four states of `hookStatus`, and what each means to a visitor. */
const HOOK: Record<number, { pill: string; label: string; note: string }> = {
  0: { pill: "", label: "not launched", note: "the payout contracts exist, the token has not been launched yet" },
  1: { pill: "ok", label: "collecting", note: "" },
  2: { pill: "warn", label: "redirect scheduled", note: "Pons has proposed sending these fees elsewhere" },
  3: { pill: "bad", label: "fees lost", note: "the fees no longer come here — what it already holds stays claimable" },
};

/** What the chip explains on hover. One sentence: the row has no space for
 *  more, and the launch's own page carries the full description. */
const MODE_TITLE: Partial<Record<Mode, string>> = {
  tontine: "the holders who stay share what the leavers left behind",
  backing: "burn your tokens to take your share of the pot — there is no claim under this mode",
  lottery: "each draw pays its whole pot to one holder, drawn from a public randomness beacon",
  portfolio: "the fees are converted to dollars and you choose what they buy for you — or take the creator's basket",
  unknown: "a payout mode this build does not know — open the launch to see what it says",
};

interface Row {
  vault: Address;
  distributor: Address;
  /** What this launch pays and through which contract. Anything but
   *  `distribution` / `tontine` means the claim path does not apply to it —
   *  which is what keeps it out of "Collect everything". */
  mode: Mode;
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

/**
 * Every vault's rows, in TWO rounds — not two rounds per vault.
 *
 * **The cost per vault was three serialised round trips.** `read()` awaited one
 * vault at a time, and inside it the symbol and the holder's balance waited on
 * the five fixed reads. Measured 2026-09-16 in the fixture world with 20 ms per
 * read: 7 vaults took ~28 round trips, 20 took ~64, 50 took ~149 — a straight
 * line, and at a real round trip of ~250 ms that is 37 seconds of blank table
 * for a registry of fifty, against a node that throttles at 25 requests a
 * second. The registry is meant to hold many more than seven.
 *
 * Issued in ONE tick they are folded by `batch.multicall` into a single
 * `eth_call` (`chain.ts`), so the whole index costs two round trips whatever
 * the count. The old code said it went one at a time ON PURPOSE, because a
 * burst of separate calls is how a public RPC decides to rate-limit you — that
 * was true and is the same lesson the creation screen learned: the answer is to
 * stop issuing a burst, not to issue it slowly. A batch is one request.
 *
 * Round two exists because it depends on round one: an unlaunched vault has no
 * token, so no symbol and no balance to ask for.
 */
async function readAll(vaults: readonly Address[]): Promise<{ rows: Row[]; unread: number }> {
  // One vault that reverts must not take the registry down with it. That was
  // already the old behaviour's weakness and it only gets likelier as the list
  // grows: a mode whose `economics` moves, a vault half-way through a
  // migration. It is skipped and COUNTED — a row quietly missing from an index
  // is the one failure this screen cannot afford to hide.
  const base = (await Promise.all(vaults.map(async (vault) => {
    try {
      const [token, distributor, hook, eco, reserve, mode] = await Promise.all([
        pub.readContract({ address: vault, abi: vaultAbi, functionName: "token" }),
        pub.readContract({ address: vault, abi: vaultAbi, functionName: "DISTRIBUTOR" }),
        pub.readContract({ address: vault, abi: vaultAbi, functionName: "hookStatus" }),
        pub.readContract({ address: vault, abi: vaultAbi, functionName: "economics" }),
        pub.readContract({ address: vault, abi: vaultAbi, functionName: "rewardsPool" }),
        // In the SAME tick as the five above, so it rides the multicall that
        // was already going out: the mode costs nothing to read and deciding
        // without it costs a holder their gas on a revert.
        REGISTRY
          ? pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "modeOf", args: [vault] })
            .catch(() => null)
          : Promise.resolve(null),
      ]);
      return { vault, token, distributor, hook, eco, reserve, mode };
    } catch {
      return null;
    }
  }))).filter((b) => b !== null);
  const unread = vaults.length - base.length;

  // The tickers go through `symbolsOf`, which retries the ROUND: one refused
  // batch used to put a "?" on every row at once, which reads as a registry of
  // broken tokens rather than as a node that said no.
  const me = viewer;
  const tokens = base.map((b) => b.token).filter((t) => t !== ZERO_ADDR);
  const named = new Map<string, string | null>();
  (await symbolsOf(tokens)).forEach((sym, i) => named.set(tokens[i]!.toLowerCase(), sym));

  // The visitor's position: read ONLY if they are connected. With no wallet the
  // page reads in full -- we do not charge a connection for looking.
  const rows = await Promise.all(base.map(async (b) => {
    const live = b.token !== ZERO_ADDR;
    const symbol = live ? named.get(b.token.toLowerCase()) ?? "?" : "—";
    const [balance, decimals] = await Promise.all([
      live && me
        ? pub.readContract({ address: b.token, abi: erc20, functionName: "balanceOf", args: [me] }).catch(() => 0n)
        : Promise.resolve(0n),
      live && me
        ? pub.readContract({ address: b.token, abi: erc20, functionName: "decimals" }).catch(() => 18)
        : Promise.resolve(18),
    ]);
    return {
      vault: b.vault,
      distributor: b.distributor,
      mode: modeName(b.mode),
      token: b.token,
      symbol,
      status: Number(b.hook[0]),
      effectiveAt: b.hook[2],
      grossOfVolume: b.eco[3],
      rewardsOfVolume: b.eco[4],
      creatorOfVolume: b.eco[5],
      platformOfVolume: b.eco[6],
      reserve: b.reserve,
      balance,
      decimals,
    };
  }));
  return { rows, unread };
}

/** What the visitor holds of this launch, at its own precision. */
const qty = (r: Row) =>
  Number(formatUnits(r.balance, r.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** The link to a launch's own page. `KEEP` carries `?mock` across, so the
 *  fixture world does not end at this screen.
 *
 *  It used to carry `&from=<registry>` as well — the back link, from before the
 *  tabs existed. Nothing has read it for months: every shared link since has
 *  carried an address nobody could use, and a reader looking for what consumes
 *  it finds nothing. The tab bar is the way back. */
const href = (r: Row) =>
  `./index.html?token=${r.vault}&distributor=${r.distributor}${KEEP}`;

/** One launch, as a row of the list.
 *
 *  The whole row is the link, but the ticker is a real `<a>`: middle-click and
 *  the keyboard have to reach a launch, and a `click` handler on a `<tr>` gives
 *  them neither. A vault with nothing to claim keeps its row and loses its
 *  link — same `live` condition as before.
 *
 *  The notes the cards carried ("Pons has proposed sending these fees
 *  elsewhere", the date a redirect takes effect) move onto the pill's `title`:
 *  a column list has no room for a paragraph, and dropping them would drop the
 *  only warning this screen gives. */
function row(r: Row): string {
  const h = HOOK[r.status] ?? HOOK[0]!;
  const live = r.status === 1 || r.status === 2;
  // A vault whose economics could not be derived shows nothing rather than a
  // stale figure: `economics` returns zeros when a Pons getter moves.
  const known = r.grossOfVolume > 0n;
  const held = r.balance > 0n;
  const chip = modeChip(r.mode);
  const why = [
    h.note,
    r.status === 2
      ? `effective ${new Date(Number(r.effectiveAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : "",
    known ? "" : "economics unavailable — a Pons getter did not answer",
  ].filter(Boolean).join(" · ");

  const name = live
    ? `<a class="sym" href="${href(r)}">${esc(r.symbol)}</a>`
    : `<span class="sym">${esc(r.symbol)}</span>`;

  return `<tr${live ? "" : ' aria-disabled="true"'}>
    <td class="c-vault">${name}${held ? `<span class="held">held</span>` : ""}${
    chip ? `<span class="mode" title="${esc(MODE_TITLE[r.mode] ?? "")}">${esc(chip)}</span>` : ""
  }</td>
    <td class="c-status"><span class="pill ${h.pill}"${why ? ` title="${esc(why)}"` : ""}>${
    esc(h.label)
  }</span></td>
    <td class="c-rate num">${known ? `<span class="rate">${pct(r.rewardsOfVolume)}</span>` : "—"}</td>
    <td class="c-split num"><span class="split">${
    known ? `${pct(r.creatorOfVolume)} / ${pct(r.platformOfVolume)}` : "—"
  }</span></td>
    <td class="c-res num">${eth(r.reserve)}</td>
    <td class="c-yours num">${held ? `<span class="mine">${esc(qty(r))}</span>` : `<span class="none">—</span>`}</td>
  </tr>`;
}

/** Set by the last read: how many vaults did not answer. Kept out of `#status`
 *  itself because the filter rewrites that node on every click. */
let unreadNote = "";

/** The list's own state. Client-side, over `lastRows`: no extra read, no URL,
 *  nothing persisted.
 *
 *  `Yours` and `Live only` are two INDEPENDENT checkboxes and no longer four
 *  mutually exclusive segments: "yours" and "collecting" were never alternatives
 *  — the question a holder asks is both at once — and one of the four had to be
 *  given up to ask it. `Live only` folds the old "Collecting" and "On the curve"
 *  together the other way round: they were the same question asked from its two
 *  ends. On by default, so the page opens on the launches that are running. */
type Sort = "Newest" | "Paid" | "Yours";
type Shown = "cards" | "table";
let list: Shown = "cards";
let onlyYours = false;
let onlyLive = true;
let sort: Sort = "Newest";

/** Live is what the fee hook says, not what the page wishes: `1` collecting and
 *  `2` a redirect merely PROPOSED, which is still collecting today. `0` has not
 *  launched and `3` has lost its fees — both are real launches and both stay
 *  one unchecked box away. */
const isLive = (r: Row) => r.status === 1 || r.status === 2;

/** Held first, then the chosen order.
 *
 *  Held-first is not decoration: a page listing fifty launches is unusable if
 *  the three that concern you are buried in it. The segment chooses the
 *  SECONDARY key, which is what "sort" means on a list that already has a
 *  reason to lift your own rows to the top.
 *
 *  `Newest` is the registry's own order reversed, which needs no read at all:
 *  `Payd.vaults()` appends, so the array IS creation order and `lastRows` keeps
 *  it. `Paid` and `Yours` sort on figures that arrive one round later
 *  (`extras`, `owed`), and both fall back to something already known rather
 *  than to nothing — otherwise the first paint of a sorted list is arbitrary
 *  and then jumps. */
function ordered(rows: Row[]): Row[] {
  const idx = new Map(rows.map((r, i) => [r.vault, i]));
  const paid = (r: Row) => extras.get(r.vault.toLowerCase())?.paidUsd ?? -1;
  const mine = (r: Row) => owed.get(r.vault.toLowerCase()) ?? -1;
  const by = (a: Row, b: Row) =>
    sort === "Paid"
      ? paid(b) - paid(a) || idx.get(b.vault)! - idx.get(a.vault)!
      : sort === "Yours"
      ? mine(b) - mine(a) || (b.balance === a.balance ? 0 : b.balance > a.balance ? 1 : -1)
      : idx.get(b.vault)! - idx.get(a.vault)!;
  return rows
    .filter((r) => (!onlyYours || r.balance > 0n) && (!onlyLive || isLive(r)))
    .sort((a, b) => (a.balance > 0n === b.balance > 0n ? by(a, b) : a.balance > 0n ? -1 : 1));
}

const HEAD = `<tr><th>Token</th><th>Status</th><th class="num">To holders</th>
  <th class="num">Creator / platform</th><th class="num">Waiting to buy</th>
  <th class="num">Yours</th></tr>`;

/** The badge a card carries, and only when something is wrong. A healthy
 *  launch says nothing: a grid where every cell has a coloured pill teaches the
 *  reader to ignore all of them. */
const BADGE: Record<number, [string, string]> = {
  0: ["not launched", "var(--dim)"],
  2: ["redirect scheduled", "var(--warn)"],
  3: ["fees redirected", "var(--bad)"],
};

/**
 * One launch, as the card grid's view-model.
 *
 * The secondary line is the one place the card adapts to the reader: their own
 * claim when they hold the token, the rate a trade pays holders when they do
 * not. Showing the rate to a holder would be the less useful of the two, and
 * showing an empty "yours" cell to everybody else would put a blank on most of
 * the grid.
 */
function cardOf(r: Row): Card {
  const ex = extras.get(r.vault.toLowerCase());
  const badge = BADGE[r.status];
  const held = r.balance > 0n;
  const mine = owed.get(r.vault.toLowerCase());
  const known = r.grossOfVolume > 0n;
  return {
    href: href(r),
    sym: r.symbol === "—" ? "?" : r.symbol,
    mode: r.mode,
    logo: ex?.logo ?? "",
    age: r.status === 0
      ? "on the curve"
      : ex?.ageSeconds === null || ex?.ageSeconds === undefined ? "" : ago(ex.ageSeconds),
    badge: badge?.[0] ?? "",
    badgeInk: badge?.[1] ?? "var(--dim)",
    alarm: r.status === 3,
    dim: r.status === 0,
    // Three sentences, and the difference between them matters: `—` is "not
    // read yet or never launched", `could not read` is a call that failed, and
    // a dollar figure is a figure. A zero is a real answer and prints as one.
    paid: r.status === 0 ? "—" : ex === undefined ? "—" : ex.paidUsd === null ? "could not read" : usd(ex.paidUsd),
    paidMuted: r.status === 3 || (ex !== undefined && ex.paidUsd === null),
    secondaryK: held ? "Yours to collect" : "To holders, of a trade",
    secondaryV: held
      ? mine === undefined ? "—" : usd(mine)
      : known ? pct(r.rewardsOfVolume) : "—",
    secondaryOk: held,
  };
}

/** Redraws the list from `lastRows` alone — every segment click lands here. */
function paintList(): void {
  const grid = document.getElementById("grid");
  if (!grid) return;
  const rows = ordered(lastRows);
  grid.innerHTML = list === "table"
    ? rows.length === 0
      ? ""
      : `<div class="tablewrap"><table class="lpt"><thead>${HEAD}</thead>
         <tbody>${rows.map(row).join("")}</tbody></table></div>`
    // The launch cell is the FIRST cell and not a button above the grid, so an
    // empty registry has something to show rather than a blank page under a
    // heading. It is also why this branch never returns "".
    : `<div class="cards">${launchCellHtml()}${rows.map((r) => cardHtml(cardOf(r))).join("")}</div>`;
  // `#status` carries both sentences, and the filter's must not erase the one
  // that says a vault is MISSING — every segment click comes through here.
  const status = document.getElementById("status");
  if (status && lastRows.length > 0) {
    status.textContent = rows.length === 0
      ? onlyLive || onlyYours
        ? "no launch matches these filters"
        : "no launch matches this filter"
      : "";
  }
  const partial = maybe("lp-partial");
  if (partial) {
    partial.hidden = unreadNote === "";
    const say = partial.querySelector("span");
    if (say) say.textContent = unreadNote;
  }
}

// ------------------------------------------------------------------- the rail
//
// The shell's left column, and — under 900px — the sheet the vault chip opens.
// It draws `lastRows`, which the Vaults view fills when it paints and
// `loadRail` fills for every other view.
//
// **It used to fill only when the Vaults view had been opened**, and that is
// precisely where a switcher is of no use: arriving on a launch — the link
// everybody actually shares — left the rail on "open Vaults to list them" and
// the chip on "All vaults", so moving from one vault to another meant going
// back to the list first, which re-read every vault a second time. Two batched
// round trips fix it, the same two the list itself pays.

/**
 * The shell's batch button: whether it shows, and what its badge counts.
 *
 * Split out of `paint()` because that function belongs to the index view and
 * the button does not. A launch page reached by a shared link fills its rows
 * through `loadRail` and never paints the list — so the one action that spans
 * every launch stayed hidden exactly where somebody holding several of them
 * would look for it.
 *
 * Conditioned on `connected` and not merely on there being a viewer: the batch
 * goes through `writeContract` with the viewer as the account, and a wallet
 * will not sign for an address somebody typed.
 */
function paintBatch(): boolean {
  const btn = maybe("lp-collect") as HTMLButtonElement | null;
  const canBatch = connected && COLLECTOR !== ZERO_ADDR;
  // Hidden on the TOKENS view, where the position card carries the same button
  // with the sentence that explains it. Two "Collect everything" on one screen
  // is a reader wondering whether they do different things. The card's presence
  // is what identifies the view — `#lp-pos` exists in no other markup — rather
  // than a second copy here of which view is on screen.
  const onTokens = document.getElementById("lp-pos") !== null;
  if (btn) btn.hidden = !canBatch || onTokens;
  const amt = maybe("lp-amt");
  // The badge counts launches, not ether. What the button will actually send is
  // only known after one artifact fetch per launch (`collectAll`), and a header
  // is not the place to spend that — a count is free and true.
  const held = lastRows.filter((r) => r.balance > 0n).length;
  if (amt) amt.textContent = held > 0 ? `${held} held` : "";
  return canBatch;
}

/** One rail line. Same four states as the list's pills, from the same table. */
function railRow(r: Row): string {
  const h = HOOK[r.status] ?? HOOK[0]!;
  const live = r.status === 1 || r.status === 2;
  const held = r.balance > 0n;
  const on = CURRENT !== "" && r.vault.toLowerCase() === CURRENT;
  const value = held ? qty(r) : r.grossOfVolume > 0n ? pct(r.rewardsOfVolume) : "—";
  const inner = `<span class="sq ${h.pill}"></span><span class="t">${esc(r.symbol)}</span>
    <span class="v${held ? " held" : ""}">${esc(value)}</span>`;
  return live
    ? `<a class="rrow${on ? " on" : ""}" href="${href(r)}">${inner}</a>`
    : `<span class="rrow dead">${inner}</span>`;
}

function paintRail(): void {
  const mine = document.getElementById("rail-mine");
  const all = document.getElementById("rail-all");
  if (!mine || !all) return;
  const needle = (document.getElementById("rail-filter") as HTMLInputElement | null)
    ?.value.trim().toUpperCase() ?? "";
  const shown = needle === ""
    ? lastRows
    : lastRows.filter((r) => r.symbol.toUpperCase().includes(needle));
  const held = shown.filter((r) => r.balance > 0n);
  const rest = shown.filter((r) => r.balance === 0n);

  mine.innerHTML = held.length === 0
    ? ""
    : `<span class="eyebrow">Your positions · ${held.length}</span>${held.map(railRow).join("")}`;
  all.innerHTML = rest.length === 0
    ? ""
    : `<span class="eyebrow">All · ${lastRows.length}</span>${rest.map(railRow).join("")}`;

  const total = document.getElementById("rail-total");
  if (total) {
    total.textContent = lastRows.length === 0
      ? ""
      : `${lastRows.length} token${lastRows.length > 1 ? "s" : ""}`;
  }
  const chipN = document.getElementById("vchip-n");
  const chipNm = document.querySelector<HTMLElement>("#vchip .nm");
  if (chipN) chipN.textContent = lastRows.length > 1 ? `+${lastRows.length - 1}` : "";
  if (chipNm) {
    const here = lastRows.find((r) => r.vault.toLowerCase() === CURRENT);
    chipNm.textContent = here ? here.symbol : "All tokens";
  }
}

/**
 * Fills the rail on a view that is not the list.
 *
 * The same two reads as `paint()` and none of its writes: the list's own shell
 * (`#grid`, `#status`, the batch button) does not exist outside the Vaults
 * view, and `paint()` writes into all of it. Sharing the reads rather than the
 * function is what keeps this from being a second source of rows — `lastRows`
 * is the one store, and whichever of the two ran last owns it.
 */
export async function loadRail(): Promise<void> {
  if (!REGISTRY || lastRows.length > 0) return;
  const all = document.getElementById("rail-all");
  if (all) all.innerHTML = `<span class="eyebrow">reading the tokens…</span>`;
  try {
    const vaults = await pub.readContract({
      address: REGISTRY, abi: registryAbi, functionName: "vaults",
    }) as readonly Address[];
    if (vaults.length === 0) {
      if (all) all.innerHTML = `<span class="eyebrow">no launch yet</span>`;
      return;
    }
    lastRows = (await readAll(vaults)).rows;
    paintRail();
    paintBatch();
  } catch {
    // The rail is a convenience; the launch on screen is not. It says what
    // happened and the next view that paints will fill it.
    if (all) all.innerHTML = `<span class="eyebrow">could not read the list — open Tokens to retry</span>`;
  }
}

/** The shell's own wiring: the collect button, the switcher sheet, the rail's
 *  filter and the list's segments. Bound ONCE, at import — these elements are
 *  in `index.html` and outlive every view, so binding them from `renderLaunchpad`
 *  would bind them again on every mount. */
{
  const sheet = (open: boolean) => {
    document.body.classList.toggle("sheet", open);
    const veil = document.getElementById("veil");
    if (veil) veil.hidden = !open;
    document.getElementById("vchip")?.setAttribute("aria-expanded", String(open));
  };
  // No registry, no rail and no switcher: there is one vault and nothing to
  // switch to. The chip would open an empty sheet on every phone.
  if (!REGISTRY) {
    for (const id of ["rail", "vchip"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  }
  // Before either filler has run there is nothing to project, and an empty
  // column reads as a broken one. `loadRail` replaces this within a round trip.
  const all = document.getElementById("rail-all");
  if (REGISTRY && all) {
    all.innerHTML = `<span class="eyebrow">reading the tokens…</span>`;
  }
  document.getElementById("lp-collect")?.addEventListener("click", () => {
    void collectAll().catch((e: Error) => {
      const head = document.getElementById("lp-say");
      if (head) head.textContent = `failed: ${String(e.message).split("\n")[0]!.slice(0, 120)}`;
    });
  });
  document.getElementById("vchip")?.addEventListener("click", () => {
    sheet(!document.body.classList.contains("sheet"));
    // On a wide screen the rail is already on show; the chip is the way TO it.
    (document.getElementById("rail-filter") as HTMLInputElement | null)?.focus();
  });
  document.getElementById("veil")?.addEventListener("click", () => sheet(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") sheet(false); });
  document.getElementById("rail-filter")?.addEventListener("input", paintRail);
  // A rail line is a real link: leaving the sheet open behind the next page
  // would be the one state nothing closes.
  //
  // The line for the vault ALREADY on screen is the exception. It is the one
  // marked `.on`, it is where the eye lands first, and following it reloaded
  // the whole app to arrive at the page it was already on — a flash, a second
  // scan, and the scroll position lost. It closes the sheet and stops there.
  document.getElementById("rail")?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("a.rrow");
    if (!row) return;
    sheet(false);
    if (row.classList.contains("on")) e.preventDefault();
  });
}

/** `f` over `items`, at most `n` of them in flight. The bound is the point: a
 *  gateway answers four requests and drops forty. */
async function mapLimit<T, R>(
  items: readonly T[],
  n: number,
  f: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await f(items[i]!, i);
    }
  }));
  return out;
}

/** The last render's rows: what the batch button needs to read back. */
let lastRows: Row[] = [];
/**
 * What the CARDS need and the table never did, keyed by vault, lowercased.
 *
 * A second store beside `lastRows` rather than fields on `Row`, because the two
 * arrive in different rounds and mean different things when absent: a `Row` with
 * no entry here has not been PRICED yet, which the card draws as `—`, and a row
 * missing from `lastRows` did not answer at all. Folding them would make the
 * first indistinguishable from the second on the first paint — every card would
 * open on "could not read" for the round it takes to fill.
 */
let extras = new Map<string, Extra>();
/** Dollars the viewer can still collect, per vault. Filled one round after
 *  `extras` because it costs an IPFS fetch per held launch, and emptied on every
 *  viewer change: showing the previous person's claim is the failure the whole
 *  repaint coalescing exists to avoid. */
let owed = new Map<string, number>();
let collecting = false;

/**
 * One paint at a time, and one more if something asked while it ran.
 *
 * The index painted TWICE on every load: `renderLaunchpad` paints on mount, and
 * `?address=0x…` then reaches `setViewer`, whose listener paints again — two
 * full passes over the registry before the visitor had touched anything.
 * Measured in the fixture world at 50 vaults, that was 858 reads where 429 say
 * the same thing. Connecting a wallet mid-paint did it too.
 *
 * Coalesced rather than debounced: the second request is not dropped, it is
 * SERVED, once, after the first — the viewer may have changed, and a page
 * showing the previous person's balances is the failure this avoids.
 */
let painting: Promise<void> | null = null;
let repaint = false;
function schedulePaint(): Promise<void> {
  if (painting) { repaint = true; return painting; }
  painting = (async () => {
    try {
      do { repaint = false; await paint(); } while (repaint);
    } finally { painting = null; }
  })();
  return painting;
}

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
  // BOTH, and neither of them assumed to exist. `#lp-say` sits beside the
  // button in the shell and is therefore visible from every view; `#lp-sum` is
  // the index's own footer line, which is where a reader looking at the list
  // expects it. Writing only into the second is what made a click from any
  // other view look like a button that does nothing — and, before the index had
  // ever been mounted, threw on a null element inside an async function, which
  // is the quietest failure there is.
  const say = (m: string) => {
    const head = maybe("lp-say");
    if (head) head.textContent = m;
    const foot = maybe("lp-sum");
    if (foot) foot.textContent = m;
  };
  if (!connected || !viewer) {
    return say("connect that wallet to collect — a pasted address can be read, not signed for");
  }
  const me = viewer;

  collecting = true;
  btn.disabled = true;
  try {
    // EVERY launch, not only those with a non-zero balance. A share is
    // CUMULATIVE and does not expire (§S18): somebody who held and then sold is
    // still owed everything the epochs they held credited them. Filtering on the
    // current balance is exactly how you miss those -- and they have no way of
    // knowing it from this page.
    // ONLY the launches that pay through `claim`. `Collector.collect` calls
    // `distribute` on every distributor it is handed, and a backing or lottery
    // vault's second contract is not a `Distributor` at all: one of them in the
    // list reverts the whole batch, taking every other launch's share with it.
    // The mode comes from the registry, so this is decided before a proof is
    // built rather than by a read that happened to fail.
    const all = lastRows.filter((r) => payScreen(r.mode) === "claim");
    if (all.length === 0 && lastRows.length > 0) {
      return say(
        "none of these launches pays through a claim — a backing token is redeemed and a lottery "
        + "is collected by its winner, each from its own page",
      );
    }

    // The two CHAIN reads go in one tick each, for every launch at once: folded
    // into one `eth_call` by `batch.multicall`, they cost two round trips
    // instead of two per launch. Only a launch with something published is
    // carried into the next round.
    say(`reading ${all.length} launch${all.length > 1 ? "es" : ""}…`);
    const actives = await Promise.all(all.map((r) =>
      pub.readContract({ address: r.distributor, abi: distributorAbi, functionName: "activeRoot" })
        .catch(() => 0n) as Promise<bigint>));
    const live = all
      .map((r, i) => ({ r, active: actives[i] ?? 0n }))
      .filter((x) => x.active > 0n);

    const rootRows = await Promise.all(live.map((x) =>
      pub.readContract({
        address: x.r.distributor, abi: distributorAbi, functionName: "roots", args: [x.active],
      }).catch(() => null) as Promise<readonly [Address, number, Hex, Hex, number, Hex] | null>));

    // The artifacts are the part that cannot be folded: one IPFS fetch each,
    // through a gateway, and nothing on chain batches that. Four at a time --
    // serially this was one round trip per launch and the button sat there for
    // a registry of any size; all at once would bring the gateway down before
    // the RPC.
    //
    // They are KEPT, not consumed: the pushed half and the claimed half are two
    // different trees over the same file, and fetching it twice would double
    // the only slow part of this button.
    //
    // ponytail: still O(launches) fetches. Beyond a hundred or so it will take
    // an artifact-side index (which holder appears where) rather than
    // downloading every one of them.
    let done = 0;
    const arts = (await mapLimit(live, 4, async (x, i) => {
      const root = rootRows[i];
      if (!root) return null;
      try {
        const art = await fetchArtifact(x.r.distributor, root[5], x.active);
        return art ? { distributor: x.r.distributor, art } : null;
      } catch {
        return null; // an unreadable launch does not cancel the others
      } finally {
        say(`reading launch ${++done} of ${live.length}…`);
      }
    })).filter((a) => a !== null);

    const eth = provider();
    if (!eth) return say("connect a wallet first — the Connect button, top right");
    if (!(await ensureChain(eth, say))) return;
    const wallet = createWalletClient({ account: me, chain, transport: custom(eth) });

    // --- half one: what the ROUTER can settle, in a single transaction.
    //
    // `Collector.collect` calls `distribute`, which verifies against the PUSH
    // root — the shares large enough to deserve a pushed delivery — and refunds
    // its gas. It is the cheap half and it goes first.
    const pushable: { distributor: Address; a: ClaimArgs }[] = [];
    for (const { distributor, art } of arts) {
      const a = await buildClaim(distributor, me, art, undefined, "push");
      if (a.stocks.length > 0) pushable.push({ distributor, a });
    }

    let settled = 0;
    if (pushable.length > 0) {
      say(`collecting ${pushable.length} launch${pushable.length > 1 ? "es" : ""}…`);
      const hash = await wallet.writeContract({
        address: COLLECTOR, abi: collectorAbi, functionName: "collect",
        args: [
          me,
          pushable.map((p) => p.distributor),
          pushable.map((p) => p.a.stocks),
          pushable.map((p) => p.a.cumulative),
          pushable.map((p) => p.a.proofs),
        ],
        account: me, chain,
      });
      say(`sent: ${hash.slice(0, 10)}…`);
      await pub.waitForTransactionReceipt({ hash });
      settled = pushable.length;
      say(`collected ${settled}, checking what is left…`);
    }

    // --- half two: everything else, claimed BY the holder.
    //
    // **A router cannot claim for anybody.** `Distributor.claim` settles from
    // `msg.sender` (`Collector.sol` says so in its first paragraph), so a share
    // under the automatic-delivery floor can only be moved by a transaction the
    // holder signs themselves — there is no contract that can stand in, and
    // that is the property that makes the floor safe to have at all.
    //
    // What CAN be done is send those claims as one wallet batch. Built after
    // the router call on purpose: `buildClaim` re-reads `owedTo`, so whatever
    // the Collector has just settled drops out by itself rather than being
    // claimed twice.
    const rest: { distributor: Address; a: ClaimArgs }[] = [];
    for (const { distributor, art } of arts) {
      const a = await buildClaim(distributor, me, art, undefined, "claim");
      if (a.stocks.length > 0) rest.push({ distributor, a });
    }

    if (rest.length > 0) {
      const n = await sendClaims(eth, wallet, me, rest, say);
      settled += n;
    }

    if (settled === 0) {
      return say("nothing owed on any of these launches — every share already reached you");
    }
    await schedulePaint();
  } catch (e) {
    say("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 120));
  } finally {
    collecting = false;
    btn.disabled = false;
  }
}

/**
 * Claims, from the holder's own wallet, on every launch that still owes them
 * something.
 *
 * **One confirmation when the wallet can do it.** EIP-5792's `wallet_sendCalls`
 * sends several calls as one batch, each with the holder as the sender — which
 * is exactly what `claim` requires and what no router can provide. Wallets that
 * do not implement it answer with an error, and then it is one transaction per
 * launch: more confirmations, the same result, and the reader is told which it
 * is rather than left to guess from the number of prompts.
 *
 * Returns how many launches were settled.
 */
async function sendClaims(
  eth: Eth1193,
  wallet: ReturnType<typeof createWalletClient>,
  me: Address,
  rest: { distributor: Address; a: ClaimArgs }[],
  say: (m: string) => void,
): Promise<number> {
  const calls = rest.map((x) => ({
    to: x.distributor,
    data: encodeFunctionData({
      abi: distributorAbi, functionName: "claim",
      args: [x.a.stocks, x.a.cumulative, x.a.proofs],
    }),
  }));

  try {
    say(`claiming ${rest.length} launch${rest.length > 1 ? "es" : ""} in one batch…`);
    const answer = await eth.request({
      method: "wallet_sendCalls",
      params: [{ version: "1.0", chainId: `0x${CHAIN_ID.toString(16)}`, from: me, calls }],
    });
    // A wallet that does not know the method usually throws; some answer `null`
    // instead, and taking that for a batch id would report a success nothing
    // sent. An id is a string, or `{ id }` in the newer shape — anything else
    // falls through to one transaction per launch.
    const ref = typeof answer === "string" ? answer : (answer as { id?: string } | null)?.id;
    if (!ref) throw new Error("wallet_sendCalls answered nothing");
    // The id is not a transaction hash and there is nothing here that can wait
    // on it honestly: the wallet decides how the batch is submitted. Say it is
    // sent, and let the next paint read the result off the chain.
    say(`claimed ${rest.length} in one batch (${ref.slice(0, 10)}…)`);
    return rest.length;
  } catch {
    // No EIP-5792 here. One at a time, and a refusal in the middle keeps what
    // came before it — every claim is independent.
    let ok = 0;
    for (const [i, x] of rest.entries()) {
      say(`claiming ${i + 1} of ${rest.length}… (one confirmation each: this wallet cannot batch)`);
      try {
        const hash = await wallet.writeContract({
          address: x.distributor, abi: distributorAbi, functionName: "claim",
          args: [x.a.stocks, x.a.cumulative, x.a.proofs],
          account: me, chain,
        });
        await pub.waitForTransactionReceipt({ hash });
        ok += 1;
      } catch (e) {
        say(`stopped after ${ok} of ${rest.length}: ${String((e as Error).message).split("\n")[0]!.slice(0, 90)}`);
        break;
      }
    }
    return ok;
  }
}

/// Builds the creation screen inside its own view. Separated from the index
/// because they are two tabs now, not one page with a query flag.
export async function renderCreate(host: HTMLElement): Promise<void> {
  if (!REGISTRY) return;
  host.innerHTML = CREATE_SHELL;
  await mountCreate(REGISTRY);
}

/// Builds the index of every launch INSIDE `host`. It used to assign
/// `document.body.innerHTML`, which threw away the header, the tabs and the
/// footer the rest of the app has — three screens that looked like three
/// different products. Called from `main.ts`.
export async function renderLaunchpad(host: HTMLElement): Promise<void> {
  if (!REGISTRY) return;

  host.innerHTML = SHELL;

  // The two segmented groups and the two checkboxes re-read `lastRows`. Bound
  // here and not at import, because this markup is replaced with the shell on
  // every mount — and delegated within each group, so a segment added to the
  // HTML needs no second edit here.
  for (const [id, set] of [
    ["lp-list", (v: string) => { list = v as Shown; }],
    ["lp-sort", (v: string) => { sort = v as Sort; }],
  ] as const) {
    $(id).addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      set(b.dataset.l ?? b.dataset.s ?? "");
      for (const o of Array.from($(id).querySelectorAll("button"))) {
        o.setAttribute("aria-pressed", String(o === b));
      }
      paintList();
    });
  }
  for (const [id, set] of [
    ["lp-mine", (v: boolean) => { onlyYours = v; }],
    ["lp-live", (v: boolean) => { onlyLive = v; }],
  ] as const) {
    const box = $(id) as HTMLInputElement;
    // The DOM is the source for both, not the module variable: the input is
    // re-created on every mount and arrives with its own `checked` from the
    // markup, so reading it back is what keeps the two from disagreeing.
    box.checked = id === "lp-live" ? onlyLive : onlyYours;
    box.addEventListener("change", () => { set(box.checked); paintList(); });
  }
  // The position card's button is the header's, said where a holder is looking.
  // Same function, so there is one collect path and not two.
  $("lp-pos-go").addEventListener("click", () => {
    void collectAll().catch((e: Error) => {
      const foot = maybe("lp-sum");
      if (foot) foot.textContent = `failed: ${String(e.message).split("\n")[0]!.slice(0, 120)}`;
    });
  });

  await schedulePaint();
}

// A pasted address is a viewer like any other: the rows below read `balanceOf`,
// which asks for no signature. Repainting on every change is what keeps the
// index, the launch page and the Treasury showing the same person.
onViewer(() => {
  // Connecting a wallet is what turns the batch button on, and that has to hold
  // on a launch page too — where there is no grid to repaint.
  paintBatch();
  if (!document.getElementById("grid")) return;
  void schedulePaint();
});

async function paint(): Promise<void> {
  if (!REGISTRY) return;
  try {
    const vaults = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "vaults" });
    if (vaults.length === 0) {
      // Not a blank page under a heading. An empty registry is exactly the
      // state the "Launch a token" cell is best at: it is the only thing there
      // is to show, and it says what to do about it.
      $("status").textContent = "no launch yet — yours would be the first";
      $("grid").innerHTML = list === "table" ? "" : `<div class="cards">${launchCellHtml()}</div>`;
      lastRows = [];
      paintRail();
      paintBatch();
      return;
    }

    const { rows, unread } = await readAll(vaults as readonly Address[]);

    // Kept in REGISTRY order: "Newest" is that order reversed, and a list
    // sorted here would have no way back to it. The display order is
    // `ordered()`'s business.
    lastRows = rows;

    unreadNote = unread === 0
      ? ""
      : `${unread} launch${unread > 1 ? "es" : ""} did not answer and ${
        unread > 1 ? "are" : "is"} not in this list — reload to read ${unread > 1 ? "them" : "it"} again`;
    // Where these figures come from: no server, no indexer. It is the property
    // that sets this page apart, and it deserves to be written down.
    $("lp-count").textContent =
      `${rows.length} launch${rows.length > 1 ? "es" : ""} · read from the chain in your browser`;
    paintList();
    paintRail();

    // Not conditioned on the balance: a sold share is still owed, and
    // yesterday's holder would never see the button if holding were required.
    // An undeployed Collector leaves the page STRICTLY as it was — it is a
    // shortcut, not a dependency (`paintBatch`).
    const held = rows.filter((r) => r.balance > 0n).length;
    const canBatch = paintBatch();
    paintPosition(held, canBatch);

    const whose = connected ? "you hold" : "this address holds";
    $("lp-sum").textContent = viewer
      ? held === 0
        ? canBatch
          ? "you hold none of these — a share you were owed before selling is still collectable"
          : `${whose} none of these`
        : canBatch
        ? `you hold ${held} of ${rows.length} — one button settles every share you are owed, whatever its size`
        : connected
        ? `you hold ${held} of ${rows.length} — collecting is per launch, from its own page`
        : `${whose} ${held} of ${rows.length} — connect that wallet to collect`
      : "connect a wallet, or paste an address above, to see which of these it holds";

    // --- the rounds the CARDS add, and they run after the paint on purpose.
    //
    // The grid is drawn and readable — ticker, mode, status, age — before any of
    // this is asked for, and each figure lands in place when it arrives. Awaited
    // BEFORE the first paint, the page would have shown nothing at all for the
    // three round trips the headline costs, on a screen whose whole claim is
    // that it reads the chain in front of you.
    await fillCards(rows);
  } catch (e) {
    $("status").textContent = `cannot read the chain: ${(e as Error).message}`;
  }
}

/**
 * The card figures: the headline for every launch, then what the viewer is owed
 * on the ones they hold.
 *
 * Two rounds and not one, because the second is the expensive one — an artifact
 * per held launch, through a gateway — and the first is what the whole grid is
 * for. A failure in either leaves the grid exactly as it was: `readExtras`
 * answers `null` per launch for what it could not read and the card says so,
 * `readOwed` simply has no entry and the card keeps its rate line.
 *
 * `extras` is REPLACED rather than merged. A viewer change repaints through here
 * (`onViewer`), and a stale entry for a vault that has since left the registry
 * would price a card that is no longer on the page.
 */
async function fillCards(rows: readonly Row[]): Promise<void> {
  // BEFORE the read, not after it. Every viewer change repaints through here,
  // and `cardOf` reads this map: left in place for the round `readExtras` takes,
  // the grid showed the PREVIOUS viewer's claim on any launch the new one also
  // holds. Cleared first, the worst case is an em dash for one round.
  owed = new Map();
  extras = await readExtras(rows);
  paintList();

  const me = viewer;
  if (!me) return;
  // Only what pays through a claim, and only what is held: a backing or lottery
  // launch has no claimable share to price (`payScreen`), and an artifact fetch
  // for a launch the viewer does not hold buys a figure nobody asked for.
  const held = rows.filter((r) => r.balance > 0n && payScreen(r.mode) === "claim");
  if (held.length === 0) return;
  owed = await readOwed(held, me, (v) => extras.get(v.toLowerCase())?.legs ?? []);
  paintList();
}

/**
 * The position card: shown only when a wallet is connected, and counting
 * launches.
 *
 * Same two conditions as the header's own button, from the same `paintBatch`
 * — `connected` and not merely a viewer, because the batch is signed and a
 * wallet will not sign for an address somebody pasted. A pasted address still
 * reads every figure on the page; what it cannot do is collect.
 */
function paintPosition(held: number, canBatch: boolean): void {
  const card = maybe("lp-pos");
  if (card) card.hidden = !canBatch;
  const n = maybe("lp-pos-n");
  if (n) n.textContent = String(held);
  const u = maybe("lp-pos-u");
  if (u) u.textContent = held === 1 ? "token held" : "tokens held";
  // The chip filters, which is a READ: a pasted address holds tokens like
  // anybody else and gets to narrow the list to them. Only the BUTTON above
  // needs a wallet, because only the button signs — the same line the rest of
  // this file draws, and the reason the page never asks anyone to connect in
  // order to look.
  const chip = maybe("lp-mine-chip");
  if (chip) chip.hidden = viewer === null;
}
