/**
 * Re-reads the registry's allowlists and diffs them against what `config.ts`
 * ships. `pnpm --filter front listings` — run it before a release.
 *
 * **This is the expensive walk, kept in one place where it is affordable.** The
 * app used to do it in the browser on every cold visit: `StockAllowed` and its
 * four siblings scanned forward from `PAYD_BLOCK`, which is now 13 M blocks
 * behind the head — 1 452 windows and ~61 s to find 92 events, growing ~96
 * windows a day, and on the public RPC it never finished at all. Here it runs
 * once, against an endpoint with a rate budget, and its OUTPUT is what ships.
 *
 * Prints a diff and nothing else when nothing changed. Exits 1 when the shipped
 * lists disagree with the chain, so it can gate a release.
 *
 * Needs an endpoint: `RPC_URL` in the repository's `.env`, or `--rpc <url>`
 * (the dev server's own proxy, `http://127.0.0.1:5174/rpc`, works).
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";

/** `config.ts` reads `location.search` at import — that is what lets the page
 *  switch network through the URL. There is none here, and a static import
 *  would be hoisted ABOVE this line, so the config is loaded dynamically for
 *  the same reason `quotes.test.ts` loads it dynamically. */
globalThis.location ??= new URL("http://localhost/");
const { KNOWN_QUOTES, KNOWN_STOCKS, LISTINGS_READ_AT, PAYD_BLOCK, REGISTRY } =
  await import("./src/config.ts");

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const fromEnv = () => {
  try {
    const m = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^RPC_URL=(.+)$/m);
    return m?.[1]?.trim() || null;
  } catch { return null; }
};
const RPC = flag("--rpc") ?? fromEnv();
if (!RPC) {
  console.error("no endpoint: set RPC_URL in .env, or pass --rpc <url>");
  process.exit(2);
}

/** 9 000, the widest range either node serves (`chain.ts`, `LOG_SPAN`). */
const SPAN = 9_000n;
/** Eight at a time. The browser walk used six through a client with no retry of
 *  its own; here a refused window is retried below and nobody is waiting. */
const LANES = 8;

const EVENTS = [
  parseAbiItem("event StockAllowed(address indexed stock, uint24 poolFee, address feed)"),
  parseAbiItem("event StockRemoved(address indexed stock)"),
  parseAbiItem("event QuoteAllowed(address indexed quote, uint24 poolFee, uint24 wethFee, uint256 minBuy)"),
  parseAbiItem("event QuoteRemoved(address indexed quote)"),
];
const padAbi = parseAbi([
  "function listing(address) view returns (uint24 poolFee, address feed, bool allowed)",
  "function quoteListing(address) view returns (uint24 poolFee, uint24 wethFee, uint256 minBuy, bool allowed)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)"]);

const pub = createPublicClient({ transport: http(RPC, { batch: false, retryCount: 3 }) });

const head = await pub.getBlockNumber();
const windows = [];
for (let f = PAYD_BLOCK; f <= head; f += SPAN) {
  windows.push([f, f + SPAN - 1n > head ? head : f + SPAN - 1n]);
}
process.stderr.write(`head ${head} · ${windows.length} windows from ${PAYD_BLOCK}\n`);

const out = new Array(windows.length);
let next = 0, done = 0;
await Promise.all(Array.from({ length: LANES }, async () => {
  for (;;) {
    const i = next++;
    if (i >= windows.length) return;
    for (let attempt = 0; ; attempt++) {
      try {
        out[i] = await pub.getLogs({
          address: REGISTRY, events: EVENTS, fromBlock: windows[i][0], toBlock: windows[i][1],
        });
        break;
      } catch (e) {
        // A window the node will not serve AT ALL would silently shrink the
        // list, which is the one outcome this script must never produce
        // quietly. Four tries, then say so and fail the run.
        if (attempt >= 4) {
          console.error(`window ${windows[i][0]}–${windows[i][1]} failed: ${String(e).slice(0, 120)}`);
          out[i] = null;
          break;
        }
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    if (++done % 200 === 0) process.stderr.write(`  ${done}/${windows.length}\n`);
  }
}));

const failed = out.filter((w) => w === null).length;
if (failed > 0) {
  console.error(`\n${failed} window(s) went unread — the result would be incomplete. Not diffing.`);
  process.exit(2);
}

const logs = out.flat().sort((a, b) =>
  Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

/** The last event for an address IS its state — both halves are emitted on
 *  every change, so this fold is exact rather than approximate. */
const stocks = new Map(), quotes = new Map();
for (const l of logs) {
  const a = l.args;
  if (l.eventName === "StockAllowed") stocks.set(a.stock.toLowerCase(), a.stock);
  else if (l.eventName === "StockRemoved") stocks.delete(a.stock.toLowerCase());
  else if (l.eventName === "QuoteAllowed") quotes.set(a.quote.toLowerCase(), a.quote);
  else if (l.eventName === "QuoteRemoved") quotes.delete(a.quote.toLowerCase());
}

/** The events say who; the mapping says whether — the same rule the screen
 *  follows, applied to the list before it is shipped. */
async function confirm(found, fn) {
  const rows = await Promise.all([...found.values()].map(async (a) => {
    const row = await pub.readContract({ address: REGISTRY, abi: padAbi, functionName: fn, args: [a] });
    const allowed = fn === "listing" ? row[2] : row[3];
    const sym = await pub.readContract({ address: a, abi: erc20, functionName: "symbol" }).catch(() => "?");
    return { a, sym, allowed };
  }));
  return rows.filter((r) => r.allowed).sort((x, y) => x.sym.localeCompare(y.sym));
}

const [liveStocks, liveQuotes] = await Promise.all([
  confirm(stocks, "listing"),
  confirm(quotes, "quoteListing"),
]);

let drift = 0;
function diff(label, live, shipped) {
  const have = new Set(shipped.map((a) => a.toLowerCase()));
  const want = new Set(live.map((r) => r.a.toLowerCase()));
  const added = live.filter((r) => !have.has(r.a.toLowerCase()));
  const gone = shipped.filter((a) => !want.has(a.toLowerCase()));
  console.log(`\n${label}: ${live.length} on chain, ${shipped.length} shipped`);
  for (const r of added) console.log(`  + "${r.a}", // ${r.sym}`);
  for (const a of gone) console.log(`  -  ${a}  (no longer listed — drop it)`);
  if (added.length === 0 && gone.length === 0) console.log("  unchanged");
  drift += added.length + gone.length;
}

diff("stocks", liveStocks, KNOWN_STOCKS);
diff("quotes", liveQuotes, KNOWN_QUOTES);

console.log(`\nLISTINGS_READ_AT: ${LISTINGS_READ_AT} shipped, ${head} now`);
if (drift > 0) {
  console.log("\nUpdate KNOWN_STOCKS / KNOWN_QUOTES and LISTINGS_READ_AT in front/src/config.ts.");
  process.exit(1);
}
console.log("config.ts agrees with the chain.");
