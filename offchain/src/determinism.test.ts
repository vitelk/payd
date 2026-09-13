/**
 * Root determinism. `pnpm --filter offchain test:determinism`
 *
 * The whole verifiability story rests on one property: **two machines replaying
 * the same epochs must produce exactly the same root and the same CID.** If they
 * diverge, an honest verifier raises a groundless alarm — or worse, concludes
 * everything is fine while a wrong root is live.
 *
 * We do not test `buildCumulative` end to end: it needs an RPC and deployed
 * contracts, so it would not run in CI. We test the PURE layer that produces the
 * on-chain commitment — `build()`, `canonicalJson()`, the CID — by feeding it
 * the same data in DIFFERENT ORDERS. That is the only genuinely plausible class
 * of bug here: a Map's iteration order follows insertion order, hence the RPC's
 * response order, which nobody guarantees.
 */
import assert from "node:assert/strict";
import { accumulate } from "./epoch.js";
import { weighBalances } from "./snapshot.js";
import { getAddress, sha256, toHex, type Address } from "viem";
import { build, shareOf, key, type Entry } from "./merkle.js";
import { replayExclusions } from "./snapshot.js";
import { PUSH_TARGET_WEI, PUSH_K_MIN, SETTLE_GAS, pushSet, pushFloorFor, NON_ETH_PUSH_BPS } from "./epoch.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
import { canonicalJson, type CumulativeArtifact } from "./epoch.js";

const addr = (n: number): Address =>
  `0x${n.toString(16).padStart(40, "0")}` as Address;

/** Deterministic shuffle (LCG), so a failure is reproducible. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const STOCKS = [addr(0xaa), addr(0xbb), addr(0xcc)];
const ENTRIES: Entry[] = [];
for (let h = 1; h <= 60; h++) {
  for (const stock of STOCKS) {
    ENTRIES.push({ holder: addr(0x1000 + h), stock, cumulative: BigInt(h) * 10n ** 15n });
  }
}
// A pushed subset, chosen independently of the list's order.
const PUSH = new Set(ENTRIES.filter((_, i) => i % 7 === 0).map((e) => key(e.holder, e.stock)));

function artifactOf(entries: Entry[]): CumulativeArtifact {
  const built = build(entries, PUSH);
  return {
    upToEpoch: 41,
    windows: [
      {
        fromEpoch: 38, toEpoch: 40, stocks: [STOCKS[0]!, STOCKS[1]!], amounts: ["1000", "2000"],
        periodStart: 68400, periodEnd: 73800, transferBlocks: 9, minBalance: "1000000",
      },
      {
        fromEpoch: 41, toEpoch: 41, stocks: [STOCKS[1]!], amounts: ["2000"],
        periodStart: 73800, periodEnd: 75600, transferBlocks: 3, minBalance: "900000",
      },
    ],
    excluded: [addr(0xdead), addr(0xbeef)],
    entries: built.entries.map((e) => ({
      holder: e.holder, stock: e.stock, cumulative: e.cumulative.toString(),
      push: PUSH.has(key(e.holder, e.stock)),
    })),
  };
}

// 1. Roots and CID identical whatever the input order. This is THE test.
{
  const ref = build(ENTRIES, PUSH);
  const refJson = canonicalJson(artifactOf(ENTRIES));
  const refCid = sha256(toHex(refJson));

  for (const seed of [1, 7, 12345, 99991]) {
    const mixed = shuffled(ENTRIES, seed);
    const got = build(mixed, PUSH);
    assert.equal(got.claimRoot, ref.claimRoot, `claimRoot depends on order (seed ${seed})`);
    assert.equal(got.pushRoot, ref.pushRoot, `pushRoot depends on order (seed ${seed})`);

    const json = canonicalJson(artifactOf(mixed));
    assert.equal(json, refJson, `canonical serialisation depends on order (seed ${seed})`);
    assert.equal(sha256(toHex(json)), refCid, `the CID depends on order (seed ${seed})`);
  }
}

// 2. Insertion order in the push Set must change nothing either.
{
  const ref = build(ENTRIES, PUSH);
  const reversed = new Set([...PUSH].reverse());
  const got = build(ENTRIES, reversed);
  assert.equal(got.pushRoot, ref.pushRoot, "pushRoot depends on the Set's order");
  assert.equal(got.claimRoot, ref.claimRoot, "claimRoot depends on the Set's order");
}

// 3. Proofs must be stable too: a holder recomputing their proof on their own
//    machine must get the one the contract will accept.
{
  const ref = build(ENTRIES, PUSH);
  const mixed = build(shuffled(ENTRIES, 4242), PUSH);
  const e = ENTRIES[17]!;
  assert.deepEqual(
    mixed.proofFor(e.holder, e.stock, "claim"),
    ref.proofFor(e.holder, e.stock, "claim"),
    "the proof depends on input order",
  );
}

// 4. `shareOf` is integer division with no fix-up on the last entry: two
//    implementations must agree to the wei, and sum BELOW the funded amount.
{
  const supply = 123_456_789n;
  const funded = 1_000_000_000_000_000_000n;
  const bals = [1n, 2n, 7n, 999n, 1_000_000n, 122_455_780n];
  assert.equal(bals.reduce((a, b) => a + b, 0n), supply, "the test set must cover the whole supply");

  const total = bals.reduce((acc, b) => acc + shareOf(b, supply, funded), 0n);
  assert.ok(total <= funded, "the sum of shares exceeds the funded amount");
  assert.ok(funded - total < BigInt(bals.length), "rounding loss above 1 wei per holder");

  // Same input, same output, whatever the evaluation order.
  const reverse = [...bals].reverse().reduce((acc, b) => acc + shareOf(b, supply, funded), 0n);
  assert.equal(reverse, total, "shareOf is not associative — floating-point rounding?");
}

// 5. One extra entry MUST change the root. Without this, the tests above would
//    still pass if `build` returned a constant.
{
  const ref = build(ENTRIES, PUSH);
  const plus = build([...ENTRIES, { holder: addr(0x9999), stock: STOCKS[0]!, cumulative: 1n }], PUSH);
  assert.notEqual(plus.claimRoot, ref.claimRoot, "the root does not react to its content");
}

// 6. `canonicalJson` must sort BY ITSELF. The checks above go through
//    `build()`, which already sorts — so they would say nothing if
//    `canonicalJson` trusted its caller. Here we hand it an artifact whose
//    entries are shuffled by hand, as a verifier rebuilding the artifact
//    differently from us would.
{
  const ref = artifactOf(ENTRIES);
  const refJson = canonicalJson(ref);

  for (const seed of [3, 777, 20260903]) {
    const scrambled: CumulativeArtifact = {
      ...ref,
      windows: shuffled(ref.windows, seed),
      excluded: shuffled(ref.excluded, seed),
      entries: shuffled(ref.entries, seed),
    };
    assert.equal(
      canonicalJson(scrambled), refJson,
      `canonicalJson trusts its input's order (seed ${seed})`,
    );
    assert.equal(
      sha256(toHex(canonicalJson(scrambled))), sha256(toHex(refJson)),
      `the CID committed on-chain depends on order (seed ${seed})`,
    );
  }
}


// 7. Replaying exclusions must depend only on the epoch being computed, never
//    on when the replay happens. This was a real defect: `snapshot.ts` read
//    `isExcluded`, the CURRENT state, so two honest verifiers straddling a
//    `setExcluded` produced different roots for the same epoch — and a
//    good-faith verifier would have reported a disagreement that is not fraud.
{
  const A = addr(0xa1), B = addr(0xb2), C = addr(0xc3);
  // The log as the contract writes it: append-only, fromEpoch increasing.
  const LOG = [
    { account: A, state: true, fromEpoch: 5 },
    { account: B, state: true, fromEpoch: 5 },
    { account: A, state: false, fromEpoch: 12 }, // A reinstated
    { account: C, state: true, fromEpoch: 30 },
  ];

  // getAddress returns EIP-55: normalise both sides.
  const set = (...xs: string[]) => xs.map((x) => getAddress(x)).sort().join(",");
  const at = (e: number) => replayExclusions(LOG, e).join(",");
  assert.equal(at(0), "", "before any entry, nobody is excluded");
  assert.equal(at(4), "", "an entry at fromEpoch 5 must not bite at epoch 4");
  assert.equal(at(5), set(A, B), "both exclusions take effect at 5");
  assert.equal(at(11), set(A, B), "A is still excluded at 11");
  assert.equal(at(12), set(B), "A is reinstated from 12 on");
  assert.equal(at(29), set(B), "C does not bite before 30");
  assert.equal(at(30), set(B, C), "C joins at 30");

  // The decisive point: adding FUTURE entries must change nothing in the past.
  // That is exactly what happens when a `setExcluded` executes between two
  // replays of the same epoch.
  const LATER = [...LOG, { account: B, state: false, fromEpoch: 40 }, { account: A, state: true, fromEpoch: 41 }];
  for (const e of [0, 5, 11, 12, 29, 30, 39]) {
    assert.equal(
      replayExclusions(LATER, e).join(","), replayExclusions(LOG, e).join(","),
      `a later setExcluded changed the set for epoch ${e}`,
    );
  }
  assert.equal(replayExclusions(LATER, 41).join(","), set(A, C), "future entries do apply, once reached");
}


// 8. The push floor must depend on the COVERED EPOCH, never on when the
//    computation runs.
//
//    This was a real defect: `buildCumulative` read the basefee at the CURRENT
//    block (`client.getBlock()`). Two verifiers ten minutes apart got different
//    push sets, hence different `pushRoot`s. Under the keeper model `dispute.ts`
//    is the only check left: it would have reported a divergence on every run,
//    and nobody could have told real fraud from noise any more.
{
  // THE REAL FUNCTION, not a restatement of it. This block used to carry its
  // own copy of the formula, which meant it went on passing if `pushFloorFor`
  // changed underneath — a false assurance on the one constant this file
  // carries a warning about.
  //
  // `minBuyQuote` is passed as zero on purpose: it is the non-ether branch's
  // input and must not reach this one. If it ever does, the assertions below
  // collapse to zero and say so loudly.
  const floor = (basefeeWei: bigint) => pushFloorFor(ZERO_ADDRESS, 0n, basefeeWei);

  // Normal gas: the TARGET drives, the holder keeps ~99 %.
  const normal = 417_700_000n; // 0.4177 gwei
  assert.equal(floor(normal), PUSH_TARGET_WEI, "at normal gas, the target must win");
  const costNormal = Number(SETTLE_GAS * normal) / Number(floor(normal));
  assert.ok(costNormal < 0.01, `gas should eat less than 1 %, it eats ${(100 * costNormal).toFixed(2)} %`);

  // Past the CROSSOVER the floor takes over, and the holder still keeps 95 % —
  // that is the entire reason the second bound exists.
  //
  // Derived from the constants rather than hardcoded: the fixture used to be a
  // flat 4.177 gwei ("gas x10"), which stopped being past the crossover the day
  // `PUSH_TARGET_WEI` was doubled to ~$20 — the crossover moved from 5.4x to
  // 10.8x today's gas. The test failed, correctly, on a change that was fine.
  // Computed, it holds whatever the target becomes.
  const crossover = PUSH_TARGET_WEI / (PUSH_K_MIN * SETTLE_GAS);
  assert.equal(floor(crossover), PUSH_TARGET_WEI, "at the crossover exactly, the target still wins");
  const expensive = 2n * crossover;
  assert.ok(floor(expensive) > PUSH_TARGET_WEI, "past the crossover, the floor must win");
  const costExpensive = Number(SETTLE_GAS * expensive) / Number(floor(expensive));
  assert.ok(costExpensive <= 0.05 + 1e-9, `the holder must keep at least 95 %, they keep ${(100 - 100 * costExpensive).toFixed(2)} %`);

  // A NON-ether vault answers the same question with none of these terms: its
  // floor is its own currency's, and gas does not enter it. Asserted here and
  // not only in `pushfloor.test.ts`, because the defect this block exists for
  // — a floor that moves with WHEN you compute it — is exactly the one a gas
  // term reintroduces.
  const minBuyUsdg = 25_000_000n;
  const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
  assert.equal(
    pushFloorFor(usdg, minBuyUsdg, 417_700_000n),
    pushFloorFor(usdg, minBuyUsdg, 20_000_000_000n),
    "a non-ether floor must not move with gas: nothing in it is priced in wei",
  );
  assert.equal(pushFloorFor(usdg, minBuyUsdg, 1n), 10_000_000n, "and it is $10.00 in usdg units");

  // And the floor never DROPS when gas rises.
  let previous = 0n;
  for (const bf of [100_000_000n, 417_700_000n, 1_000_000_000n, 4_177_000_000n, 20_000_000_000n]) {
    const f = floor(bf);
    assert.ok(f >= previous, "the floor fell while gas was rising");
    previous = f;
  }
}


// ---- the cumulative model itself -------------------------------------------
//
// Found by mutation: replacing `+=` with `=` in the accumulation passed the
// entire off-chain suite. The property the whole design rests on had no test.
{
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  const S1 = "0x00000000000000000000000000000000000000e1" as `0x${string}`;
  const S2 = "0x00000000000000000000000000000000000000e2" as `0x${string}`;

  const totals = new Map<string, { holder: string; stock: string; cumulative: bigint }>();
  accumulate(totals as never, { [A]: "100", [B]: "5" }, S1);
  accumulate(totals as never, { [A]: "30" }, S1);
  accumulate(totals as never, { [A]: "7" }, S1);

  const a1 = [...totals.values()].find((e) => e.holder === A && e.stock === S1)!;
  assert.equal(a1.cumulative, 137n, "three epochs on one stock must ADD UP, not overwrite");

  const b1 = [...totals.values()].find((e) => e.holder === B)!;
  assert.equal(b1.cumulative, 5n, "a holder seen once keeps exactly their amount");

  // Same holder, different stock: a separate line, never merged.
  accumulate(totals as never, { [A]: "9" }, S2);
  assert.equal([...totals.values()].filter((e) => e.holder === A).length, 2, "one entry per (holder, stock)");
  assert.equal(a1.cumulative, 137n, "another stock must not disturb the first");
}

// ---- the time weighting ----------------------------------------------------
//
// This is the piece a third party has to reimplement to check a root, so it is
// the piece that has to be pinned down by examples rather than by prose.
{
  const A = addr(0xa);
  const B = addr(0xb);
  const C = addr(0xc);
  const ZERO_ADDR = addr(0) as Address;
  const S = 1000;
  const E = 2000; // a 1,000-second period

  // A holds 100 throughout; B holds nothing. Weight is balance x seconds.
  {
    const w = weighBalances({ opening: new Map([[A, 100n]]), transfers: [], startTs: S, endTs: E });
    assert.equal(w.get(A), 100_000n, "a full period pays balance x length");
    assert.equal(w.get(B), undefined, "a holder of nothing earns nothing");
  }

  // B arrives at the halfway mark: half the weight of someone who was there
  // all along. THIS is what the 8-block draw could not express — B either hit
  // a sampled block or did not.
  {
    const w = weighBalances({
      opening: new Map([[A, 100n]]),
      transfers: [{ at: 1500, from: A, to: B, value: 100n }],
      startTs: S,
      endTs: E,
    });
    assert.equal(w.get(A), 50_000n, "A held 100 for half the period");
    assert.equal(w.get(B), 50_000n, "B held 100 for the other half");
  }

  // The sniper: in at the last second, out at the boundary. Near-zero weight,
  // where one sampled block would have paid a full share.
  {
    const w = weighBalances({
      opening: new Map([[A, 100n]]),
      transfers: [{ at: 1999, from: A, to: C, value: 100n }],
      startTs: S,
      endTs: E,
    });
    assert.equal(w.get(A), 99_900n, "A held for all but the last second");
    assert.equal(w.get(C), 100n, "one second of holding pays one second");
    // Under the 8-block draw, C landing on one sampled block collected 1/8 of a
    // full share for one second of holding. Here it collects 1/999th.
    assert.ok(w.get(C)! * 500n < w.get(A)!, "sniping the boundary must be worthless");
  }

  // Mint and burn: the zero address is not a holder and earns nothing.
  {
    const w = weighBalances({
      opening: new Map(),
      transfers: [
        { at: 1000, from: ZERO_ADDR, to: A, value: 100n },
        { at: 1500, from: A, to: ZERO_ADDR, value: 100n },
      ],
      startTs: S,
      endTs: E,
    });
    assert.equal(w.get(A), 50_000n, "minted at the start, burnt halfway");
    assert.equal(w.get(ZERO_ADDR), undefined, "address zero is never a holder");
  }

  // Two transfers sharing a timestamp: the second adds no time, only balance.
  // Blocks are ~100 ms here, so this is the common case, not the exotic one.
  {
    const w = weighBalances({
      opening: new Map([[A, 100n]]),
      transfers: [
        { at: 1500, from: A, to: B, value: 60n },
        { at: 1500, from: A, to: C, value: 40n },
      ],
      startTs: S,
      endTs: E,
    });
    assert.equal(w.get(A), 50_000n, "A held 100 up to 1500 and nothing after");
    assert.equal(w.get(B), 30_000n, "B held 60 for half the period");
    assert.equal(w.get(C), 20_000n, "C held 40 for half the period");
  }

  // Conservation: the total weight equals supply x period, whatever the churn.
  // A weighting that leaked would show up here and nowhere else.
  {
    const w = weighBalances({
      opening: new Map([[A, 100n]]),
      transfers: [
        { at: 1200, from: A, to: B, value: 70n },
        { at: 1400, from: B, to: C, value: 50n },
        { at: 1700, from: C, to: A, value: 20n },
        { at: 1900, from: A, to: B, value: 10n },
      ],
      startTs: S,
      endTs: E,
    });
    const total = [...w.values()].reduce((x, y) => x + y, 0n);
    assert.equal(total, 100_000n, "weight must be conserved: supply x period");
  }

  // Order is not a free parameter: the caller feeds chain order, and a
  // different order is a different history, not a different rounding.
  {
    const base = { opening: new Map([[A, 100n]]), startTs: S, endTs: E };
    const w1 = weighBalances({
      ...base,
      transfers: [
        { at: 1200, from: A, to: B, value: 100n },
        { at: 1800, from: B, to: C, value: 100n },
      ],
    });
    const w2 = weighBalances({
      ...base,
      opening: new Map([[A, 100n]]),
      transfers: [
        { at: 1200, from: A, to: B, value: 100n },
        { at: 1800, from: B, to: C, value: 100n },
      ],
    });
    assert.deepEqual([...w1.entries()].sort(), [...w2.entries()].sort(), "same input, same weights");
  }
}

// 10. The eligibility bar must be COMMITTED, not merely shipped alongside.
// The front tells a visitor "you need N tokens" from the artifact's
// `minBalance`; if that field were outside the hashed payload, a gateway could
// serve any bar it liked and the page would repeat it with a green tick.
{
  const ref = artifactOf(ENTRIES);
  assert.ok(canonicalJson(ref).includes('"minBalance":"1000000"'), "the bar must be in the canonical payload");

  const tampered = {
    ...ref,
    windows: ref.windows.map((w, i) => (i === 0 ? { ...w, minBalance: "1" } : w)),
  };
  assert.notEqual(
    sha256(toHex(canonicalJson(tampered))),
    sha256(toHex(canonicalJson(ref))),
    "moving the bar must move the digest",
  );
}


// ---------------------------------------------------------------------------
// The push set must not depend on WHEN it is computed.
//
// This is the property the fork rehearsal of 2026-09-06 broke. `buildCumulative`
// took `paid` from `claimedSoFar` at the head of the chain. At publication every
// holder was owed their share, so all three went into `pushRoot`; the keeper
// then delivered exactly those three, and a verifier replaying the same root
// twenty minutes later found them all settled, derived an EMPTY push set, and
// `dispute.ts` reported "the delivery floor was manipulated" on an honest root.
// That command is the one the README hands to holders to check us with.
//
// The fix is structural: `pushSet` is pure and takes `paid` as an argument, so
// the impurity is one named call, `deliveredUpTo(distributor, anchorBlock)`,
// with the block it is cut at written into the call.
{
  const E3 = [
    { holder: addr(0x11), stock: addr(0xaa), cumulative: 100n },
    { holder: addr(0x22), stock: addr(0xaa), cumulative: 200n },
    { holder: addr(0x33), stock: addr(0xaa), cumulative: 300n },
  ];
  const totalQuote = 600n, totalCum = 600n, floor = 50n;

  const atTheCut = new Map<string, bigint>();
  const published = pushSet(E3, atTheCut, totalQuote, totalCum, floor);
  assert.equal(published.size, 3, "all three clear the floor when the root is cut");

  // The deliveries this root authorises now land.
  const afterTheAirdrop = new Map<string, bigint>(
    E3.map((e) => [key(e.holder, e.stock), e.cumulative]),
  );

  // A verifier replaying the root uses the map AS OF THE CUT and lands on the
  // same set, whatever has happened since.
  assert.deepEqual(
    [...pushSet(E3, atTheCut, totalQuote, totalCum, floor)].sort(),
    [...published].sort(),
    "replaying with the historical map must reproduce the published push set",
  );

  // And this is the bug, kept as a witness: hand it live state instead and the
  // set empties out, which is what made an honest root look forged.
  assert.equal(
    pushSet(E3, afterTheAirdrop, totalQuote, totalCum, floor).size,
    0,
    "live state empties the push set - the failure mode this guards against",
  );

  // Order independence, like everything else here.
  assert.deepEqual(
    [...pushSet(shuffled(E3, 7), atTheCut, totalQuote, totalCum, floor)].sort(),
    [...published].sort(),
    "the push set must not depend on the order entries arrive in",
  );
}

console.log("determinism: 15 checks OK");
