/** The v4 singleton read. `pnpm --filter front test` */
import assert from "node:assert/strict";
import { poolId, slot0Slot, decodeSlot0, priceOfCurrency1 } from "./v4.js";

const ETH = "0x0000000000000000000000000000000000000000" as const;
const PAYD = "0xc8D259fBb46947F2C7Fa19999C76C795e353CB3a" as const;
const PONS_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const;

// 1. THE test, and it is an end-to-end one: $PAYD's real key, read from
//    `getLaunchedToken` on 2026-09-14 (pairToken 0x0, poolFee 0, tickSpacing
//    200), through the poolId, the storage slot and the packing, to the word
//    `PoolManager.extsload` actually returned. Every step is a place where
//    being wrong produces a plausible number instead of an error, so the chain
//    is pinned as one piece.
const key = { currency0: ETH, currency1: PAYD, fee: 0, tickSpacing: 200, hooks: PONS_HOOK };
{
  const id = poolId(key);
  assert.equal(id, "0xc667622f418f7eab074c22c194b66386f55b703f5631dd339fb6a465a110d8fc");
  assert.equal(slot0Slot(id), "0x86ea331f188d5f61a0abcd900958b04e9743631552e2a44a6de91509ac87d5af");
}

// 2. The word that slot held, and what it means. The cross-check is a number
//    this repository did not choose: at an ETH/USD of 2518.36 read from the
//    WETH/USDG v3 pool in the same block, the price below puts $PAYD's fully
//    diluted value at $7 562 on a supply of 1e27 — and the market was quoting
//    7.5k. Nothing short of the whole path being right produces that.
{
  const word = "0x00000000000000000002fe9700000000000047493a400354163ad49ae771df99" as const;
  const { sqrtPriceX96, tick } = decodeSlot0(word);
  assert.equal(sqrtPriceX96, 1445852765240350217872016562839449n);
  assert.equal(tick, 196247);

  const eth = priceOfCurrency1(sqrtPriceX96, 18, 18);
  const fdv = eth * 2518.36 * 1e9; // 1e27 raw = 1e9 whole tokens
  assert.ok(Math.abs(fdv - 7562) < 20, `FDV should be ~$7562, got $${fdv.toFixed(0)}`);
}

// 3. The hook is part of the identity, not decoration. Anyone may initialise a
//    v4 pool on our token — BERRY carries two squatters at 79 % and 81 % fee —
//    and they differ from the real one only by the key. A poolId computed
//    without the hook must not collide with the real one.
{
  const squatter = poolId({ ...key, hooks: ETH });
  assert.notEqual(squatter, poolId(key), "dropping the hook must not land on Pons's pool");
  assert.notEqual(poolId({ ...key, fee: 790_000 }), poolId(key));
  assert.notEqual(poolId({ ...key, tickSpacing: 19_988 }), poolId(key));
}

// 4. The tick is int24 and is negative for every token worth less than its
//    quote — which is every one of these. Read unsigned it comes back as ~16.7
//    million and nothing throws.
{
  const neg = (BigInt(0xffffff - 100 + 1) << 160n) | 12345n; // tick = -100
  assert.equal(decodeSlot0(`0x${neg.toString(16).padStart(64, "0")}`).tick, -100);
  assert.equal(decodeSlot0(`0x${((1n << 183n) | 1n).toString(16).padStart(64, "0")}`).tick, -0x800000,
    "the most negative int24, not +8388608");
}

// 5. An uninitialised pool reads as an all-zero word, and must price at zero
//    rather than dividing by it. `yieldOf` turns a zero price into "cannot be
//    computed"; an Infinity would render as a yield.
{
  const { sqrtPriceX96, tick } = decodeSlot0(`0x${"0".repeat(64)}`);
  assert.equal(sqrtPriceX96, 0n);
  assert.equal(tick, 0);
  assert.equal(priceOfCurrency1(0n, 18, 18), 0, "never Infinity");
}

// 6. Decimals apply the way round the name says: currency1 priced in currency0.
//    At sqrt = 2**96 the raw price is 1, so a 6-decimal currency1 against an
//    18-decimal currency0 is worth 1e-12 of it.
{
  const Q96 = 2n ** 96n;
  assert.equal(priceOfCurrency1(Q96, 18, 18), 1);
  assert.ok(Math.abs(priceOfCurrency1(Q96, 18, 6) - 1e-12) < 1e-24);
}

console.log("v4: 6 checks OK — $PAYD's pool, key to price, against the 7.5k the market quoted");
