/**
 * rehearsal.ts — a checklist that checks itself.
 *
 * The rehearsal exists because nothing in this repository has ever run with us
 * as the `creatorFeeRecipient`. The fork tests use other people's tokens: they
 * prove the code is right against real state, not that OUR deployment works.
 *
 * A passive checklist would let you tick "harvest works" because a transaction
 * did not revert. This reads the chain instead and reports, step by step, what
 * has actually happened — and refuses to call a step done on anything weaker
 * than on-chain evidence.
 *
 * It is read-only. It signs nothing, holds no key, and can be run at any time,
 * including against the real deployment after launch.
 *
 *   DISTRIBUTOR=0x… FEE_VAULT=0x… pnpm --filter offchain rehearsal
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { RPC_URL, PONS_V2_FACTORY, PONS_V2_ESCROW } from "./config.js";
import { distributorAbi, feeVaultAbi, escrowAbi } from "./abis.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const factoryAbi = [
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

type State = "done" | "pending" | "fail" | "n/a";

const rows: { step: string; state: State; detail: string }[] = [];
const add = (step: string, state: State, detail: string) => rows.push({ step, state, detail });

function env(k: string): Address {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from the environment`);
  return v as Address;
}

async function main() {
  const distributor = env("DISTRIBUTOR");
  const vault = env("FEE_VAULT");

  const readD = (fn: string, args: unknown[] = []) =>
    client.readContract({ address: distributor, abi: distributorAbi, functionName: fn as never, args: args as never });
  const readV = (fn: string, args: unknown[] = []) =>
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: fn as never, args: args as never });

  // Fail on the obvious mistake before the RPC noise: a typo'd or not-yet-mined
  // address reads as an empty contract, and every call below would then fail
  // with a viem stack trace instead of the actual problem.
  for (const [name, addr] of [["DISTRIBUTOR", distributor], ["FEE_VAULT", vault]] as const) {
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`${name}=${addr} has no code — wrong address, or not deployed yet`);
  }

  // ---- 1. wiring ---------------------------------------------------------
  let vaultDist: string, distVault: string;
  try {
    [vaultDist, distVault] = await Promise.all([
      client.readContract({ address: vault, abi: [{ type: "function", name: "DISTRIBUTOR", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "DISTRIBUTOR" }),
      client.readContract({ address: distributor, abi: [{ type: "function", name: "FEE_VAULT", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "FEE_VAULT" }),
    ]);
  } catch {
    // Both addresses have code, so they are contracts — just not ours. Swapping
    // DISTRIBUTOR and FEE_VAULT is the easy mistake to make here.
    throw new Error(
      "neither address answers DISTRIBUTOR()/FEE_VAULT() — wrong contracts, or the two are swapped",
    );
  }
  const wired = vaultDist.toLowerCase() === distributor.toLowerCase() && distVault.toLowerCase() === vault.toLowerCase();
  add("contracts cross-wired", wired ? "done" : "fail", wired ? "vault <-> distributor" : "MISMATCH — do not continue");

  // ---- 2. bound to a token ----------------------------------------------
  const token = (await readV("token")) as Address;
  if (token === ZERO) {
    add("bind(token)", "pending", "vault is not bound — run script/Rehearsal.s.sol");
    return report();
  }
  add("bind(token)", "done", token);

  const l = (await client.readContract({
    address: PONS_V2_FACTORY as Address, abi: factoryAbi, functionName: "getLaunchedToken", args: [token],
  })) as { creatorFeeRecipient: string; pairToken: string; buybackEnabled: boolean; creatorTaxBps: number; phase: number; curve: string };

  const recipientOk = l.creatorFeeRecipient.toLowerCase() === vault.toLowerCase();
  add("vault is the creatorFeeRecipient", recipientOk ? "done" : "fail",
      recipientOk ? "fees can only be claimed by the vault" : `points at ${l.creatorFeeRecipient} — the vault will never collect`);
  // A vault speaks ONE currency, stamped at birth. Comparing against ETH here
  // would have failed every USDG- or stock-quoted launch the v2 vault exists to
  // serve — three fifths of Pons's volume (measured 2026-09-08).
  const quote = (await client.readContract({
    address: vault, abi: [{ type: "function", name: "QUOTE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "QUOTE",
  })) as string;
  const pairOk = l.pairToken.toLowerCase() === quote.toLowerCase();
  const quoteName = quote === ZERO ? "native ETH" : quote;
  add(`pairToken = ${quoteName}`, pairOk ? "done" : "fail",
      pairOk ? "the fees land on the ledger harvest reads" : `${l.pairToken} — the vault claims a ledger this launch never credits`);
  add("buybackEnabled = false", !l.buybackEnabled ? "done" : "fail",
      !l.buybackEnabled ? "pre-graduation sweep stays reachable" : "the sweep now depends on a Pons operator");
  add("creatorTaxBps", "done", `${l.creatorTaxBps} (${(l.creatorTaxBps / 100).toFixed(2)} %) — frozen forever`);
  // phase: 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued (docs.ponsfamily.com/v2).
  // Only 2 creates the v4 pool. 3 is a graduation that never got one, so the
  // hook sweep stays unreachable there — >= 2 would have called that "live".
  add("graduated", l.phase === 2 ? "done" : l.phase === 3 ? "fail" : "pending",
      l.phase === 2 ? "post-graduation path is live"
      : l.phase === 3 ? "phase 3 (Rescued) — graduation left no v4 pool, the hook sweep is dead"
      : `phase ${l.phase} — the v4 sweep is NOT exercised yet`);

  // ---- 3. fees actually arriving -----------------------------------------
  const escrowBal = (await client.readContract({
    address: PONS_V2_ESCROW as Address, abi: escrowAbi, functionName: "balanceOf", args: [vault],
  })) as bigint;
  const pools = (await Promise.all([
    readV("rewardsPool"), readV("creatorPool"),
  ])) as [bigint, bigint];
  const [rewards, dev] = pools;
  const harvested = rewards + dev > 0n;
  add("harvest() collected fees", harvested ? "done" : "pending",
      harvested
        ? `rewards ${formatEther(rewards)} · dev ${formatEther(dev)} ETH`
        : `nothing split yet — escrow holds ${formatEther(escrowBal)} ETH`);
  if (escrowBal > 0n) add("escrow has claimable fees", "done", `${formatEther(escrowBal)} ETH waiting — call harvest()`);

  // ---- 4. the epoch cycle ------------------------------------------------
  const epoch = (await readD("currentEpoch")) as bigint;
  add("current epoch", "done", epoch.toString());

  // D8 removed `runEpoch` and its `ran(uint256)` flag: an epoch no longer buys
  // one stock, a WINDOW of epochs buys the whole basket. The old probe read a
  // getter that no longer exists — it would have reverted on the first line of
  // the rehearsal, which is the worst place to find out.
  //
  // The window equivalent is `nextEpoch`: the first epoch not yet covered by a
  // purchase. Anything above zero means at least one `buyBasket` has landed.
  const nextE = (await readD("nextEpoch")) as bigint;
  const pending = (await readD("pendingEpochs")) as bigint;
  add(
    "buyBasket() bought the basket",
    nextE > 0n ? "done" : "pending",
    nextE > 0n
      ? `covered through epoch ${nextE - 1n}, ${pending} epoch(s) waiting`
      : `never run — ${pending} epoch(s) waiting`,
  );

  // ---- 5. roots and settlement -------------------------------------------
  const rootCount = (await readD("rootCount")) as bigint;
  add("publishRoot()", rootCount > 0n ? "done" : "pending",
      rootCount > 0n ? `${rootCount} root(s) published` : "the keeper has never published");

  if (rootCount > 0n) {
    const r = (await readD("roots", [rootCount])) as unknown[];
    add("  latest root covers", "done", `through epoch ${r[4]}, cid ${String(r[5]).slice(0, 18)}…`);
  }

  const atRisk = (await readD("quoteAtRisk")) as bigint;
  add("quoteAtRisk()", "done", `${formatEther(atRisk)} ETH — the exposure if the keeper key leaks`);

  const keeper = (await readD("keeper")) as Address;
  add("keeper set", keeper !== ZERO ? "done" : "fail", keeper);

  report();
}

function report() {
  const mark = { done: "  ok  ", pending: " todo ", fail: " FAIL ", "n/a": "  --  " } as const;
  const width = Math.max(...rows.map((r) => r.step.length));
  console.log("");
  for (const r of rows) console.log(`[${mark[r.state]}] ${r.step.padEnd(width)}  ${r.detail}`);

  const failed = rows.filter((r) => r.state === "fail");
  const todo = rows.filter((r) => r.state === "pending");
  console.log("");
  if (failed.length) {
    console.log(`${failed.length} BROKEN — do not launch on top of this:`);
    for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
  }
  if (todo.length) {
    console.log(`${todo.length} step(s) never exercised:`);
    for (const t of todo) console.log(`  - ${t.step}`);
  }
  if (!failed.length && !todo.length) console.log("Every step of the cycle has run at least once on-chain.");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
