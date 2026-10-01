/** Graduation gauge. `pnpm --filter front test` */
import assert from "node:assert/strict";
import { curveProgress, CURVE_VIRTUAL_WEI, GRADUATION_WEI } from "./curve.js";

// 1. THE test: the real reading of 2026-09-06, against what Pons displayed for
//    the same curve — "0.114973 of 4.2 ETH raised". If the virtual reserve were
//    dropped, this would announce 1.79 ETH raised and 43 % of the way there, on
//    a curve that has taken 0.11 ETH.
{
  const p = curveProgress(1_794_973_268_721_709_359n);
  assert.equal(p.raised, 114_973_268_721_709_359n, "raised must match the Pons figure to the wei");
  assert.equal(p.pct.toFixed(1), "2.7", "and the percentage Pons rounds to 3 %");
  assert.equal(p.left, GRADUATION_WEI - 114_973_268_721_709_359n);
}

// 2. An untouched curve is at zero, not at 40 % of the way.
{
  const p = curveProgress(CURVE_VIRTUAL_WEI);
  assert.equal(p.raised, 0n);
  assert.equal(p.pct, 0);
  assert.equal(p.left, GRADUATION_WEI, "everything still to raise");
}

// 3. A reading below the virtual floor is a broken RPC, not a negative raise.
//    bigint subtraction does not clamp on its own and would throw in formatEther.
{
  const p = curveProgress(1n);
  assert.equal(p.raised, 0n, "clamped, never negative");
  assert.equal(p.pct, 0);
}

// 4. At and past the threshold the bar fills and nothing is left — the gauge
//    must not overshoot in the window between the last buy and `graduated()`.
{
  const at = curveProgress(CURVE_VIRTUAL_WEI + GRADUATION_WEI);
  assert.equal(at.pct, 100);
  assert.equal(at.left, 0n);

  const past = curveProgress(CURVE_VIRTUAL_WEI + GRADUATION_WEI * 2n);
  assert.equal(past.pct, 100, "capped at 100");
  assert.equal(past.left, 0n, "never a negative remainder");
}

// 5. Monotonic: more in the reserve is never less progress.
{
  let previous = -1;
  for (let eth = 0n; eth <= 5n; eth++) {
    const p = curveProgress(CURVE_VIRTUAL_WEI + eth * 10n ** 18n);
    assert.ok(p.pct >= previous, "progress must never go backwards");
    previous = p.pct;
  }
}

console.log("curve: 5 checks OK — gauge matches the Pons reading of 2026-09-06");
