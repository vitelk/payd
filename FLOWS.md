# FLOWS — where the money goes, and who can move it

> A document meant to be read by a third party: an accountant, an adviser, an
> auditor, or any token holder who would rather verify than believe.
>
> Every claim points at the file and the **function** that proves it — never at a
> line number. A line number drifts at the first commit and becomes wrong without
> anybody noticing; a function name is found by search and stays true.
>
> Last revised: 2026-09-11.

---

## 1. In one sentence

A token launched on Pons pays its *creator fees* to a contract, never to a
wallet. That contract splits them according to percentages written in the code,
converts the holders' share into tokenised stocks, and distributes those to them.

**The only regular exit towards the developer is a fixed share, paid to an
address written at deployment and impossible to change afterwards.** There is a
single function in the whole system that moves funds to an address somebody names
— it is described in §7.a, with its three locks and the reason it exists.

---

## 2. Every contract, and the two that touch the money

```
   Pons v2 (a launch's creator fees)
        │
        ▼
   FeeVault  ── one per launched token ──────────────────────────┐
        │                                                        │
        ├─ rewardsBps  ──▶ basket purchase ──▶ Distributor ──▶ the holders
        ├─ PLATFORM_BPS ─▶ Treasury                              │
        └─ the residue ──▶ CREATOR (the creator's immutable address)
                                     ┌───────────────────────────┘
                                     ▼
   Treasury ── one, for the whole platform, for the life of the protocol
        ├─ 33.33 %  ──▶ DEV_WALLET          (the dev share)
        ├─ 16.67 %  ──▶ buyback + burn of the platform token
        ├─ 16.67 %  ──▶ liquidity held by the contract itself
        └─ 33.33 %  ──▶ $PAYD's FeeVault ──▶ its holders
```

| Contract | What it is | Holds money? |
|---|---|---|
| **`FeeVault` + `Distributor`** | one pair per launched token. This is where the product happens: harvesting the fees, buying the basket of stocks, distributing to the holders | **yes** — the token's fees and the stocks bought |
| **`Treasury`** | the platform's till. Receives every vault's platform share and splits it four ways. Holds the protocol's liquidity position | **yes** |
| **`Payd`** | the registry. The allowlists, the platform rate of future vaults, the keeper, the `isVault` register, and it mints vaults by calling the factory | **no** — not a wei passes through it |
| **`DistributionFactory`** | the machine. Carries the two cloned implementations and assembles them. No privileged function, no mutable state | **no** |
| **`Timelock`** | the only holder of power, and §6 is its list. OpenZeppelin's `TimelockController` with **no administrator**: the Safe proposes, anyone executes 48 h later | **no** |
| **`Collector`** | a shortcut, not a step. Settles a holder's share on several launches in one transaction instead of one call per launch. No owner, no allowlist, no state but a reentrancy latch | **no** — the stock goes straight from each `Distributor` to the holder |

That is the whole list. `contracts/` holds one more file, `Bootstrap.sol`, and it
is not in the table because **no `Bootstrap` is ever a standing contract**: the
factory deploys one per `create` to tie the knot — `FeeVault` and `Distributor`
each need the other's address — and abandons it in the same transaction. It has
no owner, no state and nothing to hold.

`Payd`, `DistributionFactory`, `Timelock` and `Collector` appear nowhere on the flow
diagram, and that is the point of the diagram: **four of the six standing
contracts are not on the path the money takes.** A `Collector` that is missing,
broken or replaced stops nobody from getting their share — every launch is still
claimed from its own page.

**A vault quoted in anything but ether uses the same ~$10 airdrop floor as an
ether one, expressed in its own currency: 40 % of `MIN_BUY_QUOTE`.**
The delivery budget is wei and `harvest` skims none of it there, because the
`Distributor` cannot spend USDG on gas (§4.3bis), so every push on those vaults
is fronted by whoever calls and is paid for by `keeperBountyBps` instead.

That floor was briefly set at ~$200, to make the unrefunded deliveries cheap.
The arithmetic did not support it: at $10 the whole cycle — deliveries and
purchases together — costs **65 bps of rewards**, against the **3.00 %** an
ether vault already takes as `distGasBps` for the delivery service alone. Four
times cheaper than what the protocol charges its own ether holders is not a
thing to ration, and at $200 only the largest holders would ever have received
anything: a 0.1 % holder of a token doing $50k a day waited a hundred days.

**The ether floor came down in the same pass, from $20 back to $10.** It had
been doubled on 2026-09-06 to halve the cycle's push gas; the gas it was
defending against has since fallen 56.7 % (`ESTIMATIONS.md` §0), and the 3 %
reserve was never close to binding — a holder under the floor is not delivered,
so deliveries are bounded by `rewards / floor` and the reserve is self-funding
from **$1.34**. $10 and not lower is set by the rule the suite already
enforced: at normal gas a delivery must eat less than 1 % of what it carries.

**And since 2026-09-11 the contract enforces that rule too, rather than
inheriting it from the keeper** (`Distributor.REFUND_VALUE_BPS`, T-REFUND-02).
`_refund` priced the CALL and nothing related it to what changed hands: an
invariant campaign found 23 087 729 830 400 wei of refund paid against about
**seven wei** of value delivered, with no padding involved — a small delivery
simply cost the reserve the same fixed refund as a large one. A `distribute` is
now refunded at most **10 %** of what it moved, valued by the same `backing`
figure `quoteAtRisk` is decremented by, so no price is read and none can be
manipulated. Ten per cent is the keeper's own floor made binding: `PUSH_K_MIN`
already guarantees the gas is at most 1/20 of the value, and the factor of two
covers what sits outside `SETTLE_GAS`. It caps and never reverts — a delivery
worth too little to refund still delivers, and the caller fronts the difference
as everywhere else. A batch that repeats a stock is refused outright
(`DuplicateStock`): one account has at most `MAX_BASKET` distinct lines, so
nothing legitimate repeats one, and 63 no-ops riding with one real delivery used
to cost the reserve 1.854 times the honest refund.

**Not pushing at all was the first answer, and it was withdrawn for a security
reason rather than an economic one.** What a false root could award itself is
`Distributor.totalFunded(stock) - totalDistributed(stock)` — the clamp at
`contracts/Distributor.sol:544-545`, monitored in quote terms as `quoteAtRisk`
— and it is already several windows rather than one, because the push floor
never reaches the sub-floor tail (§7.c). Stop the deliveries and there is no
bound left at all, on the vaults where the value then accumulates untouched — at
the same time as `Payd.allowKeeper` widens who may publish. The two together
were not shippable.

---

## 3. The shares

### Tier 1 — `FeeVault`, one per token

| Share | Value | Destination | Mutable? |
|---|---|---|---|
| holders | `rewardsBps`, ≥ 50 % | stock purchase then `Distributor` | **yes, upwards only** — `FeeVault.setRewardsBps` |
| platform | `PLATFORM_BPS`, ≤ 15 % | `Treasury` | **no**, written at the vault's birth |
| creator | the residue | `CREATOR` | **no**, address written at birth |
| caller of the cycle | gas refund, or the bounty of §4.3bis on a non-ETH vault | `msg.sender` | no — hard caps |

The split happens in `FeeVault.harvest`, the second the fees leave the Pons
escrow. No intermediate step, no buffer wallet: the contract is itself the
`creatorFeeRecipient` at Pons and calls `claim()` in its own name.

For **$PAYD**: `rewardsBps = 8 649` (86.49 %), `PLATFORM_BPS = 0`, creator
residue 13.51 %. Related to traded volume: 3.20 % to the holders, 0.50 % to the
creator. The `economics()` view computes it live from Pons's own parameters,
copying nothing.

### Tier 2 — `Treasury`, one only

| Pocket | Value | Destination | Mutable? |
|---|---|---|---|
| dev | 33.33 % | `Treasury.DEV_WALLET` | **downwards only** |
| buyback/burn | 16.67 % | `0x…dEaD` | yes, between pockets |
| liquidity | 16.67 % | position held by the `Treasury` | yes, between pockets |
| $PAYD holders | 33.33 % | $PAYD's vault | yes, between pockets |

Values: `Treasury.devBps` / `burnBps` / `lpBps` / `rewardsBps`. The split
(`_split`) is called automatically by each of the exits, and it measures the
**balance** rather than a parameter — so an unexpected payment or a donation is
split like the rest.

---

## 4. The channels to the developer — all three, declared

| # | Channel | Amount | Destination | Can it grow? |
|---|---|---|---|---|
| 1 | The Treasury's dev share | 33.33 % of the platform share (itself 10 % of third-party tokens' gross) | `DEV_WALLET`, immutable | **no** — capped at its value at birth |
| 2 | The $PAYD vault's creator residue | 13.51 % of $PAYD's gross, i.e. 0.50 % of its volume | `CREATOR` = the Safe, immutable | **no** — can only fall |
| 3 | Gas refunds, on an **ETH-quoted** vault | real cost at `block.basefee`, capped at 0.01 ETH per call | `msg.sender`, often the keeper operated by the dev | no — hard cap |
| 3bis | The cycle bounty, on a vault quoted in **anything else** | `keeperBountyBps` of what the call moved — 70 bps at birth, hard ceiling 300 — capped at `MIN_BUY_QUOTE` (~$25), and on `harvest` also by 50 bps of the creator's residue | `msg.sender`, same caller | **timelock only, and never above 3 %** |

Channel 3 is a refund, not revenue: it hands the caller back the gas they have
just spent on the protocol's behalf, computed on a `basefee` the caller does not
choose. It is listed because it will show up in an indexer, and a document that
omitted it would be false.

**Channel 3bis is not a refund, and the difference is deliberate.** A vault
quoted in USDG or NVDA holds no ether, so `_refundAmount` — which computes wei
from gas — has nothing to pay with. Pricing gas in NVDA would mean an ETH/QUOTE
oracle on the money path for a few cents of L2 gas, and that trade was refused.
A **bounty** avoids it entirely: a percentage of an amount already denominated
in `QUOTE` needs no price at all, so nothing here can be moved by one.

It is therefore approximate by construction, and bounded rather than made exact
— on both sides, and by the timelock. The rate is `keeperBountyBps`, **70 bps at
birth, and `MAX_KEEPER_BOUNTY_BPS` forbids more than 300** whatever the timelock
decides: that ceiling is what stops a reimbursement becoming a tax on holders,
the same sentence `MAX_DIST_GAS_BPS` exists for. Each payment is additionally
capped at `MIN_BUY_QUOTE` — about $25, the same order as `MAX_REFUND` on the
ether path.

> This line said **100** until 2026-09-11 (T-DOC-01). The constant is 300
> (`contracts/FeeVault.sol:508`), and its own comment records why: 100 was the
> first value and was too tight to survive a doubling of the basefee — at 70 bps
> seeded, 2x gas needs ~105. `CLAUDE.md` §Conventions already said "bounded
> [10, 300]"; this paragraph had not followed.

**70 bps is what the cycle measures, not a margin.** The purchase side runs
15–38 bps of what a vault spends depending on its size, and the deliveries add
~40 bps at the $10 floor: 65 bps in all, with the rest absorbing a basefee that
halved in three days and can double back. The ceiling is 300 rather than a
round number because it has a rule: a non-ether vault's holders must never pay
more for the WHOLE cycle than an ether vault's holders already pay for delivery
alone. Where a choice remains, erring low is
the rule — paying less than cost degrades to the caller fronting the difference,
which is written down (§S8), while paying more moves holders' money to whoever
runs the keeper.

**Who pays it is the same as on the ether path**, which is the point: the
purchase bounty comes out of `rewardsPool`, the harvest bounty out of the
creator's residue. What changed is not the incidence but the currency — and
before this, a non-ETH vault's cycle was paid for by whoever ran the keeper,
for ever, on 59.1 % of Pons volume (`docs/ARCHITECTURE.md` §S40).

**Two ratchets, both one-way:**

- **the dev share never goes back up.** `Treasury.setSplit` refuses any value
  above the current one. 33.33 % is a ceiling for the life of the contract. Held
  by `invariant_DevBpsOnlyEverFalls`;
- **the holders' share never falls**, floor 50 %.

And two hard caps: the platform share never exceeds 15 %, checked **twice** — by
`Payd` at write time and by `FeeVault.init` at birth, because a vault believes
nothing the registry tells it. It is engraved in each vault at its birth:
**`setPlatformBps` never reaches an existing vault.** A creator knows at launch
what the platform will take, forever. If they want that to change, they migrate —
and `migrate` accepts only a destination whose platform share is **less than or
equal** and whose holders' share is **greater than or equal**.

---

## 5. What does not exist

| What one looks for | Present? |
|---|---|
| `rescue`, `sweep` to a chosen address, `recover`, `emergency*`, `skim` | **no** |
| `onlyOwner`, `Ownable`, `owner()` | **no** — there is no owner |
| `pause`, `Pausable`, `whenNotPaused` | **no** — nothing can be frozen |
| upgradeable proxy (UUPS, Transparent, Beacon) | **no** — the vaults are minimal, non-upgradeable clones |
| `delegatecall`, `selfdestruct` | **no** |
| a setter on `DEV_WALLET`, `CREATOR`, `PLATFORM`, `DISTRIBUTOR`, `REGISTRY`, `GENERATION_KEY`, `PREDECESSOR` | **no** — all immutable |
| **a function that sends funds to an address somebody names** | **yes, exactly one** — `Treasury.migrateTreasury`, §7.a |

The `withdraw()` functions of `FeeVault` and `Distributor` pay only
`msg.sender`, and only a payment that had already failed to reach them.
`sweepToEth` and `collectFrom` (§6) take no destination: what they move stays in
the contract.

The liquidity position is held by the `Treasury` itself at the Uniswap v4
PoolManager, with no NFT in between: **there is nothing to approve, nothing to
transfer, and no function removes it** — not even the migration.

---

## 6. The privileged functions, without exception

**Two authorities, and nothing moves without them.**

- **The timelock** — an OpenZeppelin `TimelockController` deployed with **no
  administrator** (fourth argument `address(0)`). Sole proposer: the
  multi-signature Safe. Executor: `address(0)`, which OpenZeppelin reads as
  "anyone". The Safe decides, the public executes once the **48 hours** have
  elapsed. Every proposal emits a `CallScheduled` at submission.
- **The generation key** — a hardware wallet (Ledger) **kept apart from the
  Safe's signers**, which holds nothing and signs nothing else. It **approves**,
  it never triggers: without a timelock operation, what it writes does nothing.
  On the same hardware as the Safe it would add nothing but code — this is the
  one assumption in this document that no contract can verify.

Classification: **(a)** touches funds, **(b)** touches a parameter, **(c)** purely
operational.

| Function | Holder | Class | What it allows |
|---|---|---|---|
| `Treasury.migrateTreasury` | **Timelock + Ledger**, once, one way | **(a)** | sends the Treasury's whole contents to a successor. §7.a |
| `Payd.setFactory` | **Timelock + Ledger** | **(a)** | changes the code future vaults execute. §7.b |
| `Payd.enableFactory` | **Timelock + Ledger** | **(a)** | lets a factory build in this registry **without** moving the default. This is how a second payout mode exists. §7.b |
| `Payd.disableFactory` | Timelock | (b) | stops a factory building anything new. Touches no vault it already built, and cannot be aimed at the default |
| `Payd.setCrossModeMigration` | **Ledger** alone | (b) | opens the door between two payout modes. Moves nothing: the timelock must still call `migrate`, through its 48 h. Shut at birth |
| `Treasury.bindPlatform` | **Timelock + Ledger**, once | **(a)** | names the token bought back and the vault that receives the holders' pocket |
| `Distributor.publishRoot` | **A keeper** (hot key): the Distributor's own pinned one, **or** any address `Payd.isKeeper` names | **(a)** | publishes the root that says who receives what. §7.c |
| `FeeVault.migrate` | Timelock | (a), bounded | redirects a vault's future stream **and carries its unconverted reserve**, to a vault of the **same registry** and of the **same payout mode** — `isVault` and `modeOf`, both unforgeable. Crossing modes needs the Ledger to have opened the door first |
| `Treasury.setSplit` | Timelock | (b) | reweights the four pockets; the dev share can only fall |
| `Treasury.allowSweeps` | Timelock | (b) | declares convertible tokens and the route each converts through — **exactly one** tier each, `token/WETH` or `token/PIVOT`. Moves nothing. Seeded at birth from the quote list, so day one is not a 48-hour wait. **A route may be repointed, never removed**: naming neither tier is refused |

**The pair, and why it is a pair.** `Payd._requireSweepable` stops a quote being
listed before the till can convert it; `allowSweeps` refusing "neither" stops
the till's route being closed after vaults are already paying in it. One guard
without the other leaves the door open in the other direction, and a vault's
quote is stamped for life — it cannot be told to stop paying in a currency that
has become unconvertible. Delisting a row used to be possible and tested; it was
the more dangerous half, because a stale row costs nothing (`sweepToEth` reverts
`NoPool` and the money waits) while a removed one strands every payment that
follows.
| `Distributor.setKeeper` | Timelock **or its own registry** | (b) | rotates the publication key. The registry is a second caller so that `Payd.rotateKeeper` can reach a live vault; it is read from the vault, never stored |
| `Distributor.setExcluded` | Timelock | (b) | the snapshot's exclusion list |
| `FeeVault.setAllocations` / `setPayoutBps` / `setDistGasBps` | Timelock | (b) | basket, cadence, delivery budget — all bounded |
| `FeeVault.setRewardsBps` | The token's **creator** | (b) | raises the holders' share, never the other way |
| `Payd.allowStocks` / `removeStocks` / `allowQuotes` / `removeQuotes` | Timelock | (b) | what a basket is allowed to contain, and what a vault may be quoted in |

**`allowQuotes` now depends on `Treasury.allowSweeps`, and the order is
enforced rather than remembered.** A vault pays its platform share in its own
currency and the Treasury works exclusively in ether, so a quote listed on the
registry but absent from the sweep list produces vaults whose platform share
arrives in something `sweepToEth` refuses — and it does not revert, it
accumulates for ever. `_requireSweepable` reads the till before writing the
listing: **sweeps first, quotes second.** Both are the timelock's, so it costs
an ordering, not a key.

It fails **open** against a platform that does not answer, deliberately:
`PLATFORM` is immutable and written at deployment, so a platform that is not a
Treasury is a wiring catastrophe this guard is not meant to catch, and refusing
every listing against one would be a liveness hazard bought for nothing. The
keeper warns, per round, about what that leaves uncovered.

**`allowQuotes` also refuses a route that holds nothing, and the bar is a
sanity bar** (`Payd.MIN_ROUTE_DEPTH`, since 2026-09-11). `_requirePool` admits
any pool on `liquidity() != 0` and says in its own comment that it does not
catch a thin tier — so cbBTC/USDG at tier 3000, a real pool with **two dollars**
of active depth, was listable by a timelock that copied `3000` out of that
token's WETH row into the pivot column. The vault it mints is stamped with that
quote for life, `removeQuotes` reaching none of them.

The on-chain bar is **$500 on the thinnest hop**, an order of magnitude under
the $5 000 `docs/allowlist.md` sets and re-measures. The gap is the point:
active liquidity at the current tick is volatile — the cbBTC/WETH pool read
$158 774, $4 166, $4 927, $2 496, $9 546 and $11 302 inside a few hours with its
deposits unchanged — so a revert at the policy figure would make the registry's
own seed deploy or not depending on the block. **The contract refuses the typo;
the policy stays off-chain, dated and re-measured.** `allowStocks` deliberately
gets no such bar: a basket line that dries up is skipped one leg at a time and
the vault keeps running, where a quote is on every purchase it will ever make.
| `Payd.setPlatformBps` | Timelock | (b) | platform share of **future** vaults, cap 15 % |
| `Payd.setKeeper` | Timelock | (b) | keeper of **future** vaults. Moves nothing already live |
| `Payd.setCoSigner` | Timelock | (b) | the second key **future** vaults are born with. Moves nothing already live. It refuses `keeper`, and since 2026-09-12 any address `allowKeeper` already names — the same collapse arrived at by the other order of the same two calls. Zero stays legal: it is what removes the requirement from future vaults |
| `Payd.rotateCoSigner(from, to)` | Timelock | (b) | pushes it into the Distributors of live vaults, by index range, exactly like `rotateKeeper`. A Distributor that refuses is skipped and named |
| `Distributor.setCoSigner` | Timelock **or** the vault's registry | (b) | names or removes the second key on one vault. **It refuses the keeper's own address, and `setKeeper` refuses the co-signer's** — two roles collapsed into one address is a second secret held by whoever holds the first, and every property would still read as satisfied. What no contract can check is that the co-signer runs on another HOST against another node, which is what the second key actually buys. Removing it is the 48-hour lever; `CO_SIGNER_GRACE` is the three-hour one that needs nobody |
| `Distributor.heartbeat` | The co-signer, and it alone | (b) | says the second key is alive. Moves nothing, and its ABSENCE is what lets the pinned key publish alone again |
| `Distributor.requestCoSignature` | A keeper — **the vault's own pinned key OR any address `Payd.isKeeper` names** | (b) | puts one root to the co-signer publicly. Moves nothing. Three hours later that root — and no other — may go out on one key, so a second key that refuses to sign cannot hold the vault shut. **Four things bound WHEN that clock may start**, all added 2026-09-12 after it was found to bound none: the epoch must be closed, the co-signer must be in force, the request must postdate `coSignerNamedAt`, and it may not be made in the naming block. Without them a request banked while `coSigner` was zero — or while it was lapsed — was refusable by nobody and honoured for ever after |
| `Distributor.rejectCoSignature` | The co-signer, and it alone | (b) | refuses one root for good. Moves nothing. It is what stops the line above being a three-hour path to theft for a compromised keeper, and unlike silence it is attributable |
| `Payd.rotateKeeper(from, to)` | Timelock | (b) | pushes the current keeper into the Distributors of live vaults, by range. **The answer to a compromised key across many vaults.** A Distributor that refuses is skipped and named in `KeeperRotationSkipped`, never blocking the rest |
| `Payd.allowKeeper(who, bool)` | Timelock | **(a)** | names, or unnames, an ADDITIONAL publisher on every vault of this registry at once — no loop, because a Distributor asks at publish time. **Class (a): a root takes effect immediately, so every address here can award itself what a Distributor holds undelivered.** It only ever adds PUBLICATION — it cannot take publication away from a vault, and a registry that stops answering cannot either. **What it can no longer do is collapse the two roles.** Naming the registry's own `coSigner` here handed one secret both the sender `Distributor._publish` accepts and the signer `publishRoot` recovers, on every vault at once, with `coSignerRequired()` still reading true and the root recorded as co-signed — one timelock call, whose motive ("let the second node publish while the keeper box is down") reads as routine. Refused since 2026-09-12 in both orders: `Payd.setCoSigner` refuses an address this set already names. **Unnaming stays open whoever the address is**, so an approval made in error can always be withdrawn. The comparison is against `Payd.coSigner`, the registry's default — a Distributor handed a co-signer of its own is outside it, the same approximation `setKeeper` makes (`docs/AUDIT_PAYD.md` F-1) |
| `Payd.createVaultFor` | Timelock | (b) | creates a vault for a creator — used by migrations. It now NAMES the mode, the currency and the mode's per-launch parameter, instead of being wired to the default factory and to native ETH. Same `FactoryNotEnabled` gate as `createVaultWith`: the timelock picks among the modes BOTH keys admitted, never the code. Widened because a vault of a secondary mode, or quoted in anything but ETH, had no destination the timelock could mint — so a launcher gone quiet meant a vault that could never move to a newer implementation |
| `Payd.approve` / `Treasury.approvePlatform` / `Treasury.approveTreasury` | **Ledger** alone | (c) | authorises without triggering anything |
| `Timelock.updateDelay` / `grantRole` | the Timelock itself | (b) | at the price of a full delay |

Everything else is **permissionless**: `harvest`, `buyBasket`, `payCreator`,
`payPlatform`, `fundRewards`, `fundPivot`, `bind`, `withdraw`, `split`,
`payDev`, `fundPlatformRewards`, `buyAndBurn`, `addLiquidity`,
`sweepToEth`, `collectFrom`, `followMigration`, `pushAll`, `claim`,
`distribute`, `collect` — and creating a launch: `createVault`,
`createVaultQuoted`, `createVaultWith`. **None of them takes a destination as an
argument**: they trigger a movement whose arrival is already written.

Three address arguments in that list are worth naming rather than leaving a reader
to find them, because none of them is a destination for funds:

- `createVaultWith(factory_, …)` names **which admitted factory builds**. The
  only addresses it can reach are already in `factoryMode`, which takes the
  Ledger and the timelock to write; an address nobody admitted reverts
  (`FactoryNotEnabled`). The caller chooses among modes that are already
  sanctioned — never what code runs;
- `distribute(account, …)` and `collect(account, …)` name **who gets paid**, and
  the answer is fixed by the published root: naming somebody else pays that
  somebody else what they were already owed, which is the point of the push;
- `collect(account, distributors, …)` also names **which launches to settle**,
  and `Collector` deliberately does not check them. It holds nothing — the stock
  goes straight from each `Distributor` to `account`, and the only ETH that ever
  sits there is the gas refund, forwarded before the call returns — so an
  address passed in as a "distributor" has nothing to take. The worst it can do
  is waste the caller's own gas.

---

## 7. What this document does not claim

**a. `migrateTreasury` — the door, and it is owned.**
It sends the Treasury's whole contents to a named address. It exists because this
contract has no withdrawal: if a defect made it unusable, everything it holds
would be lost, and the vaults already created would go on paying it forever —
their `PLATFORM` is immutable. The door limits the bleeding; it is also, by
construction, a door.

Three locks, and none of them claims to make the destination "legitimate":

1. **two keys** — the timelock with its public 48 h, and the Ledger;
2. **once, one way** — `migratedTo` written, never anywhere else again;
3. **the destination has to be expecting you** — it must expose
   `receiveMigration` **and** carry this Treasury as its immutable
   `PREDECESSOR`. An EOA or a mistyped address is refused by construction. A
   contract written for the occasion is not: that is why there are two keys.

What does not follow: the liquidity position. Moving it would require a
`removeLiquidity`, that is, turning "nobody can withdraw the liquidity" into
"nobody except two keys". It loses nothing by staying — it goes on providing its
depth in the pool.

**b. `setFactory`, and `enableFactory` beside it.** Two keys, 48 h, both. A
hostile factory would produce vaults registered in the registry, hence valid
`migrate` destinations. No on-chain check tells a real factory from a fake one:
everything you could read on it is written by it.

The registry holds **several** factories — that is what makes `Payd` an interface
over them rather than a pointer to one, and what lets two payout modes coexist.
`enableFactory` admits one; `setFactory` admits one **and** makes it the default
that `createVault` builds through. `createVaultWith` then lets a launcher name
any admitted factory. That last function is permissionless and adds no power: the
only addresses it can reach are those already in `factoryMode`, which takes both
keys to write. What a launcher chooses is which admitted mode they launch under,
never what code runs.

`disableFactory` is the way back out, and it is one key because it removes a
capability rather than granting one. It reaches nothing already built: those
vaults are stamped and keep running. It cannot be aimed at the default, which
would leave `createVault` calling a factory the registry has disowned.

**c. The keeper publishes the distribution root — and since 2026-09-11 one key
is not enough to.** `Distributor.coSigner`, when named, makes
`publishRoot` require a signature by a second key over the exact root being
published. That key is not a second secret, it is a second COMPUTATION:
`offchain/src/cosign.ts` replays the epochs from its own node and signs only what
it reproduces, so the two machines have to lie the same way about a
deterministic, publicly repeatable calculation.

> **This paragraph said "one key is not enough to" without qualification until
> 2026-09-12, and for one day it was wrong** — in the same way it was wrong about
> "one 30-minute epoch" until the day before. `requestCoSignature` constrained
> nothing: not `coSigner != address(0)`, not `coSignerRequired()`, not that the
> epoch was over. So a keeper could bank a lapsed request at a moment when
> **nobody was able to refuse it** — `rejectCoSignature` reverts for every caller
> while `coSigner` is zero — and spend it later against a co-signer that was
> named, heartbeating and in force. Measured: **12.000 NVDA, 100 % of the
> undelivered balance, on one key** (`docs/AUDIT_EXECUTION_2.md` §1).
>
> **Closed the same day** (`docs/AUDIT_FIXES_2.md`): a request now needs a closed
> epoch, a co-signer in force, and a timestamp later than `coSignerNamedAt`. The
> sentence above is true again, and it is true of every root rather than of the
> ones nobody thought to bank in advance.

**What settled that design is the order of two transactions.** A thief holding
the keeper key sends `publishRoot` and `claim` with consecutive nonces in the
same block — nothing in `claim` times anything. No watcher and no freeze fits in
that gap, so whatever closes it has to sit before the publication.

**The requirement lifts itself after three hours of silence**
(`CO_SIGNER_GRACE`), and that clock runs on a heartbeat the co-signer writes
rather than on "no root published" — which would put the deadman under the
control of whoever holds the keeper key.

**And a veto has to be exercised to be kept.** The heartbeat covers a co-signer
that STOPS; it does not cover one that keeps beating and signs nothing, which
would block publication for the 48 h a removal takes. So the keeper puts the root
on the record (`requestCoSignature`), and if the same three hours pass without it
being signed, the single-key form accepts **that root and no other** — the key
commits to every field, to the Distributor and to the chain.

**"That root and no other" is about WHICH root, and until 2026-09-12 it said
nothing about WHEN.** Three things were unbounded and all three were doors: no
co-signer had to exist, the request never expired, and `upToEpoch` could name an
epoch that had not happened — so a request for an epoch weeks away was never
"overtaken", which is the argument the code gives for having no expiry. Each one
let the three hours of notice be spent on a day the keeper chose rather than on
the day of the theft. **All three are now refused at the door**, which is what
makes "slow and loud" a property rather than a hope: the clock can only start on
a closed epoch, against a key that is in force, and it dies when that key is
replaced.

**That record is a door for a compromised keeper too, and `rejectCoSignature`
is what shuts it.** A thief holding the keeper key would otherwise post their
forged root, wait three hours and publish alone — against the forty-eight a
rotation takes. So the co-signer, the one party that knows whether its own
silence was deliberate, can refuse a root outright, and a refusal never ages into
a lapse. `offchain/src/cosign.ts` watches the chain for these requests rather
than waiting to be asked, because a compromised keeper does not ask.

**One limit on that refusal, and it is structural.** It is available only to a
co-signer that already holds the role — there is no refusal at all while
`coSigner` is zero. That is why the contract, and not the watcher, is what stops
a request being banked in that state. `policeRequests` used to compound it by
starting its cursor at the current head and by advancing it over ranges it had
failed to read; since 2026-09-12 it backfills from genesis and refuses to move
past a query that did not answer (T2-OFF-01).

What that costs is the case where the co-signer is itself hostile: it can refuse
everything and block publication until the timelock removes it. Forty-eight hours
of delay against forty-eight hours of theft — and every refusal is a transaction
signed by its own key, so an operator can tell a second key that is BLOCKING from
one that is DOWN. The silence it replaces allowed neither. Removing the requirement through the
timelock is the other lever and it takes 48 h: ninety-six epochs on a protocol
that pays every thirty minutes, which is a failure and not a degradation.

**What an attacker needs.** The keeper key AND the ability to silence the
co-signer's host for three hours, during which the publication lag,
`quoteAtRisk` and the heartbeat all say so. **There is no longer a second case**:
until 2026-09-12 a root banked earlier needed only the key and one transaction of
about 25 000 gas, with nothing late, quiet or unusual at the moment of the theft.
`docs/AUDIT_FIXES_2.md` closed it — a clock may only be started on a closed
epoch, against a key that is in force, and it dies with that key.

`offchain/src/watch.ts` replays every published root and shouts on a divergence
— which is what covers the two states where the requirement is not in force: a
vault whose co-signer was never named, and one whose co-signer has lapsed.
**Those two states used to be where a request could be banked as well**, and the
watcher was in no position to notice: both of its look-back windows were 5 000
blocks — **515 seconds** measured on this chain, against a three-hour grace, so
**4.8 % of it** — and its governance cursor advanced over ranges it had failed to
read (T2-OFF-02). A `CallScheduled` fires once, 48 h before it lands, and a
watcher restarted after ten minutes down had already missed it. Both windows are
now derived from `CO_SIGNER_GRACE` at twice its width, and neither cursor moves
past a query that did not answer.

The contract still cannot verify a root by itself. A compromised key that also
holds the second one can publish a root that assigns itself what has not yet
been distributed. The
enforced ceiling is `Distributor.totalFunded(stock) − totalDistributed(stock)`,
clamped in `_one`, **per stock and for the whole undelivered history** — not one
epoch. This paragraph said "on the order of one 30-minute epoch" until
2026-09-11 and that was wrong: the push floor (~$10) means a holder below it is
never delivered to, so the standing balance is

```
(holders below the push floor) × pushFloor  +  one window in flight
```

An honest-cycle fork campaign peaks at three windows in flight
(`test/RootExposureInvariants.t.sol`), and `docs/recon.md` §6 records a Pons
token with 103 968 holders. The clamp is not narrowed because nothing on-chain
tells a thief's leaf from a dormant holder's — see `docs/ARCHITECTURE.md` §S29.
The timelock revokes the key in 48 h, which stops the next theft and not this
one. `offchain/src/dispute.ts` recomputes the root without asking anyone for
anything, and `offchain/src/check.ts` warns when `quoteAtRisk` passes eight
windows' funding.

**e. A leg large against its pool is priced by a constant — and the size of the
purchase is now capped on-chain, so the bound holds against anyone.** `FeeVault._legFloor` floors every leg at `MAX_SLIPPAGE_BPS` —
300 bps, a constant — while the purchase is `payoutBps` of the free reserve and
a single line may be 9 000 bps of it. Nothing in the contract compares the two.
A leg that is a few per cent of a pool therefore executes *inside* the band and
the vault eats the impact: measured, a 90 % MRVL leg of a 24 ETH reserve at
`MAX_PAYOUT_BPS` filled **2.78 % under the TWAP**, about $155 on one purchase,
with no attacker, no event and no revert.

It is not near that today and the distance is stated rather than asserted: the
steady state at $500k/day of volume is a reserve of ~$8.3k and a purchase of
~$333, which moves the same pool by ~11 bps. The band starts to matter at a free
reserve of **$443k at `payoutBps = 400`** or **$177k at the `MAX_PAYOUT_BPS`
ceiling** — reached by a quiet stretch, since nobody is paid to call `buyBasket`
below ~$136 of bounty, or by a timelock that raises `payoutBps`.

**Two guards, and only one of them binds a stranger.** Reading the pool's depth
inside `_legFloor` was built and measured at **+876 bytes**, which lands
`FeeVault` at 24 842 against a 24 576 cap: it does not deploy. So the depth is
not what is read.

- **On-chain, and this is the one that binds everyone** (`MAX_BUY_MULTIPLE`,
  since 2026-09-11): one purchase may spend at most forty `MIN_BUY_QUOTE`, about
  $1,000. No oracle and no pool read — `MIN_BUY_QUOTE` is already a per-vault
  dollar-denominated quantity. Measured at the pinned block, the 24 ETH case at
  `MAX_PAYOUT_BPS` goes from 2.4 ETH of purchase filling **278 bps under the
  TWAP** to 0.4 ETH filling **64 bps under it**, of which 30 is the pool's own
  fee — so about **34 bps of real impact**, a ninth of the 300 bps band. The
  steady-state purchase is untouched even with `payoutBps` at its ceiling: 0.129
  ETH against a 0.4 ETH cap.
- **Off-chain, finer**: `offchain/src/keeper.ts` re-measures each leg's pool per
  purchase and shrinks `amountIn` so that no leg spends more than one whole +1 %
  depth. `docs/allowlist.md` carries the derivation and why the figure is
  re-measured rather than read: the same MRVL pool photographed at $5 312 on
  2026-09-08 read $842 three days later.

**Nothing is stranded and nothing is gated.** What the cap does not spend stays
in the reserve and the next window takes another slice, through a call anybody
may make — one purchase covers one window, so the cap allows 48 × $1,000 a day
against the ~$16k/day of rewards a $500k/day token produces.

**What is left, and it is why this paragraph is still in §7:** the cap is a
CONSTANT, so a basket of deep pools is capped when it did not need to be. That is
paid in extra calls, never in stranded money. A per-vault parameter is the right
shape and measured **+258 bytes, 169 over the CI gate** against this one's +74 —
revisit it the day a trim frees the room.

**d. Key custody — and two of the four keys cannot be rotated at all.**

The rotations that exist, stated so nobody has to go looking:

| key | replaceable? | how |
| :--- | :--- | :--- |
| **keeper** | **yes** | `Distributor.setKeeper` (timelock or the vault's registry), `Payd.rotateKeeper(from, to)` in bulk, `Payd.allowKeeper(who, false)` for the registry-wide set. 48 h — and with a co-signer in force, a compromised keeper can steal nothing while they run — banking a request in advance was a way round that until 2026-09-12, and a rotation now clears what the replaced key left pending (`coSignerNamedAt`) |
| **co-signer** | **yes** | `Distributor.setCoSigner`, `Payd.rotateCoSigner(from, to)`. 48 h — and it cannot hold the vault shut in the meantime, see `requestCoSignature` above |
| **timelock** | **NO — and there is no separate key to compromise either** | There is no `setTimelock` anywhere in `contracts/`. `Payd.TIMELOCK` and `Treasury.TIMELOCK` are `immutable`; elsewhere it is storage written once in `init`. **And the timelock has no admin**: `contracts/Timelock.sol` hard-codes `address(0)` as the fourth constructor argument, so no account outside it holds `DEFAULT_ADMIN_ROLE`. "A compromised timelock" is therefore not a thing on its own — it is **the Safe**, which is the sole proposer. See the paragraph below |
| **generation key** | **NO** | `immutable` in both `Payd` and `Treasury`. Alone it does nothing: it approves and never triggers |

So **a compromised timelock is terminal for the vaults that already exist**, and
that is the assumption below rather than an oversight.

**And it is worse than "for as long as the Safe is held", which is the part
worth being precise about.** `TimelockController`'s constructor grants
`DEFAULT_ADMIN_ROLE` to the timelock itself, so the Safe reaches `grantRole`,
`revokeRole` and `updateDelay` through it. At one 48-hour delay each, a Safe
acting against the protocol can:

1. `grantRole(PROPOSER_ROLE, x)` — `x` proposes in its own right, and recovering
   the Safe afterwards no longer removes it;
2. `revokeRole(PROPOSER_ROLE, safe)` — the legitimate Safe is gone;
3. `updateDelay(0)` — and nothing is announced in advance ever again.

Every one of those is public for a full delay before it can execute, and
**that announcement is the entire defence**. Until 2026-09-12 nothing read it:
`offchain/src/watch.ts` now watches the timelock's `CallScheduled` and
`MinDelayChange` and shouts, loudest on those three. A 48-hour warning nobody is
listening to is not a warning. It is also why the three
doors that move value to a named address need the Ledger as well: one key of the
two is not enough for any of them.

Everything above assumes that the Safe's signers and the
holder of the Ledger do not collude against the protocol, and that the Ledger is
stored elsewhere. No code protects against that. What the code guarantees is that
none of these powers is exercised **without public notice**, and that none of them
aims at an address chosen at call time without two distinct authorities having
named it.

### What has disappeared from this list

There used to be a **successor chain** here: `Payd.setSuccessor` designated the
next generation's registry and `recognised` walked it, so that `FeeVault.migrate`
would accept a vault from another generation. It was the largest residual hole:
`setSuccessor` accepted any address, and five lines answering `isVault(x) = true`
for every `x` opened the migration — hence the future stream **and** the reserve
of any vault — onto anything. Nothing could close it, since everything you read
on an unknown contract is written by that contract.

It only existed because the implementations lived **inside** the registry, as
`immutable`s: a new version of the vault code forced a new registry, hence a
bridge between two registries. Now that `DistributionFactory` carries them, a new
version is a new factory and its vaults are born in the **same** registry. So
`migrate` now queries `isVault`, written by `_create` and by nothing else.
**The chain, the function and the power have been removed.**

Beside it, one bound that was added rather than removed: `migrate` also compares
the two vaults' **payout mode**. `isVault` says the destination was born here; it
does not say it pays the same way. Today only one mode exists and the two
questions have the same answer — the day a second factory builds something else,
they do not, and one timelock operation would move a pro-rata stream into another
promise. The mode is declared by the factory that built the vault
(`DistributionFactory.MODE`) and stamped at birth by `Payd._create` (`modeOf`), so what
is compared is what the two vaults promise and **not** which deployment made
them: a new version of the same mode still migrates, which is the whole point of
the function.

That bound has one key, and it is not the timelock's. `Payd.crossModeMigration`
is `false` from birth — no constructor argument, nothing to get wrong on
deployment night — and only the **generation key** moves it. Flipping it migrates
nothing and moves no wei: it lets the timelock schedule a cross-mode migration
that must still clear its 48 h and still satisfy every other condition of
`migrate` — same token, same creator, same quote, and a split no worse for the
holders. So the property holds here as everywhere else: the cold key authorises
and never acts, the timelock acts and cannot authorise itself, and one
compromised key moves no holder into a promise they did not buy.

What it does not do, stated plainly: while it is open it is open for **every**
vault in the registry, not for the one being migrated. It is meant to be opened
for one operation and shut after it — the same call with `false`, effective at
once — and nothing enforces that discipline. Making it self-closing would mean
letting a vault write into the registry, which is a door of its own and a worse
one.

What that costs, and it is owned: if `Payd` itself turned out to be broken, its
vaults could never migrate again. It holds not a wei and a vault never calls it
again after its birth — except there — so a broken registry blocks no funds.

---

## 8. Reconstructing the flows from the chain

| Event | Contract | What it says |
|---|---|---|
| `Wired(timelock, devWallet, generationKey)` | Treasury | the destinations and the authorities, announced at birth |
| `Split(toDev, toBurn, toLp, toRewards)` | Treasury | every split, pocket by pocket |
| `DevPaid(to, amount)` | Treasury | **every wei paid to the dev**, with the address |
| `LiquidityAdded`, `Burned`, `PlatformRewardsFunded` | Treasury | the three exits that stay inside the system |
| `Swept(token, amountIn, ethOut)`, `Collected(vault, amount)` | Treasury | the third currencies converted and recovered |
| `PlatformApproved`, `PlatformBound`, `TreasuryApproved`, `TreasuryMigrated`, `Pushed` | Treasury | the wiring and the succession, on both sides |
| `Harvested(gross, refund, toRewards, toCreator, toPlatform)` | FeeVault | every harvest and its split |
| `CreatorPaid(to, amount)`, `PlatformPaid(to, amount)` | FeeVault | the payments to the creator and to the platform |
| `BasketBought`, `LegSkipped` | FeeVault | every stock purchase |
| `Migrated`, `ReserveMoved(to, quote, pivot)` | FeeVault | a vault migration and what it carried away |
| `Approved`, `FactorySet`, `VaultCreated` | Payd | the lineage of approved factories, and every vault minted |
| `WindowFunded`, `RootPublished`, `Delivered`, `DeliveryFailed` | Distributor | what was credited, promised, delivered |
| `GasRefunded`, `PaymentDeferred`, `Withdrawn` | both | refunds and deferred payments |

Two tests hold this property rather than describing it:
`test_EveryWeiToTheDevIsLogged` compares the sum of the `DevPaid`s to the
balance's real movement, and `test_EverySplitIsLogged` checks that the announced
split adds up to the total received (`test/DevPathInvariants.t.sol`).

---

## 9. Checking for yourself

```bash
forge test --fork-url $RPC_URL_FALLBACK --compute-units-per-second 60 -j 1
```

The tests run against the chain's **real state**: the Pons curve, the Uniswap
pools and the stock tokens are not simulated. A test that only passes thanks to a
simulation of Pons or Uniswap is refused by project convention (`docs/CONVENTIONS.md`).

| File | What it holds |
|---|---|
| `test/DevPathInvariants.t.sol` | the attacker **is** the timelock and the Ledger, together; 720 calls per campaign; the dev's balance never exceeds its share, nothing leaves through an uncounted door, the dev share does not go back up |
| `test/Treasury.t.sol` | the four pockets, the buyback against the real curve, the liquidity against the real pool, the two-key wiring, the sweep of third currencies, the succession |
| `test/Payd.t.sol` | the lists, the registry, the two-key factory, and that a new version of the vault code stays in the same registry |
| `test/Launch.t.sol` | a vault migration carries the reserve and leaves the stocks |
| `test/Invariants.t.sol` | we never distribute more than we funded |

---

## 10. Revision history

**2026-09-12 (b) — and it was closed the same day.**
`docs/AUDIT_FIXES_2.md`. `requestCoSignature` now refuses a clock that no key
could answer: the epoch must be closed, the co-signer must be in force, the
request must postdate `coSignerNamedAt` (a new slot), and it may not be made in
the block the key was named in. `Payd` gained the role-collapse guard its own
`Distributor` always had, on both setters, plus an event when `_create`'s stamp
does not land — the silent version of that failure was the same finding one level
up. **That event is gone and the stamp is HARD since the same evening**: a vault
whose Distributor cannot take the registry's co-signer is not created at all
(`CoSignerStampFailed`). An event made the failure observable and made the
guarantee depend on somebody subscribing; nothing did. Reverting makes the state
unreachable, which is the version that needs no watcher. Off-chain, neither watcher's cursor advances over a range it failed to read,
and both look-backs are derived from `CO_SIGNER_GRACE` instead of being 5 000
blocks.

All seventeen tests of `test/CoSigner.t.sol` — the mechanism's own, written by
its author — pass unchanged. One fixture line moved and no assertion did, which
was the condition set before the fix was written: a fix that needs its own test
edited is a fix that moved the mechanism rather than the hole. The suite is
**328 / 0 / 0** with no `AUDIT_RED` gate anywhere.

**2026-09-12 (a) — §7.c claimed more than the code delivers, and §6 and §7.d
repeated it.**
"Since 2026-09-11 one key is not enough to" was written the day the co-signature
landed and it was true of the mechanism as designed. It is not true of
`requestCoSignature`, which constrains **none** of its arguments and none of the
contract's state: a keeper banks a lapsed request while `coSigner` is zero — or
while it is lapsed, the state `CO_SIGNER_GRACE` deliberately tolerates — and
publishes that root alone afterwards, with the second key named, heartbeating and
in force. Measured at **12.000 NVDA, 100 % of the undelivered balance, on one
key** (`docs/AUDIT_EXECUTION_2.md` §1). `rejectCoSignature` cannot answer it: it
requires the role that did not yet exist, and `policeRequests` starts its cursor
at the current head.

Three statements were corrected rather than softened — the §7.c heading, the
"an attacker needs the keeper key AND to silence the host for three hours"
sentence, and §7.d's "a compromised keeper can steal nothing while they run" —
and §6's `requestCoSignature` row now says what the function does not check. The
defect itself is **open on the frozen tree** and is `docs/LAUNCH_2026_12_09.md`
§3, which says **no-go** until it is closed; this file records the bound, not the
fix.

**The pattern is the one this section already shows twice.** §7.c said "on the
order of one 30-minute epoch" until 2026-09-11 and said "one key is not enough"
until 2026-09-12. Both were sentences about a mechanism written by the person who
had just written the mechanism, and both were corrected by somebody re-deriving
the bound instead of reading it. That is what §7 is for.

**2026-09-10 (b) — the LP hatch was deleted, not narrowed.**
`Treasury.withdrawLp` and the `LP_SAFE` immutable are **gone**, along with the
`LpWithdrawn` event and the `lpSafe` field of `Wiring`. The hatch sent the LP
pocket to a Safe in the one state `addLiquidity` refuses — before graduation,
when there is no pool to place liquidity in. It had been narrowed twice (§10,
2026-09-09 (a)) and both narrowings missed the point: what it was, in any window,
was **a permanent path from this contract to an address the maintainer
controls**. Deleting it takes the exits that reach the maintainer from three to
two, and it is the only change that turns "the LP share will not be diverted"
from a promise into an absent function.

The accepted cost, stated rather than buried: if the platform token never
graduates, `lpPool` accumulates with nothing to spend it and that ETH is
immobilised for good — `setSplit` reweights future inflow, not a pocket already
allocated. In a world where the platform token never graduates, a sixth of a
Treasury nobody filled is not the problem.

What replaced the tests: `test_TheLpPocketHasExactlyOneExit` walks the whole
permissionless surface (`payDev`, `buyAndBurn`, `fundPlatformRewards`, `split`)
and asserts `lpPool` is unchanged by every one of them, then that `addLiquidity`
spends it. `DevPathInvariants` closes its balance sheet over two exits instead of
three.

**2026-09-11 — the registry stopped holding one mode's parameters.**
Three things left `Payd`, and the same sentence explains all three: what it
validates must be true of every mode, not of the first one.

The **epoch bounds** are a `Distributor` cadence and now live in
`DistributionFactory` — a mode without epochs never reads the argument. An
**empty basket** is legal: a basket is the distribution mode's parameter, and
requiring one forced every future mode to be handed a stock it would never buy.
A basket that IS presented is still checked entry by entry against the stock
allowlist, which is governance's; and the distribution mode still refuses an
empty one, one step later, in `FeeVault.init`. Finally **`bytes modeData`** gives
the launcher's per-launch parameter a home: forwarded by `createVaultWith` and
`createVaultFor`, never decoded here, and refused rather than ignored by a mode
that has none.

`createVaultFor` was widened at the same time and it is the only power change on
this line. It was wired to the default factory, to native ETH and to an empty
`modeData`; its whole job is to give a MIGRATION a destination when the launcher
will not or cannot make one, and those three constants put every vault of a
secondary mode, every non-ETH vault and every mode with a per-launch parameter
out of reach of any migration its launcher did not perform in person — for ever,
a vault's code being fixed at birth. It gains the same `FactoryNotEnabled` gate
as `createVaultWith`: the timelock still picks among the modes BOTH keys
admitted, and still cannot exceed the 15 % cap nor go under the holders' floor.

`Payd.factory` is typed `IVaultFactory` rather than `DistributionFactory`, and
`VaultFactory` was renamed `DistributionFactory` — the registry must not speak
one mode's type, nor carry its name.

The same day and for the same reason, **the two allowlists stopped being
Uniswap v3 shaped**. `_requirePool` is a v3 guard and both lists are read by
every mode, so a mode settling on v4 — or paying with no swap at all — could not
get a line listed without inventing a tier for a pool it would never touch. A
tier of **zero now declares "no v3 route"** and skips the guard; a non-zero tier
is measured against a live pool exactly as before, so the deployment-time
guarantee still holds for every line that declares one. The distribution mode
fails closed on the rest: `FeeVault._setAllocations` refuses a basket line at
zero that is not the pivot, and `FeeVault.init` already refused a quote with no
route. What changes for that mode is only WHEN it learns — at the vault's birth
instead of at the listing — and only for a line somebody listed at zero
deliberately.

**2026-09-10 (a) — payout modes, and a fourth door for the Ledger.**
`Payd` becomes an interface over **several** factories rather than a pointer to
one: `factoryMode` records each admitted factory and the mode it declares
(`DistributionFactory.MODE`), `enableFactory` admits one without moving the default,
`disableFactory` stops one building, and `createVaultWith` lets a launcher build
through any admitted one. Each vault is stamped with its factory's mode at birth
(`modeOf`), and `FeeVault.migrate` gains a seventh condition: **the destination
must promise the same thing.** Written before a second mode exists rather than
after, because the check lives in the vault and a vault's code is fixed at birth —
every vault registered before the field existed would have carried the version
that cannot compare.

The one thing that lifts that condition is `crossModeMigration`, **shut from
birth and held by the generation key alone** — a fourth door for that key, and
the first that moves nothing by itself: the timelock must still call `migrate`
and still clear 48 h. While open it is open for every vault in the registry, and
nothing enforces that it is shut again. §7.b, and `docs/ARCHITECTURE.md` §S46.

**2026-09-09 (c) — the split, and the removal of the largest power.**
`Launchpad` becomes `Payd` (a registry, not a launcher: the launcher is Pons) and
the cloning machinery moves out into `DistributionFactory`. Two consequences: its
initcode goes from 54 635 to 18 704 bytes — it was over the EIP-3860 cap — and,
above all, a new version of the vault code no longer demands a new registry. The
successor chain, its function and the power it carried have been **removed**;
`migrate` now validates its destination through `isVault`, which cannot be
forged. A second authority — the generation Ledger — guards the three remaining
doors.

**2026-09-10 (b) — the sweep reached WETH, the quotes route through USDG.**
The fix below converted a token to ETH in **one hop, `token -> WETH`**, and the
currencies a vault may be quoted in are measured against the **PIVOT**. For most
of them no `token/WETH` pool exists at all: measured on the 41 rows of
`Quotelist`, **ten had no way out** — IBM, BABA, USO, DELL, PLTR, FIG, PFE, RIVN,
UPS, and JNJ whose pool holds no 30-minute window. Each list was correct on its
own; they disagreed with each other, which is why no pool measurement saw it and
`test_EveryListedQuoteCanLeaveTheTreasuryAsEth` did — it sweeps a real Treasury
holding each currency in turn.

`sweepToEth` now takes `token -> PIVOT -> WETH` when that is the route the row
declares, on the pools the quote already crosses; the second hop is the
`USDG/WETH` pool every ETH-quoted vault uses. **The remedy was one hop, not ten
delistings.** `allowSweep` became the batch `allowSweeps`, with one tier per
route and exactly one route per row, and the list is **seeded in the Treasury's
constructor** — derived from `Quotelist`, not written a second time — because the
48 hours protect changes, not the initial state. Still no destination in any
argument.

**2026-09-09 (b) — the third currencies.**
`FeeVault._pay` sends the platform share in the vault's currency. The Treasury
only knew about ETH: ~59 % of the platform's revenue (22.0 % USDG + 37.2 % stock
tokens, measured 2026-09-08) landed in a contract unable to see it, with no
withdrawal to recover it. `sweepToEth` converts them under a TWAP floor,
`collectFrom` recovers a payment that had failed. Neither takes a destination.

**2026-09-09 (a) — audit of the flow invariants.**
Four paths by which funds could reach a developer-controlled address were closed:
the holders' pocket destination was named after the fact by the Safe alone (it
now takes two keys); `setSplit` accepted `dev = 100 %` (ratchet); `withdrawLp`
stayed open for life as long as nobody named the token (narrowed then, deleted
outright on 2026-09-10 — see below); adding liquidity computed its limit on the block's
price (it now anchors on the price of the last buyback). An accounting defect was
found along the way: on a vault whose currency **is** the pivot currency,
`fundRewards` re-credited `pivotReserve` a second time.

In the same revision, `FeeVault.migrate` stopped moving nothing: it now carries a
vault's unconverted reserve over to its successor, so that a migrated vault
produces from its very first transaction. The stocks already bought stay at the
`Distributor`, claimable forever.
