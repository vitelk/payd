/**
 * value.ts — what the fees have bought, in dollars.
 *
 * Reads `Distributor.totalFunded[stock]`, the units of each stock bought since
 * genesis, and prices every one of them on the same USDG v3 pool the vault
 * bought through. USDG is a dollar, so the sum is the dollar value of
 * everything the cycle has converted so far.
 *
 * Two totals, deliberately, because they answer different questions:
 *   - ETH spent (`quoteFundedFor`), what the fees cost. It only ever grows.
 *   - value now, what the holders' stocks are worth today.
 * They should sit within a percent of each other; a wide gap means either the
 * market moved or a price is wrong, and both are worth seeing before the
 * number is published anywhere.
 *
 *     pnpm --filter offchain value
 */
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, formatUnits, type Address } from "viem";
import { RPC_URL, V3_FACTORY, USDG, WETH } from "./config.js";
import { distributorAbi, feeVaultAbi } from "./abis.js";

/** USDG is the dollar leg of every pool we price against. */
const USDG_DECIMALS = 6;

/** The WETH/USDG hop `FeeVault._floor` puts on the path of all ten (recon §4). */
const WETH_USDG_FEE = 100;

const poolAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
]);

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/**
 * A Uniswap v3 pool's spot price of `a` in units of the other token.
 *
 * `sqrtPriceX96 ** 2` is the price of **token0 in token1**, in raw units. Which
 * of the two is token0 is decided by address order, not by what we are asking
 * for, so the answer has to be inverted half the time — and the decimal
 * adjustment inverts with it. Getting that backwards does not throw, it returns
 * a number off by ~1e12, which is why this is a pure function with a test.
 */
export function spotPrice(
  sqrtPriceX96: bigint,
  aIsToken0: boolean,
  decA: number,
  decB: number,
): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const raw = sqrt * sqrt;
  return aIsToken0 ? raw * 10 ** (decA - decB) : 1 / (raw * 10 ** (decB - decA));
}

/** One stock: what was bought, what it cost, what it is worth now. */
export type Row = {
  symbol: string;
  qty: number;
  price: number;
  usd: number;
  eth: number;
};

/** Everything the report and the social card both need, read in one pass. */
export type Value = {
  block: bigint;
  epoch: bigint;
  ethUsd: number;
  eth: number;
  usd: number;
  rows: Row[];
};

/**
 * Read and price the whole basket. Exported: `card.ts` draws the same numbers,
 * and two readers of the same chain disagreeing about $48 would be worse than
 * having no card at all.
 */
export async function collect(): Promise<Value> {
  const vault = process.env.FEE_VAULT as Address | undefined;
  const dist = process.env.DISTRIBUTOR as Address | undefined;
  if (!vault || !dist) {
    console.error("FEE_VAULT / DISTRIBUTOR not in the environment — nothing to price.");
    process.exit(1);
  }

  const pub = createPublicClient({ transport: http(RPC_URL) });

  /** Price `token` against USDG on the pool at `fee`, in dollars. */
  const priceInUsdg = async (token: Address, fee: number, decimals: number) => {
    const pool = await pub.readContract({
      address: V3_FACTORY, abi: poolAbi, functionName: "getPool", args: [token, USDG, fee],
    });
    const [slot0, token0] = await Promise.all([
      pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
      pub.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    ]);
    const isToken0 = token0.toLowerCase() === token.toLowerCase();
    return spotPrice(slot0[0], isToken0, decimals, USDG_DECIMALS);
  };

  const allocations = await pub.readContract({
    address: vault, abi: feeVaultAbi, functionName: "getAllocations",
  });

  const rows: Row[] = [];
  for (const a of allocations) {
    if (a.stock === "0x0000000000000000000000000000000000000000") continue;
    const [symbol, decimals, units, quoteIn] = await Promise.all([
      pub.readContract({ address: a.stock, abi: erc20Abi, functionName: "symbol" }),
      pub.readContract({ address: a.stock, abi: erc20Abi, functionName: "decimals" }),
      pub.readContract({ address: dist, abi: distributorAbi, functionName: "totalFunded", args: [a.stock] }),
      pub.readContract({ address: dist, abi: distributorAbi, functionName: "quoteFundedFor", args: [a.stock] }),
    ]);
    const price = await priceInUsdg(a.stock, a.poolFee, decimals);
    const qty = Number(formatUnits(units, decimals));
    rows.push({ symbol, qty, price, usd: qty * price, eth: Number(formatUnits(quoteIn, 18)) });
  }

  const [ethUsd, block, epoch] = await Promise.all([
    priceInUsdg(WETH, WETH_USDG_FEE, 18),
    pub.getBlockNumber(),
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "currentEpoch" }),
  ]);

  rows.sort((x, y) => y.usd - x.usd);
  return {
    block,
    epoch,
    ethUsd,
    eth: rows.reduce((s, r) => s + r.eth, 0),
    usd: rows.reduce((s, r) => s + r.usd, 0),
    rows,
  };
}

async function main() {
  const { block, epoch, ethUsd, eth, usd, rows } = await collect();
  console.log(`\nPayd value — epoch ${epoch}, block ${block}  ETH/USD ${ethUsd.toFixed(2)}\n`);
  console.log("  stock         units       price       value      eth in     spent $");
  for (const r of rows)
    console.log(
      " ", r.symbol.padEnd(7), r.qty.toFixed(6).padStart(12),
      ("$" + r.price.toFixed(2)).padStart(10), ("$" + r.usd.toFixed(2)).padStart(11),
      r.eth.toFixed(6).padStart(11), ("$" + (r.eth * ethUsd).toFixed(2)).padStart(11),
    );
  console.log(
    `\n  ${eth.toFixed(6)} ETH spent ($${(eth * ethUsd).toFixed(2)})` +
    ` -> stocks worth $${usd.toFixed(2)} today` +
    `  [${(((usd - eth * ethUsd) / (eth * ethUsd)) * 100).toFixed(2)}%]\n`,
  );
}

// Importable for its arithmetic, runnable as a CLI. Without this guard the
// test would fire ten RPC reads on import.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) await main();
