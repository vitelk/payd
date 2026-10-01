/** The distribution polyline. `pnpm --filter front test` */
import assert from "node:assert/strict";
import { spark, cumulative } from "./spark.js";

// 1. THE test, and the reason the file exists: the baseline is ZERO, not the
//    minimum. A series that crept from $900 to $1000 must read as a 10 % rise
//    and not as a climb across the whole panel. Fitted to its own range the
//    first point would sit at y = 45 (the floor); anchored at zero it sits at
//    90 % of the height, which is what 900/1000 looks like.
{
  const s = spark([900, 1000], 100, 50)!;
  assert.ok(s, "two points are a series");
  const [first, last] = s.points.split(" ").map((p) => Number(p.split(",")[1]));
  assert.equal(last, 3, "the maximum touches the top padding");
  assert.ok(first! > 6 && first! < 9, `900/1000 must sit near the top, got y=${first}`);
}

// 2. Zero really is the floor: a series starting at 0 starts on the baseline.
{
  const s = spark([0, 50, 100], 100, 50)!;
  assert.equal(s.points, "3,47 50,25 97,3", "bottom, middle, top");
  assert.deepEqual(s.last, { x: 97, y: 3 });
  assert.equal(s.max, 100);
}

// 3. Refusals. Both render as a horizontal rule if allowed through, and "paid
//    nothing, steadily" is a different sentence from "no data yet".
{
  assert.equal(spark([], 100, 50), null, "no points");
  assert.equal(spark([42], 100, 50), null, "one point is not a series");
  assert.equal(spark([0, 0, 0], 100, 50), null, "no scale");
  assert.equal(spark([NaN, 7], 100, 50), null, "one survivor is not a series either");
}

// 4. A pool that would not answer drops its own point and takes nothing else
//    down: eleven legs priced and one NaN still draws eleven.
{
  const s = spark([1, NaN, 2, 3], 100, 50)!;
  assert.equal(s.points.split(" ").length, 3, "the NaN is dropped, the rest survive");
}

// 5. The area closes onto the baseline at both ends, or the fill leaks upward.
{
  const s = spark([0, 100], 100, 50)!;
  assert.ok(s.area.startsWith("M3,47 "), `area must open on the baseline, got ${s.area}`);
  assert.ok(s.area.endsWith("L97,47 Z"), `area must close on the baseline, got ${s.area}`);
}

// 6. Cumulative is monotonic and never goes backwards on a series of payments —
//    which is exactly what makes the line readable. A NaN window contributes
//    nothing rather than poisoning every point after it.
{
  assert.deepEqual(cumulative([1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(cumulative([1, NaN, 3]), [1, 1, 4], "a bad window is skipped, not propagated");
  assert.deepEqual(cumulative([]), []);
}

console.log("spark: 6 checks OK — zero baseline, degenerate series refused");
