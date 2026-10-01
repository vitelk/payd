/**
 * Equivalence with `@openzeppelin/merkle-tree`. `pnpm --filter front test`
 *
 * The front rebuilds the tree itself, to avoid shipping another 42 KB gzip in a
 * page we pin on IPFS. That is acceptable ONLY because this test compares root
 * and proofs against the real library — the one that produces the root committed
 * on-chain — leaf by leaf. The library is a test dependency, never a bundle one.
 *
 * The test also keeps the front's old algorithm (sorted leaves paired two by
 * two, odd one carried up) and REQUIRES that it diverge. It happened to be right
 * at 2, 3, 4, 6 and 8 leaves — so every quick trial passed — and wrong from 5 on.
 * At the scale of a real epoch, every `claim` would have reverted with
 * `InvalidProof`.
 */
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, concatHex, type Hex } from "viem";
import { claimTree, leafOf, type Entry } from "./merkle.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const entries = (n: number): Entry[] =>
  Array.from({ length: n }, (_, i) => ({
    holder: addr(i + 1),
    stock: addr(1000 + (i % 10)),
    cumulative: String(BigInt(i + 1) * 10n ** 15n + BigInt(i * i)),
  }));

/** Verification identical to `Distributor._verify`: sorted pairs. */
function verify(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let computed = leaf;
  for (const p of proof) {
    computed = computed < p ? keccak256(concatHex([computed, p])) : keccak256(concatHex([p, computed]));
  }
  return computed === root;
}

/** The front's old algorithm, kept only to prove it was wrong. */
function naiveRoot(list: Entry[]): Hex {
  let level = list.map((e) => leafOf(e.holder, e.stock, BigInt(e.cumulative))).sort();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!, b = level[i + 1];
      if (b === undefined) { next.push(a); continue; }
      next.push(a < b ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a])));
    }
    level = next;
  }
  return level[0]!;
}

const sizes = [...Array.from({ length: 40 }, (_, i) => i + 1), 64, 100, 137, 200];

for (const n of sizes) {
  const list = entries(n);
  const mine = claimTree(list);
  const oz = StandardMerkleTree.of(
    list.map((e) => [e.holder, e.stock, BigInt(e.cumulative)]) as never,
    ["address", "address", "uint256"] as never,
  );

  // 1. Same root as the library that commits to the chain.
  assert.equal(mine.root, oz.root, `root mismatch at ${n} leaves`);

  // 2. Same proofs, and each one passes the contract's verification.
  for (const [i, v] of oz.entries()) {
    const holder = String(v[0]) as `0x${string}`;
    const stock = String(v[1]) as `0x${string}`;
    const proof = mine.proofFor(holder, stock);
    assert.ok(proof, `missing proof for ${holder} at ${n} leaves`);
    assert.deepEqual(proof, oz.getProof(i), `proof mismatch at ${n} leaves`);
    assert.ok(verify(proof, mine.root, leafOf(holder, stock, BigInt(String(v[2])))), `invalid proof at ${n}`);
  }
}

// 3. Input order does not change the root: leaves are re-sorted.
const shuffled = [...entries(23)].reverse();
assert.equal(claimTree(shuffled).root, claimTree(entries(23)).root, "the root depends on input order");

// 4. A missing pair returns null, not an exception.
assert.equal(claimTree(entries(4)).proofFor(addr(999) as `0x${string}`, addr(1000) as `0x${string}`), null);

// 5. The naive pairing does diverge — that is the bug we lock down.
const diverging = [5, 7, 9, 11, 13].filter((n) => naiveRoot(entries(n)) !== claimTree(entries(n)).root);
assert.deepEqual(diverging, [5, 7, 9, 11, 13], "naive pairing no longer diverges: the comparison proves nothing any more");

// 6. THE PUSH TREE. `distribute` -- the only path the Collector
//    emprunte -- verifie contre `pushRoot`, pas `claimRoot` (`Distributor._settle`).
//    On the keeper's side that tree is `sorted.filter(pushKeys)` handed to the
//    same StandardMerkleTree; in the browser it is `claimTree` over the entries
//    marked `push`. Those two sentences have to describe the same tree.
//
//    And above all: a proof built on the FULL tree must NOT pass against
//    `pushRoot`. That is the bug we nearly shipped -- it clears every check in
//    the page and only shows itself by paying for the transaction.
for (const n of [5, 9, 23, 64, 137]) {
  const list = entries(n);
  // One holder in three deserves the push: enough for the two trees to differ,
  // not enough for them to coincide.
  const pushed = list.filter((_, i) => i % 3 === 0);

  const minePush = claimTree(pushed);
  const ozPush = StandardMerkleTree.of(
    pushed.map((e) => [e.holder, e.stock, BigInt(e.cumulative)]) as never,
    ["address", "address", "uint256"] as never,
  );
  assert.equal(minePush.root, ozPush.root, `push root mismatch at ${n}`);

  const mineClaim = claimTree(list);
  assert.notEqual(minePush.root, mineClaim.root, `both trees coincide at ${n}: the test proves nothing`);

  for (const e of pushed) {
    const h = e.holder as `0x${string}`, st = e.stock as `0x${string}`;
    const leaf = leafOf(h, st, BigInt(e.cumulative));

    // The right proof passes against the right root.
    const good = minePush.proofFor(h, st);
    assert.ok(good && verify(good, minePush.root, leaf), `push proof invalide a ${n}`);

    // The full tree's proof does NOT pass against the push root.
    const wrong = mineClaim.proofFor(h, st)!;
    assert.ok(!verify(wrong, minePush.root, leaf), `a claim proof passes against pushRoot at ${n}`);
  }

  // A holder outside the push has no push proof -- null, not an exception.
  const out = list.find((_, i) => i % 3 !== 0)!;
  assert.equal(minePush.proofFor(out.holder as `0x${string}`, out.stock as `0x${string}`), null);
}

console.log(`merkle: identical to OpenZeppelin across ${sizes.length} sizes (1 to 200 leaves), naive pairing diverges, push tree distinct from claim tree`);
