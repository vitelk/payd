/**
 * cu.ts — what a round costs at the RPC, in the unit the invoice is in.
 *
 * The keeper and the co-signer call a metered endpoint every minute, for ever.
 * Alchemy prices **per method**, not per request, which decides everything about
 * how this code should be written and was the thing nobody could see from the
 * inside:
 *
 *   - a JSON-RPC batch (`[{…},{…}]` in one HTTP POST) is billed as N methods, so
 *     batching the transport buys nothing. It is deliberately NOT enabled;
 *   - `Multicall3.aggregate3` is ONE `eth_call` whose calldata happens to invoke
 *     N reads. The node executes one call and charges for one call, whatever is
 *     inside it. That is why `config.ts` declares `contracts.multicall3` and the
 *     clients set `batch: { multicall }` — an eleven-read round costs 26 CU
 *     rather than 286.
 *
 * So the number worth watching is not requests, it is CU. This meters them.
 *
 * **It measures, it never decides.** Nothing here can fail a call, change a
 * cadence or skip a step: it wraps the transport, counts what went past, and
 * prints a line. A meter that can break the thing it meters is worse than no
 * meter.
 */
import type { Transport } from "viem";

/**
 * Alchemy's published compute-unit weights, as of 2026-09-15.
 *
 * **Re-read them off the dashboard rather than trusting this table**: Alchemy
 * has revised them more than once, and a weight that drifts turns this log line
 * into a confident wrong number. The check is the one that costs nothing — the
 * projection below against the month's actual usage. If they disagree, the
 * dashboard is right and this table is stale.
 */
const WEIGHTS: Readonly<Record<string, number>> = {
  eth_sendRawTransaction: 250,
  eth_estimateGas: 87,
  eth_getLogs: 75,
  eth_call: 26,
  eth_getTransactionCount: 26,
  eth_getBalance: 19,
  eth_gasPrice: 19,
  eth_getBlockByNumber: 16,
  eth_maxPriorityFeePerGas: 16,
  eth_feeHistory: 15,
  eth_getTransactionReceipt: 15,
  eth_blockNumber: 10,
  eth_chainId: 0,
};

/**
 * An unlisted method is priced as an `eth_call` rather than as free.
 *
 * Free would mean a new call site silently costs nothing in this log while
 * costing money on the invoice, which is exactly the blindness the file exists
 * to remove. It is also named once, so the table gets maintained.
 */
const DEFAULT_WEIGHT = 26;
const unknown = new Set<string>();

const round = new Map<string, number>();
const total = new Map<string, number>();
const startedAt = Date.now();

function charge(method: string): void {
  if (!(method in WEIGHTS) && !unknown.has(method)) {
    unknown.add(method);
    console.log(`cu: ${method} is not in the weight table, priced at ${DEFAULT_WEIGHT} CU — add it`);
  }
  round.set(method, (round.get(method) ?? 0) + 1);
  total.set(method, (total.get(method) ?? 0) + 1);
}

const weigh = (counts: Map<string, number>): number =>
  [...counts].reduce((sum, [m, n]) => sum + n * (WEIGHTS[m] ?? DEFAULT_WEIGHT), 0);

/** Wraps a transport so every request it carries is counted. */
export function metered(transport: Transport): Transport {
  return ((opts: Parameters<Transport>[0]) => {
    const t = transport(opts);
    return {
      ...t,
      request: ((args: { method: string }, options?: unknown) => {
        charge(args.method);
        return (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
      }) as typeof t.request,
    };
  }) as Transport;
}

const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`;

/**
 * One line: what this round cost, what the process has cost so far, and where
 * that lands over thirty days at the same rate.
 *
 * The projection is the point. A round costing 600 CU reads as nothing; the
 * same round 1 440 times a day for a month is 26 M, and that is the figure that
 * decides whether a cadence is affordable.
 *
 * Resets the round; the cumulative and the clock keep running.
 */
export function meterRound(): string {
  const spent = weigh(round);
  const soFar = weigh(total);
  const elapsed = Math.max(1, Date.now() - startedAt);
  const monthly = (soFar / elapsed) * 30 * 86_400_000;

  const top = [...round]
    .map(([m, n]) => [m, n * (WEIGHTS[m] ?? DEFAULT_WEIGHT)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m, cu]) => `${m.replace(/^eth_/, "")} ${cu}`)
    .join(", ");

  round.clear();
  return `cu: ${spent} this round (${top || "nothing"}), ${compact(soFar)} in ${Math.round(elapsed / 60_000)} min, ~${compact(monthly)}/30d`;
}

/** The CU a set of counts is worth. Exported for the test, and for nothing else. */
export const weightOf = (method: string): number => WEIGHTS[method] ?? DEFAULT_WEIGHT;
