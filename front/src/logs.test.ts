/**
 * The two log walkers, and the only thing that can be wrong with them: the
 * window arithmetic.
 *
 * The node refuses any range over 10 000 blocks (`chain.ts`, `LOG_SPAN`) and it
 * says so as `-32000 internal server errror`, which reads like a node fault —
 * so an off-by-one here does not show up as a bad range, it shows up as a page
 * that reports the chain is broken. A gap between two windows is worse still:
 * it drops the log silently, and for `create.ts` that is a `StockRemoved` lost
 * and a delisted stock offered to a creator.
 */
import assert from "node:assert/strict";

(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { pub, logsBack, logsSince, LOG_SPAN, MIN_GAP_MS } = await import("./chain.js");

const HEAD = 1_000_000n;
pub.getBlockNumber = (async () => HEAD) as typeof pub.getBlockNumber;

// ------------------------------------------------------------- logsSince
{
  const asked: [bigint, bigint][] = [];
  const from = HEAD - 30_000n;
  const { logs, upTo } = await logsSince(from, async (f, t) => { asked.push([f, t]); return [f]; });

  assert.equal(upTo, HEAD, "the cursor returned is the head the scan reached");
  asked.sort((a, b) => Number(a[0] - b[0]));
  assert.equal(asked[0]![0], from, "the first window starts at the floor asked for");
  assert.equal(asked.at(-1)![1], HEAD, "the last window ends at the head, not past it");
  for (const [f, t] of asked) assert.ok(t - f + 1n <= 10_000n, `window ${f}-${t} is over the node's cap`);
  for (let i = 1; i < asked.length; i++) {
    assert.equal(asked[i]![0], asked[i - 1]![1] + 1n, "windows are contiguous: no block is scanned twice or skipped");
  }
  assert.equal(logs.length, asked.length, "every window's logs are kept");
}

// A floor above the head asks the node nothing at all — the normal case on a
// warm cache, where the cursor is one block behind the head.
{
  let calls = 0;
  const { logs, upTo } = await logsSince(HEAD + 1n, async () => { calls++; return [1n]; });
  assert.equal(calls, 0, "nothing to scan, nothing asked");
  assert.deepEqual(logs, []);
  assert.equal(upTo, HEAD);
}

// A THROTTLED window is retried rather than taking the scan down. This is the
// failure the create screen actually died of: ~270 windows against a node that
// rate-limits, one of them answered `Failed to fetch`, and the basket picker
// showed a viem error instead of the allowlist.
{
  const tries = new Map<string, number>();
  const from = HEAD - 30_000n;
  const { logs } = await logsSince(from, async (f, t) => {
    const n = (tries.get(`${f}`) ?? 0) + 1;
    tries.set(`${f}`, n);
    // The second window fails twice before it answers, like a throttle lifting.
    if (f === from + LOG_SPAN && n <= 2) throw new Error("HTTP request failed: Failed to fetch");
    return [f];
  });
  assert.equal(logs.length, tries.size, "every window lands, including the one that had to be retried");
  assert.equal(tries.get(`${from + LOG_SPAN}`), 3, "and it was asked three times, not once");
}

// The FIRST window refused takes the scan down: there is no prefix, so there is
// nothing true to return and nothing worth caching.
{
  await assert.rejects(
    logsSince(HEAD - 30_000n, async (f) => {
      if (f === HEAD - 30_000n) throw new Error("the node would not serve this range");
      return [f];
    }),
    /would not serve/,
    "retries are bounded, and with no prefix the scan fails rather than inventing one",
  );
}

// A LATER window refused returns the contiguous prefix with a cursor that says
// where it stopped. This is what lets a throttled visit cache something: before
// it, a cold scan that died at window 200 of 268 saved nothing, so the next
// visit walked all 268 again — measured 2026-09-16, 893 requests in 45 s and
// no cache written, twice in a row.
{
  const from = HEAD - 30_000n;
  const dead = from + LOG_SPAN * 2n;
  const { logs, upTo, head } = await logsSince(from, async (f) => {
    if (f >= dead) throw new Error("throttled");
    return [f];
  });
  assert.equal(head, HEAD, "the head reached for is reported whatever the scan managed");
  assert.equal(upTo, dead - 1n, "the cursor is the end of the last window that ANSWERED");
  assert.deepEqual(logs, [from, from + LOG_SPAN], "and the logs are exactly that prefix");
  // The property the cursor exists to guarantee: replaying from it covers every
  // block, so nothing is skipped between two visits.
  const { logs: rest } = await logsSince(upTo + 1n, async (f) => [f]);
  assert.equal(rest[0], upTo + 1n, "the next scan resumes on the very next block — no gap");
}

// A hole is never served as a prefix: window 2 fails, window 3 succeeds, and
// only windows 0 and 1 come back. A gap here drops a `StockRemoved` in silence.
{
  const from = HEAD - 30_000n;
  const { logs, upTo } = await logsSince(from, async (f) => {
    if (f === from + LOG_SPAN * 2n) throw new Error("throttled");
    return [f];
  }, 4);
  assert.ok(!logs.includes(from + LOG_SPAN * 3n), "nothing past the hole is returned");
  assert.equal(upTo, from + LOG_SPAN * 2n - 1n, "and the cursor stops before it");
}

// The lanes are PACED. Six of them with nothing in between issue as fast as the
// round trip allows, which is past what this node serves: it answers the excess
// with a 429 whose CORS headers the browser rejects, so the app sees "Failed to
// fetch" and retries, and the retry is what keeps it over the line. The gap is
// what holds the page under it — and it is per PAGE, not per lane, or six lanes
// each respecting it would still be six times too fast.
{
  let asked = 0;
  const from = HEAD - 60_000n;                 // seven windows, four lanes
  const t0 = Date.now();
  await logsSince(from, async (f) => { asked++; return [f]; }, 4);
  const took = Date.now() - t0;

  assert.equal(asked, 7, "every window was asked for");
  // The DURATION, not the gap between two starts: a busy machine can stall the
  // event loop and let several already-due timers fire in the same
  // millisecond, which looks like no pacing at all and is not. What pacing
  // guarantees is the floor on the whole run — a stall can only lengthen it.
  // Four lanes with no shared line would finish this in one tick.
  const floor = (asked - 1) * MIN_GAP_MS * 0.8;
  assert.ok(took >= floor, `seven paced windows took ${took} ms, under the ${floor} ms floor`);
}

// The BACKWARD walker is on the same line. Its parallel branch fires every span
// from one `Promise.all`, which is the shape of a burst — and it is the one the
// browser console caught throttling during a refresh, under `artifact.ts`.
{
  let asked = 0;
  const t0 = Date.now();
  await logsBack(async () => { asked++; return [] as bigint[]; }, 4);
  const took = Date.now() - t0;
  assert.equal(asked, 4, "every span was asked for");
  const floor = (asked - 1) * MIN_GAP_MS * 0.8;
  assert.ok(took >= floor, `four paced spans took ${took} ms, under the ${floor} ms floor`);
}

// -------------------------------------------------------------- logsBack
{
  // Only the third window back holds anything: the walk must reach it and stop.
  const asked: [bigint, bigint][] = [];
  const hit = HEAD - LOG_SPAN * 2n - 5n;
  const logs = await logsBack(async (f, t) => {
    asked.push([f, t]);
    return f <= hit && hit <= t ? ["found"] : [];
  }, 6, true);

  assert.deepEqual(logs, ["found"], "the walk finds a log three windows back");
  assert.equal(asked.length, 3, "and stops there rather than spending the six windows");
  assert.equal(asked[0]![1], HEAD, "the first window ends at the head");
  for (const [f, t] of asked) assert.ok(t - f + 1n <= 10_000n, `window ${f}-${t} is over the node's cap`);
  for (let i = 1; i < asked.length; i++) {
    assert.equal(asked[i]![1], asked[i - 1]![0] - 1n, "each window ends where the previous one began");
  }
}

// Every window, in parallel, when `first` is not set — and a window the node
// refuses costs that window and not the panel.
{
  const logs = await logsBack(async (f, t) => {
    if (Number((HEAD - t) / LOG_SPAN) % 2 === 0) throw new Error("the node would not serve this range");
    return [f];
  }, 6);
  assert.equal(logs.length, 3, "the three failed windows drop out, the three others land");
}

console.log("logs: windows contiguous, capped at 10 000, backward walk stops on the first hit");
