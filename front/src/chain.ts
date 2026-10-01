import { createPublicClient, http, parseAbi, defineChain, type Address } from "viem";
import { RPC_URL, CHAIN_ID, EXPLORER, WC_PROJECT_ID, PROJECT_NAME, APP_URL } from "./config.js";

export const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  // Multicall3 at its canonical address, read on-chain 2026-09-12 (7.6 kB of
  // code there). Declaring it is what lets `batch.multicall` below exist.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/**
 * `batch.multicall` folds the `view` calls issued in the same tick into ONE
 * `eth_call`. It is not a micro-optimisation here: the creation screen reads
 * `symbol()` for every stock the timelock has listed — 46 of them — and the
 * code did it one at a time, on purpose, because a burst of separate calls is
 * how a public RPC decides to rate-limit you. That cost **16.5 seconds** with
 * the basket picker showing "reading the allowlist…" the whole way, which is
 * indistinguishable from broken. Batched, it is one request and the reason for
 * going one at a time disappears with it.
 */
export const pub = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 3 }),
  // `batchSize` in BYTES of calldata: the default of 1024 splits 46 `symbol()`
  // calls across eight batches, and a round trip to this node costs ~1 s.
  // `wait` is a collection window — the reads are issued from separate
  // microtasks, and at the default of 0 the first one leaves before its
  // siblings are queued.
  batch: { multicall: { batchSize: 16_384, wait: 20 } },
});

/**
 * The client the PARALLEL log scan reads through, and it differs from `pub` in
 * exactly one way: it does not retry.
 *
 * `tryWindow` below already retries, with jitter and a backoff sized for a
 * rate-limit window. viem retrying inside it meant one window could cost 4 x 4
 * = 16 requests — and viem's four leave 150 ms apart, inside a single slot of
 * the pacer, so the layer meant to survive the throttle was feeding it. The
 * browser console showed both loops nested in one stack, over a
 * `429 Too Many Requests`.
 *
 * `pub` keeps its retries: every other read is an `eth_call`, batched into one
 * multicall, and there is no second layer above it to collide with.
 */
export const pubLogs = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 0 }),
});

const symbolAbi = parseAbi(["function symbol() view returns (string)"]);

/** Attempts for a round of `symbol()` reads, and the first backoff in ms. */
const SYMBOL_TRIES = 3;
const SYMBOL_BACKOFF_MS = 500;

/**
 * `symbol()` for many tokens at once, and RETRIED AS A ROUND.
 *
 * **A ticker that cannot be read does not fail visibly, it fails wrongly.**
 * Every caller has a fallback — the address, or "?" — so one refused request
 * puts 46 addresses on the creation screen where 46 tickers belong, with
 * nothing on the page saying the node said no. Seen 2026-09-17; `symbol()` read
 * straight from the chain a minute later returned JNJ, AMC, RDDT, AMZN, DJT.
 * The tokens were never the problem.
 *
 * They go in ONE tick so `batch.multicall` folds them into a single `eth_call`
 * (46 sequential reads took 16.5 s), and that is exactly why the RETRY is of the
 * whole round: retrying token by token would issue 46 separate calls and
 * recreate the burst that earned the refusal.
 *
 * `null` for a token whose own call failed, so the caller can tell one broken
 * ERC-20 from a node that answered nothing. Only an ALL-failed round is retried
 * — a mix means the reads went through and some tokens simply have no
 * `symbol()`, which no amount of asking again will change.
 */
export async function symbolsOf(tokens: readonly Address[]): Promise<(string | null)[]> {
  if (tokens.length === 0) return [];
  for (let attempt = 1;; attempt++) {
    const rows = await Promise.all(tokens.map((address) =>
      pub.readContract({ address, abi: symbolAbi, functionName: "symbol" })
        .then((symbol) => symbol as string | null)
        .catch(() => null)));
    const missing = rows.filter((r) => r === null).length;
    if (missing < tokens.length || attempt >= SYMBOL_TRIES) return rows;
    // Full jitter, like a log window: a fixed pause puts the next round on the
    // same millisecond as everything else that backed off with it.
    await new Promise((r) => setTimeout(r, Math.random() * SYMBOL_BACKOFF_MS * 2 ** (attempt - 1)));
  }
}

export const distributorAbi = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function epochEnd(uint256) view returns (uint256)",
  "function GENESIS() view returns (uint256)",
  "function EPOCH_LENGTH() view returns (uint256)",
  "function MAX_BATCH() view returns (uint256)",
  "function MAX_REFUND() view returns (uint256)",
  "function PUSH_MARGIN_BPS() view returns (uint256)",
  "function nextEpoch() view returns (uint256)",
  "function pendingEpochs() view returns (uint256)",
  "function totalFunded(address) view returns (uint256)",
  "function quoteFundedFor(address) view returns (uint256)",
  "function totalDistributed(address) view returns (uint256)",
  "function claimedSoFar(address, address) view returns (uint256)",
  "function owedTo(address holder, address stock, uint256 cumulative) view returns (uint256)",
  "function rootCount() view returns (uint256)",
  "function activeRoot() view returns (uint256)",
  // WARNING: this tuple must match `Distributor.Root` field for field. Dropping
  // one raises no error at all — viem decodes a word too early and EVERYTHING
  // after it shifts by one slot, so the `cid` read is really the `upToEpoch` and
  // the page never finds its epoch data. Any change to `Root` has to be mirrored
  // here AND in `offchain/src/abis.ts`.
  "function roots(uint256) view returns (address publisher, uint40 publishedAt, bytes32 claimRoot, bytes32 pushRoot, uint48 upToEpoch, bytes32 digest)",
  "event RootPublished(uint256 indexed rootId, address indexed publisher, bytes32 claimRoot, bytes32 pushRoot, uint256 upToEpoch, bytes32 digest, string cid)",
  "function keeper() view returns (address)",
  "function quoteAtRisk() view returns (uint256)",
  "function claim(address[] stocks, uint256[] cumulative, bytes32[][] proofs) returns (uint256)",
]);

export const vaultAbi = parseAbi([
  "function rewardsPool() view returns (uint256)",
  "function creatorPool() view returns (uint256)",
  "function platformPool() view returns (uint256)",
  "function rewardsBps() view returns (uint256)",
  "function hookStatus() view returns (uint8 status, address current, uint64 effectiveAt)",
  "function hookLostAt() view returns (uint64)",
  "function flagHookLost()",
  "function economics() view returns (uint256 taxBps, uint256 curveFeeBps, uint256 ponsShareBps, uint256 grossOfVolumeBps, uint256 rewardsOfVolumeBps, uint256 creatorOfVolumeBps, uint256 platformOfVolumeBps)",
  "function PLATFORM_BPS() view returns (uint256)",
  "function CREATOR() view returns (address)",
  "function PLATFORM() view returns (address)",
  "function payoutBps() view returns (uint256)",
  "function token() view returns (address)",
  "function curve() view returns (address)",
  "function ESCROW() view returns (address)",
  "function MIN_PAYOUT_BPS() view returns (uint256)",
  "function TWAP_WINDOW() view returns (uint32)",
  "function MAX_SLIPPAGE_BPS() view returns (uint256)",
  "function getAllocations() view returns ((address stock, uint24 poolFee, uint16 bps, address feed)[])",
]);

export const escrowAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** The Pons bonding curve, only for what the graduation gauge needs. */
export const curveAbi = parseAbi([
  "function quoteReserve() view returns (uint256)",
  "function graduated() view returns (bool)",
]);

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

// ------------------------------------------------------------------ wallet

/** EIP-1193 provider, or null when no wallet injected one. */
export type Eth1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** What EIP-6963 hands over with each announcement. */
type Announced = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eth1193;
};

/**
 * Every wallet that announced itself under EIP-6963, keyed by `rdns`.
 *
 * `window.ethereum` is ONE slot and browsers routinely hold three extensions.
 * Whichever loads last wins it, so a visitor with MetaMask and Rabby installed
 * connects whichever of the two happened to overwrite the other — and there is
 * no way from this side to ask for the other one. EIP-6963 replaces the slot
 * with an announcement: we dispatch a request, every installed wallet answers
 * with its own provider object, and the visitor picks.
 *
 * Keyed by `rdns` and not `uuid`: the uuid is fresh on every page load, so two
 * announcements from the same wallet — they do announce on load AND on our
 * request — would be two rows in the menu.
 *
 * Guarded on `window` because this module is imported by the node tests, where
 * there is no event target to listen on and nothing to discover.
 */
const announced = new Map<string, Announced>();
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * The wallet the visitor CHOSE, once they have chosen one.
 *
 * Every write in this app reaches its wallet through `provider()`, and they
 * all call it AFTER the header's Connect button ran. So remembering the choice
 * in one place is what makes the choice mean anything: the launch form, the
 * bind, the claim and the collect all sign with the wallet that was picked,
 * including when that wallet is a phone on the other side of a QR code.
 */
let chosen: Eth1193 | null = null;

/** Remembers the visitor's pick. Everything that signs reads it back through
 *  `provider()`. */
export function useWallet(eth: Eth1193): void { chosen = eth; void watchNetwork(eth); }

// ------------------------------------------------------- which network, passively
//
// **Nothing asked until something was signed.** `ensureChain` reads
// `eth_chainId` at the moment of a write and switches if it must, which is
// correct and far too late to be useful: a visitor on Ethereum mainnet saw a
// page that looked entirely normal, pressed Collect, and only then learned
// that the last two minutes of reading had been about a chain their wallet was
// not on. Every figure on the page was true — they are read through `pub`, our
// own RPC, and no wallet is involved — but nothing said which of the two
// networks anything belonged to.
//
// So the chain is tracked from the moment a wallet is chosen, and the shell
// says it. Read once, then kept current by `chainChanged`, which every
// EIP-1193 provider emits and which this app had no listener for at all — a
// visitor who switched network in MetaMask kept the old answer until they
// reloaded.

/** The chain id the chosen wallet is on, or `null` when none is chosen or the
 *  wallet would not say. `null` is not "wrong": it is "not asked", and the
 *  shell draws nothing for it. */
export let walletChain: number | null = null;
/** True only when a wallet is chosen AND it is demonstrably on another chain.
 *  Never true while the answer is unknown — a banner shown on a guess is worse
 *  than no banner. */
export const onWrongNetwork = (): boolean => walletChain !== null && walletChain !== CHAIN_ID;

const netSubs: Array<() => void> = [];
/** Called after every change, like `onViewer`. */
export function onNetwork(fn: () => void): void { netSubs.push(fn); }
function setChain(id: number | null): void {
  if (id === walletChain) return;
  walletChain = id;
  for (const fn of netSubs) fn();
}

/** Listeners are per PROVIDER, so a visitor who switches wallets gets a second
 *  one. Tracked by identity and removed on the way out — an extension that
 *  keeps emitting after being dropped would otherwise rewrite the state of a
 *  wallet nobody is using. */
type Emitter = Eth1193 & {
  on?: (ev: string, fn: (v: unknown) => void) => void;
  removeListener?: (ev: string, fn: (v: unknown) => void) => void;
};
let watching: { eth: Emitter; fn: (v: unknown) => void } | null = null;

export async function watchNetwork(eth: Eth1193 | null): Promise<void> {
  if (watching) {
    watching.eth.removeListener?.("chainChanged", watching.fn);
    watching = null;
  }
  if (!eth) return setChain(null);
  const fn = (v: unknown) => setChain(typeof v === "string" ? Number(v) : null);
  (eth as Emitter).on?.("chainChanged", fn);
  watching = { eth: eth as Emitter, fn };
  try {
    setChain(Number((await eth.request({ method: "eth_chainId" })) as string));
  } catch {
    // A wallet that will not answer is not a wallet on the wrong chain. Left
    // unknown, which draws nothing.
    setChain(null);
  }
}

/**
 * A provider that can end its own session — WalletConnect can, an extension
 * cannot, and the difference is not cosmetic.
 *
 * A WalletConnect session is a real object with two copies: one on the relay,
 * one in this browser's `localStorage`. `EthereumProvider.init` restores it on
 * the next visit, which is what makes coming back to the page free of a second
 * QR code — and which is exactly why forgetting it HERE is not enough. A
 * Disconnect that only clears our variable is a Disconnect the next reload
 * undoes.
 *
 * An extension has nothing of the sort. Being connected to one is a permission
 * IT holds, revocable from its own UI and from nowhere else; the honest thing
 * this app can do is stop using it, which is the local half below.
 */
type Endable = Eth1193 & { disconnect?: () => Promise<void> };

/**
 * Forgets the wallet, and ends the session when there is one to end.
 *
 * `chosen` is cleared FIRST and unconditionally: whatever the relay does with
 * the request, the visitor asked to be disconnected and `provider()` must stop
 * naming that wallet before anything can await. The failure being swallowed is
 * the session that was already gone — the phone ended it from its side, which
 * is the common way this runs — and there is nothing left to report about it.
 */
export async function disconnect(): Promise<void> {
  const eth = chosen as Endable | null;
  chosen = null;
  // Before the await, for `chosen`'s reason: the visitor asked to be
  // disconnected, and a wrong-network strip must not outlive the wallet it is
  // about.
  void watchNetwork(null);
  try { await eth?.disconnect?.(); } catch { /* already ended, and the local half is done */ }
}

/**
 * The provider to sign with: the chosen one, else whatever is injected, else
 * the first wallet that announced itself.
 *
 * The injected slot comes BEFORE the announcements on purpose. It is what this
 * function has always returned, it is what the node fixture installs, and a
 * visitor who never opened the menu is a visitor with one wallet — reading the
 * slot directly is then both correct and one map lookup cheaper.
 */
export const provider = (): Eth1193 | null =>
  chosen
  ?? (window as unknown as { ethereum?: Eth1193 }).ethereum
  ?? announced.values().next().value?.provider
  ?? null;

/** A row in the Connect menu. `open` is what running the row does, and it is
 *  async because one of them has a library to fetch and a QR code to show. */
export type WalletOption = {
  id: string;
  name: string;
  icon?: string;
  open: () => Promise<Eth1193>;
};

/**
 * What the Connect button can offer, in the order it offers it.
 *
 * Injected wallets first — they are one click and no third party. The
 * fallback row exists because announcing is younger than injecting: a wallet
 * that only fills the slot (an older extension, or the in-app browser of a
 * phone wallet) is still the only wallet there is, and must not be hidden by
 * a standard it does not implement yet.
 */
export function walletOptions(): WalletOption[] {
  const out: WalletOption[] = [...announced.values()].map((a) => ({
    id: a.info.rdns,
    name: a.info.name,
    icon: a.info.icon,
    open: () => Promise.resolve(a.provider),
  }));
  const injected = (window as unknown as { ethereum?: Eth1193 }).ethereum;
  if (out.length === 0 && injected) {
    out.push({ id: "injected", name: "Browser wallet", open: () => Promise.resolve(injected) });
  }
  if (WC_PROJECT_ID) {
    out.push({ id: "walletconnect", name: "WalletConnect", open: walletConnect });
  }
  return out;
}

/**
 * WalletConnect, fetched only when the row is clicked.
 *
 * `import()` and not a top-level import: this library is several times the
 * weight of everything else this app ships, and it is of no use at all to the
 * visitor who has an extension. The build keeps it in its own chunk next to
 * the page — same directory, same CID, relative path — so the default visit
 * pays nothing for it.
 *
 * `optionalChains` and not `chains`: a required namespace a wallet has never
 * heard of is a session it REFUSES outright, and Robinhood Chain is exactly
 * such a chain for every wallet that has not added it. Declaring it optional
 * gets the session open, and `ensureChain` then asks for the switch — or the
 * add — through the same two calls it already makes for an extension.
 */
export async function walletConnect(): Promise<Eth1193> {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const wc = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    optionalChains: [CHAIN_ID],
    rpcMap: { [CHAIN_ID]: RPC_URL },
    showQrModal: true,
    metadata: {
      name: PROJECT_NAME,
      description: "Creator fees, converted into stocks and paid to holders.",
      url: APP_URL,
      icons: [`${APP_URL}og.png`],
    },
  });
  // Reuses a session already in localStorage when there is one, so coming back
  // to the page is not a second QR code.
  await wc.enable();
  return wc as Eth1193;
}

/**
 * Puts the wallet on Robinhood Chain, adding the network if it does not know it.
 *
 * Reads go through our own transport, so a page renders correctly no matter
 * what network the wallet sits on — and the write then fails on a chain
 * mismatch that viem raises before anything reaches the user. That is a button
 * which does nothing when clicked, the worst shape a failure can take. Asking
 * for the switch is what turns it back into a wallet prompt.
 *
 * `report` rather than a direct call to a logger: this lives here so the claim
 * page and the launch form share ONE copy, and they write their messages to
 * different places.
 */
export async function ensureChain(eth: Eth1193, report: (s: string) => void): Promise<boolean> {
  const want = `0x${CHAIN_ID.toString(16)}`;
  if (((await eth.request({ method: "eth_chainId" })) as string).toLowerCase() === want) return true;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    return true;
  } catch (e) {
    // 4902: the wallet has never heard of this chain. Offer to add it rather
    // than sending the visitor to chainlist.org to find it themselves.
    if ((e as { code?: number }).code !== 4902) {
      report(`switch to Robinhood Chain in your wallet (${String((e as Error).message).split("\n")[0]?.slice(0, 60) ?? ""})`);
      return false;
    }
    try {
      await eth.request({ method: "wallet_addEthereumChain", params: [{
        chainId: want,
        chainName: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [EXPLORER],
      }] });
      return true;
    } catch {
      report("could not add Robinhood Chain to the wallet");
      return false;
    }
  }
}

/**
 * Just enough of the Uniswap v3 factory and pool to read a spot price. The
 * vault swaps through these same pools, so "what the fees bought, in dollars"
 * is priced where it was bought and not against an outside quote.
 */
export const poolAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address)",
]);

/** The only way into a Uniswap v4 singleton's per-pool state. `v4.ts` computes
 *  the slot; there is no pool contract to call and no getter to call on it. */
export const poolManagerAbi = parseAbi([
  "function extsload(bytes32) view returns (bytes32)",
]);

// ------------------------------------------------------------------- logs

/**
 * The widest `eth_getLogs` range either node will serve, minus a margin.
 *
 * **`fromBlock: 0n` does not work on this chain and has not for a while.** The
 * archive endpoint says it in words — `ranges over 10000 blocks are not
 * supported on free plan` — and the public node answers the same cap as
 * `-32000 internal server errror`, which reads like a node fault and is not
 * one. At 0.104 s a block that window is ~17 minutes of chain, so a 30-minute
 * epoch does not fit in one and every caller has to walk.
 *
 * Measured 2026-09-15: 8 000 blocks answer, 10 000 do not.
 */
export const LOG_SPAN = 9_000n;

/**
 * Walks BACKWARDS from head, one `LOG_SPAN` window at a time.
 *
 * `get` is a closure rather than a params object so viem keeps inferring the
 * log's shape from the `event` at the call site — the helper never sees the ABI.
 *
 * @param spans how far back to look, in windows (~15 min of chain each).
 * @param first stop at the first window that has anything. For a lookup of ONE
 *              known log (the active root's), which is otherwise `spans`
 *              requests to find something that is usually in the first two.
 */
export async function logsBack<T>(
  get: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  spans: number,
  first = false,
): Promise<T[]> {
  const head = await pub.getBlockNumber();
  const window = (i: number) => {
    const to = head - LOG_SPAN * BigInt(i);
    return { from: to > LOG_SPAN ? to - LOG_SPAN + 1n : 0n, to };
  };

  // Paced like the forward scan, and for the same reason: `spans` windows fired
  // from one `Promise.all` is a burst, and a burst is what the node answers
  // with a 429. Unlike `logsSince` this walker has NO retry of its own — the
  // parallel branch swallows a failed window as an empty one — so it keeps
  // reading through `pub`, whose transport retries. One layer here, one layer
  // there, never two.
  if (!first) {
    const all = await Promise.all(
      Array.from({ length: spans }, async (_, i) => {
        const { from, to } = window(i);
        if (to <= 0n) return [] as T[];
        await pace();
        return get(from, to).catch(() => [] as T[]);
      }),
    );
    return all.flat();
  }

  for (let i = 0; i < spans; i++) {
    const { from, to } = window(i);
    if (to <= 0n) break;
    await pace();
    const logs = await get(from, to);
    if (logs.length) return logs;
    if (from === 0n) break;
  }
  return [];
}

/** Attempts per window before a failure is allowed to take the scan down, and
 *  the first backoff in ms. Four attempts spend at most ~6 s on a window the
 *  node keeps refusing — worth it against re-scanning 270 of them. */
const WINDOW_TRIES = 4;
const WINDOW_BACKOFF_MS = 600;

/**
 * The gap between two window requests, for the whole page.
 *
 * **The rate is the lever, not the lane count.** The node throttles around 25
 * requests a second and answers past that with a `429` whose
 * `Access-Control-Allow-Origin` the browser rejects — so the refusal reaches
 * the app as "Failed to fetch" with no status, and looks like a network fault
 * rather than the quota it is. Six lanes with nothing between them issue as
 * fast as the round trip allows, which is well past that; 45 ms between starts
 * holds the page at ~22/s whatever the lane count, and the lanes then only
 * decide how deep the pipeline is.
 *
 * Measured 2026-09-16 on a cold allowlist scan of 268 windows: 893 requests
 * without it, against 268-odd with.
 */
export const MIN_GAP_MS = 45;
let nextSlot = 0;

/** Takes the next slot. Not a sleep per caller: each one reserves a moment on a
 *  shared line, so six lanes come out evenly spaced rather than in bursts of
 *  six followed by a silence. */
async function pace(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/**
 * One window, retried on anything that is not an answer.
 *
 * **Full jitter, not a fixed backoff.** Six lanes that sleep for the same
 * duration wake in the same millisecond and rebuild the burst that throttled
 * them; `Math.random()` over the whole interval is what spreads them out.
 *
 * It does not look at the error. A throttle reaches the browser as `Failed to
 * fetch` with no status (the node's 429 carries no CORS header, so the fetch
 * itself rejects and the status is gone), which is indistinguishable here from
 * a dropped connection — and both are worth one more try. A range the node
 * genuinely refuses still fails, four times, and still takes the scan down.
 */
async function tryWindow<T>(
  get: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pace();
      return await get(from, to);
    } catch (e) {
      if (attempt >= WINDOW_TRIES) throw e;
      const ceiling = WINDOW_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, Math.random() * ceiling));
    }
  }
}

/**
 * Every log from `from` to head, in `LOG_SPAN` windows read `lanes` at a time.
 *
 * The counterpart of `logsBack` for a range whose FLOOR is known — the
 * registry's deployment block (`PAYD_BLOCK`), which is the only thing that can
 * replace the `fromBlock: 0n` the node refuses.
 *
 * **The lane count is not the lever it looks like.** The node throttles around
 * 25 requests a second: measured 2026-09-15 over the registry's 2.4 M blocks,
 * 6 lanes scan in 11.2 s, 8 in 11.9 s and 10 in 10.3 s, and 12 only earns a
 * 429. What makes this affordable is the CALLER'S CACHE, not the parallelism —
 * a second visit resumes from the cursor and scans one window.
 *
 * **A partial scan is returned, not thrown away — but only its contiguous
 * PREFIX.** A result with a hole in it looks exactly like a complete one, and a
 * caller that cached that would hold a truncated allowlist for ever: a missed
 * `StockRemoved` offers a delisted stock, and the create form builds a basket
 * the registry rejects. A prefix has no hole. It is not "part of the history",
 * it is the whole history up to a LOWER head, and `upTo` says which — so the
 * caller caches something exact and the next visit resumes from there instead
 * of re-walking 268 windows it has already paid for.
 *
 * That is what this chain needs rather than all-or-nothing. Measured
 * 2026-09-16 against the public node: a cold allowlist scan issued 893
 * requests in 45 s, never finished, and therefore cached NOTHING — so the
 * following visit started again from the registry's deployment block, and so
 * did the one after that. The screen was not slow, it was stuck in a loop it
 * could not get out of. Only a scan whose very first window fails still throws,
 * because then there is no prefix and nothing true to say.
 *
 * **Which is why a window is retried before it is allowed to do that.** The
 * registry's history is ~270 windows and the node throttles: one throttled
 * window out of 270 killed the whole create screen, which reported `HTTP
 * request failed … Failed to fetch` — a browser saying it never got an answer,
 * not a chain saying anything. viem's own `retryCount: 3` does not cover it:
 * its backoff is 150/300/600 ms, shorter than a rate-limit window, and all six
 * lanes serve theirs at once so the burst that earned the throttle is reissued
 * intact. `tryWindow` below is the same idea at the right scale, with jitter so
 * the lanes come back apart.
 *
 * @returns the logs, the block they actually reach (the cursor to store), and
 *   the head at the time of the scan. `upTo < head` means the scan was cut
 *   short and the caller is looking at a true but older picture.
 */
export async function logsSince<T>(
  from: bigint,
  get: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  lanes = 6,
): Promise<{ logs: T[]; upTo: bigint; head: bigint }> {
  const head = await pub.getBlockNumber();
  if (from > head) return { logs: [], upTo: head, head };

  const windows: [bigint, bigint][] = [];
  for (let f = from; f <= head; f += LOG_SPAN) {
    const to = f + LOG_SPAN - 1n;
    windows.push([f, to > head ? head : to]);
  }

  // Indexed rather than appended, so the result keeps chain order however the
  // lanes interleave. `fold` sorts on `at` and does not need it; `quotelist`
  // reads the order as given and would.
  const out: (T[] | undefined)[] = new Array(windows.length);
  let next = 0;
  let failure: unknown = null;
  await Promise.all(Array.from({ length: Math.min(lanes, windows.length) }, async () => {
    for (;;) {
      const i = next++;
      const w = windows[i];
      if (!w) return;
      try {
        out[i] = await tryWindow(get, w[0], w[1]);
      } catch (e) {
        // This lane stops rather than pulling the next window: past the first
        // hole nothing it reads can be kept anyway, and on a node that is
        // throttling, not asking is the only thing that helps.
        if (failure === null) failure = e;
        return;
      }
    }
  }));

  let done = 0;
  while (done < windows.length && out[done] !== undefined) done++;
  if (done === 0) throw failure;
  return {
    logs: (out.slice(0, done) as T[][]).flat(),
    upTo: windows[done - 1]![1],
    head,
  };
}
