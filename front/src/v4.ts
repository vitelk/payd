/**
 * v4.ts — the token's own price, after graduation.
 *
 * The page could price everything the vault BUYS — the stocks all sit in
 * Uniswap v3 pools with a `slot0()` getter — and nothing it is DENOMINATED in.
 * $PAYD graduates into a Uniswap v4 pool, and v4 is a singleton: there is no
 * pool contract to call, the state lives in one mapping inside the
 * `PoolManager` and the only way in is `extsload`. Without this file the yield
 * panel has a numerator and no denominator.
 *
 * Three things have to be right and none of them throws when wrong:
 *
 *  1. **the PoolKey**, and therefore the poolId. Anyone can initialise a v4
 *     pool on our token — BERRY has three, two of them noise at 79 % and 81 %
 *     fee (`docs/recon.md` §graduation). The Pons pool is the one whose key
 *     carries Pons's hook, so the hook is not a detail of the key, it is what
 *     identifies the pool at all;
 *  2. **the storage slot**. `_pools` is slot 6 of the PoolManager, and slot 6
 *     of the wrong layout reads as a valid-looking zero;
 *  3. **the packing** of `Slot0`. `sqrtPriceX96` is the low 160 bits; the tick
 *     sits above it and is SIGNED.
 *
 * All three were checked together on 2026-09-14 against a number nobody in this
 * file chose: the reconstructed price puts $PAYD's fully diluted value at
 * $7 562, and the market was quoting 7.5k. `v4.test.ts` pins that reading.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** `PoolManager._pools` — slot 6, the layout Uniswap v4's `StateLibrary` reads. */
const POOLS_SLOT = 6n;

export interface PoolKey {
  /** The lower address of the two. Native ETH is `address(0)` and so is always
   *  currency0 — v4 has no WETH wrapper on the pool's own accounting. */
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** `keccak256(abi.encode(key))`, the same id the PoolManager emits on `Initialize`. */
export function poolId(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

/** Where that pool's `Slot0` lives, for the one `extsload` this needs. */
export function slot0Slot(id: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOLS_SLOT]),
  );
}

const MASK160 = (1n << 160n) - 1n;

/**
 * Unpacks `Slot0`: `sqrtPriceX96` low, then `tick`, `protocolFee`, `lpFee`, 24
 * bits each.
 *
 * The tick is **int24 and is negative half the time** — every pool whose
 * token1 is worth less than its token0, which is every meme token quoted in
 * ETH. Read unsigned it comes back as ~16.7 million, a price off by 10^36, and
 * nothing anywhere throws. It is not used to price (the sqrt is), but it is
 * what tells a reader the pool is initialised at all, so it is decoded rather
 * than skipped.
 */
export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number } {
  const w = BigInt(word);
  const raw = Number((w >> 160n) & 0xffffffn);
  return { sqrtPriceX96: w & MASK160, tick: raw >= 0x800000 ? raw - 0x1000000 : raw };
}

/**
 * `sqrtPriceX96` → the price of **currency1 in currency0**, decimals applied.
 *
 * v4 orders a key by address, exactly as v3 does, so which of the two is the
 * token being asked about is not a choice. Here the caller always wants
 * currency1 (the launched token) priced in currency0 (ETH), because that is the
 * only direction Pons ever creates: `address(0)` sorts below every token.
 */
export function priceOfCurrency1(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const oneInOne = sqrt * sqrt; // currency1 per currency0, raw units
  return oneInOne > 0 ? 10 ** (dec1 - dec0) / oneInOne : 0;
}
