/**
 * value.test.ts — `spotPrice` has to survive both token orderings.
 *
 * Uniswap decides which token is token0 by address order, so half the pools we
 * price answer the reciprocal of what we asked for, with the decimal shift
 * inverted too. Both mistakes return a plausible-looking number rather than an
 * error — off by 1e12 on an 18/6 pair — so the arithmetic is pinned here.
 */
import assert from "node:assert";
import { spotPrice } from "./value.js";

let checks = 0;
const ok = (c: boolean, m: string) => {
  assert.ok(c, m);
  checks++;
};

/** The sqrtPriceX96 a pool would carry for `price` of token0 in token1. */
const encode = (price: number, dec0: number, dec1: number) =>
  BigInt(Math.round(Math.sqrt(price * 10 ** (dec1 - dec0)) * 2 ** 96));

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) / b < tol;

// 1:1, same decimals — the identity case, and the one that hides sign errors.
ok(near(spotPrice(encode(1, 18, 18), true, 18, 18), 1), "1:1 same decimals");

// ETH at $2500 against a 6-decimal dollar, ETH as token0.
ok(near(spotPrice(encode(2500, 18, 6), true, 18, 6), 2500), "18/6 pair, a is token0");

// The same pool with the addresses the other way round: the price of ETH is
// now the reciprocal of what the pool stores, and the decimals swap with it.
ok(near(spotPrice(encode(1 / 2500, 6, 18), false, 18, 6), 2500), "18/6 pair, a is token1");

// A stock at $410 against USDG, both orderings, must agree.
const asT0 = spotPrice(encode(410.36, 18, 6), true, 18, 6);
const asT1 = spotPrice(encode(1 / 410.36, 6, 18), false, 18, 6);
ok(near(asT0, 410.36) && near(asT1, 410.36), "both orderings agree on the same price");

// No decimal adjustment must survive when the two legs match.
ok(near(spotPrice(encode(7, 6, 6), true, 6, 6), 7), "equal decimals need no shift");

console.log(`value.test.ts: ${checks} checks passed`);
