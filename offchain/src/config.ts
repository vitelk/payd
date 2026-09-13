/**
 * Addresses verified on-chain on Robinhood Chain (chainId 4663).
 * Source and verification method: docs/recon.md §1.1 and §3.1.
 */
export const CHAIN_ID = 4663;
export const RPC_URL = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
export const PONS_V2_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as const;
export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/**
 * `ArbGasInfo`, the Nitro precompile that prices a transaction. We read one
 * field of it: `getL1BaseFeeEstimate()`, which is **0 on this chain** — the L1
 * pricer is switched off, so calldata is free and the whole gas-refund model
 * holds (docs/recon.md §10.7, measured 2026-09-04).
 *
 * It is a chain *setting*, not a property of Orbit. The operator can turn it on
 * and nothing in the contracts would notice, so the keeper re-reads it every
 * tick.
 */
export const ARB_GAS_INFO = "0x000000000000000000000000000000000000006C" as const;

/**
 * The public RPC serves logs but NOT historical state: an `eth_call` at an old
 * block returns "metadata is not found" beyond a few thousand blocks (verified
 * 2026-09-03). That is why the snapshot replays `Transfer` events instead of
 * calling `balanceOf` in the past — and that is what lets anyone recompute with
 * the free RPC, without an archive node.
 */
export const LOG_CHUNK = 50_000;

/**
 * Eligibility threshold, expressed as the VALUE of the share rather than a
 * number of tokens (docs/ARCHITECTURE.md §S14).
 *
 * A fixed threshold as a % of supply does exactly the wrong thing: at launch the
 * share is worth fractions of a cent for everybody, and later the same
 * percentage excludes real holders. Expressed as a value, the threshold loosens
 * by itself as revenue grows.
 *
 * The denominator is the ETH CUMULATED since genesis, not the epoch's: with the
 * epoch's ETH the threshold would be 48x harsher on 30-minute epochs than on
 * one-day epochs, and changing the epoch length would silently redefine who is
 * owed what (§S17).
 *
 * START_BALANCE is the starting point: 1,000,000 tokens. On a 1 B supply that is
 * 0.1 %, so at most 1,000 eligible holders at the start. The cap stops binding at
 *
 *     crossover = MIN_SHARE_WEI * candidateSupply / START_BALANCE
 *
 * after which the formula takes over and the threshold falls on its own.
 *
 * CANDIDATE supply, not total supply: the pool, the bonding curve, `FeeVault`,
 * `Distributor`, `0x0` and `excluded[]` are all out of that sum. The table below
 * therefore describes a token entirely in holders' hands. The crossover scales
 * down with what actually circulates — with a tenth of the supply out of the
 * curve it lands at 0.02 ETH, not 0.2 — and that is correct rather than early:
 * with a tenth of the supply circulating, a tenth of the balance is worth the
 * same share.
 *
 *     0.2 ETH cumulative -> 1,000,000 tokens   (0.1 % of a 1 B CANDIDATE supply)
 *       1 ETH            ->   200,000
 *       5 ETH            ->    40,000
 *      20 ETH            ->    10,000
 *     100 ETH            ->     2,000
 *
 * A share once earned is earned for good: the threshold decides who earns a
 * share in a given epoch, never who keeps what they already earned.
 */
export const MIN_SHARE_WEI = 200_000_000_000_000n; // 0.0002 ETH ~ $0.48

/**
 * The same threshold on a vault that is not quoted in ether, in bps of that
 * vault's `MIN_BUY_QUOTE`.
 *
 * **`MIN_SHARE_WEI` is wei and the quantity it is compared against is not.**
 * `applyFloor` weighs it against the CUMULATIVE `quoteSpent`, which
 * `FeeVault._buyLegs` denominates in the vault's own currency. The two failure
 * modes are the ones the delivery floor had, and the first is total:
 *
 *     USDG  (6 dec)   the floor works out at `balance >= 200,000 x supply`
 *                     -> NO holder is ever eligible, the tree is EMPTY and
 *                        nothing is distributed at all
 *     NVDA  (18 dec)  2e14 raw units is 0.0002 NVDA ~ $0.045, not $0.48
 *                     -> ten times too permissive
 *
 * 192 bps of `MIN_BUY_QUOTE` is $0.48 against its ~$25, i.e. the same threshold
 * in the vault's own units. `MIN_BUY_QUOTE` is written at birth and never
 * written again, so a verifier replaying an old root through `buildCumulative`
 * derives the identical figure — which is the binding constraint, this being
 * part of the root and not a keeper heuristic.
 */
export const NON_ETH_MIN_SHARE_BPS = 192n;
export const START_BALANCE = 1_000_000n * 10n ** 18n; // 1 M tokens, 18 decimals

/**
 * The eligibility floor for one vault, in the units its shares are in.
 *
 * Same shape and same reason as `pushFloorFor`: the constant is wei, the
 * quantity it is weighed against is not, and `MIN_BUY_QUOTE` is the only
 * dollar-denominated figure a vault carries. See `NON_ETH_MIN_SHARE_BPS`.
 *
 * It lives here rather than beside `pushFloorFor` because `snapshot.ts` needs
 * it and `epoch.ts` already imports `snapshot.ts`: the other way round is a
 * cycle.
 */
export function minShareFor(quote: string, minBuyQuote: bigint): bigint {
  if (quote === "0x0000000000000000000000000000000000000000") return MIN_SHARE_WEI;
  return (minBuyQuote * NON_ETH_MIN_SHARE_BPS) / 10_000n;
}
