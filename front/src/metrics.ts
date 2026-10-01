/**
 * metrics.ts — the yield, read from the chain. The impure half.
 *
 * `yield.ts` and `v4.ts` are arithmetic and are deliberately chainless. This is
 * the file that goes and gets the numbers, and it exists as its own module for
 * one reason: **two pages show them**. The app renders them as cards in the
 * vault view; the shop window renders them under the contract address, from a
 * separate bundle that shares no DOM with the app. Written twice they would
 * drift, and two pages of ours quoting different yields for the same vault in
 * the same minute is worse than neither quoting one.
 *
 * Three reads, each with a way of being quietly wrong — see `v4.ts` for the
 * third, which is the dangerous one.
 */
import { formatUnits, formatEther, type Address, type Hex } from "viem";
import {
  DISTRIBUTOR, FEE_VAULT, V3_FACTORY, USDG, WETH, WETH_USDG_FEE,
  POOL_MANAGER, DEAD, PONS_FACTORY, PONS_V4_HOOK,
} from "./config.js";
import { pub, distributorAbi, vaultAbi, erc20Abi, poolAbi, poolManagerAbi } from "./chain.js";
import { ponsRegistryAbi } from "./pons.js";
import { spotPrice, floatOf, type YieldInput } from "./yield.js";
import { poolId, slot0Slot, decodeSlot0, priceOfCurrency1 } from "./v4.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export interface Metrics extends YieldInput {
  /** The vault's basket, already read — the caller usually wants it too. */
  stocks: number;
  /**
   * The token's Uniswap v4 pool id, or `null` before graduation.
   *
   * Returned rather than kept private because it is also **the only address a
   * price chart needs**: DexScreener indexes this chain's v4 pools under the
   * poolId itself, so `dexscreener.com/robinhood/<pairId>` is the launch's
   * chart with no lookup, no API key and no extra read — this is the same
   * `poolId(...)` the price below is derived from, handed back instead of
   * computed twice. Checked on 2026-09-28 against their own `pairAddress` for
   * $PAYD: `0xc667622f…d8fc`, identical.
   *
   * `null` before phase 2 is not a failure: the token is still on the bonding
   * curve, there is no pool to chart, and the page shows the curve gauge there
   * instead.
   */
  pairId: Hex | null;
  /**
   * Share of the supply sitting at `0xdead`, as a percentage.
   *
   * Measured from the BALANCE and not from a list of our own transactions, so
   * the figure stays true whoever burns next. Today every token of it is ours:
   * `eth_getLogs` on 2026-09-14 returns exactly two transfers into `0xdead`,
   * both from the Safe `0x5a4A5DEc…` on 13 September (36 104 858 then
   * 26 750 992 tokens), and their sum equals the balance to the wei. That is
   * what lets the page say "burnt by us" rather than "burnt"; if a third party
   * ever burns, this number stays correct and only the wording would need
   * revisiting.
   *
   * `totalSupply` is untouched at 1e27 — the tokens went to an address nobody
   * holds the key to rather than through `burn()`, so the denominator does not
   * move under this number.
   */
  burntPct: number;
}

/**
 * A token's price in dollars, on the v3 pool the vault swaps it through.
 *
 * Tier zero is USDG itself: the pivot has no pool against itself and a dollar
 * is a dollar (`FeeVault._setAllocations` accepts exactly that one line at tier
 * 0). A pool that does not exist prices at 0 rather than throwing — the caller
 * turns a zero into "cannot be computed", which is the honest rendering.
 *
 * Exported for the index's cards, which price the same stocks over many
 * launches at once: the basket of fifty launches is drawn from the same
 * dozen equities, so `cards.ts` memoises this per (stock, tier) and pays for
 * each pool once. A second pricer there would be a second answer to
 * "what is NVDA worth", on two screens of the same app.
 */
export async function usdPrice(t: Address, fee: number, decimals: number): Promise<number> {
  if (fee === 0) return 1;
  const pool = (await pub.readContract({
    address: V3_FACTORY, abi: poolAbi, functionName: "getPool", args: [t, USDG, fee],
  })) as Address;
  if (pool === ZERO) return 0;
  const [slot0, token0] = await Promise.all([
    pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
  ]);
  return spotPrice(slot0[0], (token0 as string).toLowerCase() === t.toLowerCase(), decimals, 6);
}

/** What `PONS_FACTORY.getLaunchedToken` gives back, of which two fields and a
 *  phase are all a pool key needs. Structural, so a field added upstream does
 *  not have to be mirrored here. */
type Launch = { pairToken: Address; poolFee: number; tickSpacing: number; phase: number };

/**
 * A launch's Uniswap v4 pool id, from a record already read.
 *
 * `null` before phase 2 is the token still being on the bonding curve, which
 * is not a failure: there is no pool yet, and a caller that asks for one is
 * asking a question the chain has not answered rather than one it refused.
 *
 * Pure, and separate from the read below, because the two callers arrive with
 * different things in hand: `readMetrics` has the launch already (it needs
 * `pairToken` for the price anyway) and must not read it twice, while a mode
 * page has only the token. One derivation either way — the key's shape, the
 * hook included, is the thing that must not exist in two versions.
 */
export function pairIdOfLaunch(launch: Launch | null, token: Address): Hex | null {
  if (!launch || launch.phase < 2) return null;
  return poolId({
    currency0: launch.pairToken, currency1: token,
    fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: PONS_V4_HOOK,
  });
}

/**
 * The same id, for a caller that holds nothing but the token.
 *
 * This is the backing and lottery pages: they never build a `Metrics` — there
 * is no basket to price and no `Distributor` to read — and a launch under any
 * mode still graduates into a Pons pool indexed exactly like every other. One
 * read, and a node that will not answer gives `null` rather than throwing into
 * a page that is otherwise fine.
 */
export async function pairIdOf(token: Address): Promise<Hex | null> {
  const launch = await pub.readContract({
    address: PONS_FACTORY, abi: ponsRegistryAbi, functionName: "getLaunchedToken", args: [token],
  }).catch(() => null);
  return pairIdOfLaunch(launch as Launch | null, token);
}

/**
 * Everything the yield needs, or `null` if the chain would not answer.
 *
 * `null` and zero are different sentences and only one of them is ever true
 * here: a vault that has paid nothing is a real zero, a node that timed out is
 * not, and a page must never render the second as the first.
 */
export async function readMetrics(): Promise<Metrics | null> {
  try {
    const [allocations, token, tokenCurve] = await Promise.all([
      pub.readContract({ address: FEE_VAULT, abi: vaultAbi, functionName: "getAllocations" }),
      pub.readContract({ address: FEE_VAULT, abi: vaultAbi, functionName: "token" }) as Promise<Address>,
      pub.readContract({ address: FEE_VAULT, abi: vaultAbi, functionName: "curve" }) as Promise<Address>,
    ]);

    // --- numerator: what the fees have bought, in dollars ------------------
    //
    // Priced where it was bought, so the figure is what holders OWN rather than
    // what it cost. `offchain/src/value.ts` computes the identical number from
    // a terminal and the two must agree.
    const paidUsd = (
      await Promise.all(allocations.map(async (a) => {
        const [decimals, units] = await Promise.all([
          pub.readContract({ address: a.stock, abi: erc20Abi, functionName: "decimals" }),
          pub.readContract({
            address: DISTRIBUTOR, abi: distributorAbi, functionName: "totalFunded", args: [a.stock],
          }) as Promise<bigint>,
        ]);
        return Number(formatUnits(units, decimals)) * await usdPrice(a.stock, a.poolFee, decimals);
      }))
    ).reduce((x, y) => x + y, 0);

    // --- denominator: the eligible supply, and what one token is worth ------
    //
    // The seven structural exclusions of `offchain/src/snapshot.ts`,
    // de-duplicated because the vault IS the `creatorFeeRecipient` on this
    // launch: a set that counts its balance twice makes the supply smaller and
    // the yield larger, in our favour, which is the direction to be careful in.
    const excluded = [...new Set(
      [ZERO, DEAD, POOL_MANAGER, token, tokenCurve, DISTRIBUTOR, FEE_VAULT].map((a) => a.toLowerCase()),
    )] as Address[];

    const [supply, balances, launch, ethUsd, genesis] = await Promise.all([
      pub.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }) as Promise<bigint>,
      Promise.all(excluded.map((a) =>
        pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] })
          .catch(() => 0n) as Promise<bigint>)),
      pub.readContract({
        address: PONS_FACTORY, abi: ponsRegistryAbi, functionName: "getLaunchedToken", args: [token],
      }).catch(() => null),
      usdPrice(WETH, WETH_USDG_FEE, 18),
      pub.readContract({ address: DISTRIBUTOR, abi: distributorAbi, functionName: "GENESIS" }) as Promise<bigint>,
    ]);

    // The pool's key, and so its id, needs the fee and the tick spacing Pons
    // chose at graduation — read, not assumed: `launchConfigCount()` is 1 today,
    // which is a fact about the factory's configuration and not about the
    // protocol. `pairToken` is `address(0)` on a native-ETH launch, which is
    // also the only ordering v4 can give it: nothing sorts below zero.
    let priceUsd = 0;
    const pairId = pairIdOfLaunch(launch as Launch | null, token);
    if (pairId) {
      const word = await pub.readContract({
        address: POOL_MANAGER, abi: poolManagerAbi, functionName: "extsload",
        args: [slot0Slot(pairId)],
      }).catch(() => null);
      if (word) priceUsd = priceOfCurrency1(decodeSlot0(word as Hex).sqrtPriceX96, 18, 18) * ethUsd;
    }

    const dead = balances[excluded.indexOf(DEAD.toLowerCase() as Address)] ?? 0n;

    return {
      burntPct: supply > 0n ? (Number(formatEther(dead)) / Number(formatEther(supply))) * 100 : 0,
      paidUsd,
      floatTokens: Number(formatEther(floatOf(supply, balances))),
      priceUsd,
      ageSeconds: Math.floor(Date.now() / 1000) - Number(genesis),
      stocks: allocations.length,
      pairId,
    };
  } catch {
    return null;
  }
}
