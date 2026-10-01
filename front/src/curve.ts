/**
 * Graduation progress on the Pons bonding curve.
 *
 * Pure on purpose: this is the one number the page shows that a visitor may act
 * on, and it has to be checkable without a chain. `curve.test.ts` pins it to the
 * reading Pons itself displayed on 2026-09-06.
 */
/**
 * Pons v2 launch config #0 — the only one on the production factory
 * (`launchConfigCount() = 1`, docs/recon.md §1.8). Read from
 * `getLaunchConfig(0)` on 0x7eD598Bc…EC7e, words 3 and 4:
 *
 *   w2 = 1.68e18  virtual quote reserve the curve starts on
 *   w3 = 4.20e18  graduation threshold
 *
 * The threshold is measured against the ETH ACTUALLY RAISED, not against
 * `quoteReserve` — confirmed 2026-09-06 against the Pons interface, which
 * showed "0.114973 of 4.2 ETH raised" for exactly the difference computed
 * below. A derivation putting graduation at 2.52 ETH was wrong; the test
 * pins the right reading so it cannot come back.
 */
export const CURVE_VIRTUAL_WEI = 1_680_000_000_000_000_000n;
export const GRADUATION_WEI = 4_200_000_000_000_000_000n;

export interface Progress {
  /** ETH actually paid in by buyers, virtual reserve removed. */
  raised: bigint;
  /** What is still missing to close the curve. */
  left: bigint;
  /** 0 to 100, for the bar's width. */
  pct: number;
}

/**
 * `quoteReserve` starts at `CURVE_VIRTUAL_WEI` — 1.68 ETH that is not money and
 * that nobody paid. Only what sits ABOVE it counts, and that is also what the
 * Pons interface calls "raised": subtracting the virtual reserve reproduces it
 * to the wei.
 */
export function curveProgress(quoteReserve: bigint): Progress {
  // Below the virtual floor is a broken read, not a negative raise.
  const raised = quoteReserve > CURVE_VIRTUAL_WEI ? quoteReserve - CURVE_VIRTUAL_WEI : 0n;
  const left = raised >= GRADUATION_WEI ? 0n : GRADUATION_WEI - raised;
  const pct = Math.min(100, Number((raised * 10_000n) / GRADUATION_WEI) / 100);
  return { raised, left, pct };
}
