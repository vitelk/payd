/**
 * Dev-only fixture world.
 *
 * The page reads everything from chain, so with no deployment there is nothing
 * to look at. This answers every read with plausible values so the three views
 * can be checked end to end — layout, formatting, empty states, the claim flow.
 *
 * It is NEVER shipped: `main.ts` imports it behind `import.meta.env.DEV`, which
 * Vite folds to `false` in a production build, so the whole module is dropped.
 *
 * Two things are deliberately NOT faked, because faking them would hide the
 * code that matters:
 *   - the epoch JSON is served through the real `fetch`/sha256 path, with the
 *     `cid` derived from the content itself, so the integrity check really runs;
 *   - the merkle root is the real one, computed from the entries, so
 *     `claimTree` and `proofFor` are exercised for real.
 */
import { sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import { pub, pubLogs } from "./chain.js";
import { claimTree, type Entry } from "./merkle.js";
// The artifact's type, so a fixture that drifts from the keeper's shape
// fails `tsc` instead of failing on screen.
import type { Artifact } from "./artifact.js";
import { cidFromSha256 } from "./cid.js";
import {
  DISTRIBUTION_FACTORY_V3, KNOWN_QUOTES, KNOWN_STOCKS, PAYD_BLOCK, TREASURY as TREASURY_CONF,
} from "./config.js";
import { modeWorld } from "./mock.modes.js";

const HOLDER = "0x9de4b0d4c3a1f7e2b8c5a6d9e0f1a2b3c4d5e31a" as Address;
const KEEPER = "0x4b1d9a7c3e5f80b2a6c4d8e0f1a3b5c7d9e0f2a4" as Address;
const TOKEN = "0xa45c9f3e1b7d0a2c4e6f8b0d2a4c6e8f0b2d407f" as Address;
const ESCROW = "0x2c7f1a9b3d5e7f0a2c4e6b8d0f2a4c6e8b0d2f4a" as Address;
const CURVE = "0x8b3d5e7f0a2c4e6b8d0f2a4c6e8b0d2f4a1c7e93" as Address;

/** The five deepest Robinhood stock pools — see docs/allowlist.md. A basket is
 *  2 to 8 lines, no line under 1,000 bps; five equal fifths is the default. */
const BASKET: { sym: string; bps: number; fee: number }[] = [
  { sym: "QQQ", bps: 2000, fee: 500 }, { sym: "NVDA", bps: 2000, fee: 500 },
  { sym: "GLD", bps: 2000, fee: 3000 }, { sym: "SPCX", bps: 2000, fee: 500 },
  { sym: "TSLA", bps: 2000, fee: 3000 },
];
const stockAt = (i: number) =>
  (`0x${(0xd0000 + i * 0x1111).toString(16).padStart(40, "0")}`) as Address;

/**
 * A Uniswap v3 pool per basket line, and a dollar price on it.
 *
 * **The index's headline is priced, so a world with no pools has no headline.**
 * `metrics.ts`'s `usdPrice` reads `getPool` then `slot0` and `token0`, and
 * without these three the fixture threw "no fixture for getPool" — which
 * `readExtras` catches into a price of zero, which `paidOf` reads as "a leg
 * delivered and nothing priced it", so all seven cards came up "could not read".
 * A mock that answers nothing is not neutral; it draws the error state.
 *
 * The prices are the real ones to the dollar on purpose: a fixture where every
 * stock is worth $100 hides the case the arithmetic is actually for, which is a
 * basket whose lines are worth two orders of magnitude apart.
 */
const PRICES: Record<string, number> = {
  QQQ: 487.20, NVDA: 178.45, GLD: 312.80, SPCX: 26.15, TSLA: 402.60,
};
const poolAt = (i: number) =>
  (`0x${(0x9000 + i).toString(16).padStart(4, "0")}${"b1".repeat(18)}`) as Address;
/**
 * `sqrtPriceX96` for a price of `usd` dollars, with the stock as token0 against
 * USDG's six decimals.
 *
 * The inverse of `yield.ts`'s `spotPrice`, which is what reads it back:
 * `raw = (x / 2**96) ** 2` and the result is `raw * 10 ** (18 - 6)`. Computing
 * it rather than pasting a constant is what keeps the fixture and the function
 * from disagreeing when either moves — `cards.test.ts` asserts the round trip.
 */
const sqrtX96 = (usd: number) =>
  BigInt(Math.floor(Math.sqrt(usd / 1e12) * 2 ** 96));

/**
 * What each launch has DELIVERED, per basket line — the index's headline.
 *
 * Per launch and not one constant, because the whole point of the card is that
 * the number differs: seven cards reading the same $11,131 say "this figure is
 * decorative", which is the opposite of what the page claims about itself. The
 * spread is two orders of magnitude on purpose, and launch 3 has delivered
 * nothing at all — a real zero, which the card must print as `$0` and not as a
 * failure.
 */
const distributedAt = (vault: number, stock: number): bigint =>
  vault === 3
    ? 0n
    : BigInt(Math.floor((vault + 1) ** 2 * (stock + 1) * 137)) * 10n ** 13n;
const FEED = (i: number) =>
  // GLD sits on the TWAP alone, like the real basket.
  (i === 2 ? "0x0000000000000000000000000000000000000000"
    : `0x${(0xfeed00 + i).toString(16).padStart(40, "0")}`) as Address;

const EPOCH = 1284n;
const EPOCH_LEN = 1800n;
const GENESIS = 1_780_000_000n;
/** One purchase covers a WINDOW — every epoch closed since the last one — and
 *  buys the whole basket, each line at its weight (`FeeVault._buyLegs`).
 *
 *  What stood here was a weighted wheel: one stock per epoch, chosen by
 *  `allocationOf(epoch)`. It modelled a design removed from the vault in
 *  2026-09 and its own comment said so. It is deleted rather than annotated,
 *  because a fixture that contradicts the contract is not a warning, it is a
 *  second source of truth. */
const spend = (k: number) => BigInt(120_000 + k * 4_300) * 10n ** 12n;

/**
 * Cumulative amounts owed to the demo holder, raw units. One is already paid.
 *
 * `push` is whether that line is in the tree `distribute` checks against — the
 * shares large enough to deserve a pushed delivery. It matters here for one
 * reason: **the Collector's door is `distribute`, not `claim`**, so
 * "Collect everything" can only ever settle lines marked `push`. With all four
 * at `false`, as they were, that button answered "nothing to collect in one go"
 * for ever and the whole batch path — the push tree, the proofs, the router
 * call — could not be exercised in the fixture world at all.
 *
 * So the largest line is over the floor and the rest are under it, which is
 * also the realistic shape: one holding worth delivering, three accruing.
 */
const MINE: { i: number; cumulative: bigint; paid: bigint; push?: boolean }[] = [
  { i: 0, cumulative: 450920n * 10n ** 12n, paid: 412806n * 10n ** 12n },
  { i: 2, cumulative: 295773n * 10n ** 12n, paid: 284371n * 10n ** 12n },
  { i: 3, cumulative: 2106668n * 10n ** 12n, paid: 1902550n * 10n ** 12n, push: true },
  { i: 5, cumulative: 96004n * 10n ** 12n, paid: 96004n * 10n ** 12n },
];

function buildArtifact() {
  const entries: (Entry & { push: boolean })[] = MINE.map((m) => ({
    holder: HOLDER, stock: stockAt(m.i),
    cumulative: m.cumulative.toString(), push: m.push === true,
  }));
  // A crowd, so "holders in the tree" is not 1.
  for (let h = 0; h < 240; h++) {
    const i = h % 10;
    entries.push({
      holder: (`0x${(0x100000 + h * 7919).toString(16).padStart(40, "0")}`),
      stock: stockAt(i), cumulative: String(BigInt(9_000 + h * 131) * 10n ** 12n), push: h % 5 === 0,
    });
  }
  // FIELD FOR FIELD as `offchain/src/epoch.ts` writes them, and that is not a
  // detail of tidiness: `renderEligibility` reads `windows.at(-1).toEpoch` and
  // the old shape had no such field, so the app printed "Bar at epoch
  // #undefined" — a defect of the fixture that read as a defect of the page.
  // `renderHistory` reads `stocks`/`amounts` the same way.
  //
  // Two of the twelve cover more than one epoch: a purchase covers every epoch
  // closed since the last one, so `fromEpoch === toEpoch` is the common case
  // and not the only one. A fixture where they are always equal never shows
  // the `#a–b` span the history table draws.
  const windows: Artifact["windows"] = [];
  for (let k = 0, e = Number(EPOCH) - 14; k < 12; k++) {
    const span = k === 3 || k === 8 ? 2 : 1;
    windows.push({
      fromEpoch: e,
      toEpoch: e + span - 1,
      stocks: BASKET.map((_, i) => stockAt(i)),
      // The whole basket, each line at its weight — which is what makes the
      // amounts add back up to what the window spent.
      amounts: BASKET.map((b) => String((spend(k) * BigInt(b.bps)) / 10_000n)),
      periodStart: Number(GENESIS) + e * Number(EPOCH_LEN),
      periodEnd: Number(GENESIS) + (e + span) * Number(EPOCH_LEN),
      transferBlocks: 40 + k,
      minBalance: (1_000_000n * 10n ** 18n).toString(),
    });
    e += span;
  }
  const doc: Artifact = {
    upToEpoch: Number(EPOCH) - 1,
    windows, excluded: [ESCROW, TOKEN],
    entries,
  };
  const text = JSON.stringify(doc);
  return { text, cid: sha256(toHex(text)), root: claimTree(entries).root as Hex };
}

const ART = buildArtifact();

/** Everything the page asks the chain, keyed by function name. */
function answer(fn: string, args: readonly unknown[]): unknown {
  const now = BigInt(Math.floor(Date.now() / 1000));
  switch (fn) {
    // --- Distributor
    case "currentEpoch": return EPOCH;
    case "EPOCH_LENGTH": return EPOCH_LEN;
    case "epochEnd": return now + 494n;
    case "rootCount": return 42n;
    case "activeRoot": return 42n;
    case "keeper": return KEEPER;
    case "quoteAtRisk": return 4187n * 10n ** 14n;
    case "MAX_BATCH": return 64n;
    case "MAX_REFUND": return 3n * 10n ** 15n;
    case "PUSH_MARGIN_BPS": return 300n;
    case "roots": return [KEEPER, Number(now - 180n), ART.root, ART.root,
                          Number(EPOCH) - 1, ART.cid];
    case "nextEpoch": return EPOCH;
    case "pendingEpochs": return 0n;
    // The age line and the `Newest` sort read this and nothing else: it is
    // epoch zero's timestamp, which every Distributor carries. Absent, the
    // index's cards drew no age and `readMetrics` returned `null` for the whole
    // yield panel — one missing fixture switching off two screens, which is the
    // failure the comment above `extra()` is about.
    case "GENESIS": return GENESIS;
    case "totalFunded": return 8_420_000n * 10n ** 12n;
    case "quoteFundedFor": return 3_120n * 10n ** 14n;
    case "totalDistributed": return 7_910_000n * 10n ** 12n;
    case "claimedSoFar": {
      const s = (args[1] as string).toLowerCase();
      return MINE.find((m) => stockAt(m.i).toLowerCase() === s)?.paid ?? 0n;
    }
    case "owedTo": {
      const s = (args[1] as string).toLowerCase();
      const m = MINE.find((x) => stockAt(x.i).toLowerCase() === s);
      return m ? m.cumulative - m.paid : 0n;
    }

    // --- FeeVault
    case "token": return TOKEN;
    case "ESCROW": return ESCROW;
    case "curve": return CURVE;
    // 1.68 virtual + 1.05 raised -> 25 % of the way to 4.2
    case "quoteReserve": return 2_730_000_000_000_000_000n;
    case "graduated": return false;
    case "rewardsPool": return 20_940n * 10n ** 15n;
    case "creatorPool": return 640n * 10n ** 15n;
    case "payoutBps": return 400n;
    case "MIN_PAYOUT_BPS": return 50n;
    case "rewardsBps": return 7000n;
    case "PLATFORM_BPS": return 1000n;
    case "MAX_SLIPPAGE_BPS": return 150n;
    case "TWAP_WINDOW": return 1800n;
    case "getAllocations":
      return BASKET.map((b, i) => ({
        stock: stockAt(i), poolFee: b.fee, bps: b.bps, feed: FEED(i),
      }));

    // --- ERC-20 / escrow
    case "symbol": return "?";
    case "decimals": return 18;
    case "balanceOf": return 1_080n * 10n ** 15n;
  }
  throw new Error(`mock: no fixture for ${fn}`);
}

/**
 * The world of the OTHER TWO modes: the launch index and the Treasury.
 *
 * They read contracts the claim page never touches -- `Payd.vaults()`, the four
 * pockets, `platformPool` per vault. Without these fixtures the two screens were
 * only viewable after a deployment, which is exactly the moment when it is too
 * late to correct the design.
 *
 * Seven launches, in varied states ON PURPOSE: one not launched, one whose fees
 * are lost, one whose redirection is pending. A set where everything is fine
 * does not show three quarters of the interface.
 */
/** `?vaults=N` grows the registry, seven by default.
 *
 *  The index's cost per vault is the thing this fixture cannot show at a fixed
 *  size: seven of them read fast enough that a per-vault round trip looks free,
 *  and the registry is meant to hold many more than seven. With the knob the
 *  slope is measurable before a deployment makes it everyone's problem. */
const VAULT_COUNT = Math.max(
  1,
  Math.min(400, Number(new URLSearchParams(location.search).get("vaults") ?? 7) || 7),
);
const VAULTS = Array.from({ length: VAULT_COUNT }, (_, i) =>
  `0x${(i + 1).toString(16).padStart(4, "0")}${"7a".repeat(18)}` as Address);
const BASE_SYMS = ["VOLT", "MESA", "KIRN", "ORBIT", "PALLAS", "DRIFT", "SOL8"];
const LAUNCH_SYMS = Array.from(
  { length: VAULT_COUNT },
  (_, i) => (i < BASE_SYMS.length ? BASE_SYMS[i]! : `${BASE_SYMS[i % BASE_SYMS.length]}${Math.floor(i / BASE_SYMS.length)}`),
);
/** An address space OF ITS OWN for the launched tokens. `stockAt(i)` already
 *  designates the basket's stocks: reusing the same sequence would make launch
 *  i's token stock i, and the symbols would have trodden on each other. */
const launchTokenAt = (i: number) =>
  `0x${(i + 1).toString(16).padStart(4, "0")}${"c3".repeat(18)}` as Address;
/** status, rewards/creator/platform/gross in bps of VOLUME, reserve, balance held.
 *  Seven rows, cycled when `?vaults=` asks for more: the STATES are what this
 *  table is for, and seven of them already cover every branch the index draws. */
const SHAPES: [number, number, number, number, number, bigint, bigint][] = [
  [1, 329, 94, 47, 470, 126_000_000_000_000_000n, 1_080_000_000_000_000_000_000n],
  [1, 280, 140, 40, 460, 41_000_000_000_000_000n, 0n],
  [2, 300, 120, 43, 463, 9_000_000_000_000_000n, 250_000_000_000_000_000_000n],
  [1, 410, 30, 52, 492, 302_000_000_000_000_000n, 0n],
  [3, 260, 160, 38, 458, 0n, 0n],
  [1, 350, 80, 45, 475, 77_000_000_000_000_000n, 12_400_000_000_000_000_000n],
  [0, 0, 0, 0, 0, 0n, 0n],
];
const LAUNCHES = Array.from({ length: VAULT_COUNT }, (_, i) => SHAPES[i % SHAPES.length]!);
/** The 12 stocks the timelock has listed, in the fixture world. Two tiers and
 *  two stocks with no Chainlink feed, like the real list. */
const LISTED: { sym: string; fee: number; feed: boolean }[] = [
  { sym: "NVDA", fee: 3000, feed: true }, { sym: "AAPL", fee: 3000, feed: true },
  { sym: "TSLA", fee: 10000, feed: true }, { sym: "QQQ", fee: 3000, feed: true },
  { sym: "GLD", fee: 3000, feed: true }, { sym: "USO", fee: 10000, feed: false },
  { sym: "AMZN", fee: 3000, feed: true }, { sym: "GOOGL", fee: 3000, feed: true },
  { sym: "GME", fee: 10000, feed: false }, { sym: "SPCX", fee: 10000, feed: false },
  { sym: "META", fee: 3000, feed: true }, { sym: "MSFT", fee: 3000, feed: true },
];
/**
 * The allowlist's addresses — THE REAL ONES, and that is the whole point.
 *
 * The creation screen no longer discovers the list from `StockAllowed`: it asks
 * `Payd.listing(stock)` about the addresses `config.ts` ships
 * (`KNOWN_STOCKS`). So a fixture on invented addresses is a fixture the screen
 * never asks about — twelve `listing` calls for twelve strangers, twelve
 * `null`s, and the picker switched off with "no stock is listed yet". That is
 * the failure `install()` below has been burnt by twice; it moves here with the
 * lookup.
 *
 * Twelve of the forty-six, on purpose. The rest are candidates the registry
 * does NOT confirm, which is the state a delisting leaves behind and the one
 * path worth having in the fixture: a shipped address that answers
 * `allowed: false` must simply not appear.
 */
const listedAt = (i: number) => KNOWN_STOCKS[i % KNOWN_STOCKS.length]!;

/** The currencies a launch can be quoted in.
 *
 *  All three shapes are represented on purpose: the native ETH the form adds
 *  itself, USDG (no hop, hence `fee` at zero) and a stock (one v3 hop, hence a
 *  tier). A mock that returned only ETH would have left the selector with a
 *  single row and nobody would have seen that it exists -- the same mistake as
 *  the empty allowlist below, which switched off the whole screen. */
const quoteAt = (i: number) => KNOWN_QUOTES[i % KNOWN_QUOTES.length]!;
const QUOTES: { quote: Address; sym: string; fee: number; wethFee: number; minBuy: bigint }[] = [
  // `Payd._allowQuotes`: the PIVOT carries no tier (no route to itself), every
  // other currency carries EXACTLY ONE of `fee` (direct QUOTE/USDG) and
  // `wethFee` (the `QUOTE -> WETH -> PIVOT` detour). The third row is the
  // detour, which had no fixture at all — the shape that makes COIN and cbBTC
  // servable was the one nobody could look at.
  { quote: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address, sym: "USDG", fee: 0, wethFee: 0, minBuy: 10_000_000n },
  { quote: quoteAt(0), sym: LISTED[0]!.sym, fee: LISTED[0]!.fee, wethFee: 0, minBuy: 50_000_000_000_000_000n },
  { quote: quoteAt(1), sym: LISTED[1]!.sym, fee: 0, wethFee: 3000, minBuy: 50_000_000_000_000_000n },
];

const vaultIndex = (a: string) => VAULTS.findIndex((v) => v.toLowerCase() === a.toLowerCase());

/** Returns the index/Treasury mode's fixture, or `undefined` if this is not one
 *  of their reads -- the caller then falls back to the main world. */
function extra(addr: string, fn: string): unknown {
  if (fn === "vaults") return VAULTS;
  if (fn === "platformBps") return 1_000n;
  if (fn === "PLATFORM") return (TREASURY_ADDR ?? ZERO_ADDR) as Address;
  if (fn === "PONS_FACTORY") return "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
  // THE CREATION SCREEN NEEDS THESE TO EXIST AT ALL. Without a `factory` the
  // form holds on "could not read which factory the registry builds through",
  // and every mode-dependent control below it — the payout mode, the burn and
  // the locked-LP legs — is unreachable in the fixture world. Same mistake as
  // an empty `getLogs`: a mock that answers nothing is not neutral, it switches
  // off a page. V3 on purpose, because that is the version whose legs exist.
  if (fn === "factory") return DISTRIBUTION_FACTORY_V3;
  if (fn === "factoryMode") return stringToHex("distribution", { size: 32 });
  if (fn === "maxCreatorTaxBps") return 1_000n;

  // The Treasury, recognised by its ADDRESS and not by the function's name:
  // `rewardsBps` exists on both sides -- 33.33 % here, a vault's holders' share
  // over there. Sorting by name alone would have shown 70 % in the pockets.
  if (TREASURY_ADDR && addr === TREASURY_ADDR) {
    switch (fn) {
      case "devBps": case "rewardsBps": return 3_333n;
      case "burnBps": case "lpBps": return 1_667n;
      case "devPool": return 412_000_000_000_000_000n;
      case "rewardsPool": return 690_000_000_000_000_000n;
      case "burnPool": return 96_000_000_000_000_000n;
      case "lpPool": return 88_000_000_000_000_000n;
      case "platformToken": return TOKEN;
      case "DEV_WALLET": return "0x00000000000000000000000000000000000000de" as Address;
    }
    return undefined;
  }

  const i = vaultIndex(addr);
  if (i < 0) return undefined;
  const [status, rew, cre, plat, gross, reserve] = LAUNCHES[i]!;
  switch (fn) {
    case "token": return status === 0 ? ZERO_ADDR : launchTokenAt(i);
    case "DISTRIBUTOR": return VAULTS[i];
    case "PLATFORM_BPS": return status === 0 ? 0n : 1_000n;
    case "platformPool": return reserve / 10n;
    case "hookStatus": return [status, ZERO_ADDR, BigInt(Math.floor(Date.now() / 1000) + 172_800)];
    case "economics": return [400n, 100n, 3_000n, BigInt(gross), BigInt(rew), BigInt(cre), BigInt(plat)];
    case "rewardsPool": return reserve;
  }
  return undefined;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
/**
 * The address the Treasury page reads — FROM THE CONFIG, which is where that
 * page reads it too, and which already applies the `?treasury=` override.
 *
 * It parsed the query string itself, and that worked only while the constant
 * was zero: once the deployment filled it in, `/?mock#treasury` had a Treasury
 * page and no fixtures for it, and the screen came up "no fixture for devBps".
 * The same note is on `REGISTRY` in `registry.ts`: reading the URL a second
 * time is how the constant and the query string come apart.
 */
const TREASURY_ADDR = TREASURY_CONF === ZERO_ADDR ? null : TREASURY_CONF.toLowerCase();

export function install() {
  // The vaults of the OTHER payout modes: two of the seven, so the index shows
  // its chips and each mode's screen is reachable by `?vault=`.
  const modes = modeWorld(VAULTS, BASKET.map((_, i) => stockAt(i)), HOLDER);

  const bySymbol = new Map<string, string>(BASKET.map((b, i) => [stockAt(i).toLowerCase(), b.sym]));
  // `symbol` answers at the top of `readContract` and RETURNS THERE, so
  // anything with a ticker has to be in this map or it comes out as "?"
  // whatever is written below. That is not hypothetical: the launched tokens
  // were matched thirty lines further down, the early return never let the
  // match run, and the seven cards of the index all read "?" — a fixture that
  // shows the same wrong thing for every row hides the row that is wrong.
  for (const q of QUOTES) bySymbol.set(q.quote.toLowerCase(), q.sym);
  for (const [i, sym] of LAUNCH_SYMS.entries()) bySymbol.set(launchTokenAt(i).toLowerCase(), sym!);
  for (const [i, l] of LISTED.entries()) bySymbol.set(listedAt(i).toLowerCase(), l.sym);
  bySymbol.set(TOKEN.toLowerCase(), "PAYD");

  /**
   * `?lag=N` gives every mocked read N milliseconds, and `window.__reads`
   * counts them.
   *
   * Without it this world answers in the same microtask, so a screen that makes
   * one round trip PER VAULT and one that makes one for all of them render at
   * exactly the same speed — the fixture hides the only property that decides
   * whether the index still works at fifty launches. With a lag, the wall clock
   * IS the count of serialised round trips, and `__reads` says how many calls
   * the batching folded into them.
   */
  const LAG = Math.max(0, Number(new URLSearchParams(location.search).get("lag") ?? 0) || 0);
  const counter = globalThis as unknown as { __reads: number };
  counter.__reads = 0;

  pub.readContract = (async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    counter.__reads++;
    if (LAG) await new Promise((r) => setTimeout(r, LAG));
    const addr = p.address.toLowerCase();
    if (p.functionName === "symbol") return bySymbol.get(addr) ?? "?";
    if (p.functionName === "decimals") return 18;
    // --- the v3 pools the index's cards price their headline on. Keyed by the
    // stock the pool was asked FOR, so a pool address maps back to one price.
    if (p.functionName === "getPool") {
      const i = BASKET.findIndex((_, k) => stockAt(k).toLowerCase() === String(p.args?.[0] ?? "").toLowerCase());
      return i < 0 ? ZERO_ADDR : poolAt(i);
    }
    {
      const pi = BASKET.findIndex((_, k) => poolAt(k).toLowerCase() === addr);
      if (pi >= 0) {
        // The stock as token0, which is the half of `spotPrice` that does not
        // need inverting: the ordering is by address in a real pool and this
        // fixture is not testing which side won.
        if (p.functionName === "token0") return stockAt(pi);
        if (p.functionName === "slot0") {
          return [sqrtX96(PRICES[BASKET[pi]!.sym] ?? 100), 0, 0, 0, 0, 0, true];
        }
      }
    }
    // The launched token's own metadata. Pons writes it at launch and there is
    // no setter; the cards read it for the 40 px square. One launch carries
    // none on purpose — the ticker fallback is a state, not an accident.
    if (p.functionName === "logo") {
      const li = VAULTS.findIndex((_, i) => launchTokenAt(i).toLowerCase() === addr);
      return li === 1 ? "" : `ipfs://bafkreimockedlogo${li < 0 ? 0 : li}`;
    }
    // `balanceOf` is asked of two different things: the escrow (what a harvest
    // would bring back) and the token (the holder's balance, which the
    // eligibility panel compares to the bar). Same name, different fixture.
    if (p.functionName === "balanceOf" && addr === TOKEN.toLowerCase()) return 1_450_000n * 10n ** 18n;
    // The currency mapping: read BY ADDRESS, as `quotelist` does. It comes
    // before `extra`, which does not see the arguments.
    // The stock allowlist, read one address at a time — which is how the
    // creation screen asks now that it no longer walks `StockAllowed`. Twelve
    // of the shipped candidates answer; every other one falls through to the
    // `allowed: false` below, which is exactly what a delisted address does on
    // the real registry.
    if (p.functionName === "listing") {
      const i = LISTED.findIndex((_, k) => listedAt(k).toLowerCase() === String(p.args?.[0] ?? "").toLowerCase());
      return i < 0
        ? [0, ZERO_ADDR, false]
        : [LISTED[i]!.fee, LISTED[i]!.feed ? FEED(0) : ZERO_ADDR, true];
    }
    if (p.functionName === "quoteListing") {
      const q = QUOTES.find((x) => x.quote.toLowerCase() === String(p.args?.[0] ?? "").toLowerCase());
      return q ? [q.fee, q.wethFee, q.minBuy, true] : [0, 0, 0n, false];
    }

    // What each launch has handed to its holders, per line of its basket. Asked
    // of the DISTRIBUTOR, which in this world is the vault itself
    // (`case "DISTRIBUTOR"` below returns it), so the launch is the address and
    // the stock is the argument.
    if (p.functionName === "totalDistributed") {
      const vi = vaultIndex(addr);
      const si = BASKET.findIndex((_, k) => stockAt(k).toLowerCase() === String(p.args?.[0] ?? "").toLowerCase());
      if (vi >= 0 && si >= 0) return distributedAt(vi, si);
    }

    // The payout modes, before everything else: `modeOf` is asked of the
    // REGISTRY with the vault as an argument, and the mode contracts answer
    // names (`currentEpoch`, `balanceOf`) the main world also answers with
    // something else entirely.
    if (p.functionName === "modeOf") return modes.modeOf(String(p.args?.[0] ?? ""));
    const m = modes.read(addr, p.functionName, p.args ?? []);
    if (m !== undefined) return m;

    // The other two modes first: their reads overlap the main world only on
    // `rewardsBps`, which exists on both sides with different meanings -- hence
    // indexing by address rather than by name alone.
    const e = extra(addr, p.functionName);
    if (e !== undefined) return e;

    // The balance PER launch. Without it they all fell back on `balanceOf`'s
    // general fixture and the seven cards showed the same figure -- including
    // the one for the launch that does not exist yet.
    const li = VAULTS.findIndex((_, i) => launchTokenAt(i).toLowerCase() === addr);
    if (p.functionName === "balanceOf" && li >= 0) return LAUNCHES[li]![6];

    return answer(p.functionName, p.args ?? []);
  }) as typeof pub.readContract;

  /**
   * ABOVE `PAYD_BLOCK`, and that is not cosmetic.
   *
   * Every log walk on this page starts at the registry's deployment block and
   * `logsSince` returns nothing at all when that floor is above the head. With
   * a head of 8 412 907 against a floor of 61 344 426, the fixture world's
   * creation screen scanned zero windows, folded zero events and came up with
   * an empty allowlist — the picker switched off, whatever this stub answered
   * below. One window past the floor is enough, and it also keeps the walk to
   * a single `getLogs` so the fold is not handed the same rows 268 times.
   */
  pub.getBlockNumber = (async () => PAYD_BLOCK + 512n) as typeof pub.getBlockNumber;
  pub.getBalance = (async () => 1_040_000_000_000_000_000n) as typeof pub.getBalance;
  /**
   * **The creation screen makes no log request any more, so this stub answers
   * nothing and that is correct.**
   *
   * It used to serve `StockAllowed`, `QuoteAllowed` and `FactoryEnabled` — the
   * three streams `scanListings` walked — and the comment here twice recorded
   * the same lesson: a mock that returns `[]` is not neutral, it switches off
   * an entire page. The lesson still holds; what changed is where the allowlist
   * comes from. It is `listing` / `quoteListing`, one address at a time, and
   * those are answered above. If the picker ever comes up empty in `?mock`
   * again, THAT is where to look, not here.
   *
   * Empty rather than deleted because `artifact.ts` walks `RootPublished`
   * backwards from head, and a missing `getLogs` would take that to the real
   * chain with fixture addresses.
   */
  pub.getLogs = (async () => []) as unknown as typeof pub.getLogs;
  pubLogs.getLogs = pub.getLogs;
  // The creation screen asks the registry before it asks the wallet. Left
  // unstubbed that question goes to the REAL chain with fixture addresses, and
  // it is answered — correctly — "not on the timelock's allowlist", which shuts
  // the screen in the one world built to exercise it.
  pub.simulateContract = (async (p: { functionName: string }) =>
    ({ result: [VAULTS[0], VAULTS[0]], request: { functionName: p.functionName } })) as unknown as
      typeof pub.simulateContract;
  pub.waitForTransactionReceipt = (async () =>
    ({ status: "success" })) as unknown as typeof pub.waitForTransactionReceipt;

  // Serve the epoch JSON at its real CID, through the real verification path.
  const realFetch = globalThis.fetch.bind(globalThis);
  const path = cidFromSha256(ART.cid);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith(path)) return Promise.resolve(new Response(ART.text));
    // The lottery's ticket set, at the CID its own digest produces: the draw
    // screen then runs the real sha256 check and the real tree rebuild.
    const ticket = modes.serve(String(input));
    if (ticket !== null) return Promise.resolve(new Response(ticket));
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;

  /**
   * A wallet, so the claim panel and the button can be exercised — and
   * `?wrongnet` puts it on ANOTHER chain.
   *
   * The shell's wrong-network state is a whole strip, a red dot and a changed
   * Connect label, and until this knob existed none of it could be looked at
   * without owning a wallet and switching networks by hand. That is the same
   * gap the seven launch states above were given: a fixture where everything
   * is fine does not show three quarters of the interface.
   *
   * It emits `chainChanged` too, which is what `chain.ts` listens to — so
   * pressing "Switch to Robinhood Chain" flips the stub and the shell repaints
   * on the event, exactly as it would against a real wallet.
   */
  let chainId = new URLSearchParams(location.search).has("wrongnet") ? "0x1" : "0x1237";
  let declineSwitch = chainId !== "0x1237";
  const chainSubs: ((v: unknown) => void)[] = [];
  (globalThis as unknown as { ethereum: unknown }).ethereum = {
    on: (ev: string, fn: (v: unknown) => void) => { if (ev === "chainChanged") chainSubs.push(fn); },
    removeListener: (ev: string, fn: (v: unknown) => void) => {
      if (ev !== "chainChanged") return;
      const i = chainSubs.indexOf(fn);
      if (i >= 0) chainSubs.splice(i, 1);
    },
    request: async ({ method, params }: { method: string; params?: { data?: string }[] }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [HOLDER];
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") {
        // **Declined once, accepted after**, which is the only way the wrong
        // network is reachable at all. `connectWith` calls `ensureChain` the
        // moment a wallet answers, so a stub that always obeys is on the right
        // chain before the header has painted once and the strip can never be
        // seen. A visitor reaches that state by refusing the wallet's prompt —
        // so the fixture refuses it, exactly once, with the code MetaMask
        // sends (4001, user rejected). Pressing the strip's own button is the
        // second ask, and it goes through.
        if (declineSwitch) {
          declineSwitch = false;
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        }
        chainId = "0x1237";
        for (const fn of chainSubs) fn(chainId);
        return null;
      }
      if (method === "eth_sendTransaction") {
        // The calldata, where a test can read it: the units a screen SENDS are
        // not the units it displays, and the creation screen shipped "90" for
        // `rewardsBps` where the registry wanted 9000 — every creation refused
        // `BadSplit`, with the screen's own checklist all green because it read
        // the same field through the converter and the submit did not.
        console.log("CALLDATA", params?.[0]?.data);
        return `0x${"ab".repeat(32)}`;
      }
      return null;
    },
  };

  // eslint-disable-next-line no-console
  console.info(`[mock] fixture world installed — root ${ART.root.slice(0, 10)}…, cid ${ART.cid.slice(0, 10)}…`);
}
