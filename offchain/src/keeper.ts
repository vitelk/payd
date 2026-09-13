/**
 * keeper.ts — runs the cycle.
 *
 * **Only one of these actions is reserved to it.** `publishRoot` is keeper-only;
 * everything else — harvest, buyBasket, distribute, creator — is
 * callable by anyone; all of them refund their own gas except `payCreator`, where
 * whoever calls it pays. If the keeper stops, anyone can keep the cycle turning,
 * and if nobody does, epochs simply carry over (docs/ARCHITECTURE.md §S29).
 *
 * Each step is **idempotent**: it looks at on-chain state and does nothing if
 * the work is already done. The keeper can therefore restart at any moment with
 * no memory, and two keepers running in parallel do not trip over each other —
 * at worst one wastes gas on a reverting transaction.
 *
 *   RPC_URL, KEEPER_PRIVATE_KEY, v.distributor, v.vault in the environment.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL, CHAIN_ID, PONS_V2_ESCROW, ARB_GAS_INFO, V3_FACTORY } from "./config.js";
import { distributorAbi, feeVaultAbi, escrowAbi, quoterAbi, arbGasInfoAbi , registryAbi, treasuryAbi, erc20Abi, v3FactoryAbi, v3PoolAbi } from "./abis.js";
import { buyDecision, payCreatorDecision, maxSpendForDepth, slotsForWindow, BUY_BASKET_GAS } from "./buy.js";
import { buildCumulative, canonicalJson, l1PricerAlert, gasRunwayAlert, GAS_CRITICAL_TICKS, type CumulativeArtifact } from "./epoch.js";
import { publishEpoch, pruneArtifacts } from "./publish.js";
import { preflight } from "./preflight.js";
import { prefetchTransfers } from "./snapshot.js";
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
}

/** Every vault the Payd has made, oldest first. */
async function registry(): Promise<Vault[]> {
  const vaults = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "vaults" });
  return Promise.all(
    (vaults as readonly Address[]).map(async (vault) => {
      const [distributor, token, quote, minBuyQuote] = await Promise.all([
        pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "DISTRIBUTOR" }),
        pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }),
        pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "QUOTE" }),
        pub.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
      ]);
      // `buildCumulative` reads the last two for itself, so `dispute.ts`
      // derives the same floors from the chain alone. They are read again here
      // for what only the keeper can know: which currencies the Treasury may be
      // holding, and the bar under which sweeping one is not worth its gas.
      return {
        vault, distributor: distributor as Address, token: token as Address,
        quote: quote as Address, minBuyQuote: minBuyQuote as bigint,
      };
    }),
  );
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

const chain = { id: CHAIN_ID, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } } as const;
const account = privateKeyToAccount(requireEnv("KEEPER_PRIVATE_KEY") as Hex);
const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 5, retryDelay: 500 }) });
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

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
    log(`${fn} skipped:`, String((e as Error).message).split("\n")[0]?.slice(0, 120));
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
 * **Tied to the window, not to a timer.** We top up when there is a window to
 * cover and stop when there is none — `pendingEpochs()` says so on-chain, so a
 * keeper restarting mid-window does not harvest a second time. The in-memory
 * flag covers the other case: a window whose pool has not reached `MIN_BUY`,
 * where nothing on-chain would stop us from harvesting every minute. Losing it
 * on a restart costs one extra harvest, nothing more — and it is per VAULT,
 * because two vaults share a tick but not an epoch counter.
 */
/// Per VAULT, not global: two vaults share a tick but not an epoch counter.
const harvestedEpoch = new Map<string, bigint>();

async function stepHarvest(v: Vault, epoch: bigint, pending: bigint) {
  // Nothing to buy means nothing to top up for.
  if (pending === 0n || harvestedEpoch.get(v.vault) === epoch) return;
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
async function legDepthPivot(stock: Address, poolFee: number): Promise<bigint | undefined> {
  try {
    const pool = await pub.readContract({
      address: V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [USDG as Address, stock, poolFee],
    });
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
async function ensureFirstHopWindow(v: Vault, quote: Address): Promise<boolean> {
  // A pivot-quoted vault has no first hop at all: `_toPivot` returns what it
  // was given.
  if (quote.toLowerCase() === USDG.toLowerCase()) return true;
  try {
    const [quoteFee, quoteWethFee, ethPivotFee, window] = await Promise.all([
      pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "QUOTE_FEE" }),
      pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "QUOTE_WETH_FEE" }),
      pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "ETH_PIVOT_FEE" }),
      pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "TWAP_WINDOW" }),
    ]);

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
      const pool = await pub.readContract({
        address: V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [tokenIn, against, fee],
      });
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
  const [pool, payoutBps, maxRefund, minBuyQuote, allocs, nextEpoch, quote] = await Promise.all([
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "rewardsPool" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "payoutBps" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "MAX_REFUND" }),
    // **`MIN_BUY_QUOTE`, not `MIN_BUY`.** The second is the wei constant
    // (0.01 ether) and the first is what the contract actually spends against
    // — the same number in the vault's own currency. Reading the constant made
    // every comparison below wei-against-QUOTE on a non-ether vault, and the
    // keeper skipped all of them silently, for ever.
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "getAllocations" }),
    pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "nextEpoch" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "QUOTE" }),
  ]);
  // Nothing to cover: every closed epoch already belongs to a purchase.
  if (epoch === 0n || epoch - 1n < nextEpoch) return;

  // Every threshold lives in `buy.ts`, as a pure function, because this was
  // wrong in three places at once and a fork test is a poor place to find that.
  // Before anything else: a first hop that cannot be priced reverts the WHOLE
  // purchase, not one leg (T-HYP-02).
  if (!(await ensureFirstHopWindow(v, quote as Address))) return;

  const basefee = (await pub.getBlock()).baseFeePerGas ?? 0n;
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
async function stepPublish(v: Vault, current: bigint) {
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
    if (upTo <= covered) return; // nothing new to cover
    // Wait until enough epochs have piled up to be worth a publication. Never
    // starves: `upTo` advances with the clock, so the gap always closes.
    // The FIRST root is exempt — a chain with nothing claimable yet should not
    // stay that way for N epochs.
    if (upTo - covered < BigInt(ROOT_INTERVAL_EPOCHS)) {
      log(`root deferred: ${upTo - covered}/${ROOT_INTERVAL_EPOCHS} epochs since the last one`);
      return;
    }
  }

  // An epoch range with nothing funded in it is a normal early-life state, not
  // an error: `buyBasket` may not have bought yet, or every holder may be below
  // the eligibility floor. `buildCumulative` throws on it, and letting that
  // escape aborted the whole tick — so `distribute` and `payDev`
  // never ran either, and the keeper looked alive while doing nothing.
  let built: Awaited<ReturnType<typeof buildCumulative>>;
  try {
    built = await buildCumulative(v.distributor, v.vault, Number(upTo));
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

async function stepDistribute(v: Vault) {
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
  if (since < PUSH_INTERVAL_MS) return;

  const activeRoot = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "activeRoot" });
  if (activeRoot === 0n) return;
  const r = await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "roots", args: [activeRoot] });

  const built = await buildCumulative(v.distributor, v.vault, Number(r[4]));

  const perHolder = new Map<Address, { stocks: Address[]; cumulative: bigint[]; proofs: Hex[][] }>();
  for (const e of built.entries) {
    if (!built.pushKeys.has(`${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`)) continue;
    const cur = perHolder.get(e.holder) ?? { stocks: [], cumulative: [], proofs: [] };
    cur.stocks.push(e.stock);
    cur.cumulative.push(e.cumulative);
    cur.proofs.push(built.proofFor(e.holder, e.stock, "push") as Hex[]);
    perHolder.set(e.holder, cur);
  }

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
  const [dev, block, quote, minBuyQuote] = await Promise.all([
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "creatorPool" }),
    pub.getBlock(),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "QUOTE" }),
    pub.readContract({ address: v.vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
  ]);
  const basefee = block.baseFeePerGas ?? 0n;
  // `creatorPool` is in QUOTE and the gas bar is in wei. See `payCreatorDecision`.
  if (payCreatorDecision(dev, quote as Address, minBuyQuote as bigint, GAS_K_MIN * DEV_GAS * basefee)) {
    await send("payCreator", () => wallet.writeContract({ address: v.vault, abi: feeVaultAbi, functionName: "payCreator", account, chain }));
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
      ++l1TicksSinceWarn;
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
  // A migrated Treasury moves nothing: `payDev` and the rest revert
  // `AlreadyMigrated`, and `pushAll` is the only thing left to call.
  if (migrated !== ZERO_ADDRESS) return;

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
  // The token list is not read from the sweep mapping, which is not
  // enumerable: it is DERIVED from the registry, because the only currencies
  // that can reach this contract are the quotes of the vaults it serves.
  const quotes = new Map<string, bigint>();
  for (const v of vaults) {
    if (v.quote === ZERO_ADDRESS || quotes.has(v.quote)) continue;
    quotes.set(v.quote, v.minBuyQuote);
  }
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
      pub.getBlock().then((b) => b.timestamp),
    ]);
    if (now >= lastBurn + cooldown) {
      await send("buyAndBurn", () =>
        wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "buyAndBurn", account, chain }));
    }
  }
}

async function tickVault(v: Vault) {
  const [epoch, pending] = await Promise.all([
    pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "currentEpoch" }),
    pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "pendingEpochs" }),
  ]);

  // `pendingEpochs` replaces the old `ran` flag: there is no per-epoch purchase
  // any more, there is a window waiting to be covered or there is not.
  await stepHarvest(v, epoch, pending);
  // Before the purchase, so a donation is spent by the window it arrived in.
  if (pending > 0n) await stepDonations(v);
  if (pending > 0n) await stepBuyBasket(v, epoch);

  await stepPublish(v, epoch);
  await stepDistribute(v);
  await stepDev(v);
  await stepHook(v);
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

async function tick() {
  const vaults = await registry();
  log(`registry: ${vaults.length} vault(s)`);

  // One `Transfer` walk for the whole round instead of one per vault. What the
  // snapshots do with it is unchanged — a vault the store does not cover simply
  // scans for itself (see `prefetchTransfers`).
  const pre = await prefetchTransfers(vaults.map((v) => v.token).filter((t) => t !== ZERO_ADDRESS));
  if (pre) log(`transfers prefetched for ${pre.tokens} token(s): blocks ${pre.from}-${pre.to}, ${pre.logs} logs in ${pre.requests} request(s)`);

  let atRisk = 0n;
  for (const v of vaults) {
    try {
      await tickVault(v);
      atRisk += await pub.readContract({ address: v.distributor, abi: distributorAbi, functionName: "quoteAtRisk" });
    } catch (e) {
      // One vault must never stop the round: a paused stock or a dry pool on
      // one token is not a reason to leave every other holder unpaid.
      log(`vault ${v.vault} failed:`, (e as Error).message);
    }
  }
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

  // Last, and once for the whole round: a warning must never delay the money.
  await stepGas();
  await stepL1Pricer();
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

main();
