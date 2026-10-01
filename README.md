<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/payd-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/payd-logo.svg">
    <img alt="Payd Protocol" src="docs/brand/payd-logo.svg" width="84">
  </picture>
</p>

<h1 align="center">Payd Protocol</h1>

<h3 align="center">Creator fees buy tokenised equities for a token's holders.</h3>

<p align="center">
  No staking, no sign-up, nothing to approve.
</p>

<p align="center">
  <img alt="Solidity 0.8.26" src="https://img.shields.io/badge/solidity-0.8.26-14130f?style=flat-square&labelColor=14130f&color=ccff00">
  <img alt="Robinhood Chain 4663" src="https://img.shields.io/badge/chain-Robinhood%204663-14130f?style=flat-square&labelColor=14130f&color=97917f">
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-14130f?style=flat-square&labelColor=14130f&color=97917f">
  <img alt="No audit yet" src="https://img.shields.io/badge/audit-none%20yet-14130f?style=flat-square&labelColor=14130f&color=d9614f">
</p>

<p align="center">
  <a href="https://paydprotocol.eth.limo"><b>paydprotocol.eth</b></a> &nbsp;·&nbsp;
  <a href="docs/HOW_IT_WORKS.md">How it works</a> &nbsp;·&nbsp;
  <a href="FLOWS.md">Where the money goes</a> &nbsp;·&nbsp;
  <a href="docs/CONVENTIONS.md">Conventions</a> &nbsp;·&nbsp;
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <sub>Served from IPFS under one ENS name, no backend. If your browser does not speak ENS,
  <a href="https://paydprotocol.eth.limo">paydprotocol.eth.limo</a> — the app is at
  <a href="https://paydprotocol.eth.limo/app/">/app</a>.</sub>
</p>

---

## The idea

Every trade on the token pays a fee. That fee buys **real tokenised stocks** on
Robinhood Chain — NVDA, AAPL, TSLA, gold, oil — and those stocks are split
between holders, pro-rata to what they hold.

Every 30 minutes an epoch closes. One purchase then buys **the whole basket at
once**, covering every epoch since the last one — so you get a slice of the
basket, not whatever a wheel landed on. Your share is sent to you automatically.

> **Reading the code rather than buying?**
> [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) is the whole system in one pass
> — the contracts, the cycle, the snapshot, who can do what. Everything else is
> indexed in [`docs/`](docs/).

## What you actually get

**There is no single number, and a page that prints one is lying about every
launch but one.** The rate is set per launch: the creator chooses their tax at
Pons, and the share of the curve fee belongs to Pons. So this section describes
the *shape*, and the app reads each launch's live figures off the chain —
`FeeVault.economics()` derives them rather than storing them, which is why they
follow when Pons moves its own share instead of quietly going stale.

Every trade on a token pays **the curve fee plus the tax its creator set at
launch**. Part of that reaches the vault: the tax in full, plus the share of the
curve fee Pons does not keep. What arrives is then split three ways —

| | |
| :--- | :--- |
| **Holders** | buys the basket of stocks and distributes it |
| **The platform** | `PLATFORM_BPS`, capped at birth and able to be zero |
| **The creator** | whatever is left |

**No founder allocation, no hidden reserve, no vesting cliff.**

### What the code guarantees, whatever the launch

These are constants, not policy — they hold for every vault the registry ever
builds, and no key can raise them:

| | |
| :--- | :--- |
| Holders' share | **at least 50 %** of what arrives (`MIN_REWARDS_BPS`). The creator can raise it, **never lower it** |
| The platform's share | **at most 15 %** (`MAX_PLATFORM_BPS`), stamped into the vault **at birth** and immutable there — so a creator knows at launch what the platform takes, for good |
| Delivery budget | **at most 20 %** of the holders' share (`MAX_DIST_GAS_BPS`), 3 % in practice. Not a share of anything: it is the gas that carries the stocks to wallets, and it is the only deduction that returns as a delivery |
| Paid out per purchase | **at most 10 %** of the reserve (`MAX_PAYOUT_BPS`), 4 % in practice — it smooths out quiet stretches, with a floor so a young vault is never stranded |
| Slippage tolerated | **at most 3 %** (`MAX_SLIPPAGE_BPS`), under an oracle floor. Never `minOut = 0` |

Changing the basket or the payout rate on a vault takes a **48-hour timelock**,
so any change is public two days before it applies. That timelock can neither
withdraw, nor redirect, nor freeze funds. $PAYD's own numbers are further down.

## When you receive

Your share **accumulates** every 30-minute epoch. Once it is worth about **$20**,
it is sent to your wallet — at most once every 24 hours.

Below that threshold it keeps adding up. **Nothing is ever lost.** You can also
claim it yourself at any time, paying your own gas.

> **Why wait for $20?** A transfer costs gas whatever it carries. Delivering a
> $0.20 share would burn half of it. By waiting until it is worth ~$20, **you
> keep 99 % of it** instead of 90 %. Nothing is withheld — only batched.

## How your share is computed

Pro-rata to what you hold, **weighted by how long you hold it**, across the
whole epoch.

Not a photograph taken at some instant — the area under your balance. Hold for
the full half-hour and you count for the full half-hour. Buy thirty seconds
before the end and you count for thirty seconds. That is what stops anyone from
turning up just in time to collect a share they never earned, and it needs no
lottery to do it.

## What still has to be trusted

This part is worth reading.

Computing the shares happens **off-chain**: it would mean replaying the history
of every holder, which no contract can do. So one address publishes the result,
and it takes effect immediately — that is what makes payouts fast.

**What that address cannot do:**

- invent money — the contract never pays out more than it took in;
- pay you twice, or take back what you were already paid;
- touch the funds — the contracts expose **no withdrawal to any privileged
  address**. The one `withdraw()` that exists pays each caller their own failed
  payment, and nobody else's;
- drain the protocol: deliveries run continuously, so at any moment there is only
  about **one epoch** of rewards sitting in the contract.

That exact amount is public and readable on-chain: `Distributor.quoteAtRisk()`.

**What it could do:** misallocate a distribution. That is the one real risk, and
here is what limits it.

## Checking for yourself

You do not have to take anyone's word. The repository ships a tool that
**recomputes the shares from the blockchain alone**:

```bash
pnpm --filter offchain dispute
```

It takes no input from the project, needs no key, and signs nothing. It reads the chain,
redoes the computation, and tells you whether the published result matches. If it
diverges, you hold a reproducible proof that anyone else can reproduce too.

Before every publication, the protocol itself runs **five checks** and refuses to
publish if any of them fails — including a full recomputation from a second node.
Publishing a doubtful result would be worse than publishing nothing.

## What can go wrong

Stated plainly, because you deserve it before you buy.

- **The tokenised stocks belong to Robinhood.** They can pause them, block an
  address, or burn holdings. This protocol is exposed to that like everyone else.
- **After the token graduates**, fees sit in the Pons hook until someone sweeps
  them. The protocol can do that itself most of the time; when a sell has just
  landed, only Pons can. Measured wait: a few minutes typically, up to ~35 at
  worst.
- **If the publishing service stops**, fees pile up and nothing is distributed
  until it comes back.
- **Pons can redirect the fee stream.** The registry's owner can point a
  launch's creator fees at another address, with 3 days' notice and no veto from
  the vault.
  Stocks and ETH already in the contracts stay yours and stay claimable — it is
  the future flow that would stop.
- **No external audit has been done to date.** How to report something you find:
  [`SECURITY.md`](SECURITY.md).

## $PAYD's own parameters

**This is the one section with concrete numbers**, and they are $PAYD's alone.
Every other launch sets its own — see *What the code guarantees* above for what
holds regardless.

| | |
| :--- | :--- |
| Creator tax | **3.00 %** (`creatorTaxBps = 300`) — engraved at the Pons launch, **never changeable** |
| **The trader pays** | **4.00 %** — the tax plus the 1 % curve fee |
| **The vault receives** | **3.70 %** of volume — the tax in full, plus the 70 % of the curve fee Pons does not keep |
| → to holders, as stocks | **3.20 %** of volume (`rewardsBps = 8 649`), less the 3 % delivery budget → **~3.10 %** lands in wallets |
| → to the creator | **0.50 %** of volume — the residue |
| → to the platform | **nothing.** `platformBps = 0`: **$PAYD does not tax itself** |
| Epoch | 30 minutes |
| Automatic delivery threshold | ~$20, at most every 24 h |
| Basket | QQQ · NVDA · TSLA · SPCX · SPY — **20 % each** ([why five and not ten](docs/ARCHITECTURE.md#why-5-and-not-10)) |

`rewardsBps = 8 649` is not a round number because the target is not one either:
it is the exact value that lands the creator residue on **50 bps** after integer
division. 8 648 would give 51.

The 3.70 % is not stored anywhere — `economics()` recomputes it from the Pons
launch record and the live curve config, so if Pons raises its share of the curve
fee to its documented ceiling the figure follows down to 3.50 % on its own,
rather than this table becoming a lie nobody noticed.

**Anyone can top up the pot.** `FeeVault.fundRewards()` puts ETH straight into
the reserve the epochs buy from — no dev share taken, no gas cut, and no way for
anyone to take it back out. It is the same one-way street the fees take; it just
does not have to come from a trade.


## Addresses

Filled at deployment. Until then these are placeholders, and the pre-publish
check refuses to let anything ship while one remains — a page that announces
addresses and gives none is worse than a page that says nothing.

```bash
grep -rIn '{{[A-Za-z_-]*}}' site/index.html README.md front/index.html   # empty before publication
```

**The five platform contracts**, each deployed once, in one transaction, by
[`script/DeployPayd.s.sol`](script/DeployPayd.s.sol):

| | Address |
| :--- | :--- |
| `Payd` — the registry | `0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03` |
| `DistributionFactory` | `0x1228E61aba98260dC8b5eAf3D40A899bA766753b` |
| `Treasury` | `0x943Cb95441B26622a1c3c606E20cB60b2Dc94694` |
| `Collector` | `0xf3102FfE59DC2147bC0DF7e5b64d40E6b8Fed9f7` |
| `Timelock` | `0x1e9389CF4B42527f6EB1e107E99B9F5Da15c7291` |

**The $PAYD launch.** `FeeVault` and `Distributor` have no fixed address of their
own — a pair is cloned for every token, and the app names both on the page of the
launch that owns them. These are the platform's own pair, the first the registry
built:

| | Address |
| :--- | :--- |
| **Token — $PAYD** | `0xc8D259fBb46947F2C7Fa19999C76C795e353CB3a` |
| `FeeVault` | `0x4DBA57f2E1b9AFE02cA091916F98dd7B4A248A64` |
| `Distributor` | `0xe765f074650b83d95E09A22F0B87A992792705fb` |

Robinhood Chain, chain id **4663**. Every one of them is verified on
[the explorer](https://robinhoodchain.blockscout.com) — the source shown there is
the source that runs, comments included.

> **No deployed address of ours appears anywhere in this repository**, and that
> is deliberate rather than incidental. Placeholders were being read as real
> addresses against the right documentation, which is the dangerous direction of
> that mistake. Beyond it: `getLaunchedToken` returns a launch's deployer and
> `getOwners()` turns one address into a list of signers, so a fixture pointing
> at this project's own deployment would publish a multisig's membership from a
> public file.
>
> The fork tests therefore use **third parties' live launches** — for what they
> are, never for whose they are. `test/AdoptLiveLaunch.t.sol` is the clearest
> case: it proves an already-launched token can adopt a vault without relaunching,
> and it proves it against a creator who owes this project nothing.

## Going deeper

| | |
| :--- | :--- |
| [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) | **The technical entry point** — the whole system in one pass |
| [`docs/`](docs/) | The index: what each document is for |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 46 decisions, each with its measurement and its reasoning — **including the ones we got wrong** |
| [`docs/recon.md`](docs/recon.md) | Every external address, how it was verified, and on what date |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | The rules this codebase is held to, and the measurement behind each |
| [`contracts/`](contracts/) | 8 contracts, ~5,000 lines |
| [`FLOWS.md`](FLOWS.md) | **Where the money goes, and who can move it** — the percentages, the privileged functions and their holders, and the withdrawal functions that do not exist. Written to be handed to a third party |
| [`SECURITY.md`](SECURITY.md) | What is in scope, what an attacker can already reach, and how to report |

The code is tested against the **real** state of the blockchain: not one test
passes thanks to a stand-in for Pons or Uniswap.

```
184 tests against the live chain
 13 fuzzed invariants, over three handlers
 96 off-chain checks + 204 conformance vectors
```
