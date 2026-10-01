/**
 * epoch.ts — computing the CUMULATIVE root.
 *
 * **One code path, two callers.** `keeper.ts` uses it to publish, `dispute.ts`
 * to verify. If the two went through different implementations, a serialisation
 * difference would look like fraud and raise a groundless alarm.
 *
 * Each epoch is computed independently (one snapshot, one stock, one amount),
 * then shares are **summed per (holder, stock)**. That sum is what the leaf
 * carries: the contract remembers what it already paid and settles only the
 * difference (docs/ARCHITECTURE.md §S18).
 */
import { createPublicClient, http, keccak256, sha256, toHex, type Address } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RPC_URL, minShareFor } from "./config.js";
import { distributorAbi, feeVaultAbi } from "./abis.js";
import { snapshot, excludedAt, blockAtOrAfter, windows, type PurchaseWindow } from "./snapshot.js";
import { build, shareOf, key, type Entry } from "./merkle.js";
import { scanLogs } from "./logs.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

/**
 * FULL cost of settling one (holder, stock) pair, measured on-chain: Merkle
 * proof verification + writing `claimedSoFar` + transferring the stock token.
 * 93,000 gas, not 40,000 — the transfer alone pays only a third of the bill, and
 * underestimating here means airdropping dust at a loss (docs/recon.md §6).
 */
export const SETTLE_GAS = 93_000n;
/**
 * Delivery threshold: TWO bounds, we keep the higher one.
 *
 *     pushFloor = max( PUSH_TARGET_WEI , PUSH_K_MIN x SETTLE_GAS x basefee )
 *
 * **`PUSH_TARGET_WEI` — the target.** ~$10 of value per delivery. This is what
 * drives in normal operation: at the measured gas price (0.4177 gwei) a delivery
 * costs $0.0927, so the holder keeps **99.54 %**.
 *
 * **`PUSH_K_MIN` — the floor.** Guarantees the holder **at least 95 %** whatever
 * happens. It only binds if gas spikes so far that $20 would no longer leave
 * 95 % — from ~$1.00 per delivery on, i.e. 10.8x the current gas. The threshold
 * then rises with gas instead of letting the holder's share fall.
 *
 * What that gives, by gas price:
 *
 *     delivery $0.09  ->  threshold $20.00  ->  the holder keeps 99.5 %
 *     delivery $0.25  ->  threshold $20.00  ->  the holder keeps 98.8 %
 *     delivery $0.50  ->  threshold $20.00  ->  the holder keeps 97.5 %
 *     delivery $1.00  ->  threshold $20.00  ->  the holder keeps 95.0 %  <- crossover
 *     delivery $2.00  ->  threshold $40.00  ->  the holder keeps 95.0 %
 *
 * Doubled from $10 to $20 on 2026-09-06 to halve the cycle's push gas, and put
 * BACK to $10 on 2026-09-11. Three things retired that doubling:
 *
 *   - **the cost it was buying against has fallen 56.7 %.** Gas was 0.294 gwei
 *     when the doubling was argued and is 0.1299 gwei today (`ESTIMATIONS.md`
 *     §0). At $10 the reserve now has more room than $20 had then;
 *   - **the reserve was never close to binding.** A holder under the floor is
 *     not delivered, so deliveries are bounded by `rewards / floor` — the cost
 *     is a guarantee, not an average. The 3 % reserve is self-funding from a
 *     floor of **$1.34**. At $20 it was oversized fifteen times over;
 *   - **the wait is the product.** Holders of a launch want to receive, and at
 *     $20 a 0.1 % holder of a token doing $50k a day waited ten days for it.
 *
 * $10 and not lower because of the rule this file already had and
 * `determinism.test.ts` already enforced: **at normal gas, the delivery must
 * eat less than 1 %**. That is what picks the number — $0.0927 a delivery at
 * the 0.4177 gwei the test calls normal is 0.93 % of $10, and would be 1.85 %
 * of $5. The rule chose, not taste.
 *
 * Nothing is withheld either way: the share keeps accruing and `claim` stays
 * open for whoever does not want to wait their turn.
 *
 * ⚠️ **CHANGE IT BEFORE A LAUNCH OR NOT AT ALL.** `dispute.ts` recomputes an old
 * root with the constant it finds in this file, so moving it makes every root
 * published before the move recompute to a different `pushRoot` — an honest
 * keeper reported as forged, exactly the failure the `claimedSoFar` fix of the
 * same day removed. Moving it after launch needs the treatment the exclusion
 * list already has (§S23): a dated log, replayed up to the covered epoch.
 *
 * PUSH_TARGET_WEI is denominated in WEI, not dollars: reading a USD price would
 * require the historical state of a Chainlink feed, which the public RPC does not
 * serve. The target therefore drifts with the ETH price — a published constant,
 * to be readjusted if the price moves sharply.
 *
 * Raising the threshold WITHHOLDS nothing: the total distributed is identical,
 * only the batch size changes. A holder in a hurry does not wait: `claim` stays
 * open.
 */
export const PUSH_TARGET_WEI = 4_192_000_000_000_000n; // ~$10 at $2,386/ETH
export const PUSH_K_MIN = 20n; // 1 - 1/20 = 95 % guaranteed to the holder

/**
 * **On a vault that is not quoted in ether, none of the two bounds above can be
 * used, and the reason is a units bug this constant exists to close.**
 *
 * `quoteSpent` is not in wei there. `FeeVault._buyLegs` computes it as
 * `legPivot * quoteIn / pivot`, and `quoteIn` is what the vault SPENT — in its own
 * currency. The name is V1's, from when `QUOTE` was always ether. So
 * `pushSet` was comparing a value in raw QUOTE units against a floor in wei,
 * and it failed in opposite directions depending on the quote:
 *
 *     USDG  (6 decimals, $25 = 25e6)     a $1,000 share is 1e9 raw units
 *                                        against a floor of 8.384e15
 *                                        -> NOTHING was ever pushed
 *     NVDA  (18 decimals, $25 = 0.12e18) 8.384e15 raw units is 0.0084 NVDA
 *                                        -> a floor of $1.89, not $20, i.e.
 *                                           dust delivered at a loss, on a
 *                                           vault that refunds no gas at all
 *
 * **The floor has to be denominated in the vault's own currency, and one
 * already is.** `MIN_BUY_QUOTE` is about $25 in the quote's raw units, written
 * at the vault's birth from `Payd.quoteListing` and never written again — so it
 * is deterministic for `dispute.ts`, which is the binding constraint here, and
 * it needs no price feed. The bounty cap uses the same unit for the same
 * reason.
 *
 * **40 % of it, i.e. ~$10 — the same floor an ether vault has, in another
 * currency.** There is no reason for the two to differ: the number is a product
 * decision about how often a holder receives, and which currency the fees
 * happened to arrive in is not a holder's concern.
 *
 * It was set at 8x (~$200) for an afternoon, on the argument that a non-ETH
 * vault refunds no delivery gas, so fewer deliveries meant an affordable bill.
 * The arithmetic did not support rationing anything:
 *
 *     floor   deliveries cost   + purchase   the keeper fronts
 *     $200        0.020 %         0.250 %         27 bps
 *     $100        0.040 %         0.250 %         29 bps
 *     $10         0.402 %         0.250 %         65 bps
 *
 * — all of it against the **3.00 %** of rewards an ETHER vault already takes as
 * `distGasBps` for that delivery service alone. At $10 a non-ether vault's
 * holders pay 65 bps for the whole cycle, basket included: four times less than
 * what the protocol already charges its ether holders for delivery on its own.
 * `FeeVault` seeds `keeperBountyBps` at 70 to cover it.
 *
 * The gas bound still cannot come along — `PUSH_K_MIN x SETTLE_GAS x basefee`
 * is in wei, and converting it into NVDA needs the oracle this design avoids.
 * At $10 the floor carries the 95 % guarantee by itself up to $0.50 a delivery,
 * i.e. **12x today's $0.0402**, and the holder keeps 99.6 % at today's gas.
 *
 * In bps of `MIN_BUY_QUOTE` rather than a whole multiple, because ~$25 is the
 * granularity the chain hands us and the product question does not care.
 */
export const NON_ETH_PUSH_BPS = 4_000n;

/**
 * The epoch from which an entry is valued against **its own leg** rather than
 * against the pooled basket. Below it, the old formula — bug included.
 *
 * **What was wrong.** `pushSet` priced an outstanding share as
 * `units x (all quote spent) / (all units of every leg summed)`. That treats
 * one unit of NVDA and one unit of PONS as the same thing, and they are not:
 * measured on $PAYD's own vault at root #27, 2026-09-13,
 *
 *     leg    weight    quote spent    credited by the pooled formula    ratio
 *     PONS   1000 bps    0.0989 ETH              0.9720 ETH            x9.83
 *     QQQ    1800 bps    0.1781                  0.0069                x0.039
 *     NVDA   1800 bps    0.1781                  0.0047                x0.027
 *     TSLA   1800 bps    0.1781                  0.0028                x0.016
 *     SPCX   1800 bps    0.1781                  0.0014                x0.008
 *     SPY    1800 bps    0.1781                  0.0013                x0.008
 *
 * PONS is 98.26 % of the units in the tree and 10 % of the value, because it
 * trades at 0.000234 ETH against NVDA's 0.0866 — a factor of 370. So an equity
 * share had to be worth **25 to 127 times** the $10 floor before the floor saw
 * $10, which with 0.1781 ETH per leg across 105 holders is unreachable: the five
 * equities read `totalDistributed = 0` seventeen hours after the launch and
 * would have read it for ever, while PONS was delivered at a floor ten times too
 * low — 278.39 of 422.02 units already out, 6.172 of them into the supply locker.
 *
 * **Why it is dated and not simply fixed.** `dispute.ts` — the command the
 * README hands holders — rebuilds an old root through `buildCumulative` and
 * compares. Change the formula for everybody and all 27 roots published before
 * today recompute to a different `pushRoot`, i.e. an honest keeper reported as
 * forged on its whole history. So the rule is versioned by the epoch it covers,
 * exactly as the exclusion list is (`docs/ARCHITECTURE.md` §S23): a root whose
 * `upToEpoch` is below this uses the pooled formula, at or above it the per-leg
 * one, and both stay reproducible for ever.
 *
 * **The number is a deploy deadline, and this one was deliberately tight.** 35
 * was chosen at 12:36 UTC on 2026-09-13, during epoch 34, to put the equities in
 * the very next root rather than two hours later: epoch 35 closes at **13:13:25
 * UTC** and the root covering it is published within the minute. The keeper was
 * deployed at 12:4x, before that close — which is the whole requirement. A keeper
 * on the pooled formula publishing epoch 35 while a verifier reads the per-leg
 * one is exactly the false alarm this versioning exists to prevent, so on any
 * later change: move the number forward BEFORE deploying, never after.
 */
export const PUSH_VALUE_V2_FROM_EPOCH = 35;

/**
 * The epoch from which the delivery floor is the holder's **whole** outstanding
 * balance instead of one (holder, stock) pair at a time.
 *
 * **What it was.** `SETTLE_GAS` measures one pair, so the floor was written where
 * the cost is: each pair judged alone against ~$10. The consequence, measured on
 * $PAYD's tree at root #27 with the per-leg valuation already in place — a basket
 * of six legs, five equities at 1800 bps and PONS at 1000:
 *
 *     >= $10 of accrued value in total:   37 holders,  9 delivered to
 *     >= $25:                              19 holders,  9 delivered to
 *     smallest holder receiving anything: $65.16
 *     largest holder receiving NOTHING:   $50.82
 *
 * A holder needed ~$58 before ONE leg cleared, because their $58 arrives as six
 * slices of ~$10. "Your share is worth $10 and it is pushed" was true of a leg
 * and false of a holder, which is not the sentence anybody reads it as.
 *
 * **What it is now.** A holder's outstanding legs are valued (each inside its own
 * leg, `PUSH_VALUE_V2_FROM_EPOCH`), summed, and if the sum clears the floor **all
 * of them are delivered in one `distribute`**. Run against the same tree, by
 * basefee, and the gas bound below is why the answer moves with gas at all:
 *
 *     0.3000 gwei   216 deliveries to 36 holders    (per-pair: 52)
 *     0.4177 gwei   192 to 32                       (per-pair: 52)
 *     1.0000 gwei    96 to 16                       (per-pair: 52)
 *
 * 216 deliveries is 20.1 M gas, 0.0060 ETH at 0.3 gwei, against the 0.0446 ETH
 * the Distributor holds for refunds.
 *
 * **And the gas bound is multiplied by the number of legs**, which is the only
 * subtle part. `PUSH_K_MIN x SETTLE_GAS x basefee` guarantees the holder 95 % of
 * ONE delivery; six deliveries against one $10 floor would guarantee 70 %. So
 * `pushSetWhole` takes the bound per pair and scales it: at 0.3 gwei and six legs
 * that is 0.00335 ETH, still under the $10 target, so the target commands and the
 * holder keeps 97.6 % at today's gas. Above ~0.37 gwei the scaled bound takes
 * over and the floor rises, exactly as it always did.
 *
 * Dated for `dispute.ts`'s sake, like the two rules before it: below this epoch
 * the per-pair floor, at or above it the whole-holder one. 36 was chosen at 12:56
 * UTC on 2026-09-13, in epoch 35; epoch 36 opens at 13:13:25 and **its root is
 * published at 13:43:25**, which is the deadline for keeper AND co-signer both.
 * The co-signer recomputes the root it is asked to sign, so a half-deployed pair
 * does not merely disagree — it refuses an honest root and blocks publication
 * until the two match again.
 */
export const PUSH_WHOLE_HOLDER_FROM_EPOCH = 36;

/**
 * Epochs whose root is cut with a floor OTHER than the standing one, keyed by
 * the epoch and valued in the vault's own quote units.
 *
 * **A table, and APPEND-ONLY.** `dispute.ts` and `recompute.ts` rebuild an old
 * root through `buildCumulative`, so an epoch published under an override has
 * to keep rebuilding under the same one forever. Changing 46's `0n` after root
 * 46 exists reports an honest keeper as forged. Add a row, never edit one.
 *
 * **Why a table and not the list of waived epochs it replaces.** The first
 * sweep needed a floor of zero; the second needs a floor of about a dollar, and
 * "waived or not" cannot express that. The published epoch keeps its exact
 * value, so the migration from list to map changes no root.
 *
 * **The value replaces BOTH halves of the floor** — the product target and the
 * `PUSH_K_MIN x SETTLE_GAS x basefee` gas bound. Keeping the gas bound would
 * make a row saying "$1" mean $2.32 for a six-leg holder at today's basefee,
 * i.e. not what it says. A row is the whole floor.
 *
 * ---
 *
 * **46 — zero, 2026-09-13 18:43.** 870 entries, 720 pairs in the push set, 714
 * delivered to 119 wallets in sixty seconds, $337.93, no `DeliveryFailed`.
 *
 * **And it cost 8.5x what was projected, which is the lesson this table
 * carries.** Measured across the burst:
 *
 *     keeper   0.014439 ETH -> 0.001502 ETH   net -0.012937 ETH  ($32.40)
 *     refunds received                             0.008700 ETH  ($21.79)
 *     gross gas                                    0.021637 ETH  ($54.19)
 *     basefee  0.0846 gwei  -> 0.286 gwei     (x3.4)
 *
 * The projection had modelled the basefee as a constant. It is not: 119
 * transactions in sixty seconds ARE a gas spike, and this one tripled it. The
 * cost of each call followed; the refund ceiling did not, because
 * `REFUND_VALUE_BPS` is 10 % of the value MOVED and that is denominated in
 * dollars, not in gas. So far more calls hit the ceiling than at a calm
 * basefee, and the keeper ate the difference. **Price a row at the basefee the
 * sweep will CREATE, not the one it starts from.**
 *
 * **58 — `PUSH_TARGET_WEI / 10`, ~$1, 2026-09-14 00:43.** A second sweep at
 * zero was costed and refused. Measured on root #50 (epoch 56) at 00:01 UTC,
 * with the locker's 70.6 % already set aside:
 *
 *     floor    wallets   legs   delivered   gross gas   the keeper eats
 *     zero         249   1494     $377.51       ~$112             ~$83
 *     ~$1           82    492     $333.95        ~$26              ~$4
 *
 * 88.5 % of the value for 33 % of the transactions. The 167 wallets under a
 * dollar hold **$43.56 between them** and would cost ~$75 of gas to serve —
 * the one segment where a sweep moves less than it burns. They lose nothing:
 * the share keeps accruing and `claim` is open.
 *
 * **60 — the same ~$1, because 58 delivered nothing.** Root #52 was published
 * at 00:45:43 and epoch 58's own basket was bought 61 seconds later, so the
 * push rebuilt a different tree ten minutes on and all 96 wallets reverted with
 * `NothingDelivered`. The floor was never the problem — 582 pairs were in the
 * push set. Epoch 59's row would have been wasted too: `markPushed` ran anyway,
 * so the keeper's next push is 01:55:56 and root #53 is replaced at 01:43:25.
 * 60 is the epoch whose root is still active when the gate opens. The keeper
 * now pushes from the published artifact and refuses to send on a pushRoot
 * mismatch, which is what makes a row survive the race at all.
 *
 * **104 — the same ~$1, 2026-09-14 23:30, one epoch and back.** First asked
 * on 103 at 22:40, withdrawn at 22:55, asked again on 104 at 23:26 — the
 * 103 root was built floorless in between, so 104 is the one that carries
 * it. One key: the gate is opened by hand while root-for-104 is the active
 * one, and everything after it returns to the standing $10 floor by
 * construction. The locker is not a key here: the keeper skips it live on
 * every push.
 *
 * **155 — the same ~$1, 2026-09-16 00:35, one epoch and back.** Measured on
 * root #147 (epoch 153) with `sweepcost.ts`, the locker already filtered out
 * the way the keeper filters it:
 *
 *     floor    wallets   legs   delivered   gross gas   the keeper eats
 *     ~$1           89    534     $348.89       $8.06              $0.00
 *     zero         338   2028     $416.84      $30.62             $15.53
 *
 * 83.7 % of the value for 26 % of the transactions, and the first row costs
 * the keeper nothing at all: at 0.0635 gwei a 6-leg wallet burns $0.091 and
 * `_refund`'s ceiling — 10 % of what the call MOVED — is $0.39, so the reserve
 * pays the whole bill, $8.30 of the $165 it holds. The 249 wallets under a
 * dollar hold $68 between them and would cost $22 more of gas than the ceiling
 * covers, which is the same segment epoch 58 refused and the same reason.
 *
 * **155 and not 154: the co-signer has to be carrying this row too.** It
 * rebuilds the root on another host and refuses to sign a `pushRoot` it does
 * not reproduce, so BOTH Fly apps must be deployed before the epoch closes —
 * 01:13:25 UTC for this one. A deploy that lands late does not sweep at the
 * wrong floor, it cancels the publication; move the row to the next epoch
 * rather than hurry it.
 *
 * **304 — the same ~$1, 2026-09-19 02:47.** Measured on root #276 (epoch 301)
 * with `sweepcost.ts`, the locker already filtered out the way the keeper
 * filters it:
 *
 *     floor    wallets   legs   delivered   gross gas   refunded   the keeper eats
 *     ~$1          189   1134     $719.64      $18.20     $18.75            $0.00
 *     zero         564   3381     $823.23      $54.27     $29.11           $25.17
 *
 * 87.4 % of the value for 33.5 % of the wallets, and the first row costs the
 * keeper nothing: the refund is `gross x 1.03` to the cent, so not one wallet in
 * the set is ceiling-bound, and the reserve pays the whole $18.75 out of the
 * $179.66 it holds. The 375 wallets under a dollar hold **$103.59 between them**
 * and would cost $36.07 more of gas, $25.17 of it out of the keeper's own
 * pocket — the same segment rows 58 and 155 refused, for the same reason.
 *
 * **Priced again at the gas the sweep will CREATE, which is row 46's rule and
 * not an afterthought.** 119 deliveries tripled the basefee there; this row is
 * 189. At 0.2025 gwei, 3x today's 0.0675:
 *
 *     ~$1          189   1134     $719.64      $54.60     $45.15            $9.45
 *     zero         564   3381     $823.23     $162.79     $55.50          $107.28
 *
 * So the ~$1 row survives its own spike — $45.15 of a $179.84 reserve, $9.45
 * eaten — and the zero row does not: $107.28 to the keeper for $103.59 of extra
 * value delivered, which is the same trade the table has refused twice.
 * `BASEFEE_GWEI` in `sweepcost.ts` is what produced the second block.
 *
 * **304 and not 303, and the deadline is what decides it.** Epoch 303's root is
 * published at 03:13:25 UTC, twenty-one minutes after this was costed, and the
 * image runs the whole offchain suite before it ships — keeper AND co-signer
 * both. 155's rule is to move the row rather than hurry it, so this one is 304:
 * it closes at 03:43:25 and the pair has fifty-one minutes.
 *
 * **The push gate is opened by hand here, as it was for 104 and 155, and this
 * time it has to be TAKEN BACK first.** `PUSH_INTERVAL_HOURS` is 1 and the last
 * push was 02:39:19, so the gate opens by itself at 03:39:19 — while
 * root-for-303 is the active one, at the standing floor, where the push set is
 * empty and `markPushed` runs all the same. That burns the interval to ~04:39,
 * by which time root-for-304 (active 03:43:25 -> 04:13:25) is gone. So the gate
 * is reopened inside that window by deleting `last-push-<distributor>.json` from
 * the keeper's volume, and everything after 304 returns to the standing $10
 * floor by construction.
 *
 * **It was not taken back, and the row was lost at 03:39 exactly as written
 * above — then rescued at 03:59:35 with eighteen minutes of the window left:
 * 188 wallets, 1 128 legs, root #279.** The hand-opening is what failed, four
 * rows out of five (58, 104, 155, 304), and a step that has to be performed by
 * a human inside a thirty-minute window at four in the morning is not a step.
 * `keeper.ts`'s `stepDistribute` no longer consumes the interval on a root
 * whose `pushRoot` is zero, so the tick that lands between two sweeps observes
 * and waits instead of shutting the door on the root that carries the set. A
 * future row needs nothing but the number.
 *
 * **The trend is the real argument.** The tree went from 139 holders to 365 in
 * six hours, nobody leaving, so the median outstanding share FELL from $1.15 to
 * $0.42. Gas is paid per wallet and value accrues per dollar: a sweep at zero
 * cost $32 at 139 holders, would cost $83 at 365, and is simply unaffordable at
 * a thousand. Sweeping is a young-vault move, and this table should get shorter
 * rows, not longer ones.
 */
export const PUSH_FLOOR_OVERRIDES: ReadonlyMap<number, bigint> = new Map([
  [46, 0n],
  [58, PUSH_TARGET_WEI / 10n],
  [60, PUSH_TARGET_WEI / 10n],
  [104, PUSH_TARGET_WEI / 10n],
  [155, PUSH_TARGET_WEI / 10n],
  [304, PUSH_TARGET_WEI / 10n],
]);

/** The override for the root covering `upToEpoch`, or undefined for the standing floor. */
export const floorOverride = (upToEpoch: number): bigint | undefined =>
  PUSH_FLOOR_OVERRIDES.get(upToEpoch);

/**
 * The Pons locker, and the epoch from which what it accrued goes back to the
 * holders.
 *
 * `PonsV2LaunchLocker` holds 8.16 % of the supply — 13.46 % of the eligible
 * base, once the PoolManager and `0xdead` are out — and it **cannot move an
 * ERC-20**: five state-changing functions, `acceptOwnership`, `lockPosition`,
 * `lockTokenSupply`, `setFactory`, `transferOwnership`, and not one of them
 * transfers. It was a holder like any other until the timelock excluded it at
 * **epoch 132**, so epochs 0-131 accrued it a share of every leg that sits in
 * the Distributor undeliverable, and that no later root would ever release.
 *
 * From this epoch `reclaimUndeliverable` hands that share back to the real
 * holders, pro-rata to what they are already owed. What it does NOT hand back
 * is the 6.172179755515995546 PONS the locker was actually DELIVERED on launch
 * night (block 61499557): those left the contract, and promising them to
 * somebody else would make `_one` truncate the last claimers in silence. The
 * locker keeps a row worth exactly what it was paid, which is what keeps the
 * arithmetic exact — `checkConservation` is unmoved by this rule, by
 * construction.
 *
 * **This is the `structuralExclusions` route that the note above `keeper.ts`'s
 * push filter rules out, and the reason it is safe here is that it is DATED.**
 * Recomputing the structural set per window would drop the locker's cumulative
 * to zero across the whole history on every build, including rebuilds of roots
 * published before anyone thought of it, and `dispute.ts` would report every
 * one of them as forged. Below this epoch a rebuild reproduces what was
 * published; at or above it, one root steps the locker down and every root
 * after it is flat again.
 *
 * The address is PINNED rather than read from `factory.locker()`, which is the
 * opposite of what the push filter does and for the opposite reason: the
 * filter must follow a rotation at Pons, a rebuild must not — an old root has
 * to keep rebuilding to the same answer in five years. A second locker would
 * be a second row here, with its own epoch.
 *
 * **Both hosts, before the epoch closes.** The co-signer recomputes the root it
 * is asked to sign, so a half-deployed pair does not merely disagree — it
 * refuses an honest root and blocks publication until the two match. Epoch 159
 * closes 2026-09-16 03:13:25 UTC; if the deploy will not land by then, move the
 * number rather than hurry it.
 *
 * **159 and not 158: the ~$1 sweep of epoch 155 goes out first.** Deploying
 * both at once would land a reclaim and a floor override on overlapping roots,
 * and the sweep is the one with a deadline — it is one epoch wide and cannot be
 * moved without editing an append-only table. Three epochs of daylight between
 * them also means the reclaim is measured against a tree the sweep has already
 * settled, which is what `sweepcost.ts` was pointed at to cost this.
 */
export const LOCKER_RECLAIM_FROM_EPOCH = 159;

/** Pons Locker v2 (`docs/recon.md` §1.2, `factory.locker()` on 2026-09-16). */
export const LOCKER_RECLAIM_ACCOUNT = "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952" as Address;

/**
 * The delivery floor for one vault, in the units its shares are denominated in.
 *
 * Derived only from facts written at the vault's birth — `QUOTE` and
 * `MIN_BUY_QUOTE`, neither of which has a setter — plus the anchor block's
 * basefee, which `buildCumulative` already pins. `dispute.ts` and
 * `recompute.ts` reach it through `buildCumulative`, so there is one
 * definition and an honest keeper cannot be reported as forged for it.
 */
export function pushFloorFor(quote: Address, minBuyQuote: bigint, basefee: bigint, targetDiv?: bigint): bigint {
  const { target, perDelivery } = pushFloorParts(quote, minBuyQuote, basefee, targetDiv);
  return perDelivery > target ? perDelivery : target;
}

/**
 * The same floor, as the two numbers it is made of.
 *
 * `target` is the product decision — ~$10 of value, in the vault's own currency.
 * `perDelivery` is the gas bound, `PUSH_K_MIN x SETTLE_GAS x basefee`, and it is
 * **per (holder, stock) pair**, because that is what `SETTLE_GAS` measures.
 *
 * Split out for `pushSetWhole`, which gates on a holder's WHOLE outstanding
 * balance and therefore has to multiply the gas bound by the number of pairs it
 * is about to settle. Fold the two back into one number and the 95 % guarantee
 * silently becomes a 70 % one for a holder with six legs. On a non-ether vault
 * `perDelivery` is 0: the bound is in wei and there is no oracle on this path,
 * exactly as before.
 */
export function pushFloorParts(
  quote: Address,
  minBuyQuote: bigint,
  basefee: bigint,
  /**
   * What a mode divides the TARGET by, and only the target.
   *
   * **The gas bound deliberately does not follow it**, which is the whole
   * safety of the thing: a mode may decide its holders are worth pushing at $1
   * rather than $10, and it may not decide they are worth pushing at a loss.
   * `PUSH_K_MIN` keeps its 95 % whatever the target says, so on a gas spike the
   * bound takes over for a portfolio vault exactly as it does for any other.
   *
   * On a non-ether vault the bound is 0 — it is in wei and the shares are not —
   * so there the divisor is the only thing acting, and `NON_ETH_PUSH_BPS`'s
   * own reasoning about how far gas may move before $10 stops guaranteeing
   * 95 % applies to the divided number instead. See `buildCumulative`'s
   * `pushTargetDiv`, which is the only caller that passes one.
   */
  targetDiv?: bigint,
): { target: bigint; perDelivery: bigint } {
  const div = targetDiv ?? 1n;
  if (quote !== "0x0000000000000000000000000000000000000000") {
    return { target: (minBuyQuote * NON_ETH_PUSH_BPS) / 10_000n / div, perDelivery: 0n };
  }
  return { target: PUSH_TARGET_WEI / div, perDelivery: PUSH_K_MIN * SETTLE_GAS * basefee };
}

/**
 * How often to repeat the L1-pricer warning while it stays on. The keeper ticks
 * every 60 s, so 60 ticks is hourly.
 *
 * Not one line and done: a keeper runs unattended for months, and a single
 * warning at the moment of the flip is a line nobody will ever scroll back to.
 * Repeating it hourly means any `tail` of the log shows the problem, not just
 * the log of the exact hour it started.
 */
export const L1_WARN_EVERY_TICKS = 60;

/** Ticks of runway below which the keeper's gas balance is worth saying out loud. */
export const GAS_WARN_TICKS = 200;
/** And below which it is worth repeating every tick rather than hourly. */
export const GAS_CRITICAL_TICKS = 40;

/**
 * Should the keeper announce its gas balance?
 *
 * **Runway is MEASURED, not modelled.** The keeper sends seven kinds of
 * transaction -- harvest, fundRewards, buyBasket, publishRoot, distribute (once
 * per holder), payCreator, flagHookLost -- most of them refunded, some of them
 * not, and the mix changes with the number of vaults and holders. Any formula
 * for "gas per tick" would be wrong the day a vault is added. The balance delta
 * between two ticks is the truth, and it costs one `getBalance` to read.
 *
 * @param runway ticks the current balance affords at the measured burn, or
 *        `null` while no burn has been observed yet (the first tick, or a
 *        stretch where every call was fully refunded -- which is the good case
 *        and must stay silent).
 */
export function gasRunwayAlert(runway: number | null, ticksSinceWarn: number): boolean {
  if (runway === null) return false;
  if (runway <= GAS_CRITICAL_TICKS) return true;
  if (runway > GAS_WARN_TICKS) return false;
  return ticksSinceWarn >= L1_WARN_EVERY_TICKS;
}

/**
 * Should this tick warn that the L1 pricer is on?
 *
 * Everything the push economics rest on assumes a transaction here pays for its
 * execution and **nothing for its calldata** — `getL1BaseFeeEstimate() = 0`,
 * measured in `docs/recon.md` §10.7. If that changes, ArbOS starts charging the
 * L1 posting of calldata by ADDING to the transaction's gas used, above what the
 * EVM ran. `gasleft()` cannot see it, so `_refund` cannot price it, and the miss
 * grows with calldata — worst exactly on `distribute`, which is 64 Merkle proofs
 * of it. `REFUND_OVERHEAD` is a flat 40,000 and an `internal constant`: the fix
 * is a redeploy, not a setter.
 *
 * A WARNING, deliberately, and never a gate. A live pricer does not make a root
 * wrong — it makes pushing unprofitable. Refusing to publish would punish
 * holders for a change none of them caused.
 *
 * Edge-triggered, then repeated: warn when it is on and was not (or on the first
 * read of the process, so a restart re-announces it), then once an hour while it
 * stays on.
 */
export function l1PricerAlert(previous: bigint | null, current: bigint, ticksSinceWarn: number): boolean {
  if (current === 0n) return false;
  if (previous === null || previous === 0n) return true;
  return ticksSinceWarn >= L1_WARN_EVERY_TICKS;
}
const CACHE_DIR = process.env.EPOCH_DIR ?? "data";

/** One purchase: the epochs it covers, the stocks it bought, and who gets what. */
export interface WindowShares {
  fromEpoch: number;
  toEpoch: number;
  /** The basket bought, and the amount of each. Aligned arrays. */
  stocks: Address[];
  amounts: string[];
  quoteSpent: string;
  periodStart: number;
  periodEnd: number;
  transferBlocks: number;
  /** Last block of the period — where another log stream is cut to line up
   *  with this window. Only the tontine's `Delivered` replay uses it. */
  lastBlock: number;
  eligibleSupply: string;
  minBalance: string;
  /** Weight per holder over the window. One split, applied to every stock. */
  weights: Record<Address, string>;
  /** Who held less during the window than at its start. Empty for every
   *  holder who only held or bought, which is the normal case; the tontine
   *  mode is the only reader. */
  decreases: Record<Address, { open: string; min: string }>;
}

/**
 * What each (holder, stock) had actually been delivered as of `toBlock`,
 * replayed from the `Delivered` logs.
 *
 * Deterministic where `claimedSoFar` is not: the counter on the contract is the
 * value NOW, so it moves as the very deliveries this root authorises land, and
 * a verifier replaying the root an hour later reads a different number. The
 * logs, cut at a fixed height, always say the same thing.
 *
 *   event Delivered(address indexed holder, address indexed stock,
 *                   address indexed caller, uint256 amount)
 *
 * Scanned from the Distributor's genesis: nothing can have been delivered
 * before the contract's first epoch existed.
 */
const DELIVERED_TOPIC = keccak256(toHex("Delivered(address,address,address,uint256)"));

export interface Delivery {
  block: number;
  holder: Address;
  stock: Address;
  amount: bigint;
}

/**
 * The raw stream, in chain order. One scan answers both questions asked of it:
 * what was delivered by the root's anchor (`deliveredUpTo`), and what had been
 * delivered by each earlier window's boundary — which is what the tontine needs
 * to know how much of a holder's share was still UNDELIVERED, hence
 * forfeitable, when they sold.
 */
export async function deliveredLog(distributor: Address, toBlock: number): Promise<Delivery[]> {
  const genesis = await client.readContract({ address: distributor, abi: distributorAbi, functionName: "GENESIS" });
  const from = await blockAtOrAfter(Number(genesis));

  const out: Delivery[] = [];
  await scanLogs(
    client,
    { address: distributor, fromBlock: from, toBlock, topics: [DELIVERED_TOPIC] },
    (logs) => {
      for (const l of logs) {
        out.push({
          block: Number(l.blockNumber),
          holder: ("0x" + l.topics[1]!.slice(26)).toLowerCase() as Address,
          stock: ("0x" + l.topics[2]!.slice(26)).toLowerCase() as Address,
          amount: BigInt(l.data),
        });
      }
    },
  );
  return out;
}

/** Sums the stream per (holder, stock), up to and including `toBlock`. Pure. */
export function foldDelivered(log: readonly Delivery[], toBlock = Number.MAX_SAFE_INTEGER): Map<string, bigint> {
  const paid = new Map<string, bigint>();
  for (const d of log) {
    if (d.block > toBlock) continue;
    const k = key(d.holder, d.stock);
    paid.set(k, (paid.get(k) ?? 0n) + d.amount);
  }
  return paid;
}

export async function deliveredUpTo(distributor: Address, toBlock: number): Promise<Map<string, bigint>> {
  return foldDelivered(await deliveredLog(distributor, toBlock));
}

/**
 * Who is worth an actual delivery. **Pure**, and that is the point.
 *
 * `paid` must be what had been delivered AS OF THE BLOCK THE ROOT IS CUT AT —
 * `deliveredUpTo(distributor, anchorBlock)` — never the live `claimedSoFar`.
 * Passing live state makes the result depend on when it is computed: the
 * deliveries this very root authorises land, every holder becomes settled, and
 * a verifier replaying it afterwards derives an empty push set and reports the
 * root as forged. That happened, on the fork rehearsal of 2026-09-06, and it is
 * why this takes a map instead of reading one.
 *
 * `quoteOf` and `cumOf` are **per stock**, keyed by lowercased address: what was
 * spent on that leg, and the units of it the tree owes in total. A share is
 * therefore valued inside its own leg, which is the only place its units mean
 * anything — see `PUSH_VALUE_V2_FROM_EPOCH` for the measurement that says so and
 * for why the caller, not this function, decides which epoch gets which rule.
 * The pooled formula it replaces is expressible in the same two maps (every leg
 * pointing at the pooled totals), so there is no second code path here.
 *
 * A stock with no recorded quote, or no units, is **not pushed**: a share that
 * cannot be valued must not be delivered on a guess, and `claim` stays open for
 * it either way.
 */
export function pushSet(
  entries: { holder: Address; stock: Address; cumulative: bigint }[],
  paid: Map<string, bigint>,
  quoteOf: Map<string, bigint>,
  cumOf: Map<string, bigint>,
  pushFloor: bigint,
): Set<string> {
  const keys = new Set<string>();
  for (const e of entries) {
    const already = paid.get(key(e.holder, e.stock)) ?? 0n;
    if (e.cumulative <= already) continue;
    const leg = e.stock.toLowerCase();
    const quote = quoteOf.get(leg) ?? 0n;
    const units = cumOf.get(leg) ?? 0n;
    if (quote === 0n || units === 0n) continue;
    // Value of the outstanding share, in the QUOTE the leg was bought with.
    const value = ((e.cumulative - already) * quote) / units;
    if (value >= pushFloor) keys.add(key(e.holder, e.stock));
  }
  return keys;
}

/**
 * Who is worth an actual delivery, judged on the holder's WHOLE balance.
 *
 * Same valuation as `pushSet` — every share priced inside its own leg — and a
 * different question asked of it: not "is this leg worth delivering" but "is this
 * HOLDER worth a transaction". If they are, every outstanding leg they have goes
 * out in the same `distribute`, which is what makes one push settle somebody
 * rather than one sixth of them.
 *
 * `perDelivery` is the gas bound PER PAIR and is scaled here by the number of
 * pairs being settled: see `PUSH_WHOLE_HOLDER_FROM_EPOCH`. Pure, and ordering
 * cannot reach it — the floor is compared against a sum.
 */
export function pushSetWhole(
  entries: { holder: Address; stock: Address; cumulative: bigint }[],
  paid: Map<string, bigint>,
  quoteOf: Map<string, bigint>,
  cumOf: Map<string, bigint>,
  target: bigint,
  perDelivery: bigint,
): Set<string> {
  const mine = new Map<string, { keys: string[]; total: bigint }>();
  for (const e of entries) {
    const k = key(e.holder, e.stock);
    const already = paid.get(k) ?? 0n;
    if (e.cumulative <= already) continue;
    const leg = e.stock.toLowerCase();
    const quote = quoteOf.get(leg) ?? 0n;
    const units = cumOf.get(leg) ?? 0n;
    if (quote === 0n || units === 0n) continue;
    const cur = mine.get(e.holder.toLowerCase()) ?? { keys: [], total: 0n };
    cur.keys.push(k);
    cur.total += ((e.cumulative - already) * quote) / units;
    mine.set(e.holder.toLowerCase(), cur);
  }

  const keys = new Set<string>();
  for (const h of mine.values()) {
    const bound = perDelivery * BigInt(h.keys.length);
    const floor = bound > target ? bound : target;
    if (h.total >= floor) for (const k of h.keys) keys.add(k);
  }
  return keys;
}

export interface CumulativeArtifact {
  upToEpoch: number;
  /** Covered purchases, each with the period its average covers — what a
   *  verifier replays. There is nothing else to record: the period comes from
   *  the epoch calendar, so it cannot have been chosen.
   *
   *  `minBalance` is the eligibility bar that epoch: the front reads the last
   *  one to tell a visitor how many tokens they need to be in the next tree,
   *  rather than reimplementing `applyFloor` in the browser. */
  windows: {
    fromEpoch: number;
    toEpoch: number;
    stocks: Address[];
    amounts: string[];
    periodStart: number;
    periodEnd: number;
    transferBlocks: number;
    minBalance: string;
  }[];
  excluded: Address[];
  entries: { holder: Address; stock: Address; cumulative: string; push: boolean }[];
}

export interface BuiltCumulative {
  artifact: CumulativeArtifact;
  claimRoot: `0x${string}`;
  pushRoot: `0x${string}`;
  cid: `0x${string}`;
  entries: Entry[];
  pushKeys: Set<string>;
  /** Rows `reclaimUndeliverable` stepped DOWN. The only cumulative amounts in
   *  the tree allowed to go backwards, and `preflight` blocks on any other. */
  reclaimed: Set<string>;
  proofFor(holder: Address, stock: Address, tree: "claim" | "push"): string[];
}

/**
 * Canonical serialisation: THIS string is what gets hashed on-chain.
 *
 * It sorts by itself; it does not trust its caller. The Merkle root is already
 * order-insensitive — `StandardMerkleTree` sorts leaves by hash internally — but
 * the CID was not: two honest machines receiving the entries in different orders
 * would have published the same roots and DIFFERENT CIDs, and a verifier
 * comparing CIDs would have read that as fraud. The sort was already done
 * upstream in `buildCumulative`, so by convention; doing it here makes it
 * structural.
 *
 * See `determinism.test.ts`, which fails if it is removed.
 */
export function canonicalJson(a: CumulativeArtifact): string {
  const byEpoch = [...a.windows].sort((x, y) => x.fromEpoch - y.fromEpoch);
  const byKey = [...a.entries].sort((x, y) => {
    const kx = `${x.holder.toLowerCase()}:${x.stock.toLowerCase()}`;
    const ky = `${y.holder.toLowerCase()}:${y.stock.toLowerCase()}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  return JSON.stringify({
    upToEpoch: a.upToEpoch,
    windows: byEpoch.map((w) => ({
      fromEpoch: w.fromEpoch,
      toEpoch: w.toEpoch,
      stocks: w.stocks.map((x) => x.toLowerCase()),
      amounts: w.amounts,
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      transferBlocks: w.transferBlocks,
      minBalance: w.minBalance,
    })),
    excluded: a.excluded.map((x) => x.toLowerCase()).sort(),
    entries: byKey.map((e) => ({
      holder: e.holder.toLowerCase(), stock: e.stock.toLowerCase(), cumulative: e.cumulative, push: e.push,
    })),
  });
}

/**
 * Shares for ONE epoch. Cached on disk: a settled epoch never changes again, and
 * recomputing it on every publication would make the cost quadratic in time.
 *
 * The file name carries the DISTRIBUTOR, not just the epoch number. A redeployed
 * Distributor starts its own epoch numbering from its own genesis, so `shares-0`
 * would otherwise mean two different things in the same directory: a keeper
 * reusing its data volume after a redeploy would rebuild the new deployment's
 * roots from the old one's shares. The preflight's cross-check runs on an empty
 * cache and would diverge, so it fails safe rather than publishing — but it would
 * block every publication until someone worked out why. Keying by deployment
 * removes the collision instead of relying on the check to catch it.
 */
export async function windowShares(
  distributor: Address,
  token: Address,
  w: PurchaseWindow,
  /** `minShareFor(QUOTE, MIN_BUY_QUOTE)`, the eligibility floor in the vault's
   *  own units. Threaded in rather than read here so the whole root derives
   *  from one place a verifier can agree with. */
  minShare: bigint,
): Promise<WindowShares | null> {
  mkdirSync(CACHE_DIR, { recursive: true });
  // The floor is IN the key. A cached window computed under a different
  // threshold is a different tree, and silently reusing it is how a verifier
  // and a keeper end up disagreeing for a reason neither can see.
  const path = `${CACHE_DIR}/shares-${distributor.toLowerCase()}-${w.fromEpoch}-${w.toEpoch}-${minShare}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as WindowShares;

  const quoteSpent = w.quoteSpent.reduce((a: bigint, b: bigint) => a + b, 0n);
  if (quoteSpent === 0n) return null;

  // ONE snapshot for the whole purchase. Payd needed one per epoch because an
  // epoch bought one stock; a window buys the basket, so the same split applies
  // to every leg — which is exactly what makes "you own a slice of the basket"
  // true rather than a figure of speech.
  //
  // **A window that predates the token has nobody to pay, and skipping it is
  // what lets every later root exist.** `GENESIS` is the vault's birth, not the
  // launch: on 2026-09-12 the vault was created at 19:13 and $PAYD's first
  // transfer landed at 22:15, so epochs 0-5 closed with the token not yet in
  // existence. The first purchase funded that range all the same — `fundWindow`
  // covers every epoch closed since the last one — and `snapshot` threw "no
  // candidates" on it. Because the cumulative build replays from epoch 0 and
  // cannot step over a funded window, that one throw stopped EVERY root, for
  // good: three hours after genesis the vault had bought three baskets and
  // published nothing.
  //
  // Skipping is deterministic — the window is holder-less on chain, so the
  // keeper, the co-signer and `dispute.ts` all reach the same verdict — and it
  // is the same branch `quoteSpent === 0` already takes. What it costs is that
  // the window's stocks stay in the Distributor, funded and owed to nobody.
  // They can be carried into a later window afterwards if that is judged worth
  // it: roots are cumulative and only ever grow.
  let snap;
  try {
    snap = await snapshot(distributor, token as Address, w.fromEpoch, w.toEpoch, quoteSpent, minShare);
  } catch (e) {
    if ((e as Error).message !== "no candidates") throw e;
    // stderr, NOT stdout. `recompute.ts` — the cross-check's subprocess — writes
    // the rebuilt root to stdout and the parent does `JSON.parse` on it, so one
    // informative line here failed the fifth preflight with `Unexpected token
    // 'w'` and cancelled the publication just as thoroughly as the throw it
    // replaced. Anything this library ever says goes to stderr.
    console.error(`window ${w.fromEpoch}-${w.toEpoch}: no holder existed, skipped`);
    return null;
  }
  const weights: Record<Address, string> = {};
  for (const [holder, bal] of Object.entries(snap.balances) as [Address, bigint][]) {
    if (bal > 0n) weights[holder] = bal.toString();
  }

  const decreases: WindowShares["decreases"] = {};
  for (const [holder, e] of snap.decreases) {
    decreases[holder] = { open: e.open.toString(), min: e.min.toString() };
  }

  const out: WindowShares = {
    fromEpoch: w.fromEpoch,
    toEpoch: w.toEpoch,
    stocks: w.stocks,
    amounts: w.amounts.map((a: bigint) => a.toString()),
    quoteSpent: quoteSpent.toString(),
    periodStart: snap.periodStart,
    periodEnd: snap.periodEnd,
    transferBlocks: snap.transferBlocks,
    lastBlock: snap.lastBlock,
    eligibleSupply: snap.eligibleSupply.toString(),
    minBalance: snap.minBalance.toString(),
    weights,
    decreases,
  };
  writeFileSync(path, JSON.stringify(out));
  return out;
}

/**
 * Merge one epoch's shares into the running totals.
 *
 * This `+=` IS the cumulative model. Overwrite instead of add and a holder's
 * entry collapses to their LAST epoch, silently erasing everything earned
 * before it. Pulled out of `buildCumulative` — which needs an RPC and so
 * cannot run in CI — because mutation testing showed the single most
 * important property of the design had no test that could fail.
 */
export function accumulate(
  totals: Map<string, Entry>,
  shares: Record<string, string>,
  stock: Address,
): void {
  for (const [holder, amount] of Object.entries(shares) as [Address, string][]) {
    const k = key(holder, stock);
    const cur = totals.get(k);
    if (cur) cur.cumulative += BigInt(amount);
    else totals.set(k, { holder, stock, cumulative: BigInt(amount) });
  }
}

/**
 * Gives back what the tree accrued to an address that can never take it.
 *
 * **Pure, and it has to be**: this moves holders' money between rows, so the
 * one property worth proving — the per-stock total is unchanged — must be
 * provable without an RPC. `accumulate` was extracted for the same reason.
 *
 * `paid` is what had been DELIVERED at the root's anchor block, the same
 * `foldDelivered` map the push floor is judged against. Never `claimedSoFar`
 * at the head: live state would make an old root rebuild differently the
 * moment its own deliveries landed, which is the defect the rehearsal of
 * 2026-09-06 caught (`pushSet`).
 *
 * Per leg: the account's row drops to what it was already paid, and the
 * difference is added to every OTHER row of that leg in proportion to what it
 * already carries. Pro-rata on the cumulative and not a fresh per-window
 * replay, because it is the same weighting either way — a holder's cumulative
 * IS their time-weighted share of every window they were in — and one pass
 * over a map cannot disagree with itself about a window the way two replays
 * can.
 *
 * Integer division with no fix-up on the last row: the remainder stays
 * unpromised, which is the safe side of `checkConservation`. Order cannot
 * reach the result — each row's increment depends only on its own cumulative
 * and on two values fixed before the loop.
 *
 * Returns the keys it REDUCED, because those are the rows that legitimately go
 * backwards and `checkMonotonic` has to be told which ones.
 */
export function reclaimUndeliverable(
  totals: Map<string, Entry>,
  /** Every row's cumulative AS OF `LOCKER_RECLAIM_FROM_EPOCH`, which is what
   *  the split is computed from. See the paragraph above on why it cannot be
   *  the live totals. */
  atGate: ReadonlyMap<string, bigint>,
  paid: Map<string, bigint>,
  account: Address,
): Set<string> {
  const reduced = new Set<string>();
  const stuck = account.toLowerCase();

  for (const [k, e] of [...totals]) {
    if (e.holder.toLowerCase() !== stuck) continue;
    // The canonical key, not the map's: `preflight` waives what this returns,
    // and a map keyed some other way would hand it something it cannot match.
    const kk = key(e.holder, e.stock);
    const kept = paid.get(kk) ?? 0n;
    const excess = (atGate.get(kk) ?? e.cumulative) - kept;
    // Delivered more than the tree owes: not this function's problem, and
    // certainly not one to "fix" by taking the difference off other holders.
    if (excess <= 0n) continue;

    const leg = e.stock.toLowerCase();
    const peers: { row: Entry; was: bigint }[] = [];
    let weight = 0n;
    for (const p of totals.values()) {
      const pk = key(p.holder, p.stock);
      if (p.stock.toLowerCase() !== leg || pk === kk) continue;
      // A row that did not exist at the gate takes no part of the split: it
      // was not owed any of this when the correction was decided, and letting
      // it in would move everybody ELSE's share every time somebody new buys.
      const was = atGate.get(pk);
      if (was === undefined || was === 0n) continue;
      peers.push({ row: p, was });
      weight += was;
    }
    // Nobody to hand it to. Leave the row alone rather than burn it: a leg
    // whose only entry is this account is a leg to look at, not to rewrite.
    if (weight === 0n) continue;

    for (const p of peers) p.row.cumulative += (excess * p.was) / weight;

    if (kept === 0n) totals.delete(k);
    else e.cumulative = kept;
    reduced.add(kk);
  }
  return reduced;
}

/**
 * What ONE window does to the running totals.
 *
 * The only thing a payout mode changes about a root. Everything else in
 * `buildCumulative` — which windows are covered, the eligibility floor, the
 * exclusion replay, the delivery floor, the trees, the CID — is the same
 * question for every mode, and a mode that forked it would have to be audited
 * for all of it again. `deliveries` is the whole `Delivered` stream up to the
 * root's anchor, so a rule that needs to know what had already been paid at an
 * EARLIER window's boundary can fold it there (`foldDelivered(log, lastBlock)`)
 * without a second scan.
 */
export type WindowAccrual = (
  totals: Map<string, Entry>,
  sh: WindowShares,
  deliveries: readonly Delivery[],
) => void;

/**
 * The distribution mode's rule, and the one every mode starts from: each
 * holder of the window takes their slice of every leg, and a share once earned
 * is earned for good (`docs/ARCHITECTURE.md` §S18).
 */
export const plainAccrual: WindowAccrual = (totals, sh) => {
  const supply = BigInt(sh.eligibleSupply);
  // ONE weighting, applied to EVERY stock of the purchase. That is the whole
  // difference D8 makes: a holder of the window gets a slice of the basket,
  // not a slice of whichever stock the rotation reached while they held.
  for (let i = 0; i < sh.stocks.length; i++) {
    const amount = BigInt(sh.amounts[i]!);
    if (amount === 0n) continue;
    const shares: Record<string, string> = {};
    for (const [holder, weight] of Object.entries(sh.weights)) {
      const part = shareOf(BigInt(weight), supply, amount);
      if (part > 0n) shares[holder] = part.toString();
    }
    accumulate(totals, shares, sh.stocks[i]!);
  }
};

/** Sums every window up to `upToEpoch`, and builds the matching trees. */
export async function buildCumulative(
  distributor: Address,
  vault: Address,
  upToEpoch: number,
  /** The payout mode's rule. Defaults to the distribution mode's, so every
   *  existing caller is unchanged; `buildRoot` is what picks another. */
  accrual: WindowAccrual = plainAccrual,
  /**
   * What this mode divides the standard ~$10 push TARGET by.
   *
   * **A divisor and not an amount, because the target is denominated in the
   * vault's own currency** — wei on an ether vault, raw `MIN_BUY_QUOTE` units
   * otherwise — and the caller that knows the mode does not know the currency.
   * Dividing works in both without reading anything.
   *
   * **Keyed on the MODE, which is stamped at birth and never written again, so
   * a rebuild reaches the same answer forever** — that is what makes this safe
   * where reading a mutable per-holder setting would not be. `buildRoot` is
   * the only caller: it maps mode -> divisor, exactly as it maps mode -> rule.
   *
   * It moves the product target only. The gas bound
   * (`PUSH_K_MIN x SETTLE_GAS x basefee`) still applies on an ether vault, so
   * lowering the target can never take a holder below the 95 % guarantee —
   * unlike `PUSH_FLOOR_OVERRIDES`, which is a one-epoch sweep and deliberately
   * replaces both.
   */
  pushTargetDiv?: bigint,
): Promise<BuiltCumulative> {
  const [token, quote, minBuyQuote] = await Promise.all([
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "token" }),
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "QUOTE" }),
    client.readContract({ address: vault, abi: feeVaultAbi, functionName: "MIN_BUY_QUOTE" }),
  ]);
  if (token === "0x0000000000000000000000000000000000000000") throw new Error("vault is not bound to a token");
  // Both floors come from the same two facts, and both are written at the
  // vault's birth and never written again — which is what lets `dispute.ts`
  // rebuild an old root and get the same answer.
  const minShare = minShareFor(quote as string, minBuyQuote as bigint);

  // The anchor, and the deliveries, BEFORE the loop: an accrual rule may need
  // to know what had already been paid out at each window's boundary, and one
  // scan answers that for every window as well as for the delivery floor below.
  //
  // WARNING: the basefee is read at the LAST BLOCK OF THE COVERED EPOCH, not at
  // the current block. The first version read `client.getBlock()` — the head —
  // which made `pushRoot` depend on WHEN the computation ran: two verifiers ten
  // minutes apart got different push sets, hence different roots. Under the
  // keeper model `dispute.ts` is the only check left: it would have reported a
  // divergence on every run.
  const epochEndTs = Number(
    await client.readContract({ address: distributor, abi: distributorAbi, functionName: "epochEnd", args: [BigInt(upToEpoch)] }),
  );
  const anchorBlock = (await blockAtOrAfter(epochEndTs)) - 1;
  const basefee = (await client.getBlock({ blockNumber: BigInt(anchorBlock) })).baseFeePerGas ?? 1n;
  const deliveries = await deliveredLog(distributor, anchorBlock);

  const totals = new Map<string, Entry>();
  /** Every row's cumulative as of `LOCKER_RECLAIM_FROM_EPOCH`, taken once, on
   *  the boundary. `null` until we cross it — and still `null` at the end when
   *  this root does not reach that far, in which case `totals` IS the state at
   *  the gate. */
  let atGate: Map<string, bigint> | null = null;
  const covered: CumulativeArtifact["windows"] = [];
  /** QUOTE spent on each leg, keyed by lowercased stock. The denominator of the
   *  delivery value, and the whole of the 2026-09-13 fix. */
  const quoteSpentOf = new Map<string, bigint>();
  let quoteTotal = 0n;
  let excluded: Address[] = [];

  for (const w of await windows(distributor)) {
    if (w.toEpoch > upToEpoch) break;
    const sh = await windowShares(distributor, token as Address, w, minShare);
    if (!sh) continue;
    covered.push({
      fromEpoch: sh.fromEpoch, toEpoch: sh.toEpoch, stocks: sh.stocks, amounts: sh.amounts,
      periodStart: sh.periodStart, periodEnd: sh.periodEnd, transferBlocks: sh.transferBlocks,
      minBalance: sh.minBalance,
    });
    quoteTotal += BigInt(sh.quoteSpent);
    // Per leg, straight off `WindowFunded` and never off the cached `sh`, whose
    // `quoteSpent` is the window's SUM. Keyed by address rather than by index so
    // a cache written by an earlier run cannot line up the wrong pair.
    const legQuote = new Map(w.stocks.map((st, i) => [st.toLowerCase(), w.quoteSpent[i]!]));
    for (let i = 0; i < sh.stocks.length; i++) {
      if (BigInt(sh.amounts[i]!) === 0n) continue;
      // Counted for exactly the legs that produced entries, so the numerator and
      // the denominator of the delivery value always describe the same
      // purchases. Mode-agnostic: what a leg cost is not a matter of opinion.
      const leg = sh.stocks[i]!.toLowerCase();
      quoteSpentOf.set(leg, (quoteSpentOf.get(leg) ?? 0n) + (legQuote.get(leg) ?? 0n));
    }
    // The snapshot is taken BEFORE the first window that reaches past the gate,
    // so it holds exactly the epochs the correction was decided on.
    if (atGate === null && sh.toEpoch > LOCKER_RECLAIM_FROM_EPOCH) {
      atGate = new Map([...totals].map(([k, e]) => [k, e.cumulative]));
    }
    accrual(totals, sh, deliveries);
  }
  if (totals.size === 0) throw new Error("no shares to distribute");

  // The set in force at `upToEpoch`, replayed from the dated log — never the
  // current state, which would make the artifact depend on when it was built.
  excluded = await excludedAt(distributor, upToEpoch);

  // Push floor: the share NOT YET DELIVERED has to be worth enough to justify
  // delivering it. What was already paid is replayed from the `Delivered` logs
  // **up to `anchorBlock`** — not read from `claimedSoFar` at the head.
  //
  // That read is what the rehearsal of 2026-09-06 caught, and it is the same
  // defect as the basefee one below, one line further down. `claimedSoFar` is
  // live state: at publication every holder was owed their share and went into
  // `pushRoot`; once the airdrop had gone out the same computation found them
  // settled and put NOBODY in it. So `pushRoot` and the artifact's `push` flags
  // — hence the cid — changed the moment the root's own deliveries landed, and
  // `dispute.ts` answered "DIVERGENCE DETECTED · the delivery floor was
  // manipulated" on a root that was perfectly honest. That command is the one
  // the README hands to holders to check us with.
  //
  // Replayed at a fixed block it is deterministic, and it is the same quantity:
  // what a holder was owed at the moment the root was cut. It also replaces one
  // RPC round trip PER ENTRY with a single log scan.
  //
  // On an ether vault, two bounds, keep the higher one:
  //   - PUSH_TARGET_WEI: the ~$20-of-value-per-delivery target;
  //   - PUSH_K_MIN x gas: the floor guaranteeing the holder at least 95 %.
  // At normal gas the target dominates and the holder keeps ~99 %. If gas spikes
  // so far that $20 would no longer leave 95 %, the floor takes over and the
  // threshold rises — the holder never drops below 95 %.
  //
  // On any other vault neither applies: the shares are not in wei. See
  // `pushFloorFor`.
  const paidAt = foldDelivered(deliveries);

  // What the Pons locker accrued before the timelock excluded it goes back to
  // the holders, once, at `LOCKER_RECLAIM_FROM_EPOCH`. Here and not inside the
  // window loop: the rule is one pass over the finished totals, and putting it
  // after `paidAt` is what lets it use the anchored delivery log rather than
  // live `claimedSoFar`. Everything downstream — `cumOf`, the push set, the
  // trees, the cid — is computed from `totals` below, so it all follows.
  const reclaimed = upToEpoch >= LOCKER_RECLAIM_FROM_EPOCH
    ? reclaimUndeliverable(
        totals,
        atGate ?? new Map([...totals].map(([k, e]) => [k, e.cumulative])),
        paidAt,
        LOCKER_RECLAIM_ACCOUNT,
      )
    : new Set<string>();

  // An override IS the whole floor: it replaces the product target and the gas
  // bound both. Keeping the bound would make a row reading "$1" gate at $2.32
  // for a six-leg holder at today's basefee — see `PUSH_FLOOR_OVERRIDES`.
  const override = floorOverride(upToEpoch);
  // A mode target, when there is one, moves the product half and leaves the gas
  // bound alone. A dated override still beats it: that one is a sweep with a
  // deadline and replaces the whole floor on purpose.
  const moded = pushFloorParts(quote as Address, minBuyQuote as bigint, basefee, pushTargetDiv);
  const parts = override !== undefined ? { target: override, perDelivery: 0n } : moded;
  const pushFloor = override ?? (moded.perDelivery > moded.target ? moded.perDelivery : moded.target);
  const totalQuote = quoteTotal === 0n ? 1n : quoteTotal;
  const totalCum = [...totals.values()].reduce((a, e) => a + e.cumulative, 0n) || 1n;

  // Units of each leg the tree owes, the denominator that makes a value mean
  // something. Built from `totals` rather than from the windows: it has to match
  // the entries the floor is applied to, floor and exclusions included.
  const cumOf = new Map<string, bigint>();
  for (const e of totals.values()) {
    const leg = e.stock.toLowerCase();
    cumOf.set(leg, (cumOf.get(leg) ?? 0n) + e.cumulative);
  }

  // The two rules, expressed as the same two maps: the pooled one points every
  // leg at the basket's totals, which is exactly what it used to compute. One
  // formula in `pushSet`, the epoch decides which numbers reach it — see
  // `PUSH_VALUE_V2_FROM_EPOCH`.
  const pooled = (total: bigint) => new Map([...cumOf.keys()].map((leg) => [leg, total]));
  const perLeg = upToEpoch >= PUSH_VALUE_V2_FROM_EPOCH;
  const pushKeys = upToEpoch >= PUSH_WHOLE_HOLDER_FROM_EPOCH
    ? pushSetWhole([...totals.values()], paidAt, quoteSpentOf, cumOf, parts.target, parts.perDelivery)
    : pushSet(
        [...totals.values()],
        paidAt,
        perLeg ? quoteSpentOf : pooled(totalQuote),
        perLeg ? cumOf : pooled(totalCum),
        pushFloor,
      );

  const entries = [...totals.values()];
  const tree = build(entries, pushKeys);

  const artifact: CumulativeArtifact = {
    upToEpoch,
    windows: covered,
    excluded,
    entries: tree.entries.map((e) => ({
      holder: e.holder, stock: e.stock, cumulative: e.cumulative.toString(), push: pushKeys.has(key(e.holder, e.stock)),
    })),
  };

  return {
    artifact,
    reclaimed,
    claimRoot: tree.claimRoot,
    pushRoot: tree.pushRoot,
    // sha256, not keccak: the digest is that of a raw IPFS block, so the CIDv1
    // can be rebuilt from the chain. The committed hash IS the address.
    cid: sha256(toHex(canonicalJson(artifact))),
    entries: tree.entries,
    pushKeys,
    proofFor: tree.proofFor,
  };
}
