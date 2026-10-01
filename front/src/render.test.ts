/**
 * The two mode screens, RENDERED — against the fixture world, in node.
 *
 * Neither can be opened on the chain: the tontine, backing and lottery
 * factories are enabled by a timelock batch that has not executed, so no vault
 * has ever been built under them. Everything else about those screens is
 * checked (`backing.test.ts`, `lottery.test.ts`), and none of it would catch
 * the two ways a panel actually dies on a first visit: an id the markup does
 * not contain, and a read whose shape does not match what the panel unpacks.
 *
 * So this walks both: a DOM stub thin enough to be honest (it resolves ids, it
 * does not parse HTML), a `readContract` answering from `mock.modes.ts`, and a
 * static check that every id the code asks for is one its own markup declares.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Address } from "viem";

(globalThis as { location?: unknown }).location = new URL("http://localhost/");

// --- 1. every `$("id")` is an id the markup declares.
//
// The panels build their own markup and then look their pieces up by id. A
// renamed id in one of the two places is invisible to the compiler, silent at
// runtime (`getElementById` simply answers null) and shows up as a panel that
// never fills in.
const INDEX = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
// Four more screens than this check started with. They all look their pieces
// up by id and they all build part of their own markup, so they all die the
// same silent way — and `#wallets`, the wallet picker `main.ts` fills, is the
// newest id in that set. Adding them cost nothing: all four were already
// clean when the loop was widened.
for (const file of ["backing.ts", "lottery.ts", "portfolio.ts", "main.ts", "create.ts", "registry.ts", "treasury.ts"]) {
  const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const declared = new Set([
    ...[...src.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]!),
    ...[...INDEX.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]!),
  ]);
  // `maybe()` as well as `$()`. It is the SAME silent failure and a quieter one:
  // `$` at least throws on the non-null assertion the moment something reads the
  // element, while `maybe` is written precisely to tolerate an absence — so a
  // misspelt id there is a control that is simply never wired, for ever. Every
  // id the Tokens cards added (`lp-pos`, `lp-live`, `lp-partial`…) is reached
  // through it.
  //
  // `document.getElementById("…")` is in this pattern, and it was not — which
  // is how the paste-an-address field became unreachable without one test
  // saying so. Every id that form is wired by is read that way, with `?.`
  // after it, precisely so the page survives their absence: the markup moved
  // and the code went on asking a document that no longer answered, in
  // silence. That is the exact failure this block exists to catch, and the
  // quietest form of it was the one form it did not look at.
  const asked = [...src.matchAll(/(?:\$|maybe|document\.getElementById)\("([a-z0-9-]+)"\)/g)]
    .map((m) => m[1]!);
  assert.ok(asked.length > 0, `${file} looks nothing up — this check would pass on an empty file`);
  for (const id of asked) {
    assert.ok(declared.has(id), `${file} asks for #${id}, which no markup declares`);
  }
}

// --- 2. both panels render against the fixture world.
const { pub } = await import("./chain.js");
const { modeWorld } = await import("./mock.modes.js");

const VAULT = "0x00027a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const LOTTO = "0x00047a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const FOLIO = "0x00077a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const HOLDER = "0x9de4b0d4c3a1f7e2b8c5a6d9e0f1a2b3c4d5e31a" as Address;
const stocks = [0, 1, 2, 3, 4].map((i) =>
  `0x${(0xd0000 + i * 0x1111).toString(16).padStart(40, "0")}` as Address);
// The list's ORDER is what `mock.modes.ts` keys the modes on (index 1 is the
// backing vault, index 3 the lottery's), so the two fillers are not padding:
// with the same address twice, `indexOf` finds the first and hands back the
// wrong mode.
const OTHER = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const world = modeWorld([OTHER(1), VAULT, OTHER(3), LOTTO, OTHER(5), OTHER(6), FOLIO], stocks, HOLDER);

/** The reads the two panels make of the VAULT itself, which belong to the main
 *  fixture world rather than to the modes': the mode contract is the vault in
 *  that world, so `DISTRIBUTOR` answers with it. */
pub.readContract = (async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => {
  const fn = p.functionName;
  if (fn === "symbol") return "MESA";
  if (fn === "decimals") return 18;
  if (fn === "DISTRIBUTOR") return p.address;
  if (fn === "token") return "0x0002c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3" as Address;
  if (fn === "totalSupply") return 1_000_000_000n * 10n ** 18n;
  if (fn === "getAllocations") return stocks.map((stock) => ({ stock, poolFee: 3000, bps: 2000, feed: stock }));
  const m = world.read(p.address.toLowerCase(), fn, p.args ?? []);
  if (m !== undefined) return m;
  if (fn === "balanceOf") return 12_000n * 10n ** 18n;
  throw new Error(`no fixture for ${fn}`);
}) as typeof pub.readContract;

pub.getBlockNumber = (async () => 61_344_938n) as typeof pub.getBlockNumber;
pub.getLogs = (async () => []) as unknown as typeof pub.getLogs;
// The ticket artifact, at the address its own digest produces — so the panel
// runs the real sha256 check and the real tree rebuild, as in a browser.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const served = world.serve(String(input));
  if (served === null) throw new Error(`unexpected fetch: ${String(input)}`);
  return new Response(served);
}) as typeof fetch;

/** A DOM thin enough not to lie about what it is: ids resolve to their own
 *  node, `innerHTML` is a string, and nothing is parsed. It cannot prove the
 *  markup is well formed — it proves the code runs and writes. */
interface Node { id: string; innerHTML: string; textContent: string; hidden: boolean; className: string }
const nodes = new Map<string, Node>();
const node = (id: string): Node => {
  let n = nodes.get(id);
  if (!n) {
    n = {
      id, innerHTML: "", textContent: "", hidden: false, className: "",
      addEventListener() { /* the panels wire their buttons; nothing clicks here */ },
    } as Node;
    nodes.set(id, n);
  }
  return n;
};
(globalThis as { document?: unknown }).document = { getElementById: (id: string) => node(id) };

// A CONNECTED holder, because that is the state both panels have something to
// say in: the deferred credits and the odds are read per address, and the two
// buttons are disabled for an address that can only be looked at.
const { setViewer } = await import("./viewer.js");
setViewer(HOLDER, true);

const { renderBacking } = await import("./backing.js");
const { renderLottery } = await import("./lottery.js");

{
  const host = node("host-backing");
  await renderBacking(host as unknown as HTMLElement, VAULT);
  assert.ok(host.innerHTML.includes("Burn to redeem"), "the backing panel drew its shell");
  const legs = node("bk-legs").innerHTML;
  assert.ok(legs.includes("MESA"), "…and a row per stock in the pot");
  assert.ok(!legs.includes("Reading the chain"), "…replacing the placeholder rather than sitting on it");
  // The deferred panel is the branch a paused stock produces, and the fixture
  // holds one: it is the one part of that screen nobody would otherwise see.
  assert.equal(node("bk-deferred").hidden, false, "a deferred leg opens its own panel");
}

{
  const host = node("host-lottery");
  await renderLottery(host as unknown as HTMLElement, LOTTO);
  assert.ok(host.innerHTML.includes("The draw"), "the lottery panel drew its shell");
  assert.ok(node("lt-facts").innerHTML.includes("Winning ticket"), "a settled draw names its ticket");
  // THE POINT OF THE SCREEN: the artifact was fetched, verified, and the
  // winning interval found inside it. The fixture puts the winner on the demo
  // holder, and this address is the one the collect button would pay.
  assert.ok(node("lt-who").innerHTML.includes("you won"), "the winner is resolved from the ticket list");
  assert.equal((node("lt-collect") as unknown as { disabled?: boolean }).disabled, false,
    "…and the button that pays it is live: a settled draw with an unpaid leg");
  assert.ok(node("lt-legs").innerHTML.includes("paid"), "the paid leg is marked as such");
}

{
  // **The portfolio's row panel, which is the only screen in this app that
  // exists to WRITE.** Its two silent deaths are this file's two: an id the
  // SHELL does not declare, and a read whose shape does not match what
  // `readRow` unpacks — `linesOf` returns an array of structs, and unpacking it
  // as anything else leaves a panel that draws its shell and no rows.
  const { renderPortfolio } = await import("./portfolio.js");
  const host = node("host-portfolio");
  const named = stocks.map((stock, i) => ({ stock, symbol: `STK${i}` }));
  await renderPortfolio(host as unknown as HTMLElement, FOLIO, named);

  assert.ok(host.innerHTML.includes("What you are paid in"), "the portfolio panel drew its shell");

  const rows = node("pf-rows").innerHTML;
  assert.ok(!rows.includes("No stocks named"), "…with the holder's row, not the empty state");
  // The fixture's row is STK2 at 70 % and STK3 at 30 %, and the panel has to
  // name the stocks rather than print their addresses: the allowlist is passed
  // in for exactly this, so a row whose tickers went missing is a row the
  // holder cannot check.
  assert.ok(rows.includes("STK2") && rows.includes("STK3"), "…naming the stocks by ticker");
  assert.ok(!rows.includes("STK0"), "…and only the ones the holder actually chose");

  assert.equal(node("pf-total").textContent, "100 %", "the weights add up on screen, in per cent");

  // THE SENTENCE THIS PANEL EXISTS FOR. `linesOf` answers with the creator's
  // default when a holder has chosen nothing, so a screen that does not compare
  // tells everybody they chose a row they never chose. The fixture's holder HAS
  // chosen, and differently from the default.
  assert.ok(node("pf-state").textContent.includes("your own choice"),
    "a holder who has chosen is told it is theirs");

  // The picker offers what is left of the allowlist and nothing that is already
  // in the row — adding a stock twice is a revert the book would take.
  const add = node("pf-add").innerHTML;
  assert.ok(add.includes("STK0") && add.includes("STK1"), "the picker offers the stocks not yet named");
  assert.ok(!add.includes("STK2"), "…and never one the row already holds");
  // **Dollars are offered even though the allowlist does not carry them.** The
  // pivot is the currency the vault already owes, not a stock the platform
  // picked, so `allowlist()` has no row for it — and a holder who wants to opt
  // out of equities has no other way to say so.
  assert.ok(add.includes("Dollars"), "the picker offers the pivot, named rather than tickered");
}

// The creation screen builds its markup and looks its pieces up the same way,
// in ONE file — so the same class of failure lives there, and the fold added to
// step one (`mk-s1`, `mk-s1-sum`, `mk-done`) is exactly the kind of id that is
// added in the code and forgotten in the markup. `getElementById` answers null
// and the screen simply stops half-way, silently.
{
  const src = fs.readFileSync(new URL("create.ts", import.meta.url), "utf8");
  const declared = new Set([...src.matchAll(/id="([A-Za-z0-9-]+)"/g)].map((m) => m[1]!));
  for (const m of src.matchAll(/\$\("([A-Za-z0-9-]+)"\)/g)) {
    assert.ok(declared.has(m[1]!), `create.ts asks for #${m[1]}, and its own markup declares no such id`);
  }
}

// --- 5. the price chart's address, which every mode's page now asks for.
//
// It is here rather than in `v4.test.ts` because it is the MODE pages that
// gained it: the chart used to be drawn only on the distribution path, and a
// backing or lottery launch showed none. What can break it silently is the
// phase guard, not the hash — `poolId` is pinned next door, but a chart offered
// for a token still on the bonding curve links to a pool DexScreener has never
// seen, and the reader gets a 404 from a page of ours.
{
  const { pairIdOfLaunch } = await import("./metrics.js");
  const TOKEN = "0xc8D259fBb46947F2C7Fa19999C76C795e353CB3a" as Address;
  // $PAYD's launch record, read on 2026-09-28: native-ETH pair, fee 0, spacing
  // 200, phase 2. The expected id is not ours — it is the `pairAddress`
  // DexScreener serves for this pool, which is what makes the embed's URL an
  // address and not a lookup.
  const live = { pairToken: OTHER(0), poolFee: 0, tickSpacing: 200, phase: 2 };
  assert.equal(
    pairIdOfLaunch(live, TOKEN),
    "0xc667622f418f7eab074c22c194b66386f55b703f5631dd339fb6a465a110d8fc",
    "the pool id must stay the pairAddress DexScreener indexes",
  );

  // Still on the curve: no pool exists, so there is no chart to offer.
  assert.equal(pairIdOfLaunch({ ...live, phase: 1 }, TOKEN), null, "phase 1 has no pool");
  assert.equal(pairIdOfLaunch({ ...live, phase: 0 }, TOKEN), null, "phase 0 has no pool");
  // A token the Pons factory does not know, and a node that would not answer,
  // reach this the same way.
  assert.equal(pairIdOfLaunch(null, TOKEN), null, "an unread launch is not a chart");

  // The hook is part of the KEY, not a detail of it — anyone can initialise a
  // v4 pool on the same two currencies (`v4.ts`: BERRY has three). A spacing
  // that differs is a different pool too.
  assert.notEqual(pairIdOfLaunch({ ...live, tickSpacing: 60 }, TOKEN), pairIdOfLaunch(live, TOKEN));
}

console.log("render: the three mode panels draw against the fixture world, ids, reads and the pool id included");
