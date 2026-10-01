/**
 * dashboard.ts — the health report, on a screen, for a platform that has more
 * than one vault.
 *
 *   REGISTRY=0x… KEEPER_ADDRESS=0x… pnpm --filter offchain dashboard
 *   → http://127.0.0.1:8787
 *
 * It is `check.ts` with an HTML renderer in front of it, and that is the whole
 * design: every threshold — the publication lag, the 8-window at-risk ratio,
 * the refund blend, the keeper's runway — is argued in that file and read from
 * it. A dashboard holding its own copy of the thresholds is a dashboard that
 * reads green while `check` reads red, and the whole point of a screen is to be
 * believed.
 *
 * **Why not Grafana.** Grafana wants Prometheus, Prometheus wants an exporter,
 * and that is three services to host numbers one read-only script already
 * computes. If HISTORY is ever wanted — the publication lag over a week rather
 * than its value now — the cheap path is `check --json --all` appended to a
 * file on a cron and Grafana's textfile collector pointed at it, still with no
 * exporter of our own to keep in step with `check.ts`.
 *
 * It holds no key, signs nothing, sends no transaction, and binds to loopback:
 * the report names the keeper's balance and every vault's address, which is not
 * secret but is a map of what to watch, and there is no reason to serve it to a
 * network. `HOST=0.0.0.0` is deliberate if you want it, and is on you.
 */
import { createServer } from "node:http";
import { report, reportAll, bigints, type Report, type Row } from "./check.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
/** Matches `check --watch`. The epoch is 30 min, so anything faster only costs
 *  the endpoint its rate budget for figures that have not moved. */
const REFRESH_MS = 60_000;

/** Chain data on a page. A token symbol is holder-supplied and an address is
 *  not, but one escape for both is shorter than deciding per field. */
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const WORST: Row["state"][] = ["fail", "warn", "wait", "ok"];
/** A vault's headline state is its worst row. The alternative — an average, or
 *  a count — lets one FAIL hide behind nine OKs, which is the failure a screen
 *  exists to prevent. */
export function worst(rows: Row[]): Row["state"] {
  return WORST.find((s) => rows.some((r) => r.state === s)) ?? "ok";
}

function card(r: Report): string {
  const head = r.vault ? `${esc(r.vault)}` : "no FEE_VAULT in the environment";
  const rows = r.rows
    .map(
      (row) =>
        `<tr class="${row.state}"><td class="s">${row.state.toUpperCase()}</td>` +
        `<td class="l">${esc(row.label)}</td><td class="d">${esc(row.detail)}</td></tr>`,
    )
    .join("");
  return `<section class="card ${worst(r.rows)}">
    <h2>${head}<span class="meta">block ${esc(r.block)} · ${esc(r.at)}</span></h2>
    <table>${rows || '<tr class="wait"><td class="s">..</td><td class="l">nothing read</td><td class="d"></td></tr>'}</table>
  </section>`;
}

export function render(reports: Report[]): string {
  const fails = reports.reduce((n, r) => n + r.fails, 0);
  const warns = reports.reduce((n, r) => n + r.rows.filter((x) => x.state === "warn").length, 0);
  // The banner is the only thing readable across a room, so it states the one
  // fact that decides whether anybody has to move.
  const banner = fails
    ? `<div class="banner fail">${fails} FAIL across ${reports.length} vault(s)</div>`
    : warns
      ? `<div class="banner warn">no FAIL · ${warns} warning(s)</div>`
      : `<div class="banner ok">all green · ${reports.length} vault(s)</div>`;
  return `<!doctype html><meta charset="utf-8"><title>Payd — health</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0d0d0c;--fg:#f2ede3;--dim:#8b8b80;--ok:#b8e986;--warn:#e8c15a;--fail:#ff6b5e;--wait:#6f6f6a;--line:#24241f}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;background:var(--bg);color:var(--fg);
  font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font:600 1.1rem/1 ui-sans-serif,system-ui;letter-spacing:.18em;text-transform:uppercase;margin:0 0 1rem}
.banner{padding:.7rem 1rem;border-radius:.4rem;font-weight:600;margin-bottom:1.5rem}
.banner.ok{background:#1b2a12;color:var(--ok)} .banner.warn{background:#2e2510;color:var(--warn)}
.banner.fail{background:#3a1412;color:var(--fail)}
.card{border:1px solid var(--line);border-left-width:3px;border-radius:.4rem;margin-bottom:1rem;overflow:hidden}
.card.ok{border-left-color:var(--ok)} .card.warn{border-left-color:var(--warn)}
.card.fail{border-left-color:var(--fail)} .card.wait{border-left-color:var(--wait)}
h2{font-size:.82rem;font-weight:600;margin:0;padding:.6rem .9rem;background:#141412;
  display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.meta{color:var(--dim);font-weight:400}
table{width:100%;border-collapse:collapse}
td{padding:.3rem .9rem;border-top:1px solid var(--line);vertical-align:top}
.s{width:4rem;font-weight:600} .l{width:13rem;color:var(--dim)} .d{word-break:break-all}
tr.ok .s{color:var(--ok)} tr.warn .s{color:var(--warn)} tr.fail .s{color:var(--fail)} tr.wait .s{color:var(--wait)}
footer{color:var(--dim);margin-top:1.5rem;font-size:.78rem}
</style>
<h1>Payd · health</h1>${banner}${reports.map(card).join("")}
<footer>reloads every ${REFRESH_MS / 1000}s · thresholds live in offchain/src/check.ts · read-only, no key</footer>
<script>setTimeout(()=>location.reload(),${REFRESH_MS})</script>`;
}

/**
 * How long the page waits for the chain before it says so instead. Measured
 * 2026-09-12: the whole report is seconds on the archive endpoint and does not
 * come back AT ALL on the public one — `RPC_URL`'s node rate-limits a burst of
 * reads and, per CLAUDE.md, stays poisoned for minutes afterwards. So point
 * this at the archive endpoint:
 *
 *   RPC_URL=$RPC_URL_FALLBACK REGISTRY=0x… pnpm --filter offchain dashboard
 */
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 45_000);

/** One report at a time. Two browsers hitting refresh together would otherwise
 *  double the RPC load for the same numbers, and the endpoint rate-limits. */
let inflight: Promise<Report[]> | null = null;
function collect(): Promise<Report[]> {
  if (!inflight) {
    const run: Promise<Report[]> = process.env.REGISTRY ? reportAll() : report().then((r) => [r]);
    inflight = run;
    // Identity-checked: a run abandoned at the deadline clears the slot itself,
    // and must not clear the slot of its replacement when it settles minutes
    // later. The `catch` is for the slot only — the rejection itself is handled
    // by whoever awaited `collect()`.
    run.finally(() => {
      if (inflight === run) inflight = null;
    }).catch(() => {});
  }
  return inflight;
}

/**
 * **A dashboard that can hang forever is worse than no dashboard**: it is the
 * one failure mode indistinguishable from "nothing has changed, all is well".
 * One stalled read must therefore neither hold the page nor stay in the slot,
 * or the first rate-limited burst kills the screen until it is restarted.
 */
async function collectOrSayWhy(): Promise<Report[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), DEADLINE_MS);
  });
  const got = await Promise.race([collect(), deadline]);
  clearTimeout(timer);
  if (got) return got;
  inflight = null;
  throw new Error(
    `no answer from the chain in ${DEADLINE_MS / 1000}s — RPC_URL is rate-limiting or down. ` +
      `The archive endpoint answers in seconds: RPC_URL=$RPC_URL_FALLBACK`,
  );
}

export const server = createServer(async (req, res) => {
  try {
    const reports = await collectOrSayWhy();
    if (req.url?.startsWith("/api")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reports, bigints, 2));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(render(reports));
  } catch (e) {
    // A dead RPC must not look like a healthy platform, so it is served as a
    // page that says so rather than as an empty 500 the browser renders blank.
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    res.end(render([{ at: new Date().toISOString(), block: "?", chainId: 0, rows: [
      { state: "fail", label: "rpc", detail: (e as Error).message },
    ], fails: 1 }]));
  }
});

// Guarded so `dashboard.test.ts` can import the renderer without opening a port.
if (process.argv[1]?.endsWith("dashboard.ts")) {
  server.listen(PORT, HOST, () => console.log(`dashboard on http://${HOST}:${PORT}`));
}
