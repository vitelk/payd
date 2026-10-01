/** The yield panel's arithmetic. `pnpm --filter front test` */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spotPrice, yieldOf, floatOf } from "./yield.js";

const ONE = 10n ** 18n;

// 1. spotPrice, both ways round. The inversion is the whole risk: getting it
//    backwards does not throw, it returns a number off by ~1e12 and the panel
//    announces a yield of 0.000001 % or of 40 million percent. sqrtPriceX96 at
//    exactly 2**96 is a raw price of 1, so with equal decimals both directions
//    must land on 1 — and with 18 against 6 they must be reciprocal.
{
  const Q96 = 2n ** 96n;
  assert.equal(spotPrice(Q96, true, 18, 18), 1);
  assert.equal(spotPrice(Q96, false, 18, 18), 1);

  // One pool, token0 with 18 decimals against token1 with 6 — a stock against
  // USDG. Asking for each side's price must give reciprocal answers, and note
  // that `decA`/`decB` swap WITH `aIsToken0`: they describe the token being
  // priced and the one it is priced in, not token0 and token1.
  const stock = spotPrice(Q96, true, 18, 6);
  const usdg = spotPrice(Q96, false, 6, 18);
  assert.equal(stock, 1e12);
  assert.ok(Math.abs(usdg * stock - 1) < 1e-9, "the two directions must be reciprocal");
}

// 2. spotPrice has not drifted from `offchain/src/value.ts`. Two readers of the
//    same pool disagreeing about the dollar value of the basket would be worse
//    than showing no yield at all, and the copy is only safe while this holds.
{
  const src = readFileSync(new URL("../../offchain/src/value.ts", import.meta.url), "utf8");
  const body = (s: string) =>
    s.slice(s.indexOf("const sqrt = Number(sqrtPriceX96)"), s.indexOf("aIsToken0 ? raw"));
  const mine = readFileSync(new URL("./yield.ts", import.meta.url), "utf8");
  assert.ok(body(src).length > 0, "value.ts no longer contains spotPrice — the copy has lost the source it is checked against");
  assert.equal(body(mine), body(src), "spotPrice must stay identical to offchain/src/value.ts");
}

// 3. THE number. $1,000 of stock bought for a float worth $100,000, over 10
//    days: every $100 held earned $1, and a year at that rate is 36.5 %.
{
  const y = yieldOf({ paidUsd: 1_000, floatTokens: 1e9, priceUsd: 1e-4, ageSeconds: 10 * 86_400 })!;
  assert.ok(Math.abs(y.per100 - 1) < 1e-9, "$1 per $100 held on a float worth $100,000");
  assert.ok(Math.abs(y.perYear - 36.5) < 1e-9, "linear, not compounded");
}

// 4. "Cannot be computed" is not "pays nothing". A float of zero, a price of
//    zero and an age of zero all have to read as null, or the page confidently
//    announces a 0 % yield on a vault that has simply not been read yet.
{
  const base = { paidUsd: 1_000, floatTokens: 1e9, priceUsd: 1e-4, ageSeconds: 86_400 };
  assert.equal(yieldOf({ ...base, floatTokens: 0 }), null);
  assert.equal(yieldOf({ ...base, priceUsd: 0 }), null);
  assert.equal(yieldOf({ ...base, ageSeconds: 0 }), null);
  assert.equal(yieldOf({ ...base, paidUsd: NaN }), null);
  assert.notEqual(yieldOf({ ...base, paidUsd: 0 }), null, "but a real zero paid IS a zero yield");
}

// 5. The float is the supply the exclusions leave behind — and it never goes
//    negative. A launch where the vault is also the creator fee recipient feeds
//    the same balance in twice, and a negative float would render as null,
//    i.e. as "no pool yet", which is the wrong sentence entirely.
{
  assert.equal(floatOf(1000n * ONE, [900n * ONE, 50n * ONE]), 50n * ONE);
  assert.equal(floatOf(1000n * ONE, []), 1000n * ONE, "nothing excluded, everything earns");
  assert.equal(floatOf(1000n * ONE, [700n * ONE, 700n * ONE]), 0n, "clamped, never negative");
  assert.equal(floatOf(0n, [0n]), 0n);
}

// 6. The yield falls as the float grows, at the same dollars paid. Obvious, and
//    it is the direction an inverted denominator would reverse.
{
  const at = (floatTokens: number) =>
    yieldOf({ paidUsd: 500, floatTokens, priceUsd: 1e-3, ageSeconds: 86_400 })!.per100;
  assert.ok(at(1e6) > at(1e7), "more tokens sharing the same dollars is a smaller share each");
}

console.log("yield: 6 checks OK — spotPrice matches offchain/src/value.ts");
