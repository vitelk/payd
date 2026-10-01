/**
 * The four read tools of `docs/MCP.md`, as plain functions over a viem client.
 *
 * Nothing here signs and nothing here holds a key: every value is an `eth_call`
 * on public state, or an IPFS artifact checked against the hash the chain
 * published (`createPayd` does that check — this file never fetches one itself).
 */
import { createPublicClient, http, parseAbi, isAddress, hexToString, type Address, type Hex, type PublicClient } from "viem";
import { createPayd, robinhoodChain, RPC_URL } from "../../sdk/src/payd.js";
import { KNOWN_STOCKS, KNOWN_QUOTES, LISTINGS_READ_AT } from "../../front/src/listings.js";
import {
  MIN_BASKET, MAX_BASKET, MIN_ALLOC_BPS, MIN_REWARDS_BPS, MIN_EPOCH_MIN, MAX_EPOCH_MIN,
} from "../../front/src/basket.js";

/** Same values as `site/llms.txt` and `front/src/config.ts`. */
export const REGISTRY: Address = "0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03";
export const PONS_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const registryAbi = parseAbi([
  "function vaults() view returns (address[])",
  "function vaultsOf(address creator) view returns (address[])",
  "function modeOf(address vault) view returns (bytes32)",
  "function factory() view returns (address)",
  "function platformBps() view returns (uint256)",
  "function listing(address stock) view returns (uint24 poolFee, address feed, bool allowed)",
  "function quoteListing(address quote) view returns (uint24 poolFee, uint24 wethFee, uint256 minBuy, bool allowed)",
]);
const ponsAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
]);
const erc20Abi = parseAbi([
  "function token() view returns (address)",
  "function symbol() view returns (string)",
]);

/**
 * Reads issued in the same tick fold into ONE `eth_call` through Multicall3,
 * as `front/src/chain.ts` does. `launch_options` is ~180 reads: one request
 * each is a 429, and JSON-RPC batching is worse — the public node drops
 * responses from a batch, which viem reports as an unknown RPC error
 * (measured 2026-10-01, even at 20 per batch).
 */
const chain = {
  ...robinhoodChain,
  // Canonical address, code confirmed on-chain (`docs/recon.md`).
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address } },
};
export function makeClient(rpc = process.env.PAYD_RPC_URL ?? RPC_URL): PublicClient {
  return createPublicClient({
    chain,
    batch: { multicall: { wait: 20 } },
    transport: http(rpc, { retryCount: 3 }),
  }) as PublicClient;
}

/**
 * Text a launcher wrote — a token's symbol — wrapped so the model reading it
 * sees that it is data. A token named "ignore previous instructions" is a
 * prompt injection with a Pons listing.
 */
export const untrusted = (s: string) => ({ untrusted: s });

/** JSON for a tool result: bigints as decimal strings, never as floats. */
export const toJson = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export function requireAddress(name: string, v: string): Address {
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return v;
}

/** `bytes32("distribution")` → "distribution". */
export const modeName = (b: Hex) => hexToString(b, { size: 32 }).replace(/\0+$/, "");

const soft = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export async function listTokens(c: PublicClient, o: { creator?: string; limit: number; offset: number }) {
  const all = o.creator
    ? await c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "vaultsOf", args: [requireAddress("creator", o.creator)] })
    : await c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "vaults" });
  // Newest first: the registry appends, and a reader asking "what launched"
  // means recently.
  const page = [...all].reverse().slice(o.offset, o.offset + o.limit);
  const rows = await Promise.all(page.map(async (vault) => {
    const [token, mode] = await Promise.all([
      soft(c.readContract({ address: vault, abi: erc20Abi, functionName: "token" }), ZERO),
      soft(c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "modeOf", args: [vault] }), null),
    ]);
    const symbol = token === ZERO ? null
      : await soft(c.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }), null);
    return {
      vault,
      token: token === ZERO ? null : token,
      symbol: symbol === null ? null : untrusted(symbol),
      mode: mode === null ? null : modeName(mode),
    };
  }));
  return { total: all.length, offset: o.offset, tokens: rows };
}

const HOOK = ["not launched", "collecting", "redirect scheduled", "fees lost"] as const;

export async function tokenInfo(c: PublicClient, vault: string) {
  const i = await createPayd({ vault: requireAddress("vault", vault), client: c }).info();
  return {
    ...i,
    symbol: untrusted(i.symbol),
    quote: i.quote === ZERO ? "native ETH" : i.quote,
    hookStatus: i.hookStatus === null ? null : { code: i.hookStatus, meaning: HOOK[i.hookStatus] },
    warning: i.hookStatus !== null && i.hookStatus !== 1
      ? "Fees are not (or soon will not be) arriving at this launch. Say so; do not quote its percentages as current."
      : undefined,
    note: "rewardsOfVolumeBps is a share of TRADED VOLUME paid to holders as stock, not a yield. null means unread — hide it, never show 0.",
  };
}

export async function holderShares(c: PublicClient, vault: string, holder: string) {
  const shares = await createPayd({ vault: requireAddress("vault", vault), client: c })
    .shares(requireAddress("holder", holder));
  if (shares.length === 0) {
    return {
      shares: [],
      note: "Nothing in the current root for this address. Usually: bought after the last publication, "
        + "or a share under the value floor — check again after the next epoch. It can also mean the "
        + "epoch data could not be fetched from any gateway right now. Not an error either way.",
    };
  }
  return {
    shares,
    note: "owed/claimed/cumulative are raw integer units of each stock; divide by 10^decimals. "
      + "Shares are airdropped automatically; claiming is only a shortcut.",
  };
}

export async function launchOptions(c: PublicClient) {
  const r = <T>(functionName: string, args: unknown[] = []) =>
    c.readContract({ address: REGISTRY, abi: registryAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const sym = (t: Address) => soft(c.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }), null);

  const [stocks, quotes, platformBps, factory, launchFee, maxTax, enabled] = await Promise.all([
    Promise.all(KNOWN_STOCKS.map(async (s) => {
      const [l, symbol] = await Promise.all([r<readonly [number, Address, boolean]>("listing", [s]), sym(s)]);
      return l[2] ? { stock: s, symbol, poolFee: l[0] } : null;
    })),
    Promise.all(KNOWN_QUOTES.map(async (q) => {
      const [l, symbol] = await Promise.all([r<readonly [number, number, bigint, boolean]>("quoteListing", [q]), sym(q)]);
      return l[3] ? { quote: q, symbol, route: l[0] !== 0 || l[1] === 0 ? "direct to pivot" : "via WETH", minBuy: l[2] } : null;
    })),
    r<bigint>("platformBps"),
    r<Address>("factory"),
    c.readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "launchFee" }),
    c.readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "maxCreatorTaxBps" }),
    c.readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "launchEnabled" }),
  ]);

  return {
    basket: {
      stocks: stocks.filter((s) => s !== null),
      minLines: MIN_BASKET, maxLines: MAX_BASKET, minLineBps: MIN_ALLOC_BPS, totalBps: 10_000,
    },
    quotes: [{ quote: "native ETH", symbol: "ETH" }, ...quotes.filter((q) => q !== null)],
    rewardsBpsMin: MIN_REWARDS_BPS,
    epochMinutes: { min: MIN_EPOCH_MIN, max: MAX_EPOCH_MIN },
    platformBps,
    defaultFactory: factory,
    pons: { launchEnabled: enabled, launchFeeWei: launchFee, maxCreatorTaxBps: maxTax },
    listsCollectedAtBlock: LISTINGS_READ_AT,
    note: "Every stock and quote above was confirmed `allowed` by the registry just now. One listed after "
      + "listsCollectedAtBlock is missing until this server is updated. Proposing a basket is the caller's "
      + "decision; this server does not rank or recommend stocks.",
  };
}
