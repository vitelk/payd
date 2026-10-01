/**
 * card.ts — the social card, drawn from the chain rather than from a screenshot.
 *
 *     pnpm --filter offchain card [out.png]
 *
 * Same numbers as `value`, same read, same pass: it calls `collect()` rather
 * than re-deriving anything. A card and a report that disagree about $48 would
 * be worse than having no card.
 *
 * Rendering goes through headless Chrome, which is already how the brand assets
 * are exported (BRAND.md, "Exported assets") — no toolchain to install, and the
 * page is written next to the PNG so a layout bug is inspectable in a browser.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { collect, type Value } from "./value.js";

/**
 * `currentEpoch` is 0-indexed and counts the epoch IN PROGRESS, so its value is
 * also the number of epochs already behind us — which is what the card claims
 * the ETH was spent over. Do not add one to it.
 */
/** X renders a 16:9 card without cropping; 2x keeps the mono type crisp. */
const WIDTH = 1600;
const HEIGHT = 900;
const SCALE = 2;

/** BRAND.md: the palette lives in the SVGs, these are the four it uses. */
const BG = "#14130f";
const INK = "#eeebe3";
const MUT = "#97917f";
const ACC = "#ccff00";

const CHROME = env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const money = (n: number) => "$" + n.toFixed(2);

export function page(v: Value): string {
  const max = Math.max(...v.rows.map((r) => r.usd));
  const rows = v.rows
    .map(
      (r) => `<div class="row">
        <div><div class="sym">${r.symbol}</div><div class="qty">${r.qty.toFixed(6)} shares</div></div>
        <div class="bar"><span style="width:${((r.usd / max) * 100).toFixed(1)}%"></span></div>
        <div class="usd">${money(r.usd)}</div>
      </div>`,
    )
    .join("");

  return `<!doctype html><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${WIDTH}px; height:${HEIGHT}px; background:${BG}; color:${INK};
         font-family:ui-sans-serif,system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;
         padding:72px 80px; display:flex; flex-direction:column; }
  .mono { font-family:ui-monospace,'SF Mono',Menlo,monospace; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; }
  .eyebrow { font-size:23px; letter-spacing:.14em; text-transform:uppercase; color:${MUT}; }
  h1 { font-size:64px; font-weight:600; letter-spacing:-.025em; margin-top:14px; line-height:1.08; }
  h1 em { font-style:normal; color:${ACC}; }
  .totals { text-align:right; }
  .totals .big { font-size:92px; font-weight:600; color:${ACC}; letter-spacing:-.03em; line-height:1; }
  .totals .sub { font-size:24px; color:${MUT}; margin-top:14px; line-height:1.5; }
  .grid { flex:1; display:grid; grid-template-columns:1fr 1fr; gap:0 90px; align-content:center; }
  .row { display:grid; grid-template-columns:158px 1fr 122px; align-items:center; gap:22px;
         padding:17px 0; border-bottom:1px solid #262420; }
  .sym { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:29px; font-weight:600; }
  .qty { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:16px; color:${MUT}; white-space:nowrap; }
  .bar { height:12px; background:#262420; position:relative; }
  .bar span { position:absolute; inset:0 auto 0 0; background:${ACC}; }
  .usd { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:29px; text-align:right; }
  .foot { display:flex; justify-content:space-between; align-items:flex-end; font-size:22px;
          color:${MUT}; padding-top:34px; }
  .foot b { color:${INK}; font-weight:600; }
</style>
<div class="top">
  <div>
    <div class="eyebrow mono">Payd &nbsp;·&nbsp; epoch ${v.epoch} &nbsp;·&nbsp; robinhood chain</div>
    <h1>Trading fees, turned into<br><em>real stock</em>, for holders.</h1>
  </div>
  <div class="totals mono">
    <div class="big">${money(v.usd)}</div>
    <div class="sub">of stock bought so far<br>${v.eth.toFixed(6)} ETH spent over ${v.epoch} epochs</div>
  </div>
</div>
<div class="grid">${rows}</div>
<div class="foot mono">
  <div>every 30 min · no staking · no owner key</div>
  <div><b>paydprotocol.eth</b> &nbsp;·&nbsp; block ${v.block.toLocaleString("en-US")}</div>
</div>`;
}

const v = await collect();

// Same home as the keeper's epoch artifacts, and gitignored for the same
// reason: this is output, not source. Git is not an image host — a 240 kB PNG
// per epoch would be. What makes a published card permanent is its CID, not a
// commit.
const out = resolve(
  argv[2] ?? new URL(`../data/cards/payd-epoch${v.epoch}.png`, import.meta.url).pathname,
);
const html = out.replace(/\.png$/, "") + ".html";

mkdirSync(dirname(out), { recursive: true });
writeFileSync(html, page(v));

const r = spawnSync(
  CHROME,
  [
    "--headless", "--disable-gpu", "--hide-scrollbars",
    `--screenshot=${out}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--force-device-scale-factor=${SCALE}`,
    `file://${html}`,
  ],
  { cwd: dirname(out), stdio: ["ignore", "ignore", "pipe"] },
);
if (r.error || r.status !== 0) {
  console.error(`Chrome failed (${CHROME}). Set CHROME= to its path.\n${r.stderr?.toString() ?? r.error}`);
  exit(1);
}

console.log(
  `${out}  ${WIDTH * SCALE}x${HEIGHT * SCALE}\n` +
  `epoch ${v.epoch}, block ${v.block} — ${money(v.usd)} of stock, ${v.eth.toFixed(6)} ETH spent`,
);
