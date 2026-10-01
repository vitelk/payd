/**
 * The row a holder writes, and the rules it has to obey.
 *
 * `validateRow` mirrors `PortfolioBook._write`. It exists so a holder reads the
 * refusal next to the field instead of paying for it on-chain, which means the
 * two must agree exactly — every case below names the contract clause it
 * copies. Pure, so it runs under node with no chain and no DOM.
 */
import type { Address } from "viem";

// `config.ts` reads `location.search` at module load — that is what lets the
// app be pinned to one launch by query string — and this module reaches it
// through `chain.js`. `backing.test.ts` does the same thing for the same
// reason; the alternative is splitting the mode's rules away from its screen,
// which would put the floor and the cap one import further from the panel
// that has to honour them.
(globalThis as { location?: unknown }).location = new URL("http://localhost/");

const { validateRow, evenRow, isDefaultRow, MAX_LINES, MIN_LINE_BPS, BPS } = await import("./portfolio.js");

let checks = 0;
function ok(c: unknown, what: string) {
  if (!c) throw new Error(what);
  checks++;
}
function eq(a: unknown, b: unknown, what: string) {
  if (a !== b) throw new Error(`${what}: ${String(a)} != ${String(b)}`);
  checks++;
}

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const C = "0x00000000000000000000000000000000000000c3" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// The constants are the contract's, not this file's opinion of them.
eq(MAX_LINES, 64, "MAX_LINES is PortfolioBook's");
eq(MIN_LINE_BPS, 100, "MIN_LINE_BPS is one per cent, not five");
eq(BPS, 10_000, "and BPS is BPS");

// --- the sum, which is the clause a holder trips over most -----------------
ok(validateRow([{ stock: A, bps: 10_000 }]).ok, "one stock taking the whole share is a legal row");
ok(validateRow([{ stock: A, bps: 5_000 }, { stock: B, bps: 5_000 }]).ok, "and so is an even pair");
ok(!validateRow([{ stock: A, bps: 5_000 }]).ok, "half a row is refused: `_write` wants exactly BPS");
ok(
  validateRow([{ stock: A, bps: 5_000 }]).error!.includes("50 %"),
  "...and it says how much is unassigned, in per cent",
);
ok(
  validateRow([{ stock: A, bps: 6_000 }, { stock: B, bps: 6_000 }]).error!.includes("too much"),
  "over BPS is refused too, and named as an excess rather than a shortfall",
);

// --- the floor: 1 %, which is what lets a row be long ----------------------
ok(validateRow([{ stock: A, bps: 100 }, { stock: B, bps: 9_900 }]).ok, "a 1 % line is legal");
ok(!validateRow([{ stock: A, bps: 99 }, { stock: B, bps: 9_901 }]).ok, "0.99 % is not");

// --- the two clauses that are easy to forget -------------------------------
ok(
  !validateRow([{ stock: A, bps: 5_000 }, { stock: A, bps: 5_000 }]).ok,
  "the same stock twice is refused where it is written, not on-chain",
);
ok(!validateRow([{ stock: ZERO, bps: 10_000 }]).ok, "and so is a line naming no stock");
ok(!validateRow([]).ok, "an empty row is not 'no choice' — clearPortfolio is");

// A row at the cap, and one over it. 64 lines cannot all clear the 1 % floor
// AND sum to BPS... they can: 64 x 100 = 6,400, with the remainder on one line.
const wide = [
  ...Array.from({ length: 63 }, (_, i) => ({ stock: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, bps: 100 })),
  { stock: A, bps: BPS - 6_300 },
];
eq(wide.length, 64, "fixture: a row exactly at the cap");
ok(validateRow(wide).ok, "sixty-four lines is legal — the cap is a sanity bound, not an economic one");
ok(!validateRow([...wide, { stock: B, bps: 100 }]).ok, "sixty-five is not");

// --- evenRow lands on a row the book accepts -------------------------------
for (const n of [1, 2, 3, 7, 8]) {
  const stocks = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
  const row = evenRow(stocks);
  eq(row.length, n, `even over ${n} keeps ${n} lines`);
  ok(validateRow(row).ok, `...and the book accepts it (${n})`);
}
// Three stocks cannot be split into three equal ten-thousandths, and the row
// still has to sum exactly: `spread` puts the remainder somewhere.
eq(evenRow([A, B, C]).reduce((a, l) => a + l.bps, 0), BPS, "an uneven split still sums to BPS");

// --- "is this mine, or the creator's?" -------------------------------------
// The contract answers `linesOf` with the default when a holder has chosen
// nothing, so the screen cannot tell the two apart without comparing. Getting
// this wrong means telling somebody they chose a row they never chose.
const def = [{ stock: A, bps: 5_000 }, { stock: B, bps: 5_000 }];
ok(isDefaultRow(def, def), "the same row is the default");
ok(isDefaultRow([{ stock: A.toUpperCase() as Address, bps: 5_000 }, { stock: B, bps: 5_000 }], def),
  "...whatever the address casing the node returned");
ok(!isDefaultRow([{ stock: A, bps: 6_000 }, { stock: B, bps: 4_000 }], def),
  "a reweighted copy is the holder's own choice");
ok(!isDefaultRow([{ stock: B, bps: 5_000 }, { stock: A, bps: 5_000 }], def),
  "...and so is the same pair in another order: the book stores what was written");
ok(!isDefaultRow([], def), "an empty row is not the default");
ok(isDefaultRow([], []), "but with no default at all, nothing IS the default");

console.log(`portfolio(front): ${checks} checks OK`);
