/**
 * The Discord rendering. Same reason as the Telegram one: a failed POST is
 * loud, a wrong number is not.
 *
 * Plus the one thing embeds can get wrong that a plain string cannot — a field
 * Discord silently drops. An embed with an empty title or a description over
 * 4,096 characters is rejected with a 400 that says very little, and the
 * announcement simply never appears.
 */
import assert from "node:assert/strict";
import { basketEmbed, rootEmbed, airdropEmbed, ACCENT } from "./discord-format.js";

let checks = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); ++checks; };
const eq = (a: unknown, b: unknown, m: string) => { assert.equal(a, b, m); ++checks; };

const all = [
  basketEmbed(42n, 5, 81_928_094_197_055_372n),
  rootEmbed(42n, "https://paydprotocol.eth.limo/app/"),
  airdropEmbed(9, ["NVDA", "QQQ"]),
  airdropEmbed(1, []),
];

for (const e of all) {
  ok(e.title.length > 0 && e.title.length <= 256, "a title Discord will accept (1..256)");
  ok(e.description.length > 0 && e.description.length <= 4096, "a description Discord will accept (1..4096)");
  eq(e.color, ACCENT, "the brand accent, so it does not look like a default webhook");
}

// --- the content itself -----------------------------------------------------
const e = basketEmbed(42n, 5, 81_928_094_197_055_372n);
ok(e.title.includes("epoch 42"), "the window's last epoch is in the title");
ok(e.description.includes("5 stocks"), "the number of legs is named: a purchase has no single stock");
ok(e.description.includes("0.081928 ETH"), "and the spend is the same figure Telegram shows");

const r = rootEmbed(7n, "https://paydprotocol.eth.limo/app/");
ok(r.title.includes("Epoch 7 is LIVE"), "the claim embed says which epoch");
ok(r.description.includes("](https://paydprotocol.eth.limo/app/)"), "the link is a real markdown link, not a bare URL");
eq(r.url, "https://paydprotocol.eth.limo/app/", "and the embed itself is clickable");

ok(airdropEmbed(1, ["NVDA"]).description.startsWith("1 wallet paid"), "singular for one wallet");
ok(airdropEmbed(9, ["NVDA"]).description.startsWith("9 wallets paid"), "plural for several");

console.log(`discord: ${checks} checks OK`);
