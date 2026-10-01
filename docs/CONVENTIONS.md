# CONVENTIONS.md — the rules this codebase is held to

> The engineering conventions, the non-negotiable rules, and the measurements
> behind them. Everything here is enforced by a test, by the build, or by review
> against this file — nothing is aspirational.

## What we are building
A system of contracts on **Robinhood Chain** (Arbitrum Orbit L2) that:
1. receives the creator fees of a token launched on **Pons v2** (creator wallet = our `FeeVault`), in the currency the launch is quoted in — native ETH, USDG or a stock token,
2. converts that into a basket of **2 to 8 Stock Tokens** (`FeeVault.MIN_BASKET` / `MAX_BASKET`) through Uniswap according to fixed weights,
3. distributes those stocks **to the token's holders with no staking**: pushed airdrop by default, Merkle claim as the fallback.

Guiding principle: **as few keys as possible**. No `onlyOwner` function except the timelock (stock weights) and `publishRoot` (keeper). Every other cycle action (`harvest`, `runEpoch`, `distribute`, `payDev`) is callable by anyone and refunds its own gas.

## Stack
- Solidity 0.8.26, **Foundry** (forge/cast/anvil), OpenZeppelin 5.x.
- **Fork** tests against Robinhood Chain (`RPC_URL` in `.env`). No mocks for Pons/Uniswap/Stock Tokens: we test against the real state.
- Off-chain: TypeScript (viem), scripts in `offchain/`. Deterministic and reproducible (same input → same root).
- Minimal front end: Vite + viem, one page, entirely static.

## Structure
```
contracts/     the product, per launched token:  FeeVault.sol, Distributor.sol
               the platform:  Payd.sol (the registry, and the interface over the
                              factories), DistributionFactory.sol (one per payout mode),
                              Treasury.sol (the only platform contract holding money),
                              Timelock.sol, Bootstrap.sol, Collector.sol
               interfaces/ (IVaultFactory.sol + VaultTypes.sol: what Payd
                              speaks to a factory, and the shapes it passes — neither
                              belongs to a mode), libraries/
               modes/      the TEMPLATE a second payout mode is copied from, and
                              it COMPILES AND DEPLOYS — BaseModeVault.sol (the
                              non-basket half of FeeVault: harvest, bind,
                              migrate, fundRewards, _pay, withdraw, hookStatus),
                              ModeVault.sol (the payout() stub), ModeFactory.sol
                              (what Payd.enableFactory admits). It is reached
                              through the registry like any other factory, so a
                              defect here is a live defect and not a note to a
                              future author: T-MODE-01 found this base paying
                              its caller NOTHING on a non-ether quote, on 59.1 %
                              of Pons volume. Anything fixed in FeeVault's
                              non-basket half has to be carried across, and
                              test/ModeVault.t.sol is what says whether it was.
test/          fork tests (*.t.sol) + three invariant handlers: Invariants.t.sol,
               DevPathInvariants.t.sol, TreasuryInvariants.t.sol
script/        DeployPayd.s.sol — the whole platform, in one transaction.
               Deploy.s.sol is V1's (one vault, no registry) and is kept for it
FLOWS.md       where the money goes and who can move it. Written for a third party
offchain/      snapshot.ts, epoch.ts, merkle.ts, keeper.ts, preflight.ts, dispute.ts
front/         the app (index.html + src/), published on IPFS at paydprotocol.eth/app
site/          the shop window, one static HTML file, published at paydprotocol.eth
docs/          recon.md (verified addresses), ARCHITECTURE.md, HOW_IT_WORKS.md
```

## Non-negotiable rules
- **Everything that reaches the repository is in English.** Commit messages, code comments, NatSpec, docs, test names, revert strings, console output. No exception, including for a note meant to be temporary — the temporary ones are the ones that survive. The conversation can be in any language; the repository is read by people who will never be in that conversation.
- **Recon before code**: never write code against an assumed address or ABI. Everything in `docs/recon.md` was read on-chain (`cast call`, explorer) and dated.
- **A failed leg blocks nothing.** `buyBasket` buys every leg of the basket in one transaction, each sized by its `bps`. A leg that cannot be bought is **skipped**: its pivot currency stays in `pivotReserve` and the next purchase spends it. A stock Robinhood paused costs a delay, never a loss — and never the other legs. `_fund` truncates the arrays to the legs that actually bought, because `Distributor.fundWindow` refuses a zero amount: without it a single skipped leg reverted the whole purchase (`test_AFailedLegNoLongerTakesTheBasketDown`).
- **Everything routes through one PIVOT currency**, `FeeVault.PIVOT` — USDG on this chain, because that is where the stocks' liquidity is (`docs/recon.md` §4.1). **The pivot is a crossroads, not a wall**: a quote with no pivot pool is reached by `QUOTE → WETH → PIVOT`, whose second hop is the pool every ETH-quoted vault already uses. Exactly one of `QUOTE_FEE` / `QUOTE_WETH_FEE` is non-zero — the route is declared at birth from a measurement, never probed at swap time. It is what makes COIN and cbBTC servable: no pivot pool at all, $33k and $159k of WETH depth, and 198 of the ~220 weekly credits of the otherwise-unreachable set. It is a **parameter, not a constant**: written at `init` from the registry's wiring, and `migrate` does not compare pivots, so a vault can move to a successor that pivots elsewhere, one at a time, under timelock. The WETH→PIVOT tier (`ETH_PIVOT_FEE`) is stamped the same way — it was the last welded pool on the money path.
- **Two legs skip the pool entirely.** A **USDG** line is transferred as-is — there is no pool of USDG against itself, so no floor to compute and nothing to protect; it is the one stock a **basket** accepts at tier 0 — `FeeVault._setAllocations` refuses any other line without a v3 tier. `Payd.allowStocks` itself no longer refuses one (2026-09-11): tier zero declares "no v3 route" for a mode that settles elsewhere, and a non-zero tier is still measured against a live pool. A line that **is the vault's `QUOTE`** is held back before the ETH/quote→USDG hop rather than bought back after it: the round trip cost 0.10 % measured on NVDA/USDG at tier 500, for no movement at all.
- **Bounded slippage**: every swap has a `minOut` derived from an oracle (Chainlink when a feed is available, otherwise a 30-minute Uniswap v3 TWAP). Never `minOut = 0`.
- **No unbounded push**: `distribute` takes an explicit list; the loop cannot exceed `MAX_BATCH` (64).
- Reentrancy guard on every function that transfers. CEI throughout.
- **No secrets in the repository.** `.env` is ignored. The keeper runs with a wallet that holds nothing but gas.
- Small commits, one contract = one PR = its tests. A test that only passes thanks to a `vm.mockCall` on Pons/Uniswap is rejected. `vm.etch` is allowed — it puts OUR code at an address Pons genuinely designates, so nothing about Pons is faked. Clear the slots first: an address that already holds a Safe keeps its storage, and slot 0 of a Safe is its singleton.
- **Two authorities, and neither is enough alone.** The timelock (Safe as sole proposer, open execution, 48 h) and a **generation key** — a Ledger kept apart from the Safe signers, which approves and never triggers. It guards the three doors that move value to an address somebody names: `Payd.setFactory`, `Treasury.bindPlatform`, `Treasury.migrateTreasury` — and a fourth that moves nothing, `Payd.setCrossModeMigration`, which only lets the timelock migrate a vault to one of another payout mode (`false` at birth). Everything about who can do what lives in `FLOWS.md` §6, and that file is the one to update when a power changes.
- **One payout mode = one factory.** `Payd` holds several (`factoryMode`, two keys to write), `createVault` builds through the default and `createVaultWith` names any other. A vault is stamped with its factory's `MODE` at birth (`modeOf`), and `FeeVault.migrate` refuses a destination of another mode unless the generation key has opened `crossModeMigration` — `false` at birth. A mode's per-MODE parameters live in its factory and its per-LAUNCH parameter travels in `bytes modeData`, forwarded by `createVaultWith` / `createVaultFor` and never decoded by `Payd`. The registry validates only what it owns — the quote allowlist, the 15 % cap, the `isVault`/`modeOf` stamps: the epoch bounds moved to `DistributionFactory` and an empty basket is now legal (`FeeVault.init` still refuses one for this mode).
- **`Payd` and `DistributionFactory` never hold a wei.** The registry stamps and indexes; the factory clones. Only `FeeVault`/`Distributor` (per token) and `Treasury` (the platform) hold money. A change that puts value through either of the first two is a design error, not an optimisation.

## Conventions
- Stock weights in bps (summing to 10,000). **One purchase buys the WHOLE basket**, each line by its weight (`FeeVault.buyBasket` → `_buyLegs`), covering every epoch closed since the last one. One shared ETH→USDG hop instead of one per stock, which is where the gas goes.
  - `allocationOf(uint256)` and `ROTATION_STRIDE` **are gone** (2026-09-09). They survived from an earlier weighted-rotation design — one stock per epoch — replaced by buying the whole basket in one transaction, and this file had said for months that nothing called them. What removed them was a measurement, not taste: `FeeVault` was **26 152 bytes of runtime, 1 576 above EIP-170**, and those two dead members were 1 322 of the way back under.
- Distribution epoch: **30 min**, root published **by the keeper every epoch**, effect **immediate** — no bond and no challenge window any more (§S29). A holder can claim as soon as their epoch is over: the seed delay that used to sit in between is gone with the draw (§S38). The automatic airdrop runs at most every 24 h, as soon as their share is worth ~$10 (§S30) — back to its pre-2026-09-06 value, the doubling having been argued on a gas price that has since fallen 56.7 %. Shares are **cumulative**: one claim settles the whole history, one transfer per stock. See `docs/ARCHITECTURE.md` §S18 and §S20.
- An epoch's snapshot = **the time-weighted average of balances over the whole epoch**, `∫ balance dt / L`, not a sample of blocks → a sniper is paid in proportion to the time they actually held, which for an instant is nothing. There is no seed, no anchor and no reveal: the window is two immutables and a subtraction (`docs/ARCHITECTURE.md` §S38).
- **One quote per vault, stamped at birth** (`FeeVault.QUOTE`, `address(0)` = native ETH). Pons keeps one escrow ledger per currency, so a vault claims exactly one and `bind` refuses any launch quoted elsewhere. Measured 2026-09-08 over 7 days of `V2FeeEscrow` credits: 40.9 % of Pons volume is ETH-quoted, 22.0 % USDG, 37.2 % stock tokens — v1 served only the first. The quote's USDG tier and its `MIN_BUY_QUOTE` come from `Payd.quoteListing` (timelock), because 0.01 ether of raw USDG is ten billion dollars.
  - **A non-ETH vault skims no delivery budget, and pays a bounty rather than a refund.** `_refundAmount` computes wei and the Distributor spends wei; a vault holding NVDA has none, and pricing GAS in NVDA would put an oracle on the money path for a few cents of L2 gas. A **bounty** sidesteps it: `keeperBountyBps` of what the call MOVED is already denominated in `QUOTE`, so no price is read and none can be manipulated — `buyBasket` out of `rewardsPool` capped at `MIN_BUY_QUOTE`, `harvest` out of the creator's residue at its existing 50 bps cap, and `buyBasket` holds `MIN_BUY_QUOTE` back the way it holds `MAX_REFUND` back on an ether vault. The delivery budget stays zero, so the keeper fronts every push there and **the airdrop floor is 40 % of `MIN_BUY_QUOTE` (~$10), the same floor an ether vault has** — the whole cycle then costs 65 bps of rewards against the 3.00 % `distGasBps` an ether vault already takes for deliveries alone. The ether floor came down too, $20 → $10. Stopping the pushes outright was the first answer and it was withdrawn: the bound on what a false root can award itself (`Distributor.totalFunded - totalDistributed`, clamped at `Distributor.sol:544-545`) IS that deliveries run continuously, and dropping it while `Payd.allowKeeper` widens who may publish is not shippable. Same file: **`quoteSpent` is in the vault's QUOTE units, not wei** (`_buyLegs` derives it from `ethIn`, which is what the vault spent), so the floor is denominated in `MIN_BUY_QUOTE` — `offchain/src/pushfloor.test.ts` pins both ends. The rate is **a timelock parameter seeded at 70 bps, bounded [10, 300]**, for `distGasBps`'s reason: the cost is fixed per call and the bounty is a share of an amount, so no constant covers $20k/day and $500k/day at once. Seeded low — under-paying degrades to the keeper fronting, over-paying is holders' money. `test_ANonEthVaultPaysItsHarvestBountyInItsOwnCurrency`, `test_TheNonEthReserveKeepsEnoughToPayItsCaller`.
- Excluded from the snapshot: the Uniswap pool, the Pons bonding curve, `FeeVault`, `Distributor`, address 0, and an `excluded[]` list managed by the timelock (CEXs, contracts).
- Minimum threshold: expressed as the **value of the share**, not as a % of supply — a fixed percentage is too permissive at launch and too restrictive later. See `docs/ARCHITECTURE.md` §S14. Holders below the threshold are not in the tree; their weight is redistributed to the others (option B, an accepted gap in the report).

## Build
**`via_ir = true` is not a taste setting — it is what makes `FeeVault`
deployable.** Measured 2026-09-09, runtime bytes: 26 152 without it, 24 679
with, 23 357 once the dead rotation members were removed. **Today, 2026-09-11,
after the audit fixes: 23 911 runtime, 665 bytes of margin under the 24 576 cap
and 89 under the CI gate of 24 000** — re-measure that margin after any change
to `FeeVault`, it is the number that decides, and this paragraph read 23 699 /
877 for a day after it stopped being true. T-ALLOC-01 spent 155 bytes on asking
the factory whether a basket line's pool exists and T-RISK-01 a further 136 on
carrying a skipped leg's quote; the only reason both fit is that separating
T-RISK-01's accounting quote from its pricing quote was 96 bytes cheaper than
blending them, and also the correct behaviour (`docs/AUDIT_FIXES.md` §2.3). 89
bytes is not a budget: the next change has to find its own trim. The chain is Arbitrum
Nitro (ArbOS 116), where the cap applies to the COMPRESSED size, so 26 KB might
have squeezed through — but of 89 addresses read on this chain not one exceeds
24 576, and a deployment that fails is discovered at the worst possible moment.

Two consequences to live with: builds take ~2 minutes, and `via_ir` hits
"stack too deep" where the old pipeline did not. The remedy is the one already
used throughout (`_buyLegs`, `_create`, `_waveOne`): give the block its own
function so its locals die. A Yul stack error names no file — bisect by moving
test files out of `test/`.

## Commands
```
forge test --fork-url $RPC_URL_FALLBACK --compute-units-per-second 60 -j 1 -vvv
forge script script/DeployPayd.s.sol --rpc-url $RPC_URL --broadcast --verify
pnpm --filter offchain test
pnpm --filter offchain keeper
pnpm --filter offchain dispute <rootId>
```
**The fork suite needs `$RPC_URL_FALLBACK`, not `$RPC_URL`.** This line said
`$RPC_URL` for months and the suite cannot pass on it: the public node **prunes**,
and a fork pinned to a block it no longer holds fails with `-32000: metadata is
not found` before any test body runs. Measured 2026-09-10 — **36 failures on
`$RPC_URL`, of which ~33 are that error**, against **197/197 green in 625 s** on
the archive endpoint. The failures name accounts and storage slots, so they read
like contract bugs; they are a node that cannot answer. `.env.example` explains
which endpoint is archival and how to verify a candidate.

`-j 1` and the throttle stay, on either node. Without them the run 429s, and on
the fallback a single unthrottled run burns the rate budget for several minutes
afterwards — a retry that 429s straight away is usually the previous run's fault,
not the key's.

`Deploy.s.sol` on the second line was **V1's** script (one vault, no registry).
The platform is `DeployPayd.s.sol`.
