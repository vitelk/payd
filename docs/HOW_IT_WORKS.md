# HOW_IT_WORKS.md — the whole system, once through

`README.md` says what a holder gets. This says how it is built, in one pass, for
someone who intends to read the code afterwards. `ARCHITECTURE.md` holds the
reasoning behind every choice mentioned here and is not a prerequisite.

---

## The mechanism in one paragraph

A token is launched on **Pons v2** with a contract — not a wallet — as its
creator-fee recipient. Every trade pays the curve fee plus **the tax that
launch's creator set**, and most of it reaches that contract — the tax in full,
plus the share of the curve fee Pons does not keep. **There is no single rate**:
it is chosen per launch, `FeeVault.economics()` derives it rather than storing
it, and any figure written here would be true of one token and false of the
rest. The contract converts what it collects into **tokenised stocks** on
Uniswap v3, the whole basket in one purchase, and hands them to a second
contract that distributes them to the token's holders **pro rata to what they
held**, with no staking and no action on their part. Who held what is computed
off-chain, committed on-chain as a Merkle root, and re-computable by anyone from
the chain alone.

That pair of contracts is no longer made once, for one token: a **`Payd`**
registry mints a fresh pair per launch through its **`DistributionFactory`**, and the platform's own token, `$PAYD`, is one of
its tenants rather than its landlord.

## Why any of it is off-chain

The token is minted by the Pons factory. It has **no transfer hook**, so no
contract can know a past balance. Without staking — and staking is a click, a
lock-up, and a contract holding your tokens — the split has to be computed off
the chain and committed to it.

That is the whole trust surface, and it is worth stating plainly rather than
burying: **one key publishes the roots.** What it cannot do is invent money, pay
someone twice, take back what was paid, or move funds anywhere — those are
contract-level guarantees, not promises. What it could do is misdirect what has
not been delivered yet, a figure the contract publishes as
`Distributor.quoteAtRisk()` and which continuous delivery keeps at roughly one
epoch. [§S29](ARCHITECTURE.md#s29--the-keeper-publishes-and-the-root-takes-effect-immediately)
argues the alternative — a bond and a challenge window — and says why it was
dropped.

## The eight contracts

**Per launch**, one of each:

| | |
| :--- | :--- |
| **`FeeVault`** | Receives the creator fees in the launch's currency. Splits them three ways, buys the whole basket, sends the stocks straight to the Distributor. Holds no stock, ever. |
| **`Distributor`** | Holds the stocks and pays them out against a Merkle proof. Remembers what each holder has already been paid. |

**Once, for the platform:**

| | |
| :--- | :--- |
| **`Payd`** | The registry, and **an interface over the factories** rather than a pointer to one. Holds the parameters a creator may not choose alone: which stocks a basket may contain, which currencies a launch may be quoted in, what the platform takes — and which factories may build here at all. **It launches nothing** — the creator launches their own token on Pons, so the registry is the Pons `deployer` of nothing and holds no standing power over any launch. |
| **`DistributionFactory`** | Makes the pairs, and only that. Split out of `Payd` because a contract that does `new FeeVault()` carries that creation code: `Payd` weighed **54,635 bytes of initcode**, above the EIP-3860 ceiling, and 18,704 once the machinery left. It is also what makes a new vault implementation ordinary — a new factory, admitted by `Payd` under two keys and 48 h, and the vaults that follow are born in **this** registry. **One factory declares one payout mode** (`MODE`, `"distribution"` here): several may be admitted at once, and a vault is stamped with its own at birth. ([§S46](ARCHITECTURE.md#s46--one-payout-mode-is-one-factory-and-the-stamp-that-keeps-them-apart)) |
| **`Treasury`** | Receives the platform's share of every launch and splits it four ways: dev ⅓, `$PAYD` rewards ⅓, buy-and-burn ⅙, LP ⅙. No gas refund anywhere in it — the platform has every reason to call its own pockets. |
| **`Collector`** | Settles N launches in one transaction. A router that holds nothing: the stocks go straight to the holder, the refunded gas straight to the caller. ([§S39](ARCHITECTURE.md#s39--collector-settling-n-launches-in-one-transaction-and-the-door-it-uses)) |
| **`Timelock`** | 48 h, OpenZeppelin, self-administered. Its powers are listed below, and none of them moves value. |
| **`Bootstrap`** | Ties the knot: `FeeVault` and `Distributor` each need the other's address, so neither can be deployed first. The factory deploys one per `create` and abandons it in the same transaction — no `Bootstrap` is ever a standing contract. |

There is **no owner** anywhere. No `withdraw` exists for any privileged address;
the only `withdraw()` on either contract pays the caller a payment that had
already failed to reach that same caller, takes no address argument, and can move
nobody else's balance.

## One turn of the cycle

Every step is callable **by anyone**. On an ETH-quoted vault each one refunds its
own gas at the real cost, priced at `block.basefee` — which the caller does not
choose — and capped. `publishRoot` is the single exception.

```
harvest()                 pull the creator fees out of Pons, split them
   │                      platform (fixed at birth) · rewards (rewardsBps,
   │                      raisable only) · creator (the residue)
   ▼
buyBasket(minOuts[])      buy the WHOLE basket for every epoch since the last
   │                      purchase — one shared hop into the pivot, then one
   │                      leg per stock, each above its own price floor,
   │                      delivered straight to the Distributor
   ▼
publishRoot(...)          KEEPER ONLY. Commit the cumulative root, immediately
   │                      in force. Preceded by five preflight checks.
   ▼
distribute(holder, ...)   push a holder's shares to them. Or the holder calls
                          claim(...) and pays their own gas — or collect(...)
                          and settles every launch they hold at once.
```

An epoch nobody buys for simply carries over: the money stays in the vault and
the next purchase covers every epoch that went by. Nothing is lost and nothing is
stuck.

### One purchase, the whole basket

Payd bought **one stock per epoch** and honoured the weights by rotation. The
value was fair; the composition was noise — at a 24-hour cadence a holder needed
ten days to see a whole basket go by. A purchase now covers a **window**: every
epoch the Distributor has not been funded for, up to the last one that has
finished. ([§S41](ARCHITECTURE.md#s41--one-purchase-takes-the-whole-basket-and-a-skipped-leg-brings-nothing-down),
which supersedes [§S16](ARCHITECTURE.md#s16--one-epoch-one-stock-weighted-rotation))

What the window shares, instead of paying per leg: the hop into the pivot
currency (139,625 gas), the TWAP read of that same pool (69,389 gas), the
ETH/USD feed, the base transaction, the refund, and one `fundWindow` instead of
one `fund` per epoch.

**A leg that cannot be bought is skipped, not fatal.** A paused stock, a dry
pool, a floor the market will not meet: that leg's pivot currency stays in
`pivotReserve`, the contract emits `LegSkipped`, and the next purchase spends it.
A stock Robinhood pauses costs a delay, never a loss — and never the other legs.
This is what the `try/catch` buys back, and why `_fund` truncates the arrays to
the legs that actually bought: `fundWindow` refuses a zero amount, so passing the
full-width arrays made one skipped leg revert the entire purchase.

Two legs never touch a pool at all:

- a **pivot line** (USDG here) is already in the basket's currency. There is no
  pool of a token against itself, so there is no floor to compute and no price to
  protect. It is the one line `Payd` lists at tier 0;
- a line that **is the vault's own quote** is held back *before* the hop rather
  than bought back after it. The round trip costs two pool fees and two
  slippages to end up where it started — 0.10 % measured on NVDA/USDG at tier
  500.

### One currency per vault, and the pivot it routes through

Pons takes `pairToken` as an argument of `launchToken`, and its escrow keeps
**one ledger per currency**. Measured over seven days of `V2FeeEscrow` credits
(2026-09-08): **40.9 %** of Pons volume is quoted in ETH, **22.0 %** in USDG,
**37.2 %** in stock tokens. A vault that reads only the ETH ledger leaves three
fifths of the market unreachable, which is what v1 did.

So a vault declares **one `QUOTE` at birth and never changes it** — every number
it holds is denominated in that currency, and `bind` refuses any launch quoted
elsewhere. Everything then routes through one **`PIVOT`** currency, USDG on this
chain, because that is where the stocks' liquidity is (`recon.md` §4.1).

**The pivot is a crossroads, not a wall.** A currency can be deeply traded and
still invisible against the pivot: COIN and cbBTC have no pivot pool at all, and
$33,144 / $158,774 of WETH depth — between them 198 of the ~220 weekly credits
among the otherwise-unreachable pairs. Those are reached by `QUOTE → WETH →
PIVOT`, whose second hop is the very pool an ETH-quoted vault already uses. The
route is **declared at birth from a measurement, never probed when the money
moves**: exactly one of `QUOTE_FEE` / `QUOTE_WETH_FEE` is non-zero.

Neither the pivot nor the WETH→pivot tier is a constant any more. Both are
written at `init` from `Payd`'s wiring, so a redeployed registry can point
somewhere else without a line of contract changing.
([§S40](ARCHITECTURE.md#s40--one-currency-per-vault-and-the-pivot-as-a-crossroads))

**A non-ETH vault skims no delivery budget, and pays its caller in its own
currency.** The refund is computed in wei and the Distributor spends wei; a vault
holding NVDA has neither. So the cycle pays a **bounty** instead — 2 % of what
the call moved, capped at about $25 — which needs no price feed because it is
already denominated in the vault's currency. The delivery budget has no such
escape — it is wei, and the Distributor cannot spend NVDA on gas — so the keeper
fronts every push there and the bounty is what pays for it. The airdrop floor is
**40 % of `MIN_BUY_QUOTE`, about $10** — the same value an ether vault uses,
simply expressed in the currency the vault actually holds.

### The price floor

Never `minOut = 0`. Every purchase prices through a **30-minute Uniswap v3
TWAP**, tightened by a **Chainlink** feed where one exists and never blocked by
one that is stale — equity feeds go quiet at the weekend, and around a split the
feed and the token's own multiplier disagree for an hour. The caller may pass a
tighter `minOut` per leg; the contract takes `max(caller, on-chain floor)`, so a
hostile caller can only make their own transaction fail.
([§S3](ARCHITECTURE.md#s3--minout-an-on-chain-floor-tightenable-off-chain-p3-p4))

Upstream of the floor, `Payd` refuses to list a stock or a quote whose
declared pool **does not exist or carries nothing**. Existence alone would have
caught nothing here: all four NVDA/USDG tiers exist and `getPool` answers on each
— it is the liquidity that separates them, 1.4e19 at tier 500 and **zero** at
tier 10000. ([§S42](ARCHITECTURE.md#s42--a-listed-line-must-have-a-pool-that-carries-something))

## The snapshot

An epoch's balances are the **time-weighted average over the whole epoch**: not
a balance read at some instant, but `∫ balance dt` divided by the epoch's length.
Hold for the full period and you weigh what you hold; hold for a second and you
weigh a second.

That leaves nothing to snipe, and nothing to draw. The period is
`[GENESIS + e·L, GENESIS + (e+1)·L)` — two immutables and a subtraction — so the
publisher chooses no part of it, and no seed has to be committed on-chain to
prove they did not. The two transactions per epoch that used to do that, and the
delay between them, are gone. ([§S38](ARCHITECTURE.md#s38--the-time-weighted-average-and-the-machinery-it-deletes))

`L` is per vault: `Payd` accepts anything from **30 minutes to 24 hours**.
Thirty minutes is what a token with real volume wants; a day is what a quiet one
wants, so its keeper is not publishing roots into the void.

Excluded from the snapshot: the Uniswap pool, the Pons bonding curve, the vault
and its Distributor, address zero, the burn address `0xdead`, and a list the timelock
maintains. That list is
**on-chain and dated**: an exclusion applies from a given epoch onward, so two
people replaying the same epoch on either side of a change still agree.
([§S23](ARCHITECTURE.md#s23--an-exclusion-is-dated-not-live))

## Two roots, and why cumulative

A leaf is `(holder, stock, cumulative)` — the total owed **since inception**, not
for one epoch. The contract remembers what it has already paid and settles only
the difference. Cost therefore scales with the number of **stocks**, never with
the number of epochs elapsed: settling a holder after a week costs the same as
after an hour, and replaying an old proof pays nothing.
([§S18](ARCHITECTURE.md#s18--cumulative-roots-cost-follows-the-stocks-no-longer-time))

Each publication carries **two** roots:

- **`claimRoot`** — every eligible holder. This is what `claim` verifies against,
  and it is open to anyone at any time.
- **`pushRoot`** — only the entries worth delivering, currently ~$20 of value.
  `distribute` verifies against this one, so the gas refund can only ever fund a
  delivery that was worth making.

Both are standard OpenZeppelin sorted-pair trees, checked leaf by leaf against
the reference implementation in `test/MerkleCompat.t.sol` and
`front/src/merkle.test.ts`. They are **different trees**, and a proof built on
the wrong one passes every check in the browser and reverts on-chain — the trap
§S39 documents.

## Verifying without asking anyone

```bash
pnpm --filter offchain dispute
```

Recomputes the shares from the chain alone — no key, no input from the project, no
archive node — and reports whether the published root matches. Everything it
consumes is public: the exclusions are on-chain and dated, the artifact is
committed as a sha256 digest in `Root.digest`, and the period each average covers
falls out of `GENESIS` and `EPOCH_LENGTH`.

The keeper runs **five preflight checks** before publishing and refuses to
publish if any fails — conservation, monotonicity, population, provenance, and a
full recomputation on a second RPC. Publishing nothing delays rewards;
publishing wrongly misdirects them.
([§S32](ARCHITECTURE.md#s32--the-preflight-refusing-to-publish-rather-than-publishing-wrongly))

## Who can do what

| Actor | Can | Cannot |
| :--- | :--- | :--- |
| **Anyone** | harvest, buy the basket, pay the creator and the platform their share, distribute, claim, collect across launches, top up the rewards reserve, split the Treasury and run its four pockets | change any parameter |
| **Keeper** | publish a root | move funds, change anything else |
| **Creator** (of one launch) | raise their vault's `rewardsBps` — **upwards only**, floor 50 % | lower it, touch the basket, touch funds |
| **Timelock** (48 h, proposed by the Safe, executed by anyone) | per vault: reweight the basket, set the payout rate, set the gas share, manage exclusions, rotate the keeper, `migrate` the fee stream. Platform-wide: list and delist stocks and quotes, set `platformBps` for FUTURE vaults, set the Treasury split, admit a factory the generation key has approved (`setFactory`, `enableFactory`) and stop one building (`disableFactory`) | withdraw, redirect to itself, or freeze anything |
| **Safe** (2-of-3) | launch its own token, propose to the timelock | touch funds already in the contracts, or reach a creator's launch |
| **Generation key** (cold, immutable, holds nothing) | `approve` a candidate factory — and revoke it while the timelock has not executed. Open or shut `crossModeMigration`, the one thing that lets a migration cross payout modes | name anything by itself: `setFactory` and `enableFactory` are still the timelock's, still 48 h, and opening the cross-mode door migrates nothing on its own |

`platformBps` is stamped into each vault **at its birth** and is immutable there:
changing it on `Payd` reaches only vaults that do not exist yet, so a
creator knows at launch what the platform takes, for good.

`migrate` is the only door out of a vault, and it leads to exactly one place: a
vault of the **same token, same creator, same currency and the same payout
mode**, that pays holders at least as well and takes no more for the platform. **Not one stock leaves the
Distributor** — what was already credited stays claimable where it is; the vault's
own undelivered reserve follows the stream, into the successor's rewards pool and
pivot reserve, which are one-way pockets there too (`_moveReserve`). It exists
because only the *current* fee recipient can replace itself, so without it a bug
would strand a token's fee stream forever.

The destination is checked against **the registry, and nothing the destination
itself says**: `Payd.isVault`, a flag written by `_create` and by nothing else,
and `Payd.modeOf`, stamped there in the same breath. It used to be `recognised`,
which walked a chain of
`setSuccessor` pointers so a vault of another generation could be accepted — and
that was the largest residual hole in the system: `setSuccessor` took any address,
and five lines answering `isVault(x) = true` for every `x` opened the migration,
hence the future flow *and* the reserve, onto anything. No check could close it,
because everything you read from an unknown contract is written by that contract.
It existed only because the implementations lived inside the registry as
`immutable`, so a new vault version forced a new registry. `DistributionFactory` carries
them now, a new version is born in **this** registry, and the successor chain has
been deleted rather than guarded.
[§S24](ARCHITECTURE.md#s24--the-escape-valve-and-why-it-points-at-the-safe)
records the version that pointed at a maintainer-controlled Safe, and why it no
longer does.

**The mode is the bound that was added rather than removed.** `isVault` says the
destination was born here; it does not say it pays the same way. While one mode
exists the two questions have the same answer — the day a second factory builds
something else they do not, and one timelock operation would move a pro-rata
stream into another payout shape. What is compared is what the two vaults *pay*,
not which deployment made them, so a new version of the same mode still migrates:
that is the entire point of the function. Crossing modes takes a second key that
is not the timelock's — the generation key opens `crossModeMigration`, shut from
birth — and even open, it only lets the timelock schedule a migration that must
still clear 48 h and every other condition above.
[§S46](ARCHITECTURE.md#s46--one-payout-mode-is-one-factory-and-the-stamp-that-keeps-them-apart)
has the reasoning and what it deliberately does not do.

## The code

```
contracts/          FeeVault · Distributor · Payd · DistributionFactory · Treasury
                    Collector · Timelock · Bootstrap
  interfaces/       every external ABI, each one read on-chain and dated
  libraries/        TwapFloor + the Uniswap maths it needs, ported to 0.8
test/               fork tests against live state — no mock on Pons or Uniswap
  Invariants.t.sol  what must hold after ANY sequence of calls
script/             Deploy · DeployPayd · Allowlist · Quotelist · the Measure* recons
offchain/src/
  snapshot.ts       replay Transfer logs, weight each balance by the time it was held
  eligibility.ts    who is in the tree — a pure function, replayable
  epoch.ts          build the cumulative artifact and both roots
  preflight.ts      the five checks that block a publication
  keeper.ts         the loop: every step idempotent, restartable with no memory
  dispute.ts        recompute a published root from the chain alone
front/              the claim page: reads the chain, rebuilds the tree, proves
site/               the shop window
```

A test that only passes thanks to a mock on Pons or Uniswap is rejected. The
suite runs against the real chain, with real pools and real stock tokens taken
from real holders.

```bash
forge test --fork-url $RPC_URL_FALLBACK --compute-units-per-second 60 -j 1
pnpm --filter offchain test && pnpm --filter front test
```

## What can go wrong

Stated in the README for holders, repeated here for readers of the code:
Robinhood can pause or block a stock token and this protocol is exposed like
everyone else — a paused stock now costs a skipped leg rather than a failed
purchase, but it still costs; Pons can redirect the fee stream with three days'
notice and no veto from the vault; the publishing service stopping means fees pile
up undistributed until it comes back. And **no external audit has been done** —
[`SECURITY.md`](../SECURITY.md) says what is in scope and how to report.

## Where to go next

| | |
| :--- | :--- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 42 decisions with their measurements — including the ones we got wrong |
| [`recon.md`](recon.md) | Every external address, how it was verified, on what date |
| [`CONVENTIONS.md`](CONVENTIONS.md) | The rules the code is held to, and the measurement behind each |
| [`recon-launchpad.md`](recon-launchpad.md) | The same, for what the registry had to learn |
| [`allowlist.md`](allowlist.md) | The stocks and quotes, with the depth measured behind each |
| [`../SECURITY.md`](../SECURITY.md) | Scope, the known trade-offs, how to report a finding |
