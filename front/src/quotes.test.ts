/**
 * `quotelist` — the list of currencies a launch can be quoted in, as the form's
 * selector reads it.
 *
 * What is tested here is not viem: it is the rule. A SHIPPED LIST finds the
 * addresses, the MAPPING says their state. An implementation trusting the list
 * alone would offer the creator a currency `Payd._create` refuses — and the
 * list is now a build-time constant rather than a log scan, so that is more
 * important than it was, not less. It is what the first case catches.
 *
 * The addresses used to come from `QuoteAllowed` logs; they come from
 * `config.ts`'s `KNOWN_QUOTES` now (see `KNOWN_STOCKS` there for the 1 452
 * windows that bought). Nothing else about the rule moved, which is why this
 * file only changed where the candidates enter: they are passed in, through the
 * defaulted parameter `quotelist` exposes for exactly this.
 */
import assert from "node:assert/strict";
import type { Address } from "viem";

// `config.ts` reads `location.search` when the module loads -- that is what lets
// the page switch network through the URL. Under node there is none, so one is
// set before importing, which is the only reason this file imports dynamically.
(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { pub } = await import("./chain.js");
/** The registry's deployment block, as `config.ts` declares it. */
const { PAYD_BLOCK: PAYD_BLOCK_FLOOR } = await import("./config.js");
const { quotelist } = await import("./create.js");

const PAD = "0x00000000000000000000000000000000000000ad" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const NVDA = "0x000000000000000000000000000000000000nvda".replace("nvda", "0eda") as Address;
const GONE = "0x00000000000000000000000000000000000000f0" as Address;
const MUTE = "0x00000000000000000000000000000000000000f1" as Address;

// `[poolFee, wethFee, minBuy, allowed]` — the four fields `Payd.quoteListing`
// returns, in its order. This stub used to carry three, which is how the shape
// drifted from the contract without a single test going red: the stub agreed
// with the declaration, and both were wrong. The rows now honour the contract's
// own rule (`Payd._allowQuotes`): the PIVOT carries no tier at all, and every
// other currency carries exactly one of the two.
const listing = new Map<string, [number, number, bigint, boolean]>([
  [USDG, [0, 0, 10_000_000n, true]], // the pivot against itself: no route, no tier
  [NVDA, [500, 0, 50_000_000_000_000_000n, true]], // a direct QUOTE/USDG pool
  [GONE, [3000, 0, 1n, false]], // listed, then removed
  [MUTE, [0, 3000, 1n, true]], // the WETH detour, and no `symbol()`
]);
const symbols = new Map<string, string>([[USDG, "USDG"], [NVDA, "NVDA"]]);

// The candidates, as a build ships them. NVDA appears TWICE on purpose: the
// list is hand-maintained data now, so a duplicated address is a mistake
// somebody can actually make in an editor — and it must still produce one row.
const CANDIDATES = [USDG, NVDA, GONE, MUTE, NVDA];

// No `getLogs` stub any more, and that absence is the point: this screen makes
// no log request at all. `pubLogs` is not even imported.
pub.readContract = (async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => {
  if (p.functionName === "quoteListing") {
    const row = listing.get(String(p.args?.[0]).toLowerCase());
    if (!row) throw new Error("not listed");
    return row;
  }
  if (p.functionName === "symbol") {
    const s = symbols.get(p.address.toLowerCase());
    if (!s) throw new Error("no symbol()"); // an ERC-20 is allowed not to have one
    return s;
  }
  throw new Error("unexpected read: " + p.functionName);
}) as typeof pub.readContract;

const out = await quotelist(PAD, CANDIDATES);

// 1. The removed currency does not come back, even though the build still
//    ships its address.
assert.equal(out.find((q) => q.quote === GONE), undefined, "a removed currency must not be offered");

// 2. One address per row, whatever the number of events.
assert.equal(out.filter((q) => q.quote === NVDA).length, 1, "a duplicated candidate must not duplicate the row");

// 3. A token with no `symbol()` degrades instead of taking the list down --
//    otherwise a single badly behaved ERC-20 would empty the selector.
const mute = out.find((q) => q.quote === MUTE);
assert.ok(mute, "a token with no symbol() stays offerable");
assert.equal(mute.symbol, MUTE.slice(0, 8));

// 4. Sorted by symbol, like the stock allowlist.
assert.deepEqual(out.map((q) => q.symbol), [...out.map((q) => q.symbol)].sort((a, b) => a.localeCompare(b)));
assert.equal(out.length, 3);

// ---------------------------------------------------- the shipped lists

// The candidate lists are hand-maintained DATA now, not a scan's output, so
// they can be wrong in ways a log walk never could: a duplicated line, a
// truncated paste, an address typed one nibble short. None of that is caught
// by the type — every one of them is still a string — and none of it is caught
// at runtime either, because the screen would simply ask the registry about a
// bad address and get nothing back. `pnpm --filter front listings` checks them
// against the CHAIN and needs an endpoint; this checks the shape, and needs
// nothing.
const { KNOWN_QUOTES, KNOWN_STOCKS, LISTINGS_READ_AT } = await import("./config.js");

for (const [name, list] of [["KNOWN_STOCKS", KNOWN_STOCKS], ["KNOWN_QUOTES", KNOWN_QUOTES]] as const) {
  assert.ok(list.length > 0, `${name} is empty — the picker would be switched off`);
  for (const a of list) {
    assert.match(a, /^0x[0-9a-fA-F]{40}$/, `${name}: ${a} is not an address`);
  }
  const lower = list.map((a) => a.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, `${name} lists an address twice`);
}
// Measured after the registry's own deployment, which is the only thing that
// makes the reading meaningful.
assert.ok(LISTINGS_READ_AT > PAYD_BLOCK_FLOOR, "LISTINGS_READ_AT predates the registry");

console.log(
  `quotes: removals excluded, duplicates folded, missing symbol tolerated, stable sort, no log read`
  + ` · ${KNOWN_STOCKS.length} stocks and ${KNOWN_QUOTES.length} quotes shipped, all well formed`,
);
