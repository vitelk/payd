/**
 * sweepcost.ts — what a floor override would actually push, and what it costs.
 *
 * The table in `PUSH_FLOOR_OVERRIDES` (epochs 46, 58, 60, 104) was costed by
 * hand each time. This is that costing, reading the live tree: same windows,
 * same accrual rule, same `pushSetWhole`, same locker filter as `keeper.ts`.
 *
 *   EPOCH_DIR=... pnpm --filter offchain exec tsx src/sweepcost.ts [upToEpoch]
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { RPC_URL, minShareFor } from "./config.js";
import { distributorAbi, feeVaultAbi, ponsFactoryAbi, ponsLockerAbi } from "./abis.js";
import { PONS_V2_FACTORY } from "./config.js";
import { windows } from "./snapshot.js";
import {
  windowShares, deliveredLog, foldDelivered, pushSetWhole, pushFloorParts,
  PUSH_TARGET_WEI, SETTLE_GAS, plainAccrual,
  reclaimUndeliverable, LOCKER_RECLAIM_FROM_EPOCH, LOCKER_RECLAIM_ACCOUNT,
} from "./epoch.js";
import { modeOfVault, MODE_TONTINE } from "./buildroot.js";
import { tontineAccrual } from "./tontine.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

// The contract's own per-call overhead: intrinsic gas + the refund transfer.
const REFUND_OVERHEAD = 40_000n;
const REFUND_VALUE_BPS = 1_000n; // the refund cannot exceed 10 % of what moved
const PUSH_MARGIN_BPS = 300n;
const MAX_REFUND = 20_000_000_000_000_000n; // 0.02 ether
// Same convention as PUSH_TARGET_WEI's comment: ~$10 of ether.
const USD_PER_ETH = 10 * 1e18 / Number(PUSH_TARGET_WEI);
const usd = (wei: bigint) => (Number(formatEther(wei)) * USD_PER_ETH);

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from the environment`);
  return v;
}

async function main() {
  const distributor = env("DISTRIBUTOR") as Address;
  const vault = env("FEE_VAULT") as Address;

  const [token, quote, minBuyQuote, activeRoot] = await Promise.all([
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }) as Promise<Address>,
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "QUOTE" }) as Promise<Address>,
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }) as Promise<bigint>,
    client.readContract({ address: distributor, abi: distributorAbi, functionName: "activeRoot" }) as Promise<bigint>,
  ]);
  const r = await client.readContract({ address: distributor, abi: distributorAbi, functionName: "roots", args: [activeRoot] }) as readonly unknown[];
  const upTo = process.argv[2] ? Number(process.argv[2]) : Number(r[4] as bigint);

  const head = Number(await client.getBlockNumber());
  // The live basefee, unless `BASEFEE_GWEI` overrides it. Row 46 of
  // `PUSH_FLOOR_OVERRIDES` is the reason that override exists: 119 deliveries in
  // sixty seconds tripled the basefee, and a row priced at the calm one cost
  // 8.5x its projection. Price a sweep at the gas it will CREATE.
  const live = (await client.getBlock({ blockNumber: BigInt(head) })).baseFeePerGas ?? 1n;
  const forced = process.env.BASEFEE_GWEI;
  const basefee = forced ? BigInt(Math.round(Number(forced) * 1e9)) : live;
  const reserve = await client.getBalance({ address: distributor });

  const mode = await modeOfVault(vault);
  const accrual = mode === MODE_TONTINE ? tontineAccrual : plainAccrual;
  const minShare = minShareFor(quote as string, minBuyQuote);

  // --- the tree, exactly as buildCumulative assembles it ------------------
  const deliveries = await deliveredLog(distributor, head);
  const paidAt = foldDelivered(deliveries);
  const totals = new Map<string, any>();
  let atGate: Map<string, bigint> | null = null;
  const quoteSpentOf = new Map<string, bigint>();
  for (const w of await windows(distributor)) {
    if (w.toEpoch > upTo) break;
    const sh = await windowShares(distributor, token, w, minShare);
    if (!sh) continue;
    const legQuote = new Map(w.stocks.map((st, i) => [st.toLowerCase(), w.quoteSpent[i]!]));
    for (let i = 0; i < sh.stocks.length; i++) {
      if (BigInt(sh.amounts[i]!) === 0n) continue;
      const leg = sh.stocks[i]!.toLowerCase();
      quoteSpentOf.set(leg, (quoteSpentOf.get(leg) ?? 0n) + (legQuote.get(leg) ?? 0n));
    }
    // Same boundary snapshot `buildCumulative` takes: the reclaim's split is
    // decided at the gate and never recomputed against a moving tree.
    if (atGate === null && sh.toEpoch > LOCKER_RECLAIM_FROM_EPOCH) {
      atGate = new Map([...totals].map(([k, e]) => [k, (e as any).cumulative as bigint]));
    }
    accrual(totals, sh, deliveries);
  }
  // The same post-pass `buildCumulative` runs, under the same gate. Without it
  // this tool would keep costing the tree as it was BEFORE the locker's share
  // went back to the holders — every outstanding share understated, so every
  // scenario understating both what is delivered and what it costs to deliver.
  const reclaimed = upTo >= LOCKER_RECLAIM_FROM_EPOCH
    ? reclaimUndeliverable(
        totals,
        atGate ?? new Map([...totals].map(([k, e]) => [k, e.cumulative as bigint])),
        paidAt,
        LOCKER_RECLAIM_ACCOUNT,
      )
    : new Set<string>();

  const entries = [...totals.values()];
  const cumOf = new Map<string, bigint>();
  for (const e of entries) {
    const leg = e.stock.toLowerCase();
    cumOf.set(leg, (cumOf.get(leg) ?? 0n) + e.cumulative);
  }

  // The locker, skipped by `keeper.ts` on every push: it cannot move an ERC-20.
  let locker: string | undefined;
  try {
    const addr = await client.readContract({ address: PONS_V2_FACTORY, abi: ponsFactoryAbi, functionName: "locker" }) as Address;
    const locks = await client.readContract({ address: addr, abi: ponsLockerAbi, functionName: "isLocked", args: [token] }) as boolean;
    if (locks) locker = addr.toLowerCase();
  } catch { /* unreadable: the keeper would push to it */ }

  const parts = pushFloorParts(quote, minBuyQuote, basefee);
  const standing = parts.perDelivery > parts.target ? parts.perDelivery : parts.target;

  console.log(`vault ${vault} · token ${token} · quote ${quote === "0x0000000000000000000000000000000000000000" ? "native ETH" : quote}`);
  console.log(`root #${activeRoot} through epoch ${upTo} · ${entries.length} (holder, stock) pairs in the tree`);
  console.log(`basefee ${Number(basefee) / 1e9} gwei${forced ? ` (forced, live ${Number(live) / 1e9})` : ""} · ETH at $${USD_PER_ETH.toFixed(0)} (PUSH_TARGET_WEI's convention)`);
  console.log(`standing floor: $${usd(standing).toFixed(2)} (target $${usd(parts.target).toFixed(2)}, gas bound $${usd(parts.perDelivery).toFixed(2)}/pair)`);
  console.log(`distributor reserve: ${formatEther(reserve)} ETH ($${usd(reserve).toFixed(2)})\n`);
  if (reclaimed.size > 0) console.log(`locker reclaim applied: ${reclaimed.size} row(s) handed back to the holders\n`);

  const scenarios: [string, bigint, bigint][] = [
    ["standing (~$10)", parts.target, parts.perDelivery],
    ["~$1", PUSH_TARGET_WEI / 10n, 0n],
    ["zero", 0n, 0n],
  ];

  console.log("floor            wallets  legs   delivered   gas (gross)   refunded   the keeper eats");
  for (const [name, target, perDelivery] of scenarios) {
    const keys = pushSetWhole(entries, paidAt, quoteSpentOf, cumOf, target, perDelivery);
    const perHolder = new Map<string, { legs: number; value: bigint }>();
    for (const e of entries) {
      const k = `${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`;
      if (!keys.has(k)) continue;
      if (locker && e.holder.toLowerCase() === locker) continue;
      const already = paidAt.get(k) ?? 0n;
      const leg = e.stock.toLowerCase();
      const value = ((e.cumulative - already) * (quoteSpentOf.get(leg) ?? 0n)) / (cumOf.get(leg) ?? 1n);
      const cur = perHolder.get(e.holder.toLowerCase()) ?? { legs: 0, value: 0n };
      cur.legs++; cur.value += value;
      perHolder.set(e.holder.toLowerCase(), cur);
    }
    let legs = 0, delivered = 0n, gross = 0n, refunded = 0n;
    for (const h of perHolder.values()) {
      legs += h.legs;
      delivered += h.value;
      const gas = BigInt(h.legs) * SETTLE_GAS + REFUND_OVERHEAD;
      const cost = gas * basefee;
      gross += cost;
      let owed = (cost * (10_000n + PUSH_MARGIN_BPS)) / 10_000n;
      const ceiling = (h.value * REFUND_VALUE_BPS) / 10_000n;
      if (owed > ceiling) owed = ceiling;
      if (owed > MAX_REFUND) owed = MAX_REFUND;
      refunded += owed;
    }
    const eats = gross > refunded ? gross - refunded : 0n;
    console.log(
      `${name.padEnd(16)} ${String(perHolder.size).padStart(7)} ${String(legs).padStart(5)} `
      + `${("$" + usd(delivered).toFixed(2)).padStart(11)} ${("$" + usd(gross).toFixed(2)).padStart(13)} `
      + `${("$" + usd(refunded).toFixed(2)).padStart(10)} ${("$" + usd(eats).toFixed(2)).padStart(17)}`,
    );
  }
  if (locker) console.log(`\nlocker ${locker} filtered out of every row, as the keeper does.`);
  if (reserve < 0n) console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
