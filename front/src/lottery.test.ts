/**
 * The lottery's ticket tree, browser side.
 *
 * `LotteryDistributor.collect` re-hashes `(holder, ticketStart, ticketEnd)` and
 * verifies it against the root the draw committed — a root produced by
 * `@openzeppelin/merkle-tree` on the keeper's side. So the only thing worth
 * testing here is that this page's tree is byte-for-byte that library's, over
 * the LOTTERY's leaf types rather than the claim tree's. They differ in the
 * second and third members, which is exactly the kind of divergence that passes
 * every eyeball and reverts on-chain with `InvalidProof`.
 *
 * The other half is the winner: a half-open interval `[start, end)`, so the
 * ticket equal to `end` belongs to the NEXT holder. An off-by-one there hands
 * the prize to the wrong address, and the contract would happily verify it.
 */
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, encodeAbiParameters, concatHex, type Hex } from "viem";

(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { ticketTree, ticketLeafOf, holderOfTicket } = await import("./merkle.js");
const { oddsOf, ticketsMatch } = await import("./lottery.js");

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** The intervals exactly as `offchain/src/lottery.ts` lays them out: ascending
 *  address order, cumulative, half-open. */
function ticketsOf(weights: bigint[]) {
  let cursor = 0n;
  return weights.map((w, i) => {
    const t = { holder: addr(i + 1), start: cursor.toString(), end: (cursor + w).toString() };
    cursor += w;
    return t;
  });
}

// THE TREE. Every size from 1 to 40 — the shapes where a naive pairing and
// OpenZeppelin's complete-tree layout diverge (5, 7, 9, …) are inside it.
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 17, 23, 40]) {
  const tickets = ticketsOf(Array.from({ length: n }, (_, i) => BigInt((i + 1) * 1_000)));
  const rows = tickets.map((t) => [t.holder, t.start, t.end]);
  const oz = StandardMerkleTree.of(rows as never, ["address", "uint256", "uint256"] as never);
  const mine = ticketTree(tickets);
  assert.equal(mine.root, oz.root as Hex, `root matches OpenZeppelin at ${n} tickets`);

  for (const [i, v] of oz.entries()) {
    const proof = mine.proofFor(v[0] as string);
    assert.deepEqual(proof, oz.getProof(i) as Hex[], `proof matches at ${n} tickets, leaf ${i}`);
  }
}

// The leaf itself: the double keccak the contract computes inline.
{
  const holder = addr(7);
  const expected = keccak256(concatHex([
    keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] as never,
      [holder, 100n, 250n] as never,
    )),
  ]));
  assert.equal(ticketLeafOf(holder, 100n, 250n), expected, "the leaf is keccak(keccak(abi.encode(...)))");
  // And it is NOT the claim tree's leaf shape: same holder, different types.
  assert.notEqual(ticketLeafOf(holder, 0n, 1n), ticketLeafOf(addr(8), 0n, 1n), "the holder is part of the leaf");
}

// THE WINNER, on a half-open interval. [0,100) [100,300) [300,600)
{
  const tickets = ticketsOf([100n, 200n, 300n]);
  assert.equal(holderOfTicket(tickets, 0n)?.holder, addr(1), "ticket 0 is the first interval's");
  assert.equal(holderOfTicket(tickets, 99n)?.holder, addr(1), "…and so is the last one below its end");
  assert.equal(holderOfTicket(tickets, 100n)?.holder, addr(2), "the end belongs to the NEXT holder");
  assert.equal(holderOfTicket(tickets, 599n)?.holder, addr(3), "the last ticket is inside the last interval");
  assert.equal(holderOfTicket(tickets, 600n), null, "…and totalTickets itself is outside every one of them");
  assert.equal(holderOfTicket(tickets, 10n ** 30n), null, "a ticket beyond the set names nobody");
}

// The odds, which is what a holder reads before the beacon lands.
{
  const tickets = ticketsOf([100n, 300n]);
  assert.equal(oddsOf(tickets, addr(1), 400n), 25, "a quarter of the tickets is a 25 % chance");
  assert.equal(oddsOf(tickets, addr(2).toUpperCase(), 400n), 75, "the lookup is case-insensitive");
  assert.equal(oddsOf(tickets, addr(9), 400n), 0, "a non-holder has no chance and no error");
  assert.equal(oddsOf(tickets, addr(1), 0n), 0, "an empty draw does not divide by zero");
  // Counts are seconds × balance: they run past 2^53 and must not lose the
  // ratio on the way through Number.
  const big = [{ holder: addr(1), start: "0", end: (10n ** 30n).toString() }];
  assert.equal(oddsOf(big, addr(1), 10n ** 30n), 100, "a holder of every ticket reads 100 %, at any scale");
}

// The artifact is only usable if it reproduces what the DRAW committed. The
// sha256 says the bytes are the published ones; this says the tree in them is
// the one a proof will be checked against.
{
  const tickets = ticketsOf([100n, 300n]);
  const root = ticketTree(tickets).root;
  const set = { fromEpoch: 0, upToEpoch: 9, totalTickets: "400", root, tickets };
  assert.equal(ticketsMatch(set, root, 400n), true, "the published set matches its own root");
  assert.equal(ticketsMatch(set, root, 399n), false, "a different ticket count is refused");
  assert.equal(ticketsMatch(set, `0x${"11".repeat(32)}` as Hex, 400n), false, "…and so is a different root");
  assert.equal(ticketsMatch({ ...set, tickets: [] }, root, 400n), false, "an empty list proves nothing");
}

console.log("lottery: tickets identical to OpenZeppelin across 13 sizes, half-open intervals, odds at any scale");
