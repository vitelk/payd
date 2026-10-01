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
/**
 * OZ's layout over leaves that are ALREADY hashed, keyed by whatever the caller
 * looks them up by.
 *
 * Extracted when the lottery mode arrived with a second leaf shape
 * `(address, uint256, uint256)`: the tree is the part that has to match
 * OpenZeppelin byte for byte, and two copies of it is two chances to get it
 * wrong in a way only a reverted transaction reveals. The leaf types stay with
 * each caller — they are what each contract re-hashes — and the shape stays
 * here, tested once against the real library (`merkle.test.ts`).
 */
export function treeOf(leaves: { key: string; hash: Hex }[]) {
  if (leaves.length === 0) throw new Error("no entries");

  // Leaves sorted by ascending hash, then laid out BACKWARDS in the second half
  // of a complete binary tree of 2n-1 nodes: that is OpenZeppelin's layout, and
  // it is what fixes the root.
  const sorted = [...leaves].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const size = 2 * sorted.length - 1;
  const tree = new Array<Hex>(size);
  sorted.forEach((l, i) => { tree[size - 1 - i] = l.hash; });
  for (let i = size - 1 - sorted.length; i >= 0; i--) {
    tree[i] = hashPair(tree[2 * i + 1]!, tree[2 * i + 2]!);
  }

  const indexOfKey = new Map<string, number>();
  sorted.forEach((l, i) => indexOfKey.set(l.key, size - 1 - i));

  return {
    root: tree[0]!,
    /** `null` if the key is not in the tree — never an exception. */
    proofFor(key: string): Hex[] | null {
      let j = indexOfKey.get(key);
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

export function claimTree(entries: Entry[]) {
  const tree = treeOf(entries.map((e) => ({
    key: `${e.holder.toLowerCase()}:${e.stock.toLowerCase()}`,
    hash: leafOf(e.holder, e.stock, BigInt(e.cumulative)),
  })));
  return {
    root: tree.root,
    proofFor: (holder: Address, stock: Address): Hex[] | null =>
      tree.proofFor(`${holder.toLowerCase()}:${stock.toLowerCase()}`),
  };
}

// ------------------------------------------------------------- the lottery's

/** The lottery's leaf types: one holder, one half-open ticket interval.
 *  `LotteryDistributor.collect` re-hashes exactly this. */
export const TICKET_TYPES = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }] as const;

/** Leaf exactly as `collect` recomputes it: the same double keccak. */
export function ticketLeafOf(holder: string, start: bigint, end: bigint): Hex {
  return keccak256(concatHex([
    keccak256(encodeAbiParameters(TICKET_TYPES as never, [holder, start, end] as never)),
  ]));
}

export interface Ticket { holder: string; start: string; end: string }

/**
 * The ticket tree of one draw, and the proof its winner needs.
 *
 * Keyed by the HOLDER alone: `offchain/src/lottery.ts` lays out one interval per
 * holder, so there is exactly one leaf each — and the winner is identified by
 * the interval containing the winning ticket, not by a stock.
 */
export function ticketTree(tickets: Ticket[]) {
  const tree = treeOf(tickets.map((t) => ({
    key: t.holder.toLowerCase(),
    hash: ticketLeafOf(t.holder, BigInt(t.start), BigInt(t.end)),
  })));
  return {
    root: tree.root,
    proofFor: (holder: string): Hex[] | null => tree.proofFor(holder.toLowerCase()),
  };
}

/** The interval containing `ticket` — who won, computed from the artifact the
 *  same way `offchain/src/lottery.ts` does. `null` when the ticket falls
 *  outside every interval, which is a corrupt artifact and not a winner. */
export function holderOfTicket(tickets: Ticket[], ticket: bigint): Ticket | null {
  return tickets.find((t) => ticket >= BigInt(t.start) && ticket < BigInt(t.end)) ?? null;
}
