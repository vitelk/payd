/**
 * lottery.ts — the ticket set a draw is committed to.
 *
 * **One window, one draw, one winner.** The distribution mode folds every
 * window since genesis into a cumulative owed per holder; a lottery does not
 * accumulate a debt, it accumulates a POT, and each draw pays `POT_BPS` of it
 * to exactly one address. So the ticket set covers the window since the LAST
 * draw and nothing before it: `_publishDraw` refuses an `upToEpoch` that does
 * not move past `draws[drawCount].upToEpoch`, which makes the scopes a
 * partition of the calendar rather than a cumulative sum.
 *
 * **A ticket is a second of holding, not a token.** The count is the same
 * time-weighted balance the distribution mode pays by (`∫ balance dt / L`,
 * §S38), reused verbatim through `windowShares` — so a sniper who held for an
 * instant gets an instant's worth of tickets, and the draw cannot be farmed by
 * buying just before the window closes. It also means the eligibility floor
 * applies here as it does everywhere else: a holder too small to be in a
 * distribution tree is too small to hold a ticket, which keeps one rule for
 * "who is a holder" across every mode rather than two.
 *
 * **Intervals, not counts.** The leaf is `(holder, start, end)` over a
 * half-open `[start, end)`, so the contract settles the draw with ONE proof
 * instead of walking a list: the winning ticket falls in exactly one interval.
 * The intervals are laid out in ascending address order — the one ordering both
 * a keeper and a verifier reach without agreeing on anything first.
 */
import { createHash } from "node:crypto";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { RPC_URL, minShareFor } from "./config.js";
import { feeVaultAbi, lotteryDistributorAbi } from "./abis.js";
import { windowShares } from "./epoch.js";
import { windows } from "./snapshot.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

/** `(holder, ticketStart, ticketEnd)` — exactly what `collect` re-hashes. */
export const TICKET_LEAF_TYPES = ["address", "uint256", "uint256"] as const;

/** `Draw.totalTickets` is a `uint128`. A window that overflows it is a window
 *  whose tickets cannot be committed, and failing here beats a silent
 *  truncation that would put every holder in the wrong interval. */
const MAX_TICKETS = (1n << 128n) - 1n;

export interface Ticket {
  holder: Address;
  start: bigint;
  end: bigint;
}

export interface TicketSet {
  fromEpoch: number;
  upToEpoch: number;
  totalTickets: bigint;
  root: Hex;
  tickets: Ticket[];
  /** The canonical JSON the digest commits to. */
  json: string;
  /** sha256 of that JSON — the 32 bytes `publishDraw` commits to, and what a
   *  holder's downloaded artifact is checked against. The same commitment
   *  `publishEpoch` computes for a distribution root, computed HERE so the
   *  keeper and the co-signer read one value rather than two implementations
   *  of one hash. */
  digest: Hex;
  proofFor(holder: Address): string[];
}

/** Serialisation that sorts by itself, for `canonicalJson`'s reason: two honest
 *  machines handed the same window must produce the same bytes, or their CIDs
 *  differ and a verifier reads that as fraud. */
function canonicalTicketJson(s: Omit<TicketSet, "json" | "digest" | "proofFor">): string {
  return JSON.stringify({
    fromEpoch: s.fromEpoch,
    upToEpoch: s.upToEpoch,
    totalTickets: s.totalTickets.toString(),
    root: s.root,
    tickets: s.tickets.map((t) => ({ holder: t.holder, start: t.start.toString(), end: t.end.toString() })),
  });
}

/**
 * The epochs a new draw would cover: everything past the last draw, up to the
 * last epoch a purchase has actually funded.
 *
 * The ceiling is the funded frontier and not `currentEpoch() - 1` on purpose.
 * A window that was never funded bought no stock, so it contributed nothing to
 * the pot; committing tickets over it would hand a share of somebody else's
 * purchase to holders of a period that paid for none of it.
 */
export async function drawScope(distributor: Address): Promise<{ fromEpoch: number; upToEpoch: number } | null> {
  const count = await client.readContract({
    address: distributor, abi: lotteryDistributorAbi, functionName: "drawCount",
  }) as bigint;
  let fromEpoch = 0;
  if (count > 0n) {
    const last = await client.readContract({
      address: distributor, abi: lotteryDistributorAbi, functionName: "draws", args: [count],
    }) as readonly unknown[];
    // `upToEpoch` is the fourth member of `Draw`.
    fromEpoch = Number(last[3] as bigint) + 1;
  }
  const funded = await windows(distributor);
  if (funded.length === 0) return null;
  const upToEpoch = Math.max(...funded.map((w) => w.toEpoch));
  if (upToEpoch < fromEpoch) return null;
  return { fromEpoch, upToEpoch };
}

/**
 * Builds the ticket set for `[fromEpoch, upToEpoch]`.
 *
 * Deterministic in its inputs and in nothing else — same chain, same window,
 * same root, whoever runs it and whenever. That is what lets a holder, a
 * co-signer or a stranger rebuild the tree and check the published root before
 * the beacon that picks the winner even exists.
 */
export async function buildTickets(
  distributor: Address,
  vault: Address,
  fromEpoch: number,
  upToEpoch: number,
): Promise<TicketSet> {
  const [token, quote, minBuyQuote] = await Promise.all([
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }),
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "QUOTE" }),
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
  ]);
  if (token === "0x0000000000000000000000000000000000000000") throw new Error("vault is not bound to a token");
  const minShare = minShareFor(quote as string, minBuyQuote as bigint);

  const weights = new Map<string, bigint>();
  for (const w of await windows(distributor)) {
    if (w.fromEpoch < fromEpoch || w.toEpoch > upToEpoch) continue;
    const sh = await windowShares(distributor, token as Address, w, minShare);
    if (!sh) continue;
    for (const [holder, weight] of Object.entries(sh.weights)) {
      const k = holder.toLowerCase();
      weights.set(k, (weights.get(k) ?? 0n) + BigInt(weight));
    }
  }
  if (weights.size === 0) throw new Error(`no ticket holder in epochs ${fromEpoch}-${upToEpoch}`);

  return ticketsFrom(fromEpoch, upToEpoch, weights);
}

/**
 * Weights → intervals → tree. **Pure**, and separated from the chain reads for
 * the reason `weighBalances` is: this is the half that decides who can win, so
 * it is the half that has to be testable without an RPC.
 */
export function ticketsFrom(fromEpoch: number, upToEpoch: number, weights: Map<string, bigint>): TicketSet {
  const holders = [...weights.entries()]
    .filter(([, w]) => w > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (holders.length === 0) throw new Error("no ticket holder with a positive weight");

  const tickets: Ticket[] = [];
  let cursor = 0n;
  for (const [holder, weight] of holders) {
    tickets.push({ holder: holder as Address, start: cursor, end: cursor + weight });
    cursor += weight;
  }
  if (cursor > MAX_TICKETS) throw new Error(`totalTickets ${cursor} overflows uint128`);

  const rows = tickets.map((t) => [t.holder, t.start, t.end] as const);
  const tree = StandardMerkleTree.of(rows as never, TICKET_LEAF_TYPES as never);
  const partial = { fromEpoch, upToEpoch, totalTickets: cursor, root: tree.root as Hex, tickets };
  const json = canonicalTicketJson(partial);

  return {
    ...partial,
    json,
    digest: `0x${createHash("sha256").update(json).digest("hex")}` as Hex,
    proofFor(holder: Address) {
      for (const [i, v] of tree.entries()) {
        if ((v[0] as string).toLowerCase() === holder.toLowerCase()) return tree.getProof(i);
      }
      throw new Error(`${holder} holds no ticket in this draw`);
    },
  };
}

/** The interval containing `ticket` — who actually won, off-chain. */
export function holderOfTicket(s: TicketSet, ticket: bigint): Ticket {
  const found = s.tickets.find((t) => ticket >= t.start && ticket < t.end);
  if (!found) throw new Error(`ticket ${ticket} is outside [0, ${s.totalTickets})`);
  return found;
}

/** The leaf exactly as `collect` recomputes it. Exposed for cross-checks. */
export function ticketLeaf(holder: Address, start: bigint, end: bigint): Hex {
  return StandardMerkleTree.of([[holder, start, end]] as never, TICKET_LEAF_TYPES as never)
    .leafHash([holder, start, end] as never) as Hex;
}
