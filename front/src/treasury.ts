/**
 * The platform token's page: the Treasury's four pockets, and what each launch
 * owes it.
 *
 * A MODE of the single page, like the index (`?registry=`), and for the same
 * reason: two HTML entry points would split the bundle, and the "one JS file,
 * one CID to pin" guarantee only holds with one entry.
 *
 * **What this page does NOT show, and why.** The mockup planned a table "what
 * each launch sent the Treasury, last 7 days", with the traded volume. Nothing
 * on-chain traces either the volume per launch or the provenance of what arrives
 * at the Treasury: it would take an indexer, and there is none. Rather than
 * inventing a column, we show what is READABLE -- the rate engraved in each
 * vault and what is waiting to be pushed there -- and the columns are named
 * accordingly.
 */
import { parseAbi, formatEther, type Address } from "viem";
import { EXPLORER, REGISTRY as REGISTRY_ADDR, TREASURY as TREASURY_ADDR } from "./config.js";
// Same reason as in `registry.ts`: one client, the one the mock patches.
import { pub, symbolsOf } from "./chain.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const some = (a: string): Address | null => (a === ZERO_ADDR ? null : (a as Address));

// From the config, which already applies the `?treasury=` / `?registry=`
// overrides — same reason as in `registry.ts`.
export const TREASURY = some(TREASURY_ADDR);
const PAD = some(REGISTRY_ADDR);


const treasuryAbi = parseAbi([
  "function devBps() view returns (uint256)",
  "function burnBps() view returns (uint256)",
  "function lpBps() view returns (uint256)",
  "function rewardsBps() view returns (uint256)",
  "function devPool() view returns (uint256)",
  "function burnPool() view returns (uint256)",
  "function lpPool() view returns (uint256)",
  "function rewardsPool() view returns (uint256)",
  "function platformToken() view returns (address)",
  "function DEV_WALLET() view returns (address)",
  "function TIMELOCK() view returns (address)",
]);
const padAbi = parseAbi(["function vaults() view returns (address[])"]);
const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function PLATFORM_BPS() view returns (uint256)",
  "function platformPool() view returns (uint256)",
  "function economics() view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)"]);

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (b: bigint) => `${(Number(b) / 100).toFixed(2)} %`;
const eth = (v: bigint) => `${Number(formatEther(v)).toFixed(4)} ETH`;

/// Markup taken from `Payd Payd.dc.html`, styles included: we copy, we do not
/// redraw. The colours go through our variables, whose values are identical to
/// the design's to the bit.
const SHELL = `
  <style>
    /* The shell's grammar: a head, a row of figures, then panels. The rule
       across each section title and the 1px outline round each surface are
       gone — the surface is what separates now. */
    .tr { display: flex; flex-direction: column; gap: 1.25rem; }
    .tr .hd { padding: 0; border-bottom: 0; max-width: none; }
    .tr .eyebrow { font: 500 .6875rem var(--mono); letter-spacing: .16em; text-transform: uppercase;
      color: var(--ok); }
    .tr h1 { font: 600 2.25rem/1.05 var(--sans); letter-spacing: -.03em; margin: 0; }
    .tr .lede { color: var(--mut); margin: .6rem 0 0; max-width: 34rem; text-wrap: pretty; }
    .tr .lede strong { color: var(--fg); font-weight: 500; }
    .tr .head { display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
      gap: .875rem; margin-top: 0; }
    @media (max-width: 56.25rem) { .tr .head { grid-template-columns: repeat(2, minmax(0,1fr)); } }
    .tr .stat { border: 0; border-radius: var(--r-lg); background: var(--surface);
      padding: 1.25rem 1.375rem; container-type: inline-size; }
    @media (max-width: 56.25rem) { .tr .stat { padding: 1rem 1.125rem; } }
    .tr .stat .k { font: 500 .6875rem/1 var(--mono); letter-spacing: .12em; text-transform: uppercase;
      color: var(--dim); }
    .tr .stat .trv { font: 500 clamp(.875rem,13cqw,1.75rem)/1 var(--mono); font-variant-numeric: tabular-nums;
      letter-spacing: -.03em; margin-top: .35rem; white-space: nowrap; }
    .tr .stat .trv.hl { color: var(--ok); }
    .tr .stat .n { font-size: .78125rem; color: var(--mut); margin-top: .3rem; text-wrap: pretty; }
    .tr .rule { display: flex; align-items: baseline; gap: 1rem; margin: .75rem 0 0; flex-wrap: wrap; }
    .tr .rule h2 { font: 600 1.0625rem/1 var(--sans); letter-spacing: -.015em;
      color: var(--fg); margin: 0; }
    .tr .rule .fill { display: none; }
    .tr .rule .hint { font: .75rem var(--mono); color: var(--dim); }
    .tr .trpanel { border: 0; border-radius: var(--r-lg); background: var(--surface);
      padding: 1.25rem 1.375rem 1.375rem; }
    .tr .split { display: flex; height: 44px; border-radius: var(--r-md); overflow: hidden; border: 0; }
    .tr .split i { display: flex; align-items: center; justify-content: center; color: var(--bg);
      font: 600 .8125rem var(--mono); font-style: normal; overflow: hidden; white-space: nowrap; }
    .tr .pockets { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,16rem),1fr));
      gap: .75rem; margin-top: 1.25rem; }
    .tr .pocket { border: 0; border-radius: var(--r-md); background: var(--bg);
      padding: 1rem 1.125rem; display: flex; flex-direction: column; gap: .45rem; }
    .tr .pocket .top { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
    .tr .pocket .name { display: flex; align-items: center; gap: .5rem; font: 500 .875rem var(--sans); }
    .tr .pocket .trdot { width: 9px; height: 9px; border-radius: 2px; }
    .tr .pocket .bps { font: 500 .8125rem var(--mono); font-variant-numeric: tabular-nums;
      color: var(--mut); }
    .tr .pocket code { font: .75rem var(--mono); color: var(--fg); }
    .tr .pocket p { margin: 0; font-size: .78125rem; line-height: 1.55; color: var(--mut);
      text-wrap: pretty; }
    .tr .pocket .who { font: .6875rem var(--mono); color: var(--dim); }
    .tr .trpanel .foot { margin: 1.125rem 0 0; padding-top: 1rem; border-top: 1px solid var(--hair);
      font-size: .8125rem; color: var(--mut); max-width: 52rem; text-wrap: pretty; }
    .tr .wrap { overflow-x: auto; background: var(--surface); border-radius: var(--r-lg); }
    .tr table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: .8125rem; }
    .tr th { text-align: right; font: 500 .6875rem/1 var(--mono); letter-spacing: .12em;
      text-transform: uppercase; color: var(--dim); padding: .65rem 1.375rem .75rem; border: 0; }
    .tr th:first-child { text-align: left; }
    .tr td { padding: .85rem 1.375rem; border: 0; border-top: 1px solid var(--hair); text-align: right;
      font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .tr td:first-child { text-align: left; font-weight: 600; font-family: var(--sans); }
    .tr .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,20rem),1fr));
      gap: .875rem; margin-top: 0; }
    .tr .trpanel.own, .tr .trpanel.cannot { padding: 1.375rem 1.5rem; }
    .tr .trpanel.cannot { border-left: 2px solid var(--pen); }
    .tr .eyebrow.dim { color: var(--dim); }
    .tr .own-p { margin: .75rem 0 0; font-size: .875rem; line-height: 1.65; color: var(--mut);
      text-wrap: pretty; }
    .tr .own-p strong { color: var(--fg); font-weight: 500; }
    .tr .own-p em { color: var(--fg); font-style: normal; }
    .tr .mini { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
      gap: .875rem; margin-top: 1.125rem; padding-top: 1rem; border-top: 1px solid var(--hair); }
    /* These cells carry a label and a figure like a card but are not one, so
       they need their own containment: without it the shared figure rule sizes
       itself against the VIEWPORT, and a 28px "0.6900 ETH" overflows a 128px
       cell. */
    .tr .mini > div { container-type: inline-size; }
    .tr .mini .k { font: 500 .6875rem/1 var(--mono); letter-spacing: .12em; text-transform: uppercase;
      color: var(--dim); }
    .tr .mini .v { margin-top: .3rem; }
    .tr .cannots { display: flex; flex-direction: column; gap: .7rem; margin-top: 1rem; }
    .tr .cannots .row { display: flex; gap: .625rem; align-items: flex-start; }
    .tr .cannots .no { font: .6875rem var(--mono); padding: .2rem .45rem; border-radius: 6px;
      border: 0; background: var(--raised); color: var(--ok); flex-shrink: 0; }
    .tr .cannots .t { font-size: .8125rem; color: var(--mut); text-wrap: pretty; }
  </style>
  <div class="tr">
    <div class="hd">
      <a class="back" id="tr-back" hidden
         style="display:inline-block;margin:0 0 .75rem;font:.75rem var(--mono);color:var(--mut);text-decoration:none">&larr; all launches</a>
      <h1 id="tr-h1">Treasury</h1>
      <p class="lede" id="tr-lede">reading the chain…</p>
    </div>

    <div class="head" id="tr-head"></div>

    <div class="rule"><h2>The four pockets</h2><span class="fill"></span>
      <span class="hint">weights set by the 48 h timelock</span></div>
    <div class="trpanel">
      <div class="split" id="tr-split"></div>
      <div class="pockets" id="tr-pockets"></div>
      <p class="foot" id="tr-foot"></p>
    </div>

    <div class="rule"><h2>What each launch owes the Treasury</h2><span class="fill"></span>
      <span class="hint" id="tr-rows-hint"></span></div>
    <div class="wrap"><table>
      <thead><tr><th>Launch</th><th>Platform rate</th><th>Of its volume</th>
        <th>Waiting to be sent</th></tr></thead>
      <tbody id="tr-rows"></tbody>
    </table></div>

    <div class="pair">
      <div class="trpanel own">
        <div class="eyebrow" id="tr-own-h">The platform token's own vault</div>
        <p class="own-p" id="tr-own-p"></p>
        <div class="mini" id="tr-own"></div>
      </div>
      <div class="trpanel cannot">
        <div class="eyebrow dim">What the platform cannot do</div>
        <div class="cannots" id="tr-cannot"></div>
      </div>
    </div>
  </div>`;

/// Builds the Treasury page INSIDE `host`. It used to assign
/// `document.body.innerHTML`, which cost it the header, the tabs and the
/// footer — see the same note in `registry.ts`.
export async function renderTreasury(host: HTMLElement): Promise<void> {
  if (!TREASURY) return;
  host.innerHTML = SHELL;
  // The "← all launches" link stays hidden: the "Launches" TAB is the way back
  // now, and the same action offered twice, in two styles, is what made these
  // screens read as separate sites in the first place.

  const [devBps, burnBps, lpBps, rewBps, devPool, burnPool, lpPool, rewPool, platToken, dev] =
    await Promise.all([
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "devBps" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "burnBps" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "lpBps" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "rewardsBps" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "devPool" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "burnPool" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "lpPool" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "rewardsPool" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "platformToken" }),
      pub.readContract({ address: TREASURY, abi: treasuryAbi, functionName: "DEV_WALLET" }),
    ]);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const sym = platToken !== ZERO
    ? await pub.readContract({ address: platToken, abi: erc20, functionName: "symbol" }).catch(() => "the platform token")
    : null;
  const name = sym ? `$${sym}` : "The platform token";

  // "the pad" was the last of the Launchpad name left in a shipped surface —
  // the registry is what every other screen and the shop window call it.
  // Not "earns": the vault RECEIVES a share, which it spends on stocks. The verb
  // is the contract's, and the subject is the vault -- never the holder, and
  // never a return the reader is told to expect.
  // The title is the screen's name; the sentence that used to BE the title now
  // opens the summary, where a 2.25rem head has room for a noun and not a claim.
  $("tr-h1").textContent = "Treasury";
  $("tr-lede").innerHTML =
    `<strong>${esc(name)} receives a share of every token launched through the registry.</strong> ` +
    `Each token sends a share of what reaches it to the Treasury, which splits every arrival into four ` +
    `pockets — and ${pct(rewBps as bigint)} of it buys real stocks for ${esc(name)} holders. ` +
    `<strong>The rate is written into each token at birth</strong>: raising it later reaches new launches only, ` +
    `never an existing one.`;

  const balance = await pub.getBalance({ address: TREASURY });
  $("tr-head").innerHTML = [
    ["Held right now", eth(balance), "across the four pockets", true],
    ["Waiting for holders", eth(rewPool as bigint), `buys stocks for ${esc(name)} holders`, false],
    ["Waiting for the dev", eth(devPool as bigint), "one exit, fixed at deployment", false],
    // `platformToken()` reads zero until `bindPlatform` has been called, which
    // takes the generation key AND the timelock (FLOWS.md §6). Until then the
    // Treasury collects normally and `fundPlatformRewards` has nowhere to send
    // the rewards pocket — a live state worth naming, not a blank.
    ["Platform token", sym ? esc(name) : "not bound yet",
      sym
        ? "bound, irreversibly"
        : "bindPlatform has not been called — the rewards pocket has nothing to fund yet",
      false],
  ].map(([k, v, n, hl]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v${hl ? " hl" : ""}">${v}</div>` +
    `<div class="n">${n}</div></div>`).join("");

  const pockets: [string, bigint, bigint, string, string, string, string][] = [
    [`${name} rewards`, rewBps as bigint, rewPool as bigint, "var(--ok)", "fundPlatformRewards()",
      "Does not buy the token. It buys stocks for its holders — the loop reaches people rather than the chart.", "anyone"],
    ["Dev", devBps as bigint, devPool as bigint, "var(--mut)", "payDev()",
      "One exit, set at deployment and with no setter.", `only ${dev}`],
    ["Burn", burnBps as bigint, burnPool as bigint, "var(--warn)", "buyAndBurn()",
      "Buys the platform token on the open market and burns it, inside a price band.", "anyone"],
    ["LP", lpBps as bigint, lpPool as bigint, "var(--dim)", "addLiquidity()",
      "Pairs ETH with the token against the v4 PoolManager. There is no LP token to burn and no function here that removes the position, so the depth cannot be pulled.", "anyone"],
  ];
  // The bar CARRIES its labels, as in the mockup: 40 px tall, each segment
  // writing its name and its rate inside it. A separate legend forced a round
  // trip between the colour and the word.
  $("tr-split").innerHTML = pockets
    .map(([k, b, , c]) =>
      `<i style="flex:${Number(b)};background:${c}">${esc(k)} ${pct(b)}</i>`).join("");
  $("tr-pockets").innerHTML = pockets.map(([k, b, pool, c, call, n, who]) =>
    `<div class="pocket">
       <div class="top">
         <span class="name"><span class="trdot" style="background:${c}"></span>${esc(k)}</span>
         <span class="bps">${pct(b)}</span>
       </div>
       <code>${esc(call)}</code>
       <p>${esc(n)}</p>
       <p>holding ${eth(pool)}</p>
       <span class="who">${esc(who.length > 30 ? who.slice(0, 12) + "…" + who.slice(-6) : who)}</span>
     </div>`).join("");
  $("tr-foot").textContent =
    "Every permissionless action here refunds its caller's gas, so nobody has to volunteer to keep it running.";

  // --- what each launch owes ------------------------------------------------
  renderTail(name, null, rewPool as bigint);
  if (!PAD) {
    $("tr-rows-hint").textContent = "add ?registry=0x… to list the launches";
    return;
  }
  const vaults = (await pub.readContract({ address: PAD, abi: padAbi, functionName: "vaults" })) as readonly Address[];
  $("tr-rows-hint").textContent = "read live — no history, see below";

  // TWO rounds for the whole registry, not four per vault. Issued in one tick
  // they are folded into a single `eth_call` by `batch.multicall`, so this
  // table costs the same at fifty launches as at one — it used to cost three
  // serialised round trips each, which is the shape the index was measured at
  // (~149 of them for 50 vaults) before the same change was made there.
  const base = await Promise.all(vaults.map((v) =>
    Promise.all([
      pub.readContract({ address: v, abi: vaultAbi, functionName: "token" }) as Promise<Address>,
      pub.readContract({ address: v, abi: vaultAbi, functionName: "PLATFORM_BPS" }) as Promise<bigint>,
      pub.readContract({ address: v, abi: vaultAbi, functionName: "platformPool" }) as Promise<bigint>,
      pub.readContract({ address: v, abi: vaultAbi, functionName: "economics" })
        .catch(() => null) as Promise<readonly bigint[] | null>,
    ]).then(
      ([tok, rate, pool, e]) => ({ v, tok, rate, pool, e }),
      // An unreadable vault does not cancel the list.
      () => null,
    )));

  // Through `symbolsOf` so a refused batch is asked again instead of turning
  // every launch in the table into a "?".
  const toks = base.filter((b) => b && b.tok !== ZERO).map((b) => b!.tok);
  const named = new Map<string, string | null>();
  (await symbolsOf(toks)).forEach((sym, i) => named.set(toks[i]!.toLowerCase(), sym));

  const rows = base.map((b) => {
    if (!b) return "";
    const s = b.tok !== ZERO ? named.get(b.tok.toLowerCase()) ?? "?" : "—";
    const ofVolume = b.e && b.e[6] !== undefined && b.e[6] > 0n ? pct(b.e[6]) : "—";
    return `<tr><td><a href="${EXPLORER}/address/${b.v}">${esc(s)}</a></td>` +
      `<td>${pct(b.rate)}</td><td>${ofVolume}</td><td>${eth(b.pool)}</td></tr>`;
  }).filter(Boolean);
  $("tr-rows").innerHTML = rows.join("")
    || `<tr><td colspan="4" class="note">no launch yet</td></tr>`;
}

/**
 * The two panels at the bottom: the platform token's vault, and what the
 * platform CANNOT do.
 *
 * **One of the mockup's claims was corrected, not copied.** It announced
 * "listing a stock without the 48 h timelock, OR without a live 30-minute TWAP
 * behind it". Checked in `Payd.allowStocks`: the function imposes `onlyTimelock`
 * and looks at NO TWAP. The guarantee exists, but elsewhere and later -- at
 * purchase time, a leg with no usable floor is SKIPPED rather than bought blind.
 * That is what is written here. Announcing a guarantee the contract does not
 * give is the one defect a page like this cannot afford.
 */
function renderTail(name: string, ownBps: bigint | null, rewPool: bigint): void {
  $("tr-own-h").textContent = `${name} itself`;
  $("tr-own-p").innerHTML =
    `${esc(name)} is launched through the registry like any other token, and it is born at ` +
    `<strong>platformBps = 0</strong> — the Treasury paying itself in two hops would inflate every ` +
    `number on this page. So ${esc(name)} holders receive the full share of its own volume, ` +
    `<em>plus</em> the platform pocket from every other launch.`;
  $("tr-own").innerHTML = [
    ["Own volume", ownBps !== null ? pct(ownBps) : "—", false],
    ["Platform pocket", eth(rewPool), true],
    ["Its platform rate", "0 %", false],
  ].map(([k, v, hl]) =>
    `<div><div class="k">${esc(String(k))}</div>` +
    `<div class="v${hl ? " hl" : ""}">${esc(String(v))}</div></div>`).join("");

  $("tr-cannot").innerHTML = [
    "Raise the platform's share on a token that already launched — the rate is engraved at birth.",
    "Redirect the platform share: the Payd holds the Treasury address as an immutable, with no setter.",
    "Withdraw a launched token's rewards or a holder's stock — no privileged withdrawal exists anywhere.",
    "List a stock without the 48-hour timelock. A listed stock with no usable price floor is then " +
    "skipped at purchase rather than bought blind.",
  ].map((t) => `<div class="row"><span class="no">no</span><span class="t">${esc(t)}</span></div>`)
    .join("");
}
