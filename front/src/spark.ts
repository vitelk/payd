/**
 * spark.ts — one polyline, and the arithmetic that places it.
 *
 * The purchase history is a table of twelve rows. A table answers "what
 * happened at epoch #212"; it does not answer "is this accelerating", which is
 * the only question a visitor actually has about a series. One `<polyline>`
 * does, costs no dependency, and reads the same in both themes.
 *
 * **The baseline is zero and never the minimum.** Every chart library defaults
 * to fitting the data — min at the bottom, max at the top — and on a cumulative
 * money series that turns a 2 % rise into a full-height climb. The series here
 * is dollars paid to holders since genesis, a number a reader may act on, so
 * the axis starts where the money started. That single decision is why this is
 * fifty lines of our own rather than an import.
 *
 * Pure, like `yield.ts`, `curve.ts` and `basket.ts`, and for their reason: it
 * has to be checkable under node with no chain and no DOM in the way. See
 * `spark.test.ts`.
 */

export interface Spark {
  /** `points` for a `<polyline>`. */
  points: string;
  /** The same curve, closed onto the baseline, for a `<path>` fill. */
  area: string;
  /** Where the series ends — the dot that says "and here we are". */
  last: { x: number; y: number };
  /** The top of the axis, so a caller can label it. */
  max: number;
}

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * `null` rather than a flat line when there is nothing to draw.
 *
 * Fewer than two points is not a series, and a maximum of zero has no scale —
 * both would render as a horizontal rule across the panel, which reads as
 * "paid nothing, steadily" and is a different sentence from "no data yet". The
 * caller renders the difference; this only refuses to invent one.
 *
 * Non-finite values are dropped rather than propagated: one `NaN` from a pool
 * that would not answer must not take the other eleven points down with it.
 */
export function spark(values: number[], w: number, h: number, pad = 3): Spark | null {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;

  const max = Math.max(...v);
  if (!(max > 0)) return null;

  const innerW = w - 2 * pad;
  const innerH = h - 2 * pad;
  const x = (i: number) => r(pad + (innerW * i) / (v.length - 1));
  // Zero at the bottom. See the note above: this is the whole point of the file.
  const y = (n: number) => r(h - pad - (innerH * Math.max(n, 0)) / max);

  const pts = v.map((n, i) => `${x(i)},${y(n)}`);
  const base = r(h - pad);

  return {
    points: pts.join(" "),
    area: `M${x(0)},${base} L${pts.join(" L")} L${x(v.length - 1)},${base} Z`,
    last: { x: x(v.length - 1), y: y(v[v.length - 1]!) },
    max,
  };
}

/**
 * A running total, which is the shape this chart is for.
 *
 * Here and not at the call site because the call site holds per-window amounts
 * and the difference between plotting those and plotting their sum is the
 * difference between a noisy bar chart and the line that answers the question.
 */
export function cumulative(values: number[]): number[] {
  let sum = 0;
  return values.map((n) => (sum += Number.isFinite(n) ? n : 0));
}
