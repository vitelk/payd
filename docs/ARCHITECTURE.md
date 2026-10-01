# ARCHITECTURE.md — decisions and solutions

**Date: 2026-09-03.** Every solution below answers a **measured** problem, referenced in `docs/recon.md`. Nothing here is speculative: when a solution rests on a number, that number comes from a dated on-chain call.

Two sources of problems:
- **P1–P5**: found in our own recon (`recon.md` §6, §5, §9).
- **P6–P11**: found by re-reading the third-party contract "FORM-4 FI" (`SignedPot`), which implements roughly our target. We would inherit each of them if we copied it as is.

---

## Where to read what

Forty-five decisions, written as they were taken, so the numbering follows
chronology and not subject. **Nothing here is a tidy retelling** — several
sections record being wrong and say so, which is most of what makes them worth
reading. Cross-references from the contract comments land on these numbers, so
they are stable and never renumbered.

If you are arriving from the code, [`HOW_IT_WORKS.md`](HOW_IT_WORKS.md) is the
five-minute version. This file is the reasoning underneath it.

**The shape of the system**
[§S41](#s41--one-purchase-takes-the-whole-basket-and-a-skipped-leg-brings-nothing-down) one purchase buys the whole basket, and a skipped leg takes nothing down ·
[§S40](#s40--one-currency-per-vault-and-the-pivot-as-a-crossroads) one quote per vault, and the pivot as a crossroads ·
[§S39](#s39--collector-settling-n-launches-in-one-transaction-and-the-door-it-uses) settling N launches in one transaction ·
[§S18](#s18--cumulative-roots-cost-follows-the-stocks-no-longer-time) cumulative roots ·
[§S29](#s29--the-keeper-publishes-and-the-root-takes-effect-immediately) the keeper publishes, and why that is the central trade-off ·
[§S2](#s2--making-distribution-fundable-p2-040holderepoch) making distribution fundable ·
[§S13](#s13--running-without-anyone-what-is-possible-and-what-is-not) running without anyone

**Money: what goes where**
[§S11](#s11--launch-parameters-decided-and-the-split) the split, and the launch parameters ·
[§S15](#s15--a-smoothing-reserve-not-spending-everything-each-cycle) the smoothing reserve ·
[§S14](#s14--eligibility-threshold-by-value-not-as-a-percentage-of-supply) who is in the tree ·
[§S30](#s30--the-delivery-threshold-a-target-and-a-floor) who is worth an airdrop ·
[§S8](#s8--paying-the-keeper-without-opening-a-tap-p10) paying the keeper without opening a tap ·
[§S34](#s34--eth-that-is-not-fee-revenue-and-a-refund-that-outgrew-its-epoch) ETH that is not fee revenue

**Prices, and not being sandwiched**
[§S3](#s3--minout-an-on-chain-floor-tightenable-off-chain-p3-p4) the on-chain floor ·
[§S21](#s21--choosing-the-stocks-depth-beats-the-number-of-price-sources) choosing the ten stocks ·
[§S42](#s42--a-listed-line-must-have-a-pool-that-carries-something) a listed line must have a pool that carries something ·
[§S4](#s4--a-failing-swap-a-failing-transfer-p5--p9) a failing swap, a failing transfer

**The snapshot, and why anyone can replay it**
[§S22](#s22--root-determinism-finally-tested) root determinism ·
[§S23](#s23--an-exclusion-is-dated-not-live) an exclusion is dated ·
[§S32](#s32--the-preflight-refusing-to-publish-rather-than-publishing-wrongly) the preflight ·
[§S36](#s36--the-digest-is-not-the-address-and-confusing-them-capped-us-at-160-holders) the digest is not the address

**Time: epochs, seeds, latency**
[§S20](#s20--immediacy-what-the-epoch-length-buys-and-what-it-does-not) what the epoch length buys ·
[§S17](#s17--any-quantity-coupled-to-the-epoch-length-must-be-a-bounded-parameter) anything coupled to it must be a parameter ·
[§S35](#s35--blocknumber-is-ethereums-and-what-that-costs) `block.number` is Ethereum's, and what that cost us ·
[§S38](#s38--the-time-weighted-average-and-the-machinery-it-deletes) the time-weighted average, and the machinery it deletes

**Cost, measured**
[§S19](#s19--measured-costs-of-the-cycle-and-two-corrections-they-revealed) the cycle, measured ·
[§S31](#s31--the-cycle-pays-for-itself) does it pay for itself ·
[§S37](#s37--what-a-30-minute-epoch-costs-and-the-one-lever-that-does-not-touch-it) what 30-minute epochs cost

**Keys, and what none of them can do**
[§S46](#s46--one-payout-mode-is-one-factory-and-the-stamp-that-keeps-them-apart) one payout mode is one factory, and the stamp that keeps them apart ·
[§S45](#s45--the-way-out-was-closing-on-its-own-generation) the door out was closing on its own generation — the defect stands, the fix was deleted hours later by the `Payd` / `DistributionFactory` split ·
[§S44](#s44--the-timelock-protects-changes-not-the-initial-state) the timelock guards changes, not the initial state ·
[§S24](#s24--the-escape-valve-and-why-it-points-at-the-safe) the escape valve ·
[§S5](#s5--the-root-stays-contestable-p6-form-4-has-no-challenge-mechanism-at-all) the root stays contestable ·
[§S9](#s9--the-push-must-really-be-permissionless-p11) the push must really be permissionless ·
[§S7](#s7--no-funds-trapped-forever-p8) no funds trapped forever

**Still open**
[§S43](#s43--the-v4-leg-the-route-works-and-the-pools-are-empty) the v4 leg: the route runs, the pools are empty ·
[§S10](#s10--one-epoch-one-stock-open-decision) one epoch, one stock

**Being wrong, in public**
[§S27](#s27--adversarial-security-review-three-real-defects) three real defects, found by attacking our own code ·
[§S26](#s26--invariants-what-the-harness-taught-more-than-the-invariants-themselves) what the invariant harness taught ·
[§S25](#s25--a-dress-rehearsal-of-the-deployment) the dress rehearsal ·
[§S33](#s33--harvest-sweeps-pons-itself-in-both-phases) `harvest` sweeps Pons itself

**Superseded, kept for the reasoning**
[§S1](#s1--isolating-the-pons-coupling-p1) ·
[§S6](#s6--not-failing-the-last-holder-silently-p7) ·
[§S10](#s10--one-epoch-one-stock-open-decision) ·
[§S12](#s12--epoch-length-30-min-see-s20) ·
[§S28](#s28--window-aligned-to-the-epoch-30-min) — the optimistic model, the challenge window, and the questions they answered before §S29 removed them ·
[§S16](#s16--one-epoch-one-stock-weighted-rotation) — weighted rotation, right for a one-hour epoch and wrong for a configurable one, until §S41 replaced it.


## S1 — Isolating the Pons coupling (P1)

> **Updated 2026-09-03.** The original problem ("launching blocked, fee model unknown") **no longer exists**: Pons v2 is identified, open, and its fee mechanism has been read (`recon.md` §1.1–1.2). S1 stays useful, for a different reason.

**What we now know.** `V2FeeEscrow.claim()` reads `_balances[msg.sender]`. Therefore:
- the `creatorFeeRecipient` **must be the contract that calls `claim()`** — no delegation is possible;
- with `pairToken = address(0)`, the fees are in **native ETH**;
- changing the `creatorFeeRecipient` takes **3 days of timelock + a 3-day execution window**.

**Decision: `FeeVault` is directly the `creatorFeeRecipient`.** No intermediate `FeeForwarder` — it would add a hop and buy nothing, since the claim has to come from the recipient anyway.

```solidity
contract FeeVault {
    IV2FeeEscrow public immutable ESCROW;   // 0xd3AFEB2a...
    receive() external payable {}           // the escrow pays with call{value:}

    /// Permissionless: anyone triggers it, but FeeVault is msg.sender towards
    /// the escrow, so the ETH can only arrive here.
    function harvest() external {
        if (ESCROW.balanceOf(address(this)) != 0) ESCROW.claim();
        ...
    }
}
```

**The real reason to keep S1: the 3-day timelock.** Replacing `FeeVault` is no longer an instant operation. Two consequences to accept:
1. **Runbook**: `transferCreatorFeeRecipient` → wait 3 days → `executeCreatorFeeRecipientChange` **within the following 3 days**, otherwise the procedure expires and everything has to start over. To be written into `LAUNCH_CHECKLIST.md` with a calendar alert.
2. **`FeeVault` must be the simplest contract possible**, because it is the most expensive to replace. All the logic likely to evolve — weights, routes, oracle, distribution — belongs to the `Distributor` and to the scripts, not to the vault. The vault collects, swaps according to timelocked `Allocation`s, and passes on. Nothing else.

**If we had gone with `RWAERC20LaunchpadFactory` instead** (`recon.md` §1.4), its escrow exposes a **permissionless** `claimFor(recipient, currency)`: the vault would not even need a `harvest()`, anyone would push the fees into it. That is cleaner, but it is not Pons — trade-off in `recon.md` §9.1.4.

## S2 — Making distribution fundable (P2: $0.40/holder/epoch)

**Measured problem** (`recon.md` §6): a stock-token transfer costs ~40,000 gas in a batch → **$0.04** at 0.4177 gwei and ETH = $2,385.81. Ten stocks per holder = **$0.40 per holder per epoch**. At 10,000 holders, $4,000 per epoch. A full push is not fundable.

**The principle that governs everything below: the threshold decides who we deliver to for free, never who is entitled.** The claim stays open to everyone, all the time, from the moment the epoch is settled.

### S2.a — A derived push threshold, kept out of the contract

No finger-in-the-air `MIN_BALANCE` as a percentage of supply. We push **if and only if the share is worth appreciably more than its delivery**:

```
push  if  shareValue(holder) >= K * deliveryCost        (K = 10, decided)
claim otherwise — and the claim is open to everyone, all the time
```

`K = 10` is not an arbitrary figure, it is a restatement: **gas never exceeds 10 % of the value delivered**. The same rule as the volume table in §S11.

**The threshold does not exist in the contract.** It is a keeper policy, computed in `snapshot.ts`. It can be adjusted in the light of real figures without redeploying anything, without a timelock and without a key. The contract only knows roots.

Effective threshold as a share of eligible supply, with the 4-epoch grouping from §S2.b:

| Volume / epoch | Push threshold |
|---|---|
| $100 k | 0.025 % of supply |
| $500 k | **0.005 %** |
| $2 M | 0.00125 % |

At $500 k of weekly volume, holding 0.005 % of supply is enough to be delivered without doing anything.

### S2.b — Deliver every 4 epochs, claim open in between

The cost is per *delivery*, not per epoch. Accumulating and pushing every 4 epochs divides the gas by 4: **$0.10/holder/epoch**. Shares keep being computed and settled **every week**; only the pushed delivery is grouped.

**The claim is never grouped.** As soon as an epoch is settled, anyone can claim theirs — without waiting for the push cycle, without a threshold, without a condition. The grouping is an optimisation on our side, it adds no constraint on the holder's side.

**Synergy with S2.a**: the share accumulated over 4 epochs is 4x bigger for an identical delivery cost. So, at constant `K`, **the grouping makes the threshold 4x more inclusive**. The two levers reinforce each other rather than adding up.

### S2.c — A basket token: **not now**, with a written trigger

The idea: a `BASKET` ERC-20 backed by the 10 stocks held by the `Distributor`. Distributing becomes **1 transfer instead of 10** ($0.04 instead of $0.40 per holder, and the volume needed per holder drops from ~$100 to ~$10 per epoch, §S11). A permissionless `redeem(amount)` returns the pro-rata of the 10 stocks to whoever asks.

**The strongest argument is not ours, it is the holder's.** A $0.40 share spread over ten stocks is **$0.04 per line**: dust that will always cost more to move than it is worth. The basket concentrates the same value into one transferable unit. At small share sizes the basket is **strictly better for the holder**, not only for our costs. At large sizes ($20/holder, i.e. $2 per line), direct delivery becomes more legible again.

**Decision: we are not building it now.** Three reasons:

1. **S2.a + S2.b + S2.d already solve solvency**, by excluding the unprofitable tail from the push — which keeps its right to claim. The basket answers a different goal, "push to everyone", which we never committed to.
2. It is a **change of product promise** (a redeemable share instead of ten tokens in a wallet), so a choice better made on real figures than on a projection.
3. It is one more contract: audit surface, an extra failure mode, and a wrapper holding restricted RWAs has its own legal reading (see the legal point in `PLAN.md`).

**Trigger to reopen the question** — to be checked after the first 4 real epochs:

> If the number of pushed holders is limited by gas rather than by the threshold, **or** if the median share per holder falls below ~$4 while the number of eligible holders exceeds ~5,000, then the basket becomes the only lever left and we build it.

That is exactly the 50 % line of the table in §S11. Until we get there, the basket is complexity we do not have to pay for.

### S2.d — Two roots per epoch (a fix for a flaw that S8 + S9 created)

**The problem.** S9 makes `distributeBatch` permissionless and S8 refunds gas from the reserve. Taken together, anyone can push any holder in the tree **and get reimbursed**. An attacker pushes 10,000 specks of dust worth $0.001 and drains the gas reserve, stealing nothing but paralysing real deliveries. Both solutions were good separately; it was their combination that opened the hole.

**The fix.** Each epoch publishes **two roots**:

| Root | Content | Used by |
|---|---|---|
| `claimRoot` | **all** eligible holders | `claim()` — the entitlement, unconditional |
| `pushRoot` | only those above the threshold | `distributeBatch()` — and **the gas refund is only paid against a proof under this root** |

Consequences:
- a stranger can now only push holders it was **already profitable to push**: that is no longer griefing, it is help, and the refund is deserved;
- pushing someone outside `pushRoot` stays possible, but **at their own expense** — so of no interest to an attacker, and still possible for a well-meaning third party;
- the threshold becomes **committed on-chain and contestable** like everything else (it is implicit in `pushRoot`), for the cost of one `bytes32` per epoch;
- `claimRoot` stays sovereign: being outside `pushRoot` removes no entitlement.

Both roots go into the single hash of §S5, so one challenge covers them both.

**Decided: S2.a (K = 10) + S2.b (4 epochs) + S2.d (two roots). S2.c deferred, with a written trigger.**

---

## S3 — `minOut`: an on-chain floor, tightenable off-chain (P3, P4)
**Measured problem** (`recon.md` §5): the Chainlink equity feeds are 0.2 h to 3.5 h behind during trading hours, 17.3 h for SGOV, and go stale all weekend. GLD, RDDT and HIMS have no feed at all.

### Correction: I had overstated the security argument

I wrote that a Chainlink veto was a security necessity. **That is false, and two risks I was conflating must be separated:**

| Risk | Real at our size? |
|---|---|
| **Manipulation for profit** — an attacker moves the TWAP to extract value from our swap | **No.** Moving a 30-minute TWAP on a $200 k–$4.8 M pool requires holding the price off-market for 30 minutes. Our swap is **$120 to $840 per stock** (table below). The cost of manipulation exceeds the gain by several orders of magnitude. |
| **Stale pool price** — over the weekend the pool stays at Friday's price; if the underlying gaps on Monday, we paid Friday's price | **Yes, but it is a *price* risk, not a *safety* risk.** Nobody is stealing from us; we get a worse entry. Bounded, and **symmetric** — the gap works in our favour as often as against us. |

Hard-blocking on feed freshness protected against the second risk, which does not justify sacrificing liveness. **Mandatory veto abandoned.**

### The design that uses the off-chain side without trusting it

This is what you were pointing at: we have a keeper, let us use it. The key is that **the caller can only tighten, never loosen.**

```
minOut = max( callerMinOut , onChainFloor )

onChainFloor = amountIn / twapPrice30min * (1 - MAX_SLIPPAGE_BPS)      // always available
if the Chainlink feed is fresh (< MAX_FEED_AGE):
    onChainFloor = max( onChainFloor, oracleVersion )                   // tightens further
    and we log |twap - oracle| as an event, without blocking
```

Properties:
- **Permissionless preserved.** `harvest()` stays callable by anyone. A hostile caller can only make the swap fail (the ETH stays in the vault, no loss), never degrade it.
- **The keeper contributes knowledge without authority.** It knows the real price, a CEX order book, market hours; it passes a tight `minOut`. If it is compromised or absent, the on-chain floor takes over.
- **Never a single source and never `minOut = 0`.** If the TWAP is unavailable (`observe()` in a `try/catch`), that stock is not bought this cycle.
- **Chainlink becomes a tightener and a witness**, not a switch. Fresh, it hardens the floor. Stale, it is ignored and the divergence is logged.

### What this unblocks

- **No blocking window.** No more dependency on US market hours, no more cycle lost over the weekend.
- **GLD, RDDT and HIMS become eligible again** ($802 k, $854 k and $545 k of USDG liquidity), with a TWAP-only floor. To be arbitrated in the list of 10 — `recon.md` §8 had rejected them on the "feed present" criterion, which is no longer blocking. Including them stays your choice: it trades depth against a single price source.
- **Cardinality becomes critical again**, since the TWAP is the last-resort floor and no longer a second opinion. Bumping QQQ (**~$30**) and HIMS (~$32) is no longer optional if we keep them.

### And short epochs settle the rest

The stale-price risk dilutes itself with short epochs: buying every day instead of every week is **DCA**, and weekend gaps average out instead of landing on one large purchase. See §S12.

| Epoch length | Rewards / epoch | Per stock | In ETH |
|---|---|---|---|
| 1 week | $20,000 | $2,000 | 0.838 ETH |
| 48 h | $5,714 | $571 | 0.240 ETH |
| **24 h** | **$2,857** | **$286** | **0.120 ETH** |

(at $500 k of weekly volume, rewards = 4 %)

Swaps of 0.12 ETH make the manipulation argument even more absurd, and the slippage measured in `recon.md` §4.2 — already 0.002 %–0.09 % at 0.5 ETH — becomes negligible.

### Prerequisite verified on 2026-09-03: observation cardinality

A 30-minute TWAP requires the pool to keep 30 minutes of observations. Measured (`slot0().observationCardinality`):

| Pool | Cardinality | Verdict |
|---|---|---|
| NVDA/USDG | 6000 | ok |
| SPCX/USDG | 3100 | ok |
| WETH/USDG | 2500 | ok |
| AAPL, SPY, AMZN, GOOGL, TSLA, MSFT, RDDT | 1801 | ok, at the limit |
| GME | 1500 | ok, at the limit |
| GLD | 1400 | ok, at the limit |
| **QQQ** | **300** | ~5 min under dense trading |
| **HIMS** | **200** | ~3 min under dense trading |

Uniswap v3 writes at most one observation per second. 1801 ≈ 30 min of continuous trading; in practice trading is sparse, so it covers far more. But QQQ and HIMS are too short to be safe.

**Fix, once, at deployment**: `increaseObservationCardinalityNext(pool, 1801)` on the pools that are too short. The function is **permissionless** — anyone can pay for it. 1801 is the target because Uniswap v3 writes at most **one observation per second**: 1801 guarantees 30 min even under continuous trading, and it is already the level of the other seven pools.

Real cost, at ~20 k gas per initialised slot, 0.4177 gwei, ETH = $2,385.81:

| Pool | Bump | Slots | Cost |
|---|---|---|---|
| QQQ | 300 → 1801 | 1,501 | **$29.92** |
| HIMS | 200 → 1801 | 1,601 | **$31.91** |
| GME | 1500 → 1801 | 301 | $6.00 |
| GLD | 1400 → 1801 | 401 | $7.99 |

**≈ $30 for QQQ, ≈ $32 for HIMS** if it is kept. This is no longer optional: since the revision of §S3, the TWAP is the last-resort floor, so a pool with short cardinality is a stock we will not be able to buy. To be done in `Deploy.s.sol`, and to be re-checked before adding any stock.

**Last-resort guard**: call `observe()` in a `try/catch`. If the TWAP is unavailable (insufficient cardinality), **we do not swap that stock this cycle** — the same rule as for a stale feed: the ETH stays in the vault and the other nine go through. Never `minOut = 0`, never a single source, never a silent fallback.

> **This paragraph described an intention, not the code, until 2026-09-10.**
> `FeeVault._legFloor` called `TwapFloor.meanTick` — an INTERNAL library call,
> which `try` cannot wrap, a detail that reads as a formality and is not one:
> one pool unable to serve the window reverted the WHOLE `buyBasket`, for every
> vault holding that leg, on every purchase, until somebody paid to bump the
> pool's cardinality. `Payd._requirePool` admits a pool on existence and
> liquidity alone, so nothing upstream stopped such a leg from being listed.
> The `try` now lives around `observe` itself, in `TwapFloor.tryMeanTick`, and
> `_legFloor` returns 0 — which `_buyLegs` already reads as "skip this leg, its
> USDG waits in the reserve". Regression test:
> `test_APoolTooYoungForTheWindowCostsOnlyItsOwnLeg`, which builds the
> condition out of real swaps on a real pool (TSLA/USDG tier 500, cardinality
> 8) rather than mocking Uniswap. Note the shape of the trap: a pool fails the
> window only while EVERY observation it holds is inside it, so a quiet pool
> answers from its last write — the first version of that test passed against
> the bug.

---

## S4 — A failing swap, a failing transfer (P5 + P9)

**Problem.** Two different surfaces, often conflated:
- at the **swap**: a stock can be paused or its pool empty;
- at **delivery**: `Stock.transfer` is guarded by `onlyNotPaused` **and** `onlyNotBlocked(from)` / `onlyNotBlocked(to)`. Robinhood can pause a token or blocklist an address — including ours.

The FORM-4 contract tests `oraclePaused()` before buying. **That is the wrong flag**: in the `Stock` source (read, `recon.md` §2.2), transfers are guarded by `paused()` = `$.paused || registry.paused()`. `oraclePaused()` blocks no transfer. And nothing tests `isBlocked(address(this))`.

**Solution: do not test, try.** A state read at block N can change at block N+1; a prior `require` gives false security and a hard block.

```solidity
// swap
try router.exactInput(...) returns (uint256 out) { ... }
catch { /* the ETH stays in the vault for the next cycle */ emit SwapSkipped(stock); }

// delivery
try IERC20(stock).transfer(holder, amt) returns (bool ok) {
    if (ok) { claimed[epoch][holder][stock] = true; }
    else    { emit PushFailed(epoch, holder, stock); }
} catch { emit PushFailed(epoch, holder, stock); }
```

**The critical point, and this is where FORM-4 takes the wrong trade-off**: `SignedPot` sets `paid[roundId][account] = true` **before** the transfer, and its `_safeTransfer` reverts on failure. Result: a single paused stock reverts the whole batch. For us it must be the opposite — **never mark `claimed` if the transfer did not succeed**, otherwise a temporarily paused token **permanently burns the holder's entitlement**. The entitlement must survive the failure and stay claimable.

Add an explicit non-regression test: `test_PushFailedDoesNotBurnEntitlement`.

---

## S5 — The root stays contestable (P6: FORM-4 has no challenge mechanism at all)

`SignedPot.publishDistribution` is `onlyOperator` and **nothing on-chain ties the root to real balances**. `snapshotBlock` helps auditing but commits nobody. Its sentence *"it cannot pick where the stock goes"* is true **only for an honest root**.

**We keep our optimistic design** (the pre-recon plan): `proposeRoot` with a bond, a challenge window, `challenge` with a bond, arbitration by the timelock only in case of a dispute. This is the point where we must not copy — our version is strictly stronger.

Two things to **take** from FORM-4 nonetheless:
1. **`snapshotBlock` on-chain.** Without it, "anyone can recompute the root" is false: the verifier has to be told which block to replay. To be stored in the epoch.
2. **A single hash commits everything.** Publish `keccak256(epoch, claimRoot, pushRoot, eligibleSupply, holdersCount, snapshotBlock, cid)` rather than separate fields: the challenger challenges **one** hash, not a field, and nothing can be modified afterwards without changing it. **Both** roots from §S2.d go into it, so a single challenge covers both the entitlement (`claimRoot`) and the push threshold (`pushRoot`).

And make the draw of the 8 blocks verifiable: seed = `blockhash(epochEndBlock)`, as originally planned. The seed is on-chain, so the draw is replayable by anyone without taking our word for it.

---

## S6 — Not failing the last holder silently (P7)
**Problem.** In `SignedPot._credit`, if `Σ(leaves) > eligibleSupply`, the guard `d.paidOut + amount > d.stockAmount` triggers `RoundExhausted`. In strict mode it reverts; **in the batch paths it is a silent `skip`**: the last holders are never paid and nothing reports it.

**Solution, one line: cap instead of refuse.**

```solidity
uint256 remaining = d.stockAmount - d.paidOut;
if (amount > remaining) amount = remaining;   // instead of revert/skip
```

The total stays bounded by what the epoch funded (the invariant that matters), but the last holder receives the dust instead of zero. No silent failure mode.

In addition, on the off-chain side: `snapshot.ts` **must** guarantee `Σ(holderBalance) == eligibleSupply` exactly, and the CI reproducibility test must check that equality — not merely that two machines produce the same root.

---

## S7 — No funds trapped forever (P8)

`SignedPot` has neither an owner nor a `withdraw` — a good property, but it creates three permanent traps. Fixes:

| Trap | Fix |
|---|---|
| If the pot never exceeds `MIN_SPEND_WEI`, `_spend` always reverts (`floor ≥ MIN_SPEND_WEI > pot`) → **ETH locked forever** | The anti-dust floor must only apply when it is reachable: `if (pot < MIN_SPEND_WEI) floor = pot;` — spending the whole pot is allowed. One small round is better than a permanent lock. |
| `rolledOver[stock]` is only consumed by the **next purchase of the same stock** → an abandoned stock keeps its credit forever | Add a **permissionless** `roundFromCredit(address stock)`: it creates an epoch funded solely by `rolledOver[stock]` and zeroes the credit. No need to buy the stock again in order to distribute it. No new power: the stock still only leaves towards a proven holder. |
| The `Distributor` blocklisted on a stock → that stock can no longer leave | Irreducible at the token level (`recon.md` §2.3). Mitigation: S4 (one stock failing does not prevent the other 9) + the risk written plainly in the README. |

---

## S8 — Paying the keeper without opening a tap (P10)

`SignedPot._refundGas` refunds a flat `GAS_PER_PAYOUT * payouts`. The comment owns the choice (`tx.gasprice` is chosen by the caller, so refunding the real cost would let a leaked key drain the reserve). But the flat rate is still drainable by the operator, and it is either too generous or insufficient.

**Solution: measure the gas, price it at `block.basefee`, cap it.**

```solidity
uint256 g0 = gasleft();
...                                     // the work
uint256 used = g0 - gasleft() + OVERHEAD;
uint256 owed = used * block.basefee;                    // not tx.gasprice
if (owed > payouts * MAX_REFUND_PER_PAYOUT) owed = payouts * MAX_REFUND_PER_PAYOUT;
if (owed > gasReserve) owed = gasReserve;               // degrade, do not revert
```

`block.basefee` is not chosen by the caller: the manipulation disappears, the refund follows the real cost, and the per-payout cap bounds the damage from a leaked key. It is also the answer to point 10 of `recon.md` §9.3: a constant 0.0005 ETH tip (~$1.19) covers a `harvest` but **not** a 25-holder batch ($10–15).

**Indispensable condition, otherwise this refund is a tap**: it is only paid against a proof under `pushRoot` (§S2.d). Without that guard, an attacker pushes dust and gets refunded until the reserve is empty. Pushing a holder outside `pushRoot` stays allowed — but at the caller's expense.

---

## S9 — The push must really be permissionless (P11)

In `SignedPot`, `distribute()` and `distributeTo()` carry `onlyOperator`, while the file header announces *"distribute() anyone pays the gas"* and the NatSpec of `distributeTo` literally says *"Permissionless, because there is nothing here to aim"* — right above the modifier. The contract's most visible decentralisation property is not implemented.

**For us it must be**, and it is safe: the destination is the address **written in the Merkle leaf**, never the caller's. A pusher can only spend their gas to pay someone else.

The only reason to close it would be the gas refund, and two guards neutralise that: **S8** (refund at real cost priced at `block.basefee`, capped — pushing is never profitable in itself) and **S2.d** (refund reserved for proofs under `pushRoot` — pushing dust is never refunded).

`distributeBatch` therefore stays **open to everyone**, in line with `docs/CONVENTIONS.md` ("every cycle action is callable by anyone"), without that openness creating a drain vector.

---

## S10 — One epoch, one stock? (open decision)

FORM-4 buys **a single stock per round**. That makes the partial-swap problem disappear: no try/catch, no failure semantics, each round has its own independent snapshot.

| | Our `Allocation[10]` | One stock per round |
|---|---|---|
| A swap failing | try/catch mandatory, ETH carried over | impossible by construction |
| Snapshots | 1 per epoch | 10 per cycle |
| Transfers per holder | 10 | 1 per round, **10 in total** — identical |
| Weights honoured | in every epoch | on average over time |
| Contract complexity | higher | lower |

**Gas does not decide it**: ten rounds with one transfer cost as much as one round with ten transfers. The per-stock aggregation in `SignedPot._settle` (one transfer for twenty rounds of the same stock) would only help us if we adopted **their** rhythm too — frequent purchases of the same stock. With a weekly epoch and ten distinct stocks, it merges nothing.

**~~Recommendation: keep `Allocation[10]`~~ — REVISED, see §S16**, because the weights are the product promise and one round per stock makes them only approximate in the short term. The try/catch from S4 is needed for delivery anyway, so sharing it with the swap costs almost nothing. To be revisited if the contract becomes too heavy.

---

## S11 — Launch parameters decided, and the split

> **The three numbers below are $PAYD's, and two of them moved.** As written
> (2026-09-03) this was a single-token project, so "the launch parameters" and
> "$PAYD's launch parameters" were the same sentence. They are not any more:
> `creatorTaxBps` is chosen **per launch** by the creator at Pons, and every
> figure derived from it is that launch's alone.
>
> For **$PAYD** the tax settled at **300, not 400** — trader pays 4.00 %, the
> vault receives 3.70 % — and `platformBps` is **0**, so the dev bucket below
> does not exist for it: the residue goes to the creator instead
> (`LAUNCH_PAYD.md`, `script/DeployPaydVault.s.sol`, `test/LaunchTonight.t.sol`).
> The `REWARDS_BPS = 8511` / `DEV_BPS = 1489` pair is gone with the fixed split;
> it is `rewardsBps = 8 649` on the vault, and the platform's share is a separate
> `PLATFORM_BPS` stamped at birth.
>
> **What the reasoning below still buys**, and it is the reason the section
> stays: why the tax landed at 4 rather than 10, and why the split has to be a
> **ratio rather than a rule about origin** — `escrow.claim()` returns one number
> with no breakdown, so the contract cannot tell the tax from the curve share.
> That constraint is unchanged. The 400/4.70 % arithmetic also still describes a
> launch that picks 400, which `test/Launch.t.sol` does and asserts.

**Decisions taken on 2026-09-03:**

| Parameter | Value | Consequence |
|---|---|---|
| `pairToken` | **native ETH** (`address(0)`) | creator fees in **native ETH**; `FeeVault` only needs a `receive()` |
| `creatorTaxBps` | **400 (4 %)** | frozen forever at launch. Revised 10 % → 5 % → 4 % — reasoning below |
| `buybackEnabled` | **false** — see `recon.md` §1.7 | keeps the pre-graduation sweep reachable by the buffer, without depending on the Pons operator |
| `launchConfigId` | 0 (the only one) | supply 1e27, `curveFeeBps` 100 (1 %) |

**What we actually collect**, measured in §1.9 of `recon.md` on two graduated tokens:

```
the trader pays      1 % (curve fee)  +  4 % (our tax)  =  5.00 %
Pons takes           30 % of the curve fee              =  0.30 %
we receive           70 % of the curve fee + the tax    =  4.70 %
```

The tax is paid to us **in full**: Pons only takes 0.30 % of volume, whatever our tax. And that 0.70 % share of the curve fee is identical before and after graduation.

**Split of that 4.70 %**:

| Bucket | Share of what is collected | Share of volume |
|---|---|---|
| Rewards (buying the basket, distributed to holders) | `REWARDS_BPS = 8511` | **4.000 %** |
| Dev | `DEV_BPS = 1489` | **0.700 %** |

**The split follows where the money comes from.** Rewards take the creator tax
in full — the 4 % we set and control. Dev takes our share of the curve fee, the
0.70 % that belongs to the launchpad's own economics and that we do not set.

It is expressed as a ratio rather than a rule about origin because the contract
cannot tell the two apart: `escrow.claim()` returns one amount, and Pons credits
`creatorAmount = curve share + tax` as a single number with no breakdown. 8511 /
1489 reproduces the intended division to within two hundredths of a basis point,
and sums to exactly 10,000.

> **The burn was removed on 2026-09-04.** An earlier split sent 0.5 points of
> volume to buying the token back and calling `burn()`. It went, and with it
> `buyAndBurn`, the v4 swap path, `recoverStalledBurn`, `BURN_STALL` and the
> `poolManager` config field — about 150 lines of the vault and its only
> reentrant path into Uniswap.
>
> What that costs, stated once: the burn was the only mechanism creating demand
> for the token itself. Without it the token's case is entirely the stock
> distribution, which is the simpler promise and the one the contracts can
> actually keep. The 0.5 points did not disappear — 0.35 went to rewards and
> 0.15 to dev.

Sum = 10,000 bps. Immutable constants in `FeeVault`, no setter.

The constants are **fractions of what arrives**, not points of volume. That is deliberate: the effective rate depends on `creatorTaxBps` and on the curve fee, two things we do not fully control. A constant expressed in points of volume would be wrong as soon as either of them moved (§S17).

### Why 5 and not 10

The argument that decides it is not "10 is a lot", it is **the asymmetry of an irreversible decision**.

- Too low: we leave revenue on the table, but the token lives, volume exists, and rewards follow volume.
- Too high: the token never takes off. **10 % of nothing is nothing.** And we cannot lower it afterwards.

When a parameter is frozen forever and the two errors do not cost the same, you place yourself on the recoverable side. With the 1 % curve fee, 5 % gives a round trip at ~11.6 % instead of ~21 %. That is still above comparable launchpads (0–2 %), but within an order of magnitude a market tolerates.

**What it costs, honestly**: at rewards = 4 % instead of 8.5 %, **about twice the volume** is needed for the same rewards/gas efficiency. The bet is that 5 % attracts more than twice the volume of 10 % — unverifiable in advance, but the asymmetry above holds whatever the real elasticity.

### The volume we need (computed on the gas measured in `recon.md` §6)

Rule: delivery must not exceed **10 % of rewards**.

| Delivery mode | Cost per holder | Volume required, per pushed holder per epoch |
|---|---|---|
| Direct push, 10 transfers | $0.40 | **≥ $100** |
| Basket token (§S2.c), 1 transfer | $0.04 | **≥ $10** |

| Holders pushed | Volume / epoch | Rewards | Per holder | Delivery gas | % of rewards |
|---|---|---|---|---|---|
| 1,000 | $100,000 | $4,000 | $4.00 | $400 | 10 % |
| 1,000 | $500,000 | $20,000 | $20.00 | $400 | 2 % |
| 5,000 | $100,000 | $4,000 | $0.80 | $2,000 | **50 %** |
| 5,000 | $500,000 | $20,000 | $4.00 | $2,000 | 10 % |
| 20,000 | $2,000,000 | $80,000 | $4.00 | $8,000 | 10 % |

**The 50 % line is what justifies S2.a.** Many holders on little volume, and half the rewards go to gas. The derived push threshold (`push if share ≥ 10 × delivery cost`) prevents exactly that case: below the threshold, the share stays claimable instead of being delivered at a loss. **The threshold is not a convenience, it is what makes the system solvent at low volume.**

### The dev share

0.3 % of volume, in ETH, to an address fixed at deployment.

**Recommendation: immutable, to a Safe multisig.** The Safe absorbs signer rotations without the contract changing address — flexibility without adding a setter, so without adding a key to the system.

---

## S12 — Epoch length: 30 min (see §S20)

`docs/CONVENTIONS.md` set "distribution epoch: 1 week". **Decided: 1 h** (revised down from 24 h on 2026-09-03).

### What shortening the epoch breaks

Three things do not survive the change of scale, and two were latent defects this choice revealed.

| | 24 h epoch | 1 h epoch |
|---|---|---|
| **Constant** proposer premium (0.01 ETH) | 1 % of rewards — ~$24/day | **20 % of rewards — ~$573/day** |
| `BUY_INTERVAL = 12 h` | below the epoch length | **12x the epoch length**: epochs with no `quoteSpent`, hence no computable threshold |
| `payoutBps = 10 %` | pays 10 %/day, 81 % left after a 48 h lull | **pays 92 %/day, 0.6 % left** |
| Keeper load | 4 tx/day, 1 tree | **96 tx/day, 24 trees, 24 IPFS publications** |

**Fixes applied:**

1. **The premium becomes proportional** — `BOUNTY_BPS = 100` (1 % of the epoch's ETH), capped by `MAX_BOUNTY`. It adjusts itself to the epoch length and to volume. A constant does not survive a change of scale: it is exactly the kind of parameter that looks harmless and empties a treasury.
2. **`BUY_INTERVAL` drops to 30 min**, below the epoch length. It must stay there: an epoch with no purchase has no `quoteSpent`, so no computable eligibility threshold and nothing to distribute.
3. **`payoutBps` stays timelock-adjustable**, but its value now depends on the epoch length — see the warning in §S15.

### What it costs, to be accepted

- **Minimum holding falls to one hour.** Drawing 8 blocks inside the hour forces presence at 8 unpredictable instants, so in practice holding for the hour — but long-term alignment disappears. That is the real price.
- **Swap gas rises.** 24 purchases/day × 10 stocks = 240 swaps of ~$12 each. At ~$0.33 of gas per swap, that is **~2.8 % of rewards** in swap fees, against ~0.1 % with 24 h epochs. It stays within the 10 % budget of §S2, but it is no longer negligible.
- **The challenge window stays 24 h**: it is a human reaction time, it does not follow the epoch length. Consequence: **24 epochs are in flight permanently**, each with its bond (~1.2 ETH immobilised), and rewards arrive 24 h late. To be decided: keep 24 h, or shorten it by relying on an automated `dispute.ts`.

### What the epoch length changes, and what it does not

| | 1 week | 24 h |
|---|---|---|
| Minimum holding period to earn | 7 days | **1 day** |
| Size of one swap per stock (at $500 k/week) | 0.838 ETH | **0.120 ETH** |
| Slippage incurred | already negligible | **even more negligible** |
| Keeper transactions (propose + finalize + fund) | ~3 / week | **~3 / day** |
| Delivery gas cost | **unchanged** — it depends on the number of deliveries, not of epochs (§S2.b) | same |
| Latency from epoch end to distribution | ~24 h (challenge window) | ~24 h, **unchanged** |

**The important point: the epoch length and the delivery cadence are decoupled.** §S2.b groups delivery every 4 epochs; with 24 h epochs, that is one delivery every **4 days** instead of every 28. Distribution gas does not move, only the perceived rhythm improves.

### What it costs, honestly

1. **Alignment falls.** A one-week epoch requires holding for a week; 24 h only requires a day. The token becomes easier to treat as a mercenary. That is the real price of the decision.
   **What mitigates it**: the snapshot stays the **average of N = 8 blocks drawn at random inside the epoch** (`docs/CONVENTIONS.md`). To capture a 24 h epoch you have to be present at 8 unpredictable instants spread across the day — in practice, to hold for the day. The draw protects against one-off sniping, independently of the length.
2. **7x more roots proposed**, hence 7x more bonds to immobilise and IPFS publications. With a 24 h challenge window and a 24 h epoch there is only **one root in flight at a time** — the pipeline stays simple, but the keeper runs every day.
3. **7x more monitoring.** `dispute.ts` has to be run daily by third parties for the optimism to stay credible. To be documented in the README as a routine, not as a one-off gesture.

### What it gains, beyond the product feel

- **DCA.** Buying every day instead of once a week averages weekend gaps instead of concentrating them into one large purchase. That is what finally makes the Chainlink veto unnecessary (§S3).
- **Swaps 7x smaller** → even lower slippage, and the TWAP-manipulation argument becomes definitively absurd at 0.12 ETH per stock.
- **A failure is 7x less costly.** A stock we cannot buy on a given day represents 1/7 of what it used to, and it is picked up the next day.

### Parameters chosen

| Constant | Value | Adjustable |
|---|---|---|
| `EPOCH_LENGTH` | **1 h** | immutable (constructor parameter) |
| `CHALLENGE_WINDOW` | **2 h** | **bounded constructor parameter** [1 h, 7 d] — see §S17 |
| Pushed delivery cadence | **4 epochs** (≈ 4 days) | keeper policy, outside the contract (§S2.a) |
| `CLAIM_DEADLINE` before rollover | 90 days | timelock 48 h |

The challenge window must **not** be shortened along with the epoch: 24 h is the minimum for a human to notice a wrong root and react. A 24 h epoch with a 24 h window means we distribute epoch N during epoch N+1 — an offset of one step, with no overlapping bonds.

---

## S13 — Running without anyone: what is possible and what is not

**Question asked: can the snapshot and the Merkle tree be done on-chain?**
**Answer: no.** Four obstacles, each verified on 2026-09-03.

| Obstacle | Verification |
|---|---|
| The token has **no checkpoints, no snapshot, no votes** | `PonsV2LauncherToken` ABI: `allowance, approve, balanceOf, burn, burnFrom, curve, decimals, deployer, description, getTokenInfo, launchFactory, logo, name, socials, symbol, totalSupply, transfer, transferFrom`. Nothing historical. |
| **ERC-20 holders are not enumerable** | The `Transfer` events exist but a contract cannot read events. |
| **Historical state proofs** are out of reach | Native `blockhash`: 256 blocks ≈ **26 s** at ~100 ms/block. EIP-2935 (`0x0000F908…2935`) is deployed and serves **at least 300,000 blocks (~8.3 h)**, but **reverts at 432,000 (~12 h)** — less than one epoch. And it only gives hashes, not MPT proofs. |
| An **on-chain tree** would cost O(N) hashes + O(N) writes per epoch | Out of budget from a few thousand holders on. |

**But the real goal is not "on-chain", it is "not depending on anyone in particular".** That is reachable, and three pieces were missing.

### S13.a — The draw comes from the chain, in two steps

The original plan was `seed = keccak(blockhash(epochEndBlock))`. With native `blockhash` that leaves **26 seconds** to act: impossible without a bot watching every block — exactly what we want to avoid.

Two calls, both permissionless:

```
anchorEpoch(epoch)   -> sets seedBlock = block.number + SEED_DELAY (128 blocks)
revealSeed(epoch)    -> seed = keccak(epoch, blockhash(seedBlock))
                        native blockhash, then the history contract beyond 256
```

- Whoever anchors **does not yet know** the hash they are fixing: they cannot grind the draw by choosing their moment.
- **No deadline.** There used to be a `SEED_WINDOW` of 6 h, past which `revealSeed` reverted forever. That made a keeper outage terminal — and not only for the epoch it hit: `buildCumulative` replays from epoch 0 and cannot skip a funded epoch with no seed, so **one** stranded epoch stopped every future root. The keeper looked alive, kept buying stock, and never distributed again.
- Instead, a **dead anchor can be replaced**: `anchorEpoch` accepts a second commit once the old target's hash is provably unreachable. Liveness is unconditional — an outage costs time, never an epoch.
- The draw stays un-grindable because replacement is gated on unreachability. While the anchored hash is still readable `revealSeed` works and re-anchoring reverts, so nobody can re-roll a seed they have already seen. Buying one retry costs the whole blockhash window — **256 mainnet blocks, ~51 min** (§S35; the 393,168-block buffer this line used to cite is keyed on ArbSys numbers and can never serve an L1-numbered anchor).
- `proposeRoot` **requires** an anchored seed: without it the proposer would choose the sampled blocks themselves.
- Epoch bounds are deterministic on-chain (`GENESIS` + `EPOCH_LENGTH`), so nobody chooses where an epoch ends either.

### S13.b — Proposing has to be profitable

Proposing cost gas and only returned the bond. Nobody had a reason to do it, and the system rested on the goodwill of an operator — that is, on someone in particular.

`PROPOSER_BOUNTY = 0.01 ETH`, paid at finalisation on top of the bond, and to the winner in case of a dispute. It is funded by `FeeVault.DIST_GAS_BPS = 300`: 3 % of rewards go to the Distributor on each `harvest`, which also pays the delivery refunds. Taken from rewards, consistent with §S11 (dev is a fixed obligation, rewards absorbs operations).

The premium degrades without reverting if the reserve is empty: a missing premium must never prevent an epoch from being finalised.
### S13.c — Fix: inaction immobilised the stocks forever

`rollover` required `p.claimRoot != 0`. **An epoch nobody proposed had no exit path at all** — neither claim (no root) nor rollover. Same for a dispute the timelock never settles. That is precisely the trap §S7 forbids, and it was in the first version shipped.

Fix, one line:

```solidity
uint256 closesAt = p.finalized
    ? uint256(p.proposedAt) + CHALLENGE_WINDOW + CLAIM_DEADLINE
    : epochEnd(epoch) + STALL_DELAY;      // 30 days after the epoch ends
```

The "not finalised" branch covers both deadlock cases at once, and it depends only on the on-chain calendar — so it works even if absolutely nobody ever touched that epoch. Two tests prove it: `test_UnproposedEpochIsNeverStuck` and `test_UnresolvedDisputeIsNeverStuck`.

### What remains irreducible

The snapshot computation is off-chain, and that will not change while the token has no checkpoints. What is guaranteed, on the other hand:

- **the draw** is chosen by nobody (S13.a);
- **the computation** is deterministic and reproducible: two machines must produce the same root, with a CI test that checks it;
- **publication** is open to everyone and compensated (S13.b);
- **challenging** is open to everyone and paid for by the loser's bond;
- **distribution** is open to everyone and refunded;
- **total inaction** traps nothing: everything eventually carries over to the next epoch (S13.c).

The system cannot run *by itself*. It can run **without anyone in particular**, which is the property we were after.

---

## S14 — Eligibility threshold: by value, not as a percentage of supply

### The floor is waived rather than allowed to empty the tree

If **no** candidate clears the bar, the floor is dropped for that epoch and every
candidate goes into the tree. This is a liveness rule, not a generosity one:
`snapshot` treats an empty eligible set as fatal, and since the cumulative build
replays from epoch 0 and cannot skip a funded epoch, **one** such epoch would
stop every future root for good.

It is reachable at the very start. The keeper runs an epoch as soon as
`rewardsPool` passes `MAX_REFUND` (0.02 ETH); at `payoutBps = 400` that first
purchase is `(pool − 0.02) × 4 %` — under **0.0002 ETH**, i.e. below
`MIN_SHARE_WEI`, for any pool below 0.025 ETH.
The `START_BALANCE` cap then holds the bar at 0.1 % of supply, and if nobody has
bought that much yet, nobody is eligible.

Waiving costs nothing: it only widens who is *in the tree*. Who is worth an
actual delivery is a separate decision, taken by the push floor in
`buildCumulative`. The rule is deterministic, so `dispute.ts` replays it
identically, and `minBalance = 0` in the artifact makes it visible to anyone
checking.

The bar travels in the artifact for a second reason: the app shows a visitor
how many tokens they need to be in the next tree, and it must show the number
the keeper actually used. `CumulativeArtifact.epochs[].minBalance` sits inside
the canonically-serialised payload, so it is covered by the on-chain digest —
a gateway cannot serve a friendlier bar than the one that was applied
(`determinism.test.ts` check 10).


`docs/CONVENTIONS.md` planned "`MIN_BALANCE` (to be calibrated, e.g. 0.01 % of supply)". **A fixed threshold as a percentage of supply does the opposite of what is needed.** Computation, at 4 % rewards and a 24 h epoch:

| Volume / week | What 0.01 % of supply is worth |
|---|---|
| $50 k | **$0.029** — dust for everybody, the tree fills with useless leaves |
| $500 k | $0.286 |
| $2 M | $1.14 |
| $10 M | **$5.71** — excludes real holders |

At launch it is too permissive, later too restrictive. Exactly backwards.

### The rule

The threshold is expressed as the **value of the share**, not as a number of tokens, and its denominator is the **cumulative ETH since genesis**:

```
eligible if   balance / candidateSupply * ethCumulative  >=  MIN_SHARE_WEI
     <=>      balance >= MIN_SHARE_WEI * candidateSupply / ethCumulative

minBalance = min(START_BALANCE, MIN_SHARE_WEI * candidateSupply / ethCumulative)
```

`MIN_SHARE_WEI = 0.0002 ETH` (≈ $0.48), `START_BALANCE = 1,000,000 tokens`.

### Why the cumulative and not the epoch's ETH — correction

The first version divided by `quoteSpent`, the **current epoch's** ETH. That was right while an epoch lasted a day. With 30-minute epochs, one epoch only distributes a 48th of the day, so the required share of supply is mechanically 48x higher:

| Volume / day | Threshold per epoch (old) | Maximum eligible holders |
|---|---|---|
| $50 k | **1.145 %** of supply | 87 |
| $100 k | **0.573 %** | 174 |
| $500 k | 0.115 % | 873 |
| $1 M | 0.057 % | 1,746 |

And the exclusion was **permanent**: a holder below the threshold was below it in every epoch, so their cumulative stayed at zero forever. At $100 k/day you needed 0.573 % of supply to receive a single cent.

This is the fifth occurrence of the pattern described in §S17 — a constant calibrated at one scale, silently redefined by a change of epoch length. The comment in `config.ts` still proved it: it reasoned in "volume / **week**".

With the cumulative as the denominator, **the threshold no longer depends on how time is sliced**. Changing the epoch length no longer redefines who is owed what. That is check 7 in `eligibility.test.ts`.

### The start cap

At the very beginning, `ethCumulative` is tiny and the formula would demand tens of millions of tokens. `START_BALANCE` caps the threshold: **you need 1,000,000 tokens to be eligible**, i.e. 0.1 % of a 1 B supply, so at most 1,000 eligible holders on the first day.

The cap stops binding at `MIN_SHARE_WEI * candidateSupply / START_BALANCE`, after which the formula takes over and the threshold falls on its own, never rising again.

**That crossover scales with the CANDIDATE supply, not the total supply.** The pool, the bonding curve, `FeeVault`, `Distributor`, `0x0` and `excluded[]` are all out of the sum, so the 0.2 ETH below is the figure for a token entirely in holders' hands — never true at launch, when most of the supply is still in the curve:

    crossover = 0.2 ETH * candidateSupply / 1 B

With a tenth of the supply circulating the cap stops binding at **0.02 ETH**, and the threshold starts falling ten times sooner than the table suggests. That is correct rather than early: with a tenth of the supply circulating, a tenth of the balance is worth the same share. Read the table as a function of what circulates, never as a date.

| Cumulative ETH | Threshold (1 B CANDIDATE supply) | As % of candidate supply |
|---|---|---|
| 0.2 | 1,000,000 tokens | 0.1 % |
| 1 | 200,000 | 0.02 % |
| 5 | 40,000 | 0.004 % |
| 20 | 10,000 | 0.001 % |
| 100 | 2,000 | 0.0002 % |

Those five values are checked exactly by check 6 in `eligibility.test.ts` — if the behaviour drifts, the test fails.

### The crossover point is exactly the right one

A holder with balance `b` becomes eligible when `ethCumulative > MIN_SHARE_WEI * supply / b`. At that precise instant, what they **would** have accumulated since genesis is worth `b / supply * ethCumulative = MIN_SHARE_WEI`.

In other words: **they enter the tree exactly when their accumulated share would have reached the threshold.** The two formulations — "threshold on the balance" and "threshold on the cumulative" — coincide to the wei at the crossover point. So we get the semantics of carry-over without paying its cost: nothing sits dormant in the `Distributor` waiting for a holder to cross a threshold.

Time to the first payout, at a $0.48 threshold:

| Share of supply | $50 k/d | $100 k/d | $200 k/d | $500 k/d | $1 M/d |
|---|---|---|---|---|---|
| 0.001 % | 24 d | 12 d | 6.0 d | 2.4 d | 1.2 d |
| 0.01 % | 2.4 d | 1.2 d | 14 h | 5.7 h | 2.9 h |
| 0.05 % | 11.5 h | 5.7 h | 2.9 h | 1.1 h | 0.6 h |
| 0.1 % | 5.7 h | 2.9 h | 1.4 h | 0.6 h | 0.3 h |

### Why everything traces back on-chain

The trap would be making it a script parameter: a malicious proposer would choose a threshold that makes only themselves eligible. **Every quantity in the formula must be on-chain.**

`FeeVault` accumulates the ETH spent and passes it to `fund(epoch, stock, amount, quoteSpent)`. The Distributor exposes it as `epochQuoteSpent(epoch)`, and `quoteCumulativeUpTo` takes the prefix sum — values that are immutable once the epoch is closed, hence cached on disk. `MIN_SHARE_WEI` and `START_BALANCE` are published constants of the repository. A verifier replays the rule without having to ask us for anything. No oracle, no price.

### A single pass, no fixed point

The threshold depends on `candidateSupply`, which depends on who is kept: it is circular. Iterating would be tempting — dropping holders lowers the sum, which lowers the threshold, which lets some back in — **but it oscillates instead of converging**.

The computation is therefore done **in a single pass, against the sum of candidates before filtering**. Deterministic, slightly conservative, and trivial to replay. It is written in `offchain/src/eligibility.ts`, a pure function, with seven checks in `eligibility.test.ts`.

### What it changes for those dropped — option B, but temporary

Holders below the threshold **are not in that epoch's tree**. Their weight is redistributed to the holders above, who therefore receive more. That is an accepted departure from `docs/CONVENTIONS.md`, which said "their share is carried over (not burned)", and it still stands: there is **no** retroactive catch-up for the epochs spent below the threshold.

Reason: the tree. With carry-over, a token with 60,000 holders produces 60,000 leaves, the overwhelming majority of which are not worth their gas — it bloats the IPFS JSON, weighs down every proof, and leaves undistributable stocks dormant in the contract.

**What has changed is that the exclusion is no longer structural.** Before, a small holder was below the threshold in every epoch and stayed there indefinitely. Now the threshold falls as fees come in: it eventually drops below them, and they earn shares from that point on. What they lose is bounded by what they would have accumulated before the crossover — at most $0.48, by construction (see the crossover point above).

And a share once earned is earned for good: the threshold decides who earns a share in a given epoch, **never** who keeps what they already earned. Roots being cumulative (§S18), a holder who later falls below the threshold keeps their whole history and can claim it whenever they like.

### Not to be confused with the push threshold (§S2.a)

Two different thresholds, two roles:

| | §S14 — eligibility | §S2.a — push |
|---|---|---|
| Decides | who has an **entitlement** | who is **delivered to for free** |
| Below it | not in the tree, weight redistributed | in `claimRoot`, claimable at any time |
| Root involved | both | `pushRoot` only |
| Denominator | cumulative ETH, falling threshold | current gas price |

### Correcting the push threshold: 93,000 gas, not 40,000

The push threshold was `PUSH_K × TRANSFER_GAS × basefee` with `TRANSFER_GAS = 40,000` — the cost of an **ERC-20 transfer alone**. But settling one (holder, stock) pair costs more: verifying the Merkle proof, writing `claimedSoFar`, then transferring. **93,000 gas measured** (`docs/recon.md` §6).

The threshold was therefore 2.3x too low: we were airdropping shares worth 4.3x their delivery instead of the 10x intended. The constant is now called `SETTLE_GAS` — the name said "transfer" while the formula meant "full settlement", and it is that naming slip that let the error through.

Effect at the current gas price (0.4177 gwei, ETH at $2,386): the airdrop floor moves from **$0.40 to $0.93** per (holder, stock) pair. Below it, the share is not lost — it stays in `claimRoot`, claimable at any time.

---

## S15 — A smoothing reserve: not spending everything each cycle

**Problem.** `buyStocks` spent the whole rewards bucket on each call. Rewards were therefore as volatile as volume: one big day, then nothing for a week. But what keeps a holder is not the total amount — it is **regularity**. One flat week at zero, and there is no longer a reason to keep the token.
**Solution: pay out only a constant fraction of the reserve each cycle.**

```
spendable = (rewardsPool - MAX_REFUND) * payoutBps / 10_000     // 4 % per 30-minute epoch
```

Simulation, a $4,000 spike then dead calm (24 h epochs):

| day | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|
| spend everything | $4,000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **smoothed 25 %/day** | $1,000 | $750 | $563 | $422 | $316 | $237 | $178 | $133 |
| smoothed 10 %/day | $400 | $360 | $324 | $292 | $262 | $236 | $213 | $191 |

### What it does NOT do: withhold funds

This is the point that makes the mechanism acceptable. **In steady state, with a regular income `I` per epoch, the reserve converges to `I / rate` and the payout converges to `I`.** So we distribute 100 % of the revenue — the reserve only spreads it over time, it keeps none of it.

| Rate | Reserve in steady state | Half-life of one collection |
|---|---|---|
| 10 %/epoch | 10 days of income | 6.6 days |
| **25 %/epoch** | **4 days** | **2.4 days** |
| 50 %/epoch | 2 days | 1.0 day |

**That table assumes 24 h epochs. The rate only means something relative to the epoch length**, and the epoch moved to 1 h (§S12):

| Setting | Paid per day | Half-life | Left after a 48 h lull |
|---|---|---|---|
| 24 h @ 25 % | 25 % | 2.4 d | 56 % |
| 1 h @ 10 % | 92 % | 0.3 d | 0.6 % |
| 1 h @ 1 % | 21 % | 2.9 d | 62 % |
| **20 min @ 5 % (chosen)** | **97.5 %** | **4.5 h** | **0.06 %** |
| 20 min @ 0.33 % | 21 % | 2.9 d | 62 % |
| 1 h @ 0.5 % | 11 % | 5.8 d | 79 % |

**Chosen: 2 % per 30-minute epoch.** Comparison over three active days at $4,000/day, then four flat days, then a restart:

| Setting | D4 | D5 | D6 | D7 | Paid/day | Half-life | Left after 48 h |
|---|---|---|---|---|---|---|---|
| **2 %** | **$2,397** | **$909** | **$345** | **$131** | 62 % | 17.2 h | **14.4 %** |
| 3 % | $2,044 | $474 | $110 | $25 | 77 % | 11.4 h | 5.4 % |
| 5 % | $1,447 | $123 | $11 | $1 | 92 % | 6.8 h | 0.7 % |

2 % survives **three flat days** with payouts still visible, where 3 % dies on the second. The trade-off is a reserve of about one day of income instead of 0.7 — a little more money in transit, none withheld.

Adjustable by **a single timelock call**, with no redeployment: it is the parameter we will tune in the light of the first real cycles.

`MIN_PAYOUT_BPS` had to follow. It was 500, calibrated for 24 h epochs; at 1 h it would have become a disguised cap and **forbidden the 1 % setting**. Brought down to 10 bps, which still guarantees a half-life bounded at ~14 days at 30-minute epochs: the timelock sets the pace, it can never freeze.

### Two guards

**`payoutBps` is timelocked, but bounded.** A zero rate would immobilise the rewards forever — exactly the trap §S7 forbids. `MIN_PAYOUT_BPS = 10` (0.1 % per epoch) guarantees that at worst the reserve halves in ~14 days, even if nothing more comes in. The floor is deliberately low: at 48 epochs a day, a high floor would be a disguised cap forbidding the slow rates we want to be able to choose (§S17). **`MAX_PAYOUT_BPS = 1_000`** (10 % per epoch) closes the other side, added 2026-09-05: the previous cap was `BPS` itself, so a mistyped `10000` would have pushed the whole reserve through a single pool in one `runEpoch`, at 25x the size the `minOut` floor is calibrated for. The two bounds do not guard against the same thing — a rate set too low is undone 48 h later with nothing lost, a rate set too high is a swap that already happened. The timelock can set the pace, never freeze distribution, and it can in no case change where the funds go.

**`BUY_INTERVAL = 12 h`.** Without a minimum delay, anyone could call `buyStocks` in a loop on tiny slices just to collect the gas refunds. Twelve hours is below the epoch length, so it is never the binding constraint in normal operation.

### Interaction with the eligibility threshold (§S14)

The threshold depends on `quoteSpent`, which becomes far more stable thanks to the smoothing. A holder is therefore no longer eligible one day and dropped the next because of a volume lull. The two mechanisms reinforce each other.

---

## S16 — One epoch, one stock (weighted rotation)

> **Superseded on 2026-09-08 by [§S41](#s41--one-purchase-takes-the-whole-basket-and-a-skipped-leg-brings-nothing-down):** one purchase now buys the whole basket. Kept for its reasoning — it was right for the premise of a fixed one-hour epoch, and the registry made the epoch a per-vault parameter. `allocationOf` and `ROTATION_STRIDE` **were removed from `FeeVault` on 2026-09-09**: 1 322 bytes of runtime for a design nothing had called in months, and the vault was 1 576 bytes above the EIP-170 cap.

**Decided 2026-09-03.** `Allocation[10]` stays the basket's definition, but an epoch now buys **one single** stock. The basket is honoured by **rotation**, not by a grouped purchase.

### Why my recommendation in §S10 reversed

§S10 concluded "keep the grouped purchase". That was right **for its premise** — an epoch then lasted a week, and a full rotation would have taken 10 weeks: a three-week holder would only have received 3 stocks out of 10.

With one-hour epochs, **a full rotation takes 10 hours**. The variance disappears, and all the advantages of the model appear without its drawback. The right answer depended on the epoch length, not on the model.

### What it gains

| | 10 stocks / epoch | 1 stock / epoch |
|---|---|---|
| Swaps per epoch | 10 | **1** |
| Swap gas (1 h epochs) | 2.8 % of rewards | **0.28 %** |
| `try/catch` on swaps | indispensable | **unnecessary** |
| Merkle leaf | `uint256[10]` | **`uint256`** |
| Full rotation | — | 10 hours |

**The `try/catch` disappears.** It only existed because ten swaps shared one transaction and one failure must not take the other nine down. With a single swap, a failure simply reverts: the ETH stays in the vault and the next epoch buys another stock. Less code, and no partial-failure semantics left to reason about.

### The rotation

```solidity
function allocationOf(uint256 epoch) public view returns (uint256) {
    uint256 pos = (epoch * ROTATION_STRIDE) % BPS;   // STRIDE = 3001, coprime with 10,000
    uint256 acc;
    for (uint256 i; i < 10; ++i) {
        acc += allocations[i].bps;
        if (pos < acc) return i;
    }
    return 9;
}
```

The stride is coprime with 10,000, so the sequence visits every position before repeating. Verified by simulation:

- equal weights → cycle `0 3 6 9 2 5 8 1 4 7`, all 10 stocks in 10 epochs;
- over 10,000 epochs, each stock is drawn **exactly** its number of bps, including with unequal weights;
- **never two epochs in a row on the same stock** — where a plain `epoch % BPS` would chain the same one 1,000 times.

Entirely deterministic: anyone can check that the epoch bought the right stock.

### Correcting a figure I had presented badly

I announced "delivery: $0.40 → $0.04 per holder, −90 %". **That was a per-epoch comparison between epochs of different lengths** — and therefore misleading. The cost that matters is the daily one:

| Length | Epochs/day | Without aggregation | With per-stock aggregation |
|---|---|---|---|
| 24 h (10 stocks) | 1 | $0.40/holder/day | $0.40 |
| 1 h (1 stock) | 24 | **$0.96/holder/day** | **$0.40** |
| 20 min | 72 | $2.88 | $0.40 |
| 15 min | 96 | $3.84 | $0.40 |

Without aggregation, shortening the epoch **increases** the delivery cost linearly: a holder has one entitlement per epoch, hence one transfer per epoch.

**Per-stock aggregation therefore becomes indispensable** — and that is precisely what `SignedPot._settle` did, which I dismissed in §S10 saying "for us it merges nothing". That was true with ten stocks per epoch; with one stock per epoch and rotation, a holder accumulating 96 epochs has only **10 distinct stocks** to receive. Aggregation brings 96 transfers down to 10.

### How far down can we go?

| Length | Fixed costs (swap + 4 tx) | Bonds in flight | Minimum holding |
|---|---|---|---|
| 1 h | 0.5 % of rewards | 1.2 ETH | 1 h |
| 20 min | 1.5 % | 3.6 ETH | 20 min |
| 15 min | 2.0 % | 4.8 ETH | 15 min |

Fixed costs stay bearable down to 15 min. The two real constraints are elsewhere:

1. **Immobilised bonds** grow with the number of epochs in flight, which is itself set by the 24 h challenge window. At 15 min, 4.8 ETH sit idle permanently. Shortening the window is the only lever — and it is a security parameter.
2. **Minimum holding** falls to 15 minutes. At that point "hold to earn" no longer means much: you can enter, wait a quarter of an hour, and collect.

### Per-stock aggregation — implemented

`claimMany` and `distributeMany` settle several epochs in **one transfer per distinct stock**, not one per epoch.

That is what makes short epochs sustainable. An epoch buys only one stock, so a holder who lets a day run accumulates 24 claims — but the rotation only visits 10 stocks. By summing before sending, they pay **at most 10 transfers**, and that number **never grows again**, whatever the accumulated duration. A holder away for a month is served in 10 transfers, not 720.

Verified: `test_ClaimManyAggregatesByStock` settles 20 epochs across 2 stocks and counts the `Transfer` events actually received — **2 transfers**.

Two properties preserved:

- **An unsettleable epoch is skipped, not fatal to the batch.** Not finalised, expired, already served, invalid proof: we move on. A stale entry in a proof file must not cost the other 23.
- **A paused stock only fails its own epochs.** The transfers are made per stock, then only the epochs whose stock actually went out are marked served. The others stay claimable — the invariant from §S4 holds even in grouped settlement.

**CORRECTED IN §S18: this conclusion was wrong.** Aggregation merges the transfers, but each epoch owed still costs a proof verification and a write — 47,000 gas, measured. The real cost therefore grew linearly with the number of epochs. It is the cumulative model of §S18 that solves the problem. Going down to 20 or 15 min now costs only the fixed fees; the question becomes purely a product one (minimum holding) and a capital one (immobilised bonds).

---
## S18 — Cumulative roots: cost follows the stocks, no longer time

**The problem, measured.** With one root per epoch, each settlement paid a proof
verification **and** a write **per epoch owed**. Measured on the real contract:
**47,000 gas per epoch**. The per-stock aggregation of §S16 changed nothing — it
merges transfers, not verifications.

| Epoch length | Entries/day | Gas/holder/day | Cost | 1,000 holders vs rewards |
|---|---|---|---|---|
| 24 h (10 stocks) | 1 | 447 k | $0.45 | 16 % |
| 1 h | 24 | 1,528 k | $1.52 | **53 %** |
| 20 min | 72 | 3,784 k | $3.77 | **132 %** |

At 20 min, **gas exceeded the rewards**. Short epochs did not cost "fixed fees"
as I had written in §S16: they cost **linearly in the number of entitlements to
settle**.

### The correction

The leaf no longer carries `(epoch, holder, amount)` but
**`(holder, stock, cumulative since genesis)`**. The contract remembers
`claimedSoFar[holder][stock]` and only pays the difference.

```solidity
uint256 paid = claimedSoFar[account][stock];
if (cumulative <= paid) return 0;          // replaying an old proof pays nothing
uint256 owed = cumulative - paid;
uint256 remaining = totalFunded[stock] - totalDistributed[stock];
if (owed > remaining) owed = remaining;    // bounds the damage from an inflated root
```

One entry settles **as many epochs as you like**. The cost becomes proportional
to the number of **stocks**, never to elapsed time:

| Push cadence | Gas per push | Per holder per day | 1,000 holders vs rewards |
|---|---|---|---|
| daily | 650 k | $0.65 | 22.7 % |
| **weekly** | 650 k | **$0.09** | **3.2 %** |
| monthly | 650 k | $0.02 | 0.8 % |

**53 % → 3.2 %.** And above all: the delivery frequency **decouples** from the
epoch length. Pushing once a week costs exactly as much as pushing every hour —
that was the "can't we optimise the cost for whoever pushes" question. The answer
was not to optimise the push, it was to make it independent of the number of
epochs.

### Three properties that fall out for free

1. **Idempotence.** Replaying a proof pays nothing: the cumulative is already
   reached. No more need for a per-epoch `claimed` marker.
2. **Expiry expressible without a mechanism.** A root that **reduces** a
   cumulative simply pays zero — it does not underflow and takes back nothing
   already paid. Expiry policy becomes off-chain, contestable like the rest.
3. **No more `rollover`.** Unclaimed amounts no longer need to be "carried over":
   they stay in the contract, and the next root assigns them to whoever is
   entitled. An entire mechanism disappears.

### What it costs

- **Only one proposal in flight at a time.** Two concurrent cumulative roots on
  the same counters would be unmanageable, so the contract refuses the next one
  while the previous is neither finalised nor settled. A welcome side effect:
  **the capital immobilised in bonds no longer depends on the epoch length** —
  it is always one bond, where one root per epoch immobilised 72 of them at
  20 min.
- **The off-chain computation becomes cumulative.** `epochShares(epoch)` is
  cached on disk: a settled epoch never changes again, and recomputing it on
  every publication would make the cost quadratic in time. A verifier starting
  from zero replays everything — that is longer, but it is the price of
  verifiability, and it stays linear.

  Measured on a synthetic 500-holder history, since this is the one cost that
  grows forever and no rehearsal is long enough to surface it:

  | Horizon | Epochs | Per publication | Cache read |
  |---|---|---|---|
  | 1 month | 1,440 | 0.5 s | 47 MB |
  | 1 year | 17,520 | 5.5 s | 575 MB |
  | 3 years | 52,560 | 16.5 s | 1.7 GB |

  Against a 30-minute cycle, three years of history costs 0.9 % of one period.
  It holds, and no work is needed. Where it does bite is a **third party
  verifying from cold**: they have no cache and must replay `Transfer` logs over
  the whole history, which is minutes to hours rather than seconds. That is the
  real price of §S13's "anyone can recompute", and it is worth stating plainly
  rather than discovering.

  Two things were done about the keeper's side of it (2026-09-09), because the
  table above measures ONE token and the cost is per vault. First, the balances
  at the period's boundary are checkpointed to disk, so a replay starts there
  rather than at the launch block — that takes the token's AGE out of the cost,
  which is the column that grows forever. Second, one `eth_getLogs` walk serves
  every token in the round instead of one walk each: RPC pages are the budget,
  not the CPU. Neither touches what a verifier does — both live in `EPOCH_DIR`,
  which the counter-computation and `dispute.ts` start empty, so every published
  root is checked against a full replay on a second node. Cold verification
  still costs what the paragraph above says it costs.
- **The last finalised root stays claimable indefinitely.** If the project stops,
  anyone in it can still claim. Only a surplus funded *after* the last root would
  be left with no assignee.

---

## S19 — Measured costs of the cycle, and two corrections they revealed

Measurements on the real contract, on a fork (gas price 0.4177 gwei, ETH = $2,385.81):

| Operation | Gas | Cost |
|---|---|---|
| `runEpoch` (1 swap + TWAP floor + `fund`) | 676,697 | $0.674 |
| `anchorEpoch` | 24,926 | $0.025 |
| `revealSeed` | 25,720 | $0.026 |
| `proposeRoot` | 152,765 | $0.152 |
| `finalize` | 45,882 | $0.046 |
| `distribute`, **per stock** | 93,000 | $0.093 |

### Correction 1 — the proposer premium paid 190 times the real cost

`BOUNTY_BPS = 1 %` of the ETH covered had been calibrated when we published **one
root per epoch**. With cumulative roots, a single daily publication is enough: so
the premium paid **$28.57 a day for a transaction costing $0.15 of gas**.

Replaced by a **refund of the gas actually consumed** — measured inside
`proposeRoot`, stored, paid at finalisation, priced at the `block.basefee` the
caller does not choose — **plus a fixed premium** `PROPOSER_PREMIUM` of
0.001 ETH. Total: **~$1.37/day** instead of $28.57.

The fixed premium covers the off-chain work gas does not capture: replaying
transfers, computing the shares, publishing to IPFS. That is what lets a third
party take over. And a constant is appropriate **here**, contrary to the rule in
§S17: it is indexed on a *publication*, not on the epoch length — publishing
twice as often is twice as much work.

### Correction 2 — `anchorEpoch` and `revealSeed` were refunded by nobody

The keeper paid for them out of pocket: 72 × $0.051 = **$3.7/day**. Modest in
value, but it contradicted the guiding principle — a third party had **no reason**
to call the only two steps the calendar makes mandatory. They are now refunded
like the rest.

### What those corrections brought down: a blocking vector

Adding those refunds turned every test red on `TransferFailed` — because the
caller was a contract with no `receive()`.

That was not a test artefact. `_pay` **reverted** on failure, so:

- an `anchorEpoch` called from a contract with no `receive()` failed entirely;
- worse, **a proposer that was such a contract made `finalize` impossible
  forever** — the root could never be activated, and anyone could freeze the
  system by proposing from a contract that refuses ETH.

Fixed with the *pull over push* pattern: `_pay` attempts the payment with bounded
gas and, on failure, credits `pendingWithdrawal`, which the recipient withdraws
whenever they like. No payment can block an action any more, and nothing is lost.
`test_UnpayableProposerCannotBlockFinalize` locks the invariant down.

### The budget, in total

**Chosen: one-hour epochs**, one root and one airdrop per day.

| Item | 20 min (72/day) | **1 h (24/day, chosen)** |
|---|---|---|
| Epoch cycle | $52.19 — 1.83 % | **$17.40 — 0.61 %** |
| Root + premium | $2.57 | $2.57 |
| Swap fees + price impact | $4.43 | $4.43 |
| **Fixed** | **$59.23 — 2.07 %** | **$24.44 — 0.86 %** |
| Airdrop, per holder delivered | $1.14 | $1.14 |

The epoch cycle is the only item that depends on cadence, and it dominates: going
from 20 min to 1 h divides it by three and brings the fixed cost from **2.07 % to
0.86 %**. Since cumulative roots have already decoupled delivery from the epoch
length, shortening the epoch now only buys purchase responsiveness — not
distribution frequency.

Total cost at 1 h, with a daily airdrop:

| Holders delivered | Per day | % of rewards |
|---|---|---|
| 50 | $81 | **2.8 %** |
| 100 | $138 | **4.8 %** |
| 200 | $252 | 8.8 % |
| 300 | $366 | 12.8 % |

The `K = 10` threshold bounds the number of deliveries by itself: you need to
hold 0.32 % of the eligible supply for a stock to be worth its delivery, so **at
most 308 holders** can physically cross it.

---

## S20 — Immediacy: what the epoch length buys, and what it does not

**The purely financial analysis said 1 h; the product argument says shorter, and it counts.** Visible on-chain activity at regular intervals proves to holders that the system is running. That does not show up in gas, but it is no less real.

The price is modest: going from 1 h to 30 min costs **$17.40/day**, i.e. 0.44 % of rewards at $100 k of daily volume and **0.09 % at $500 k**.
**Chosen: 30 min** (48 epochs/day). That is half the overhead of 20 min for comparable visibility.

### But the epoch length only drives the purchases

Since cumulative roots (§S18), the **publication frequency** is independent of the epoch length — and it is that frequency which determines how quickly rewards become claimable.

| Root cadence | Cost/day | Rewards claimable within |
|---|---|---|
| 1 per day | $2.61 | 26 h |
| every 6 h | $10.46 | 8 h |
| **every 2 h** | **$31.37** | **4 h** |
| every hour | $62.74 | 3 h |

(including the 2 h challenge window — that is the incompressible floor)

**That is the real immediacy lever.** Shortening the epoch makes the *purchases* more frequent; shortening the root cadence makes the *rewards* available sooner. A holder feels the second far more.

And it is a **keeper policy, not a contract parameter**: adjustable at any moment, without redeployment.

### Configuration chosen

30-minute epochs, a root every 2 h:

| Volume/day | Fixed cost | % of rewards | + 50 holders delivered | + 100 holders |
|---|---|---|---|---|
| $50 k | $68 | 3.41 % | 6.3 % | 9.1 % |
| $100 k | $70 | 1.76 % | 3.2 % | 4.6 % |
| $200 k | $74 | 0.93 % | 1.6 % | 2.4 % |
| $500 k | $87 | 0.43 % | 0.7 % | 1.0 % |
| $1 M | $107 | 0.27 % | 0.4 % | 0.6 % |
| $5 M | $271 | 0.14 % | 0.2 % | 0.2 % |

The system stays within the 10 % budget from **~$50 k of daily volume** on.

---

## S21 — Choosing the stocks: depth beats the number of price sources

> **A basket is 2 to 8 lines, not ten** (`FeeVault.MIN_BASKET` / `MAX_BASKET`, each at least `MIN_ALLOC_BPS` = 1 000). This entry and the gas figures in §S9, §S11 and §S18 were measured on a ten-line basket, which is what the design carried at the time; they are kept as measured rather than rewritten. What a vault may actually hold today is `docs/allowlist.md` — 49 stocks liquid enough — and `$PAYD`'s own basket is six lines. **Noted 2026-09-11.**

Price-impact measurement for the ten stocks selected, **across all routes and all tiers**, for a 7 ETH swap:

| Stock | Impact | | Stock | Impact |
|---|---|---|---|---|
| QQQ | 0.019 % | | AMZN | 0.157 % |
| GLD | 0.027 % | | GME | 0.213 % |
| NVDA | 0.028 % | | AAPL | 0.252 % |
| USO | 0.057 % | | SPCX | 0.254 % |
| GOOGL | 0.136 % | | TSLA | 0.328 % |

### Three changes

1. **SPY → GLD.** SPY cost 0.345 % and its USDG pool is only $45 k — measured, it **blows up to 34 % impact at 20 ETH**. GLD costs 0.027 % on an $802 k pool.
2. **MSFT → USO.** 0.380 % against 0.057 %.
3. **GME moves from the 500 tier to the 10000 tier.** Better at both sizes (0.009 % against 0.022 % at 0.35 ETH; 0.213 % against 0.326 % at 7 ETH). **Raw TVL does not tell you where the liquidity is** — only a quote does.

Average basket impact: **0.223 % → 0.147 %**, i.e. −34 %, without changing a line of code.

### The accepted trade-off: GLD and USO have no Chainlink feed

Their `minOut` floor therefore rests on the TWAP alone. That is acceptable, and not out of laxity:

**At our swap sizes, depth protects better than a second price source.** Manipulating 30 minutes of TWAP on GLD's pool ($802 k) costs orders of magnitude more than what we trade there. SPY's pool ($45 k) was fragile *despite* its Chainlink feed — the feed does not protect against a bad fill, it only detects one after the fact.

Eight of the ten keep their feed and therefore their double source.

### A routing limitation, noted for later

At small sizes, SPY's best route was **direct WETH in the 500 tier**, not the USDG route. Our path is fixed at `WETH → USDG → stock`, so we cannot take it. No consequence for the current selection, but if a stock we wanted to add were only liquid directly against WETH, the path would have to become configurable in `Allocation`.

---

## What we take from FORM-4

To steal as is:
1. **The `STOCK_CODEHASH` gate.** Verified 2026-09-03: NVDA, SPY, AAPL, TSLA and SGOV all share `0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630`. One codehash comparison and the contract can never again buy anything but a real Robinhood stock. A BeaconProxy's runtime code does not change when the beacon is upgraded → the guard survives upgrades. (To be re-checked if Robinhood deploys a new series of tokens with a different proxy.)
2. **`snapshotBlock` on-chain** (S5).
3. **Skip-don't-revert in batches**, with a revert if *nothing* was paid — so that one stale proof does not cost the other 99.
4. **Credit carried over rather than burned** (`rolledOver`) — our "carried-over share", with the S7 fix.

Not to take: the absence of a challenge (S5), `oraclePaused` (S4), marking before transfer (S4), the flat gas rate (S8), and the closed push (S9).

---

## What is left for you to decide

None of these questions is technical — I do not choose them for you.

1. ~~S2.c~~ — **settled: deferred**, with a measurable trigger after 4 epochs (§S2.c).
2. ~~S2.a~~ — **settled: `K = 10`**, threshold outside the contract, adjustable with no redeployment (§S2.a).
3. ~~S2.b~~ — **settled: grouped delivery every 4 epochs, claim permanently open** (§S2.b), with the two roots of §S2.d.
4. ~~S3~~ — **revised: veto abandoned**, replaced by `minOut = max(caller, on-chain floor)` (§S3). **New open question: do we bring GLD / RDDT / HIMS back**, now that they are eligible again with a TWAP-only floor?
5. **S10**: `Allocation[10]` confirmed?
6. ~~`creatorTaxBps`~~ — **settled: 4 %**, i.e. 5.00 % paid by the trader and 4.70 % collected (§S11).
7. ~~Launchpad and `pairToken`~~ — **settled: Pons v2, `buybackEnabled = false`** (§S11). ~~`pairToken` = native ETH~~ — **revised 2026-09-08: one quote per vault, ETH or any listed currency** (§S40), because ETH-only left 59.1 % of Pons volume unreachable.
8. **Dev share**: an immutable address to a Safe (recommended), or timelock-modifiable?


---

## S17 — Any quantity coupled to the epoch length must be a bounded parameter

Three times in a row, a change of epoch length broke a constant that looked
harmless:

| Constant | Calibrated for | What it became |
|---|---|---|
| `PROPOSER_BOUNTY` (0.01 ETH) | 24 h | **20 % of rewards** at 1 h, ~$573/day in premiums |
| `BUY_INTERVAL` (12 h) | 24 h | **12x the epoch length**: epochs with no `quoteSpent` |
| `MIN_PAYOUT_BPS` (500) | 24 h | **a disguised cap** at 1 h — forbade the 1 % setting |
| `CHALLENGE_WINDOW` (24 h) | 24 h | **72 epochs in flight** at 20 min, 3.6 ETH of bonds locked |

The pattern is always the same: an absolute value frozen in the bytecode, while
its **meaning** is a ratio to the epoch length. It passes the tests, it only
becomes absurd on a change of scale, and nobody re-reads it.

**Rule applied from now on:** a quantity coupled to the epoch length is either
**proportional** (the premium is a % of the epoch's ETH), or a **bounded
constructor parameter** (`CHALLENGE_WINDOW` ∈ [1 h, 7 d]), or **removed**
(`BUY_INTERVAL` replaced by "an epoch buys only once"). Never a bare constant.

### The hidden cost of the challenge window

`epochsInFlight() = CHALLENGE_WINDOW / EPOCH_LENGTH` is exposed as a view,
because that is exactly what the pairing costs:

| Window (20-minute epochs) | Epochs in flight | Bonds locked | Delivery latency |
|---|---|---|---|
| 24 h | 72 | 3.60 ETH | 24 h |
| 6 h | 18 | 0.90 ETH | 6 h |
| **2 h (chosen)** | **6** | **0.30 ETH** | **2 h** |
| 1 h | 3 | 0.15 ETH | 1 h |

**Chosen: 2 h.** The 1 h floor exists because below it no third party would
materially have time to notice a wrong root and react — and optimism is only
worth that possibility. Two hours leave room for a `dispute.ts` running
continuously **plus** a human check, while dividing the immobilised capital by
twelve.

The last-resort guard stays `STALL_DELAY` (30 days): even if nobody is watching
and nothing is ever settled, the epoch carries over by itself.

---

## S22 — Root determinism, finally tested

The whole optimistic mechanism (§S18, §S20) rests on a property that was **tested nowhere**: two machines replaying the same epochs must produce the same root **and the same CID**. If they diverge, an honest verifier opens a groundless challenge and loses their bond — or concludes everything is fine while a fraudulent root is in flight.

### What the test found

`determinism.test.ts` feeds the same data to the pure layer in **different orders**. By sabotaging the sort in `build()` to check that the test can fail, it did fail — **but not where I expected**:
| | Order-sensitive? |
|---|---|
| `claimRoot` / `pushRoot` | **no** — `StandardMerkleTree` sorts leaves by hash internally |
| Proofs | no, for the same reason |
| **`canonicalJson` → CID** | **YES** |

The root was already safe. The **digest** was not — and it is that digest which is committed on-chain in `Root.digest` and against which holders check the JSON their proofs come from. (It was called `Root.cid` until 2026-09-05; it was never an address, and the name cost us a ceiling at 160 holders. See §S36.)

Two honest machines receiving the entries in different orders would therefore have published **the same roots and different digests**. A verifier comparing them would have read that as fraud.

### The fix

The sort existed, but in `buildCumulative`, upstream — hence **by convention**. `canonicalJson` now sorts by itself: a canonical form must not depend on its caller's discipline.

```ts
const byKey = [...a.entries].sort(/* (holder, stock) */);
```

### What makes the test worth having

Each sort is **mutation-tested**: remove it, check the test fails, put it back.

| Sabotage | Expected result | Observed |
|---|---|---|
| sort removed from `build()` | failure | `canonical serialisation depends on order (seed 1)` |
| sort removed from `canonicalJson()` | failure | `canonicalJson trusts its input's order (seed 3)` |

Check 5 additionally verifies that adding an entry **changes** the root — without it, the others would still pass if `build` returned a constant.

### Why not an end-to-end test

`buildCumulative` requires an RPC and deployed contracts: it would not run in CI. So we test the pure layer that produces the on-chain commitment, and the genuinely plausible class of bug — a `Map`'s iteration order follows insertion order, hence the RPC's response order, which nobody guarantees.

CI adds a guard the test cannot give itself: **two distinct processes**, output compared with a diff. That catches a dependency on object hash order, on a seed, on a locale, or on a cache path.

---

## S23 — An exclusion is dated, not live

Found while answering a session objection: *"the fact that anyone can execute the timelock is malicious too"*. The objection was about the **choice of moment**, and while checking which of the four powers was sensitive to it, the real defect appeared — elsewhere.

### The defect

`snapshot.ts` read `isExcluded[a]`, **the current state**:

```ts
const still = await client.readContract({ ..., functionName: "isExcluded", args: [a] });
if (still) excluded.add(a);        // ← what the state is NOW
```

The contract kept no history. So two honest verifiers replaying **the same epoch** on either side of a `setExcluded` got different sets → different `eligibleSupply` → **different roots**.

That is not a loss of funds — the artifact commits the set used, so the divergence is visible. But a good-faith verifier could challenge and **lose their 0.05 ETH bond** over a disagreement that is not fraud. And the comment above the function claimed exactly the opposite:

> *"if it were a config file, 'anyone can recompute the root' would be false"*

The intention was right. We had closed the **place** dimension — the list is on-chain, not in a file — and left the **time** dimension open.

### The fix

Every change is written into an append-only log, dated with the epoch it takes effect from:

```solidity
struct ExclusionChange { address account; bool state; uint48 fromEpoch; }

uint48 from = uint48(currentEpoch() + 1);
_exclusionLog.push(ExclusionChange({account: a, state: state, fromEpoch: from}));
```

**The current epoch is never rewritten**: at the time of the call, shares may already have been computed for it. And since the timelock announces the change 48 h in advance, shifting by one 30-minute epoch surprises nobody.

On the verifier side, `replayExclusions(log, epoch)` replays the log up to the target epoch. `isExcluded` stays exposed for a user interface, with the warning written in the code that it must **never** be used to build a root.

### What it settles beyond the bug

The executor's timing power disappears. Before, whoever chose the moment of execution chose which epochs the divergence fell between. Now the executor can only shift a change already public for 48 h by one epoch — and the result is the same for everybody.

### The two tests

| Test | What it locks down |
|---|---|
| `test_ExclusionIsDatedAndNeverRewritesThePast` | The current epoch is untouched; a reinstatement does not erase the excluded period; `fromEpoch` is increasing |
| `determinism.test.ts` check 7 | Adding **future** entries to the log changes **no** past set — exactly what happens when a `setExcluded` executes between two replays |

---

## S24 — The escape valve, and why it points at the Safe

### The hole

Verified on-chain against a real launch: **only the current `creatorFeeRecipient`** can initiate its own replacement.

```
transferCreatorFeeRecipient(token, new) — called from:
  the creatorFeeRecipient  ->  0x          passes
  the token's deployer     ->  0xb9f93944  rejected
  any address              ->  0xb9f93944  rejected
```

But we launch with `feeWallet = FEE_VAULT`. The recipient is therefore the vault — and the vault had no function to call that. **The creator fees would have been bound to it forever.** A bug inside it, a network change, a shift at Pons: the project died with the contract.

`recon.md` §1.3 said "the buffer calls `transferCreatorFeeRecipient`". That was true when the plan was *buffer = recipient*. Once we verified that the vault can be the direct recipient, that path closed without being noted.

### Why the Safe rather than a "FeeVault v2"

The first idea was to name a successor in advance through the timelock. It has a defect: **you have to choose the address before knowing the problem.** The Safe, by contrast, exists on day one.

And the right to transfer follows the recipient: once the Safe has become the `creatorFeeRecipient`, it can redirect in turn to a new keyless system, with no urgency.

Secondary benefit: **no extra power for the timelock**. The "nomination" version added a fourth one; this one adds none.

### The delay, and why it does not go below 3 days

```
48 h   our timelock            <- avoided: the Safe triggers directly
 3 d   the delay imposed by Pons <- constant 259,200 read in the factory's bytecode
```

The Safe calls `emergencyRedirect()` without going through the timelock — which would normally be unacceptable, except that **the destination is `DEPLOYER`, an immutable**. Even compromised, the Safe cannot point the fees anywhere else. It triggers, it does not choose.

**CORRECTED 2026-09-04: there is no delay, and no second step.** Every version
of this section said the redirect cost 3 days of Pons timelock plus a 3-day
execution window, and the vault carried a `finishRedirect()` to close it.

`transferCreatorFeeRecipient`, called by the CURRENT recipient — which is the
vault — applies **immediately**. The pending/timelock machinery belongs to
`setCreatorFeeRecipient`, which is `onlyOwner`. That is Pons's power over us, not
a constraint on us; see the risk below. `finishRedirect()` could therefore only
ever revert `NoPendingChange()` on our path, so it has been removed rather than
left as a footgun.

Proven end to end in `test_EmergencyRedirectIsInstant`: the recipient moves in
the same transaction, and fees generated afterwards are credited to the Safe.

### What it costs, said plainly

**During the redirect, the Safe is a custodian.** Revenue arrives on a multisig with no on-chain guarantee that it goes back to holders. That is exactly what the rest of the system avoids — hence the word emergency.

And the notice period in case of a compromised Safe falls from 5 to 3 days. That is the price of a fast response; it is accepted.

### What it does not save

The **future** flow, not present holdings. If the contracts work, nothing is lost: the old pair keeps draining cleanly and the stocks stay claimable forever. If the bug is *in* the contracts, what is inside them can be trapped.

That is an argument for not waiting: the longer we delay, the more accumulated ETH and stocks there are to abandon.

---

## S25 — A dress rehearsal of the deployment

`Deploy.s.sol` carried the final configuration — ten stock addresses, their pool tiers, their weights, their feeds — and **nothing checked it**. An error would only have shown up at deployment, or later.

`test/Deploy.t.sol` runs the script against the chain's real state and validates every line of the basket: the stock is a contract, its decimals are 18, there are no duplicates, the pool exists **at the stated tier** and carries liquidity, a configured feed answers with a positive price, and the weights sum to 10,000.

The three tests are mutation-tested:

| Mutation | Result |
|---|---|
| One weight changed from 500 to 501 | `weights do not sum to 10,000: 10001 != 10000`, and `BadWeights()` at deployment |
| NVDA pool tier 500 → 10000 | `allocation 0: pool with no liquidity` |
| One digit changed in an address | **does not compile** — Solidity checks the EIP-55 checksum |

The third case is instructive: the class of error we feared most — a transposed digit in an address — was already impossible. The compiler refuses it. What remained exposed was the **pool tier** and the **weights**, which are only numbers.

One test explicitly counts the stocks with no Chainlink feed and requires that there be **exactly two**: GLD and USO are a documented choice (§S20), not an oversight. A third one raises an alarm.

---

## S26 — Invariants: what the harness taught, more than the invariants themselves

The 81 example-based tests prove that the anticipated cases work. An invariant campaign looks for the cases **we did not anticipate**: it chains random calls and checks after each one that a property still holds.
### The four properties

| Invariant | What it forbids |
|---|---|
| `DistributedNeverExceedsFunded` | Paying someone with somebody else's stock |
| `StockBalanceCoversOutstanding` | Consistent accounting while the tokens have left |
| `ClaimedNeverDecreases` | Being paid twice — if `claimedSoFar` went backwards, the whole history would become claimable again (§S18) |
| `EthCoversPendingWithdrawals` | Promising more ETH in withdrawals than the contract holds |

A fifth, `AtMostOneRootInFlight`, went with the bond and the challenge window
(§S29): with no root ever in flight there is nothing left for it to forbid.

Against **real** Robinhood stock tokens, obtained by pranking an actual holder — writing their balance slot would be a disguised mock.

### Four times green without exercising anything

The harness was wrong four times in a row, and **each time all five invariants passed** across hundreds of calls:

| Harness defect | Effect |
|---|---|
| `setDistributor` was fuzzable | The fuzzer repointed the handler at a random address |
| The seed was never anchored | No root got through, so there was nothing to claim |
| A random challenge blocked the root | No finalisation at all: only the timelock arbitrates, and the handler did not |
| `claimIt` drew a random cumulative | It **never** matched the root: no claim ever succeeded |

**That is the most insidious failure mode of invariant fuzzing: a broken harness does not complain.** An entirely green suite, zero useful calls, zero violations — and false confidence.

### The two guards that caught it

**`afterInvariant`** counts the calls that actually succeeded and fails if the cycle was not traversed — funding, finalisation, claiming. It is not an invariant: Foundry evaluates invariants from setup onwards, before any call, so a coverage assertion there would always fail.

**Mutation testing** caught the fourth one, which coverage did not see. And it delivered a piece of information about the contract along the way:

| Mutation | Result |
|---|---|
| `remaining` cap removed from `_one` | **Not detected** — see below |
| `totalDistributed += owed * 3` | `distributed > funded: 2735722854 > 911920772` |

### What the first mutation revealed

Removing the `owed > remaining` cap does **not** break the accounting invariant, and that is a good sign: the contract only holds what was funded, so an over-claim fails at the **ERC-20 transfer**, `_tryTransfer` returns `false`, and nothing is recorded.

The cap is a **second line of defence**, not the only one. We did not know that before removing it.

---

## S27 — Adversarial security review: three real defects

A contradictory review, launched **after** Slither, the invariants and the mutation tests — so aimed at what those tools do not see: reasoning errors.

Five findings raised, **three confirmed in the code**, two requalified as product decisions. Each was verified line by line before being accepted.

### 1. A challenge could freeze distribution forever

`proposeRoot` imposes two constraints on the covered range:

```solidity
if (seedOf[upToEpoch] == bytes32(0)) revert NotAnchored();
if (activeRoot != 0 && upToEpoch <= roots[activeRoot].upToEpoch) revert BadInput();
```

**`challenge` imposed none**, and `resolve` copied the value as is: `r.upToEpoch = c.upToEpoch`.

A challenger winning with `upToEpoch = type(uint48).max` froze the active root at the maximum. Every future proposal then failed on the progression guard — **permanently**. Claims already covered stayed payable, but everything `runEpoch` would have funded afterwards was blocked with no recourse.

The timelock arbitrates on the correctness of the **root**; a challenger could supply a correct root with an absurd range and go unnoticed.

This is a **validation asymmetry between the honest path and the dispute path**. The challenger is no less suspect than the proposer — there was no reason to validate them less.

### 2. The honest challenger was compensated for someone else's effort

```solidity
_reward(rootId, winner, r.proposeGas);   // in resolve(), whoever won
```

When the challenger won, they were reimbursed against the **proposer's** measured gas. `challenge` captured no `g0` of its own.

Yet they are precisely the one to pay: **the entire security of the optimistic model rests on a watcher existing.** Under-compensating them undermines the only defence against a false root. `Challenge` now carries `challengeGas`, and `resolve` reimburses the winner for their own effort.

### 3. An unpayable `DEV` blocked `payDev` forever

`FeeVault._pay` reverted on failure. `DEV` is **immutable** and the contract deliberately has no owner: a `DEV` that became unable to receive ETH blocked `payDev` permanently, and `devPool` accumulated with no way out.

**This is the defect already fixed in `Distributor._pay`** — a proposer with no `receive()` froze `finalize` (§S17). The lesson had not been carried over to `FeeVault`. Pull-based withdrawal is now there too, with the same gas cap.

> A local fix is only worth something if it is propagated to every site of the same pattern. The first reflex after a fix should be to `grep` for the pattern, not for the symptom.

### Requalified as product decisions

**The bond is decoupled from the value at stake.** `BOND = 0.05 ether`, fixed, whatever the `Distributor` has accumulated. `finalize` checks nothing about the root's content — that is the very principle of the optimistic model. The protection is the window, not the bond, and it is only worth something if someone is watching. To be arbitrated: a proportional bond, or a guaranteed watcher.

**TWAP manipulation by the caller.** `runEpoch` is open and `minOut = 0` leaves the on-chain floor (TWAP −3 %) to decide alone. The attacker can be the caller: push the spot price, call, sell back. The gain is bounded to ~3 % of the epoch's spend, but it is repeatable. **Worse over the weekend**: the Chainlink equity feeds do not refresh, `_oracleOut` falls back to zero, and only the TWAP protects — at the moment the pool is thinnest.

### Three areas examined with no finding

`emergencyRedirect`, the gas refunds in a loop, and `Bootstrap`/`Timelock`. The reviewer said so plainly rather than padding.

### The test trap, seen a third time

The first three tests written to prove these fixes **failed**, and yet the contract was correct:

```solidity
vm.expectRevert(...);
vm.prank(challenger);
dist.challenge{value: dist.BOND()}(...);   // <- dist.BOND() is a CALL
```

`dist.BOND()` consumes both the `vm.prank` **and** the `vm.expectRevert`. It is the same trap already documented in `FeeVault.t.sol`. Every read is a call: hoist them before pranking. And `vm.prank` moves no funds — for a bond to actually leave the challenger, `hoax` is needed.

---

## S28 — Window aligned to the epoch: 30 min

**Session decision.** The window drops from 2 h to **30 min**, the length of one epoch, and the keeper publishes a root at the end of every epoch.

### What it gives

```
end of the epoch                       T
anchorEpoch                            +60 s at most   (the keeper loops every 60 s)
SEED_DELAY = 128 blocks                +12.9 s         (WRONG, see S35: +25 min 36 s)
revealSeed + proposeRoot               +60 s at most   (same tick, one after the other)
challenge window                       +30 min
claimable, or pushed by airdrop        ~T + 32 to 34 min
```

Against 3 h on average before.

**The root is published two to three minutes after the epoch ends, not thirty.** The only on-chain delay is `SEED_DELAY` — 128 blocks, i.e. **12.9 seconds** at the measured block time. **Both figures are wrong and §S35 corrects them**: those were 128 blocks of Ethereum, 25 min 36 s, so the root landed ~27 min after the epoch ended. `SEED_DELAY` is 16 since, i.e. 3 min 12 s and a root ~5 min after the epoch — close to what this line claimed, by measurement rather than by luck. The reasoning below stands, the number did not. All the rest is the keeper's granularity (60 s per tick, and `stepSeed` does the anchoring OR the reveal per tick, never both).

So **the latency is the window**: 30 min out of ~33. Shortening the keeper's tick or merging anchor and reveal would only gain two minutes — pointless while the window dominates.

### What it costs

48 roots a day instead of 12: **~$136/day** of premiums and gas ($2.39 of premium + $0.45 of gas per root). The cost is **regressive**:

| Volume/day | Rewards/day | Cost | Share of rewards |
|---|---|---|---|
| $50 k | $2,000 | $136 | **6.8 %** |
| $100 k | $4,000 | $136 | 3.4 % |
| $500 k | $20,000 | $136 | 0.7 % |
| $1 M | $40,000 | $136 | 0.3 % |

It stings at launch and becomes negligible afterwards. If the launch is slow, `PROPOSER_PREMIUM` is the lever — it accounts for 84 % of the cost per root.

### What it changes in the trust model — and it has to be said

`MIN_CHALLENGE_WINDOW` falls from 1 h to **15 min** to make 30 min legal.

**Below an hour, no human spots a false root.** Detection rests entirely on an automatic verifier running continuously. The system therefore becomes **more** dependent on a specific actor, not less — in direct tension with the "as few keys as possible" principle.

It is a trade-off deliberately made in favour of latency. It combines badly with the bond finding (§S27): `BOND` stays fixed at 0.05 ETH whatever the drainable amount, and the window protecting against a false root has just been divided by four. **The two should be settled together.**

The floor stays at 15 min rather than zero: below that, the verifier does not materially have time to replay the epochs, compare, and send its transaction.

### The keeper had nothing to change

It already proposes as soon as an epoch has its seed revealed and no proposal is in flight, and it finalises. The "2 h cadence" was only a sentence in the docs, never code. With a 30-minute window and 30-minute epochs, the loop is self-sustaining: root N is finalised before epoch N+1 ends.

---

## S29 — The keeper publishes, and the root takes effect immediately

**Session decision, and it changes the nature of the project.** The bond, the challenge window, `challenge`, `resolve` and `finalize` are removed. `publishRoot` is restricted to the keeper and its root applies within the second.

### What it gives
| | Before | After |
|---|---|---|
| Latency for the holder | ~33 min | **immediate** |
| Bond to post | up to 2 ETH | **none** |
| What the holder sees | a countdown | **nothing** |
| `Distributor` | 757 lines | **600** |

### What it costs, said bluntly

A compromised keeper key can publish a root that assigns itself everything that has not yet been distributed, per stock. The enforced ceiling is one line, `contracts/Distributor.sol`'s clamp in `_one`:

```solidity
uint256 remaining = totalFunded[stock] - totalDistributed[stock];
if (owed > remaining) owed = remaining;
```

**That figure is not "about one epoch", and the three rows that used to stand here said it was.** They read ~$42 / ~$83 / ~$417 a day at $50 k / $100 k / $500 k of volume, and they were derived from "deliveries run continuously, so there is only about one epoch in the contract". The premise is false, and the project's own push floor is what falsifies it: `offchain/src/epoch.ts` pushes an entry only once its outstanding value clears the floor — `PUSH_TARGET_WEI` (~$10) on an ether vault, 40 % of `MIN_BUY_QUOTE` (~$10) elsewhere — so **a holder under the floor is never pushed at all** and settles only by calling `claim` themselves. Each such holder carries up to one floor of entitlement indefinitely. The standing balance is therefore

```
undelivered  ≈  (holders below the push floor) × pushFloor  +  one window in flight
```

Measured rather than reasoned: `test/RootExposureInvariants.t.sol` runs an entirely honest cycle — windows funded, honest roots published, and only the entries `pushSet` selects pushed — and reaches a peak of **three windows in flight**, with 9 of the campaign's pushes falling under the floor. `docs/recon.md` §6 records a Pons token with **103 968 holders**, which is the scale the first term is read at.

**Why the clamp is not narrowed.** Nothing on-chain separates a thief's leaf from a dormant holder's: both are "an account owed a large amount of undelivered stock", and the entitlement the clamp would refuse a thief is the same entitlement it would refuse the holder. A per-root fraction was costed and rejected — 96 roots fit inside the 48 h the timelock needs to revoke a key, so a 1 % cap still reaches 62 % of the pot while throttling every honest dormant claim by the same 1 %. §S29's removal of the bond and the challenge window is what leaves no third mechanism, and that removal is the accepted trade (`docs/AUDIT_PLAN.md` §7.1). What changes here is the **published number**, which was wrong, not the design, which is declared.

**It is continuous pushing that bounds the blast radius, not a guard**, and it does so only down to the push floor. The number to watch is `quoteAtRisk` **as a ratio to one window's funding**, not in absolute terms: `offchain/src/check.ts` reads the last `WindowFunded` and warns above 8 windows, which is well clear of the honest peak of 3 and well under the pot a stalled keeper accumulates.

### The second key, added 2026-09-11

**What settled it is the order of two transactions.** A thief holding the keeper
key sends `publishRoot` and `claim` with consecutive nonces in the same block;
nothing in `claim` times anything. Detection cannot fit in that gap, and neither
can a freeze — so what closes it has to sit BEFORE the publication, which is
where the bond and the challenge window used to be and why removing them left
nothing there.

`Distributor.coSigner`, when named, makes `publishRoot` require an EIP-191
signature over `rootDigest(upToEpoch, claimRoot, pushRoot, digest)` — every field
of the root, plus the chain id and the Distributor's address, so a signature
travels to no other root, no other vault and no other chain.

**It is a second opinion, not a second secret.** `preflight.ts::crossCheck`
already rebuilds a root from a second node, but the keeper runs it on itself and
a compromised keeper does not run it. `offchain/src/cosign.ts` runs the same
recomputation behind a different key on a different host and signs only what it
reproduces. Holding both secrets is not enough: the two machines have to lie the
same way about a deterministic, publicly repeatable calculation.

**The deadman, and the naive version of it hands the attacker the door.**
Measuring the silence as "no root published" puts the clock under the control of
whoever holds the keeper key — publish nothing, wait, and the requirement lifts
itself. So the clock runs on a heartbeat the co-signer writes, and taking it down
is a second capability and a visible one.

`CO_SIGNER_GRACE` is **three hours, six epochs**. Removing the requirement
through the timelock is the other lever and it is 48 h — ninety-six epochs on a
protocol that promises stocks every thirty minutes, which is a failure and not a
degradation. Nothing is lost during a lapse either way: roots are cumulative and
the next one settles the whole gap.

**The veto has to be exercised to be kept.** The heartbeat covers a co-signer
that stops; it does not cover one that keeps beating and signs nothing, which
would block publication for the 48 h a removal takes — the failure the grace
exists to prevent, reintroduced by an adversary instead of an outage. So the
keeper puts the root on the record with `requestCoSignature`, and three hours
later the single-key form accepts that root and no other. The key is
`rootDigest`, so waiting out the grace buys the right to publish exactly what was
shown, and nothing else.

**Four things bound WHEN that clock may start, and until 2026-09-12 nothing did**
(`docs/AUDIT_FIXES_2.md` §1). The function constrained none of its arguments and
none of the contract's state, so a keeper could bank a lapsed request at a moment
when nobody was able to refuse it — no co-signer named, or one past the grace —
and spend it months later against a second key that was named, heartbeating and
in force. Measured: the whole undelivered balance, on one key. So: the epoch must
be closed, the co-signer must be in force, the request must postdate
`coSignerNamedAt`, and it may not be made in the block the key was named in.
Without them "slow and loud" was a property of the day the request was made and
not of the day of the theft.

**And the record is refusable, or it would be a door for the keeper too.** A
thief holding that key would otherwise post their forged root, wait three hours
and publish alone — against the forty-eight a rotation takes. `rejectCoSignature`
is the co-signer's, a refusal never ages into a lapse, and `cosign.ts` watches
the chain for requests rather than waiting to be asked, because a compromised
keeper does not ask. The cost is a hostile co-signer able to block until the
timelock removes it: 48 h of delay against 48 h of theft, and every refusal is
signed by its own key, so BLOCKING and DOWN are finally distinguishable.

What is left accepted: an attacker who holds the keeper key AND silences the
co-signer for three hours is back to the single-key case, with every monitor red
throughout.

### What remains as defence, and why

- **The seed stays anchored on-chain**, drawn from a future block. Even the keeper does not choose its sampling blocks: without that the snapshot would be manipulable **without even publishing a false root**.
- **`dispute.ts` changes nature.** It can no longer challenge — it produces a **reproducible public proof**. Anyone re-runs it without asking the operator for anything, everything it consumes is on-chain, and they reach the same verdict.
- **`claimedSoFar`** still forbids paying twice.
- **The timelock can rotate the keeper** in 48 h. That does not stop a theft in progress: it stops it from happening again.

### The covered range must always move forward

`publishRoot` refuses a root that does not go beyond the range in force. Without that guard, republishing the same range would allow **rewriting a root already applied**, hence redistributing an epoch already settled.

### What the keeper costs, measured

`publishRoot` is no longer refunded, and that is consistent: the refund existed so that a **third party** could propose without being out of pocket. With only our keeper publishing, refunding it would move money from the protocol's reserve to our wallet — accounting, not an incentive.

| Action | Gas | $/day | Refunded |
|---|---|---|---|
| `publishRoot` × 48 | 166,891 | **7.98** | no |
| `anchorEpoch` × 48 | 60,927 | 2.91 | yes |
| `revealSeed` × 48 | 39,760 | 1.90 | yes |
| `distribute` (2 stocks) | 208,828 | variable | yes |

**Net outflow from the keeper wallet: ~$8/day.** The rest is reimbursed with 20 % of margin — it fronts the cash, it does not burn it.

### The keeper is disposable

All its local state is a cache recomputable from the chain. Changing machine loses nothing, except **one thing**: the IPFS pins. If `IPFS_API_URL` points at a local kubo, the artifacts die with the machine and holders can no longer build their proofs.

With a pinning service, the keeper becomes entirely replaceable — that is what makes the Docker image useful rather than cosmetic.

### A refactor mistake, kept on the record

All four invariants failed with `runs: 0, calls: 0`: while shrinking the selector array I had not reindexed it, leaving one slot at zero. Foundry refused to start the campaign. I first blamed the coverage guard — it was a hole in an array.

`rotateKeeper` stays among the fuzzed actions: the fuzzer can take away the handler's ability to publish, and **the accounting invariants must hold even when nobody publishes any more**.

---

## S30 — The delivery threshold: a target and a floor

**Session request: ~$20 of value per airdrop, and 95 to 99 % for the holder depending on gas.** It was ~$10 until 2026-09-06; see "Doubled, and why the timing mattered" below.

```
pushFloor = max( PUSH_TARGET_WEI , PUSH_K_MIN × SETTLE_GAS × basefee )
                 ↑ the ~$20 target      ↑ the 95 % floor
```

**That formula is the ETHER vault's, and only its.** A vault quoted elsewhere
does not denominate its shares in wei — `quoteSpent` is what the vault SPENT, in
its own currency, and the name is V1's. Its floor is 40 % of `MIN_BUY_QUOTE`
— **about $10, the same value in a different currency** — with no gas term at
all: converting wei of gas into NVDA would need a price feed, and at $10 the
target carries the 95 % guarantee by itself up to $0.50 a delivery, 12× today's
cost, with the holder keeping 99.6 % now. See §S40, "What the currency costs,
and who pays it", for the two failure modes this replaced, and for why a ~$200
floor was tried first and withdrawn.

**And `PUSH_TARGET_WEI` itself came back down to $10 on 2026-09-11**, where it
sat before the 2026-09-06 doubling. Three things retired that doubling: the gas
it was defending against has fallen **56.7 %** (`ESTIMATIONS.md` §0); the 3 %
reserve was never close to binding, because a holder under the floor is not
delivered at all, so deliveries are bounded by `rewards / floor` and the reserve
is self-funding from **$1.34** — at $20 it was oversized fifteen times over; and
the wait is the product, since at $20 a 0.1 % holder of a token doing $50k a day
waited ten days to receive anything. $10 and not lower is chosen by the rule
already in `determinism.test.ts`: at normal gas a delivery must eat less than
1 % of what it carries, which $0.0927 does at $10 and does not at $5.

| Cost of one delivery | Threshold | The holder keeps |
|---|---|---|
| $0.09 *(measured gas)* | $20.00 | **99.5 %** |
| $0.25 | $20.00 | 98.8 % |
| $0.50 | $20.00 | 97.5 % |
| $1.00 | $20.00 | **95.0 %** ← crossover |
| $2.00 | **$40.00** | 95.0 % |

In normal operation the **target** drives. If gas spikes so far that $20 would no longer leave 95 %, the **floor** takes over: the threshold rises with gas rather than letting the holder's share fall.

Raising the threshold **withholds** nothing — the total distributed is identical, only the batch size changes. And `claim` stays open for whoever does not want to wait.

### The bug this request revealed

The threshold read the basefee at the **current block**:

```ts
const head = await client.getBlock();      // ← the INSTANT of the computation
const pushFloor = PUSH_K * SETTLE_GAS * head.baseFeePerGas;
```

Two verifiers ten minutes apart got different `pushRoot`s. **Same class as the exclusions bug (§S23)**: an input that varies with time, inside a computation that must be replayable.

And it became more serious under the keeper model: `dispute.ts` is now the **only** verification left. It would have reported a divergence on every run — nobody could have told fraud from noise any more.

The basefee is now read at the **last block of the covered epoch**. Fixed, replayable, independent of the moment.

### Doubled, and why the timing mattered

Raised to **~$20** on 2026-09-06, before the relaunch. What it buys, precisely:

- **half the deliveries** for the same value distributed, hence half the push gas. The 3 % reserve covers the pushes from **~$10k of daily volume** instead of ~$20k (§S31);
- the crossover where `PUSH_K_MIN` takes over moves from $0.50 to **$1.00 per delivery**, i.e. from 5.4x to 10.8x today's gas. More headroom before the holder's share is touched at all.

What it costs: a small holder crosses the bar **half as often**, so their automatic airdrop comes later. Nothing is withheld — the share keeps accruing, and `claim` stays open for whoever does not want to wait.

Note the premise it was asked on does not hold, and the number is fine anyway: at $10 the holder already kept **99.07 %**, not 95 %. The 5 % is the `PUSH_K_MIN` *guarantee*, not the operating point. At $20 the operating point is 99.54 %.

**It had to be done before the launch, or not at all.** `dispute.ts` recomputes an old root with the constant it finds in the source, so moving this makes every root published before the move recompute to a different `pushRoot` — an honest keeper reported as forged. That is the same failure mode as the `claimedSoFar` bug fixed the same day (§S36). Moving it after launch needs what the exclusion list already has (§S23): a dated log, replayed up to the covered epoch. A relaunch is a clean slate, so it was free today and will not be free tomorrow.

### The accepted limitation

`PUSH_TARGET_WEI` is denominated in **wei**, not in dollars: reading a USD price would require the historical state of a Chainlink feed, which the public RPC does not serve. The target therefore drifts with the ETH price — a published constant, to be readjusted if the price moves sharply.

---

## S31 — The cycle pays for itself

**Session goal: the keeper should cost nothing beyond the initial fees.**

### What was wrong

`PUSH_K` set **two things at once**, and nobody had noticed: what the holder **keeps** (`1 − 1/K`) and the share of gas the system has to **fund** (`1/K`).

At `PUSH_K = 10`, the contract allowed itself 10 % of gas when the reserve only took 3 %. A structural deficit, **growing with volume**: −$33/day at $50 k of daily volume, −$213/day at $500 k.

```
DIST_GAS_BPS  >=  10 000 / PUSH_K   (+ margin for the fixed cost)
```

Two constants chosen separately that did not talk to each other.

### The three corrections

**`publishRoot` is refunded** like the rest of the cycle. Without that the keeper's wallet burned ~$8/day, and "it runs by itself" became false after a few months.

**The threshold rises to ~$10** (§S30): gas now eats only 0.93 % instead of 10 %.

**The push cadence moves to 24 h.** The threshold bounds gas by the **value** distributed; a cadence bounds it by the **number of holders**. Taking the minimum of the two makes the cycle fundable everywhere.

### `distGasBps` stays at 3 %, but becomes adjustable

I had raised it to 6 % before adding the cadence and the $10 threshold. With them, the original 3 % is enough — **the goal is to reimburse the cycle, not to build up a pot.**

What really changes is that it is now **timelock-adjustable**, bounded `[3 %, 20 %]`. The right value depends on the holders/volume ratio, which we will only know after the launch: freezing it would have been the §S17 trap one more time.

### The result, measured

| Volume/day | Reserve (3 %) | Total cost | |
|---|---|---|---|
| $20 k | $24 | $20 | ok |
| $100 k | $120 | $50 | ok |
| $500 k | $600 | $198 | ok |

**Self-funding from ~$20 k of daily volume.** What stays on you: the deployment fees, the token launch, and the VPS.

### The cost is PER HOLDER, the revenue is PER VOLUME

That is the key to this whole section, and it is worth saying once clearly.

Delivering to a holder costs **$0.0927**, whatever the volume. The reserve's revenue, on the other hand, is 0.12 % of volume. A holder "pays for their own delivery" when they generate enough volume:

```
0.12 % × volume_per_holder  >=  $0.0927     ->  ~$77/day per holder at 24 h
```

So what binds is never volume alone, but the **holders/volume ratio** — many passive holders on little volume is the hard case. The $10 threshold corrects it: only holders who really accumulate are pushed, the others wait or claim.

### A refactor mistake, kept

Adding `distGasBps` as a state variable gave it **slot 0** and shifted the entire storage layout by one. `test_BuyAndBurnAfterGraduation`, which writes slots directly through `vm.store`, then failed on an incomprehensible `NothingToDo()`. The test now carries a warning: check `forge inspect FeeVault storageLayout` after any change to state.

---

## S32 — The preflight: refusing to publish rather than publishing wrongly

The contract cannot prove a root is correct, and since §S29 **nothing catches it after the fact**: it takes effect immediately and the stocks go out.

The only defence left is therefore **upstream**. The keeper runs a battery of checks it can conduct on its own, and blocks publication at the slightest doubt.

> **Publishing a doubtful root is far worse than publishing nothing.** Publishing nothing delays rewards by a few minutes; publishing wrongly misdirects stocks with no recourse.
### The five checks, and the failure each one targets

They target the failures that are **genuinely plausible here** — none is malicious, all produce a wrong root.

| Check | What it catches |
|---|---|
| **Conservation** | The sum of promised cumulatives exceeds what the Distributor received. Read **on-chain**, not derived from our own computation — otherwise the check would validate its own error |
| **Monotonicity** | A cumulative going backwards, or a holder **disappearing** from the tree |
| **Population** | The tree loses more than half its entries at once |
| **Provenance** | A stock present in the tree with no matching funding epoch |
| **Cross-check** | The whole root rebuilt from a second node with an empty cache — detailed below |

### Why conservation was not enough

The contract already protects itself: `_one` caps at `totalFunded - totalDistributed`. But it does so by **truncating silently** — the last to claim receive less, and nothing reports it. Detecting beforehand is better than truncating afterwards.

### The nasty case monotonicity catches

An RPC returning an incomplete page of logs makes holders **disappear**. They do not only lose their share: their weight is **redistributed to the others**, so the totals stay perfectly consistent and the error is invisible in the accounting.

Worse, the consequence is permanent. `claimedSoFar` would stay above the vanished holder's new cumulative: they would **never receive anything again**, even after a correction.

That is why monotonicity compares entry by entry against the previous root, and why a missing holder counts as a cumulative fallen to zero.

### The fifth check: the cross-check

The first four verify that the result **holds together**. This one verifies that we started from the **right state**: the root is rebuilt in full from a second node, and must be identical.

Two conditions, and both are indispensable:

| | Why |
|---|---|
| **A different RPC** | A node truncating a page of logs is the most likely and most silent failure |
| **An empty cache** | Without it the second pass would re-read the first one's files — it would agree with itself **by construction** |

Hence the choice of a **subprocess** rather than an injected client: fresh module state, no shared variable, no lingering in-memory cache. The result is comparable to what a third party would get.

```
RPC_URL=<second node>  EPOCH_DIR=<temporary directory>  node recompute.ts …
```

It runs **last** — it is by far the slowest, no point paying for it if a consistency check has already settled the matter. And a cross-check that **fails** is not a cross-check that **passes**: we block rather than publish blind.

Without `RPC_URL_FALLBACK` configured, the check skips cleanly — otherwise a keeper without a second node would never publish anything.

### What it still does not do

It does not prove the root. A computation that is wrong but consistent — one that conserves, progresses, covers everyone, and that **both nodes see identically** because the bug is in our code — would pass.

These checks catch **infrastructure and data failures**, not a logic regression nor deliberate malice. Against those, `dispute.ts` remains: anyone recomputes from the chain alone and publicly proves a divergence.

---

## S33 — `harvest` sweeps Pons itself, in both phases

**Found by a session question I had answered wrongly twice.** `recon.md` §1.7
claimed that after graduation only Pons's `feeSweepOperator` could push fees from
the v4 hook to the escrow. The hook is verified, and it says otherwise:

```solidity
bool isOperator = msg.sender == feeSweepOperator;
if (!isOperator && msg.sender != info.creator) revert NotFeeSweepOperator();
if (!isOperator && _requiresTrustedOperator(poolId, info)) revert InternalSwapRequiresOperator();
```

`info.creator` is the creator **fee recipient** — `setCreatorFeeRecipient` is
`onlyFactory` and writes that field — which is `FeeVault`. My differential test
had used the token's `deployer`, a different address on that token, and I
generalised its rejection into a rule.

**The real gate is the currency, not the caller.** Fees accrue in whichever token
the swap paid in. Anything pending in the memecoin needs an internal swap that
moves our own price, capped at `maxInternalPriceImpactBps = 300`, and Pons keeps
that for its operator. Anything pending in the quote token — native ETH for us —
needs no conversion, and we can sweep it ourselves.

`harvest()` therefore attempts the sweep before claiming:

```solidity
_sweepHookFees();                       // try/catch, never reverts the harvest
if (ESCROW.balanceOf(address(this)) == 0) revert NothingToDo();
gross = ESCROW.claim();
```

Both minimums are passed as 0, which does not breach the "never `minOut = 0`"
rule: they only bind a conversion, and a conversion cannot run on this path — the
hook refuses a non-operator caller *before* converting whenever anything is
pending in the memecoin. Reached there, there is nothing to convert and nothing
to price.

**The same mistake was in the pre-graduation path.** The bonding curve's
`sweepFees` accepts its `deployer` field — and that field holds the creator FEE
RECIPIENT too, not the launching wallet. Proven on a fork against a launch of our
own: from the launching EOA it reverts `NotFeeSweepOperator`, from the `FeeVault`
it credits the escrow. `recon.md` had said the sweep was "a transaction from the
buffer Safe", implying a two-mode runbook. There is no such thing: `harvest()`
sweeps for itself in both phases.

**What it changes.** Not "we depend on Pons" and not "we are independent":
opportunistic self-service with an operator fallback. Before graduation the curve
sweep has no currency gate at all, so it simply works. After graduation, the
memecoin buckets decide — after any operator sweep they are zero, and a stretch
of buys keeps them zero; in those windows a harvest collects in one transaction.
As soon as a sell lands, we wait for Pons as before.

**The rehearsal became a test.** `launchEnabled()` is true, so `test/Launch.t.sol`
launches a real token on the real factory and *is* its creator — no mock, and
free. It asserts we collect **exactly 4.70 % of a trade** on our own launch,
where `recon.md` §1.9 had only inferred that from other people's tokens; that
one assertion is the economic model, checked rather than derived.

It also found something the documentation had wrong twice over: measured on the
first seconds of a curve the rate reads **70.5 %**, because the snipe tax (99 %
decaying over 3 s) is paid to the creator. Harmless in production, fatal to a
measurement — the test warps past it deliberately.

**Two more tests, one of them nearly worthless.** `test_HarvestSurvivesAnImpossibleHookSweep`
binds the vault to a real graduated pool it does not own, so the hook genuinely
rejects the sweep, and asserts the harvest still claims in full. Removing the
`try/catch` makes it fail with `NotFeeSweepOperator` — mutation-checked.

`test_HookAcceptsTheCreatorFeeRecipient` proves the premise against live state,
and it was **vacuous when first written**: it asserted the revert was not
`0x71c4efed`, which is `SlippageExceeded`, not `NotFeeSweepOperator` (`0x8d42130c`).
It could never have failed. It now asserts the recipient hits the currency gate
and that an unrelated address is refused on access control.

> A test that names the wrong constant does not fail — it passes for free, and
> reads as evidence. Both selectors here were four bytes of hex I had copied from
> a trace and never re-derived.


## S36 — The digest is not the address, and confusing them capped us at 160 holders

`Root.cid` held `sha256(canonicalJson)`. For a file inside one IPFS block that
value IS the address — a raw CIDv1 is a codec prefix around exactly that hash —
so `publish.ts` and the front both DERIVED the address from it and never stored
the one the node reported.

Past 256 KiB, IPFS chunks the file into a DAG whose root hash is not the
content's. The derived address 404s. `publish.ts` fetches back to prove the
artifact is really retrievable, that fetch fails, and `keeper.ts` returns
**before `publishRoot`**. Not a degradation: roots stop being published, so
nobody can claim, permanently.

Measured with the real `canonicalJson`, 10 stocks per holder, 48 epochs:

| Holders | Entries | Bytes | x 256 KiB |
|---|---|---|---|
| 100 | 1,000 | 168,295 | 0.64 |
| **160** | 1,600 | **261,595** | **1.00** |
| 200 | 2,000 | 323,795 | 1.24 |
| 1,000 | 10,000 | 1,567,795 | 5.98 |

Two growth axes reach it independently, and bounding either does not save the
other. `entries` is one row per (holder, stock): O(holders x 10), over at ~160
holders. `epochs` accumulates every epoch since genesis at ~262 bytes each,
which is **12.6 KB a day whatever the holder count** — even a handful of holders
crosses one block in about three weeks.

**The fix, taken before deploying anything.** Digest and address are now two
fields with two jobs:

- `Root.digest` — `sha256(canonicalJson)`, in storage. The commitment. Anyone
  recomputes it, every fetch is checked against it, nothing else changed.
- `publishRoot`'s new `string calldata cid` — the address the node reported,
  **emitted in `RootPublished` and never stored**. Nothing on-chain reads it; a
  log byte costs 8 gas against an SSTORE's 20,000, and calldata is free on this
  chain (§10.7).

The front reads the log for the address and falls back to `cidFromSha256` when
logs are unavailable — still exact for a single-block artifact. `publish.ts`
keeps the CID the node returns instead of asserting its own, which also removes
the dependency on `raw-leaves` being honoured, and writes it beside the artifact
so `pruneArtifacts` still knows what to unpin.

**Verified end to end on 2026-09-05**, against a real Filebase bucket, with the
actual `publishEpoch`. A 43,760-byte artifact came back as `bafkrei…`, raw codec,
one block. A 634,660-byte one — 2.42 blocks, the case that used to halt the
system — came back as `bafybei…`, dag-pb, and was read back from a public gateway
in 1.3 s. Counter-check: the address the old code would have published for that
same artifact, `bafkreiewe4jdmi4fnpn…` derived from its digest, times out on both
gateways. The content is not there, and never was.

That run also settles the `raw-leaves` doubt Filebase's documentation left open:
it honours the flag below one block and chunks correctly above it. Since the fix
keeps whatever CID the node reports, the answer would not have mattered anyway —
which was the point.

The rejected alternative was `&chunker=size-N`, forcing one big raw block. It
needs no contract change and buys roughly 1-2 MiB — bitswap's transfer limit —
so it moves the wall from three weeks to a few months and leaves it standing.


## S37 — What a 30-minute epoch costs, and the one lever that does not touch it

Measured from `test/Costs.t.sol` at 0.4182 gwei, ETH at $2,455.22:

| Action, per epoch | gas + overhead | USD |
|---|---:|---:|
| `fund` (runEpoch) | 186,819 | 0.19 |
| `anchorEpoch` | 103,099 | 0.11 |
| `revealSeed` | 77,377 | 0.08 |
| `publishRoot` | 242,520 | 0.25 |
| **total** | **609,815** | **0.63** |

48 epochs a day is **$30.05/day, $10,970/year**. It is refunded — `MAX_REFUND`
is 0.02 ETH, 78x a single action, so the cap never binds — but the refund comes
from `distGasBps`, 3 % of rewards. So the system pays for itself only above
**~$25,000 of daily volume**. Below that the keeper funds the difference, and
below ~$4,300/day even the 14.89 % dev share cannot cover it.

**`publishRoot` is 40 % of it and the only one that need not run every epoch.**
Roots are cumulative and the contract asks only that the covered range move
forward, so one root can settle four epochs. `ROOT_INTERVAL_EPOCHS` in the
keeper does that, defaulting to 1:

| N | root every | gas/epoch | USD/day | self-funds at |
|---|---|---:|---:|---:|
| 1 | 30 min | 609,815 | 30.05 | $25,000/day |
| 4 | 2 h | 427,925 | 21.09 | $17,600/day |
| 12 | 6 h | 387,505 | 19.10 | $15,900/day |

Diminishing past N = 4, and it bottoms out at **$18.10/day**: `fund`,
`anchorEpoch` and `revealSeed` run every epoch because each epoch needs its own
seed and its own buy. **That floor is the price of a 30-minute epoch**, and only
`EPOCH_LENGTH` moves it — which is immutable after deployment, unlike this.

Raising N costs less than it looks. The accumulation people watch — the funded
epoch history, the per-stock totals — is read straight from the chain
(`epochFunded`, `totalFunded`) and keeps ticking every 30 minutes whatever N is.
The automatic airdrop follows `PUSH_INTERVAL_HOURS`, not this. What it delays is
how soon a holder can claim BY HAND, and one artifact-derived stat card.

Default 1 is deliberate: the cadence is a product decision, and the lever is
there to be pulled if volume disappoints, not before.

---

## S34 — ETH that is not fee revenue, and a refund that outgrew its epoch

Three changes to the vault, all found by asking one question the code had never
been asked: *what happens to a wei that does not come from Pons?*

### The vault could take ETH and never spend it

`receive()` accepted ETH and credited nothing. That is correct for the path it
was written for — it is also where `ESCROW.claim()` lands, and crediting there
would count a harvest twice, once in `receive` and once in the split that
follows. The consequence was never stated: **anything else arriving that way was
stuck for good.** `runEpoch` only ever spends `rewardsPool`, no `withdraw`
reaches unattributed ETH, and no owner exists to move it. A top-up before a
launch, a donation, a marketing wallet emptying itself into the vault: all of it
would have sat in the balance for ever, visible on the explorer and unusable.

`fundRewards()` closes it. It credits everything held that belongs to no bucket
— balance minus `rewardsPool`, `devPool` and `pendingTotal` — to `rewardsPool`,
which is where the epochs spend from:

```
cast send $FEE_VAULT "fundRewards()" --value 1ether --rpc-url $RPC_URL --private-key $KEY
```

Send-then-call works as well as calling with value; it measures the balance, not
`msg.value`. The keeper also runs it every tick when it sees free ETH, so a
plain transfer is put to work within a minute without anybody doing anything.

What a donation buys, precisely: it lands in the same reserve as fee revenue and
is spent at `payoutBps` per epoch — 4 % per 30 minutes, ~86 % of the reserve in
a day — on the epoch's stock, to the holders. **In full**: no dev share, no gas
cut. Both of those are fractions of a *harvest*, not of the reserve. It is
permissionless and moves nothing out of the contract; it only re-labels ETH that
is already there.

It doubles as the sweep for ETH arriving by a path nobody planned — a Pons
change, a router refund, a `selfdestruct`. Before, any of those was a permanent
loss.

### `pendingTotal`, in both contracts

Deferred payments and live funds share one balance, and nothing counted them.
Two consequences, one per contract:

- in `FeeVault`, `fundRewards` would have swept ETH already owed to somebody
  whose `receive()` failed into the rewards reserve — they would never have got
  it back;
- in `Distributor`, `_refund` capped itself at `address(this).balance`, so it
  could hand a third party ETH already owed to a deferred payee, whose
  `withdraw()` then reverted for want of funds. A debt the contract still
  acknowledged, backed by nothing.

`pendingTotal` is the running sum of `pendingWithdrawal`. Both contracts now
work on the free part of the balance. `invariant_EthCoversPendingWithdrawals`
was already asserting the property; nothing had ever driven it into the corner
where it broke.

### The refund could be larger than the epoch it refunded

`harvest` has always been bounded by what it collected — `if (refund >
toRewards) refund = toRewards`. `runEpoch` was bounded by the whole reserve.
That asymmetry is invisible at volume and inverts the trade below it: the
purchase is `payoutBps` of the reserve, the refund is a flat ~676,000 gas, so
under **~0.017 ETH of reserve an epoch handed its caller more than it bought for
the holders** — 48 times a day, in exactly the regime a launch starts in.

Two bounds now, one structural and one economic:

- the contract caps the refund at `amountIn`. Worst case the gas is half of what
  the epoch moves, never more. It never blocks: a caller who is not fully
  covered fronts the difference, as everywhere else (§S8);
- the keeper applies the same `1 - 1/K` rule it already applies to `payDev` and
  to the push floor, and skips an epoch whose purchase is worth less than five
  times its gas. Waiting costs the holders nothing — the reserve carries over
  and the next epoch buys more, with one gas bill instead of two.

`pendingEthSpent` went with the same pass. It had been written for a sweep that
no longer exists — `runEpoch` credits the Distributor in the same transaction —
and was two storage writes an epoch that nothing on-chain or off-chain ever
read.

---

## S35 — `block.number` is Ethereum's, and what that costs

`docs/recon.md` §10.6b established on 2026-09-06 that ArbOS answers
`block.number` and `blockhash` with **Ethereum mainnet** heights, not this
chain's. It recorded the fact. It did not follow it through the code, and three
things in this document were left saying the opposite of what production does.

**No fork test can catch this.** Foundry runs a plain EVM where `block.number`
is the forked chain's own height and `vm.roll` advances it, so every seed test
passes against a numbering that does not exist on the chain we deploy to. The
suite is green, and it is green about the wrong thing.

### 1. The latency is 25.6 minutes, not 12.9 seconds

§S28 computed `SEED_DELAY = 128 blocks` as **+12.9 s**, from a measured 0.101 s
block time, and concluded "the root is published two to three minutes after the
epoch ends". Those are 128 blocks of *this* chain. The contract commits 128
blocks of *Ethereum*, at 12 s each:

```
epoch ends                             T
anchorEpoch                            +60 s at most (keeper tick)
SEED_DELAY = 128 mainnet blocks        +25 min 36 s     <- not 12.9 s
revealSeed, then publishRoot           +60 s at most
claimable                              ~T + 27 min
```

Read off the live deployment on 2026-09-06 rather than derived: epoch 33 ended
at 17:00:00, its anchor targets mainnet block 25,919,189, and 14 minutes later
the chain was still 62 blocks short of it. The 32 anchors placed since genesis
are spaced 149.6 mainnet blocks apart for 1,800 s of epoch — **12.03 s per
block**, Ethereum's cadence to two decimals, over 16 hours.

So a holder's shares land about when the *next* epoch ends. Nothing is broken by
it — roots are cumulative and the chain simply runs one epoch behind — but
"immediate" (§S29) and "~2 min after their epoch ends" (`docs/CONVENTIONS.md`) were false,
and they are what the front end and the announcement promise.

### 2. The history contract could never have been reached

`_pastBlockhash` called `0x0000F908…2935` whenever `blockhash` returned zero,
and the comment above it promised a 393,168-block, ~11-hour window. That
contract is keyed on **ArbSys** (L2) numbers. Handed one of our L1-numbered
anchors it does not return zero — it **reverts**. Verified against the live
contract on 2026-09-06:

| call | result |
| :--- | :--- |
| `0x0000F908…2935(L1 height − 300)` | reverts |
| `0x0000F908…2935(L2 height − 1000)` | `0xda8f6495…` |
| `ArbSys.arbBlockHash(L2 height − 5)` | `0x69340929…` |
| `ArbSys.arbBlockHash(L2 height − 300)` | reverts, `InvalidBlockNumber` |

The fallback was removed rather than left in place. An unreachable fallback is
worse than none: it is the sentence above it, promising eleven hours of recovery
where there are **fifty-one minutes** (256 mainnet blocks), that a reader
believes. Fifty-one minutes is still comfortable — the keeper ticks every 60 s
— and past it `anchorEpoch` re-anchors, so an outage of any length still costs
time and never an epoch.

That last point is the one piece of the design the L1 numbering *improves*: 256
mainnet blocks is 51 minutes where 256 blocks of this chain would have been 26
seconds, which is why the mechanism has worked in production rather than
jamming on its first reveal.

### 3. The keeper compared two chains' clocks

`stepSeed` gated its reveal on `eth_blockNumber() <= seedBlock` — this chain's
height, ~56,000,000, against a mainnet-numbered target, ~25,900,000. The
comparison could never be true, so the guard never once stopped a call; what
actually held the mechanism together was the `revealSeed` simulation behind it.
The keeper now reads `block.number` the only way JSON-RPC allows — an `eth_call`
with no recipient running `NUMBER; MSTORE; RETURN` — and compares like with
like.

### What `SEED_DELAY` actually needs to be

It buys exactly one thing: that whoever anchors cannot already know the hash
they are committing to. An anchor is placed after its epoch has ended, so an
attacker who could see the target hash in advance would be free to pick their
moment among candidate seeds and choose the sampling that flatters the balances
they held. The margin required is therefore **how far behind mainnet ArbOS's
view runs** — nothing else.

Measured 2026-09-06, 200 samples over 235 s against a mainnet node:

| lag (mainnet head − `block.number`) | samples |
| ---: | ---: |
| 0 blocks | 32 |
| 1 block | 144 |
| 2 blocks | 24 |

Maximum 2 blocks, 24 seconds. And the 16 hours of production anchors above show
no stall beyond the keeper's own 60 s tick jitter. **128 is roughly 64x the
margin the measurement calls for**, and it was chosen when the constant was
believed to mean 12.9 seconds.

The trade is legible, and it is a decision rather than a calculation: every
block of delay is a block of margin against ArbOS's L1 clock stalling, and 12
seconds of latency for the holder.

| `SEED_DELAY` | on-chain delay | stall tolerated | claimable after epoch end |
| ---: | ---: | ---: | ---: |
| 128 (as deployed) | 25 min 36 s | 25 min | ~27 min |
| 32 | 6 min 24 s | 6 min | ~8 min |
| **16 (chosen)** | **3 min 12 s** | **3 min** | **~5 min** |
| 8 | 1 min 36 s | 1 min 30 s | ~3 min |

**Settled at 16**, on 2026-09-06, for the next deployment. Eight times the
measured margin rather than sixty-four, and it costs 22 minutes less on every
epoch of every holder. What the abandoned margin protected against is ArbOS's L1
clock stalling more than 3 minutes: an anchorer could then choose their moment
among seeds already public and pick the sampling that flatters balances they
already held — worth, at most, their share of one epoch. Nothing in 16 hours of
production anchors, nor in 200 samples, came within a tenth of that.

It is immutable once deployed, so it is settled at deployment or not at all —
which is why it had to be settled before the relaunch and not after.

---

## S38 — The time-weighted average, and the machinery it deletes

**Decided 2026-09-08, for the launchpad.** It overturns S13.a, S28 and S35, and
it makes S35's whole finding moot rather than merely fixing it.

### What the draw was for

A snapshot has to resist sniping: buy just before the balances are read, sell
just after, collect a share nobody held for. §S13.a answered with **8 blocks
drawn at random inside the epoch**, and the draw had to be unpredictable, which
cost:

- `anchorEpoch`, committing to a future block — **one transaction per epoch**;
- `revealSeed`, reading its hash — **a second one**;
- `SEED_DELAY` between the two, so nobody anchors on a hash they can already
  see;
- a dependency on `blockhash` and `block.number`, which on this chain are
  **Ethereum's** — the whole subject of §S35, a bug that cost 22 minutes of
  latency on every epoch and could only be found in production.

### What replaces it

The weight of a holder over epoch `e` is now

```
weight(h) = ∫ balance(h, t) dt   over  [GENESIS + e·L, GENESIS + (e+1)·L)
```

divided by `L` to give back an average balance in raw units — the unit every
downstream rule was already written against, so eligibility, the threshold and
the cumulative build are untouched.

**The window is two immutables and a subtraction. Nobody chooses it**, so
nothing has to be committed on-chain to prove that nobody chose it. The four
items above are deleted, not replaced. What is left is one comparison in
`publishRoot`: the epoch must be over.

### Why it is stronger, not merely cheaper

| | 8 blocks drawn | time-weighted |
| :--- | :--- | :--- |
| What a sniper must do | be present at 8 unknown instants | **hold, for real time** |
| Reward for one second of presence | up to ⅛ of a full share | ¹⁄₁₈₀₀ of a full share |
| On-chain transactions per epoch | 2 | **0** |
| Depends on `blockhash` / `block.number` | yes | no |
| Latency before a claim | `SEED_DELAY`, ~3 min | none |
| Reproducible by a third party | yes, via the on-chain seed | yes, with nothing to fetch |

The sampling did not merely cost more: it *paid* a sniper who happened to land
on a sampled block, at one eighth of a full share for an instant of holding. An
integral pays presence in proportion to its length, so the same attack collects
what it is worth — which is nothing.

### What it costs

The replay needs the **timestamp** of every block that carried a transfer inside
the period. Two measurements shaped the implementation:

- the RPC returns a `blockTimestamp` on every log and it **cannot be trusted**:
  2 441 of 2 537 logs carried `0x0` on 2026-09-08, the field being populated
  only for the last ~100 blocks. The non-zero ones were exact, which is what
  makes it dangerous — trusting it would silently truncate the weighting of
  everything older. So timestamps are fetched, batched in twenties, and cached
  by block number. The cache is a pure optimisation: a cold process computes
  the same numbers;
- weighting by **block count** instead of seconds was rejected. Blocks here are
  produced on demand, so busy stretches would weigh more than quiet ones — and
  anyone can make a stretch busy. Seconds cannot be manufactured.

Accrual is **lazy**: an account is settled when a transfer touches it, and
everyone once at the period's end. `O(transfers + holders)`, not
`O(blocks × holders)` — on a 100 ms chain a 30-minute epoch spans ~17 700
blocks, so the difference is not academic.

### Where it came from

Read in StockBoundRH (`web/lib/dividends/twab.ts`), a competing launchpad on
this same chain whose token rugged on 2026-09-07. The trust model is what failed
there — an operator-supplied `minOut` with an owner-settable swap route (see
`PLAN.md` §10) — not this, which is the one piece of it worth taking.

## S39 — `Collector`: settling N launches in one transaction, and the door it uses

A launchpad multiplies vaults, hence `Distributor`s. `claim` settles from
`msg.sender` and can reach only one of them: holding three Payd tokens meant
three signatures. `Collector.collect` makes it one.

**It is a router, it holds nothing.** The whole security argument rests on two
facts read in `Distributor`: `distribute(account, …)` sends the stock to
`account` **directly** — the tokens never pass through the Collector — and
`_refund` pays `msg.sender`, ETH immediately handed back to the caller. There is
nothing to steal, hence no allowlist of targets: a hostile address passed as a
"distributor" can only waste the gas of whoever passed it. An allowlist would
also have excluded $PAYD's vault, deployed by `Bootstrap` outside the registry.

**The reentrancy lock does not protect a balance, it protects a count.** A
hostile `Distributor` calling back during the loop would deliver **first**, and
the outer loop would find nothing left to deliver: `collect` would revert on
`NothingCollected` even though everything was delivered. Verified by mutation —
with the lock removed, the test fails exactly there.

### The door is not the same, and that is the trap

`claim` checks against `claimRoot`, `distribute` against **`pushRoot`**
(`Distributor._settle`, `viaClaimRoot ? … : …`). They are two different trees:
`pushRoot` contains only the shares large enough to deserve a pushed delivery
(§S30). A proof built on the wrong tree passes every check in the browser and
reverts on-chain with `InvalidProof` — a bug you only see by paying for the
transaction. So the front end builds `claimTree(entries.filter(push))` for that
path, and `front/src/merkle.test.ts` §6 requires that a `claim` proof does
**not** pass against `pushRoot`.

The honest consequence, shown in the page rather than left to a revert: a share
below the push threshold cannot be batched. It stays entirely claimable, from its
launch's own page, with `claim`.

In exchange, `distribute` refunds its gas and `claim` does not: going through the
Collector costs **less** than signing each launch separately.

---

## S40 — One currency per vault, and the pivot as a crossroads

**Decided on 2026-09-08, measured before being written.** v1 refused everything
that was not native ETH: `bind` tested `pairToken != address(0)` and stopped
there. Seven days of `V2FeeEscrow` credits, read on 2026-09-08:

| quote currency | share of Pons volume |
|---|---|
| native ETH | 40.9 % |
| USDG | 22.0 % |
| stock tokens | 37.2 % |

**Three fifths of the market were out of reach**, and not for a liquidity reason:
for one guard line.

### One currency per vault, written at birth

The Pons escrow keeps **one ledger per currency**. A vault claiming the wrong one
sees a zero balance while its fees pile up on a ledger it never reads — it binds
without complaint, displays the right token, then reverts `NothingToDo` on every
`harvest` and every purchase, forever.

Hence `FeeVault.QUOTE`, `address(0)` for native ETH, and **one per vault, for
life**. Every number in the contract — the three pools, the pending withdrawals,
`MIN_BUY_QUOTE` — is denominated in it: a vault that could change currency would
be a vault whose books mean two things at two moments. It is `bind` that refuses
it, and that is the only place it can be refused: a reverted transaction tells
the creator they made a mistake immediately; the other option never tells them at
all.

`MIN_BUY_QUOTE` comes from `Launchpad.quoteListing` and not from a constant,
because a constant in wei cannot serve three currencies: **0.01 ether of raw USDG
(6 decimals) is ten billion dollars**, and of raw NVDA about two dollars.

### The pivot is a parameter, not a constant

Everything routes through a single currency, `FeeVault.PIVOT` — USDG on this
chain, because that is where the stocks' liquidity is (`recon.md` §4.1). It is
called `PIVOT` and not `USDG` because it is a **parameter**: written at `init`
from the Launchpad's configuration, and a Launchpad deployed with another value
builds vaults that pivot elsewhere.

`ETH_PIVOT_FEE` — the WETH/PIVOT pool's tier — moved to the same side. It was
**the last tier constant on the money path**, so the only pool still welded into
the bytecode. The value does not change (100, the deep pool measured at 3 904
WETH / 6 006 840 USDG, `recon.md` §4.1); what changes is that it lives in storage
like `QUOTE_FEE` and like `Allocation.poolFee`.

`migrate` compares **currencies** and not pivots. A vault can therefore move to a
successor that pivots elsewhere, one at a time, under a 48 h timelock — migrating
the pivot is a per-launch operation, never a global switch.

### The pivot is a crossroads, not a wall

A currency can be deeply traded and **invisible against the pivot**. Measured on
2026-09-08 over the pairs Pons actually used:

| currency | pool against the pivot | pool against WETH | WETH depth |
|---|---|---|---|
| COIN | none | tier 3000 | $33 144 |
| cbBTC | none | tier 3000 | $158 774 |

Between them, **198 of the ~220 weekly credits** among the out-of-reach pairs. A
wall would have lost them; a crossroads serves them through
`QUOTE → WETH → PIVOT`, whose second hop is the pool every ETH-quoted vault
already uses — tier 100, $2 790 608 of depth.

**One route per vault, declared at birth, never guessed.** Exactly one of the two
tiers `QUOTE_FEE` / `QUOTE_WETH_FEE` is non-zero, and the Launchpad refuses to
list zero of them as it refuses to list two: neither, and there is no route;
both, and the contract would be choosing in place of whoever measured. It is
exactly the `Allocation.poolFee` rule (§S21) — the likeliest mistake is the right
token at the wrong tier, and you do not catch it by probing at the moment the
money moves.

### Two legs touch no pool

- **A pivot line** (USDG here) is already in the basket's currency. There is no
  pool of a token against itself: no floor to compute, nothing to protect, there
  is no price. It is the one line a BASKET accepts at tier 0 — the registry lists any line at zero since 2026-09-11, and `FeeVault._setAllocations` is what refuses the others — and
  the exception is **named** — any other stock at zero stays refused.
- **A line that IS the vault's currency** is set aside *before* the hop to the
  pivot, instead of being bought back afterwards. The round trip costs two pool
  fees and two slippages to end up in the same place: **0.10 % measured on
  NVDA/USDG at tier 500**, for no movement at all.

### What the currency costs, and who pays it

**A non-ETH vault takes no delivery budget, and pays its caller a bounty
instead of a refund.**

The first half has not changed and cannot: `_refundAmount` computes wei and the
`Distributor` spends wei, so a vault holding NVDA can neither refund gas nor
fund a delivery budget. Paying them in kind would mean pricing GAS in NVDA, i.e.
an ETH/QUOTE oracle on the money path, for a few cents of Orbit L2 gas. That
trade stays refused.

**What changed is that the refund stopped being priced in gas.** A bounty — a
share of what the call MOVED — is already denominated in `QUOTE`, so it needs no
price at all, and nothing on this path can be moved by one. `buyBasket` pays
`keeperBountyBps` of what it spent, out of `rewardsPool`, capped at
`MIN_BUY_QUOTE`; `harvest` pays the same rate on the gross it claimed, under
the residue cap it already had. Same pockets as the ether path, different
currency.

**The rate is a parameter, seeded at 25 bps, bounded in [10, 100].** The cost it
covers is mostly fixed per CALL while the bounty is a share of an AMOUNT, so no
constant covers the range: about 38 bps of the spend at $20k of daily volume,
15 bps at $500k, and under $5k a day the cost curve rests on an extrapolated
point rather than a measured one (§S31). The same argument `distGasBps` makes,
and the same remedy — timelock, bounded, read after the first epochs. It is
seeded low on purpose: paying under cost degrades to the keeper fronting the
difference, which is today's behaviour and is written down; paying over it takes
holders' money with nobody voting for it.

It is approximate by construction and bounded on both sides rather than made
exact: under ~$75 of purchase the caller still fronts the difference, over
`MIN_BUY_QUOTE` (~$25, the same order as `MAX_REFUND`) it is capped, and calling
at the `MIN_BUY_QUOTE` floor repeatedly earns less than the basket costs in gas.
`buyBasket` now holds `MIN_BUY_QUOTE` back on such a vault exactly as it holds
`MAX_REFUND` back on an ether one — without it the bounty would be paid out of
whatever the purchase left behind, which on a vault spending its whole reserve
is nothing.

**The delivery budget is the half that could not be fixed this way**: it is
wei, the `Distributor` cannot spend USDG on gas, and there is no bounty shape
for publishing a root because a root moves nothing. So the keeper fronts every
push on those vaults, and `keeperBountyBps` is what pays for them — seeded at
70 bps rather than 25 once the deliveries were on it.

**The floor is 40 % of `MIN_BUY_QUOTE`, about $10, and a ~$200 one was tried
first.** The argument for $200 was that unrefunded deliveries should be rare.
The arithmetic refused it: at a $10 floor the whole cycle costs **65 bps of
rewards** — 40 for the deliveries, 15–38 for the purchases — against the
**3.00 %** an ether vault already takes as `distGasBps` for the delivery service
alone. Four times cheaper than what the protocol charges its own ether holders
is not something to ration, and $200 meant only the largest holders ever
received anything: on a token doing $50k a day, a 0.1 % holder waited a hundred
days and a 0.01 % holder waited three years.

**There is no longer a reason for the two floors to differ**, which is why they
do not: how often a holder receives is a product decision, and the currency the
fees happened to arrive in is not a holder's concern.

Stopping the pushes outright was tried first and withdrawn within the hour, for
a reason that is not about cost. What a false root could award itself is
`Distributor.totalFunded(stock) - totalDistributed(stock)` — the clamp at
`contracts/Distributor.sol:544-545`, monitored in quote terms as `quoteAtRisk`.
Its bound is the sentence *"deliveries run continuously, so this stays on the
order of a single epoch"* — which `test/RootExposureInvariants.t.sol` (T-ROOT-02,
2026-09-11) measures at up to **three windows in flight**, so read it as an
order of magnitude and not as a ceiling. Stop the
deliveries and the bound goes with them — on exactly the vaults where the value
then accumulates untouched, and at the same moment `Payd.allowKeeper` widens who
may publish. The two together were not shippable.

**And the floor had to move currency before it could move height.** `quoteSpent`
is not in wei on those vaults: `FeeVault._buyLegs` derives it from `ethIn`,
which is what the vault SPENT, in its own currency — the name is V1's, from when
`QUOTE` was always ether. `pushSet` was therefore comparing raw QUOTE units
against a wei floor, and failing in opposite directions: on USDG (6 decimals) a
$1,000 share is 1e9 against a floor of 8.384e15, so **nothing was ever pushed**;
on NVDA (18 decimals) the floor worked out at **$1.89 instead of $20**, dust
delivered at a loss on a vault that refunds no gas. `MIN_BUY_QUOTE` is the fix
for the same reason it caps the bounty: it is about $25 in the quote's own raw
units, written at birth and never written again, so `dispute.ts` derives the
identical floor from the chain alone. Measured by
`test_ANonEthVaultPaysItsHarvestBountyInItsOwnCurrency`,
`test_ANonEthVaultPaysItsPurchaseBountyOutOfRewards` and
`test_TheNonEthReserveKeepsEnoughToPayItsCaller`.

---

## S41 — One purchase takes the whole basket, and a skipped leg brings nothing down

**Decided on 2026-09-08 (`PLAN.md` D8). It overturns §S16**, which was right for
its premise and not for this one.

§S16 bought **one stock per epoch** and honoured the weights by rotation. Its
argument rested on the epoch length: at one hour per epoch, a full rotation takes
ten hours and the variance disappears. The launchpad makes the epoch
**configurable from 30 minutes to 24 hours** — and at 24 hours, seeing the whole
basket go by takes **ten days**. A holder present for three hours receives
whatever the wheel drew while they held: the value is right, the composition is
noise.

### What the window shares

A purchase now covers a **window**: every epoch for which the `Distributor` has
not been funded, up to the last one finished.

| measured | |
|---|---|
| `runEpoch` (one leg) | 691 333 gas, ~$0.81 at the basefee of the moment (0.294 gwei) |
| five legs batched | ≈ 2.65 M gas against 3.46 M across five separate epochs |

D8 estimated **−23 %** from that batching alone. The shipped version goes lower,
because it also shares what D8 had not yet counted: the hop to the pivot
(**139 625 gas**, which every leg used to pay), that same pool's TWAP
(**69 389 gas**), the ETH/USD feed, the base transaction, the refund, and one
`fundWindow` instead of one `fund` per epoch. About **−60 % on a basket of five**
— and the per-leg `transfer` disappears as a bonus: the router delivers straight
to the `Distributor`, so the vault never touches a stock.

### The price paid, and it was announced

D8 said it: "a paused stock blocks the whole batch without a per-leg
`try/catch`". That is exactly what comes back. §S16 had been able to **remove**
the `try/catch` because a single swap per transaction made a revert harmless; a
window cannot.

So a leg that cannot be bought is **skipped**: its pivot stays in `pivotReserve`,
`LegSkipped` is emitted, and the next purchase spends it. A stock Robinhood
pauses costs a delay, never a loss, and never the other legs.

**And the bug it created, which is the exact opposite of the rule.** The arrays
passed to `fundWindow` are sized for the WHOLE basket, and a skipped leg does not
fill its slot. But `fundWindow` refuses a zero amount: passing them as they were
reverted **the whole purchase** as soon as a single leg gave way. So `_fund`
truncates them to the number of legs actually bought, and
`test_AFailedLegNoLongerTakesTheBasketDown` is what stops it coming back.

### What is left of §S16: nothing

`allocationOf(uint256)` and `ROTATION_STRIDE` **were removed on 2026-09-09**.
They were `public`, nothing called them any more, and this document said "kept
for the record".

What made them go was not elegance, it was a measurement. `FeeVault` weighed
**26 152 bytes of runtime, 1 576 above the EIP-170 cap** — that is, it was not
deployable on a chain that enforces the limit, and none of the 89 contracts read
on this one exceeds it. Enabling `via_ir` gave back 1 473; these two deaths,
another 1 322, taking it to 23 357 and 1 219 bytes of margin. **Measured again
on 2026-09-10, after the mode stamp: 23 699 runtime, 877 of margin.** The margin
is the number to re-read after any change to this contract, not the total.

The history stays here, in §S16's text above. It no longer costs the bytecode
anything.

---

## S42 — A listed line must have a pool that carries something

**Added on 2026-09-09.** The Launchpad's two lists — a basket's stocks, the quote
currencies — held by **measurement discipline** (`docs/allowlist.md`,
`script/MeasureRoutes.s.sol`) and by no guard at all. So the right stock could be
listed at the wrong tier, what `Listing`'s own comment calls "the likeliest
mistake". The vault then skipped the line **silently at every purchase**, its
share piling up in `pivotReserve`, for the whole of its life.

### Checking existence would have caught nothing

That is the point that makes the guard interesting rather than obvious. On this
chain, **all four** NVDA/USDG tiers exist, and `getPool` returns a non-zero
address on each:

| tier | `getPool` | liquidity |
|---|---|---|
| 500 | ✓ | 1.4e19 — the right one |
| 10000 | ✓ | **zero** |

A guard on existence would have let through exactly the mistake it claimed to
catch. So `_requirePool` requires the pool to **exist AND carry something**, and
it is applied to the route actually declared — **both** hops when it is §S40's
detour, because a detour whose second hop is missing is as dead as a direct route
with no pool.

### What it does not catch, and that has to be said

A tier that is merely **thinner than the best one**. NVDA's 100 and 3000 tiers
carry something, less well. Only the off-chain measurement says that — and
claiming otherwise would replace a discipline with the illusion of a guarantee.

### The cost, paid at the right moment

Since the seed of both lists lives in the Launchpad's constructor, a missing pool
reverts the **deployment**. That is the right moment to learn it: nothing exists
yet, and a re-read costs less than a vault with a dead line.

The `PIVOT` exception remains, and it is named: there is no pool of USDG against
itself, and demanding a tier there would be demanding a lie (§S40).

---

## S43 — The v4 leg: the route works, and the pools are empty

**Probed on 2026-09-09.** The question asked: can a large Robinhood Chain
memecoin go into a basket? Probe before code, like the rest.

**First result: no v3 pool anywhere.** On HASH, a graduated Pons memecoin, eight
`getPool` calls (USDG and WETH × four tiers) return eight `address(0)`. The
reason is structural and not circumstantial: a graduated Pons launch lands in a
Uniswap **v4** pool — PoolManager plus the meme hook, which `_poolKey` already
builds — whereas `_buyLegs` swaps through `ISwapRouter02`, which is v3. A
multi-hop `bytes path` route would change nothing: it describes v3 hops, and
there is no v3 hop to describe (`recon.md` §12).

**Second result: the v4 route executes.** `test/V4Leg.t.sol` runs the whole thing
against the real chain from a vault's position — $200 of pivot, one v3 hop at
tier 100, a `withdraw` to get native ETH back (v4 quotes these pools in ETH, not
in WETH), then `unlock`/`swap`/`settle`/`take` on the Pons hook's pool. Memecoins
arrive. Two swap engines in the same transaction, and it works. The v4 pool's
state is readable (`_pools`, slot 6 of the PoolManager), so its depth can be
computed with the v3 formula and a size cap is implementable.

**Third result, and it is the one that should decide.** A sample of the v4 pools
actually initialised over the last 20 000 blocks, quoted in native ETH
(`script/MeasureMemePools.s.sol`):

| | |
|---|---|
| pools measured | 44 |
| above $5 000 | **0** |
| the deepest | **$63** (SQUEEZE) |
| total depth of all 44 combined | $165 |

The threshold applied to **every other basket line** is $5 000. All 44 pools
combined do not reach 4 % of that threshold for **one** line. The 0.5 % cap that
makes a purchase honest gives $0.32 per purchase on the deeper of the two
graduated ones.

So the v4 leg is not blocked by a technical problem: it is blocked by there being
nothing to buy. Writing a second swap engine inside the contract that holds the
holders' money, with a v4 floor to design since v4 has no `observe()`, in order to
buy pennies at a time in a $31 pool, would be unexercised code on the money path
— the kind that breaks the day it is finally used.

**What the probe does not prove**, and the test says so: its spot price
computation is off by about 1e15. The floor assertion was **removed** rather than
kept — an assertion that passes because its expected value is a thousand billion
times too small is worse than no assertion.

`script/MeasureMemePools.s.sol` replays the question in one command the day the
pools fill up. **Decision not taken**: it is an extra swap engine on the money
path, and the measurable trigger is one memecoin pool above the $5 000 required
everywhere else.


---

## S44 — The timelock protects changes, not the initial state

> **Two notes before reading, both dated 2026-09-09.** The reasoning and
> Application 1 stand as written; the names and one conclusion moved under them.
>
> - **`Launchpad` is called `Payd`**, and `script/DeployLaunchpad.s.sol` is
>   `script/DeployPayd.s.sol`. The `_seed()` this section describes is
>   `DeployPayd._seed()` and does exactly what is claimed here. Mentions below
>   are left in the old name because that is what the section was written
>   against; the file pointers are updated, because a pointer nobody can follow
>   is not a record of anything.
> - **Application 2 was reversed.** `bindPlatformToken` — the one-argument,
>   Safe-callable version argued for below — **does not exist**. Any contract can
>   be the `creatorFeeRecipient` of a Pons launch, so a decoy token was enough to
>   redirect a third of the Treasury: "only the Safe, only once" bounded nothing
>   (`FLOWS.md` §10). Wiring the Treasury is now `approvePlatform` (the
>   generation Ledger) then `bindPlatform` (the timelock), on the `(token, vault)`
>   pair as one block. **That does not weaken this section's reasoning — it
>   narrows its scope**: the initial state needs no delay against the people who
>   wrote it, but it still needs a second key against the one who writes it
>   *wrong*, or writes it twice.

**Two decisions, on 2026-09-08 and 2026-09-09, and a single reasoning
underneath.** They remove the only two delays left on the launch path. Written
together because separating them would give two weak justifications where there
is only one, solid.

### The reasoning

A 48 h delay buys one thing and one thing only: **public notice to people who are
already in.** A basket reweighting lands under holders who already hold, a
changing allowlist lands under vaults that already buy — there, two days to read,
verify, and leave if you disagree, are worth their price.

At the first block, there is nobody. The deployer already chooses the timelock
itself, the Treasury, the keeper, `platformBps`, the two implementations every
vault will clone. **Asking them for 48 h of permission for a state they have just
written is asking permission of oneself** — and the notice is read by nobody,
since nobody is there yet to read it.

The corollary fits in one sentence, and it is what bounds this section's scope:
**what the delay protects stays protected for everything that comes after.**

### Application 1 — both allowlists are born with the platform

`Launchpad` takes a `Seed` in its constructor and writes the basket's stocks and
the quote currencies **in the deployment transaction**
(`DeployPayd._seed()` reads them back from `Allowlist.s.sol` and
`Quotelist.s.sol`). The seed goes through `_allowStocks` and `_allowQuotes`, the
**same** internal functions the vote uses: there is no one rule set for birth and
another for what follows, and a bad seed reverts the deployment.

What that removes: a 48 h window during which the platform is deployed, visible,
and **refusing every basket**. "Deployed" reads as "open" to anyone without the
runbook in front of them, and a platform that looks open and rejects everything is
worse than a platform not yet deployed.

`allowStocks`, `allowQuotes`, `removeStocks` and `removeQuotes` stay
`onlyTimelock`. And an empty seed stays valid — it is the Launchpad that only
opens at the first vote, measured by
`test_ADeployedLaunchpadListsNothingUntilTheTimelockSpeaks`.

### Application 2 — the Safe names the platform token without waiting

`Treasury.bindPlatformToken` was `onlyTimelock`. Chicken and egg: $PLAT is
launched **through** the platform, so its address does not exist when the
Treasury is deployed, and the function that names it afterwards was guarded like
any other change.

**What that cost, and application 1 made the bill worse.** With the platform now
opening at the first block, a third-party launch can feed the Treasury from day
one — while the burn, LP and rewards pockets fill up **without being able to
draw**. The original justification ("they are empty at the start") died with
application 1: it was no longer moot, it was a two-day deferral.

**Who the notice protected here: nobody.** The token it concerns is a few minutes
old. Its holders cannot vote against, only sell.

Hence a second caller, `OPENER` — **the Safe** — with no delay and **only once**.

### The three candidates, and why the Safe

| |  |
| :--- | :--- |
| **The deployer** | Refused. The runbook says of that key: "it has no power afterwards". Giving it one, permanently, over the revenue stream, takes back the sentence that makes the deployment harmless — and it is a hot key, alone, armed from deployment until the bind. |
| **`Bootstrap`, atomic** | The pure version: create the vault, launch on Pons, `bind`, `bindPlatformToken` in one transaction. Zero discretion, zero window. The price is that `Bootstrap` then carries the Pons launch parameters and sits on the evening's critical path — a bug there breaks everything at once. Kept in reserve, not chosen. |
| **The Safe** | **Chosen.** No new key, no new signer: it is already $PAYD's `LAUNCHER` on Pons, and the timelock's proposer and canceller. |

### The power that adds, said plainly

The function's checks require a **real** Pons launch and its **real** fee
recipient, so the Safe cannot point the pockets at an arbitrary address. But it
can point them at **somebody else's launch**: the burn would buy their token, the
LP would feed their pool, the rewards pocket would pay their holders.
Permanently.

That is a power the Safe has **nowhere else**: none of the timelock's functions
moves value. So it has to be written here rather than discovered in a diff.

### Correction of 2026-09-09 — the paragraph above was too lenient

It describes the risk as **bad targeting**: the Safe would point the pockets at
somebody else's launch. That was a way out.

`docs/recon.md` §1.2 establishes that **any contract can be the
`creatorFeeRecipient`** of a Pons launch. So the "real checks" asked for nothing
expensive: the Safe launches any token (price: the `launchFee`) with a six-line
contract exposing `fundRewards() payable {}` as its fee recipient, calls
`bindPlatformToken`, and `fundPlatformRewards` — **permissionless, callable by
anyone** — pays a third of everything that will ever enter the Treasury into that
contract. "Only once" bounds nothing when the first shot is the right one.

What was changed, and why it does not cost the evening:

- **the rewards pocket's destination is no longer an argument.** It is
  `Treasury.PLATFORM_VAULT`, an `immutable` written in the constructor. Nobody
  names it, neither the Safe nor the timelock. It holds the right vault at the
  first block, so `fundPlatformRewards` flows **before** any bind — which the old
  version made wait;
- **so $PAYD's vault is born before the Treasury.** The circularity is only
  apparent: that vault has `platformBps = 0`, it never pays the Treasury
  anything, and `init` only requires that field to be non-zero. The two addresses
  it needs are predicted from the deployer's nonce — the trick `Bootstrap`
  already plays one level down — and a final `require` checks the prediction
  (`script/DeployPayd.s.sol`);
- **`bindPlatformToken` now takes only one argument**, and decides nothing beyond
  what the burn buys and which pool the LP enters: two actions that act on a
  *price*, none that hands ETH to a chosen address. It stays immediate, reserved
  to the Safe or the timelock, and single-use;
- two locks on the token presented, and both are needed: its fees must **already**
  go to `PLATFORM_VAULT`, and it must have been launched by `OPENER`. The first
  alone would let through a third party's launch pointing at our vault; the
  second alone would let through the Safe's decoy.

The choice "the Safe rather than the deployer or `Bootstrap`" remains valid: what
was wrong was not who held the power, it was the size of the power. `FLOWS.md`
§10 keeps the account of it for an outside reader.

What bounds it, and it is the half that makes the trade acceptable:

- **a single call.** `AlreadyBound` shuts the door for good — the timelock
  included. The power **extinguishes itself in being used**, a few minutes after
  the launch, by the same signers who have just signed that launch;
- **the same checks.** There is no shortened version of the function, only a
  shortened wait;
- **the timelock path stays open alongside**, for the case where that key is lost
  or the launch is redone.

`test_TheSafeNamesThePlatformTokenWithoutTheDelayAndOnlyOnce` holds both halves —
the Safe meets the same refusal as a timelock on a bad vault, and after its call
nobody renames anything. **Verified by mutation**: the guard put back to
`onlyTimelock` makes the test fail.

### What this section does not say

No other guard moves. `setSplit`, `setAllocations`, `setPayoutBps`,
`setDistGasBps`, `setExcluded`, `setKeeper`, the four allowlist functions:
everything exercised **under people already in** keeps its 48 h, because that is
exactly where the notice serves.


---

## S45 — The way out was closing on its own generation

> **The defect below is real and still worth reading; the fix is gone.**
> `setSuccessor`, `recognised` and `MAX_SUCCESSOR_HOPS` were **deleted the same
> day**, hours later, by the `Payd` / `DistributionFactory` split. The chain of
> registries existed for exactly one reason — `VAULT_IMPL` was an `immutable` of
> the registry, so a new vault implementation forced a new registry — and the
> split removes that reason at the root: the implementations live in the
> **factory** now, `Payd.setFactory` points at a new one (generation key **and**
> 48 h), and the vaults that follow are born in the **same** registry. `migrate`
> asks OUR registry about the destination and nothing else — the line this
> section opens by calling defective, and it is correct there:
>
> ```solidity
> if (REGISTRY == address(0) || !IPayd(REGISTRY).isVault(newVault)) revert NotAVault();
> ```
>
> (The conditions `migrate` checks *after* that one have kept growing — read
> `FeeVault.migrate` for the current list. What this note is about is the hop
> that is gone, not the count of the checks that remain.)
>
> This is the pattern worth taking away, and it is why the section is kept rather
> than deleted: **the seven careful lines were the right answer to a question
> that should not have been asked.** A pointer nobody can verify, a hop cap, and
> a reassignable designation — all of it correct, all of it guarding a bridge
> between two registries that only had to exist because of where one `immutable`
> sat. Moving the `immutable` deleted the bridge. `contracts/DistributionFactory.sol`
> §"Why it was pulled out of `Payd`" and `contracts/FeeVault.sol:1473-1484`
> carry the same reasoning next to the code.

**Found on 2026-09-09, while answering a simple question**: "how do we know the
destination is a vault of our registry?" The answer fitted on one line, and it
hid a permanent failure.

### The defect

```solidity
// FeeVault.migrate, before
if (LAUNCHPAD == address(0) || !ILaunchpad(LAUNCHPAD).isVault(newVault)) revert NotAVault();
```

`LAUNCHPAD` is the address engraved in the vault at its birth, and `isVault` is
written in one place only — `Launchpad._create`. There exists no function to
record a vault from elsewhere in it.

But **a new implementation requires a new Launchpad**: `VAULT_IMPL` is an
`immutable` there, built by its constructor. New Launchpad, hence **new
register**. A v1 vault asks v1 whether the destination is one of ours; v1 has
never heard of v2 and answers no.

> The system's only way out led to a **sibling of the same generation**. A v1
> vault could change its basket or raise the holders' share, never join the
> version that replaces it.

**And it was unrepairable after the fact**, because the check lives in the v1
vault's code, frozen at its birth. No later change could open that door for it.
The window to fix it ran from now to the first deployment.

### The fix

A successor pointer on the `Launchpad`, and a walk that follows it:

```solidity
function recognised(address vault) public view returns (bool) {
    if (isVault[vault]) return true;
    address s = successor;
    for (uint256 i; i < MAX_SUCCESSOR_HOPS && s != address(0); ++i) {
        if (ILaunchpad(s).isVault(vault)) return true;
        s = ILaunchpad(s).successor();
    }
    return false;
}
```

Three choices in those seven lines, and each answers a way of getting it wrong:

|  |  |
| :--- | :--- |
| **Iterative, not recursive** | A chain that loops — v1 → v2 → v1 — would run until the gas ran out. Not a theft, but a `migrate` that no longer goes through. `MAX_SUCCESSOR_HOPS = 8` returns `false` instead of consuming. |
| **Each link asked about `isVault`, not about `recognised`** | Otherwise two Launchpads designating each other pass the question back and forth forever, and the cap protects nothing any more. |
| **Reassignable** | A wrong, permanent designation would shut the door for good: exactly the failure being removed. The timelock corrects it, in 48 h and in public, and the chain extends by itself when v3 arrives. |

### What it does not add

**No power of a new nature.** The timelock already triggers `migrate`, and the
five other conditions apply **identically** to a destination from another
generation: same token, same `LAUNCHER`, same `QUOTE`, `rewardsBps` greater than
or equal, `PLATFORM_BPS` less than or equal. The pointer lets an existing power
reach the next generation; it does not create a second one.

`test_TheNextGenerationObeysTheSameFiveConditions` holds that explicitly, because
it is the legitimate fear in opening this path: that "the registry next door"
becomes a back door where the guarantees fall away. They do not — it is the same
code that checks them, after the registry's answer and not before.

**Verified by mutation**: `recognised` reduced to `isVault`, and both new tests
fail.

### What `migrate` really adds — and the correction it cost me

I had first written here that the six conditions "look at neither the basket nor
the epoch length", as though that were a discovery about `migrate`. It is
accurate and it was badly framed: **for the basket, it is a smaller instance of a
power the timelock already exercises head-on.** `FeeVault.setAllocations` is
`onlyTimelock` on every vault — it is the first of the five lines
`Timelock.sol`'s header enumerates. Going through a migration to change a basket
would be a detour; one operation is enough.

The table nobody had written, and which answers the real question — **a creator
has left, the community takes the token back, who can do what?**

| what the community wants | who can, today |
| :--- | :--- |
| change the stocks and the weights | **the timelock, directly** — `setAllocations` |
| change the payout rhythm | **the timelock** — `setPayoutBps` |
| adjust the gas reserve | **the timelock** — `setDistGasBps` |
| exclude an address from the snapshot | **the timelock** — `setExcluded` |
| change the publication key | **the timelock** — `setKeeper` |
| change the **epoch length** | nobody without a migration — `EPOCH_LENGTH` is written at `init` and has no setter |
| change the **implementation** | migration |

So an abandoned launch is not frozen: it goes on harvesting, buying and
distributing, and **everything that can be settled is settled without its
creator**. The only two things `migrate` adds to what the timelock can already do
are the **cadence** and the **code**.

### The design consequence, written down so as not to start it over

The idea considered — **the creator proposes a destination, the timelock
validates** — is good in the abstract: two keys, neither of which is enough. It is
**set aside**, and not for a cost reason:

1. it would close almost nothing. The power it targets, changing what the holders
   receive, already goes through `setAllocations`;
2. it would reopen the failure that justified `migrate`: a creator who has
   vanished — half the launches on a launchpad — would make any repair
   impossible, since nobody is left to propose.

What it would really bound comes down to the cadence and the implementation, at
the price of the repair path. A bad trade, and it had to be measured to be seen.

---

## S46 — One payout mode is one factory, and the stamp that keeps them apart

**Decided on 2026-09-10, and written before it was needed** — which is the whole
argument, so it goes first.

Today the platform has exactly one product: fees become a basket of stocks and
holders are paid pro rata. `DistributionFactory` builds it, `Payd` registers it, and
`migrate` moves a vault to a newer version of it. A second product — pay in one
currency, pay on a schedule, pay only above a threshold, whatever it turns out
to be — is a different `FeeVault`, hence a different factory.

### The defect this closes, before it exists

`FeeVault.migrate` asked one question of the registry: `isVault(newVault)`. It is
unforgeable — written by `Payd._create` and by nothing else — and it answers
*"was this born here?"*. It does **not** answer *"does this pay the way I pay?"*.

While one factory exists those are the same question. The day a second one is
admitted they come apart, and the gap is one timelock operation wide: `migrate`
would accept a destination of another mode, and the holders of a pro-rata stream
would find themselves in a product they never bought. Every other condition would
be satisfied — same token, same `LAUNCHER`, same `QUOTE`, `rewardsBps` no worse,
`PLATFORM_BPS` no worse — because none of them is about the *shape* of the
payout.

**And it would have been unfixable afterwards.** The check lives in the vault,
and a vault's code is fixed at birth. Every vault already registered when the
second mode arrives would carry the version that does not compare modes; the only
way to give them the check would be to migrate them, using the very function that
lacks it. `Payd` is the one contract that cannot be replaced without stranding
`migrate` for every vault in it — so the field it reads had to be there first.
That is the same shape as [§S44](#s44--the-timelock-protects-changes-not-the-initial-state)
seen from the other side: what the initial state gets wrong, no delay repairs.

### The three pieces

| | |
| :--- | :--- |
| **`DistributionFactory.MODE`** | `bytes32 public constant MODE = "distribution"`. The factory **declares** what it builds instead of the registry guessing. |
| **`Payd.factoryMode`** | every admitted factory and its mode. Read off the factory once, when it is admitted, and never again — so a creation pays a warm `SLOAD` rather than an external call, and a factory that declares nothing is refused on the spot (`BadMode`) instead of bricking every launch that follows. |
| **`Payd.modeOf`** | stamped on each vault at birth, in `_create`. Zero for an address this registry never built, which is what makes the check in `migrate` **fail closed**. |

**A name, not an address.** Comparing the factories that built two vaults would
forbid exactly the migration this system exists to allow: a new version of the
same mode *is* a new factory — that is the entire upgrade path since the `Payd` /
`DistributionFactory` split ([§S45](#s45--the-way-out-was-closing-on-its-own-generation)).
What has to match is what the two vaults **promise**, not which deployment made
them.

### `Payd` became an interface over factories, and that is the real change

`factory` is now only the **default** — what `createVault` and
`createVaultQuoted` build through, unchanged for every existing caller.
`enableFactory` admits one without moving the default, and `createVaultWith`
lets a launcher name any admitted one. `createVaultFor` names one too: it is the
timelock's, it exists to give a migration a destination, and being wired to the
default put every vault of a secondary mode out of its reach.

### And the registry stopped validating what it does not own

Three things left `Payd` on 2026-09-11, and the same sentence explains all three:
a registry that is an interface over factories must not hold one mode's
parameters.

| | |
| :--- | :--- |
| **the epoch bounds** | `MIN_EPOCH_LENGTH` / `MAX_EPOCH_LENGTH` are a `Distributor` cadence. They live in `DistributionFactory` now; a mode without epochs never reads the argument |
| **the empty basket** | a basket is the distribution mode's parameter. Requiring one forced every future mode to be handed a stock it would never buy. `_checkBasket` still holds a basket that IS presented to the allowlist — that list is governance's — and the distribution mode still refuses an empty one, one step later, in `FeeVault.init` where `MIN_BASKET` lives |
| **`bytes modeData`** | the scope that had no home. Platform-wide values are the registry's immutables and per-MODE values are the factory's; the value a LAUNCHER chooses, and that differs from one launch to the next, had nowhere to go. Putting it in the factory would mean one factory per value, hence one `MODE` per value — and `migrate` compares modes, so two launches of the same product would stop being migratable into each other. `Payd` forwards it and never decodes it; a mode with none REFUSES a non-empty value rather than ignoring it |

`Payd.factory` is typed `IVaultFactory` and no longer `DistributionFactory`: the
registry must not speak one mode's type. What it still enforces is short and
deliberate — the quote allowlist, the 15 % platform cap, and the `isVault` /
`modeOf` stamps.

`createVaultWith` is **permissionless and adds no power**. The only addresses it
can reach are already in `factoryMode`, which takes the generation key *and* the
timelock to write. What a launcher chooses is which admitted mode they launch
under — never what code runs.

`disableFactory` is one key rather than two, because it removes a capability
instead of granting one. It is not decorative: revoking `approved` does not reach
backwards into `factoryMode`, so without it an admitted factory would go on
minting registered vaults long after the generation key had changed its mind. It
cannot be aimed at the default, which would leave `createVault` calling a factory
the registry has disowned.

### The door between modes, and why the cold key holds it

`migrate` refuses a cross-mode destination. One thing lifts that refusal:
`Payd.crossModeMigration`, **`false` from birth** — no constructor argument, no
wiring field, nothing to get wrong on deployment night — and only the **generation
key** moves it.

That placement is the point. Flipping it moves nothing and migrates nothing: it
lets the timelock *schedule* a cross-mode migration that must still clear 48 h
and still satisfy every other condition. So the property the system has
everywhere else holds here too — **the cold key authorises and never acts, the
timelock acts and cannot authorise itself** — and one compromised key, either
one, moves no holder into a promise they did not buy. It is the same division as
`approve` / `setFactory`, applied to a different door.

The alternative considered was giving it to the timelock alone. It fails on the
count that matters: the timelock already holds `migrate`, so the switch and the
action would sit in one hand and the second key would be decorative.

### What it deliberately does not do

**It is global while it is open.** For as long as `crossModeMigration` is `true`,
every vault in the registry is one timelock operation away from a cross-mode
destination — not just the one being moved. It is meant to be opened for a single
migration and shut after it, and **nothing in the contract enforces that
discipline**; shutting it is the same call with `false`, effective at once, with
nothing to wait out.

Making it self-closing was rejected, and the reason is worth keeping: it would
mean letting a **vault** write into the registry. That is a door of its own, open
to every vault the registry has ever built, and a worse one than the discipline
it would replace. A switch somebody must remember to shut is a smaller hole than
a write path from the vaults into the register that vouches for them.

`test_TheCrossModeDoorIsShutAndOnlyTheColdKeyOpensIt`,
`test_CrossModeMigrationNeedsTheSwitchAndTheTimelock` and
`test_ClosingTheCrossModeDoorTakesEffectImmediately` hold the three halves of
that; `test_TwoModesLiveInOneRegistry` and
`test_AVaultOfAnotherModeIsNotADestination` hold the separation itself.
