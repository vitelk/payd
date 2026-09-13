/**
 * `@payd/sdk` — the element to drop in, and the package's entry point.
 *
 * ```html
 * <script type="module" src="https://paydprotocol.eth.limo/sdk/payd.js"></script>
 * <payd-vault vault="0x…"></payd-vault>
 * ```
 *
 * A NATIVE ELEMENT rather than a React component or a home-made widget: custom
 * elements work as they are in static HTML, in React, in Vue, in Webflow, and
 * their shadow DOM guarantees that no stylesheet of the host site can break the
 * card — nor the other way round. Zero dependency to install, zero framework for
 * the creator to choose.
 *
 * The styling is driven from outside through CSS variables (`--payd-*`), which
 * cross the shadow DOM by construction. Anyone wanting to redraw it entirely
 * takes `createPayd()` and never mounts the element — or reads `docs/SDK.md` and
 * talks to the contracts directly.
 */
export * from "./payd.js";
import { createPayd, connect, EXPLORER, type Payd, type VaultInfo, type Share } from "./payd.js";
import { formatUnits, type Address, type PublicClient } from "viem";

const CSS = `
:host { display:block; container-type:inline-size;
  --_bg: var(--payd-bg, #0b0b0c);
  --_fg: var(--payd-fg, #f3f3f2);
  --_mut: var(--payd-muted, #8b8b88);
  --_line: var(--payd-line, #26262a);
  --_ok: var(--payd-accent, #ccff00);
  --_r: var(--payd-radius, 14px);
  --_sans: var(--payd-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  --_mono: var(--payd-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
:host([theme="light"]) {
  --_bg: var(--payd-bg, #ffffff); --_fg: var(--payd-fg, #0b0b0c);
  --_mut: var(--payd-muted, #6b6b68); --_line: var(--payd-line, #e6e6e3); }
.card { background:var(--_bg); color:var(--_fg); border:1px solid var(--_line);
  border-radius:var(--_r); padding:1.15rem 1.25rem 1.25rem; font:400 14px/1.5 var(--_sans);
  display:flex; flex-direction:column; gap:.85rem; box-sizing:border-box; }
.hd { display:flex; align-items:baseline; justify-content:space-between; gap:.5rem; flex-wrap:wrap; }
.sym { font:600 1.15rem/1.2 var(--_sans); letter-spacing:-.01em; }
.pill { font:.68rem var(--_mono); padding:.15rem .5rem; border-radius:6px;
  border:1px solid var(--_line); color:var(--_mut); white-space:nowrap; }
.pill.ok { border-color:color-mix(in srgb, var(--_ok) 45%, transparent); color:var(--_ok); }
.pill.warn { border-color:#c9a227; color:#c9a227; }
.pill.bad { border-color:#d1495b; color:#d1495b; }
.lede { margin:0; color:var(--_mut); text-wrap:pretty; }
.lede b { color:var(--_fg); font-weight:600; }
.rows { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.6rem .9rem; }
.k { font:500 .66rem var(--_mono); letter-spacing:.1em; text-transform:uppercase; color:var(--_mut); }
.v { font:400 .95rem var(--_mono); font-variant-numeric:tabular-nums; }
.legs { display:flex; flex-wrap:wrap; gap:.3rem; }
.leg { font:.7rem var(--_mono); padding:.18rem .45rem; border-radius:6px;
  border:1px solid var(--_line); color:var(--_mut); }
.leg b { color:var(--_fg); font-weight:500; }
table { border-collapse:collapse; width:100%; font-size:.82rem; }
td { padding:.18rem 0; border-bottom:1px solid var(--_line); }
td:last-child { text-align:right; font-family:var(--_mono); font-variant-numeric:tabular-nums; }
tr:last-child td { border-bottom:0; }
button { font:600 .875rem var(--_sans); padding:.6rem .9rem; border:0; border-radius:9px;
  background:var(--_ok); color:#0b0b0c; cursor:pointer; width:100%; }
button:disabled { background:var(--_line); color:var(--_mut); cursor:default; }
.msg { font:.75rem/1.5 var(--_mono); color:var(--_mut); text-wrap:pretty; margin:0; word-break:break-word; }
.msg a { color:inherit; }
a.more { font:.72rem var(--_mono); color:var(--_mut); text-decoration:none; }
a.more:hover { color:var(--_fg); }
`;

const HOOK = ["not launched", "collecting", "redirect scheduled", "fees lost"] as const;
const HOOK_CLASS = ["", "ok", "warn", "bad"] as const;

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** "30 min", "2 h 15", "4 d" — never a raw timestamp. */
function duration(s: number): string {
  if (s <= 0) return "now";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} d`;
}

export interface MountOptions {
  vault: Address;
  rpc?: string;
  gateways?: string[];
  theme?: "dark" | "light";
  /** Countdown refresh interval, in ms. 0 switches it off. */
  tick?: number;
  /**
   * An already-built viem client, when the host has one.
   *
   * `createPayd` has always accepted it; not forwarding it here meant the
   * element could only ever talk to a real RPC. With it, the card renders
   * against a stubbed transport — which is how it is looked at without a
   * deployment, and what `payd.test.ts` already does for the data layer.
   */
  client?: PublicClient;
}

/**
 * Mounts a card into `el`. Returns a `stop()` that clears the timer — to be
 * called in the host's `useEffect`/`onUnmounted`, or an interval outlives the
 * page.
 */
export function mount(el: HTMLElement, o: MountOptions): { stop: () => void } {
  const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
  // Compare before writing: `setAttribute` fires `attributeChangedCallback`
  // even for an identical value, and `<payd-vault theme="light">` would then
  // loop forever.
  if (o.theme === "light" && el.getAttribute("theme") !== "light") el.setAttribute("theme", "light");
  root.innerHTML = `<style>${CSS}</style><div class="card"><p class="msg">loading…</p></div>`;
  const card = root.querySelector(".card") as HTMLElement;

  const payd: Payd = createPayd({ vault: o.vault, rpc: o.rpc, gateways: o.gateways, client: o.client });
  let info: VaultInfo | null = null;
  let account: Address | null = null;
  let shares: Share[] | null = null;
  let busy = false;
  let note = "";
  let timer: ReturnType<typeof setInterval> | undefined;

  const say = (s: string) => { note = s; render(); };

  function render() {
    if (!info) return;
    const due = (shares ?? []).filter((s) => s.owed > 0n);
    // `null` is UNAVAILABLE and the row goes away. A countdown drawn from a
    // timestamp we could not read would tick as convincingly as a real one.
    const left = info.epochEnd === null ? null : info.epochEnd - Math.floor(Date.now() / 1000);
    const row = (k: string, v: string | null) =>
      v === null ? "" : `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    card.innerHTML =
      `<div class="hd"><span class="sym">$${esc(info.symbol)}</span>` +
      (info.hookStatus === null ? ""
        : `<span class="pill ${HOOK_CLASS[info.hookStatus]}">${HOOK[info.hookStatus]}</span>`) +
      `</div>` +

      (info.rewardsOfVolumeBps !== null && info.rewardsOfVolumeBps > 0
        ? `<p class="lede"><b>${pct(info.rewardsOfVolumeBps)} of every trade</b> comes back to holders as ` +
          `Robinhood stock tokens. No staking, no sign-up — just hold $${esc(info.symbol)}.</p>`
        : `<p class="lede">Holders are paid in Robinhood stock tokens. No staking, no sign-up — ` +
          `just hold $${esc(info.symbol)}.</p>`) +

      `<div class="rows">` +
      row("Next buy", left === null ? null : duration(left)) +
      row("Every", info.epochLength === null ? null : duration(info.epochLength)) +
      row("Basket", info.basket.length ? `${info.basket.length} stocks` : null) +
      `</div>` +

      (info.basket.length
        ? `<div class="legs">${info.basket.map((l) =>
            `<span class="leg"><b>${esc(l.symbol)}</b> ${pct(l.bps)}</span>`).join("")}</div>`
        : "") +

      (shares && shares.length
        ? `<table>${shares.map((s) =>
            `<tr><td>${esc(s.symbol)}</td><td>${Number(formatUnits(s.owed, s.decimals)).toFixed(6)}</td></tr>`
          ).join("")}</table>`
        : "") +

      `<button id="go"${busy ? " disabled" : ""}>${
        busy ? "…" :
        !account ? "Check my share" :
        due.length ? `Collect ${due.length} stock${due.length > 1 ? "s" : ""}` :
        "Nothing to collect"
      }</button>` +

      (note ? `<p class="msg">${note}</p>` : "") +
      `<a class="more" href="${EXPLORER}/address/${info.vault}" target="_blank" rel="noopener">vault ${
        info.vault.slice(0, 6)}…${info.vault.slice(-4)} ↗</a>`;

    const btn = card.querySelector("#go") as HTMLButtonElement | null;
    if (btn) btn.disabled = busy || (!!account && due.length === 0);
    btn?.addEventListener("click", onClick);
  }

  async function onClick() {
    busy = true; say("");
    try {
      if (!account) {
        account = await connect();
        shares = await payd.shares(account);
        busy = false;
        // No entry in the active root: the normal case of a holder who arrived
        // after the last publication, or is below the value threshold.
        say(shares.length ? "" : "no share in the current root yet — check back after the next epoch");
        return;
      }
      say("building proofs…");
      const res = await payd.claim(account);
      if (!res) { busy = false; say("nothing to collect"); return; }
      shares = await payd.shares(account);
      busy = false;
      say(`sent — <a href="${EXPLORER}/tx/${res.hash}" target="_blank" rel="noopener">${
        res.hash.slice(0, 10)}… ↗</a>`);
    } catch (e) {
      busy = false;
      say(esc(String((e as Error).message).split("\n")[0]!.slice(0, 140)));
    }
  }

  payd.info()
    .then((i) => {
      info = i;
      render();
      // The countdown is the only thing that moves without interaction. A
      // minute is enough and costs no RPC: `epochEnd` only changes at the
      // rollover, which the next `info()` will pick up.
      const ms = o.tick ?? 30_000;
      if (ms > 0) timer = setInterval(() => {
        if (info && info.epochEnd !== null && info.epochEnd - Math.floor(Date.now() / 1000) <= 0) {
          payd.info().then((n) => { info = n; render(); }).catch(() => {});
        } else render();
      }, ms);
    })
    .catch((e) => {
      card.innerHTML = `<p class="msg">payd: ${esc(String((e as Error).message).split("\n")[0]!.slice(0, 140))}</p>`;
    });

  return { stop: () => clearInterval(timer) };
}

/** `<payd-vault vault="0x…" rpc="…" theme="light">`. */
export class PaydVaultElement extends HTMLElement {
  // `vault` is observed, not merely read at mount: a framework binding
  // `:vault="…"` sets the attribute AFTER inserting the element, and the card
  // would stay stuck on its missing-attribute message.
  static observedAttributes = ["vault", "theme", "rpc", "gateways"];
  #handle: { stop: () => void } | null = null;
  connectedCallback() { this.#remount(); }
  attributeChangedCallback() { if (this.isConnected) this.#remount(); }
  disconnectedCallback() { this.#handle?.stop(); this.#handle = null; }

  #remount() {
    this.#handle?.stop();
    this.#handle = null;
    const vault = this.getAttribute("vault") as Address | null;
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    if (!vault) {
      root.innerHTML =
        `<p style="font:12px monospace;color:#d1495b">&lt;payd-vault&gt; needs a vault="0x…" attribute</p>`;
      return;
    }
    this.#handle = mount(this, {
      vault,
      rpc: this.getAttribute("rpc") ?? undefined,
      gateways: this.getAttribute("gateways")?.split(",") ?? undefined,
      theme: this.getAttribute("theme") === "light" ? "light" : "dark",
    });
  }
}

// Registered when the module loads: that is what keeps the integration down to
// two lines of HTML. Guarded against a double `define`, which throws.
if (typeof customElements !== "undefined" && !customElements.get("payd-vault")) {
  customElements.define("payd-vault", PaydVaultElement);
}
