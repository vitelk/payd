/**
 * The Tokens cards' arithmetic and their states. `pnpm --filter front test`
 *
 * Three things are checked here and one of them is the reason the file exists:
 * **a leg that delivered and could not be priced must blank the headline, and a
 * leg that delivered nothing must not.** Summing an unpriced leg as zero
 * understates what holders were paid, silently and in our favour; blanking the
 * card because a never-bought exotic line has no pool blanks most of a young
 * registry. `paidOf` is the one function that tells those two apart, so it is
 * the one that gets a test per branch.
 *
 * The last block closes the loop with the fixture world: `mock.ts` builds a
 * `sqrtPriceX96` from a dollar price and `yield.ts` reads it back. If either
 * moves, the mocked index silently prices every basket wrong — which looks like
 * a bug in this code and is not one.
 */
import assert from "node:assert/strict";
import { ago, usd, paidOf, initials, modeTag, cardHtml, launchCellHtml, type Card } from "./cards.js";
import { spotPrice } from "./yield.js";

// --- the age line, coarse on purpose --------------------------------------
assert.equal(ago(0), "just now");
assert.equal(ago(59), "just now");
assert.equal(ago(60), "1 min ago");
assert.equal(ago(59 * 60), "59 min ago");
assert.equal(ago(3600), "1 h ago");
// 90 minutes is ONE hour ago. Rounding a launch's age up is the direction that
// flatters it, so every unit truncates.
assert.equal(ago(90 * 60), "1 h ago");
assert.equal(ago(23 * 3600 + 3599), "23 h ago");
assert.equal(ago(24 * 3600), "1 d ago");
assert.equal(ago(6 * 24 * 3600), "6 d ago");
assert.equal(ago(365 * 24 * 3600), "1 y ago");
// A read that did not answer is not an age: "" and never "just now", which is
// the one wrong answer that looks right.
assert.equal(ago(-1), "");
assert.equal(ago(Number.NaN), "");

// --- dollars, as a 14rem card can print them ------------------------------
assert.equal(usd(0), "$0");
assert.equal(usd(0.004), "<$0.01");
assert.equal(usd(1.5), "$1.50");
assert.equal(usd(999.99), "$999.99");
// No cents above a thousand: the two digits wrap the card and are worth nothing
// at that size.
assert.equal(usd(8930), "$8,930");
assert.equal(usd(8930.42), "$8,930");
assert.equal(usd(Number.NaN), "—");

// --- the headline, and the two ways a zero can be meant -------------------
const leg = (units: bigint | null, price: number, decimals = 18) => ({ units, decimals, price });

// Nothing delivered anywhere: a real zero, and the card prints "$0".
assert.equal(paidOf([leg(0n, 487.2), leg(0n, 178.45)]), 0);
// An empty basket is a zero too, not a failure: no leg has failed to answer.
assert.equal(paidOf([]), 0);
// One whole unit of a $100 stock.
assert.equal(paidOf([leg(10n ** 18n, 100)]), 100);
// Decimals are the stock's own, not eighteen everywhere: six of them, one unit.
assert.equal(paidOf([leg(10n ** 6n, 100, 6)]), 100);
// Two lines add up.
assert.equal(paidOf([leg(2n * 10n ** 18n, 50), leg(10n ** 18n, 25)]), 125);

// THE POINT OF THIS FILE. A leg that delivered and has no price makes the whole
// headline unreportable: the alternative is a sum that is too small, in our
// favour, with nothing on screen saying so.
assert.equal(paidOf([leg(10n ** 18n, 100), leg(10n ** 18n, 0)]), null);
// But a leg that delivered NOTHING contributes nothing whatever its price, so an
// unpriced line nobody has bought must not blank the card — that is the common
// shape of a young launch whose exotic leg has never cleared its floor.
assert.equal(paidOf([leg(10n ** 18n, 100), leg(0n, 0)]), 100);
// A read that did not answer is never a zero.
assert.equal(paidOf([leg(null, 100)]), null);
assert.equal(paidOf([leg(10n ** 18n, 100), leg(null, 50)]), null);
// A negative or NaN price is refused like a missing one rather than subtracting.
assert.equal(paidOf([leg(10n ** 18n, Number.NaN)]), null);
assert.equal(paidOf([leg(10n ** 18n, -5)]), null);

// --- the logo fallback ----------------------------------------------------
assert.equal(initials("PAYD"), "PAYD");
assert.equal(initials("ORBIT"), "ORBI");
assert.equal(initials("sol8"), "SOL8");

// --- the mode tag: the default one is spelled out too ---------------------
assert.equal(modeTag("distribution"), "distribution");
assert.equal(modeTag("tontine"), "tontine");
assert.equal(modeTag("unknown"), "other mode");

// --- the card's states, as markup -----------------------------------------
const base: Card = {
  href: "./index.html?token=0x01&distributor=0x02",
  sym: "PAYD", mode: "distribution", logo: "", age: "2 h ago",
  badge: "", badgeInk: "var(--dim)", alarm: false, dim: false,
  paid: "$8,930", paidMuted: false,
  secondaryK: "To holders, of a trade", secondaryV: "3.29 %", secondaryOk: false,
};
{
  const h = cardHtml(base);
  assert.ok(h.includes('class="tc"'), "a healthy card wears no extra class");
  assert.ok(h.includes("$8,930"), "the headline is the figure");
  assert.ok(h.includes("<i>PAYD</i>"), "no logo means the ticker stands in");
  assert.ok(!h.includes("<img"), "and there is no image element at all to break");
  assert.ok(!h.includes('class="bdg"'), "a healthy launch carries no badge");
  assert.ok(h.includes("distribution"), "the mode is spelled out");
}
{
  // Fees redirected: the alarm ring, the muted figure, the badge — and the
  // viewer's own claim still shown, in the accent. The card is honest, not
  // hidden, and what is already owed is still owed.
  const h = cardHtml({
    ...base, alarm: true, badge: "fees redirected", badgeInk: "var(--bad)",
    paidMuted: true, secondaryK: "Yours to collect", secondaryV: "$12.40", secondaryOk: true,
  });
  assert.ok(h.includes("tc alarm"), "the ring says it");
  assert.ok(h.includes('class="soft"'), "and the headline stops shouting");
  assert.ok(h.includes("fees redirected"), "the badge names it");
  assert.ok(h.includes('class="v ok"'), "the viewer's own money is in the accent");
  assert.ok(h.includes("$12.40"));
}
{
  const h = cardHtml({ ...base, dim: true, age: "on the curve", paid: "—", badge: "not launched" });
  assert.ok(h.includes("tc dim"));
  assert.ok(h.includes("on the curve"), "an unlaunched token has an age of its own");
}
{
  // A logo is written BESIDE the fallback, so the onerror that removes the
  // image is the whole fallback path — there is no state where the square is
  // empty and no second render.
  const h = cardHtml({ ...base, logo: "https://gw.example/ipfs/bafkre1" });
  assert.ok(h.includes("<img"), "the image is there");
  assert.ok(h.includes("<i>PAYD</i>"), "and so is what replaces it");
  assert.ok(h.includes("onerror"), "which is what puts it back");
}
{
  // Nothing reaches the DOM unescaped. A ticker is whatever the token's
  // `symbol()` returned, which is a string a stranger chose.
  const h = cardHtml({ ...base, sym: '<img src=x onerror=alert(1)>' });
  assert.ok(!h.includes("<img src=x"), "a hostile ticker is escaped");
  assert.ok(h.includes("&#60;img"), "as an entity");
}
{
  const h = launchCellHtml();
  assert.ok(h.includes('data-view="create"'), "the first cell reaches the Launch view");
  assert.ok(h.includes("Launch a token"));
}

// --- the fixture prices itself the way the app reads it back ---------------
//
// `mock.ts` inverts `spotPrice` to build a `sqrtPriceX96`. Asserting the round
// trip here is what stops the two from drifting: a mocked index that prices
// every basket a trillion times wrong looks like a bug in `paidOf`.
const sqrtX96 = (u: number) => BigInt(Math.floor(Math.sqrt(u / 1e12) * 2 ** 96));
for (const price of [487.20, 178.45, 312.80, 26.15, 402.60]) {
  const back = spotPrice(sqrtX96(price), true, 18, 6);
  assert.ok(
    Math.abs(back - price) < 0.01,
    `the fixture's sqrtPriceX96 reads back as ${back}, not ${price}`,
  );
}

console.log("cards: the headline refuses an unpriced delivery, the states draw, and the fixture prices itself");
