/**
 * The formatting, which is the only part of the bot that can be wrong quietly.
 *
 * A send that fails is loud — it logs and retries. A number rendered wrong is
 * not: it reads perfectly well and says something false to a channel of people
 * who cannot check it without opening the explorer.
 */
import assert from "node:assert/strict";
import { shares, eth, basketBoughtMessage, rootMessage, airdropMessage } from "./telegram-format.js";

let checks = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); ++checks; };
const eq = (a: unknown, b: unknown, m: string) => { assert.equal(a, b, m); ++checks; };

// --- share counts -----------------------------------------------------------
eq(shares(10n ** 18n), "1", "a whole share has no decimal tail");
eq(shares(0n), "0", "zero is zero, not 0.000000");
eq(shares(1_500_000_000_000_000_000n), "1.5", "trailing zeros are trimmed");
ok(shares(73_100_000_000_000_000n).startsWith("0.0731"), "sub-share amounts keep six decimals");
// The real measurement from the fork rehearsal: 0.2819 QQQ across three holders.
ok(shares(281_963_265_749_742_217n).startsWith("0.281963"), "a real epoch's output renders readably");
// Dust must not render as "0" — that would announce a delivery of nothing.
ok(shares(1_000n) !== "0", "dust renders as a number, never as zero");

// --- ETH --------------------------------------------------------------------
ok(eth(10n ** 18n).endsWith("ETH"), "the unit is always spelled out");
eq(eth(81_928_094_197_055_372n), "0.081928 ETH", "a real epoch's spend, six decimals");
// The old deployment really did buy for 0.000206 ETH an epoch. Rendering that
// as "2.06e-4 ETH" in a public channel reads as a bug, not as precision.
eq(eth(206_000_000_000_000n), "0.000206 ETH", "a small real buy stays in plain decimals");
ok(eth(1_000_000_000n).includes("e-"), "and only genuinely invisible amounts go exponential");

// --- messages ---------------------------------------------------------------
const m = basketBoughtMessage(42n, 5, 81_928_094_197_055_372n);
ok(m.includes("epoch 42") && m.includes("5 stocks"), "the window and the number of legs are both named");
ok(m.includes("0.081928 ETH"), "the spend is in the message");

const r = rootMessage(42n, "https://paydprotocol.eth.limo/app/");
ok(r.includes("Epoch 42 is LIVE"), "the claim message says which epoch");
ok(r.includes("href="), "and carries the link to the app");

eq(airdropMessage(1, ["NVDA"]).includes("1 wallet paid"), true, "singular for one wallet");
eq(airdropMessage(9, ["NVDA", "QQQ"]).includes("9 wallets paid"), true, "plural for several");
ok(airdropMessage(9, []).length > 0, "no stock list is still a valid message");

console.log(`telegram: ${checks} checks OK`);
