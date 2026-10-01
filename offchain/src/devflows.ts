/**
 * Every flow that reaches an address the maintainer controls, with its value in
 * the reporting currency at the date it happened. One CSV, one line per
 * transfer, for an annual declaration.
 *
 * TWO flows exist (audit §4.1, after the deletion of 2026-09-10):
 *
 *   1. Treasury.DevPaid(to, amount)      ETH   -> DEV_WALLET
 *   2. FeeVault.CreatorPaid(to, amount)  QUOTE -> the platform vault's CREATOR
 *                                                (the Safe, for $PAYD)
 *
 * Both name their recipient in the log, so nothing here is inferred. There used
 * to be a third, `Treasury.LpWithdrawn` to an `LP_SAFE`, whose log did NOT name
 * its destination; the function was deleted rather than fixed, which is why this
 * script no longer has an "INFERRED" column value to emit.
 *
 *   RPC_URL=... TREASURY=0x... PLATFORM_VAULT=0x... npx tsx devflows.ts 2026 > 2026.csv
 *
 * CURRENCY selects the reporting currency (default USD). It is a parameter and
 * not a constant on purpose: a tool hard-coded to one currency says where its
 * author files, which is not a fact this repository needs to publish.
 *   CURRENCY=<ISO 4217 code> ... npx tsx devflows.ts 2026
 *
 * Amounts are exact (wei, from the log). Prices are a daily close, which is what
 * a tax authority accepts and what an accountant expects -- not a per-second
 * mark. Every rate is printed in the CSV so the whole file recomputes by hand.
 */
import { createPublicClient, http, parseAbi, formatUnits, getAddress, type Address, type Hex } from "viem";

const RPC = process.env.RPC_URL;
const TREASURY = process.env.TREASURY as Address | undefined;
const PLATFORM_VAULT = process.env.PLATFORM_VAULT as Address | undefined;
const YEAR = Number(process.argv[2] ?? new Date().getUTCFullYear());
const CURRENCY = (process.env.CURRENCY ?? "USD").toUpperCase();
if (!RPC || !TREASURY) throw new Error("RPC_URL and TREASURY are required");

const treasuryAbi = parseAbi([
  "event DevPaid(address indexed to, uint256 amount)",
  "function DEV_WALLET() view returns (address)",
]);
const vaultAbi = parseAbi([
  "event CreatorPaid(address indexed to, uint256 amount)",
  "function CREATOR() view returns (address)",
  "function QUOTE() view returns (address)",
]);
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

const client = createPublicClient({ transport: http(RPC) });

// ---------------------------------------------------------------- prices
// ponytail: two free, keyless, citable sources -- the ECB daily reference rates
// for the FX leg -- a published, citable daily series, which is what an
// accountant asks for -- and CoinGecko for the asset in USD. Swap `fxPerUsd` for
// whichever series your filing requires.
// Both are cached per (asset, day) so a year of flows costs a handful of calls.
// Upgrade path if an auditor wants on-chain provenance: replace usdPrice() with
// a Chainlink `getRoundData` walk on the feed in Payd's wiring -- same number,
// no third party, ~40 more lines.
const cache = new Map<string, number>();

/** Units of CURRENCY per USD on `day`. 1 when reporting in USD. */
async function fxPerUsd(day: string): Promise<number> {
  if (CURRENCY === "USD") return 1;
  const k = `fx:${CURRENCY}:${day}`;
  if (cache.has(k)) return cache.get(k)!;
  // frankfurter serves the ECB daily reference rates verbatim, no key. They are
  // a published daily series, citable and reproducible after the fact.
  const r = await fetch(`https://api.frankfurter.dev/v1/${day}?base=USD&symbols=${CURRENCY}`);
  if (!r.ok) throw new Error(`rate unavailable for ${CURRENCY} on ${day}: ${r.status}`);
  const v = (await r.json()) as { rates: Record<string, number> };
  const rate = v.rates[CURRENCY];
  if (rate === undefined) throw new Error(`no ${CURRENCY} rate on ${day}`);
  cache.set(k, rate);
  return rate;
}

async function usdPrice(coingeckoId: string, day: string): Promise<number> {
  const k = `cg:${coingeckoId}:${day}`;
  if (cache.has(k)) return cache.get(k)!;
  const [y, m, d] = day.split("-");
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${coingeckoId}/history?date=${d}-${m}-${y}&localization=false`);
  if (!r.ok) throw new Error(`price unavailable for ${coingeckoId} on ${day}: ${r.status}`);
  const v = (await r.json()) as { market_data?: { current_price?: { usd?: number } } };
  const p = v.market_data?.current_price?.usd;
  if (p === undefined) throw new Error(`no USD price for ${coingeckoId} on ${day}`);
  cache.set(k, p);
  return p;
}

// QUOTE -> CoinGecko id. Extend as vaults on new quotes appear; an unknown quote
// must FAIL, never silently price at zero.
const COINGECKO: Record<string, string> = {
  ETH: "ethereum",
  WETH: "weth",
  USDG: "global-dollar",
};

// ---------------------------------------------------------------- rows
type Row = {
  date: string; time: string; block: bigint; tx: Hex;
  flow: string; to: Address; asset: string; amount: string;
  usdRate: string; fxRate: string; amountFiat: string; source: string;
};
const rows: Row[] = [];

async function stamp(blockNumber: bigint) {
  const b = await client.getBlock({ blockNumber });
  const iso = new Date(Number(b.timestamp) * 1000).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 19), year: Number(iso.slice(0, 4)) };
}

async function push(o: {
  blockNumber: bigint; tx: Hex; flow: string; to: Address;
  raw: bigint; symbol: string; decimals: number; source: string;
}) {
  const { day, time, year } = await stamp(o.blockNumber);
  if (year !== YEAR) return;
  const id = COINGECKO[o.symbol];
  if (!id) throw new Error(`no price source mapped for asset ${o.symbol} -- add it to COINGECKO`);
  const usd = await usdPrice(id, day);
  const fx = await fxPerUsd(day);
  const qty = Number(formatUnits(o.raw, o.decimals));
  rows.push({
    date: day, time, block: o.blockNumber, tx: o.tx, flow: o.flow, to: o.to,
    asset: o.symbol, amount: formatUnits(o.raw, o.decimals),
    usdRate: usd.toFixed(6), fxRate: fx.toFixed(6), amountFiat: (qty * usd * fx).toFixed(2),
    source: o.source,
  });
}

async function main() {
  const devWallet = await client.readContract({
    address: TREASURY!, abi: treasuryAbi, functionName: "DEV_WALLET",
  });

  // 1. Treasury -> DEV_WALLET, in ETH.
  for (const l of await client.getContractEvents({
    address: TREASURY!, abi: treasuryAbi, eventName: "DevPaid", fromBlock: 0n, toBlock: "latest",
  })) {
    await push({
      blockNumber: l.blockNumber!, tx: l.transactionHash!, flow: "Treasury.payDev",
      to: getAddress(l.args.to!), raw: l.args.amount!, symbol: "ETH", decimals: 18,
      source: "event DevPaid(to,amount)",
    });
  }


  // 2. The platform vault's creator residue, in that vault's QUOTE.
  if (PLATFORM_VAULT) {
    const [creator, quote] = await Promise.all([
      client.readContract({ address: PLATFORM_VAULT, abi: vaultAbi, functionName: "CREATOR" }),
      client.readContract({ address: PLATFORM_VAULT, abi: vaultAbi, functionName: "QUOTE" }),
    ]);
    let symbol = "ETH", decimals = 18;
    if (quote !== "0x0000000000000000000000000000000000000000") {
      [symbol, decimals] = await Promise.all([
        client.readContract({ address: quote, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: quote, abi: erc20Abi, functionName: "decimals" }),
      ]);
    }
    for (const l of await client.getContractEvents({
      address: PLATFORM_VAULT, abi: vaultAbi, eventName: "CreatorPaid", fromBlock: 0n, toBlock: "latest",
    })) {
      await push({
        blockNumber: l.blockNumber!, tx: l.transactionHash!, flow: "FeeVault.payCreator",
        to: getAddress(l.args.to!), raw: l.args.amount!, symbol, decimals: Number(decimals),
        source: `event CreatorPaid(to,amount); CREATOR=${getAddress(creator)}`,
      });
    }
  }

  rows.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

  const cols = ["date","time","block","tx","flow","to","asset","amount","usdRate","fxRate","amountFiat","source"] as const;
  console.log(cols.join(","));
  for (const r of rows) console.log(cols.map((c) => `"${String(r[c])}"`).join(","));

  const total = rows.reduce((s, r) => s + Number(r.amountFiat), 0);
  console.error(`\n${rows.length} flow(s) in ${YEAR} -> ${CURRENCY} ${total.toFixed(2)}`);
  console.error(`DEV_WALLET ${getAddress(devWallet)}`);
  console.error(`Every rate is in the CSV; the file recomputes by hand.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
