/**
 * snapshot.ts — computes a purchase window's shares, deterministically.
 *
 * The property we are after: two machines running this script on the same window
 * must produce exactly the same root, without coordinating and without trusting
 * anyone. So everything that could diverge is read ON-CHAIN, never passed as an
 * argument:
 *
 *   - the epoch bounds        -> Distributor.epochEnd(epoch), EPOCH_LENGTH
 *   - the exclusion list      -> Distributor.exclusionLog(), REPLAYED per window
 *   - the token and its curve -> PonsV2LaunchFactory.getLaunchedToken()
 *
 * The only parameters are the window's bounds and what it spent, both of
 * which come from the `WindowFunded` log.
 *
 * Method: replaying `Transfer` events since the launch block. The public RPC is
 * not an archive node (docs/ARCHITECTURE.md §S13), so reading `balanceOf` at a
 * past block is impossible; logs, on the other hand, are served over the whole
 * history.
 */
import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  keccak256,
  encodeAbiParameters,
  decodeAbiParameters,
  type Address,
} from "viem";
import { CHAIN_ID, RPC_URL, PONS_V2_FACTORY, POOL_MANAGER, START_BALANCE } from "./config.js";
import { scanLogs, type RawLog } from "./logs.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { applyFloor } from "./eligibility.js";

const CACHE_DIR = process.env.EPOCH_DIR ?? "data";

const client = createPublicClient({
  transport: http(RPC_URL, { batch: true, retryCount: 5, retryDelay: 400 }),
});

const distributorAbi = parseAbi([
  "function epochEnd(uint256) view returns (uint256)",
  "function EPOCH_LENGTH() view returns (uint256)",
  "function GENESIS() view returns (uint256)",
  "function excludedList() view returns (address[])",
  "function exclusionLog() view returns ((address account, bool state, uint48 fromEpoch)[])",
  "function isExcluded(address) view returns (bool)",
]);

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Where a burn goes. A standard ERC-20 refuses a transfer to `address(0)`, so
 * burning on this chain means sending to `0xdead`. A burnt balance left in the
 * snapshot would draw a share of every distribution for ever, and pay it to
 * nobody — which is not a burn, it is a permanent tax on the holders who
 * stayed.
 */
const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;

/**
 * The addresses that hold the token without ever being holders.
 *
 * **Structural**, and that word is the whole distinction: every entry here is
 * either derived from the launch itself or fixed by how the chain works, so
 * none of them is a choice. The discretionary list — CEXs, custodial contracts
 * — is the timelock's (`Distributor.setExcluded`) and is added on top of this
 * set by `snapshot`, with 48 h of notice. Putting a structural address through
 * that door would mean two days during which the snapshot is knowingly wrong.
 *
 * `POOL_MANAGER` is the one that was missing until 2026-09-10, and it is the
 * expensive one. Uniswap v4 is a **singleton**: after graduation the whole
 * pool's token balance sits on the PoolManager, so left in the tree it becomes
 * the largest holder of every graduated token and takes the largest share of
 * every distribution — from the holders, to a contract that cannot claim.
 * `CLAUDE.md` had promised it was excluded since the beginning; only the four
 * others actually were.
 */
export function structuralExclusions(l: {
  token: Address;
  curve: Address;
  distributor: Address;
  creatorFeeRecipient: Address;
}): Set<Address> {
  return new Set<Address>([
    ZERO,
    getAddress(DEAD) as Address,
    getAddress(POOL_MANAGER) as Address,
    getAddress(l.token) as Address,
    getAddress(l.curve) as Address,
    getAddress(l.distributor) as Address,
    getAddress(l.creatorFeeRecipient) as Address,
  ]);
}

export interface SnapshotResult {
  /** The window this covers, inclusive on both ends. */
  fromEpoch: number;
  toEpoch: number;
  /** The period the average covers, half-open: `[periodStart, periodEnd)`. */
  periodStart: number;
  periodEnd: number;
  /** Blocks inside the period that carried a `Transfer`. Reported, not chosen. */
  transferBlocks: number;
  /** Time-weighted average balance over the period, in raw units. */
  balances: Record<Address, bigint>;
  /** Sum of the kept balances — the denominator of every share. */
  eligibleSupply: bigint;
  excluded: Address[];
  /** ETH the window's purchase spent. The numerator of every share. */
  quoteSpent: bigint;
  /** Cumulative ETH over epochs 0..epoch. THIS is what sets the threshold. */
  quoteCumulative: bigint;
  /** Minimum balance kept for this epoch, in raw units. */
  minBalance: bigint;
  /** Number of holders dropped because their share was worth nothing. */
  dusted: number;
}

/**
 * Block timestamps, batched and memoised.
 *
 * A block's timestamp never changes, so the cache is a pure optimisation: a
 * cold process computes exactly the same numbers, only slower. That matters —
 * `dispute.ts` must reach the same result from the chain alone, with no state
 * inherited from us.
 *
 * The RPC returns a `blockTimestamp` field on every log, and it CANNOT be used:
 * measured 2026-09-08, 2,441 of 2,537 logs carried `0x0`, the field being
 * populated only for the last ~100 blocks. The non-zero ones were exact, which
 * is precisely what makes it dangerous — trusting it would silently truncate
 * the weighting of everything older.
 */
const tsCache = new Map<number, number>();

export async function blockTimestamps(blocks: number[]): Promise<Map<number, number>> {
  const missing = [...new Set(blocks)].filter((b) => !tsCache.has(b));
  // ponytail: chunks of 20 against a public RPC that 429s past ~40 concurrent
  // reads. Raise it behind a dedicated endpoint.
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const got = await Promise.all(
      chunk.map((n) => client.getBlock({ blockNumber: BigInt(n), includeTransactions: false })),
    );
    chunk.forEach((n, k) => tsCache.set(n, Number(got[k]!.timestamp)));
  }
  return new Map(blocks.map((b) => [b, tsCache.get(b)!]));
}

/**
 * Opening-balance checkpoints.
 *
 * The balances at the start of the period are the expensive half of a snapshot:
 * the node is not an archive node, so the only way to get them is to replay
 * every `Transfer` since the launch. Paying that on every publication makes a
 * snapshot cost grow with the AGE of the token — 48 replays a day, each longer
 * than the last, for every vault in the registry. One year-old token starves
 * the keeper long before a hundred young ones do.
 *
 * So the balances at `firstBlock - 1` are written to disk and used as the next
 * scan's starting point, which takes the age out of the cost entirely.
 *
 * **A cache, never a source.** It lives in `CACHE_DIR`, i.e. `EPOCH_DIR` — the
 * directory `preflight.ts` points at an EMPTY path for the counter-computation,
 * and which a third party running `dispute.ts` has never had. Both therefore
 * replay from `launchBlock`, so every root we publish is checked against a
 * checkpoint-free recomputation on a second node before it goes out. If a
 * checkpoint were ever wrong, the publication is what would catch it.
 */
interface Checkpoint {
  block: number;
  balances: Map<Address, bigint>;
}

const checkpointPath = (token: Address) => `${CACHE_DIR}/balances-${token.toLowerCase()}.json`;

/** The block a token's checkpoint stands at, or `null` if there is none. */
function checkpointBlock(token: Address): number | null {
  const path = checkpointPath(token);
  if (!existsSync(path)) return null;
  return Number(JSON.parse(readFileSync(path, "utf8")).block);
}

/**
 * The checkpoint usable for a period starting at `before`.
 *
 * It has to stand STRICTLY BEHIND it. Recomputing an older window against a
 * checkpoint written for a later one would count the transfers in between
 * twice — silently, and in the direction that pays the wrong people.
 */
export function loadCheckpoint(token: Address, before: number): Checkpoint | null {
  const at = checkpointBlock(token);
  if (at === null || at >= before) return null;
  const raw = JSON.parse(readFileSync(checkpointPath(token), "utf8")) as {
    block: number;
    balances: [Address, string][];
  };
  return { block: raw.block, balances: new Map(raw.balances.map(([a, v]) => [a, BigInt(v)])) };
}

/**
 * Zero balances are dropped: they weigh nothing and would otherwise make the
 * file grow with every address the token ever touched. Never moves BACKWARD —
 * recomputing an old window must not undo the progress of a newer one.
 */
export function saveCheckpoint(token: Address, block: number, balances: Map<Address, bigint>): void {
  const at = checkpointBlock(token);
  if (at !== null && at >= block) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  const kept = [...balances].filter(([, v]) => v !== 0n).map(([a, v]) => [a, v.toString()]);
  writeFileSync(checkpointPath(token), JSON.stringify({ token, block, balances: kept }));
}

/**
 * `Transfer` logs fetched for several tokens at once, keyed by token.
 *
 * The second cost that grows with the registry: once checkpoints have removed
 * the token's age from the equation, what is left is one paged `eth_getLogs`
 * walk PER VAULT over very nearly the same range — the pages are the budget
 * here, not the CPU. `eth_getLogs` takes a list of addresses, so N walks
 * collapse into one.
 */
const transferStore = new Map<Address, { from: number; to: number; logs: RawLog[] }>();

/**
 * Fetch every token's `Transfer` logs in a single paged walk, for the round
 * that follows. Call once per keeper tick, before touching any vault.
 *
 * Only tokens that ALREADY have a checkpoint take part. One without would drag
 * the shared range back to its launch block and make every other token pay for
 * its cold start; it does its own scan once, and joins the next round.
 *
 * Returns `null` when there is nothing to share — the caller carries on
 * unchanged, since a missing store only means each snapshot scans for itself.
 */
export async function prefetchTransfers(
  tokens: Address[],
): Promise<{ tokens: number; from: number; to: number; requests: number; logs: number } | null> {
  const warm = [...new Set(tokens.map((t) => getAddress(t) as Address))]
    .map((token) => ({ token, at: checkpointBlock(token) }))
    .filter((x): x is { token: Address; at: number } => x.at !== null);
  // One shared walk over one token is the very walk it would have done alone.
  if (warm.length < 2) return null;

  const from = Math.min(...warm.map((x) => x.at)) + 1;
  const to = Number(await client.getBlockNumber());
  if (from > to) return null;

  const buckets = new Map<Address, RawLog[]>(warm.map((x) => [x.token, []]));
  const { requests, logs } = await scanLogs(
    client,
    { address: warm.map((x) => x.token), fromBlock: from, toBlock: to, topics: [TRANSFER_TOPIC] },
    (page) => {
      // Pages arrive in chain order and are appended in order, which is what
      // `weighBalances` replays. A log from a token we did not ask for cannot
      // happen, but an unknown bucket is dropped rather than created.
      for (const l of page) buckets.get(getAddress(l.address) as Address)?.push(l);
    },
  );
  for (const [token, ls] of buckets) transferStore.set(token, { from, to, logs: ls });
  return { tokens: warm.length, from, to, requests, logs };
}

/** The prefetched logs, but only if they actually cover the range asked for. */
function prefetched(token: Address, from: number, to: number): RawLog[] | null {
  const s = transferStore.get(getAddress(token) as Address);
  return s && s.from <= from && s.to >= to ? s.logs : null;
}

/**
 * Time-weighted balances over `[startTs, endTs)`, in raw units × seconds.
 *
 * Replays every `Transfer` from the launch to the end of the period. Transfers
 * before `startTs` only set the opening balance; from there on, each account
 * accrues `balance × elapsed` for as long as it holds.
 *
 * **Lazy accrual**: an account is settled only when it is touched, and everyone
 * is settled once at `endTs`. The cost is therefore O(transfers + holders), not
 * O(blocks × holders) — which for a 30-minute epoch on a 100 ms chain is the
 * difference between thousands of passes and one.
 *
 * Why time rather than blocks: block production on this chain is on demand, so
 * weighting by block count would over-weight busy stretches — and anyone can
 * make a stretch busy. Seconds cannot be manufactured.
 */
async function integrateBalances(
  token: Address,
  launchBlock: number,
  firstBlock: number,
  lastBlock: number,
  startTs: number,
  endTs: number,
): Promise<{ weighted: Map<Address, bigint>; transferBlocks: number }> {
  // The replay starts at the checkpoint when there is one usable, at the launch
  // block otherwise. Either way what comes out of the loop is the same thing:
  // the balances as of `firstBlock`, and the period's transfers.
  const checkpoint = loadCheckpoint(token, firstBlock);
  const scanFrom = checkpoint ? checkpoint.block + 1 : launchBlock;
  const bal = new Map<Address, bigint>(checkpoint?.balances);
  const inPeriod: { block: number; from: Address; to: Address; value: bigint }[] = [];

  const collect = (logs: RawLog[]) => foldTransfers(logs, { bal, inPeriod, scanFrom, firstBlock, lastBlock });

  // The `Transfer` topic is fixed by ERC-20: we depend on no ABI of a token we
  // do not control. The range splitting is adaptive (see logs.ts) and never
  // influences the result.
  const shared = prefetched(token, scanFrom, lastBlock);
  if (shared) collect(shared);
  else await scanLogs(client, { address: token, fromBlock: scanFrom, toBlock: lastBlock, topics: [TRANSFER_TOPIC] }, collect);

  // `bal` now holds exactly the state at the period's boundary, which is the
  // one quantity the next window would otherwise pay the whole history for.
  saveCheckpoint(token, firstBlock - 1, bal);

  const stamps = await blockTimestamps(inPeriod.map((t) => t.block));

  const weighted = weighBalances({
    opening: bal,
    transfers: inPeriod.map((t) => ({
      // A timestamp is clamped into the period: `firstBlock` is the first block
      // at or after `startTs`, but `lastBlock` can only be found by timestamp
      // too, and a boundary block belongs to exactly one epoch.
      at: Math.min(Math.max(stamps.get(t.block)!, startTs), endTs),
      from: t.from,
      to: t.to,
      value: t.value,
    })),
    startTs,
    endTs,
  });

  const transferBlocks = new Set(inPeriod.map((t) => t.block)).size;
  return { weighted, transferBlocks };
}

export interface Fold {
  /** Balances as of `firstBlock`. Seeded from a checkpoint, or empty. */
  bal: Map<Address, bigint>;
  /** Transfers inside the period, appended in chain order. */
  inPeriod: { block: number; from: Address; to: Address; value: bigint }[];
  /** First block not already folded into `bal`. */
  scanFrom: number;
  firstBlock: number;
  lastBlock: number;
}

/**
 * The `Transfer` fold itself, with no RPC in sight: pages in, `bal` and
 * `inPeriod` mutated in place.
 *
 * Pure on purpose, and for one reason. A page can now come from the SHARED
 * store, which spans the widest range the round needed rather than this
 * token's — so the two bounds below are the difference between the right
 * balances and a history counted twice. Own scans never trip them; the store
 * does, every round.
 */
export function foldTransfers(logs: readonly RawLog[], f: Fold): void {
  for (const log of logs) {
    const blockNumber = Number(log.blockNumber);
    if (blockNumber < f.scanFrom || blockNumber > f.lastBlock) continue;
    const from = getAddress("0x" + log.topics[1]!.slice(26)) as Address;
    const to = getAddress("0x" + log.topics[2]!.slice(26)) as Address;
    const value = BigInt(log.data);
    if (blockNumber < f.firstBlock) {
      // Before the period: opening balance only, no weight earned.
      if (from !== ZERO) f.bal.set(from, (f.bal.get(from) ?? 0n) - value);
      if (to !== ZERO) f.bal.set(to, (f.bal.get(to) ?? 0n) + value);
    } else {
      f.inPeriod.push({ block: blockNumber, from, to, value });
    }
  }
}

export interface WeighInput {
  /** Balances at `startTs`, from every transfer that happened before it. */
  opening: Map<Address, bigint>;
  /** Transfers inside the period, in chain order, each already timestamped. */
  transfers: { at: number; from: Address; to: Address; value: bigint }[];
  startTs: number;
  endTs: number;
}

/**
 * The weighting itself, with no RPC in sight: `balance × seconds` per holder.
 *
 * Pure on purpose. It is the one piece a third party has to reimplement to
 * check a root, so it is the one piece that has to be testable without a chain
 * — see `determinism.test.ts`.
 *
 * **Lazy accrual**: an account is settled only when a transfer touches it, and
 * everyone is settled once at `endTs`. O(transfers + holders) rather than
 * O(blocks × holders).
 */
export function weighBalances({ opening, transfers, startTs, endTs }: WeighInput): Map<Address, bigint> {
  const bal = new Map(opening);
  const acc = new Map<Address, bigint>();
  const since = new Map<Address, number>();

  const touch = (a: Address, at: number) => {
    if (a === ZERO) return;
    const b = bal.get(a) ?? 0n;
    const from = since.get(a) ?? startTs;
    // Two transfers can share a timestamp — blocks are cheap on this chain.
    // The product is then zero, which is right: no time passed.
    if (b > 0n && at > from) acc.set(a, (acc.get(a) ?? 0n) + b * BigInt(at - from));
    since.set(a, at);
  };

  for (const t of transfers) {
    touch(t.from, t.at);
    touch(t.to, t.at);
    if (t.from !== ZERO) bal.set(t.from, (bal.get(t.from) ?? 0n) - t.value);
    if (t.to !== ZERO) bal.set(t.to, (bal.get(t.to) ?? 0n) + t.value);
  }
  // Everyone still holding at the end earns up to the boundary.
  for (const a of bal.keys()) touch(a, endTs);

  for (const [a, w] of acc) if (w === 0n) acc.delete(a);
  return acc;
}

/**
 * Time-weighted balances over the epochs `[fromEpoch, toEpoch]`, and who is
 * eligible for that window's purchase.
 *
 * **A window, not an epoch** (`PLAN.md` D8). One purchase buys the whole
 * basket, so there is one snapshot per purchase and every holder of the window
 * is paid in every stock — not in whichever one the rotation happened to land
 * on while they held.
 */
export async function snapshot(
  distributor: Address,
  token: Address,
  fromEpoch: number,
  toEpoch: number,
  windowQuote: bigint,
  /** `minShareFor(QUOTE, MIN_BUY_QUOTE)` — the floor in the vault's own units,
   *  handed in by `buildCumulative` rather than read here, so there is one
   *  place a verifier has to agree with. */
  minShare: bigint,
): Promise<SnapshotResult> {
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`wrong chain: ${chainId}`);

  const [windowEnd, epochLength] = await Promise.all([
    client.readContract({ address: distributor, abi: distributorAbi, functionName: "epochEnd", args: [BigInt(toEpoch)] }),
    client.readContract({ address: distributor, abi: distributorAbi, functionName: "EPOCH_LENGTH" }),
  ]);
  // No seed to read: the period runs from the start of `fromEpoch` to the end
  // of `toEpoch`, which is two immutables and arithmetic. Nobody chooses it, so
  // nothing has to be committed on-chain to prove nobody chose it.
  const periodEnd = Number(windowEnd);
  const periodStart = periodEnd - Number(epochLength) * (toEpoch - fromEpoch + 1);

  const launched = await client.readContract({
    address: PONS_V2_FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [token],
  });
  if (!launched.exists) throw new Error("token unknown to the Pons v2 factory");

  const { firstBlock, lastBlock, launchBlock } = await resolveEpochBlocks(
    token, periodEnd, periodEnd - periodStart,
  );

  const { weighted, transferBlocks } = await integrateBalances(
    token, launchBlock, firstBlock, lastBlock, periodStart, periodEnd,
  );

  // Exclusions: the structural ones are derived from the chain, the
  // discretionary list comes from the timelock. Neither is a script parameter.
  const excluded = structuralExclusions({
    token,
    curve: launched.curve as Address,
    distributor,
    creatorFeeRecipient: launched.creatorFeeRecipient as Address,
  });
  for (const a of await excludedAt(distributor, toEpoch)) excluded.add(a);

  // Candidates: everything that is neither a technical address nor rounding
  // dust. THIS sum is what the threshold is computed against.
  //
  // The weight carried here is `balance × seconds`; dividing by the period
  // gives back an average balance in raw units, which is what every downstream
  // rule is written against. Integer division once, at the very end: rounding
  // earlier would make two honest implementations diverge.
  const period = BigInt(periodEnd - periodStart);
  const candidates = new Map<Address, bigint>();
  let candidateSupply = 0n;
  for (const [holder, w] of weighted) {
    if (excluded.has(holder)) continue;
    const avg = w / period;
    if (avg === 0n) continue;
    candidates.set(holder, avg);
    candidateSupply += avg;
  }

  // Eligibility threshold (docs/ARCHITECTURE.md §S14).
  //
  //     share(holder) = balance / candidateSupply * quoteSpent >= minShare
  // <=> balance >= minShare * candidateSupply / quoteSpent
  //
  // `minShare` and not `MIN_SHARE_WEI`: the constant is in wei and `quoteSpent`
  // is in the vault's own currency. On a USDG vault the wei figure made the
  // condition `balance >= 200,000 x supply` — nobody eligible, an empty tree,
  // nothing distributed at all.
  //
  // Computed in ONE SINGLE PASS, against the sum of candidates before filtering.
  // Iterating to a fixed point would be tempting — dropping holders lowers the
  // sum, which lowers the threshold, which lets some back in — but it
  // oscillates. A single pass is deterministic, slightly conservative, and
  // trivial for a verifier to replay.
  // The ETH the purchase actually spent, handed in from the `WindowFunded` log
  // rather than read back: the window is the unit now, and the log is what a
  // verifier replays anyway.
  const quoteSpent = windowQuote;
  if (quoteSpent === 0n) throw new Error(`window ${fromEpoch}-${toEpoch}: no ETH spent`);

  // The threshold is computed against the CUMULATIVE figure, not this epoch's —
  // otherwise it depends on the epoch length and a small holder stays excluded
  // forever instead of merely being deferred (§S14).
  const quoteCumulative = await ethCumulativeUpTo(distributor, toEpoch);
  const { balances, eligibleSupply, minBalance, dusted } =
    applyFloor(candidates, quoteCumulative, minShare, START_BALANCE);
  if (eligibleSupply === 0n) throw new Error("no holder above the threshold");

  return {
    fromEpoch, toEpoch, periodStart, periodEnd, transferBlocks, balances, eligibleSupply,
    excluded: [...excluded].sort(), quoteSpent, quoteCumulative, minBalance, dusted,
  };
}

/**
 * The discretionary exclusion set in force at `epoch`, rebuilt by replaying the
 * on-chain log.
 *
 * We **never** read `isExcluded`, which is the current state: two honest
 * verifiers straddling a `setExcluded` would read different values and produce
 * different roots for the same epoch. The log, by contrast, is append-only and
 * dated — it gives the same answer whenever the replay happens, which is the
 * whole property the verifiability of this system rests on.
 */
export async function excludedAt(distributor: Address, epoch: number): Promise<Address[]> {
  const log = await client.readContract({
    address: distributor, abi: distributorAbi, functionName: "exclusionLog",
  });
  return replayExclusions([...log], epoch);
}

/** The replay itself, separated from the network so it is testable offline. */
export function replayExclusions(
  log: readonly { account: string; state: boolean; fromEpoch: number | bigint }[],
  epoch: number,
): Address[] {
  const state = new Map<Address, boolean>();
  for (const change of log) {
    // `fromEpoch` is increasing: past the first one beyond, so is the rest.
    if (Number(change.fromEpoch) > epoch) break;
    state.set(getAddress(change.account) as Address, change.state);
  }
  return [...state].filter(([, on]) => on).map(([a]) => a).sort();
}

export interface PurchaseWindow {
  fromEpoch: number;
  toEpoch: number;
  stocks: Address[];
  amounts: bigint[];
  quoteSpent: bigint[];
  block: number;
}

const WINDOW_FUNDED_TOPIC = keccak256(
  new TextEncoder().encode("WindowFunded(uint256,uint256,address[],uint256[],uint256[])"),
);

/**
 * Every purchase the Distributor has been credited with, oldest first.
 *
 * The windows live in the LOGS and not in storage (`Distributor.fundWindow`):
 * the contract keeps only the aggregates its own rules consult, and a verifier
 * replays events anyway — as it always did for the exclusion list. Reading them
 * here is therefore the same act as reading `epochEthSpent` used to be, minus
 * one storage write per epoch on the chain.
 */
export async function windows(distributor: Address): Promise<PurchaseWindow[]> {
  const out: PurchaseWindow[] = [];
  const from = await findFirstBlock(distributor);
  await scanLogs(client, { address: distributor, fromBlock: from, toBlock: Number(await client.getBlockNumber()), topics: [WINDOW_FUNDED_TOPIC] }, (logs) => {
    for (const log of logs) {
      const [stocks, amounts, quoteSpent] = decodeAbiParameters(
        [{ type: "address[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
        log.data as `0x${string}`,
      ) as [Address[], bigint[], bigint[]];
      out.push({
        fromEpoch: Number(BigInt(log.topics[1]!)),
        toEpoch: Number(BigInt(log.topics[2]!)),
        stocks: stocks.map((a) => getAddress(a) as Address),
        amounts: [...amounts],
        quoteSpent: [...quoteSpent],
        block: Number(log.blockNumber),
      });
    }
  });
  out.sort((a, b) => a.fromEpoch - b.fromEpoch);
  return out;
}

/** The first block worth scanning: the Distributor cannot have logged before it existed. */
async function findFirstBlock(distributor: Address): Promise<number> {
  const cached = firstBlockCache.get(distributor);
  if (cached !== undefined) return cached;
  // The genesis timestamp is an immutable, and the epoch calendar starts there.
  const genesis = await client.readContract({
    address: distributor, abi: distributorAbi, functionName: "GENESIS",
  });
  const b = await blockAtOrAfter(Number(genesis));
  firstBlockCache.set(distributor, b);
  return b;
}
const firstBlockCache = new Map<Address, number>();

/**
 * Cumulative ETH spent by every window ending at or before `epoch`.
 *
 * THIS is what sets the eligibility bar, so it has to be a quantity anyone can
 * recompute — hence the logs rather than a figure we hand over. The
 * epoch-by-epoch batched read this replaces existed because the chain stored one
 * `quoteSpent` per epoch; there is one per window now, and there are far fewer of
 * them.
 */
export async function ethCumulativeUpTo(distributor: Address, epoch: number): Promise<bigint> {
  let acc = 0n;
  for (const w of await windows(distributor)) {
    if (w.toEpoch > epoch) break;
    for (const wei of w.quoteSpent) acc += wei;
  }
  return acc;
}

/** The epoch's block bounds, and the token's launch block. */
async function resolveEpochBlocks(token: Address, epochEndTs: number, epochLength: number) {
  const startTs = epochEndTs - epochLength;
  const [firstBlock, lastBlock] = await Promise.all([
    blockAtOrAfter(startTs),
    blockAtOrAfter(epochEndTs).then((b) => b - 1),
  ]);
  const launchBlock = await findLaunchBlock(token);
  return { firstBlock, lastBlock, launchBlock };
}

/** Binary search for the first block whose timestamp is >= ts. */
export async function blockAtOrAfter(ts: number): Promise<number> {
  let lo = 1n;
  let hi = await client.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid, includeTransactions: false });
    if (Number(b.timestamp) < ts) lo = mid + 1n;
    else hi = mid;
  }
  return Number(lo);
}

/**
 * The token's launch block, read from the factory's `TokenLaunched` event.
 *
 * It CANNOT be found by looking for the first block where the token has code:
 * `eth_getCode` at an old block is a state read, which the public RPC does not
 * serve. The event, on the other hand, has `token` as an indexed topic: the
 * filter returns a single log and the node finds it through the bloom filter, so
 * wide ranges go through without trouble.
 */
const TOKEN_LAUNCHED_TOPIC = keccak256(
  new TextEncoder().encode("TokenLaunched(address,address,address,address,uint256,uint256)"),
);

/**
 * The block a token was launched at. An immutable fact, so it is cached: it is
 * looked up once per machine, never once per snapshot.
 *
 * Searched BACKWARD from the head. `scanLogs` pages at 50,000 blocks whatever
 * span it is handed, so the old forward-from-genesis walk cost ~1,100
 * sequential requests on a 54 M-block chain — paid on every cold start, before
 * the keeper could attempt its first publication. A token this keeper serves
 * was launched when the keeper was deployed, so it sits near the head.
 */
async function findLaunchBlock(token: Address): Promise<number> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = `${CACHE_DIR}/launch-${token.toLowerCase()}.json`;
  if (existsSync(path)) return Number(JSON.parse(readFileSync(path, "utf8")).block);

  const head = Number(await client.getBlockNumber());
  const topics = [TOKEN_LAUNCHED_TOPIC, "0x" + token.slice(2).toLowerCase().padStart(64, "0")];
  const STEP = 250_000;
  for (let to = head; to >= 0; to -= STEP) {
    const logs = await rawLogs({
      address: PONS_V2_FACTORY,
      fromBlock: Math.max(0, to - STEP + 1),
      toBlock: to,
      topics,
    });
    if (logs.length) {
      const block = Number(BigInt(logs[0]!.blockNumber));
      writeFileSync(path, JSON.stringify({ token, block }));
      return block;
    }
  }
  throw new Error(`no TokenLaunched found for ${token}`);
}

async function rawLogs(p: { address: string; fromBlock: number; toBlock: number; topics: (string | null)[] }) {
  const out: RawLog[] = [];
  await scanLogs(client, p, (l) => out.push(...l));
  return out;
}
