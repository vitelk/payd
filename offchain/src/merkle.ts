/**
 * merkle.ts — CUMULATIVE trees.
 *
 * A leaf carries `(holder, stock, cumulative since genesis)`. It carries NO
 * epoch: that is what lets one entry settle as many epochs as you like, and what
 * makes the settlement cost proportional to the number of stocks rather than to
 * elapsed time (docs/ARCHITECTURE.md §S18).
 *
 * We lean on `@openzeppelin/merkle-tree` rather than a home-grown
 * implementation: it produces exactly what `Distributor._verify` expects —
 * double-hashed leaves, sorted pairs. A one-bit divergence would make every
 * proof invalid.
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address } from "viem";

export const LEAF_TYPES = ["address", "address", "uint256"] as const;

export interface Entry {
  holder: Address;
  stock: Address;
  /** Cumulative amount owed since genesis, across all epochs. */
  cumulative: bigint;
}

export interface BuiltRoot {
  claimRoot: `0x${string}`;
  pushRoot: `0x${string}`;
  entries: Entry[];
  pushKeys: Set<string>;
  proofFor(holder: Address, stock: Address, tree: "claim" | "push"): string[];
}

export const key = (holder: Address, stock: Address) => `${holder.toLowerCase()}:${stock.toLowerCase()}`;

/** Splits `funded` pro-rata. Integer division, never a fix-up on the last
 *  entry: two implementations must agree to the wei. */
export function shareOf(balance: bigint, eligibleSupply: bigint, funded: bigint): bigint {
  if (eligibleSupply <= 0n) throw new Error("eligibleSupply is zero");
  return (funded * balance) / eligibleSupply;
}

export function build(entries: Entry[], pushKeys: Set<string>): BuiltRoot {
  if (entries.length === 0) throw new Error("no entries");

  // Stable sort by (holder, stock): the output must not depend on a Map's
  // iteration order, which depends on the RPC.
  const sorted = [...entries].sort((a, b) =>
    key(a.holder, a.stock) < key(b.holder, b.stock) ? -1 : 1,
  );

  const rows = (list: Entry[]) => list.map((e) => [e.holder, e.stock, e.cumulative] as const);
  const claimTree = StandardMerkleTree.of(rows(sorted) as never, LEAF_TYPES as never);
  const pushed = sorted.filter((e) => pushKeys.has(key(e.holder, e.stock)));
  const pushTree = pushed.length ? StandardMerkleTree.of(rows(pushed) as never, LEAF_TYPES as never) : null;

  const find = (tree: typeof claimTree | null, holder: Address, stock: Address) => {
    if (!tree) throw new Error("push tree is empty");
    for (const [i, v] of tree.entries()) {
      if ((v[0] as string).toLowerCase() === holder.toLowerCase() && (v[1] as string).toLowerCase() === stock.toLowerCase()) {
        return tree.getProof(i);
      }
    }
    throw new Error(`${holder}/${stock} is not in the tree`);
  };

  return {
    claimRoot: claimTree.root as `0x${string}`,
    pushRoot: (pushTree?.root ?? ("0x" + "0".repeat(64))) as `0x${string}`,
    entries: sorted,
    pushKeys,
    proofFor: (holder, stock, which) => find(which === "claim" ? claimTree : pushTree, holder, stock),
  };
}

/** Leaf exactly as the contract recomputes it. Exposed for cross-checks. */
export function leafOf(holder: Address, stock: Address, cumulative: bigint): `0x${string}` {
  return StandardMerkleTree.of([[holder, stock, cumulative]] as never, LEAF_TYPES as never)
    .leafHash([holder, stock, cumulative] as never) as `0x${string}`;
}
