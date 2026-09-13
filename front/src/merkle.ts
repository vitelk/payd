/**
 * Merkle proofs, browser side.
 *
 * **Do not naively pair sorted leaves two by two.** That is what this page used
 * to do, and it is wrong: the root committed on-chain comes from
 * `@openzeppelin/merkle-tree` (`offchain/src/merkle.ts`), which lays leaves out
 * in a COMPLETE binary tree. The two shapes coincide at 2, 3, 4, 6 and 8 leaves
 * — so every quick trial passes — and diverge at 5, 7, 9. At the scale of a real
 * epoch, every `claim` would have reverted with `InvalidProof`.
 *
 * So we reproduce OZ's shape exactly, using viem's keccak which is already
 * bundled rather than pulling the library in (it added +42 KB gzip to a page we
 * pin on IPFS). The guarantee does not come from re-reading this file:
 * `merkle.test.ts` compares root AND proofs against the real library, leaf by
 * leaf, from 1 to 200 entries. If OZ changes its tree shape, the test fails.
 */
import { keccak256, encodeAbiParameters, concatHex, type Address, type Hex } from "viem";

/** Identical to `offchain/src/merkle.ts`. A one-bit divergence invalidates everything. */
export const LEAF_TYPES = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;

export interface Entry {
  holder: string;
  stock: string;
  /** Cumulative amount owed since genesis, in raw units, serialised as decimal. */
  cumulative: string;
}

/** Leaf exactly as `Distributor._one` recomputes it: double keccak. */
export function leafOf(holder: string, stock: string, cumulative: bigint): Hex {
  return keccak256(concatHex([
    keccak256(encodeAbiParameters(LEAF_TYPES as never, [holder, stock, cumulative] as never)),
  ]));
}

/** Ordered pair, as in `Distributor._verify` and as in OZ. */
const hashPair = (a: Hex, b: Hex): Hex =>
  a < b ? keccak256(concatHex([a, b])) : keccak256(concatHex([b, a]));

/**
 * Builds the entitlement tree (every entry in the artifact) and returns the
 * proofs. Input order has no influence: leaves are re-sorted by hash, exactly as
 * on the keeper side.
 */
export function claimTree(entries: Entry[]) {
  if (entries.length === 0) throw new Error("no entries");

  // Leaves sorted by ascending hash, then laid out BACKWARDS in the second half
  // of a complete binary tree of 2n-1 nodes: that is OpenZeppelin's layout, and
  // it is what fixes the root.
  const leaves = entries
    .map((e) => ({ key: `${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`, hash: leafOf(e.holder, e.stock, BigInt(e.cumulative)) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const size = 2 * leaves.length - 1;
  const tree = new Array<Hex>(size);
  leaves.forEach((l, i) => { tree[size - 1 - i] = l.hash; });
  for (let i = size - 1 - leaves.length; i >= 0; i--) {
    tree[i] = hashPair(tree[2 * i + 1]!, tree[2 * i + 2]!);
  }

  const indexOfKey = new Map<string, number>();
  leaves.forEach((l, i) => indexOfKey.set(l.key, size - 1 - i));

  return {
    root: tree[0]!,
    /** `null` if the pair is not in the tree — never an exception. */
    proofFor(holder: Address, stock: Address): Hex[] | null {
      let j = indexOfKey.get(`${holder.toLowerCase()}:${stock.toLowerCase()}`);
      if (j === undefined) return null;
      const proof: Hex[] = [];
      while (j > 0) {
        proof.push(tree[j % 2 === 0 ? j - 1 : j + 1]!);
        j = Math.floor((j - 1) / 2);
      }
      return proof;
    },
  };
}
