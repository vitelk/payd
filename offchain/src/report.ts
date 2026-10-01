/**
 * report.ts — the week, read from the chain, drafted as a post for a human.
 *
 *     pnpm --filter offchain report
 *
 * Same numbers as `value` and `card`, from the same `collect()`: a post, a card
 * and a report disagreeing about $48 would be worse than having none. It keeps
 * one snapshot per run in `data/reports/` (gitignored, like the cards) and
 * diffs against the previous one, because the chain answers "how much so far"
 * and a public node cannot answer "how much last Wednesday".
 *
 * It DRAFTS and never posts. A human reads the table, reads the draft, and
 * decides. Every figure in the draft is printed in the table above it, so the
 * check before posting is reading two screens, not trusting this file.
 *
 * The draft's words are held to `.githooks/pre-commit`'s vocabulary — no
 * dividend, yield, earn, promise or invest, and no "we" about what a contract
 * does (`OPSEC.md` §7) — and to English, like every public post.
 */
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { collect, type Value } from "./value.js";

export interface Snapshot {
  date: string;
  block: string;
  epoch: string;
  ethUsd: number;
  /** ETH spent on stock since launch. Only ever grows. */
  eth: number;
  /** What that stock is worth today. */
  usd: number;
  rows: { symbol: string; usd: number }[];
}

const POST_MAX = 280;
const TOP = 3;

/** The ticker's own format, so the site and the post read alike. */
export const money = (v: number) =>
  v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
const eth = (v: number) => v.toFixed(v >= 1 ? 2 : 4);

export function snapshotOf(v: Value, date: string): Snapshot {
  return {
    date,
    block: v.block.toString(),
    epoch: v.epoch.toString(),
    ethUsd: v.ethUsd,
    eth: v.eth,
    usd: v.usd,
    rows: v.rows.map((r) => ({ symbol: r.symbol, usd: r.usd })),
  };
}

/**
 * The post. With a previous snapshot it leads with the WEEK: the ETH that
 * became stock since then, priced today. Not the change in value — that mixes
 * purchases with the market, and a red week on NVDA is not the protocol doing
 * less.
 */
export function draft(now: Snapshot, prev: Snapshot | null): string {
  const top = now.rows.slice(0, TOP).map((r) => `$${r.symbol} ${money(r.usd)}`).join(", ");
  const total = `${money(now.usd)} of stock held for $PAYD holders since launch, across ${now.rows.length} stocks`;
  const lead = prev && now.eth > prev.eth
    ? `This week ${eth(now.eth - prev.eth)} ETH of $PAYD trading fees became stock for holders `
      + `(${money((now.eth - prev.eth) * now.ethUsd)} at today's price).\n\n${total}`
    : `${total}, bought with ${eth(now.eth)} ETH of trading fees`;
  const tail = "\n\nEvery figure read from the chain: paydprotocol.eth";
  const withTop = `${lead}: ${top}.${tail}`;
  return withTop.length <= POST_MAX ? withTop : `${lead}.${tail}`;
}

/** The latest snapshot strictly before `date`, or null on the first run. */
function previous(dir: string, date: string): Snapshot | null {
  const before = readdirSync(dir).filter((f) => f.endsWith(".json") && f.slice(0, 10) < date).sort();
  const last = before.at(-1);
  return last ? (JSON.parse(readFileSync(`${dir}/${last}`, "utf8")) as Snapshot) : null;
}

async function main() {
  const dir = new URL("../data/reports", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);

  const now = snapshotOf(await collect(), date);
  const prev = previous(dir, date);
  writeFileSync(`${dir}/${date}.json`, JSON.stringify(now, null, 2) + "\n");

  console.log(`\nPayd report — ${date}, epoch ${now.epoch}, block ${now.block}, ETH/USD ${now.ethUsd.toFixed(2)}`);
  console.log(`  previous: ${prev ? `${prev.date} (epoch ${prev.epoch})` : "none — first run, no weekly figure"}\n`);
  for (const r of now.rows) console.log(`  ${r.symbol.padEnd(7)} ${money(r.usd).padStart(10)}`);
  console.log(`\n  ETH spent since launch  ${eth(now.eth)}${prev ? `   (+${eth(now.eth - prev.eth)} since ${prev.date})` : ""}`);
  console.log(`  value of the stock now  ${money(now.usd)}\n`);

  const post = draft(now, prev);
  console.log(`— draft, ${post.length}/${POST_MAX} characters, NOT posted —\n\n${post}\n`);
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) await main();
