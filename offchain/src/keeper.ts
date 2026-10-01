/**
 * keeper.ts — runs the cycle.
 *
 * **Only one of these actions is reserved to it.** `publishRoot` is keeper-only;
 * everything else — harvest, buyBasket, distribute, creator, platform — is
 * callable by anyone; all of them refund their own gas except `payCreator` and
 * `payPlatform`, where whoever calls it pays. If the keeper stops, anyone can keep the cycle turning,
 * and if nobody does, epochs simply carry over (docs/ARCHITECTURE.md §S29).
 *
 * Each step is **idempotent**: it looks at on-chain state and does nothing if
 * the work is already done. The keeper can therefore restart at any moment with
 * no memory, and two keepers running in parallel do not trip over each other —
 * at worst one wastes gas on a reverting transaction.
 *
 *   RPC_URL, KEEPER_PRIVATE_KEY, v.distributor, v.vault in the environment.
 */
import { createPublicClient, createWalletClient, http, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL, chain, BATCH_WAIT_MS, PONS_V2_ESCROW, PONS_V2_FACTORY, ARB_GAS_INFO, V3_FACTORY } from "./config.js";
import { distributorAbi, feeVaultAbi, escrowAbi, ponsFactoryAbi, ponsLockerAbi, quoterAbi, arbGasInfoAbi , registryAbi, treasuryAbi, erc20Abi, v3FactoryAbi, v3PoolAbi, backingRedeemerAbi, lotteryDistributorAbi, portfolioBookAbi, portfolioDistributorAbi, portfolioVaultAbi } from "./abis.js";
import { buyDecision, payCreatorDecision, maxSpendForDepth, slotsForWindow, BUY_BASKET_GAS } from "./buy.js";
import { canonicalJson, l1PricerAlert, gasRunwayAlert, GAS_CRITICAL_TICKS, type CumulativeArtifact } from "./epoch.js";
import { linesOf, planBatches, convertibleLines, lineFloor, LINE_FLOOR_CENTS, type Due } from "./portfolio.js";
import { buildRoot, MODE_BACKING, MODE_DISTRIBUTION, MODE_LOTTERY, MODE_PORTFOLIO, MODE_TONTINE } from "./buildroot.js";
import { buildTickets, drawScope, holderOfTicket } from "./lottery.js";
import { fetchBeacon, roundAt, winningTicket } from "./drand.js";
import { publishEpoch, pruneArtifacts } from "./publish.js";
import { preflight } from "./preflight.js";
import { metered, meterRound } from "./cu.js";
import { prefetchTransfers } from "./snapshot.js";
import { build } from "./merkle.js";
import { reason } from "./announce.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const EPOCH_DIR = process.env.EPOCH_DIR ?? "data";

const REGISTRY = requireEnv("REGISTRY") as Address;

/**
 * One vault and its Distributor, threaded through every step.
 *
 * **Explicitly, not through a module-level "current vault".** A mutable global
 * would work exactly as long as the loop stays sequential, and would break in
 * silence the day somebody wraps it in a `Promise.all` — with two vaults'
 * roots computed against each other's state. This is a keeper for other
 * people's money; it does not get to have that failure mode.
 */
interface Vault {
  vault: Address;
  distributor: Address;
  /** The launched token, i.e. whose holders get paid. Zero until `bind`. */
  token: Address;
  /** The currency the launch is quoted in. Zero means native ETH. */
  quote: Address;
  /** `MIN_BUY_QUOTE`, ~$25 in that currency's own units. */
  minBuyQuote: bigint;
  /** The factory's MODE stamp, from the registry. Decides which steps apply. */
  mode: Hex;
}

/**
 * Every vault the Payd has made, oldest first.
 *
 * **Per-vault tolerant.** These reads used to run before `tick`'s per-vault
 * `try`, so a single registered vault of a NEW mode that answered any of the
 * four differently rejected the whole round — for every existing vault, every
 * 60 seconds. A vault that cannot be described is now skipped and named, and
 * the round goes on without it.
 */
/**
 * Vaults already described, keyed by address.
 *
 * **Every field of `Vault` is written once and never again.** `DISTRIBUTOR`,
 * `QUOTE` and `MIN_BUY_QUOTE` are set by `FeeVault.init`, which is guarded and
 * one-shot (`test_InitHappensOnceAndOnlyOnce`); `modeOf` is stamped by the
 * factory at birth; `token` is set by `bind`, also one-shot. Re-reading them
 * every 60 s asked the node 5 questions per vault, 1 440 times a day, and the
 * answer could not have changed.
 *
 * The one state this has to respect is the vault BEFORE its launch is bound:
 * `token` is zero then and will move exactly once. A zero token is therefore
 * never cached — such a vault is re-described each round until it is bound, and
 * from then on it costs nothing like the others.
 */
const described = new Map<Address, Vault>();

export async function registry(): Promise<Vault[]> {
  const vaults = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "vaults" });
  const out = await Promise.all(
    (vaults as readonly Address[]).map(async (vault) => {
      const known = described.get(vault);
      if (known) return known;
      try {
        const [distributor, token, quote, minBuyQuote, mode] = await Promise.all([
          pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "DISTRIBUTOR" }),
          pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }),
          pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "QUOTE" }),
          pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
          pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "modeOf", args: [vault] }),
        ]);
        // `buildCumulative` reads the QUOTE pair for itself, so `dispute.ts`
        // derives the same floors from the chain alone. They are read again here
        // for what only the keeper can know: which currencies the Treasury may be
        // holding, and the bar under which sweeping one is not worth its gas.
        const v: Vault = {
          vault, distributor: distributor as Address, token: token as Address,
          quote: quote as Address, minBuyQuote: minBuyQuote as bigint, mode: mode as Hex,
        };
        if (v.token !== ZERO_ADDRESS) described.set(vault, v);
        return v;
      } catch (e) {
        log(`vault ${vault} cannot be described, skipped this round:`, reason(e));
        return null;
      }
    }),
  );
  return out.filter((v): v is Vault => v !== null);
}
const QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** Margin below the quote, in bps. The contract enforces its own floor anyway. */
const SLIPPAGE_BPS = 100n;

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from the environment`);
  return v;
}

const account = privateKeyToAccount(requireEnv("KEEPER_PRIVATE_KEY") as Hex);
/**
 * **Reads are aggregated through Multicall3** (`chain.contracts.multicall3`,
 * declared in config.ts). Every `Promise.all` of `readContract`s below leaves as
 * ONE `eth_call`, which is where the bulk of this process's RPC bill was: a
 * round that described the registry, priced a basket and read the Treasury in
 * ~65 requests a minute now does it in a handful.
 *
 * Two things it deliberately does NOT touch, and both are load-bearing:
 *   - `simulateContract` (the quoter) carries an `account`, and viem only
 *     aggregates bare `to`+`data` reads — so the revert-and-catch pricing of
 *     QuoterV2 is untouched;
 *   - writes, `getBlock`, `getBalance` and `eth_getLogs` are not calls and go
 *     out as they always did.
 */
const pub = createPublicClient({
  chain,
  batch: { multicall: { wait: BATCH_WAIT_MS } },
  transport: metered(http(RPC_URL, { retryCount: 5, retryDelay: 500 })),
});
const wallet = createWalletClient({ account, chain, transport: metered(http(RPC_URL)) });

/**
 * The round's block, read at most once and never in a round that does not need
 * one.
 *
 * Three steps wanted it — the purchase (for the basefee), `payCreator` (same),
 * and the Treasury's burn cooldown (for the timestamp) — and each called
 * `getBlock()` for itself, so a round that did all three paid for three.
 * `eth_getBlockByNumber` is one of the few reads Multicall3 cannot absorb: it is
 * not a contract call, so it never joins the aggregate and every one of them is
 * a separate metered request.
 *
 * Sharing is not an approximation here. The three uses are "the chain as it is
 * right now", and a round IS one moment — the basefee two steps apart is the
 * same basefee, and the alternative was that the purchase and the dev payout
 * could price their gas against two different blocks for no reason at all.
 */
let roundBlock: Awaited<ReturnType<typeof pub.getBlock>> | null = null;
const blockNow = async () => (roundBlock ??= await pub.getBlock());

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/**
 * Sends a transaction and swallows the revert.
 *
 * Takes a thunk rather than a request object: that preserves per-call ABI typing,
 * which a generic parameter would flatten.
 *
 * A revert is NOT an anomaly here: every step is idempotent and looks at
 * on-chain state, so "already done" or "not ripe yet" naturally shows up as a
 * revert. We log it and move on.
 *
 * **Do not add a nonce manager here.** A tick sends several transactions in a
 * row, and occasionally one fails with "nonce is lower than the current nonce"
 * because the node has not yet reflected the previous one. It self-heals: the
 * step retries on the next tick. Tracking the nonce locally with viem's
 * `nonceManager` looks like the obvious cure and was tried on 2026-09-04 — it
 * made things measurably worse. Same fork, comparable windows:
 *
 *     before, per run   4 nonce errors / 15 sends ok · 5 / 12 · 0 / 4
 *     with nonceManager 7 nonce errors /  4 sends ok
 *     without, fresh    0 nonce errors /  5 sends ok
 *
 * Seven failures for four successes. A cached counter and a node that answers
 * inconsistently fight each other, and the reset needed to stop the counter
 * drifting only re-reads the same inconsistent value. Leaving the node to
 * allocate the nonce is worse in theory and better in practice.
 */
async function send(fn: string, run: () => Promise<Hex>): Promise<boolean> {
  try {
    const hash = await run();
    const r = await pub.waitForTransactionReceipt({ hash });
    log(`${fn} ok`, hash, `gas=${r.gasUsed}`);
    return true;
  } catch (e) {
    log(`${fn} skipped:`, reason(e));
    return false;
  }
}

// ----------------------------------------------------------------- steps

/**
 * Pulls the creator fees into the vault.
 *
 * We do NOT skip when the escrow reads zero. `harvest` sweeps Pons itself now —
 * the bonding curve before graduation, the v4 hook after — so an empty escrow
 * says nothing about whether there is anything to collect; the fees may be
 * sitting on the curve, waiting for exactly this call.
 *
 * That guard was here before the vault could sweep, and it silently disabled the
 * whole cycle once it could: no harvest meant no rewards, no `buyBasket`, no
 * epoch to publish. The keeper anchored seeds forever and distributed nothing.
 *
 * Attempting unconditionally is free when there is nothing to do: `send` fails
 * on gas estimation, before any transaction leaves.
 *
 * **Once per epoch, not once per tick.** The refund comes out of REWARDS, and it
 * is a fixed cost per call: at the loop's 60 s cadence it took ~$359/day off the
 * holders where 48 calls take ~$12 — half the rewards at $20k of daily volume,
 * for nothing. Harvesting more often buys nothing either: `buyBasket` spends a
 * fraction of the pool once per epoch, so all that matters is that the pool is
 * topped up before it runs. Fees waiting on the curve or the hook are not at
 * risk while they wait; the only thing frequency changes is the number of
 * refunds.
 *
 * **Once per EPOCH, and not tied to `pendingEpochs()`. Corrected 2026-09-13,
 * from production.** This used to return early on `pendingEpochs() === 0` —
 * "nothing to buy means nothing to top up for" — and that reasoning holds only
 * before graduation, when fees reach the escrow on their own and `harvest` just
 * claims them. After graduation `harvest` IS the sweep of the v4 hook, so the
 * implication runs the other way: there is nothing to buy BECAUSE nothing was
 * harvested.
 *
 *     pendingEpochs = 0 -> no harvest -> the hook is never swept
 *       -> no fees arrive -> no window to fund -> pendingEpochs stays 0
 *
 * $PAYD sat in that loop from 23:14 to 01:45 on launch night. `buyBasket` kept
 * running every epoch and kept spending `rewardsPool` — 1.238 -> 1.011 ETH —
 * while nothing refilled it, and the creator was paid nothing at all. Neither
 * the keeper nor the chain reported an error: every call that ran, succeeded.
 *
 * **The cost bound is unchanged, because it never came from `pendingEpochs`.**
 * `harvestedEpoch` is what caps this at one call per epoch per vault — 48 a day,
 * the ~$12 the paragraph below prices — and it is still here. On an epoch with
 * genuinely nothing to collect the call fails at gas estimation, before any
 * transaction leaves, and `send` logs the skip.
 *
 * The in-memory flag also covers the case no on-chain read can: a window whose
 * pool has not reached `MIN_BUY`, where nothing would stop us harvesting every
 * minute. Losing it on a restart costs one extra harvest, nothing more — and it
 * is per VAULT, because two vaults share a tick but not an epoch counter.
 */
/// Per VAULT, not global: two vaults share a tick but not an epoch counter.
const harvestedEpoch = new Map<string, bigint>();

async function stepHarvest(v: Vault, epoch: bigint) {
  if (harvestedEpoch.get(v.vault) === epoch) return;
  harvestedEpoch.set(v.vault, epoch);

  const due = await pub.readContract({ address: PONS_V2_ESCROW, abi: escrowAbi, functionName: "balanceOf", args: [v.vault] });
  if (due !== 0n) log(`escrow: ${due} wei already claimable`);
  await send("harvest", () => wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "harvest", account, chain }));
}

/**
 * Puts stray ETH to work.
 *
 * The vault credits nothing on a plain transfer — `receive()` is also where
 * `ESCROW.claim()` lands, so crediting there would count a harvest twice. ETH
 * sent in by hand (a top-up before a launch, a donation, a sweep that took an
 * unplanned route) therefore sits in the balance, belonging to no bucket, until
 * somebody calls `fundRewards`. Nobody would.
 *
 * Gated on a read rather than left to fail on estimation: this runs every
 * minute and there is normally nothing to do, so an unconditional attempt would
 * log a skip a minute for ever.
 */
async function stepDonations(v: Vault) {
  const [bal, rewards, dev, pending] = await Promise.all([
    pub.getBalance({ address: v.vault }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "rewardsPool" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "creatorPool" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "pendingTotal" }),
  ]);
  const free = bal - rewards - dev - pending;
  if (free <= 0n) return;
  log(`${free} wei sitting in the vault outside every bucket, crediting it to rewards`);
  await send("fundRewards", () => wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "fundRewards", account, chain }));
}

/**
 * sqrt(1.01) - 1, as a fraction: the share of a pool's active liquidity that
 * sits inside a +1 % move. `docs/allowlist.md` defines the depth this way and
 * `test/Payd.t.sol::_depthUsdVsPivot` computes it the same way.
 */
const DEPTH_K_NUM = 4_987_562n;
const DEPTH_K_DEN = 1_000_000_000n;
const Q96 = 2n ** 96n;

/**
 * The pivot-side depth of a +1 % move on one leg's pool, in raw PIVOT units.
 * `undefined` when the pool cannot be read — which clamps nothing, rather than
 * clamping everything to the floor because one `getPool` returned zero.
 */
/**
 * `V3_FACTORY.getPool`, asked once per triple.
 *
 * A Uniswap v3 factory writes `getPool` when the pool is created and never
 * again, so the answer for a given (tokenA, tokenB, fee) cannot change — a pool
 * that does not exist yet is the one case worth re-asking, and the zero is
 * therefore not cached. Two callers ask on the hot path, every tick, once per
 * basket leg.
 */
const poolCache = new Map<string, Address>();
async function poolOf(a: Address, b: Address, fee: number): Promise<Address> {
  const key = `${a.toLowerCase()}:${b.toLowerCase()}:${fee}`;
  const known = poolCache.get(key);
  if (known) return known;
  const pool = await pub.readContract({
    address: V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [a, b, fee],
  }) as Address;
  if (pool !== ZERO_ADDRESS) poolCache.set(key, pool);
  return pool;
}

async function legDepthPivot(stock: Address, poolFee: number): Promise<bigint | undefined> {
  try {
    const pool = await poolOf(USDG as Address, stock, poolFee);
    if (pool === ZERO_ADDRESS) return undefined;
    const [liq, slot0] = await Promise.all([
      pub.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity" }),
      pub.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }),
    ]);
    const sqrtP = slot0[0];
    if (liq === 0n || sqrtP === 0n) return undefined;
    // Uniswap orders a pool's tokens by address, so this is token0 without a
    // call: amount0 in range is L/sqrtP, amount1 is L*sqrtP.
    const pivotIsToken0 = BigInt(USDG) < BigInt(stock);
    const raw = pivotIsToken0 ? (BigInt(liq) * Q96) / sqrtP : (BigInt(liq) * sqrtP) / Q96;
    return (raw * DEPTH_K_NUM) / DEPTH_K_DEN;
  } catch {
    return undefined;
  }
}

/**
 * **T-TWAP-01 — the bound the contract cannot carry.** `FeeVault._legFloor`
 * tolerates a constant 300 bps while the leg scales with the reserve, and
 * nothing on-chain compares a leg to the pool it hits. The on-chain fix was
 * built and sized at **+876 bytes, landing FeeVault 266 over the EIP-170 cap**,
 * so the bound is here. `FLOWS.md` §7.e records what that buys and what it does
 * not: it binds this keeper, not a stranger calling the permissionless
 * `buyBasket`.
 *
 * Returns the cap in the vault's QUOTE units, or `undefined` when the pivot →
 * quote rate is not available. Only an ether-quoted vault is served, for the
 * same reason the `minOuts` loop below is: the quoter path here is
 * `WETH -> USDG`, and a stock-quoted vault's first hop is a different one.
 */
async function depthCapQuote(allocs: readonly { stock: Address; bps: number; poolFee: number }[], quote: Address) {
  const legs: { bps: bigint; depth: bigint }[] = [];
  for (const a of allocs) {
    if (a.stock.toLowerCase() === USDG.toLowerCase()) continue; // no pool against itself
    const d = await legDepthPivot(a.stock, a.poolFee);
    if (d !== undefined) legs.push({ bps: BigInt(a.bps), depth: d });
  }
  const capPivot = maxSpendForDepth(legs);
  if (capPivot === undefined) return undefined;
  if (quote.toLowerCase() === USDG.toLowerCase()) return capPivot;
  if (quote !== ZERO_ADDRESS) return undefined; // a stock quote: no rate here
  try {
    // One ether, priced in USDG through the pool every ether vault's first hop
    // uses. A rate, not a quote for the purchase — so it does not depend on the
    // amount we are about to decide.
    const path = ("0x" + WETH.slice(2) + "000064" + USDG.slice(2)) as Hex;
    const { result } = await pub.simulateContract({
      address: QUOTER, abi: quoterAbi, functionName: "quoteExactInput", args: [path, 10n ** 18n],
    });
    const pivotPerEth = result[0];
    if (pivotPerEth === 0n) return undefined;
    return (capPivot * 10n ** 18n) / pivotPerEth;
  } catch {
    return undefined;
  }
}

/**
 * **Keeps the first hop's TWAP window alive, and grows it when it is not
 * (T-HYP-02).**
 *
 * A v3 observation ring is a fixed number of slots, so the seconds of history it
 * holds shrink as the pool gets BUSIER. Measured on PFE/USDG, a listed quote:
 * 64 slots spanning 943 seconds against the 1 800 required, after weeks of being
 * green. And the first hop does not degrade the way a leg does —
 * `FeeVault._route` asks `meanTick`, which reverts, and the whole purchase goes
 * with it.
 *
 * `increaseObservationCardinalityNext` is PERMISSIONLESS, so this is a
 * transaction rather than a vote: the keeper grows the ring and the vault keeps
 * working. The new slots fill as the pool trades, so the purchase waits a round
 * rather than reverting into a log nobody reads.
 *
 * Returns true when the hop can be priced right now.
 */
/** The route fields of one vault: four reads that `init` settled for good. */
const routeCache = new Map<Address, { quoteFee: number; quoteWethFee: number; ethPivotFee: number; window: number }>();

async function ensureFirstHopWindow(v: Vault, quote: Address): Promise<boolean> {
  // A pivot-quoted vault has no first hop at all: `_toPivot` returns what it
  // was given.
  if (quote.toLowerCase() === USDG.toLowerCase()) return true;
  try {
    // **The route is declared at birth, so it is read once.** All four are
    // written by `init` and never again (`TWAP_WINDOW` is not even storage), and
    // the whole point of the design is that the route is "declared at birth from
    // a measurement, never probed at swap time" — re-reading it every 60 s was
    // asking the chain to confirm a constant.
    const route = routeCache.get(v.vault) ?? await (async () => {
      const [quoteFee, quoteWethFee, ethPivotFee, window] = await Promise.all([
        pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "QUOTE_FEE" }),
        pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "QUOTE_WETH_FEE" }),
        pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "ETH_PIVOT_FEE" }),
        pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "TWAP_WINDOW" }),
      ]);
      const r = { quoteFee, quoteWethFee, ethPivotFee, window };
      routeCache.set(v.vault, r);
      return r;
    })();
    const { quoteFee, quoteWethFee, ethPivotFee, window } = route;

    // **Every pool the declared route reads, not just the first.** Exactly one
    // of the two tiers is non-zero, and which one decides the shape:
    //
    //   - ether       WETH/PIVOT at ETH_PIVOT_FEE, one pool;
    //   - direct      QUOTE/PIVOT at QUOTE_FEE, one pool;
    //   - the detour  QUOTE/WETH then WETH/PIVOT -- TWO, and `_route` prices it
    //                 with `quoteTwoHops`, which calls `meanTick` on BOTH. A
    //                 previous version of this function watched neither and said
    //                 so in the log, which is not the same as covering it.
    const hops: [Address, Address, number][] =
      quote === ZERO_ADDRESS
        ? [[WETH as Address, USDG as Address, ethPivotFee]]
        : quoteFee !== 0
          ? [[quote, USDG as Address, quoteFee]]
          : [[quote, WETH as Address, quoteWethFee], [WETH as Address, USDG as Address, ethPivotFee]];

    for (const [tokenIn, against, fee] of hops) {
      if (fee === 0) continue;
      const pool = await poolOf(tokenIn, against, fee);
      if (pool === ZERO_ADDRESS) continue;

      const slot0 = await pub.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" });
      const index = BigInt(slot0[2]);
      const cardinality = BigInt(slot0[3]);
      if (cardinality === 0n) continue;
      // The oldest observation sits just after the newest once the ring has
      // wrapped; before it wraps, slot 0 is the oldest.
      let oldest = await pub.readContract({
        address: pool, abi: v3PoolAbi, functionName: "observations", args: [(index + 1n) % cardinality],
      });
      if (!oldest[3]) {
        oldest = await pub.readContract({ address: pool, abi: v3PoolAbi, functionName: "observations", args: [0n] });
      }
      const now = (await pub.getBlock()).timestamp;
      const span = now > BigInt(oldest[0]) ? now - BigInt(oldest[0]) : 0n;

      const want = slotsForWindow(span, cardinality, BigInt(window));
      if (want === 0n) continue;

      log(`  route pool ${pool} holds ${span}s of a ${window}s window in ${cardinality} slots — growing it to ${want}`);
      await send("increaseObservationCardinalityNext", () => wallet.writeContract({
        address: pool, abi: v3PoolAbi, functionName: "increaseObservationCardinalityNext",
        args: [Number(want)], account, chain,
      }));
      log("  the new slots fill as the pool trades. The purchase waits a round rather than reverting.");
      return false;
    }
    return true;
  } catch (e) {
    // Never a reason to stop the cycle: at worst `buyBasket` reverts and the
    // window is covered next round.
    log(`  could not read the route's windows: ${(e as Error).message}`);
    return true;
  }
}

/** Buys the current epoch's stock, unless the epoch has already run. */
async function stepBuyBasket(v: Vault, epoch: bigint) {
  // **`MIN_BUY_QUOTE`, not `MIN_BUY`.** The second is the wei constant
  // (0.01 ether) and the first is what the contract actually spends against —
  // the same number in the vault's own currency. Reading the constant made
  // every comparison below wei-against-QUOTE on a non-ether vault, and the
  // keeper skipped all of them silently, for ever. It comes from `v` now, which
  // read it once: `init` is the only thing that ever writes it.
  const minBuyQuote = v.minBuyQuote;
  const quote = v.quote;
  const [pool, payoutBps, maxRefund, allocs, nextEpoch] = await Promise.all([
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "rewardsPool" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "payoutBps" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "MAX_REFUND" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "getAllocations" }),
    pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "nextEpoch" }),
  ]);
  // Nothing to cover: every closed epoch already belongs to a purchase.
  if (epoch === 0n || epoch - 1n < nextEpoch) return;

  // Every threshold lives in `buy.ts`, as a pure function, because this was
  // wrong in three places at once and a fork test is a poor place to find that.
  // Before anything else: a first hop that cannot be priced reverts the WHOLE
  // purchase, not one leg (T-HYP-02).
  if (!(await ensureFirstHopWindow(v, quote as Address))) return;

  const basefee = (await blockNow()).baseFeePerGas ?? 0n;
  const maxAmountIn = await depthCapQuote(
    allocs as readonly { stock: Address; bps: number; poolFee: number }[],
    quote as Address,
  );
  if (maxAmountIn === undefined) log("leg depth unmeasurable for this vault: the purchase is not clamped (T-TWAP-01)");
  const decision = buyDecision({
    pool, payoutBps, maxRefund, minBuyQuote, quote: quote as Address, gasCost: BUY_BASKET_GAS * basefee,
    // Zero means "never bought", which reads as an infinite wait and buys at
    // once — the first purchase of a vault's life is never held back.
    sinceLastBuyMs: lastBuyAt(v) === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastBuyAt(v),
    maxAmountIn,
  });
  if (!decision.buy) {
    log(`window up to ${epoch - 1n}: ${decision.why}`);
    return;
  }
  const amountIn = decision.amountIn;

  // A quote per leg, to tighten the on-chain floor. The caller can only tighten
  // it (§S3), so a leg whose quote fails simply falls back to the contract's
  // own floor instead of degrading anything.
  const minOuts: bigint[] = [];
  for (const a of allocs) {
    const legIn = (amountIn * BigInt(a.bps)) / 10_000n;
    let minOut = 0n;
    try {
      const path = ("0x" + WETH.slice(2) + "000064" + USDG.slice(2) + a.poolFee.toString(16).padStart(6, "0") + a.stock.slice(2)) as Hex;
      const { result } = await pub.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInput", args: [path, legIn] });
      minOut = (result[0] * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    } catch {
      log(`quote unavailable for ${a.stock}, letting the on-chain floor decide`);
    }
    minOuts.push(minOut);
  }

  await send("buyBasket", () =>
    wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "buyBasket", args: [minOuts], account, chain }));
  // Stamped after the attempt, not after a confirmed success: `send` swallows a
  // revert, and a vault whose purchase keeps failing must not be retried every
  // sixty seconds for ever. It waits its turn like any other.
  markBought(v);
}

/// The last epoch already covered by a published root. Everything above it that
/// is funded and unseeded blocks the next one.
async function lastPublishedEpoch(v: Vault): Promise<bigint> {
  const activeRoot = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "activeRoot" });
  if (activeRoot === 0n) return -1n;
  const r = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "roots", args: [activeRoot] });
  return BigInt(r[4]);
}

/**
 * Publishes a CUMULATIVE root covering everything up to `upToEpoch`.
 *
 * It takes effect IMMEDIATELY: no bond, no window. The only guard on the
 * contract side is that the covered range must move forward.
 */
/**
 * The epoch at which this vault last had NOTHING to publish.
 *
 * Only the two pure "nothing to cover" outcomes below write it — the range is
 * already covered, or not enough epochs have piled up. Every other path,
 * failures included, leaves it alone, so a publication that could not go out
 * is retried on the next 60 s tick exactly as before. Two sequential reads
 * (`activeRoot`, then `roots(activeRoot)`) cannot be batched into one another,
 * so this is the only way not to pay for them thirty times a window.
 */
const nothingToPublishAt = new Map<Address, bigint>();

async function stepPublish(v: Vault, current: bigint) {
  if (nothingToPublishAt.get(v.vault) === current) return;
  const activeRoot = await pub.readContract({
    address: v.distributor, abi: distributorAbi, functionName: "activeRoot",
  });

  // The last FINISHED epoch, full stop. The scan that used to sit here looked
  // for the newest seeded epoch; with no seed, the only condition left is the
  // one the contract itself enforces — the period must be over.
  const upTo = current - 1n;
  if (upTo < 0n) return;

  if (activeRoot > 0n) {
    const prev = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "roots", args: [activeRoot] });
    const covered = BigInt(prev[4]);
    if (upTo <= covered) { // nothing new to cover
      nothingToPublishAt.set(v.vault, current);
      return;
    }
    // Wait until enough epochs have piled up to be worth a publication. Never
    // starves: `upTo` advances with the clock, so the gap always closes.
    // The FIRST root is exempt — a chain with nothing claimable yet should not
    // stay that way for N epochs.
    if (upTo - covered < BigInt(ROOT_INTERVAL_EPOCHS)) {
      log(`root deferred: ${upTo - covered}/${ROOT_INTERVAL_EPOCHS} epochs since the last one`);
      nothingToPublishAt.set(v.vault, current);
      return;
    }
  }

  // An epoch range with nothing funded in it is a normal early-life state, not
  // an error: `buyBasket` may not have bought yet, or every holder may be below
  // the eligibility floor. `buildCumulative` throws on it, and letting that
  // escape aborted the whole tick — so `distribute` and `payDev`
  // never ran either, and the keeper looked alive while doing nothing.
  let built: Awaited<ReturnType<typeof buildRoot>>;
  try {
    built = await buildRoot(v.distributor, v.vault, Number(upTo));
  } catch (e) {
    log(`nothing to publish through epoch ${upTo}:`, (e as Error).message);
    return;
  }
  log(`root through epoch ${upTo}: ${built.entries.length} entries, ${built.pushKeys.size} to push`);

  // PREFLIGHT FIRST. The root takes effect immediately: nothing catches it
  // after the fact. A battery of checks the keeper can run on its own blocks
  // publication at the slightest doubt — publishing wrongly misdirects stocks,
  // publishing nothing merely delays rewards.
  const previous = readPreviousArtifact(v);
  const pf = await preflight(v.distributor, v.vault, built, previous);
  for (const c of pf.checks) log(`  preflight ${c.skipped ? "SKIP" : c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  // **Per round, not once at startup (T-OFF-03).** A check that did not run is
  // not a check that passed, and `crossCheck` is the only one of the five that
  // catches a DATA error — a node truncating a page of logs redistributes the
  // missing holders' weight to the others, and nothing in the totals looks
  // wrong. It fails open on purpose; what it must not do is fail open in
  // silence.
  const skipped = pf.checks.filter((c) => c.skipped).map((c) => c.name);
  if (skipped.length) {
    log(`  WARNING: ${skipped.join(", ")} DID NOT RUN — publishing with less verification than the design assumes.`);
    log("  WARNING: set RPC_URL_FALLBACK to a second, independent endpoint. See .env.example.");
  }
  if (!pf.ok) {
    log("PREFLIGHT FAILED — publication cancelled. The cycle resumes next tick.");
    return;
  }

  // PUBLISH THE ARTIFACT BEFORE THE ROOT. A root committed without its JSON is
  // shares nobody can claim: the proofs come from that file. And since the root
  // takes effect immediately, there is no window left to fix a failed
  // publication.
  const res = await publishEpoch(v.distributor, Number(upTo), canonicalJson(built.artifact));
  if (!res.retrievable) {
    log(`artifact not retrievable (${res.cid}), publication deferred — local copy ${res.localPath}`);
    return;
  }
  log(`artifact published ${res.cid} (read back from ${res.from})`);

  // **The second key, and it is asked BEFORE the publication rather than
  // consulted after it.** A keeper key alone could publish a root awarding
  // itself the whole undelivered balance in two transactions of one block, so
  // nothing that runs after `publishRoot` can help. `coSignerRequired()` is read
  // rather than assumed: it answers false when nobody is named, and also when
  // the one that is named has been silent past `CO_SIGNER_GRACE` — in which case
  // publishing alone beats not publishing at all, and this says so loudly.
  const required = await pub.readContract({
    address: v.distributor, abi: distributorAbi, functionName: "coSignerRequired",
  });
  let coSig: Hex | undefined;
  if (required) {
    coSig = await askCoSigner(v, Number(upTo), built.claimRoot, built.pushRoot, built.cid);
    if (!coSig) {
      // **Put it on the record rather than only give up.** A co-signer that
      // keeps heartbeating and signs nothing would otherwise hold the vault
      // shut for the 48 h a removal takes. Three hours after this call the
      // single-key form accepts THIS root and no other, and the request is in
      // the log the whole time — which is what `watch.ts` shouts about.
      const lapsed = await pub.readContract({
        address: v.distributor, abi: distributorAbi, functionName: "coSignatureLapsed",
        args: [upTo, built.claimRoot, built.pushRoot, built.cid],
      });
      if (!lapsed) {
        await send("requestCoSignature", () => wallet.writeContract({
          address: v.distributor, abi: distributorAbi, functionName: "requestCoSignature",
          args: [upTo, built.claimRoot, built.pushRoot, built.cid], account, chain,
        }));
        log("  root put on the record: if it is still unsigned in CO_SIGNER_GRACE it goes out on one key.");
        log("CO-SIGNATURE REFUSED OR UNAVAILABLE — publication deferred. The cycle resumes next tick.");
        return;
      }
      // The grace has run and this exact root was never signed: publish alone
      // rather than leave the holders waiting on a key that will not answer.
      log("  WARNING: the co-signature lapsed on this root. Publishing on ONE key.");
      log("  WARNING: a co-signer that neither signs nor stops is a co-signer to remove. See FLOWS.md 7.c.");
    }
  } else {
    const named = await pub.readContract({
      address: v.distributor, abi: distributorAbi, functionName: "coSigner",
    });
    if (named !== ZERO_ADDRESS) {
      log(`  WARNING: a co-signer is named (${named}) and has been SILENT past the grace.`);
      log("  WARNING: this root goes out on one key. Check the co-signer host before the next one.");
    }
  }

  await send("publishRoot", () =>
    coSig
      ? wallet.writeContract({
        address: v.distributor, abi: distributorAbi,
        functionName: "publishRoot",
        args: [upTo, built.claimRoot, built.pushRoot, built.cid, res.cid, coSig],
        account, chain,
      })
      : wallet.writeContract({
        address: v.distributor, abi: distributorAbi,
        functionName: "publishRoot",
        // `built.cid` is the sha256 DIGEST — the commitment. `res.cid` is where
        // the artifact actually lives, which is not derivable from it above one
        // block.
        args: [upTo, built.claimRoot, built.pushRoot, built.cid, res.cid],
        account, chain,
      }));

  // Kept as the reference for the next preflight: monotonicity and population
  // will be compared against THIS root.
  writeFileSync(previousRootFile(v), canonicalJson(built.artifact));

  // Only now, once the root this artifact backs is on-chain. Pruning earlier
  // would risk dropping the artifact of a root that is still the active one.
  const { removed, kept } = await pruneArtifacts();
  if (removed > 0) log(`pruned ${removed} old artifact(s), ${kept} still pinned`);
}

/**
 * Asks the co-signer to reproduce this root and sign it.
 *
 * **It must be a different HOST.** Co-locating the signer with this process
 * rebuilds one key with extra steps: what the second key buys is a second
 * COMPUTATION, from another node, and that only exists if the machine is
 * another one. `COSIGNER_URL` is the address of `offchain/src/cosign.ts`
 * running there.
 *
 * A refusal is not an error to retry around: it means the co-signer replayed
 * the epochs and got something else. The publication is cancelled and the
 * divergence is logged with the fields it names.
 */
async function askCoSigner(
  v: Vault,
  upToEpoch: number,
  claimRoot: Hex,
  pushRoot: Hex,
  digest: Hex,
): Promise<Hex | undefined> {
  const url = process.env.COSIGNER_URL;
  if (!url) {
    log("  COSIGNER_URL is not set, and this vault requires a co-signature. Nothing to ask.");
    return undefined;
  }
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ distributor: v.distributor, vault: v.vault, upToEpoch, claimRoot, pushRoot, cid: digest }),
    });
    const body = (await r.json()) as { signature?: Hex; detail?: string; differs?: string[] };
    if (!r.ok || !body.signature) {
      log(`  CO-SIGNER REFUSED: ${body.detail ?? `HTTP ${r.status}`}`);
      if (body.differs?.length) log(`  diverging on: ${body.differs.join(", ")} — run dispute.ts and read it now.`);
      return undefined;
    }
    return body.signature;
  } catch (e) {
    log(`  co-signer unreachable: ${(e as Error).message}`);
    return undefined;
  }
}

/** The previous root's artifact, the preflight's basis for comparison. */
/**
 * The tree of an artifact we already published, rebuilt from the artifact
 * itself rather than from the chain.
 *
 * `build` is a pure function of (entries, pushKeys), and the artifact carries
 * both -- the `push` flag on each entry IS the push set. So this reproduces the
 * published `claimRoot`/`pushRoot` exactly, whatever the windows have done
 * since. Shaped like `buildCumulative`'s result so the caller cannot tell them
 * apart.
 */
function fromPublished(a: CumulativeArtifact) {
  const entries = a.entries.map((e) => ({
    holder: e.holder as Address,
    stock: e.stock as Address,
    cumulative: BigInt(e.cumulative),
  }));
  const pushKeys = new Set(
    a.entries.filter((e) => e.push).map((e) => `${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`),
  );
  return { ...build(entries, pushKeys), pushKeys };
}

function readPreviousArtifact(v: Vault): CumulativeArtifact | null {
  try {
    return JSON.parse(readFileSync(previousRootFile(v), "utf8")) as CumulativeArtifact;
  } catch {
    return null;
  }
}


/**
 * Pushes the holders above the threshold.
 *
 * One entry per stock, however much time has passed: that is the whole point of
 * the cumulative model. Pushes can therefore be spaced out without the cost
 * rising — pushing once a week costs the same as pushing every hour.
 *
 * **Hence the 24 h cadence.** The push floor bounds gas by the VALUE delivered
 * (a ~$20 threshold per delivery). A cadence bounds it by the NUMBER OF HOLDERS.
 * Taking the minimum of the two makes the cycle self-funding everywhere: with a
 * $20 floor and 24 h, the 3 % reserve covers the gas from ~$10k of daily volume
 * on: doubling the floor halves the number of deliveries for the same value
 * distributed, so it halves the bill at every volume.
 *
 * The cost is PER HOLDER and fixed ($0.0927 per delivery); the revenue is PER
 * VOLUME. That is why the holders/volume ratio is what binds, never volume
 * alone.
 *
 * Nobody is blocked by this: `claim` stays open permanently. A holder in a hurry
 * collects their shares whenever they like, paying their own gas — which is
 * fair, since they are choosing not to wait their turn.
 */
const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_HOURS ?? 24) * 3_600_000;

/**
 * Publish a root every N epochs instead of every one. Default 1 — the cadence
 * the system was designed with, and the one the dashboard feels.
 *
 * The lever exists because `publishRoot` is 242,520 gas of the 609,815 an epoch
 * costs, ~40 %, and it is the only one of the four that does not have to run
 * every time: roots are CUMULATIVE, and the contract asks only that the covered
 * range move forward. One root can settle four epochs.
 *
 * What raising it does NOT slow down, which is most of what people watch: the
 * per-epoch history and the per-stock totals are read straight from the chain
 * (`epochFunded`, `totalFunded`), so the basket keeps filling every 30 minutes
 * whatever this is set to. And the automatic airdrop is bounded by
 * `PUSH_INTERVAL_HOURS`, not by this. What it does slow down is how soon a
 * holder can claim BY HAND, and the artifact-derived epoch count on the page.
 *
 * Measured at 0.4182 gwei with ETH at $2,455:
 *
 *     N = 1  (30 min)   609,815 gas/epoch   $30.05/day
 *     N = 4  (2 h)      427,925             $21.09/day
 *     N = 12 (6 h)      387,505             $19.10/day
 *
 * It bottoms out at $18.10/day: `fund` runs every
 * epoch no matter what, because each epoch needs its own seed and its own buy.
 * That floor is the price of a 30-minute epoch, and only the epoch length —
 * immutable after deployment — can move it.
 */
const ROOT_INTERVAL_EPOCHS = Math.max(1, Number(process.env.ROOT_INTERVAL_EPOCHS ?? 1));

/**
 * On-disk state is keyed by the DEPLOYMENT it describes.
 *
 * Both files below say something about one Distributor, and neither says which.
 * Point the keeper at a new deployment — a relaunch, a rehearsal, a redeploy —
 * with the old `data/` volume still mounted, and the damage is silent: the
 * preflight compares the first root of the new chain against the last artifact
 * of the old one, sees every holder's cumulative fall to zero, and refuses to
 * publish for ever. `last-push.json` is milder and still wrong: the first
 * airdrop, the one everybody is watching, waits a full interval for no reason.
 */
// Keyed by DEPLOYMENT, which is what makes the same data volume safe to reuse
// across vaults: two Distributors number their epochs from their own genesis,
// so a shared file would rebuild one's roots from the other's shares.
const previousRootFile = (v: Vault) => `${EPOCH_DIR}/previous-root-${v.distributor.toLowerCase()}.json`;
const lastPushFile = (v: Vault) => `${EPOCH_DIR}/last-push-${v.distributor.toLowerCase()}.json`;
/** Last completed purchase. Same shape and same failure mode as the push file:
 *  losing it buys once more than needed, and nothing worse. */
const lastBuyFile = (v: Vault) => `${EPOCH_DIR}/last-buy-${v.vault.toLowerCase()}.json`;

function lastBuyAt(v: Vault): number {
  try {
    return JSON.parse(readFileSync(lastBuyFile(v), "utf8")).at ?? 0;
  } catch {
    return 0;
  }
}

function markBought(v: Vault) {
  mkdirSync(EPOCH_DIR, { recursive: true });
  writeFileSync(lastBuyFile(v), JSON.stringify({ at: Date.now() }));
}

/** Last completed push, cached on disk. Lost = we push one extra time. */
function lastPushAt(v: Vault): number {
  try {
    return JSON.parse(readFileSync(lastPushFile(v), "utf8")).at ?? 0;
  } catch {
    return 0;
  }
}

function markPushed(v: Vault) {
  mkdirSync(EPOCH_DIR, { recursive: true });
  writeFileSync(lastPushFile(v), JSON.stringify({ at: Date.now() }));
}

/**
 * Pons's supply locker, which must never be PUSHED to.
 *
 * Every Pons launch parks part of its supply at `factory.locker()` — 8.16 % of
 * $PAYD, and the identical figure of every other launch, since it is one shared
 * contract. It is a holder like any other as far as the tree is concerned, and
 * at root #26 it is the LARGEST of the 630: 93.15e18 of cumulative PONS, twice
 * the second. So it does not merely clear the delivery floor, it is served
 * FIRST — `0x267444D0…` took the very first `Delivered` of launch night,
 * **6.172 PONS at block 61499557**.
 *
 * **Read off the logs, 2026-09-13, because the figures this paragraph first
 * carried were read off the locker's BALANCES and are not ours.** It holds
 * 13.139 NVDA and 0.261 QQQ, and neither came from this Distributor: a
 * `Transfer` scan over the last 1.4 M blocks shows the NVDA arriving every
 * ~30 min from `0x0263da0f…` (1,285 bytes of code, answering none of our
 * selectors) and no QQQ arriving at all. Five `Delivered` exist in total, all
 * PONS, blocks 61499557-61499564, and exactly one of them went to the locker.
 * The defect is the same one either way; the amount it has cost us so far is
 * 6.172 PONS and not a basket.
 *
 * **And nothing comes back out.** `PonsV2LaunchLocker` has five state-changing
 * functions — `acceptOwnership`, `lockPosition`, `lockTokenSupply`,
 * `setFactory`, `transferOwnership` — and not one of them moves an ERC-20. A
 * stock delivered there is gone, for us and for Pons.
 *
 * **Why this is a push filter and NOT an exclusion.** Adding it to
 * `structuralExclusions` would be the right shape and the wrong effect: those
 * are RECOMPUTED on every build, not replayed from a dated log, so the locker's
 * cumulative entries would drop to zero across the whole history, `checkMonotonic`
 * would see "a cumulative amount went backwards", and `preflight` would cancel
 * every publication from then on. Skipping the push touches neither the tree nor
 * the root: the locker's share simply stays undelivered in the Distributor, the
 * same state as any entry below the floor, and it stays inside `quoteAtRisk`
 * where it is accounted for. Stopping it accruing NEW shares is the timelock's
 * `excluded` list, which IS dated and therefore safe — 48 h, and forward only,
 * executed at **epoch 132**.
 *
 * **And what it accrued BEFORE epoch 132 does come back, from epoch 159** —
 * `epoch.ts`'s `LOCKER_RECLAIM_FROM_EPOCH`. The paragraph above says why a
 * structural exclusion cannot do it and stops there, which read for three days
 * as "the money is stuck": it is not, it is the UNDATED recomputation that is
 * the problem, not the idea. `reclaimUndeliverable` is dated exactly like every
 * other rule here, so a rebuild below that epoch still reproduces what was
 * published, and one root steps the locker's rows down to what it was really
 * delivered and hands the rest to the holders pro-rata. This filter stays: at
 * that point the locker's outstanding share is zero and it would be skipped
 * anyway, and a filter that costs one comparison is not worth the argument
 * about which of the two is now load-bearing.
 *
 * Read off the factory rather than pinned here: it covers every vault and
 * survives Pons pointing at a different locker.
 *
 * **And confirmed against the TOKEN, not taken on trust.** `factory.locker()`
 * answers with today's locker; the state inside it is keyed by token
 * (`isLocked`, `lockedTokenSupply`, `lockedPositions`), so a rotation would
 * leave an older launch's supply at the PREVIOUS address while the getter
 * returned the new one — and the filter would miss it without a word. Asking
 * `isLocked(token)` closes that: a false answer means this token's supply is
 * parked somewhere we are not looking, which is worth saying rather than
 * discovering by a balance that never moves.
 */
const lockerFor = new Map<string, Address | null>();
async function lockerAddress(token: Address): Promise<Address | null | undefined> {
  const k = token.toLowerCase();
  if (lockerFor.has(k)) return lockerFor.get(k);
  try {
    const addr = (await pub.readContract({
      address: PONS_V2_FACTORY, abi: ponsFactoryAbi, functionName: "locker",
    })) as Address;
    const locks = (await pub.readContract({
      address: addr, abi: ponsLockerAbi, functionName: "isLocked", args: [token],
    })) as boolean;
    // `undefined` = the getter answered but not for this token. Distinct from
    // `null` (nothing answered), because the two need different noises.
    const out = locks ? addr : undefined;
    lockerFor.set(k, out ?? null);
    return out;
  } catch {
    // A factory that will not answer is not a reason to stop delivering to
    // everybody else. We push to the locker for one tick and try again — the
    // failure is not cached.
    return null;
  }
}

/**
 * Everything BOTH delivery steps must establish before they send anything.
 *
 * **Extracted rather than copied, and the comments below say why that matters
 * more here than anywhere else in this file.** Each of these guards was added
 * after a production failure — a stale node cancelling an airdrop, an empty
 * root burning the interval, a rebuilt tree whose proofs no longer matched the
 * committed root — and every one of them is a rule about WHICH root is being
 * served. The personal-portfolio mode serves the same roots by another
 * transaction (`distributeInto` instead of `distribute`), so a second copy of
 * this would be a second place for those rules to rot.
 *
 * `null` means "skip this tick, and do NOT mark as pushed": the reason has
 * already been logged.
 */
async function deliveryPlan(
  v: Vault,
): Promise<{
  activeRoot: bigint;
  upTo: number;
  /** The published artifact's tree when we have it, a fresh rebuild otherwise
   *  — and which one it is has already been said out loud, because they are
   *  not equally trustworthy. */
  built: ReturnType<typeof fromPublished> | Awaited<ReturnType<typeof buildRoot>>;
  locker?: string;
} | null> {
  // **A vault that holds no ether is pushed too, and a higher floor is what
  // makes that affordable — not skipping it.** `Distributor._refund` pays in
  // wei out of the balance `FeeVault.harvest` sends it, and it sends nothing
  // when `QUOTE` is not native: the Distributor cannot spend NVDA on gas. So
  // every push there is fronted whole by whoever calls.
  //
  // Not pushing at all was the first answer and it was wrong, for a reason that
  // has nothing to do with cost. `Distributor.totalFunded(stock) -
  // totalDistributed(stock)` -- clamped in `_one`, monitored in quote terms as
  // `quoteAtRisk` -- is what a false root could award itself, and it is already
  // several windows rather than one, because the push floor never reaches the
  // sub-floor tail (`docs/ARCHITECTURE.md` §S29). Stop the deliveries and it
  // grows without any bound at all, on the very vaults where the value then
  // piles up untouched -- and widening who may publish (`Payd.isKeeper`) while
  // that pot grows is the one combination nobody should ship.
  //
  // So the deliveries stay and `NON_ETH_PUSH_MULTIPLE` lifts the floor to ~$200
  // instead. The value is concentrated in the large holders, so the bulk of the
  // pot drains in a fraction of the deliveries; the tail below the floor
  // accumulates exactly as it already does on an ether vault. Same shape, a
  // bigger constant.
  const since = Date.now() - lastPushAt(v);
  if (since < PUSH_INTERVAL_MS) return null;

  const activeRoot = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "activeRoot" });
  if (activeRoot === 0n) return null;
  const r = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "roots", args: [activeRoot] });
  const upTo = Number(r[4]);

  // **A stale read here silently cancels the airdrop for a whole interval, and
  // that happened in production at 13:15:49 on 2026-09-13.** `roots(activeRoot)`
  // is two RPC calls against a load-balanced endpoint, so a node a few blocks
  // behind answers with an OLDER root -- and an older root is not a smaller
  // mistake, it is a different push set. At a low epoch the whole tree is worth
  // a few dollars and the ONLY entry above the floor is the largest holder,
  // which on this vault is Pons's locker at ~25 %. So the tick skipped the
  // locker, found nothing else to send, and called `markPushed` all the same:
  // 46 pairs owed, 0 delivered, and the next attempt an hour away. The chain
  // said nothing because nothing was attempted.
  //
  // `activeRoot` only ever moves forward, so the last artifact we published is a
  // floor on what the chain must be able to tell us. Below it, the answer is the
  // node's and not the contract's -- skip, say so, and do NOT mark: the next tick
  // is 60 s away and will very likely hit a node that is caught up.
  const previous = readPreviousArtifact(v);
  if (previous && upTo < previous.upToEpoch) {
    log(`  distribute skipped: roots(${activeRoot}) says epoch ${upTo}, we published ${previous.upToEpoch} — stale node, retrying next tick`);
    return null;
  }

  // **An empty push set does not consume the interval, and that one line is
  // the whole difference between a sweep that goes out and a sweep rescued by
  // hand.** A root cut with nothing over the floor publishes `pushRoot == 0`.
  // Until 2026-09-19 the tick went on anyway: it rebuilt the tree, found no
  // pair to serve, sent nothing, and called `markPushed` all the same. The gate
  // is hours wide (`PUSH_INTERVAL_HOURS`) and a floor override
  // (`epoch.ts`'s `PUSH_FLOOR_OVERRIDES`) is ONE epoch wide — 30 minutes — so a
  // tick that lands on an empty root shuts the door on the very next root, the
  // one carrying the swept set, and the sweep is lost unless somebody deletes
  // `last-push-<distributor>.json` off the keeper's volume inside that window.
  // That is what happened to epochs 58 (re-run as 60), 104, 155 and 304: four
  // rows out of five, the same failure, each time diagnosed as a one-off.
  //
  // Returning here instead costs two view calls a minute while the tail is
  // below the floor — and the first root with a set in it is served on the next
  // tick, whatever the clock says.
  const onChainPushRoot = r[3] as Hex;
  if (BigInt(onChainPushRoot) === 0n) return null;

  // **Push from the artifact we PUBLISHED, never from a fresh rebuild.**
  //
  // Production, 00:55:56 UTC on 2026-09-14: 96 wallets, 96 `distribute` calls,
  // 96 reverts, nothing delivered. Root #52 covering epoch 58 was published at
  // 00:45:43 (block 62392536); `WindowFunded(58, 58)` -- epoch 58's own basket
  // -- landed at 00:46:44, 598 blocks LATER. So the published tree stops at the
  // epoch 57 windows. Ten minutes on, `buildCumulative` re-read the windows
  // from the chain, `w.toEpoch > upToEpoch` let the epoch 58 one in (58 <= 58),
  // every cumulative moved, and not one proof verified against the `pushRoot`
  // the contract holds.
  //
  // The root is a COMMITMENT. Rebuilding its tree to serve it is rederiving
  // what was already decided, from inputs that keep moving -- `windows()` reads
  // to the head, not to the block the root was cut at. The artifact is the
  // decision, it is already on disk and on IPFS, and the tree rebuilt from it
  // is reproducible by construction.
  //
  // Kept as a fallback: a keeper that has lost its volume has no artifact, and
  // a rebuild that happens to agree is better than no deliveries at all. Which
  // one was used is said out loud, because they are not equally trustworthy.
  const stored = readPreviousArtifact(v);
  const fromArtifact = stored?.upToEpoch === upTo;
  const built = fromArtifact
    ? fromPublished(stored!)
    : await buildRoot(v.distributor, v.vault, upTo);

  // **And verify it against the chain before sending a single transaction.**
  // This is what turns the failure above into one log line instead of 96
  // reverts and a wasted interval: the contract's `pushRoot` is the only
  // authority on which proofs will verify, and comparing costs one SLOAD we
  // have already paid for.
  if (built.pushRoot.toLowerCase() !== onChainPushRoot.toLowerCase()) {
    log(
      `  distribute SKIPPED: rebuilt pushRoot ${built.pushRoot} != root #${activeRoot}'s ${onChainPushRoot}`,
      `(${fromArtifact ? "from the published artifact" : "from a fresh rebuild -- no artifact on disk"}).`,
      "Not one proof would verify; sending would burn the interval for nothing. NOT marking as pushed.",
    );
    return null;
  }
  if (!fromArtifact) {
    log(`  distribute: no stored artifact for epoch ${upTo}, rebuilt from chain — it matches the root, proceeding`);
  }

  const lockerAddr = await lockerAddress(v.token);
  const locker = lockerAddr?.toLowerCase();
  if (lockerAddr === null) log("  WARNING: factory.locker() unreadable — pushing to the locker this tick.");
  if (lockerAddr === undefined) log(`  WARNING: factory.locker() does not lock ${v.token} — its supply sits at another address, NOT filtered.`);
  return { activeRoot, upTo, built, locker };
}

/** Pushes what is over the floor, one `distribute` per wallet. */
async function stepDistribute(v: Vault) {
  const plan = await deliveryPlan(v);
  if (!plan) return;
  const { activeRoot, built, upTo, locker } = plan;

  let skipped = 0;

  const perHolder = new Map<Address, { stocks: Address[]; cumulative: bigint[]; proofs: Hex[][] }>();
  for (const e of built.entries) {
    if (!built.pushKeys.has(`${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`)) continue;
    if (locker && e.holder.toLowerCase() === locker) { ++skipped; continue; }
    const cur = perHolder.get(e.holder) ?? { stocks: [], cumulative: [], proofs: [] };
    cur.stocks.push(e.stock);
    cur.cumulative.push(e.cumulative);
    cur.proofs.push(built.proofFor(e.holder, e.stock, "push") as Hex[]);
    perHolder.set(e.holder, cur);
  }
  // Said out loud, never silent: a delivery we choose not to make is a decision,
  // and the one thing this keeper must not do is decide quietly.
  log(`  distribute: root #${activeRoot} through epoch ${upTo}, ${built.pushKeys.size} pair(s) over the floor, ${perHolder.size} wallet(s) to serve`);
  if (skipped) log(`  locker ${locker}: ${skipped} entr${skipped === 1 ? "y" : "ies"} NOT pushed — it cannot move an ERC-20. Excluding it is the timelock's, 48 h.`);

  for (const [holder, d] of perHolder) {
    // Push only what is actually still owed: the contract knows better than we
    // do, and pushing a zero would revert the whole batch.
    const owed = await Promise.all(d.stocks.map((s, i) =>
      pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "owedTo", args: [holder, s, d.cumulative[i]!] })));
    const keep = d.stocks.map((_, i) => i).filter((i) => owed[i]! > 0n);
    if (keep.length === 0) continue;
    await send(`distribute(${holder})`, () => wallet.writeContract({
      address: v.distributor, abi: distributorAbi, functionName: "distribute",
      args: [holder, keep.map((i) => d.stocks[i]!), keep.map((i) => d.cumulative[i]!), keep.map((i) => d.proofs[i]!)],
      account, chain,
    }));
  }

  // Marked AFTER the loop: if the keeper dies mid-batch, the next tick resumes
  // instead of waiting another full interval. Roots being cumulative, re-pushing
  // an already-served holder costs a revert, not a double payment.
  markPushed(v);
}

/**
 * **The personal-portfolio mode's purchase.** `payout()` instead of
 * `buyBasket`: the vault converts a slice of the reserve into the PIVOT and
 * credits it to the Distributor as one window. There is no basket to price and
 * no per-leg `minOut` to quote — the floor is the route's own 30-minute TWAP,
 * computed on-chain — so this is the whole of it.
 *
 * The same economic gate as `stepBuyBasket` lives inside the contract
 * (`_slice`: `payoutBps` of the free reserve, floored at `MIN_BUY_QUOTE`,
 * capped at `MAX_BUY_MULTIPLE`), so a call that is not worth making reverts
 * `NothingToDo` and costs a log line.
 */
async function stepPayout(v: Vault, epoch: bigint) {
  const nextEpoch = await pub.readContract({
    address: v.distributor, abi: distributorAbi, functionName: "nextEpoch",
  });
  if (epoch === 0n || epoch - 1n < nextEpoch) return;
  await send("payout", () => wallet.writeContract({
    address: v.vault, abi: portfolioVaultAbi, functionName: "payout", account, chain,
  }));
  markBought(v);
}

/**
 * **The personal-portfolio mode's airdrop, and it is automatic in exactly the
 * way the default mode's is.** Same roots, same floor, same interval — the
 * entries over the bar are pushed without the holder doing anything, once
 * their outstanding share is worth the threshold (§S30). What differs is the
 * transaction: a holder is owed PIVOT, and `distributeInto` converts it into
 * the stocks they chose on the way out.
 *
 * **One swap per batch, and that is why the holders are grouped by stock
 * rather than served one by one.** `planBatches` does the grouping; the amounts
 * come from `sliceFor`, which is `PortfolioDistributor._take`'s own arithmetic,
 * so the plan spends what the chain will spend. A holder who declared nothing
 * is carried by the creator's default basket — the book answers `weightOf` for
 * them exactly as it does for anybody else, so nothing here special-cases them.
 *
 * A batch that reverts costs that batch. The others still go out, and the
 * interval is marked after the loop so a keeper that dies mid-batch resumes on
 * the next tick rather than waiting another interval — `stepDistribute`'s rule,
 * for its reason: roots are cumulative, so re-serving a holder costs a revert
 * and never a double payment.
 */
/**
 * The pivot's scale, read once per process.
 *
 * `decimals()` is write-once on every ERC-20 worth the name, and the pivot is
 * one address for the whole platform — so this is a single read whose answer
 * cannot change, cached rather than repeated on every tick of every vault.
 */
const pivotScale = new Map<string, number>();

async function pivotDecimals(pivot: Address): Promise<number> {
  const known = pivotScale.get(pivot.toLowerCase());
  if (known !== undefined) return known;
  const d = Number(await pub.readContract({ address: pivot, abi: erc20Abi, functionName: "decimals" }));
  pivotScale.set(pivot.toLowerCase(), d);
  return d;
}

/**
 * Which of these stocks the registry still allows, in ONE round trip.
 *
 * Cached per tick and not per process: a delisting is exactly the event this
 * exists to notice, so an answer that outlived the round would defeat it.
 */
const allowedThisTick = new Map<string, boolean>();

async function allowedStocks(v: Vault, lines: readonly { stock: Address }[]): Promise<Set<string>> {
  const want = [...new Set(lines.map((l) => l.stock.toLowerCase()))]
    .filter((k) => !allowedThisTick.has(k));
  if (want.length !== 0) {
    const registry = await pub.readContract({
      address: v.vault, abi: portfolioVaultAbi, functionName: "REGISTRY",
    }) as Address;
    const answers = await Promise.all(want.map((stock) =>
      pub.readContract({
        address: registry, abi: registryAbi, functionName: "listing", args: [stock as Address],
      }).then((r) => (r as unknown as readonly [number, Address, boolean])[2]).catch(() => false)));
    want.forEach((k, i) => allowedThisTick.set(k, answers[i]!));
  }
  return new Set([...allowedThisTick].filter(([, ok]) => ok).map(([k]) => k));
}

async function stepConvert(v: Vault) {
  allowedThisTick.clear();
  const plan = await deliveryPlan(v);
  if (!plan) return;
  const { activeRoot, built, upTo, locker } = plan;

  const book = await pub.readContract({
    address: v.distributor, abi: portfolioDistributorAbi, functionName: "book",
  }) as Address;
  const pivot = await pub.readContract({
    address: v.vault, abi: portfolioVaultAbi, functionName: "PIVOT",
  }) as Address;
  const floor = lineFloor(await pivotDecimals(pivot));

  // Every entry of a portfolio root names the PIVOT — it is the only line the
  // vault ever funds — so anything else is a tree this keeper does not
  // understand and must not serve.
  const due: Due[] = [];
  let skipped = 0;
  for (const e of built.entries) {
    if (!built.pushKeys.has(`${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`)) continue;
    if (e.stock.toLowerCase() !== pivot.toLowerCase()) continue;
    if (locker && e.holder.toLowerCase() === locker) { ++skipped; continue; }
    const raw = await linesOf(book, e.holder);
    if (raw.length === 0) continue; // no row and no default
    // A line naming a stock the registry no longer allows is dropped here
    // rather than planned and refused on-chain every interval. The pivot is
    // never looked up — see `convertibleLines`.
    const lines = convertibleLines(raw, await allowedStocks(v, raw), pivot);
    if (lines.length === 0) continue; // every stock they named has been delisted: they keep the pivot
    const converted: Record<string, bigint> = {};
    for (const l of lines) {
      converted[l.stock] = await pub.readContract({
        address: v.distributor, abi: portfolioDistributorAbi,
        functionName: "convertedInto", args: [e.holder, l.stock],
      }) as bigint;
    }
    const claimed = await pub.readContract({
      address: v.distributor, abi: distributorAbi, functionName: "claimedSoFar", args: [e.holder, pivot],
    }) as bigint;
    due.push({ holder: e.holder, cumulative: e.cumulative, claimed, converted, lines });
  }

  const batches = planBatches(due, floor);
  log(
    `  convert: root #${activeRoot} through epoch ${upTo}, ${due.length} wallet(s) in the tree, `
      + `${batches.length} swap(s) over the $${Number(LINE_FLOOR_CENTS) / 100} per-line floor`,
  );
  if (skipped) log(`  locker ${locker}: ${skipped} entr${skipped === 1 ? "y" : "ies"} NOT pushed — it cannot move an ERC-20.`);

  for (const b of batches) {
    const cumulative = b.holders.map((h) => due.find((d) => d.holder === h)!.cumulative);
    const proofs = b.holders.map((h) => built.proofFor(h, pivot, "push") as Hex[]);
    // `minOut` left to the contract's own floor: it reads the pool's 30-minute
    // TWAP and deducts the tier before the band, which is a better number than
    // a quoter call this keeper could get wrong. A caller may only TIGHTEN it
    // (§S3), so passing zero is the honest "no opinion" and never a widening.
    await send(`distributeInto(${b.stock}, ${b.holders.length})`, () => wallet.writeContract({
      address: v.distributor, abi: portfolioDistributorAbi, functionName: "distributeInto",
      args: [b.stock, b.holders, cumulative, proofs, 0n], account, chain,
    }));
  }
  markPushed(v);
}

/** Pays the dev share. Not urgent.
 *
 *  `payDev` is the one cycle call the vault does not refund, so the same
 *  `1 - 1/K` rule as the push floor (`epoch.ts`) applies: only spend the gas
 *  once it is at most 5 % of what moves. Draining the bucket every 60 s meant
 *  paying a fixed-cost transaction to move dust, out of the keeper's own
 *  pocket. */
const DEV_GAS = 40_000n;
const GAS_K_MIN = 20n;

async function stepDev(v: Vault) {
  const [dev, block] = await Promise.all([
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "creatorPool" }),
    blockNow(),
  ]);
  const basefee = block.baseFeePerGas ?? 0n;
  // `creatorPool` is in QUOTE and the gas bar is in wei. See `payCreatorDecision`.
  if (payCreatorDecision(dev, v.quote, v.minBuyQuote, GAS_K_MIN * DEV_GAS * basefee)) {
    await send("payCreator", () => wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "payCreator", account, chain }));
  }
}

/** Pays the platform share to the Treasury. Same rule, same reason as
 *  `stepDev`: `payPlatform` is not refunded by the vault either, so the bucket
 *  has to be worth its own gas before the keeper spends it — `payCreatorDecision`
 *  is written about a pocket, not about the creator, and both pockets are in
 *  `QUOTE`.
 *
 *  **It was missing, and nothing else was ever going to call it.** `harvest`
 *  CREDITS `platformPool`; only `payPlatform` moves it, and it is permissionless
 *  with an immutable destination — so the share of every vault simply sat in the
 *  vault. Found on the TOLL vault on 2026-09-19 with 0.0011058 ETH accrued and a
 *  Treasury that had never received a wei.
 *
 *  A vault born at `PLATFORM_BPS = 0` — $PAYD's — never fills the pocket, so
 *  this reads zero and fires never. */
async function stepPlatform(v: Vault) {
  const [platform, block] = await Promise.all([
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "platformPool" }),
    blockNow(),
  ]);
  const basefee = block.baseFeePerGas ?? 0n;
  if (payCreatorDecision(platform, v.quote, v.minBuyQuote, GAS_K_MIN * DEV_GAS * basefee)) {
    await send("payPlatform", () => wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "payPlatform", account, chain }));
  }
}

/**
 * Watch the one chain setting that would silently break the push economics.
 *
 * The refund measures gas from inside the call — `g0 - gasleft()` — which on
 * Nitro cannot see the L1 posting surcharge, because ArbOS adds that ABOVE the
 * EVM. Today there is nothing to see: this chain's L1 pricer is off and calldata
 * is free (docs/recon.md §10.7). If it is ever switched on, `distribute` starts
 * under-refunding in proportion to its calldata, pushing stops paying for
 * itself, and the only symptom is `quoteAtRisk` drifting up because the
 * permissionless callers quietly stopped coming.
 *
 * Nothing in the contracts can detect that, so the keeper says it out loud.
 * Never blocking: a read that fails, or a pricer that is on, must not cost us an
 * epoch. That is why this runs LAST in the tick and swallows its own errors.
 */
let l1Previous: bigint | null = null;
let l1TicksSinceWarn = 0;

let gasPrevious: bigint | null = null;
/** Exponential mean of the wei burnt per tick. Seeded by the first observation. */
let gasBurnEma: number | null = null;
let gasTicksSinceWarn = 0;

/**
 * The keeper's own balance, which nothing else in this process watches.
 *
 * It matters more than the amount suggests: the container survives its own
 * errors, so a keeper out of gas does not crash -- it loops, failing every
 * send, looking alive. Roots stop being published and holders stop being able
 * to claim, silently. This is the one failure that is invisible from the
 * outside and cheap to make loud.
 */
async function stepGas() {
  try {
    const now = await pub.getBalance({ address: account.address });
    if (gasPrevious !== null && now < gasPrevious) {
      const spent = Number(gasPrevious - now);
      // A top-up raises the balance; only a fall is a burn, so a refuel never
      // pollutes the average.
      gasBurnEma = gasBurnEma === null ? spent : gasBurnEma * 0.8 + spent * 0.2;
    }
    gasPrevious = now;

    const runway = gasBurnEma && gasBurnEma > 0 ? Number(now) / gasBurnEma : null;
    if (gasRunwayAlert(runway, gasTicksSinceWarn)) {
      const r = Math.floor(runway as number);
      log(
        `${r <= GAS_CRITICAL_TICKS ? "CRITICAL" : "WARN"}: the keeper has ${now} wei,`,
        `about ${r} tick(s) of runway at the measured burn.`,
        `Top up ${account.address}. Out of gas, this process does not stop --`,
        "it keeps looping and failing, and roots stop being published without anything looking broken.",
      );
      gasTicksSinceWarn = 0;
    } else {
      ++gasTicksSinceWarn;
    }
  } catch (e) {
    log("gas check failed:", (e as Error).message);
  }
}

async function stepL1Pricer() {
  try {
    const l1 = await pub.readContract({ address: ARB_GAS_INFO, abi: arbGasInfoAbi, functionName: "getL1BaseFeeEstimate" });
    if (l1PricerAlert(l1Previous, l1, l1TicksSinceWarn)) {
      log(
        `WARN: the L1 pricer is ON (getL1BaseFeeEstimate = ${l1}).`,
        "distribute() now under-refunds in proportion to its calldata and pushing may no longer pay for itself.",
        "REFUND_OVERHEAD is an internal constant in both contracts, so correcting it means a redeploy.",
        "Watch quoteAtRisk. See docs/recon.md S10.7.",
      );
      l1TicksSinceWarn = 0;
    } else {
      // `L1_WARN_EVERY_TICKS` was written against a 60 s tick and means "about
      // an hour". This runs on `SLOW_MS` now, so a pass counts for the minutes
      // it stands in for — otherwise the repeat would silently stretch to thirty
      // hours, on a warning whose whole job is to keep being said.
      l1TicksSinceWarn += SLOW_TICKS;
    }
    l1Previous = l1;
  } catch (e) {
    log("L1 pricer check failed (not blocking):", (e as Error).message);
  }
}

// -------------------------------------------------------------------- loop

/// One vault, one full pass. Sequential by design (see `Vault`).
/**
 * The platform's own money, which nothing was moving.
 *
 * **`Treasury.sol` refunds no gas anywhere, deliberately** — "the platform has
 * every reason to call them itself". That reasoning is sound and it left a
 * hole: the reason was never turned into code, so the four pockets filled only
 * when a human remembered, the buyback never ran, and the platform share of a
 * non-ether vault sat in USDG that nothing converted.
 *
 * Every call below is permissionless, so this changes no authority — it only
 * means the keeper is the one who remembers. The gas comes out of the keeper's
 * pocket with no refund, which is why each one is GATED on a read rather than
 * attempted and left to revert: a reverted transaction still costs.
 *
 * The same sweep found three more functions with no caller at all, and each
 * one strands money rather than failing: `pushAll` after this contract has
 * migrated, `followMigration` after the platform VAULT has, and `collectFrom`
 * for a payment a vault could not hand over. Each is documented where it is
 * called.
 *
 * The pockets are only credited by `_split()`, which every paying function runs
 * first. So the bar is checked against what the pocket WILL hold — its current
 * balance plus its share of what has arrived unallocated — and one transaction
 * then does both.
 */
async function stepTreasury(treasury: Address, vaults: Vault[]) {
  const [bal, devPool, burnPool, lpPool, rewardsPool, devBps, burnBps, lpBps, rewardsBps, minMove, migrated] =
    await Promise.all([
      pub.getBalance({ address: treasury }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "devPool" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "burnPool" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "lpPool" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "rewardsPool" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "devBps" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "burnBps" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "lpBps" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "rewardsBps" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "MIN_MOVE" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "migratedTo" }),
    ]);
  // The currencies this contract can ever hold, ether aside: the quotes of the
  // vaults it serves, and nothing else. Derived from the registry rather than
  // read off the sweep mapping, which is not enumerable. Both branches need it.
  const quotes = new Map<string, bigint>();
  for (const v of vaults) {
    if (v.quote === ZERO_ADDRESS || quotes.has(v.quote)) continue;
    quotes.set(v.quote, v.minBuyQuote);
  }

  // **A migrated Treasury moves nothing, and that was read as "nothing to
  // do".** `payDev` and the rest revert `AlreadyMigrated`; `pushAll` is the one
  // function left alive on it, and it is what carries the money across.
  // `PLATFORM` is immutable on every vault — that is what guarantees a creator
  // the platform will not re-point itself at their expense — so payments keep
  // ARRIVING here for ever after the migration. Without this they arrive and
  // stop, which is the same shape as the `payPlatform` hole one level down.
  //
  // Same bars as everywhere else in this function: `pushAll` reverts
  // `NothingToDo` on an empty balance, so a read is required anyway, and dust
  // is not worth a transaction the keeper is not refunded for.
  if (migrated !== ZERO_ADDRESS) {
    if (bal > 0n && bal >= minMove) {
      await send("pushAll(eth)", () =>
        wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "pushAll", args: [ZERO_ADDRESS], account, chain }));
    }
    for (const [token, minBuyQuote] of quotes) {
      const held = await pub.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [treasury] });
      if (held < minBuyQuote) continue;
      await send(`pushAll(${token})`, () =>
        wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "pushAll", args: [token as Address], account, chain }));
    }
    return;
  }

  const allocated = devPool + burnPool + lpPool + rewardsPool;
  const unallocated = bal > allocated ? bal - allocated : 0n;
  const after = (pool: bigint, bps: bigint) => pool + (unallocated * bps) / 10_000n;

  if (after(devPool, devBps) >= minMove) {
    await send("payDev", () =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "payDev", account, chain }));
  }
  if (after(lpPool, lpBps) >= minMove) {
    await send("addLiquidity", () =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "addLiquidity", account, chain }));
  }
  if (after(rewardsPool, rewardsBps) >= minMove) {
    await send("fundPlatformRewards", () =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "fundPlatformRewards", account, chain }));
  }
  // The burn has its own cooldown, so the bar is BOTH: enough to move and long
  // enough since the last one. Attempting inside the cooldown is a guaranteed
  // revert, paid for at the keeper's expense.
  // **The third currencies, and this is the half that had no code at all.** A
  // non-ether vault pays its platform share in USDG or NVDA, and the Treasury
  // works exclusively in ether: the pockets, the burn and the dev only ever see
  // what `sweepToEth` has converted. Without this the platform's revenue on
  // 59.1 % of Pons volume (§S40) arrived and stopped there.
  //
  // The token list is DERIVED from the registry (see `quotes` above), because
  // the only currencies that can reach this contract are the quotes of the
  // vaults it serves.
  for (const [token, minBuyQuote] of quotes) {
    const [held, direct, viaPivot] = await Promise.all([
      pub.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "sweepFee", args: [token as Address] }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "sweepPivotFee", args: [token as Address] }),
    ]);
    // **The two lists can drift, and nothing on chain notices.**
    // `Payd.allowQuotes` and `Treasury.allowSweeps` are separate timelock
    // votes, and the registry holds no reference to the sweep list: a quote
    // listed on one and not the other produces vaults whose platform share
    // arrives in a currency this contract cannot convert. It does not revert —
    // it accumulates, for ever. The same shape as the ten quotes with no WETH
    // pool that `Treasury.PIVOT` exists for, one level up.
    //
    // Nothing in the contracts can detect it, so the keeper says it out loud,
    // like the L1 pricer. There are 48 hours between noticing and fixing it.
    if (direct === 0 && viaPivot === 0) {
      if (held > 0n) log(`WARNING: ${token} is a listed quote the Treasury cannot sweep, and it holds ${held}. allowSweeps is a timelock vote away`);
      continue;
    }
    // The same bar as everywhere: do not spend a swap's gas on dust. One
    // `MIN_BUY_QUOTE` is ~$25 in that token's own units, the only
    // dollar-denominated figure available here without a price feed.
    if (held < minBuyQuote) continue;
    // `minOut` 0 hands the floor to the contract, which prices it on a
    // 30-minute TWAP at `MAX_SWEEP_SLIPPAGE_BPS`. Quoting it here would tighten
    // it against the very pool the swap is about to move — the mistake
    // `ESTIMATIONS.md` §2 records on the basket path.
    await send(`sweepToEth(${token})`, () =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "sweepToEth", args: [token as Address, 0n], account, chain }));
  }

  if (after(burnPool, burnBps) >= minMove) {
    const [cooldown, lastBurn, now] = await Promise.all([
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "BURN_COOLDOWN" }),
      pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "lastBurnAt" }),
      blockNow().then((b) => b.timestamp),
    ]);
    if (now >= lastBurn + cooldown) {
      await send("buyAndBurn", () =>
        wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "buyAndBurn", account, chain }));
    }
  }

  // **The rewards pocket kept feeding a retired vault.** `FeeVault.migrate`
  // moves a vault's stream to its successor and writes `migratedTo` on the old
  // one; `fundPlatformRewards` above still pays whatever `platformVault` says,
  // so $PAYD's holders would go on being paid through a retired basket and a
  // retired Distributor — two snapshot pipelines for one token, for ever.
  //
  // `followMigration` takes no argument: the only reachable destination is the
  // one the current vault declares itself, and `migratedTo` is written only by
  // `migrate` (timelock, 48 h). Calling it is an update, not a choice.
  //
  // The read degrades the same way the contract's does: a destination that is
  // not one of our vaults answers nothing, and that is "nothing to do" rather
  // than a wall.
  const platformVault = await pub.readContract({ address: treasury, abi: treasuryAbi, functionName: "platformVault" });
  if (platformVault !== ZERO_ADDRESS) {
    const movedTo = await pub
      .readContract({ address: platformVault, abi: feeVaultAbi, functionName: "migratedTo" })
      .catch(() => ZERO_ADDRESS as Address);
    if (movedTo !== ZERO_ADDRESS) {
      await send("followMigration", () =>
        wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "followMigration", account, chain }));
    }
  }

  // **The other face of the `payPlatform` hole.** When a vault's payment to us
  // cannot go through — an ERC-20 that returns `false`, a quote token that
  // pauses — `FeeVault._pay` does not revert the harvest that was paying it:
  // the amount falls into that vault's `pendingWithdrawal` under this
  // contract's name, and `withdraw()` is callable by nobody else. It does not
  // retry and it does not complain. It sits there.
  //
  // `collectFrom` is permissionless and has no destination — the vault pays
  // `msg.sender`, which is the Treasury — so this changes no authority either.
  // Same bar and same units as `payPlatform`: the deferred amount is in the
  // vault's QUOTE, and this call is not refunded any more than that one is.
  //
  // One `Promise.all` and not a read per iteration: viem folds concurrent reads
  // into a single Multicall3, and this one runs over every vault in the
  // registry.
  const [basefee, owed] = await Promise.all([
    blockNow().then((b) => b.baseFeePerGas ?? 0n),
    Promise.all(vaults.map((v) => pub.readContract({
      address: v.vault, abi: feeVaultAbi, functionName: "pendingWithdrawal", args: [treasury],
    }))),
  ]);
  for (const [i, v] of vaults.entries()) {
    if (!payCreatorDecision(owed[i]!, v.quote, v.minBuyQuote, GAS_K_MIN * DEV_GAS * basefee)) continue;
    await send(`collectFrom(${v.vault})`, () =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "collectFrom", args: [v.vault], account, chain }));
  }
}

/**
 * One vault's round.
 *
 * `fresh` says whether the epoch has turned since the last round that got all
 * the way through this function. **It gates the steps that cannot do anything
 * new until it does**, and nothing else:
 *
 *   - the purchase covers CLOSED epochs, so `pendingEpochs` only moves on an
 *     epoch boundary. Re-pricing four legs, their pools and the first hop's TWAP
 *     every 60 s asked the chain the same question thirty times per window;
 *   - `payCreator` and `payPlatform` are "not urgent" by their own rule — each
 *     waits until its bucket is worth 20x its own gas — and a bucket only fills
 *     at a harvest;
 *   - the Pons redirect comes with THREE DAYS of notice, so one look per epoch
 *     leaves 144 chances to see it rather than 4 320.
 *
 * What stays on every tick is the money path and the retry path: `harvest`,
 * publication, deliveries, the sweep and the draw. A publication that failed on
 * IPFS or on a co-signature must be retried in 60 seconds, not in half an hour
 * — which is also why `epochSeen` is only written once this function has
 * RETURNED. A round that threw leaves the vault fresh, and the next tick redoes
 * the whole of it.
 */
async function tickVault(v: Vault, epoch: bigint, pending: bigint, fresh: boolean) {
  // `pendingEpochs` replaces the old `ran` flag: there is no per-epoch purchase
  // any more, there is a window waiting to be covered or there is not.
  await stepHarvest(v, epoch);
  // Before the purchase, so a donation is spent by the window it arrived in.
  if (fresh && pending > 0n) await stepDonations(v);
  // The portfolio mode converts to the PIVOT and stops; there is no basket to
  // buy, so `payout()` stands where `buyBasket` does.
  if (fresh && pending > 0n) {
    if (v.mode === MODE_PORTFOLIO) await stepPayout(v, epoch);
    else await stepBuyBasket(v, epoch);
  }

  // The root cycle is the DISTRIBUTION mode's. A backing vault's second
  // contract publishes nothing and pushes nothing — the token itself is the
  // claim ticket — so the only service it takes is the sweep. An unknown mode
  // gets the safe half (harvest, buy, watch) and none of the root machinery:
  // publishing against a contract that is not a Distributor is how a new
  // mode's vault would take the whole round down.
  // The tontine is the distribution mode's cycle to the letter — same
  // Distributor, same roots, same pushes. Only the RULE the root is built by
  // differs, and `buildRoot` reads that from the registry, not from here. The
  // The portfolio publishes the same roots by the same rule — its vault funds
  // ONE line, the pivot, so the tree is a plain cumulative — and converts at
  // delivery instead of transferring (`stepConvert`).
  if (v.mode === MODE_DISTRIBUTION || v.mode === MODE_TONTINE) {
    await stepPublish(v, epoch);
    await stepDistribute(v);
  } else if (v.mode === MODE_PORTFOLIO) {
    // The same root, published the same way; only the delivery transaction
    // differs, because a holder is owed PIVOT and is paid in their own stocks.
    await stepPublish(v, epoch);
    await stepConvert(v);
  } else if (v.mode === MODE_BACKING) {
    await stepSweep(v);
  } else if (v.mode === MODE_LOTTERY) {
    await stepDraw(v);
    await stepSettle(v);
  }
  if (fresh) await stepDev(v);
  if (fresh) await stepPlatform(v);
  if (fresh) await stepHook(v);
}

/**
 * **Commits the next draw's ticket set.** The lottery's answer to `stepPublish`,
 * and the differences are the mode's: the tree covers ONE window rather than
 * every window since genesis, and the root is committed for a drand round that
 * does not exist yet — which is what makes the winner unknowable at the moment
 * somebody chooses to publish.
 *
 * Deferred rather than forced when anything is missing: an unfunded window, a
 * co-signature that has not come back, a target round the contract would
 * refuse. A draw that waits a tick costs latency; a draw published wrong pays
 * `POT_BPS` of the pot to the wrong address and cannot be taken back.
 */
const DRAW_TARGET_ROUNDS = 300; // ~15 min ahead, comfortably past the contract's 200-round floor.

async function stepDraw(v: Vault) {
  // **One draw at a time, and the guard is what makes `stepSettle` correct.**
  // The contract would happily accept a second draw over a later window while
  // the first is still waiting for its beacon; the keeper would then only ever
  // relay the LAST one, and the earlier draw's winner would hold a proof
  // against a draw nobody settles. A draw waits ~15 min for its round against a
  // 30-min window, so the queue is empty by the time the next window closes —
  // and if drand really does go dark, the pot simply accumulates into the next
  // draw, which costs latency and nothing else.
  const pending = await pub.readContract({
    address: v.distributor, abi: lotteryDistributorAbi, functionName: "drawCount",
  }) as bigint;
  if (pending > 0n) {
    const last = await pub.readContract({
      address: v.distributor, abi: lotteryDistributorAbi, functionName: "draws", args: [pending],
    }) as readonly unknown[];
    if (Number(last[4]) === 1) {
      log(`draw ${pending} is published and unsettled — no new draw until its beacon lands`);
      return;
    }
  }

  const scope = await drawScope(v.distributor);
  if (!scope) return;

  let tickets: Awaited<ReturnType<typeof buildTickets>>;
  try {
    tickets = await buildTickets(v.distributor, v.vault, scope.fromEpoch, scope.upToEpoch);
  } catch (e) {
    log(`no draw for epochs ${scope.fromEpoch}-${scope.upToEpoch}:`, (e as Error).message);
    return;
  }
  log(`draw over epochs ${scope.fromEpoch}-${scope.upToEpoch}: ${tickets.tickets.length} holders, ${tickets.totalTickets} tickets`);

  // The round is read from the CONTRACT's clock, not from this machine's and
  // not from drand's. `publishDraw` checks the margin against `currentRound()`,
  // so a target computed from anything else is a target that can be refused for
  // a reason the log would not explain.
  const roundNow = Number(
    await pub.readContract({ address: v.distributor, abi: lotteryDistributorAbi, functionName: "currentRound" }),
  );
  const targetRound = roundNow + DRAW_TARGET_ROUNDS;

  // The artifact BEFORE the commitment, for `stepPublish`'s reason: a root
  // whose ticket JSON nobody can fetch is a draw nobody can prove they won.
  const res = await publishEpoch(v.distributor, scope.upToEpoch, tickets.json);
  if (!res.retrievable) {
    log(`ticket artifact not retrievable (${res.cid}), draw deferred — local copy ${res.localPath}`);
    return;
  }
  if (res.digest !== tickets.digest) {
    log(`ticket digest mismatch: built ${tickets.digest}, published ${res.digest}. Draw cancelled.`);
    return;
  }
  log(`ticket artifact published ${res.cid}`);

  const required = await pub.readContract({
    address: v.distributor, abi: lotteryDistributorAbi, functionName: "coSignerRequired",
  });
  let coSig: Hex | undefined;
  if (required) {
    coSig = await askCoSignerDraw(v, scope, tickets, targetRound);
    if (!coSig) {
      const lapsed = await pub.readContract({
        address: v.distributor, abi: lotteryDistributorAbi, functionName: "coSignatureLapsed",
        args: [BigInt(scope.upToEpoch), tickets.root, tickets.totalTickets, BigInt(targetRound), tickets.digest],
      });
      if (!lapsed) {
        await send("requestCoSignature", () => wallet.writeContract({
          address: v.distributor, abi: lotteryDistributorAbi, functionName: "requestCoSignature",
          args: [BigInt(scope.upToEpoch), tickets.root, tickets.totalTickets, BigInt(targetRound), tickets.digest],
          account, chain,
        }));
        log("  draw put on the record: if it is still unsigned in CO_SIGNER_GRACE it goes out on one key.");
        return;
      }
      // **A lapsed draw is a draw whose target round has been public for three
      // hours**, and by then that round has been drawn. Republishing on one key
      // with the SAME target would commit a root to a beacon anybody can already
      // read, so the tick starts over and the next one picks a fresh round.
      log("  the co-signature lapsed on this draw. Starting over with a target round that is still in the future.");
      return;
    }
  }

  await send("publishDraw", () =>
    coSig
      ? wallet.writeContract({
        address: v.distributor, abi: lotteryDistributorAbi, functionName: "publishDraw",
        args: [BigInt(scope.upToEpoch), tickets.root, tickets.totalTickets, BigInt(targetRound), tickets.digest, res.cid, coSig],
        account, chain,
      })
      : wallet.writeContract({
        address: v.distributor, abi: lotteryDistributorAbi, functionName: "publishDraw",
        args: [BigInt(scope.upToEpoch), tickets.root, tickets.totalTickets, BigInt(targetRound), tickets.digest, res.cid],
        account, chain,
      }));
}

/** The co-signer, asked over the draw's own shape. `/sign-draw`, not `/sign`. */
async function askCoSignerDraw(
  v: Vault,
  scope: { fromEpoch: number; upToEpoch: number },
  tickets: Awaited<ReturnType<typeof buildTickets>>,
  targetRound: number,
): Promise<Hex | undefined> {
  const url = process.env.COSIGNER_URL;
  if (!url) {
    log("  COSIGNER_URL is not set, and this vault requires a co-signature. Nothing to ask.");
    return undefined;
  }
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/sign-draw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        distributor: v.distributor, vault: v.vault,
        fromEpoch: scope.fromEpoch, upToEpoch: scope.upToEpoch,
        root: tickets.root, totalTickets: tickets.totalTickets.toString(),
        targetRound, digest: tickets.digest,
      }),
    });
    const body = (await r.json()) as { signature?: Hex; detail?: string; differs?: string[] };
    if (!r.ok || !body.signature) {
      log(`  CO-SIGNER REFUSED: ${body.detail ?? `HTTP ${r.status}`}`);
      if (body.differs?.length) log(`  diverging on: ${body.differs.join(", ")}`);
      return undefined;
    }
    return body.signature;
  } catch (e) {
    log(`  co-signer unreachable: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * **Relays the beacon that fixes the winner.** Permissionless by design — drand
 * history is permanent, so an unsettled draw blocks nothing and there is no
 * deadline — and the keeper does it only because nobody else is watching.
 *
 * It does NOT collect the prize. `collect` pays the leaf holder and not its
 * caller, so a keeper calling it would be spending gas to deliver somebody
 * else's winnings; the winner's own front end does that, and until it exists
 * the log line below is how a winner finds out.
 */
async function stepSettle(v: Vault) {
  const count = await pub.readContract({
    address: v.distributor, abi: lotteryDistributorAbi, functionName: "drawCount",
  }) as bigint;
  if (count === 0n) return;
  const d = await pub.readContract({
    address: v.distributor, abi: lotteryDistributorAbi, functionName: "draws", args: [count],
  }) as readonly unknown[];
  // Draw.status: 0 None, 1 Published, 2 Settled.
  if (Number(d[4]) !== 1) return;

  const targetRound = Number(d[2] as bigint);
  if (roundAt(Math.floor(Date.now() / 1000)) < targetRound) return; // not drawn yet

  const beacon = await fetchBeacon(targetRound);
  if (!beacon) {
    log(`draw ${count}: round ${targetRound} is due but drand has not published it yet`);
    return;
  }
  const ok = await send("settleDraw", () => wallet.writeContract({
    address: v.distributor, abi: lotteryDistributorAbi, functionName: "settleDraw",
    args: [count, beacon.point], account, chain,
  }));
  if (!ok) return;

  // Name the winner in the log. The ticket set is rebuilt rather than trusted
  // to a cached file: this is the line an operator reads when somebody asks
  // whether they won, so it has to come from the same place the contract's
  // answer does.
  try {
    const upToEpoch = Number(d[3] as bigint);
    const fromEpoch = count === 1n ? 0 : Number((await pub.readContract({
      address: v.distributor, abi: lotteryDistributorAbi, functionName: "draws", args: [count - 1n],
    }) as readonly unknown[])[3] as bigint) + 1;
    const tickets = await buildTickets(v.distributor, v.vault, fromEpoch, upToEpoch);
    const won = holderOfTicket(tickets, winningTicket(beacon.point, tickets.totalTickets));
    log(`draw ${count} settled: ticket ${winningTicket(beacon.point, tickets.totalTickets)} — WINNER ${won.holder}`);
  } catch (e) {
    log(`draw ${count} settled; the winner could not be named here: ${(e as Error).message}`);
  }
}

/**
 * Books a backing redeemer's stray ETH — the delivery budget an ETH vault's
 * harvest skims for its distributor — back into the vault's rewards pool.
 * Permissionless and idempotent; the floor just keeps a dust balance from
 * costing a transaction every round.
 */
const SWEEP_FLOOR_WEI = 2_000_000_000_000_000n; // 0.002 ether, ~5x the tx cost
async function stepSweep(v: Vault) {
  const stray = await pub.getBalance({ address: v.distributor });
  if (stray < SWEEP_FLOOR_WEI) return;
  await send("sweepToVault", () =>
    wallet.writeContract({ address: v.distributor, abi: backingRedeemerAbi, functionName: "sweepToVault", account, chain }));
}

/// Whether the fees still come to this vault.
///
/// **`token() != 0` does not answer that** — `bind` is one-shot and never
/// re-checks, which is the live state of Payd's own deployment. Noticing is the
/// only defence there is against Pons's standing power to redirect, and it
/// comes with three days of notice if we are watching.
async function stepHook(v: Vault) {
  const [status, current, effectiveAt] = await pub.readContract({
    address: v.vault, abi: feeVaultAbi, functionName: "hookStatus",
  });
  if (status === 1) return; // Hooked
  if (status === 0) return; // Unbound: nothing launched yet

  if (status === 2) {
    log(`ALERT ${v.vault}: Pons has scheduled a redirect to ${current}, effective ${effectiveAt}`);
    return;
  }
  // Lost. Put it on record once; the vault keeps paying what it holds.
  log(`ALERT ${v.vault}: the fee stream now goes to ${current}`);
  const lostAt = await pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "hookLostAt" });
  if (lostAt === 0n) {
    await send("flagHookLost", () =>
      wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "flagHookLost", account, chain }));
  }
}

/**
 * The epoch each vault's Distributor was last seen in. Purely a cost gate — see
 * `tick`.
 */
const epochSeen = new Map<Address, bigint>();

/**
 * How often the round-level watches run, and why they are not on the tick.
 *
 * `quoteAtRisk`, the Treasury and the L1 pricer all measure things that move on
 * hours or on days — a settlement bound, a bucket under `MIN_MOVE`, a chain
 * setting the operator would have to change. Reading them every 60 s was ~170
 * CU a round, 1 440 rounds a day, to watch numbers that could not have moved.
 *
 * `stepGas` deliberately stays on the tick: it is the one failure nothing else
 * can see (a keeper out of gas keeps looping and looking alive), its runway is
 * expressed IN TICKS, and `GAS_CRITICAL_TICKS` is tuned against this cadence.
 * Moving it would be changing an alarm's units to save 19 CU.
 */
const SLOW_MS = 30 * 60_000;
/** The L1 alert repeats every `L1_WARN_EVERY_TICKS`, and that constant means
 *  minutes. A slow pass counts for the minutes it skipped, so "about an hour
 *  between repeats" survives the cadence change. */
const SLOW_TICKS = SLOW_MS / 60_000;
let slowAt = 0;

export async function tick() {
  roundBlock = null;
  const vaults = await registry();
  log(`registry: ${vaults.length} vault(s)`);

  // **The whole registry's clock in one request**, and read here rather than
  // inside `tickVault` so the round can decide what is worth doing before doing
  // any of it. Through Multicall3 these 2N reads leave as a single `eth_call`.
  const clocks = await Promise.all(vaults.map(async (v) => Promise.all([
    pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "currentEpoch" }),
    pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "pendingEpochs" }),
  ])));

  // **The `Transfer` walk follows the EPOCH, not the tick.** It used to run
  // every 60 s over a range that only widens — the checkpoints it starts from
  // advance when a root is published, i.e. at most once per 30-minute epoch — so
  // 29 walks out of 30 were built and thrown away. `eth_getLogs` is the most
  // expensive method on every provider's pricing, and this was the keeper's
  // whole consumption of it.
  //
  // Gating it is safe by construction rather than by care: `prefetched()` only
  // returns the store when it actually covers the range asked for, so a vault
  // the store does not cover scans for itself exactly as before. The gate can
  // only cost a walk, never a wrong root.
  const fresh = vaults.map((v, i) => epochSeen.get(v.vault) !== clocks[i]![0]);
  const moved = vaults.filter((v, i) => fresh[i] && v.token !== ZERO_ADDRESS);
  if (moved.length > 0) {
    const pre = await prefetchTransfers(moved.map((v) => v.token));
    if (pre) log(`transfers prefetched for ${pre.tokens} token(s): blocks ${pre.from}-${pre.to}, ${pre.logs} logs in ${pre.requests} request(s)`);
  }

  const slow = Date.now() - slowAt >= SLOW_MS;
  let atRisk = 0n;
  for (const [i, v] of vaults.entries()) {
    try {
      await tickVault(v, clocks[i]![0], clocks[i]![1], fresh[i]!);
      // **Written only once the round got through.** A vault that threw stays
      // fresh, so the next tick redoes the epoch-gated half instead of waiting
      // out the window — the retry cadence of a failed purchase or a failed
      // publication is unchanged at 60 s.
      epochSeen.set(v.vault, clocks[i]![0]);
      if (slow) {
        atRisk += await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "quoteAtRisk" });
      }
    } catch (e) {
      // One vault must never stop the round: a paused stock or a dry pool on
      // one token is not a reason to leave every other holder unpaid.
      log(`vault ${v.vault} failed:`, (e as Error).message);
    }
  }
  if (slow) {
    // The figure that bounds what a compromised keeper key could misdirect,
    // summed across every vault it publishes for.
    log(`quoteAtRisk across the registry: ${atRisk}`);

    // The platform's own money, once for the whole round and not per vault: the
    // Treasury is one contract for the life of the protocol. In its own `try`,
    // because a Treasury that cannot move — a dry pool under the burn, a
    // liquidity position that will not take — must never stop the vaults from
    // paying their holders.
    try {
      const treasury = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "PLATFORM" });
      await stepTreasury(treasury as Address, vaults);
    } catch (e) {
      log("treasury failed:", (e as Error).message);
    }
    slowAt = Date.now();
  }

  // Last, and once for the whole round: a warning must never delay the money.
  await stepGas();
  if (slow) await stepL1Pricer();

  // What the round actually cost, in the unit Alchemy invoices in. Last of all,
  // so it counts everything above it.
  log(meterRound());
}

async function main() {
  log("keeper started, account", account.address);
  log("WARNING: this wallet must hold nothing but gas");
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log("tick failed:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

// Only when RUN, not when imported — the same guard `cosign.ts` has, and for
// the same reason: `rpcbudget.test.ts` loads `registry` to count what a round
// asks the node for.
if (process.argv[1]?.endsWith("keeper.ts")) main();
