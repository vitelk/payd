/**
 * ticker.ts — the shop window's three live numbers.
 *
 * The site is ONE hand-written static file with no build and, until this, no
 * JavaScript at all (`docs/DEPLOY_FRONT.md`). That property was worth keeping
 * and it is not worth keeping at the price of the only sentence that makes
 * somebody hold the token: what holding it has paid.
 *
 * So the compromise is narrow. This is a separate bundle, built from the app's
 * already-tested modules, loaded as a deferred module and mounted into three
 * spans that **already contain a value in the HTML**. The page is complete and
 * honest before a single byte of script runs: the static figures are the ones
 * measured at the last publication and labelled as such, and the script's whole
 * job is to replace them with today's and say so. No script, no network, a
 * hostile gateway serving only the HTML — the shop window still reads correctly.
 *
 * It signs nothing, connects to no wallet and asks for nothing. One RPC, read.
 */
import { parseAbi } from "viem";
import { pub } from "./chain.js";
import { DISTRIBUTION_FACTORY_V3, REGISTRY } from "./config.js";
import { readMetrics } from "./metrics.js";
import { yieldOf } from "./yield.js";

const set = (id: string, v: string) => {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
};

const usd = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;

/** Whole units, because a shop window is read at a glance and 402,194,169 is a
 *  number a reader counts digits on. One decimal below 100M so a small supply
 *  does not round to a flat "0M". */
const millions = (v: number) => `${(v / 1e6).toFixed(v < 1e8 ? 1 : 0)}M`;

function age(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  if (d >= 1) return `${d} day${d > 1 ? "s" : ""}`;
  const h = Math.floor(seconds / 3600);
  return h >= 1 ? `${h} hour${h > 1 ? "s" : ""}` : `${Math.floor(seconds / 60)} minutes`;
}

/**
 * The one button on the page. `user-select:all` on the address already makes it
 * a single click to select with no script at all, so this is an improvement on
 * that and never a precondition: if the bundle never loads, the address is
 * still there and still selectable.
 */
function wireCopy() {
  // `Array.from` rather than `for..of`: the DOM lib this project targets types
  // a NodeList without an iterator, and spreading it is the one-line fix.
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-copy]"))) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? "");
        const was = b.textContent;
        b.textContent = "copied";
        setTimeout(() => (b.textContent = was), 1200);
      } catch {
        // Denied clipboard permission, or an insecure origin. Select the
        // address instead of pretending the copy worked.
        const el = document.getElementById("ca");
        if (el) getSelection()?.selectAllChildren(el);
      }
    });
  }
}

/**
 * The one state on this page that changes without a republication: whether the
 * registry still builds through the factory before Distribution V3.
 *
 * A vault is immutable once built, so sending somebody to create one through
 * the old default costs them the per-vault `setExcluded` ritual for the life of
 * their launch. The button therefore carries the hold — but from
 * `Payd.factory()`, so the timelock's `setFactory` lifts it by itself, on a page
 * pinned to IPFS that nobody edits.
 *
 * Silent in both directions when the read fails: the static page already offers
 * the link, and the app's own creation screen asks the same contract the same
 * question before letting anyone sign. Two doors, one source, and neither of
 * them a date.
 */
async function holdIfOldFactory(): Promise<void> {
  const note = document.getElementById("pd-hold");
  const btn = document.getElementById("pd-create");
  if (!note || !btn) return;
  const f = await pub.readContract({
    address: REGISTRY,
    abi: parseAbi(["function factory() view returns (address)"]),
    functionName: "factory",
  }) as string;
  if (f.toLowerCase() === DISTRIBUTION_FACTORY_V3.toLowerCase()) return;
  btn.classList.remove("p");
  btn.classList.add("s", "wait");
  btn.textContent = "Launch a token — on hold";
  note.innerHTML = "Launching opens when <b>Distribution V3</b> becomes the registry's default "
    + "factory. A launch is immutable once built, so the app waits rather than build you the previous "
    + "version. Everything else on this page is live.";
  note.hidden = false;
}

async function main() {
  wireCopy();
  // Before the figures: it is the only thing on the page that can send a
  // reader somewhere they should not go yet, and it costs one call.
  await holdIfOldFactory().catch(() => { /* the link stays, and the app re-asks */ });
  const m = await readMetrics();
  if (!m) return; // the static figures stay, and they say when they were taken
  const y = yieldOf(m);

  set("pd-paid", usd(m.paidUsd));
  set("pd-supply", `${millions(m.floatTokens)} tokens`);
  set("pd-burnt", `${m.burntPct.toFixed(2)} %`);
  if (y) set("pd-per100", usd(y.per100));
  set("pd-since", `live · ${age(m.ageSeconds)} of fees, read from the chain just now`);
}

void main();
