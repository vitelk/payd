import { createPublicClient, http, parseAbi, defineChain } from "viem";
import { RPC_URL, CHAIN_ID, EXPLORER } from "./config.js";

export const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 3 }) });

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
export const provider = (): Eth1193 | null =>
  (window as unknown as { ethereum?: Eth1193 }).ethereum ?? null;

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
