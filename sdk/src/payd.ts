/**
 * `@payd/sdk` — the headless half.
 *
 * What the creator wants on their site comes down to three questions: what does
 * this vault promise (`info`), what does MY address have pending (`shares`), and
 * how do I take it (`claim`). The rest — the epochs, the IPFS artifact, the
 * shape of the Merkle tree — is plumbing that must never surface in their code.
 *
 * Read-only and serverless, exactly like `front/`: everything comes from an
 * `eth_call` made in the visitor's browser. No key, no indexer, nothing to host.
 *
 * **The vault is the ONLY required parameter.** `DISTRIBUTOR`, `token`, the
 * basket and the economics are all read from it — copying a second address into
 * a third-party site is the guarantee that one of the two will one day be
 * stale.
 */
import {
  createPublicClient, createWalletClient, custom, http, defineChain, parseAbi,
  isAddress, type Address, type Hex, type PublicClient,
} from "viem";
// The only two front-end modules reused as they are, and that is no accident:
// they are the two where a one-bit divergence invalidates everything.
// `merkle.ts` reproduces OpenZeppelin's tree shape (a wrong proof reverts
// on-chain after the holder has paid the gas), `cid.ts` rebuilds the IPFS
// address from the published hash. They import nothing but viem — no config,
// nothing global — and the library build inlines them into `dist/`, so the
// published package stays self-contained. Their tests
// (`front/src/*.test.ts`) guard them for both of us.
import { claimTree, type Entry } from "../../front/src/merkle.js";
import { cidFromSha256 } from "../../front/src/cid.js";
// The degrade-don't-throw rule, shared with the app because both had the same
// defect against the same contracts. See `front/src/num.ts`.
import { toNum, toNumMax, soft } from "../../front/src/num.js";
import { sha256, toHex, parseAbiItem } from "viem";

export const CHAIN_ID = 4663;
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

/** The gateways tried in order. Filebase first: it is the service the keeper
 *  pins to, hence the only one that always holds the content. A gateway is never
 *  taken at its word — see `fetchArtifact`. */
export const GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
];

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function DISTRIBUTOR() view returns (address)",
  "function QUOTE() view returns (address)",
  "function CREATOR() view returns (address)",
  "function rewardsPool() view returns (uint256)",
  "function payoutBps() view returns (uint256)",
  "function hookStatus() view returns (uint8 status, address current, uint64 effectiveAt)",
  "function economics() view returns (uint256 taxBps, uint256 curveFeeBps, uint256 ponsShareBps, uint256 grossOfVolumeBps, uint256 rewardsOfVolumeBps, uint256 creatorOfVolumeBps, uint256 platformOfVolumeBps)",
  "function getAllocations() view returns ((address stock, uint24 poolFee, uint16 bps, address feed)[])",
]);

// CAREFUL: the `roots` tuple has to follow `Distributor.Root` field for field.
// Skipping one raises no error — viem decodes a word too early and EVERYTHING
// after it slides by one slot, so that `digest` actually returns `upToEpoch` and
// the artifact is never found.
const distributorAbi = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function epochEnd(uint256) view returns (uint256)",
  "function EPOCH_LENGTH() view returns (uint256)",
  "function rootCount() view returns (uint256)",
  "function activeRoot() view returns (uint256)",
  "function roots(uint256) view returns (address publisher, uint40 publishedAt, bytes32 claimRoot, bytes32 pushRoot, uint48 upToEpoch, bytes32 digest)",
  "function owedTo(address holder, address stock, uint256 cumulative) view returns (uint256)",
  "function claimedSoFar(address, address) view returns (uint256)",
  "function totalFunded(address) view returns (uint256)",
  "function claim(address[] stocks, uint256[] cumulative, bytes32[][] proofs) returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const ROOT_PUBLISHED = parseAbiItem(
  "event RootPublished(uint256 indexed rootId, address indexed publisher, bytes32 claimRoot, bytes32 pushRoot, uint256 upToEpoch, bytes32 digest, string cid)",
);

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** The epoch artifact, as the keeper serialises it (`offchain/src/epoch.ts`). */
interface Artifact {
  upToEpoch: number;
  excluded: string[];
  entries: (Entry & { push: boolean })[];
}

export interface Leg {
  stock: Address;
  symbol: string;
  /** Weight in the basket, in bps (they add up to 10 000). */
  bps: number;
}

export interface VaultInfo {
  vault: Address;
  distributor: Address;
  token: Address;
  symbol: string;
  decimals: number;
  creator: Address;
  /** `address(0)` = native ETH. A vault has exactly one quote currency. */
  quote: Address;
  /** The share of TRADED VOLUME that goes to the holders, in bps. It is the
   *  figure that compares from one launch to another — not the vault's share.
   *
   *  `null` throughout this interface means UNAVAILABLE, and the caller is
   *  expected to HIDE the line rather than draw a zero: a read that did not
   *  answer and a launch that pays nothing are not the same fact, and only one
   *  of them is ours to state. */
  rewardsOfVolumeBps: number | null;
  creatorOfVolumeBps: number | null;
  /** What a trade pays in total (tax + curve fee), in bps. */
  totalFeeBps: number | null;
  epochLength: number | null;
  currentEpoch: number | null;
  /** UNIX timestamp at which the current epoch ends. */
  epochEnd: number | null;
  /** 0 not launched · 1 collecting · 2 redirection scheduled · 3 fees lost. */
  hookStatus: 0 | 1 | 2 | 3 | null;
  /** Empty when the basket could not be read — never a partial one. */
  basket: Leg[];
}

export interface Share {
  stock: Address;
  symbol: string;
  decimals: number;
  /** Pending, in the stock's raw units. It is the figure that matters. */
  owed: bigint;
  /** Already received since the beginning. */
  claimed: bigint;
  /** Total earned since genesis (`owed + claimed`). */
  cumulative: bigint;
}

export interface PaydOptions {
  vault: Address;
  /** Robinhood Chain's public RPC by default. */
  rpc?: string;
  /** IPFS gateways to try, in order. */
  gateways?: string[];
  /** An already-built viem client, when the host has one. */
  client?: PublicClient;
}

/** EIP-1193, what `window.ethereum` exposes. */
export type Eth1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

export interface ClaimResult {
  hash: Hex;
  stocks: Address[];
}

export function createPayd(opts: PaydOptions) {
  // Trust boundary: an invalid address otherwise gives an `eth_call` that
  // returns `0x` and a page showing zeros without saying anything.
  if (!isAddress(opts.vault)) throw new Error(`payd: invalid vault address: ${opts.vault}`);
  const vault = opts.vault as Address;
  const gateways = opts.gateways ?? GATEWAYS;
  const pub = opts.client ?? createPublicClient({
    chain: robinhoodChain,
    transport: http(opts.rpc ?? RPC_URL, { retryCount: 3 }),
  });

  const readV = (fn: string, args: unknown[] = []) =>
    pub.readContract({ address: vault, abi: vaultAbi, functionName: fn as never, args: args as never });
  const readD = (d: Address, fn: string, args: unknown[] = []) =>
    pub.readContract({ address: d, abi: distributorAbi, functionName: fn as never, args: args as never });

  const meta = new Map<Address, { symbol: string; decimals: number }>();
  /** A token with no readable `symbol()` returns its short address rather than
   *  taking the whole card down. */
  async function tokenMeta(t: Address) {
    const hit = meta.get(t);
    if (hit) return hit;
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => `${t.slice(0, 6)}…`),
      pub.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    ]);
    const m = { symbol: symbol as string, decimals: Number(decimals) };
    meta.set(t, m);
    return m;
  }

  let distributorAddr: Address | null = null;
  async function distributor(): Promise<Address> {
    return (distributorAddr ??= (await readV("DISTRIBUTOR")) as Address);
  }

  /**
   * Fetches the active epoch's JSON and VERIFIES it against the on-chain hash.
   *
   * The gateway is never taken at its word: if the content's sha256 does not
   * match the `digest` the contract published, it is rejected. So a hostile
   * gateway can only make the call unusable, never falsify an amount or an
   * address.
   *
   * Two addresses are tried: the CID the keeper put in `RootPublished` — the
   * only valid one once the artifact exceeds an IPFS block, around 160 holders —
   * then the CIDv1 rebuilt from the digest, which covers the case where the
   * chain no longer serves old logs.
   */
  async function fetchArtifact(d: Address, digest: Hex, rootId: bigint): Promise<Artifact | null> {
    if (digest === ZERO32) return null;
    const paths: string[] = [];
    try {
      const logs = await pub.getLogs({ address: d, event: ROOT_PUBLISHED, args: { rootId }, fromBlock: "earliest" });
      const cid = (logs.at(-1) as { args?: { cid?: string } } | undefined)?.args?.cid;
      if (cid) paths.push(cid);
    } catch { /* the fallback covers it */ }
    paths.push(cidFromSha256(digest));

    for (const path of paths) {
      for (const gw of gateways) {
        try {
          const res = await fetch(gw.trim() + path);
          if (!res.ok) continue;
          const text = await res.text();
          if (sha256(toHex(text)) !== digest) continue; // does not match what was published
          return JSON.parse(text) as Artifact;
        } catch { /* next gateway */ }
      }
    }
    return null;
  }

  /** The ACTIVE root's artifact, or null while none has been published. */
  async function activeArtifact(): Promise<{ artifact: Artifact | null; rootId: bigint; d: Address }> {
    const d = await distributor();
    const rootId = (await readD(d, "activeRoot")) as bigint;
    if (rootId === 0n) return { artifact: null, rootId, d };
    const root = (await readD(d, "roots", [rootId])) as readonly unknown[];
    return { artifact: await fetchArtifact(d, root[5] as Hex, rootId), rootId, d };
  }

  return {
    vault,
    distributor,

    /** Everything a card shows, in one round of reads. */
    async info(): Promise<VaultInfo> {
      const d = await distributor();
      // EVERY read here degrades. The one that did not — `getAllocations` — is
      // what took the whole card down when the element was pointed at a v1
      // vault: viem decodes that tuple's `uint24 poolFee` from a word holding
      // an address, refuses the range, and one rejection inside `Promise.all`
      // rejects all eight. An empty basket is a card missing a row; a
      // rejection is a card that is nothing but an error message.
      const [token, quote, creator, econ, allocs, epoch, len, hook] = await Promise.all([
        readV("token") as Promise<Address>,
        soft(readV("QUOTE") as Promise<Address>, ZERO),
        soft(readV("CREATOR") as Promise<Address>, ZERO),
        // A Pons getter that moves makes this return zero: we would rather
        // show nothing than a stale percentage.
        soft(readV("economics") as Promise<readonly bigint[]>, []),
        soft(readV("getAllocations") as Promise<readonly { stock: Address; poolFee: number; bps: number }[]>, []),
        soft(readD(d, "currentEpoch") as Promise<bigint | null>, null),
        soft(readD(d, "EPOCH_LENGTH") as Promise<bigint | null>, null),
        soft(readV("hookStatus") as Promise<readonly [number, Address, bigint]>, [0, ZERO, 0n] as const),
      ]);
      // `epochEnd` takes the epoch we just read as its argument, so a bad
      // `currentEpoch` must not be forwarded: it would be encoded, sent, and
      // answered with something meaningless rather than refused.
      const [end, tokenM, legs] = await Promise.all([
        epoch === null ? null : soft(readD(d, "epochEnd", [epoch]) as Promise<bigint | null>, null),
        token === ZERO ? { symbol: "?", decimals: 18 } : tokenMeta(token),
        Promise.all(allocs.map(async (a) => {
          const bps = toNumMax(a.bps, 10_000);
          if (bps === null || !isAddress(a.stock)) return null;
          return { stock: a.stock, symbol: (await tokenMeta(a.stock)).symbol, bps };
        })),
      ]);
      // A leg that did not decode is dropped, not shown at zero. If any was
      // dropped the basket no longer adds up to 10 000 bps, so it is not a
      // basket — the card shows none rather than a plausible wrong one.
      const basket: Leg[] = legs.every((l) => l !== null) ? (legs as Leg[]) : [];
      return {
        vault, distributor: d, token, creator, quote,
        symbol: tokenM.symbol, decimals: tokenM.decimals,
        rewardsOfVolumeBps: toNumMax(econ[4], 10_000),
        creatorOfVolumeBps: toNumMax(econ[5], 10_000),
        totalFeeBps: econ[0] === undefined || econ[1] === undefined
          ? null : toNumMax(econ[0] + econ[1], 10_000),
        epochLength: toNum(len),
        currentEpoch: toNum(epoch),
        epochEnd: toNum(end),
        hookStatus: toNumMax(hook[0], 3) as VaultInfo["hookStatus"],
        basket,
      };
    },

    /**
     * What `holder` can take right now, one element per stock.
     *
     * An empty array if the address is not in the active root — a holder who
     * arrived after the last publication, or below the threshold. That is not an
     * error, it is the answer.
     */
    async shares(holder: Address): Promise<Share[]> {
      if (!isAddress(holder)) throw new Error(`payd: invalid holder address: ${holder}`);
      const { artifact, d } = await activeArtifact();
      if (!artifact) return [];
      const mine = artifact.entries.filter((e) => e.holder.toLowerCase() === holder.toLowerCase());
      return Promise.all(mine.map(async (e) => {
        const stock = e.stock as Address;
        const [m, owed, claimed] = await Promise.all([
          tokenMeta(stock),
          readD(d, "owedTo", [holder, stock, BigInt(e.cumulative)]) as Promise<bigint>,
          readD(d, "claimedSoFar", [holder, stock]) as Promise<bigint>,
        ]);
        return { stock, symbol: m.symbol, decimals: m.decimals, owed, claimed, cumulative: BigInt(e.cumulative) };
      }));
    },

    /**
     * Sends the settlement. Returns the hash, or `null` if there was nothing.
     *
     * The artifact is RE-READ just before building the proofs, never the one a
     * `shares()` from ten minutes ago returned: the keeper publishes one root
     * per epoch, and a proof built on the old one reverts the WHOLE batch with
     * `InvalidProof`. A read costs less than a failed transaction, of which the
     * wallet shows nothing but a mute "execution reverted".
     *
     * `only` restricts to the given stocks; without it everything owed leaves.
     */
    async claim(holder: Address, o: { eth?: Eth1193; only?: Address[] } = {}): Promise<ClaimResult | null> {
      if (!isAddress(holder)) throw new Error(`payd: invalid holder address: ${holder}`);
      const eth = o.eth ?? (globalThis as { ethereum?: Eth1193 }).ethereum;
      if (!eth) throw new Error("payd: no wallet detected");

      const { artifact, d } = await activeArtifact();
      if (!artifact) throw new Error("payd: epoch data not found on any gateway");

      // The CLAIM tree, not the push one: `claim()` checks against `claimRoot`
      // (every entry), `distribute()` against `pushRoot` (only the ones large
      // enough to deserve a delivery). A proof built on the wrong tree clears
      // every check here and reverts on-chain.
      const tree = claimTree(artifact.entries);
      const pick = o.only && new Set(o.only.map((a) => a.toLowerCase()));
      const stocks: Address[] = [], cumulative: bigint[] = [], proofs: Hex[][] = [];
      for (const e of artifact.entries) {
        if (e.holder.toLowerCase() !== holder.toLowerCase()) continue;
        const stock = e.stock as Address;
        if (pick && !pick.has(stock.toLowerCase())) continue;
        // A stock at zero would pass the Merkle check while delivering nothing,
        // and the caller would pay for its branch anyway.
        const owed = (await readD(d, "owedTo", [holder, stock, BigInt(e.cumulative)])) as bigint;
        if (owed === 0n) continue;
        const proof = tree.proofFor(holder, stock);
        if (!proof) continue;
        stocks.push(stock); cumulative.push(BigInt(e.cumulative)); proofs.push(proof);
      }
      if (stocks.length === 0) return null;

      await ensureChain(eth);
      const wallet = createWalletClient({ account: holder, chain: robinhoodChain, transport: custom(eth) });
      const hash = await wallet.writeContract({
        address: d, abi: distributorAbi, functionName: "claim",
        args: [stocks, cumulative, proofs], account: holder, chain: robinhoodChain,
      });
      return { hash, stocks };
    },
  };
}

export type Payd = ReturnType<typeof createPayd>;

/**
 * Puts the wallet on Robinhood Chain, adding the network if it does not know it.
 *
 * The reads go through our own transport, so a card renders correctly whatever
 * network the wallet is on — and the write then fails on a mismatch viem raises
 * before anything reaches the user. That is a button that does nothing when
 * clicked, the worst kind of failure.
 */
export async function ensureChain(eth: Eth1193): Promise<void> {
  const want = `0x${CHAIN_ID.toString(16)}`;
  if (((await eth.request({ method: "eth_chainId" })) as string).toLowerCase() === want) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    // 4902: the wallet has never heard of this chain. We offer it rather than
    // sending the visitor off to find it on chainlist.org.
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: want,
      chainName: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: [RPC_URL],
      blockExplorerUrls: [EXPLORER],
    }] });
  }
}

/** Asks the wallet for the accounts and returns the first. */
export async function connect(eth?: Eth1193): Promise<Address> {
  const e = eth ?? (globalThis as { ethereum?: Eth1193 }).ethereum;
  if (!e) throw new Error("payd: no wallet detected");
  const accounts = (await e.request({ method: "eth_requestAccounts" })) as Address[];
  const a = accounts[0];
  if (!a) throw new Error("payd: the wallet returned no account");
  return a;
}
