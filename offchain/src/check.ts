/**
 * check.ts — read-only health report. Sends nothing, signs nothing.
 *
 *   pnpm --filter offchain check          one report
 *   pnpm --filter offchain check --watch  the same, every 60 s
 *
 * DISTRIBUTOR and FEE_VAULT from the environment (`.env`). Before the
 * deployment they are simply absent and the report stops after the balances,
 * which is the whole point of running it then.
 *
 * What it is FOR: the LAUNCH.md failure mode is a silent one. Nothing reverts
 * when the keeper dies — epochs just carry over and the publication frontier
 * falls behind, and no single on-chain value says "broken". The lag between
 * `currentEpoch` and the last published root is the one number that does, so it
 * is the one this report leads with.
 */
import { createPublicClient, http, formatEther, parseAbi, type Address } from "viem";
import { RPC_URL, CHAIN_ID, PONS_V2_ESCROW } from "./config.js";
import { distributorAbi, feeVaultAbi, escrowAbi, registryAbi } from "./abis.js";
import { scanEvents } from "./logs.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Measured 2026-09-05 (docs/LAUNCH.md §3). Only used to turn a balance into
 *  hours, which is the form the number is actually read in. */
const DIST_PER_EPOCH = 205_000_000_000_000n; // 0.000205 ETH, three refunds
const KEEPER_PER_EPOCH = 76_000_000_000_000n; // 0.000076 ETH, runEpoch, cold

const chain = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 3, retryDelay: 500 }) });
const erc20 = parseAbi(["function symbol() view returns (string)"]);

const eth = (v: bigint) => `${Number(formatEther(v)).toFixed(6)} ETH`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

let bad = 0;

/** One reported signal. The terminal prints it and `--json` hands it over
 *  untouched, so every threshold in this file is argued ONCE and whatever draws
 *  a screen reads it from here. A dashboard carrying its own copy of the
 *  thresholds is a dashboard that stays green while this report goes red. */
export interface Row {
  state: "ok" | "warn" | "fail" | "wait";
  label: string;
  detail: string;
}
export interface Report {
  at: string;
  block: string;
  chainId: number;
  vault?: string;
  distributor?: string;
  rows: Row[];
  fails: number;
}

const JSON_OUT = process.argv.includes("--json");
let rows: Row[] = [];

function line(state: "ok" | "warn" | "fail" | "wait", label: string, detail = "") {
  if (state === "fail") bad++;
  rows.push({ state, label, detail });
  if (JSON_OUT) return;
  const mark = { ok: "OK  ", warn: "WARN", fail: "FAIL", wait: "..  " }[state];
  console.log(`  ${mark}  ${label.padEnd(24)}${detail}`);
}

/** Headings and the multi-value lines. Silent under `--json`, where the only
 *  thing allowed on stdout is the JSON — a stray heading makes it unparseable. */
function say(s = "") {
  if (!JSON_OUT) console.log(s);
}

/** How many windows of funding may sit undelivered before it is worth a look.
 *  The honest peak measured by `test/RootExposureInvariants.t.sol` on a fully
 *  honest cycle is 3 windows in flight, so 8 is clear of normal operation while
 *  still firing long before the pot reaches the scale §S29 describes. */
const AT_RISK_WINDOWS = 8;

/** How far back to look for the last `WindowFunded`. A window is one purchase,
 *  and `buyBasket` runs at most once per epoch (30 min), so a few thousand
 *  blocks covers many of them on a 250 ms chain. Zero means "none found" and
 *  the caller says so rather than inventing a ratio. */
const WINDOW_LOOKBACK = 500_000n;

async function lastWindowQuote(dist: Address): Promise<bigint> {
  const head = await pub.getBlockNumber();
  // Paged: 500,000 blocks is ten times what this chain's public node will serve
  // in one query, so the unpaged read failed every time and `.catch(() => [])`
  // reported "no window found" — a ratio of zero that reads like a healthy
  // vault and is in fact a check that never ran.
  const logs = await scanEvents(pub, {
    address: dist,
    abi: distributorAbi,
    eventName: "WindowFunded",
    fromBlock: head > WINDOW_LOOKBACK ? head - WINDOW_LOOKBACK : 0n,
    toBlock: head,
  }).catch(() => []);
  const last = logs.at(-1);
  if (!last) return 0n;
  return ((last.args as { quoteSpent?: readonly bigint[] }).quoteSpent ?? []).reduce((a, b) => a + b, 0n);
}

/** Epochs of runway a balance buys, given what one epoch costs it. */
const runway = (bal: bigint, per: bigint) => {
  const n = Number(bal / per);
  return `~${n} epochs, ~${(n / 2).toFixed(0)} h`;
};

/**
 * One vault's report. The pair comes from the argument when the caller knows it
 * (`--all`, the dashboard) and from the environment otherwise, which is what it
 * was before the registry existed and still the right default for one vault.
 */
export async function report(target?: { vault: Address; distributor: Address }): Promise<Report> {
  rows = [];
  const dist = target?.distributor ?? (process.env.DISTRIBUTOR as Address | undefined);
  const vault = target?.vault ?? (process.env.FEE_VAULT as Address | undefined);
  const keeper = process.env.KEEPER_ADDRESS as Address | undefined;

  // The CHAIN's clock, not this machine's: every epoch bound is derived from
  // `block.timestamp`, and a laptop a minute off would report the wrong epoch.
  const head = await pub.getBlock();
  say(`\nPayd check — ${new Date().toISOString()}  chain ${CHAIN_ID}  block ${head.number}`);
  // Every `return` below is an early one — nothing deployed yet, genesis not
  // reached — and each must still hand back the rows it did collect. `fin` is
  // what makes a partial report a report rather than a thrown away one.
  const fin = (): Report => ({
    at: new Date().toISOString(),
    block: String(head.number),
    chainId: CHAIN_ID,
    vault,
    distributor: dist,
    rows,
    fails: rows.filter((r) => r.state === "fail").length,
  });

  // --------------------------------------------------------------- balances
  say("\nBALANCES");
  if (keeper) {
    const b = await pub.getBalance({ address: keeper });
    // The keeper is the ONLY signal that a reserve has run dry: `_refund`
    // clamps to zero without reverting, so an empty Distributor shows up
    // nowhere except as the keeper quietly starting to pay for everyone.
    line(b === 0n ? "fail" : b < 500_000_000_000_000n ? "warn" : "ok",
      "keeper", `${short(keeper)}  ${eth(b)}  ${runway(b, KEEPER_PER_EPOCH)}`);
  } else line("warn", "keeper", "KEEPER_ADDRESS not set");

  if (!dist || !vault) {
    say("\nDISTRIBUTOR / FEE_VAULT not in the environment — nothing deployed yet,");
    say("or the .env has not been filled in after §1. Stopping here.\n");
    return fin();
  }

  const distBal = await pub.getBalance({ address: dist });
  line(distBal === 0n ? "fail" : distBal < 2_000_000_000_000_000n ? "warn" : "ok",
    "Distributor", `${short(dist)}  ${eth(distBal)}  ${runway(distBal, DIST_PER_EPOCH)}`);

  const [vaultBal, rewards, creatorPool, pending, payoutBps] = await Promise.all([
    pub.getBalance({ address: vault }),
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "rewardsPool" }),
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "creatorPool" }),
    pub.readContract({ address: PONS_V2_ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [vault] }),
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "payoutBps" }),
  ]);
  line("ok", "FeeVault", `${short(vault)}  ${eth(vaultBal)}`);
  say(`        rewards ${eth(rewards)} · dev ${eth(creatorPool)} · escrow pending ${eth(pending)} · payout ${payoutBps}bps`);

  // ---------------------------------------------------------------- wiring
  // Three of these four cost 48 h of timelock if they are wrong, and all four
  // are frozen at construction. Re-read every run: it costs one RPC round-trip
  // and it is the only place a wrong `KEEPER_ADDRESS` would ever show up.
  say("\nWIRING");
  const [vDist, dVault, dKeeper, token] = await Promise.all([
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "DISTRIBUTOR" }),
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "FEE_VAULT" }),
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "keeper" }),
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }),
  ]);
  line(same(vDist, dist) ? "ok" : "fail", "FeeVault.DISTRIBUTOR", vDist);
  line(same(dVault, vault) ? "ok" : "fail", "Distributor.FEE_VAULT", dVault);
  line(!keeper || same(dKeeper, keeper) ? "ok" : "fail", "Distributor.keeper", dKeeper);
  line(token === ZERO ? "wait" : "ok", "FeeVault.token (bind)", token === ZERO ? "not bound yet — §2" : token);

  // ----------------------------------------------------------------- cycle
  const [epoch, genesis, epochLen] = await Promise.all([
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "currentEpoch" }),
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "GENESIS" }),
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "EPOCH_LENGTH" }),
  ]);
  const now = head.timestamp;
  if (now < genesis) {
    say(`\nCYCLE — genesis at ${new Date(Number(genesis) * 1000).toISOString()}, in ${Number(genesis - now)} s\n`);
    return fin();
  }
  const endsIn = Number(genesis + (epoch + 1n) * epochLen - now);
  say(`\nCYCLE — epoch ${epoch}, ends in ${Math.floor(endsIn / 60)}m${String(endsIn % 60).padStart(2, "0")}s`);

  // Epochs closed but not yet bought. A backlog is NORMAL — a window waits for
  // the reserve to clear MIN_BUY — so what matters is a backlog next to a
  // reserve that could well afford a purchase.
  const [pendingWindows, minBuy, pivotHeld] = await Promise.all([
    pub.readContract({ address: dist, abi: distributorAbi, functionName: "pendingEpochs" }),
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY" }),
    // `usdgReserve` until the USDG -> PIVOT rename: the pivot is a PARAMETER
    // of the vault, not a constant. The name had stayed here, and this call
    // reverted -- `tsc` only saw it at CI, and neither did `abis.test.ts`: it
    // checks the names DECLARED in the ABI literals, not the ones passed in
    // `functionName`.
    pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "pivotReserve" }),
  ]);
  if (pendingWindows === 0n) {
    line("ok", "buyBasket", "every closed epoch is bought");
  } else {
    const canAfford = rewards > minBuy;
    line(canAfford ? "warn" : "wait", "buyBasket",
      canAfford
        ? `${pendingWindows} epoch(s) waiting and the pool is ${eth(rewards)}, over the ${eth(minBuy)} floor`
        : `${pendingWindows} epoch(s) waiting, pool ${eth(rewards)} still under the ${eth(minBuy)} floor`);
  }
  // Not an error: a leg the market could not fill keeps its pivot for the next
  // purchase. It only matters if it stops going down.
  if (pivotHeld > 0n) line("warn", "pivotReserve", `${pivotHeld} pivot held back by a skipped leg`);

  // Publication frontier — the silent-failure detector.
  const rootCount = await pub.readContract({ address: dist, abi: distributorAbi, functionName: "rootCount" });
  let frontier = -1n;
  if (rootCount > 0n) {
    // Roots are 1-INDEXED: `publishRoot` does `uint256 id = ++rootCount`, so
    // slot 0 isalways empty and the latest is roots[rootCount]. Reading
    // rootCount - 1 returns the zero Root and reports a frontier of 0 —
    // i.e. "3 epochs behind" on a keeper that is perfectly up to date.
    const r = await pub.readContract({ address: dist, abi: distributorAbi, functionName: "roots", args: [rootCount] });
    frontier = BigInt(r[4]);
    const lag = epoch - 1n - frontier;
    line(lag <= 1n ? "ok" : lag <= 4n ? "warn" : "fail", "publishRoot",
      `root #${rootCount} covers up to epoch ${frontier} — ${lag <= 0n ? "current" : `${lag} epoch(s) behind`}`);
  } else line(epoch === 0n ? "wait" : "warn", "publishRoot", "no root published yet");

  const atRisk = await pub.readContract({ address: dist, abi: distributorAbi, functionName: "quoteAtRisk" });
  // **A ratio, not an absolute.** This used to warn above a flat 0.1 ETH on the
  // grounds that "deliveries run continuously, so this should stay on the order
  // of one epoch's purchase". Both halves were wrong: the push floor means the
  // sub-floor tail is never delivered to at all, so the honest standing balance
  // is several windows (a fork campaign peaks at three), and a flat threshold
  // says nothing on a vault whose one window is bigger than it. What matters is
  // how many windows' funding is sitting undelivered — a rising count is the
  // deliveries having stopped, which is the failure this figure exists to show.
  // §S29 and FLOWS.md §7.c carry the bound this compares against.
  const window = await lastWindowQuote(dist);
  const ratio = window > 0n ? Number((atRisk * 100n) / window) / 100 : 0;
  line(
    window === 0n ? (atRisk > 0n ? "warn" : "ok") : ratio > AT_RISK_WINDOWS ? "warn" : "ok",
    "distribute",
    window === 0n
      ? `${eth(atRisk)} funded but not delivered (no WindowFunded in range: ratio unknown)`
      : `${eth(atRisk)} funded but not delivered — ${ratio.toFixed(2)} window(s), warn above ${AT_RISK_WINDOWS}`,
  );
  // **T2-REFUND-01, and it is a monitor because it cannot be a guard.**
  // `Distributor._one` prices a delivery's `backing` at
  // `quoteFundedFor / totalFunded` — a BLENDED rate across every purchase that
  // funded the stock. `FeeVault._buyLegs` carries a skipped leg's quote forward
  // in `reserveQuote` (T-RISK-01, and correctly), so each skip blends the rate
  // further from what the stock in hand actually cost. `REFUND_VALUE_BPS` is a
  // share of that blend, so **the refund ceiling loosens exactly when legs are
  // failing** — which is when the basket is already in trouble.
  //
  // Fixing it on-chain means a rate per window, i.e. an SSTORE per window on the
  // funding path, to bound a figure `MAX_REFUND` already caps at 0.02 ETH per
  // call and that nobody extracts: the reserve pays itself. So it is watched
  // rather than enforced. `reserveQuote` over the quote of one window is the
  // ratio to read; measured at 11x after ten skipped windows
  // (`test_TheRefundCeilingLoosensWithTheBlendAndStopsAtMaxRefund`).
  const carried = (await pub.readContract({
    address: vault, abi: feeVaultAbi, functionName: "reserveQuote",
  })) as bigint;
  if (window > 0n) {
    const blend = Number((carried * 100n) / window) / 100;
    line(blend > 5 ? "warn" : "ok", "refundBlend",
      `carried quote is ${blend.toFixed(2)} window(s) — the refund ceiling is that much looser`);
  } else if (carried > 0n) {
    line("warn", "refundBlend", `${eth(carried)} of carried quote, no window in range to compare it to`);
  }
  line(creatorPool > 50_000_000_000_000_000n ? "warn" : "ok", "payCreator", `${eth(creatorPool)} waiting`);

  say(bad ? `\n${bad} FAIL — stop and read the line above.\n` : "\nall green\n");
  return fin();
}

/**
 * Every vault the registry has made. `--all` is what a LIVE platform needs:
 * this report was written when there was one vault and reads one pair out of
 * the environment, which on-chain is one of N — and the one nobody is watching
 * is the one that breaks.
 *
 * Sequential on purpose. The endpoint rate-limits (`-j 1` in CLAUDE.md for the
 * same reason), and a report that 429s reads as a platform on fire.
 */
export async function reportAll(): Promise<Report[]> {
  const registry = process.env.REGISTRY as Address | undefined;
  if (!registry) throw new Error("REGISTRY is not set — --all reads the vault list from it");
  const vaults = (await pub.readContract({
    address: registry, abi: registryAbi, functionName: "vaults",
  })) as readonly Address[];
  const out: Report[] = [];
  for (const vault of vaults) {
    const distributor = (await pub.readContract({
      address: vault, abi: feeVaultAbi, functionName: "DISTRIBUTOR",
    })) as Address;
    out.push(await report({ vault, distributor }));
  }
  return out;
}

const watch = process.argv.includes("--watch");
const all = process.argv.includes("--all");

/** bigint is not JSON. Serialising it as a decimal string rather than letting
 *  `JSON.stringify` throw is the whole reason this replacer exists. */
export const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function once() {
  const reports = all ? await reportAll() : [await report()];
  if (JSON_OUT) console.log(JSON.stringify(reports, bigints, 2));
}

async function loop() {
  for (;;) {
    await once().catch((e) => console.error("check failed:", (e as Error).message));
    if (!watch) return;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

// Guarded so `dashboard.ts` can import the report without running it.
if (process.argv[1]?.endsWith("check.ts")) loop().then(() => process.exit(bad ? 1 : 0));
