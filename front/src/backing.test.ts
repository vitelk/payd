/**
 * The backing mode's arithmetic — the half of that screen a burn cannot take
 * back.
 *
 * Not the panel and not viem: the three numbers that decide what a holder gets
 * and what floor protects them. `redeem` prices every leg itself, so these are
 * never the amounts sent — but a wrong floor either reverts every redemption
 * (`BelowMinimum`) or offers the pot to whoever moves it first, and both are
 * silent until somebody has already burnt.
 */
import assert from "node:assert/strict";

// `config.ts` reads `location.search` at module load — that is what lets the
// page switch network through the URL. Under node there is none, so one is set
// before the import, which is why this file imports dynamically.
(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { minOutsFor, redeemableSupply, shareOf, parseAmount } = await import("./backing.js");

// The supply a redemption divides by: `totalSupply` MINUS what sits at
// `0xdead`. A burnt balance can never redeem, and counting it would strand its
// share of the pot for ever instead of passing it to the holders who stayed.
assert.equal(redeemableSupply(1_000n, 250n), 750n, "the dead balance leaves the denominator");
assert.equal(redeemableSupply(1_000n, 0n), 1_000n, "nothing burnt, nothing deducted");
// A token whose `burnFrom` already reduced `totalSupply` can leave the two
// equal — or, with a rebasing oddity, inverted. Neither may underflow.
assert.equal(redeemableSupply(250n, 250n), 0n, "everything burnt is a supply of zero, not an underflow");
assert.equal(redeemableSupply(100n, 250n), 0n, "…and so is a dead balance above the supply");

// Pro-rata, floor division, exactly as the contract computes it.
assert.equal(shareOf(1_000n, 250n, 1_000n), 250n, "a quarter of the supply takes a quarter of the leg");
assert.equal(shareOf(1_000n, 1n, 3n), 333n, "the division truncates, never rounds up");
assert.equal(shareOf(1_000n, 5n, 0n), 0n, "a supply of zero pays nothing rather than dividing by it");

// THE FLOOR. 1 % of slippage keeps 99 %, rounded down.
assert.deepEqual(minOutsFor([10_000n, 1n], 100), [9_900n, 0n], "99 % of each leg, truncated");
assert.deepEqual(minOutsFor([10_000n], 0), [10_000n], "no slippage asks for the whole preview");
assert.deepEqual(minOutsFor([10_000n], 10_000), [0n], "100 % of slippage is a floor of zero");
// A leg the pot has nothing of keeps a floor of zero: demanding anything of it
// would revert the redemption of every OTHER leg with it.
assert.deepEqual(minOutsFor([0n, 500n], 100), [0n, 495n], "an empty leg does not block the others");
// Out-of-range input cannot produce a floor ABOVE the preview — that would
// revert every redemption, for ever, with no message a holder could act on.
assert.deepEqual(minOutsFor([1_000n], -50), [1_000n], "a negative slippage is clamped, not applied backwards");
assert.deepEqual(minOutsFor([1_000n], 99_999), [0n], "…and an absurd one bottoms out at zero");

// The field: decimal text in, token units out, `null` for anything else — the
// state where the button stays disabled rather than sending a zero burn.
assert.equal(parseAmount("1.5", 18), 1_500_000_000_000_000_000n, "a decimal amount scales by the token's own precision");
assert.equal(parseAmount("1,5", 18), 1_500_000_000_000_000_000n, "a comma is a decimal point for half the world");
assert.equal(parseAmount("2", 6), 2_000_000n, "six decimals is not eighteen");
assert.equal(parseAmount("", 18), null, "an empty field is not a zero burn");
assert.equal(parseAmount("0", 18), null, "and neither is an explicit zero");
assert.equal(parseAmount("abc", 18), null, "junk does not become an amount");
assert.equal(parseAmount("-1", 18), null, "nor does a negative one");

console.log("backing: 20 checks OK — the floor holds at both ends and the dead balance leaves the supply");
