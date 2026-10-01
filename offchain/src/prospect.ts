/**
 * prospect.ts — who on Pons is paying their creator fee into a wallet, and what
 * that same fee would have delivered to their holders through a Payd vault.
 *
 *     pnpm --filter offchain prospect [--days 7] [--top 25] [--min 0.01] [--csv out.csv]
 *
 * The pitch this file exists to make is not an argument, it is their own
 * number: "over the last N days your launch earned X ETH of creator fee; a
 * Payd vault would have turned 70 % of it into NVDA/TSLA/SPY and pushed it to
 * the people holding your token, with no staking and nothing to sign." A list
 * of addresses ranked by that number is the whole marketing department.
 *
 * Where the number comes from, and it is the one thing to get right:
 * `V2FeeEscrow` emits `Credited(recipient, curve, amount)` on every trade, and
 * a single trade credits TWO recipients — Pons's own cut and the creator's.
 * Attributing the curve's total to the creator overstates every row, so we
 * only ever sum the credits whose `recipient` is that launch's
 * `creatorFeeRecipient`, read from the factory.
 *
 * **These amounts are a ceiling, not an audit.** `credit(address)` is
 * permissionless (`docs/recon.md` §1.2): anyone can credit anyone, so an
 * address can be made to look rich for the price of the gas. That is harmless
 * for ranking who to talk to and disqualifying for anything published — do not
 * put a figure from this file on the site or in a post without checking it
 * against the curve's own volume.
 *
 * Only ETH-quoted launches appear: `creditToken` is a different event, and the
 * 40.9 / 22.0 / 37.2 split of `CLAUDE.md` says what that leaves out.
 *
 * It holds no key, signs nothing, sends no transaction.
 */
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
  createPublicClient, http, parseAbi, formatEther, parseEther, getAddress,
  type Address, type PublicClient,
} from "viem";
import {
  RPC_URL, chain, BATCH_WAIT_MS, PONS_V2_ESCROW, PONS_V2_FACTORY,
  V3_FACTORY, WETH, USDG,
} from "./config.js";
import { registryAbi } from "./abis.js";
import { scanLogs } from "./logs.js";
import { spotPrice } from "./value.js";

/**
 * The registry, overridable like every other address here. The default is the
 * one the app ships (`front/src/config.ts`) and it answered `vaultCount() = 3`
 * on 2026-09-24 — it is only ever asked `isVault`, to mark the launches that
 * are already ours.
 */
const REGISTRY = (process.env.REGISTRY ??
  "0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03") as Address;

/** `keccak("Credited(address,address,uint256)")`, read off the live escrow. */
const CREDITED = "0x4e45da441832cf53bdaa69235704fc0575e68210f459ee1562911024b12967d5";

/** The WETH/USDG tier the whole codebase prices ETH through (recon §4). */
const WETH_USDG_FEE = 100;
const USDG_DECIMALS = 6;

/**
 * What a vault hands to holders, as a share of the fee it harvests. 70 % is
 * the default the creation form proposes; the floor the contract enforces is
 * 50 %. Used for the "would have delivered" column, so it is a parameter and
 * not a constant — a pitch that quotes a number the prospect cannot choose is
 * a pitch about our product rather than about their launch.
 */
const DEFAULT_REWARDS_BPS = 7_000;

/** Contract reads in flight at once. The RPC tolerates more; the heap did not. */
const BATCH = 25;

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function token0() view returns (address)",
]);
const v3FactoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const curveAbi = parseAbi(["function token() view returns (address)"]);
const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  // Pons stores the launch form's socials ON THE TOKEN — not in any factory
  // event, which is where this was looked for first. It is the only place the
  // creator's X handle exists on-chain, and it is what makes the list callable.
  "function socials() view returns (string)",
]);
const ponsAbi = parseAbi([
  // A STRUCT, and `creatorTaxBps` is a `uint16` — both as the factory declares
  // them (`contracts/interfaces/IExternal.sol`). Flat and widened it happens to
  // decode the same, because a static tuple is inlined and both widths occupy
  // one word; `front/src/abi.test.ts` refuses it anyway, and it is right to —
  // the day a field ahead of the end becomes dynamic, a flat declaration reads
  // an offset as a value and every field after it is wrong.
  "function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

/**
 * The creator's X handle, and nothing else from that field.
 *
 * `socials()` is a string the launcher wrote. It lands in a CSV that somebody
 * opens in a spreadsheet, so copying it through would carry whatever they put
 * in it — commas, quotes, newlines, a leading `=`. Pulling out the one capture
 * we need removes the whole question instead of escaping it: X handles are
 * 1-15 of [A-Za-z0-9_], so anything else is simply not a handle.
 */
export function xHandle(socials: string): string {
  const m = /(?:^|[\s,;])https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[\/?#]|$)/i
    .exec(" " + socials);
  return m?.[1] ? "@" + m[1] : "";
}

/** One launch, as the factory describes it. */
export interface Launch {
  token: Address;
  curve: Address;
  symbol: string;
  deployer: Address;
  /** Where the creator fee actually lands today. A wallet = a prospect. */
  recipient: Address;
  creatorTaxBps: number;
  graduated: boolean;
  /** `@name`, or empty when the launcher left the field blank or unusable. */
  handle: string;
  /** `Payd.isVault(recipient)` — true means they are already a customer. */
  customer: boolean;
}

export interface Row extends Launch {
  /** Creator fee credited over the window, in wei. */
  wei: bigint;
  eth: number;
  usd: number;
  /** What holders would have received, in dollars of stock. */
  toHolders: number;
}

/**
 * The attribution, kept pure so it can be pinned by a test: a launch takes
 * the credits addressed to ITS recipient on ITS curve, and nothing else.
 *
 * `credits` is keyed by curve then by recipient, both lower-cased, because
 * that is the only form a log topic comes in.
 */
export function rank(
  launches: Launch[],
  credits: Map<string, Map<string, bigint>>,
  opts: { ethUsd: number; rewardsBps?: number },
): Row[] {
  const rewardsBps = opts.rewardsBps ?? DEFAULT_REWARDS_BPS;
  const rows: Row[] = [];
  for (const l of launches) {
    const wei = credits.get(l.curve.toLowerCase())?.get(l.recipient.toLowerCase()) ?? 0n;
    if (wei === 0n) continue;
    const eth = Number(formatEther(wei));
    const usd = eth * opts.ethUsd;
    rows.push({ ...l, wei, eth, usd, toHolders: (usd * rewardsBps) / 10_000 });
  }
  rows.sort((a, b) => (b.wei > a.wei ? 1 : b.wei < a.wei ? -1 : 0));
  return rows;
}

/** `--days 7` / `--top 25` / `--csv out.csv`, and nothing clever. */
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/**
 * Blocks per day, measured rather than assumed. This chain's block time is not
 * a documented constant and a wrong one silently scans the wrong week.
 */
async function blocksPerDay(pub: PublicClient, head: bigint): Promise<number> {
  const back = head - 100_000n;
  const [a, b] = await Promise.all([pub.getBlock({ blockNumber: back }), pub.getBlock({ blockNumber: head })]);
  const seconds = Number(b.timestamp - a.timestamp);
  if (seconds <= 0) throw new Error("block timestamps do not move: wrong node?");
  return Math.round((100_000 / seconds) * 86_400);
}

async function ethUsdPrice(pub: PublicClient): Promise<number> {
  const pool = await pub.readContract({
    address: V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [WETH, USDG, WETH_USDG_FEE],
  });
  const [slot0, token0] = await Promise.all([
    pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
  ]);
  return spotPrice(slot0[0], token0.toLowerCase() === WETH.toLowerCase(), 18, USDG_DECIMALS);
}

async function main() {
  const days = Number(arg("days", "7"));
  const top = Number(arg("top", "25"));
  const csv = arg("csv");
  // Below this, a launch is not a conversation. It also keeps the resolution
  // pass off the long tail, which is where the heap went.
  const minWei = parseEther(arg("min", "0.01") as string);

  const pub = createPublicClient({
    chain, transport: http(RPC_URL, { batch: true }),
    batch: { multicall: { wait: BATCH_WAIT_MS } },
  }) as PublicClient;

  const head = await pub.getBlockNumber();
  const perDay = await blocksPerDay(pub, head);
  const from = Number(head) - perDay * days;
  console.log(`\nscanning ${days} day(s) — blocks ${from}..${head} (${perDay}/day)\n`);

  // One pass over the escrow. Credits are aggregated by curve and recipient;
  // which of the two recipients is the creator is the factory's answer, below.
  const credits = new Map<string, Map<string, bigint>>();
  const addr = (topic: string) => getAddress(("0x" + topic.slice(26)) as Address);
  const stats = await scanLogs(
    pub, { address: PONS_V2_ESCROW, fromBlock: from, toBlock: Number(head), topics: [CREDITED] },
    (logs) => {
      for (const log of logs) {
        const [, to, on] = log.topics;
        // Three topics or it is not a `Credited`. The scan is filtered on
        // topic0, so this only fires if the escrow ever emits a second event
        // under the same hash — in which case skipping is the right answer.
        if (!to || !on) continue;
        const recipient = addr(to).toLowerCase();
        const curve = addr(on).toLowerCase();
        const byRecipient = credits.get(curve) ?? new Map<string, bigint>();
        byRecipient.set(recipient, (byRecipient.get(recipient) ?? 0n) + BigInt(log.data));
        credits.set(curve, byRecipient);
      }
    },
  );
  console.log(`${stats.logs} credits over ${stats.requests} requests, ${credits.size} curves\n`);

  // A day of Pons is ~6,000 curves, and resolving every one of them is four
  // reads apiece — 150,000 promises in flight is how this script first died,
  // on the heap rather than on the RPC. So: prune, then resolve in batches.
  //
  // Pruning needs a creator-side figure BEFORE the factory has been asked who
  // the creator is, so it uses the one recipient that appears on nearly every
  // curve — Pons's own cut — and subtracts it. That is a heuristic and it
  // decides only WHICH curves are worth a call; every figure that reaches the
  // table is still the factory's `creatorFeeRecipient` and nothing else.
  const seen = new Map<string, number>();
  for (const byRecipient of credits.values())
    for (const r of byRecipient.keys()) seen.set(r, (seen.get(r) ?? 0) + 1);
  const ponsCut = [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const above = [...credits.entries()]
    .map(([curve, byRecipient]) => {
      let creatorSide = 0n;
      for (const [r, wei] of byRecipient) if (r !== ponsCut) creatorSide += wei;
      return { curve: curve as Address, creatorSide };
    })
    .filter((c) => c.creatorSide >= minWei)
    .sort((a, b) => (b.creatorSide > a.creatorSide ? 1 : b.creatorSide < a.creatorSide ? -1 : 0));
  // The slice is the cost control, and it is also what the totals below are
  // ABOUT: `above.length` is the market, `candidates.length` is the sample we
  // paid to resolve. Printing the sample's sum as the market's was this
  // script's first published figure and it was wrong by however much the tail
  // holds — say which one a number is, every time it appears.
  const candidates = above.slice(0, top * 4);
  const marketWei = above.reduce((t, c) => t + c.creatorSide, 0n);
  console.log(`${above.length} curves above ${formatEther(minWei)} ETH of non-Pons credit` +
    `, resolving the top ${candidates.length}\n`);

  const launches: Launch[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    await Promise.all(candidates.slice(i, i + BATCH).map(async ({ curve }) => {
      const token = await pub.readContract({ address: curve, abi: curveAbi, functionName: "token" })
        .catch(() => null);
      if (!token) return;
      const l = await pub.readContract({
        address: PONS_V2_FACTORY, abi: ponsAbi, functionName: "getLaunchedToken", args: [token],
      }).catch(() => null);
      if (!l || !l.exists) return;
      const [symbol, socials, customer] = await Promise.all([
        pub.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
        pub.readContract({ address: token, abi: tokenAbi, functionName: "socials" }).catch(() => ""),
        pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isVault", args: [l.creatorFeeRecipient] }).catch(() => false),
      ]);
      launches.push({
        token, curve, symbol,
        deployer: l.deployer, recipient: l.creatorFeeRecipient,
        creatorTaxBps: Number(l.creatorTaxBps),
        graduated: Number(l.phase) >= 2,
        handle: xHandle(socials),
        customer,
      });
    }));
  }

  const ethUsd = await ethUsdPrice(pub);
  const rows = rank(launches, credits, { ethUsd });
  const prospects = rows.filter((r) => !r.customer);

  console.log(`ETH/USD ${ethUsd.toFixed(2)} — ${rows.length} launches earned a fee, ` +
    `${rows.length - prospects.length} already on Payd\n`);
  console.log("  symbol         fee $   to holders   tax   grad  X                creator fee goes to");
  for (const r of prospects.slice(0, top))
    console.log(
      " ", r.symbol.slice(0, 12).padEnd(12),
      ("$" + r.usd.toFixed(2)).padStart(10),
      ("$" + r.toHolders.toFixed(2)).padStart(12),
      ((r.creatorTaxBps / 100).toFixed(1) + "%").padStart(6),
      (r.graduated ? "yes" : "no").padStart(5),
      " " + (r.handle || "-").padEnd(16),
      r.recipient,
    );

  const total = prospects.reduce((s, r) => s + r.usd, 0);
  const partial = above.length > candidates.length ? ` (the top ${candidates.length} of ${above.length} — the tail is not counted)` : "";
  console.log(`\n  ${prospects.length} prospects${partial}, $${total.toFixed(2)} of creator fees in ${days} day(s)` +
    ` -> $${((total * DEFAULT_REWARDS_BPS) / 10_000).toFixed(2)} that could have reached holders.`);
  // The market, sized from the heuristic rather than from the sample: every
  // curve above the threshold, minus the recipient that appears on nearly all
  // of them. It is the only line here that does not come from the factory, and
  // the only one that describes the whole window — both halves of that matter.
  const marketUsd = Number(formatEther(marketWei)) * ethUsd;
  console.log(`  Whole window, heuristic (non-Pons credit on all ${above.length} curves): ` +
    `$${marketUsd.toFixed(0)} of creator fees in ${days} day(s).`);
  console.log("  Amounts are a CEILING: credit() is permissionless. Cross-check before publishing.\n");

  if (csv) {
    // `symbol` is the launcher's too, so it gets the same treatment as the
    // handle: quoted, and never allowed to start a spreadsheet formula.
    const cell = (v: string | number | boolean) => {
      const t = String(v);
      return '"' + (/^[=+\-@]/.test(t) ? "'" + t : t).replace(/"/g, '""') + '"';
    };
    const head = "symbol,x,token,deployer,recipient,feeEth,feeUsd,toHoldersUsd,creatorTaxBps,graduated\n";
    writeFileSync(csv, head + prospects.map((r) =>
      // The handle is stored BARE: with its `@` it trips the formula guard
      // above and every row comes out as `'@name`, which reads like the handle
      // and is not one. The `@` is display, and `main`'s table adds it back.
      [r.symbol, r.handle.replace(/^@/, ""), r.token, r.deployer, r.recipient,
       r.eth.toFixed(8), r.usd.toFixed(2), r.toHolders.toFixed(2),
       r.creatorTaxBps, r.graduated].map(cell).join(",")).join("\n") + "\n");
    console.log(`  wrote ${csv}\n`);
  }
}

// Importable for `rank`, runnable as a CLI — same guard as value.ts, for the
// same reason: the test must not fire an RPC read on import.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) await main();
