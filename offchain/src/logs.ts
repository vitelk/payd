/**
 * Log reading that survives the limits of Robinhood Chain's public RPC.
 *
 * Two constraints measured on 2026-09-03:
 *   - the node refuses any query whose result exceeds 10,000 logs
 *     ("logs matched by query exceeds limit of 10000");
 *   - it is NOT an archive node: past state is unreadable, but logs are readable
 *     over the whole history.
 *
 * A third, measured on 2026-09-04: the node also refuses a range it cannot scan
 * in time, and it says so differently — code -32000, "log query timed out". It
 * is the SAME signal (the range is too wide) and it must halve the span too.
 * Treating it as a fatal error instead killed selfcheck on a 50,000-block
 * window, and would have killed the keeper the first time a token got busy.
 *
 * A fourth, measured on 2026-09-07 against `rpc-robinhood.blockmachine.io`: an
 * archive node that caps the RANGE itself rather than the result — "block range
 * exceeds maximum allowed (max=10000, requested=50000)". The same signal in a
 * fourth wording, and the one that matters most: that node is the only second
 * source we found still serving this chain's full history, and an unrecognised
 * refusal made it look broken when it is in fact the honest one. The node that
 * truncates SILENTLY is the dangerous one — see recompute.ts.
 *
 * So we cut into ranges, halve the span when the node refuses, and widen again
 * when it passes. The result never depends on how it was cut, so two machines
 * with different latencies produce the same state.
 */
import { decodeEventLog, encodeEventTopics, type Abi, type PublicClient } from "viem";

export interface RawLog {
  /** Which contract emitted it. The only way to demultiplex a multi-address scan. */
  address: `0x${string}`;
  blockNumber: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
}

// Every way this node says "that range was too wide". Anything matching halves
// the span; anything else is a real error and propagates.
// A fifth wording, measured 2026-09-12 against `robinhood-rpc.publicnode.com`:
// "exceed maximum block range: 50000" — no trailing "s", because the subject is
// the query and not the range. `exceeds maximum` did not match it, so a refusal
// that means "halve the span" propagated as a fatal error instead. The verb is
// optional-s from here on; do not re-tighten it to match one node's grammar.
//
// A sixth, measured 2026-09-12 against `lb.drpc.live` on launch night: a bare
// **HTTP 400 "Bad Request"**, with no word about ranges anywhere in it. That
// node caps `eth_getLogs` below our 50,000-block page and says so only in the
// status code, so the keeper's fifth preflight — the cross-check, which
// recomputes the root against the fallback node — failed as a hard error and
// cancelled every publication. Four checks green, one fatal, no root.
//
// Halving on a 400 is safe even where the request is genuinely malformed: the
// span floor is 1, `span > 1` stops the loop there, and the error propagates
// then. The cost of being wrong is ~16 extra requests before the same throw.
const RANGE_TOO_WIDE = /exceeds? (limit|maximum)|block range|too many|response size|query returned more|timed out|timeout|bad request|\b400\b/i;

// Every way a node says "you are going too fast". A DIFFERENT signal from the one
// above: the span is not the problem, so halving it would shrink the pages for
// ever and never fix anything. We sleep and retry the SAME range instead.
//
// The last alternative is uglier than it looks. Measured 2026-09-07 against
// blockmachine — 20 of 30 concurrent requests refused — a throttled call comes
// back with a body viem cannot parse and surfaces as
// "Cannot read properties of undefined (reading 'error')". It is a 429 wearing a
// TypeError's clothes, and viem's own retryCount does not catch it because it is
// not an HTTP error by the time it reaches us.
//
// Retrying is safe: a response that is not valid JSON-RPC is never a legitimate
// answer to a read. What would NOT be safe is treating it as an empty page —
// that is precisely how holders disappear without the totals looking wrong.
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|capacity|quota|reading 'error'/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `address` accepts a LIST. One filter over N contracts costs one set of pages
 * instead of N, which is what keeps the keeper's round flat as the registry
 * grows — see `prefetchTransfers` in snapshot.ts. The node buckets nothing for
 * us: the caller demultiplexes on `log.address`.
 */
export async function scanLogs(
  client: PublicClient,
  params: { address: string | string[]; fromBlock: number; toBlock: number; topics: (string | null)[] },
  onLogs: (logs: RawLog[]) => void,
  opts: { maxSpan?: number; maxStalls?: number; backoffMs?: number } = {},
): Promise<{ requests: number; logs: number }> {
  const maxSpan = opts.maxSpan ?? 50_000;
  const maxStalls = opts.maxStalls ?? 6;
  const backoffMs = opts.backoffMs ?? 250;
  let span = maxSpan;
  let cursor = params.fromBlock;
  let requests = 0;
  let total = 0;
  let stalls = 0;

  while (cursor <= params.toBlock) {
    const to = Math.min(cursor + span - 1, params.toBlock);
    try {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [{
          address: params.address,
          fromBlock: ("0x" + cursor.toString(16)) as `0x${string}`,
          toBlock: ("0x" + to.toString(16)) as `0x${string}`,
          topics: params.topics,
        }],
      } as never)) as unknown as RawLog[];

      requests++;
      total += logs.length;
      onLogs(logs);
      cursor = to + 1;
      stalls = 0; // the throttling budget is per stall, not per scan
      // Widen back cautiously when a range passes comfortably.
      if (logs.length < 4_000 && span < maxSpan) span = Math.min(span * 2, maxSpan);
    } catch (err) {
      const msg = String((err as { details?: string; message?: string })?.details ?? (err as Error)?.message ?? "");
      if (RANGE_TOO_WIDE.test(msg) && span > 1) {
        span = Math.max(1, Math.floor(span / 2));
        continue;
      }
      if (RATE_LIMITED.test(msg) && stalls < maxStalls) {
        // Exponential, capped: a node under load needs seconds, not minutes, and
        // an unbounded wait would hide a node that is simply gone.
        await sleep(Math.min(8_000, backoffMs * 2 ** stalls));
        stalls++;
        continue;
      }
      throw err;
    }
  }
  return { requests, logs: total };
}

/**
 * The same paging, for a DECODED event stream.
 *
 * `getContractEvents` takes one range and asks for it in one request. Three
 * callers did that over a cursor pinned at the deployment block — cosign.ts,
 * watch.ts and check.ts — and on 2026-09-12 the co-signer proved what it costs:
 * the public node caps a query at 50,000 blocks, the range from genesis grew
 * past that within the hour, and the cursor stopped advancing FOR EVER. The gap
 * only widens, so nothing about it self-heals: "a root put on the record inside
 * it is unpoliced", every two minutes, for as long as the process runs.
 *
 * A guard in each caller would have been three guards. `scanLogs` already knew
 * how to page and how to halve on refusal; this is that, plus the decode the
 * callers were getting from viem.
 */
export async function scanEvents(
  client: PublicClient,
  params: { address: string | string[]; abi: readonly unknown[]; eventName: string; fromBlock: bigint; toBlock: bigint },
  opts: { maxSpan?: number; maxStalls?: number; backoffMs?: number } = {},
): Promise<Array<{ address: `0x${string}`; blockNumber: bigint; args: unknown }>> {
  const topics = encodeEventTopics({ abi: params.abi as Abi, eventName: params.eventName }) as (string | null)[];
  const out: Array<{ address: `0x${string}`; blockNumber: bigint; args: unknown }> = [];
  await scanLogs(
    client,
    { address: params.address, fromBlock: Number(params.fromBlock), toBlock: Number(params.toBlock), topics },
    (logs) => {
      for (const l of logs) {
        // A log matching topic0 that this ABI cannot decode is not ours to
        // interpret. Dropping it is what `getContractEvents` does with
        // `strict` left at its default, so callers see no change.
        let args: unknown;
        try {
          args = decodeEventLog({ abi: params.abi as Abi, data: l.data, topics: l.topics as [] }).args;
        } catch {
          continue;
        }
        out.push({ address: l.address, blockNumber: BigInt(l.blockNumber), args });
      }
    },
    opts,
  );
  return out;
}
