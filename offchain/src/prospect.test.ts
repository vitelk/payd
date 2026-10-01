/**
 * prospect.test.ts — the attribution, which is the only place this file can
 * lie in a way nobody notices.
 *
 * Every Pons trade credits TWO recipients on the same curve: Pons's own cut
 * and the creator's. Summing the curve instead of the recipient inflates every
 * row by Pons's share — a plausible number, larger than the truth, sent to the
 * person best placed to know it is wrong. That is pinned here, with the two
 * other ways a row can be wrong: a curve that is not the launch's, and a
 * launch that already belongs to Payd.
 */
import assert from "node:assert/strict";
import type { Address } from "viem";
import { rank, xHandle, type Launch } from "./prospect.js";

let checks = 0;
const ok = (c: boolean, m: string) => { assert.ok(c, m); checks++; };
/** `rank` returns an array; every assertion below is about a row that must
 *  exist, so a missing one is a failure and not a type to widen. */
const at = <T>(rows: T[], i: number): T => {
  const r = rows[i];
  assert.ok(r, `expected a row at ${i}`);
  return r;
};

const CURVE_A = "0xb63FA00F8022fd1973b63d7A9637C1D940D27e03" as Address;
const CURVE_B = "0x849D9128b7fa260e30A96b73FD21556aBcb9A09d" as Address;
const CREATOR_A = "0x6D86b31Df79376A6EC56d814cbE980DFD93C2229" as Address;
const PONS_CUT = "0x263ed295DAfAe1d9AAdd6e56C4b6F9f38eE019dd" as Address;
const VAULT = "0x4DBA57f2E1b9AFE02cA091916F98dd7B4A248A64" as Address;

const launch = (over: Partial<Launch> = {}): Launch => ({
  token: "0xF7DA714C48f9c62eD3a7b2176E61260AAE458016" as Address,
  curve: CURVE_A, symbol: "AAA",
  deployer: CREATOR_A, recipient: CREATOR_A,
  creatorTaxBps: 300, graduated: false, handle: "@aaa", customer: false,
  ...over,
});

/** Both recipients on one curve, as the escrow really emits them. */
const credits = new Map<string, Map<string, bigint>>([
  [CURVE_A.toLowerCase(), new Map([
    [CREATOR_A.toLowerCase(), 2_000_000_000_000_000_000n], // 2 ETH to the creator
    [PONS_CUT.toLowerCase(), 5_000_000_000_000_000_000n],  // 5 ETH to Pons
  ])],
  [CURVE_B.toLowerCase(), new Map([[CREATOR_A.toLowerCase(), 9_000_000_000_000_000_000n]])],
]);

const one = rank([launch()], credits, { ethUsd: 1_000 });
ok(one.length === 1, "the launch is listed");

// The whole point: 2 ETH, not the 7 the curve saw.
ok(at(one, 0).eth === 2, "only the credits addressed to the launch's own recipient count");
ok(at(one, 0).usd === 2_000, "priced at the ETH/USD passed in");
ok(at(one, 0).toHolders === 1_400, "70 % of the fee is what a vault delivers");
ok(at(rank([launch()], credits, { ethUsd: 1_000, rewardsBps: 5_000 }), 0).toHolders === 1_000,
  "the holders' share is a parameter, not a constant");

// A recipient that earned elsewhere brings none of it to this curve.
ok(at(one, 0).eth !== 11, "credits on another curve do not travel");

// Checksummed on one side, lower-cased on the other: a log topic only ever
// arrives lower-cased, and a Map keyed the other way silently returns zero.
ok(at(rank([launch({ recipient: CREATOR_A.toLowerCase() as Address })], credits, { ethUsd: 1 }), 0).wei
   === 2_000_000_000_000_000_000n, "address case cannot decide whether a row exists");

// A launch whose fee lands somewhere nobody credited is not a row of zero, it
// is not a row at all — a prospect list padded with zeros is not a list.
ok(rank([launch({ recipient: PONS_CUT, curve: CURVE_B })], credits, { ethUsd: 1 }).length === 0,
  "a launch with no credit of its own is dropped");

// Ranking, and the customer flag that `main` filters on — set, never inferred.
const many = rank(
  [launch({ symbol: "AAA" }), launch({ symbol: "BBB", curve: CURVE_B, recipient: CREATOR_A, customer: true })],
  credits, { ethUsd: 1 },
);
ok(at(many, 0).symbol === "BBB" && at(many, 1).symbol === "AAA", "biggest fee first");
ok(at(many, 0).customer && !at(many, 1).customer, "the customer flag survives ranking");
ok(rank([launch({ recipient: VAULT })], credits, { ethUsd: 1 }).length === 0,
  "a vault that was credited nothing on this curve stays out");

// `socials()` is written by the launcher and ends up in a CSV somebody opens
// in a spreadsheet. Only the handle is ever taken out of it, so the cases that
// matter are the ones where the field is not just a clean URL.
ok(xHandle("https://x.com/COMMOXprep") === "@COMMOXprep", "the plain case, as Pons stores it");
ok(xHandle("https://www.twitter.com/foo_bar") === "@foo_bar", "twitter.com and www are the same handle");
ok(xHandle("https://x.com/foo?ref=1") === "@foo", "a query string is not part of the handle");
ok(xHandle("https://x.com/foo/status/123") === "@foo", "a deep link still names its author");
ok(xHandle("tg: https://t.me/x, https://x.com/foo") === "@foo", "found among other links");
ok(xHandle("") === "" && xHandle("https://t.me/onlytelegram") === "", "no X link, no handle");
ok(xHandle("=cmd|'/c calc'!A1") === "", "a spreadsheet formula is not a handle");
ok(xHandle("https://x.com/" + "a".repeat(16)) === "", "16 characters is not an X handle");
ok(xHandle("https://evil.com/x.com/foo") === "", "the host has to be X, not a path that looks like it");

console.log(`prospect.test.ts: ${checks} checks passed`);
