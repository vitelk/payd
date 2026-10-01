/**
 * The lottery's off-chain half, cross-checked against the on-chain one.
 *
 * Two implementations decide who wins — `DrandLib`/`LotteryDistributor` in
 * Solidity and `drand.ts`/`lottery.ts` here — and they must agree bit for bit
 * or the keeper commits a root whose winner the contract computes differently.
 * So the vectors below are not invented: they are the ones
 * `test/lottery/DrawLifecycle.t.sol` and `DrandVerifier.t.sol` pin, taken from
 * quicknet round 1,000,000, which is public history and cannot be forged.
 *
 *   1. **The beacon.** The compressed signature expands to the exact four words
 *      the Solidity test hard-codes, and it verifies under the 43-byte DST —
 *      the one `DrandLib` uses, not the 44-byte spelling a draft guessed.
 *   2. **The winning number.** `keccak256` over the uncompressed point, NOT
 *      drand's published `sha256(compressed)`, and modulo 1,000,000 it is the
 *      93,389 the lifecycle test settles on.
 *   3. **The leaf.** `keccak(keccak(abi.encode(holder, start, end)))`, the
 *      double hash `collect` recomputes, reached through the same OZ tree the
 *      distribution mode's proofs come from.
 *   4. **The tickets.** The intervals partition `[0, totalTickets)` with no gap
 *      and no overlap, in an order neither the keeper nor a verifier chooses.
 */
import { encodeAbiParameters, keccak256, type Address } from "viem";
import { toG1Point, verifyBeacon, randomness, winningTicket, roundAt, roundTime, DRAND_GENESIS } from "./drand.js";
import { ticketsFrom, ticketLeaf, holderOfTicket } from "./lottery.js";
import { cosignDrawVerdict, type DrawClaim } from "./cosign.js";

let checks = 0;
function ok(c: boolean, what: string) {
  if (!c) throw new Error(what);
  checks++;
}
function eq<T>(a: T, b: T, what: string) {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
  checks++;
}

// ---------------------------------------------------------------- 1. the beacon

const ROUND = 1_000_000;
const SIG = "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72";

ok(verifyBeacon(ROUND, SIG), "the real beacon verifies under the 43-byte DST");
ok(!verifyBeacon(ROUND + 1, SIG), "the same signature is refused for the wrong round");
ok(!verifyBeacon(ROUND, SIG.replace(/..$/, "00")), "a tampered signature is refused");

const point = toG1Point(SIG);
// The four words DrawLifecycle.t.sol hard-codes in `_sig()`.
eq(point.x_a, "0x0000000000000000000000000000000003ad29e4c409f9470fc2ef02f90214df", "x_a matches the Solidity vector");
eq(point.x_b, "0x49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72", "x_b matches the Solidity vector");
eq(point.y_a, "0x0000000000000000000000000000000001776ff7408b39c5f6f9fa50746efd7e", "y_a matches the Solidity vector");
eq(point.y_b, "0xea17fbb61f2e7b9c849ff0528e5a3deeedd029d0df345199963d75ba93b5a02a", "y_b matches the Solidity vector");

// ------------------------------------------------------- 2. the winning number

// `DrandLib.randomness` is keccak over the four packed words.
eq(
  randomness(point),
  BigInt(keccak256(`0x${[point.x_a, point.x_b, point.y_a, point.y_b].map((w) => w.slice(2)).join("")}`)),
  "randomness is keccak over the uncompressed point",
);
eq(winningTicket(point, 1_000_000n), 93_389n, "the winning ticket is the one the lifecycle test settles on");

// The round calendar, which decides when a draw can be settled at all.
eq(roundAt(DRAND_GENESIS), 1, "genesis is round 1");
eq(roundAt(DRAND_GENESIS + 3), 2, "one period on is round 2");
eq(roundTime(ROUND), DRAND_GENESIS + (ROUND - 1) * 3, "a round's time is its index times the period");
eq(roundAt(roundTime(ROUND)), ROUND, "the two are inverses");

// ------------------------------------------------------------------ 3. the leaf

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;

/** What `collect` computes, written out from the Solidity rather than reused. */
function leafByHand(holder: Address, start: bigint, end: bigint) {
  return keccak256(
    keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [holder, start, end],
    )),
  );
}
eq(ticketLeaf(A, 0n, 100n), leafByHand(A, 0n, 100n), "the leaf is the contract's double hash");
eq(ticketLeaf(B, 100n, 250n), leafByHand(B, 100n, 250n), "and for an interval that does not start at zero");

// --------------------------------------------------------------- 4. the tickets

const weights = new Map<string, bigint>([[C.toLowerCase(), 300n], [A.toLowerCase(), 100n], [B.toLowerCase(), 150n]]);
const set = ticketsFrom(3, 9, weights);

eq(set.totalTickets, 550n, "totalTickets is the sum of the weights");
eq(set.tickets.length, 3, "one interval per holder");
eq(set.tickets[0]!.holder.toLowerCase(), A.toLowerCase(), "intervals are laid out in ascending address order");
eq(set.tickets[2]!.holder.toLowerCase(), C.toLowerCase(), "…whatever order the weights arrived in");

// A partition: no gap, no overlap, and it ends exactly at totalTickets.
let cursor = 0n;
for (const t of set.tickets) {
  eq(t.start, cursor, `interval of ${t.holder} starts where the previous one ended`);
  ok(t.end > t.start, "every interval is non-empty");
  cursor = t.end;
}
eq(cursor, set.totalTickets, "the intervals cover [0, totalTickets) exactly");

// Every ticket belongs to exactly one holder — checked at each boundary, which
// is where a half-open interval written closed would go wrong.
eq(holderOfTicket(set, 0n).holder.toLowerCase(), A.toLowerCase(), "ticket 0 is the first holder's");
eq(holderOfTicket(set, 99n).holder.toLowerCase(), A.toLowerCase(), "the last ticket before the boundary too");
eq(holderOfTicket(set, 100n).holder.toLowerCase(), B.toLowerCase(), "and the boundary itself belongs to the NEXT holder");
eq(holderOfTicket(set, 549n).holder.toLowerCase(), C.toLowerCase(), "the very last ticket is inside the range");
let threw = false;
try { holderOfTicket(set, 550n); } catch { threw = true; }
ok(threw, "totalTickets itself is out of range");

// Determinism: the same weights in another order are the same tree and the same
// bytes. The keeper, the co-signer and a stranger must land on one root.
const shuffled = new Map<string, bigint>([[B.toLowerCase(), 150n], [C.toLowerCase(), 300n], [A.toLowerCase(), 100n]]);
const again = ticketsFrom(3, 9, shuffled);
eq(again.root, set.root, "the root does not depend on iteration order");
eq(again.json, set.json, "nor does the canonical JSON");
eq(again.digest, set.digest, "nor, therefore, the digest");

// A holder with no weight holds no ticket rather than an empty interval, which
// the contract would refuse (`ticketStart >= ticketEnd`).
const withZero = ticketsFrom(3, 9, new Map([[A.toLowerCase(), 100n], [B.toLowerCase(), 0n]]));
eq(withZero.tickets.length, 1, "a zero weight is left out of the tree");

// ------------------------------------------------- 5. what the co-signer refuses

const ROUND_NOW = 5_000;
const mine: DrawClaim = { root: set.root, totalTickets: "550", targetRound: ROUND_NOW + 300, digest: set.digest };
ok(cosignDrawVerdict({ ...mine }, mine, ROUND_NOW).sign, "a reproduced draw is signed");
ok(!cosignDrawVerdict({ ...mine, root: leafByHand(A, 0n, 1n) }, mine, ROUND_NOW).sign, "a different root is refused");
ok(!cosignDrawVerdict({ ...mine, totalTickets: "551" }, mine, ROUND_NOW).sign, "a different ticket count is refused");
ok(!cosignDrawVerdict({ ...mine, digest: leafByHand(A, 0n, 1n) }, mine, ROUND_NOW).sign, "a different digest is refused");
// The round is not reproduced — only bounded, by the contract's own margins.
ok(!cosignDrawVerdict({ ...mine, targetRound: ROUND_NOW + 199 }, mine, ROUND_NOW).sign, "a round under the 200 margin is refused");
ok(cosignDrawVerdict({ ...mine, targetRound: ROUND_NOW + 200 }, mine, ROUND_NOW).sign, "the margin itself is accepted");
ok(cosignDrawVerdict({ ...mine, targetRound: ROUND_NOW + 28_800 }, mine, ROUND_NOW).sign, "so is the cap");
ok(!cosignDrawVerdict({ ...mine, targetRound: ROUND_NOW + 28_801 }, mine, ROUND_NOW).sign, "past the cap is refused");

console.log(`lottery: ${checks} checks OK`);
