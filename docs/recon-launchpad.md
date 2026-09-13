# recon.md — what was read on-chain, and when

Repository rule: not a line of code against an assumed address or ABI.
Everything that follows was read on **Robinhood Chain, chainId 4663**, with
`cast`, on the date given. The measurements that required writing were made on an
**anvil fork** of the real state, never on the chain.

Payd's recon — [`recon.md`](recon.md), 1 153 lines — remains the reference for
everything that does not concern the launchpad. This file does not copy it: it
completes it and, on one point, corrects it.

---

## 0. The base layer, re-checked on 2026-09-07

Nothing has moved since Payd's recon (2026-09-03/04). Block 57 169 469.

| | |
| :--- | :--- |
| `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| `V2FeeEscrow` | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| `V2MemeHook` (`factory.memeHook()`) | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |
| `launchForwarder()` | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| `owner()` (Pons) | `0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd` |
| `launchEnabled()` | `true` |
| `launchFee()` | `5e14` (0.0005 ETH) |
| `maxCreatorTaxBps()` | `1000` (10 %) |
| `launchConfigCount()` | `1` |

---

## R6 — The getters `economics()` and `hookStatus()` depend on

**This was the only question capable of moving the design. All three answers are
good.**

### R6.a — Pons's variable share is readable ✅

```
cast call 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044 "protocolFeeShareBps()(uint256)"
  -> 3000
```

On the **hook**, not on the factory (the call reverts there). `economics()` can
therefore recompute the real share on every read, without ever hard-coding it.

### R6.b — `curveFeeBps` is readable ✅

`getLaunchConfig(0)` returns 7 words. The second is `0x64` = **100 = 1.00 %**.

```
w0 033b2e3c9fd0803ce8000000  1e27      supply, one billion
w1 0000…0064                 100       curveFeeBps            <- what we were after
w2 0000…17508f1956a80000     1.68e18
w3 0000…3a4965bf58a40000     4.2e18    graduationThreshold
w4 0                                    
w5 0000…00c8                 200       tickSpacing
w6 1
```

**Consequence: the formula in §4 of the PLAN is entirely derivable on-chain.**

```
gross(% volume) = creatorTaxBps + curveFeeBps x (1 - protocolFeeShareBps)
                = tax          + 100         x (1 - 0.30)      = tax + 0.70 %
```

### R6.c — The pending recipient is readable, **and it expires** ✅

The getter is not in the published ABI (the explorer sits behind Cloudflare for
scripted requests). It was found by extracting the dispatcher's 162 `PUSH4`
constants and testing candidates:

```
pendingCreatorFeeRecipient(address)  =  0x9beacf4a   present
```

Semantics established **on a fork**, by impersonating the Pons owner to propose
redirecting $PAYD to `0x…dEaD`, then advancing the clock:

```
pendingCreatorFeeRecipient(token)
  -> (address pendingRecipient, uint256 effectiveAt, uint256 expiresAt)

  effectiveAt = proposedAt  + 3 days      execute before -> revert 0x810c4f2a(effectiveAt)
  expiresAt   = effectiveAt + 3 days      execute after  -> revert 0xb79d40e8(expiresAt)
  in between                              execute OK
```

**A new fact, absent from Payd's recon: the proposal expires.** The execution
window lasts exactly 3 days. Past that, the proposal is dead and a new one has to
be made — hence a new 3-day notice.

That still gives us **no veto** — `CREATOR_FEE_RECIPIENT_TIMELOCK()` =
259 200 s, and the current recipient moving does not cancel the proposal
(verified: the pending one survives a `transferCreatorFeeRecipient`). But it
bounds the threat, and it gives `hookStatus()` its third value: past `expiresAt`
with no execution, the status **goes back to `Hooked` on its own**.

---

## R5 — One vault per token: confirmed by the escrow's bookkeeping ✅

The escrow knows **only the recipient**, never the launch. Selectors present in
its bytecode (19 in all):

```
OK  balanceOf(address)                      claim()
OK  balanceOfToken(address,address)         claimToken(address)
--  balanceOfLaunch(address,address)        absent
--  claimLaunch(address)                    absent
```

A recipient serving two launches would receive **one aggregated number, with no
breakdown**: it would be impossible to give each community what is theirs. **One
vault per token is not a preference, it is a constraint of the escrow.**

---

## R3 — The creator tax

`maxCreatorTaxBps() = 1000`. No minimum on Pons's side. The `MIN_TAX_BPS` floor
of PLAN §4 is therefore **our** rule, and ours to carry.

---

## R2 — The v4 swap path: still open

Not measured: it is only needed after $PLAT graduates (threshold 4.2 ETH), and
`buyAndBurn()` goes through the curve before that (PLAN D3). To be done before
graduation, not before v1.

---

## What Payd's real state teaches — and what it means for the design

Read on 2026-09-07 on the chain, not on a fork:

```
getLaunchedToken(0x427a1E8C…)   $PAYD
  deployer             0x55cB4f83…   the Safe
  creatorFeeRecipient  0x55cB4f83…   the Safe        <- NOT the FeeVault
  creatorTaxBps        400
  phase                0             not graduated yet
  sweptQuote/Tokens    0 / 0

FeeVault 0xF688201E…
  token()              0x427a1E8C…   the vault IS bound
  escrow.balanceOf()   0
```

**The vault is bound to the token, and it is no longer the fee recipient.** The
two states coexist without contradicting each other: `bind` is single-use and
never re-checks anything afterwards. The only path that leads there is
`emergencyRedirect()`, which sends the stream to `DEPLOYER` — the Safe.

That is the demonstration, on this code's only living deployment, of what the
PLAN asserted in theory:

1. **`vault.token() != 0` does not prove that the fees still arrive.** A front
   end displaying "this token distributes stocks" from the binding alone would be
   lying. Hence `hookStatus()` (PLAN §5), which re-reads the effective recipient
   on every call rather than trusting the binding.
2. **`emergencyRedirect() -> DEPLOYER` is not a theoretical risk.** On a
   launchpad where `DEPLOYER` was the token's creator, that same function would
   hand them back the stream promised to their holders. That is what `migrate()`
   replaces (PLAN D6).

> To confirm with the Payd team: deliberate redirection (putting the launch to
> sleep) or an incident? The answer does not change the two conclusions above,
> which follow from the mechanism and not from the intent.

---

## Method, for replaying

```bash
set -a; . .env; set +a          # RPC_URL

cast call $FACTORY "getLaunchedToken(address)" $TOKEN --rpc-url $RPC_URL
cast call $HOOK    "protocolFeeShareBps()(uint256)"   --rpc-url $RPC_URL
cast call $FACTORY "getLaunchConfig(uint256)" 0       --rpc-url $RPC_URL

# the selectors missing from the published ABI
cast code $FACTORY --rpc-url $RPC_URL > factory.bin
#   -> extract the PUSH4s (regex 63xxxxxxxx), compare to `cast sig "candidate(...)"`

# the measurements that write, on a fork only
anvil --fork-url $RPC_URL --port 8546 --auto-impersonate --compute-units-per-second 60
cast send $FACTORY "setCreatorFeeRecipient(address,address)" $TOKEN $NEW \
     --from $PONS_OWNER --unlocked --rpc-url http://127.0.0.1:8546
cast rpc anvil_setNextBlockTimestamp <ts> && cast rpc anvil_mine
```

---

## ERC-8056 — measured on 2026-09-08, and it fixes a bug

The tokenised stocks are **ERC-8056 "Scaled UI Amount"**: an ordinary ERC-20 plus
a display multiplier.

```
balanceOfUI(a)  = balanceOf(a) * uiMultiplier() / 1e18
uiMultiplier()  = 0xa60bf13d      newUIMultiplier() = 0xdc767007      effectiveAt() = 0x97a4064f
```

`balanceOf` **never moves** when the multiplier changes: a raw unit is neutral
across a split. So snapshots, bookkeeping and transfers in raw units stay correct
— which is what Payd established in recon §2.4.

**But the economic value of a raw unit does change.** A Chainlink feed quotes the
price **per share**, not per raw unit. After a 4:1 split (`uiMultiplier = 4e18`),
one raw unit is worth 4 shares.

### The measurement

| | |
| :--- | ---: |
| Tokens exposing `uiMultiplier()` | **194 / 194** |
| Multiplier ≠ 1 today | **11** |
| … of which in the proposed allowlist | **7** |
| Scheduled change (`newUIMultiplier`) | none |

```
SGOV  x1.0051     depth 1 997 598 $   allowlist
MU    x1.00007    depth   249 597 $   allowlist
COST  x1.00061    depth   159 557 $   allowlist
DELL  x1.00006    depth    52 629 $   allowlist
AAPL  x1.00057    depth    32 666 $   allowlist   <- and in Payd's basket
UPS   x1.00221    depth    10 370 $   allowlist
F     x1.00015    depth     9 360 $   allowlist
CCL   x1.02149    depth     2 071 $
CRWD  x4          no pool             <- a real 4:1 split, already happened
```

### The bug, exactly

`FeeVault._oracleOut` (Payd):

```solidity
return (amountIn * uint256(ethUsd)) / uint256(stockUsd);   // price PER SHARE
```

No multiplier. So the Chainlink floor assumes **1 raw unit = 1 share**. Since the
floor only ever *tightens* (`if (oracleOut > floorOut) floorOut = oracleOut`),
the error always errs on the side of refusal:

| multiplier | floor overstated by | effect |
| :--- | ---: | :--- |
| ×1.00057 (AAPL, today) | 0.057 % | absorbed by `MAX_SLIPPAGE_BPS = 300` |
| ×1.02149 (CCL) | 2.15 % | absorbed, but eats 72 % of the slippage budget |
| **×4 (CRWD, a real split)** | **300 %** | **`TooLittleOut` on every purchase, permanently** |

And the failure is **silent**: the weighted rotation simply skips that
allocation, the epoch is lost, and the stock's weight disappears from the rewards
with nothing flagging it.

Nothing breaks today — the eleven deviations are dividend reinvestments, not
splits. But CRWD proves that splits happen on this chain, and 7 of the
allowlist's 49 stocks already have a multiplier ≠ 1.

### The exact semantics of the three getters, measured on 2026-09-08

They had to be read before writing the guard, because they are not the ones one
assumes:

```
                uiMultiplier   newUIMultiplier   effectiveAt
NVDA            1.0            1.0               0
AAPL            1.00057        1.00057           1786720366   (past)
CRWD            4.0            4.0               1782999000   (past)
CCL             1.02149        1.02149           1788189026   (past)
```

- **`newUIMultiplier()` holds the CURRENT multiplier when nothing is scheduled**,
  not zero and not absent. A pending change is therefore written `next != m`, and
  not `next != 0`;
- **`effectiveAt()` alone means nothing**: it keeps the date of the LAST applied
  change, which is in the past. Reading it without the condition above would fire
  the guard permanently on AAPL, CRWD and CCL;
- none of the 194 tokens has a scheduled change today.

### The fix

```solidity
// price per RAW UNIT = price per share x uiMultiplier / 1e18
uint256 m = _uiMultiplierNow(a.stock);
if (m == 0) return 0;                                  // corporate action window
return FullMath.mulDiv(amountIn, uint256(ethUsd) * ONE, uint256(stockUsd) * m);
```

With two rules taken from StockBound, which handled them well:

1. **A read that degrades.** `_staticUint` returns the default value if the token
   reverts, returns garbage, or does not have the function — and the gas is
   capped at 30 000. **A broken or malicious stock must never be able to block a
   vault.**
2. **A corporate-action guard, ±1 h around `effectiveAt`.** Chainlink switches
   from the pre-split price to the post-split one at a moment that has no reason
   to coincide with the token's own `effectiveAt`.

**But we do not block the epoch: we degrade to the TWAP alone.** StockBound
blocks its swaps during the window; we do not need to, because **a TWAP is
denominated in raw units on both sides of the pool** and a multiplier never moves
those. So the floor does not vanish with the feed — that is exactly the rule a
stale feed already follows (§S3), and it avoids losing an epoch to a corporate
action.

> The front end must display `balanceOfUI`, never `balanceOf`. That was already
> written in Payd's recon, and it stays true.

---

## The Pons curve is a constant product — measured on 2026-09-08

This had to be known before writing `Treasury.buyAndBurn`: if the curve is
`x·y = k`, the contract computes its own floor; if not, it has to be given one,
and "the `minOut` supplied by the caller" is exactly what sank StockBoundRH
(`PLAN.md` §10).

Measured on $PAYD's curve (`0xb138c1a5…`), not graduated:

```
getReserves()          quote 1 696 832 467 057 773 342
                       token 990 080 065 425 103 500 421 393 610
buy(0.01 ETH)  simulated  ->  5 512 267 276 820 221 900 767 534
```

Constant product with a fee `f` taken on the input:

```
out = tokenReserve x in(1-f) / (quoteReserve + in(1-f))
```

Solving for `f`: **exactly 500.0 bps.** That is the creator tax (400) plus the
curve fee (100), i.e. the 5.00 % the trader pays — the same decomposition as
§1.9. Which leaves:

| | |
| :--- | ---: |
| predicted | 5 512 267 276 820 221 900 767 534 |
| measured | 5 512 267 276 820 221 900 767 534 |
| difference | **0** |

**Consequence for v1:** `buyAndBurn` derives its floor from `getReserves()`, from
`creatorTaxBps` (launch record) and from `curveFeeBps` (`getLaunchConfig(0)`),
all read on-chain. No caller `minOut`, hence no sandwich fountain — and since the
curve has no external liquidity, the only possible deviation is another purchase
landing between the read and the execution, which a tight tolerance covers.

> Valid **before graduation only**. After it, the fees come from the v4 hook and
> the purchase goes through a Uniswap v4 pool — that is R2, and it is still open.

---

## R1 and R2 — the v4 hook keeps nothing, measured on 2026-09-08

A Uniswap v4 hook's permissions are encoded in the **low bits of its address**.
For `V2MemeHook` (`0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`):

| | |
| :--- | :--- |
| `BEFORE_INITIALIZE` | yes |
| `AFTER_SWAP` + `AFTER_SWAP_RETURNS_DELTA` | yes |
| `BEFORE_SWAP` | **no** |
| the four liquidity flags | **no** |

Read that way, the hook does one thing: take its cut **after** a swap. It gates
neither swaps nor liquidity.

### Verified rather than deduced

`test/V4Swap.t.sol` executes the full v4 dance — `unlock`, then inside the
callback `swap`, `settle` what we owe and `take` what we are owed — on `SQUEEZE`
(`0xD0782C13…`), a Pons launch that really graduated (phase 2), paired in native
ETH:

```
0.05 ETH  ->  1 438 487 286 892 423 953 799 591 SQUEEZE
```

**An ordinary caller gets there.** Therefore:

- **R2 is open**: `Treasury.buyAndBurn` can buy after graduation. What remains is
  not a permission, it is a **floor** (see below);
- **R1 is open too**: nothing in the hook prevents adding liquidity. Automatic LP
  becomes an implementation question (v4 `PositionManager`, a position to manage,
  an NFT held by the `Treasury`), no longer a permission question.

### The real remaining obstacle: there is no oracle for $PLAT

Before graduation the floor is exact — the curve is deterministic. After it, the
price comes from a v4 pool, and:

- **v4 has no built-in oracle** the way v3 did. The Pons hook does not provide
  one either;
- **there is no Chainlink feed** for a memecoin. Unlike a child vault's stocks,
  which have both a v3 TWAP *and* a feed.

The pool's `slot0` gives the **spot** price, manipulable within the block — using
it as a floor is StockBound's defect under another name.

### A LIMIT, not a floor — and it is measured

A floor would have deadlocked, and precisely when things are going well: if the
price rises more than the band, the purchase reverts, and since the reference
only updates on success, **it stays stuck for good**.

A v4 `sqrtPriceLimitX96` does not revert, it **fills partially**. Verified on
SQUEEZE's graduated pool, with a limit at 99.9 % of the price:

```
offered  0.05      ETH
spent    0.00538   ETH   (10.8 %)
returned the rest, intact
```

So the burn always runs: it buys what fits, keeps the rest, and the reference
walks toward the true price. Self-repairing rather than stuck.

**The cooldown IS the TWAP's window.** Record the price obtained at the previous
burn and require the next one to stay within X % of that reference. It is at
least 4 hours old, so manipulating it means holding the price moved for that
whole time — not manipulating it within a block. The first burn after graduation
takes the curve's last price as its reference, which is known.

The band widens with elapsed time — an old reference deserves less trust — and it
is capped so that a long outage does not leave the first burn back entirely
exposed.

What it risks at worst stays bounded: the burn pocket is the platform's money,
not the holders' stocks.

> **`slot0` is read through `extsload`, slot 6.** v4 exposes no price getter.
> `_pools` is at slot 6 of the PoolManager and a pool's first word packs
> `sqrtPriceX96` into its low 160 bits — probed against the chain
> (`sqrtPriceX96 = 4.357e32`, tick 172258 on SQUEEZE), not read from a layout
> document.

---

## A graduated Pons pool has `poolFee = 0` — measured on 2026-09-08

Read on the two graduated launches found on the chain:

```
SQUEEZE  0xD0782C13…  phase 2  poolFee 0  tickSpacing 200
HASH     0x260dECCF…  phase 2  poolFee 0  tickSpacing 200
```

**The pool charges nothing.** It is the hook that takes the fee, in `afterSwap`,
with `AFTER_SWAP_RETURNS_DELTA` — which its flags already announced.

### What that changes for the platform's liquidity

**A position in a Pons pool earns no swap fee.** That was the first thing
`Treasury.addLiquidity` seemed to promise, and it is false. So there is no LP
income to collect, and no function claims to do it — the version that had one
lost it.

What the liquidity pays is elsewhere, and better placed: **the fee the hook takes
on a swap goes to the launch's `creatorFeeRecipient`**, which for $PLAT is its
own vault. So deeper liquidity attracts volume, that volume pays creator fees,
and those fees buy stocks for $PLAT's holders. It reaches people instead of
accruing in a position.

> **The bug that surfaced from this, and which stays fixed.**
> `modifyLiquidity` realises accrued fees **in the same delta as the principal**.
> If one side turns positive, v4 fails the whole `unlock` while any delta is
> unsettled. The callback only handled negative deltas: it would have worked
> until the day the position became productive, then failed for good. Both signs
> are handled — useless on a `poolFee = 0` pool, and everything the day a launch
> has one.

---

## A contract can launch, and Pons records `msg.sender` — 2026-09-08

Question from `PLAN.md` §8bis Q2: is a factory that launches on Pons on the
creator's behalf possible, and what becomes of the `deployer`?

Probed with `test/Deployer.t.sol` — a contract with no particular role calls
`launchToken` on the real factory, `msg.sender` and `tx.origin` deliberately
distinct:

```
token          0xB7B57B631e5329079baa1145f8A9Cc2F6bB2a0A0
deployer       0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f   <- the CONTRACT
the contract   0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f
the EOA        0xBee68F4bad798D325F94D732b9c6D367669A893e
pairToken      0x0000000000000000000000000000000000000000
```

1. **Pons does not refuse contracts.** No `tx.origin == msg.sender` guard. The
   launch succeeds and `exists` is true.
2. **`LaunchedToken.deployer = msg.sender`**, not `tx.origin`. A factory
   launching for others is therefore recorded as the deployer, and
   `FeeVault.bind` can no longer use it to prove the creator's identity.

> Not to be confused with the **curve**'s `deployer`, which holds the
> `creatorFeeRecipient` and not the launcher (`recon.md` §1.2, corrected on
> 2026-09-04). They are two different fields in two different contracts.

**Still to probe**: what `LaunchedToken.deployer` actually opens at Pons. Until
that is known, making a single contract the deployer of every launch is an
unmeasured concentration — cf. the trade-off in `PLAN.md` §8bis Q2.

---

## The pair tokens Pons accepts, and what a non-ETH launch does — 2026-09-08

`launchToken(params, configId, pairToken)` takes the pair token as an argument.
Probed with `test/PairToken.t.sol` by trying five values on the real factory:

| pair | result |
| :--- | :--- |
| native ETH (`address(0)`) | **accepted** |
| USDG | **accepted** |
| NVDA — a tokenised stock | **accepted** |
| WETH | refused, `0x49285dfb` |
| `0xdead` | refused, `0x49285dfb` |

**So Pons keeps an allowlist, and it is wider than ETH.** A creator can quote
their launch in USDG, or even in a stock. This is not a contrived case, it is a
choice the interface offers.

### Where the fee of an ERC-20-quoted launch goes

Measured end to end: a USDG-quoted launch, a real 1 000 USDG purchase on the real
curve **outside the snipe window**, then `sweepFees`.

```
USDG held by the curve     : 1 000 000000
the escrow's NATIVE ledger :           0
the escrow's USDG ledger   :    47 000000     <- 4.70 %
```

**Pons loses nothing**: it credits at the normal rate — 4.70 % of the trade,
exactly what Payd measures on an ETH launch. It credits on a **second ledger**,
the ERC-20 one (`balanceOfToken(recipient, token)`), distinct from the native
ledger `claim()` reads.

The vault has **no function to read it, and none to claim it**. `harvest` calls
`claim()`, which reads `_balances[msg.sender]`. There is no `claimToken` in
`FeeVault`.

> Measurement trap: a first reading gave **705 USDG out of 1 000**. I was buying
> inside the snipe window (99 % decaying over 3 s, paid to the creator), so I was
> measuring a snipe tax and not a fee. The right figure only comes out by trading
> after it. A number three times too large that "confirms" the thesis is worse
> than a red test.

### The fix

`FeeVault.bind` was not looking at `pairToken` — three other places did
(`_poolKey`, `Treasury.buyAndBurn`, the off-chain rehearsal), but not the one
that decides once and for all. A vault would bind, display the right token, and
revert `NothingToDo` on every `harvest` and every purchase, forever, while its
fees piled up out of reach.

```solidity
if (l.pairToken != address(0)) revert UnsupportedPair(l.pairToken);
```

Refusing at `bind` costs the creator one failed transaction and warns them
immediately. The alternative never warns them at all.

---

## What `LaunchedToken.deployer` opens: nothing — 2026-09-08

`PLAN.md` §8bis Q2. Pons records `msg.sender` as the `deployer`, so a factory
launching for others would be the deployer of **every** launch, forever. What
remained was to find out what that field opens.

Method: a real launch with three distinct roles (launching wallet, fee recipient,
stranger), plus the Pons owner. Each candidate function called from each role
**with identical calldata** — a differential, because a revert on its own does
not tell an access check from a state check.

| call | deployer | recipient | stranger | owner |
| :--- | :--- | :--- | :--- | :--- |
| `setCreatorFeeRecipient` | `OwnableUnauthorized` | same | same | **OK** |
| `transferCreatorFeeRecipient` | `NotCreatorFeeRecipient` | **OK** | same | same |
| `setBuybackEnabled` | `0x377dfc9a` | same | same | same |
| `graduate` | `0xffa32558` | same | same | same |

**The deployer gains no line.** It loses in exactly the places the stranger
loses. The two real powers are elsewhere: `setCreatorFeeRecipient` to the **Pons
owner**, `transferCreatorFeeRecipient` to the **current recipient** — for us, the
vault.

The last two rows are not role checks at all: the owner itself fails identically,
so it is a **state** check that reverts before any role is examined. It is the
"owner" row that makes it possible to say so; without it, three identical
failures stayed ambiguous.

**Consequence for §8bis Q2**: the concentration I feared **does not exist**. A
factory that deployed every launch would derive no power from it. The trade-off
between one transaction and three is therefore about ergonomics, not security.

`test_WhatTheDeployerFieldCanDo` stays in the suite and asserts **deployer ==
stranger** everywhere. The day Pons gives that field a power, the two diverge and
the test fails — it is the only warning we would get.

### A methodological error, told because it nearly got through

I had first extracted the factory bytecode's `PUSH4`s to conclude by absence:
"the `NotDeployer()` selector is not there, so there is no check on the
deployer". **The argument was wrong.** `NotCreatorFeeRecipient` does revert even
though its selector is likewise absent from that bytecode: the factory is a
proxy, and I had scanned the dispatcher, not the logic.

A conclusion from absence requires proving that everything was read. The
behavioural differential, by contrast, assumes nothing about the structure.
