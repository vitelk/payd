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
import { pub } from "./chain.js";

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
    .tr .hd { padding: 2.75rem 0 1.75rem; border-bottom: 1px solid var(--hair); max-width: 48rem; }
    .tr .eyebrow { font: 500 .6875rem var(--mono); letter-spacing: .16em; text-transform: uppercase;
      color: var(--ok); }
    .tr h1 { font: 600 clamp(1.75rem,4vw,2.5rem)/1.1 var(--sans); letter-spacing: -.025em;
      margin: .875rem 0 0; }
    .tr .lede { color: var(--mut); margin: .875rem 0 0; text-wrap: pretty; }
    .tr .lede strong { color: var(--fg); font-weight: 500; }
    .tr .head { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,12rem),1fr));
      gap: .75rem; margin-top: 1.5rem; }
    .tr .stat { border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
      padding: 1.125rem 1.25rem; }
    .tr .stat .k { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .tr .stat .trv { font: 500 1.5rem var(--mono); font-variant-numeric: tabular-nums;
      letter-spacing: -.02em; margin-top: .35rem; }
    .tr .stat .trv.hl { color: var(--ok); }
    .tr .stat .n { font-size: .78125rem; color: var(--mut); margin-top: .3rem; text-wrap: pretty; }
    .tr .rule { display: flex; align-items: center; gap: .75rem; margin: 2.75rem 0 1rem; }
    .tr .rule h2 { font: 500 .6875rem/1 var(--mono); letter-spacing: .16em; text-transform: uppercase;
      color: var(--ok); margin: 0; }
    .tr .rule .fill { flex: 1; height: 1px; background: var(--hair); }
    .tr .rule .hint { font: .75rem var(--mono); color: var(--dim); }
    .tr .trpanel { border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
      padding: 1.25rem 1.375rem 1.375rem; }
    .tr .split { display: flex; height: 40px; border-radius: 8px; overflow: hidden;
      border: 1px solid var(--line); }
    .tr .split i { display: flex; align-items: center; justify-content: center; color: var(--bg);
      font: 500 .75rem var(--mono); font-style: normal; overflow: hidden; white-space: nowrap; }
    .tr .pockets { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,16rem),1fr));
      gap: .75rem; margin-top: 1.25rem; }
    .tr .pocket { border: 1px solid var(--line); border-radius: 10px; background: var(--bg);
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
    .tr .wrap { overflow-x: auto; }
    .tr table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
    .tr th { text-align: right; font: 500 .6875rem var(--mono); letter-spacing: .1em;
      text-transform: uppercase; color: var(--dim); padding: .7rem .75rem;
      border-bottom: 1px solid var(--line); }
    .tr th:first-child { text-align: left; padding-left: 0; }
    .tr th:last-child { padding-right: 0; }
    .tr td { padding: .7rem .75rem; border-bottom: 1px solid var(--hair); text-align: right;
      font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .tr td:first-child { text-align: left; padding-left: 0; font-weight: 600; font-family: var(--sans); }
    .tr td:last-child { padding-right: 0; }
    .tr .pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,20rem),1fr));
      gap: .75rem; margin-top: 2.5rem; }
    .tr .trpanel.own, .tr .trpanel.cannot { padding: 1.375rem 1.5rem; }
    .tr .trpanel.cannot { border-left: 2px solid var(--pen); }
    .tr .eyebrow.dim { color: var(--dim); }
    .tr .own-p { margin: .75rem 0 0; font-size: .875rem; line-height: 1.65; color: var(--mut);
      text-wrap: pretty; }
    .tr .own-p strong { color: var(--fg); font-weight: 500; }
    .tr .own-p em { color: var(--fg); font-style: normal; }
    .tr .mini { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
      gap: .875rem; margin-top: 1.125rem; padding-top: 1rem; border-top: 1px solid var(--hair); }
    .tr .mini .k { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .tr .mini .trv { font: 500 1.125rem var(--mono); margin-top: .2rem; }
    .tr .mini .trv.hl { color: var(--ok); }
    .tr .cannots { display: flex; flex-direction: column; gap: .7rem; margin-top: 1rem; }
    .tr .cannots .row { display: flex; gap: .625rem; align-items: flex-start; }
    .tr .cannots .no { font: .6875rem var(--mono); padding: .1rem .45rem; border-radius: 6px;
      border: 1px solid rgba(204,255,0,.45); color: var(--ok); flex-shrink: 0; }
    .tr .cannots .t { font-size: .8125rem; color: var(--mut); text-wrap: pretty; }
  </style>
  <div class="tr">
    <div class="hd">
      <a class="back" id="tr-back" hidden
         style="display:inline-block;margin:0 0 .75rem;font:.75rem var(--mono);color:var(--mut);text-decoration:none">&larr; all launches</a>
      <div class="eyebrow">The platform token</div>
      <h1 id="tr-h1">The platform token's vault receives a share of every launch in the registry.</h1>
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

export async function renderTreasury(): Promise<void> {
  if (!TREASURY) return;
  document.body.innerHTML = SHELL;
  if (PAD) {
    const b = $("tr-back") as HTMLAnchorElement;
    b.href = `./index.html?registry=${PAD}`;
    b.hidden = false;
  }

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
  $("tr-h1").textContent = `${name}'s vault receives a share of every launch in the registry.`;
  $("tr-lede").innerHTML =
    `Each vault sends a share of what reaches it to the Treasury, which splits every arrival into four ` +
    `pockets — and ${pct(rewBps as bigint)} of it buys real stocks for ${esc(name)} holders through its own vault. ` +
    `<strong>The rate is written into each vault at birth</strong>: raising it later reaches new launches only, ` +
    `never an existing one.`;

  const balance = await pub.getBalance({ address: TREASURY });
  $("tr-head").innerHTML = [
    ["Held right now", eth(balance), "across the four pockets", true],
    ["Waiting for holders", eth(rewPool as bigint), `funds ${esc(name)}'s own vault`, false],
    ["Waiting for the dev", eth(devPool as bigint), "one exit, fixed at deployment", false],
    ["Platform token", sym ? esc(name) : "not bound yet",
      sym ? "bound, irreversibly" : "the Treasury has no token yet", false],
  ].map(([k, v, n, hl]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v${hl ? " hl" : ""}">${v}</div>` +
    `<div class="n">${n}</div></div>`).join("");

  const pockets: [string, bigint, bigint, string, string, string, string][] = [
    [`${name} rewards`, rewBps as bigint, rewPool as bigint, "var(--ok)", "fundPlatformRewards()",
      "Does not buy the token. It funds its vault, which buys stocks for holders — the loop reaches people rather than the chart.", "anyone"],
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

  const rows: string[] = [];
  for (const v of vaults) {
    try {
      const [tok, rate, pool] = await Promise.all([
        pub.readContract({ address: v, abi: vaultAbi, functionName: "token" }) as Promise<Address>,
        pub.readContract({ address: v, abi: vaultAbi, functionName: "PLATFORM_BPS" }) as Promise<bigint>,
        pub.readContract({ address: v, abi: vaultAbi, functionName: "platformPool" }) as Promise<bigint>,
      ]);
      const s = tok !== ZERO
        ? await pub.readContract({ address: tok, abi: erc20, functionName: "symbol" }).catch(() => "?")
        : "—";
      const e = await pub.readContract({ address: v, abi: vaultAbi, functionName: "economics" })
        .catch(() => null) as readonly bigint[] | null;
      const ofVolume = e && e[6] !== undefined && e[6] > 0n ? pct(e[6]) : "—";
      rows.push(
        `<tr><td><a href="${EXPLORER}/address/${v}">${esc(s)}</a></td>` +
        `<td>${pct(rate)}</td><td>${ofVolume}</td><td>${eth(pool)}</td></tr>`);
    } catch { /* an unreadable vault does not cancel the list */ }
  }
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
  $("tr-own-h").textContent = `${name}'s own vault`;
  $("tr-own-p").innerHTML =
    `${esc(name)} is launched through the registry like any other token, and its vault is born at ` +
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
    "Raise the platform's share on a vault that already exists — the rate is engraved at birth.",
    "Redirect the platform share: the Payd holds the Treasury address as an immutable, with no setter.",
    "Withdraw a child vault's rewards or a holder's stock — no privileged withdrawal exists anywhere.",
    "List a stock without the 48-hour timelock. A listed stock with no usable price floor is then " +
    "skipped at purchase rather than bought blind.",
  ].map((t) => `<div class="row"><span class="no">no</span><span class="t">${esc(t)}</span></div>`)
    .join("");
}
