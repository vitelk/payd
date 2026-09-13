/**
 * `quotelist` — the list of currencies a launch can be quoted in, as the form's
 * selector reads it.
 *
 * What is tested here is not viem: it is the rule. The EVENTS serve to find the
 * addresses, the MAPPING says their state. A removal does not emit a
 * `QuoteRemoved` to be folded back -- it sets `allowed` to false, and an
 * implementation trusting the logs alone would offer the creator a currency
 * `_create` refuses. That is the only bug possible in this function, and it is
 * the one the first case catches.
 */
import assert from "node:assert/strict";
import type { Address } from "viem";

// `config.ts` reads `location.search` when the module loads -- that is what lets
// the page switch network through the URL. Under node there is none, so we set
// one before importing. That is the only reason why
// ce fichier importe dynamiquement.
(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { pub } = await import("./chain.js");
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

pub.getLogs = (async (p: { event?: { name?: string } }) => {
  if (p?.event?.name !== "QuoteAllowed") return [];
  // NVDA appears TWICE: a re-listing emits a second event, and the list has to
  // stay at one row per address.
  return [USDG, NVDA, GONE, MUTE, NVDA].map((quote, i) => ({ args: { quote }, logIndex: i }));
}) as unknown as typeof pub.getLogs;

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

const out = await quotelist(PAD);

// 1. The removed currency does not come back, even though its event stays in
//    the chain forever.
assert.equal(out.find((q) => q.quote === GONE), undefined, "a removed currency must not be offered");

// 2. One address per row, whatever the number of events.
assert.equal(out.filter((q) => q.quote === NVDA).length, 1, "a re-listing must not duplicate the row");

// 3. A token with no `symbol()` degrades instead of taking the list down --
//    otherwise a single badly behaved ERC-20 would empty the selector.
const mute = out.find((q) => q.quote === MUTE);
assert.ok(mute, "a token with no symbol() stays offerable");
assert.equal(mute.symbol, MUTE.slice(0, 8));

// 4. Sorted by symbol, like the stock allowlist.
assert.deepEqual(out.map((q) => q.symbol), [...out.map((q) => q.symbol)].sort((a, b) => a.localeCompare(b)));
assert.equal(out.length, 3);

console.log("quotes: removals excluded, duplicates folded, missing symbol tolerated, stable sort");
