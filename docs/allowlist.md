# allowlist.md — which stocks a creator may put in their basket

Measured on **2026-09-08** on Robinhood Chain (4663), block ~57.17 M.
Method and replayability at the bottom of the page.

## The result in one line

**194 tokenised stocks are deployed. 49 are liquid enough for a vault to buy
into.** The allowlist is not a formality: without it, a creator picks in good
faith a basket three of whose five lines are unbuyable.

| | |
| :--- | ---: |
| Tokens listed by Robinhood | 194 |
| Existing USDG pools (4 tiers tested) | 292 |
| Total USDG in those pools | $30 762 334 |
| Tokens with ≥ $200 of depth at +1 % | 63 |
| Tokens with ≥ $1 000 | 57 |
| **Tokens with ≥ $5 000 — the proposed threshold** | **49** |

**Proposed threshold: depth ≥ $5 000 for a 1 % price move.** An epoch buys a few
hundred dollars at most; at $5 000 of depth, a $500 purchase moves the price by
~0.1 %, well below the TWAP floor. 49 stocks leave ample room to compose a basket of
2 to 8 (`FeeVault.MIN_BASKET` / `MAX_BASKET`).

## The first hop: WETH → USDG

Every purchase goes through it before reaching the stock. The four tiers, measured:

| tier | pool | USDG | depth +1 % |
| ---: | :--- | ---: | ---: |
| **100** | `0x52e65b17…` | 16 897 484 | **2 537 723** |
| 500 | `0x69bfaf19…` | 3 543 565 | 488 972 |
| 3000 | `0xa9188730…` | 1 687 259 | 45 241 |
| 10000 | `0x5f009e07…` | 1 632 | 121 |

Payd hard-codes `WETH_USDG_FEE = 100`: **that is the right tier**, verified
rather than assumed. We keep it as is.

## Payd's basket, held up against the measurement

`$PAYD`'s own basket is **six lines** (`script/DeployPaydVault.s.sol`), and every
one of them sits on the deepest tier the scan found:

| | Payd tier | best tier |
| :--- | ---: | ---: |
| QQQ | 500 | 500 |
| NVDA | 500 | 500 |
| TSLA | 3000 | 3000 |
| SPCX | 500 | 500 |
| SPY | 500 | 500 |
| PONS | 10000 | 10000 (§ `$PONS` added to the STOCK list) |

> This section read "nine of the ten allocations are on the deepest tier" and
> named GME as the exception, at tier 10000 against a better 500. **Corrected
> 2026-09-11**: that was a ten-line basket which no longer exists — `FeeVault`
> caps a basket at `MAX_BASKET = 8`, and `$PAYD`'s holds none of those stocks
> any more. The GME row stays on the measured allowlist below, where it is
> still pinned at its deepest tier.

## The measured allowlist

Tier kept = the deepest of the four for that token. Depth = USDG absorbable
before a 1 % price move, computed on the **active** liquidity at the current
tick.

| symbol | address | tier | USDG in the pool | depth +1 % |
| :--- | :--- | ---: | ---: | ---: |
| `SGOV` | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | 3000 | 2 991 487 | 1 997 598 |
| `QQQ` | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | 500 | 790 727 | 1 659 834 |
| `NVDA` | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 500 | 5 258 960 | 1 363 520 |
| `GLD` | `0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e` | 3000 | 2 781 462 | 690 010 |
| `SPCX` | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | 500 | 1 710 405 | 602 806 |
| `TSLA` | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 3000 | 895 422 | 506 867 |
| `HIMS` | `0xCceE82fE024c36fA15E1005edE3E9e4787e23D09` | 3000 | 1 396 982 | 359 945 |
| `DJT` | `0x1D11f0496982706C5e14A514D4E79F2e6BdE4516` | 10000 | 460 038 | 330 958 |
| `GME` | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | 500 | 301 302 | 301 693 |
| `AMZN` | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 3000 | 585 367 | 254 811 |
| `MU` | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | 3000 | 1 157 343 | 249 597 |
| `AMC` | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` | 3000 | 1 144 146 | 228 684 |
| `RDDT` | `0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C` | 10000 | 1 299 919 | 220 675 |
| `LULU` | `0x4e62068525Ab11FE768e29dfD00ef909B9803016` | 3000 | 282 952 | 215 011 |
| `TTWO` | `0x5e81213613b6B86EaB4c6c50d718d34359459786` | 3000 | 176 262 | 173 183 |
| `IBM` | `0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619` | 3000 | 114 432 | 164 440 |
| `COST` | `0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2` | 3000 | 532 183 | 159 557 |
| `LLY` | `0x8005d266423c7ea827372c9c864491e5786600ea` | **500** | 797 713 | 155 752 | re-pinned from 10000 on 2026-09-11, **+131.2 bps** |
| `BABA` | `0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4` | 3000 | 127 298 | 138 050 |
| `MSFT` | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 3000 | 261 802 | 88 310 |
| `SLV` | `0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f` | 3000 | 221 370 | 86 990 |
| `USO` | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | 3000 | 542 790 | 75 983 |
| `SPY` | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 500 | 127 333 | 75 674 |
| `GOOGL` | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | 500 | 250 234 | 75 440 |
| `RBLX` | `0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8` | 3000 | 157 652 | 65 425 |
| `DELL` | `0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd` | 10000 | 336 699 | 52 629 |
| `NFLX` | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | 3000 | 113 355 | 49 427 |
| `CRCL` | `0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5` | 3000 | 1 171 904 | 48 424 |
| `PLTR` | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | 3000 | 94 164 | 42 338 |
| `AAPL` | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 500 | 122 624 | 32 666 |
| `FIG` | `0x41F4267525a8AFf329540eF24fD83d9044758B33` | 3000 | 82 479 | 27 472 |
| `PFE` | `0x7066A64c24e4206CD62E83bf198c1E7EB361F51e` | 3000 | 54 609 | 26 586 |
| `JNJ` | `0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80` | 3000 | 19 944 | 22 872 |
| `MSTR` | `0xec262a75e413fAfD0dF80480274532C79D42da09` | 10000 | 249 567 | 20 936 |
| `RIVN` | `0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B` | 10000 | 76 891 | 19 233 |
| `AMD` | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | 3000 | 114 622 | 17 907 |
| `META` | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | 3000 | 95 775 | 17 370 |
| `SNAP` | `0xF6589F11Bc40b669e584073F428B05562F568733` | 3000 | 40 577 | 16 110 |
| `MRNA` | `0x43B07D15cE533bEc5476d70C22a78a1B2B662155` | 3000 | 26 915 | 13 842 |
| `WYFI` | `0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E` | 3000 | 45 698 | 11 954 |
| `UPS` | `0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2` | **3000** | 45 301 | 10 370 | re-pinned from 10000 on 2026-09-11, **+45.6 bps** |
| `QUBT` | `0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4` | 3000 | 55 189 | 9 848 |
| `USAR` | `0xd917B029C761D264c6A312BBbcDA868658eF86a6` | 3000 | 56 035 | 9 758 |
| `F` | `0x25C288E6D899b9BC30160965aD9644c67e73bE0C` | 10000 | 42 182 | 9 360 |
| `BE` | `0x822CC93fFD030293E9842c30BBD678F530701867` | 3000 | 81 232 | 8 588 |
| `TSM` | `0x58FfE4a942d3885bAa22D7520691F611EF09e7AA` | 10000 | 115 241 | 7 051 |
| `SKHY` | `0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8` | 3000 | 19 850 | 5 994 |
| ~~`BA`~~ | `0x4D21483a44Bf67a86b77E3dA301411880797D452` | 3000 | 30 031 | 5 849 | **delisted 2026-09-11** — no 30-min TWAP |
| `MRVL` | `0x62fd0668e10D8B72339BE2DCF7643001688ff13B` | 3000 | 52 190 | 5 312 |
| `NU` | `0x408c14038a04f7bD235329E26d2bf569ee20e250` | 10000 | 37 352 | 4 613 |
| `ASML` | `0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA` | 10000 | 42 315 | 4 565 |
| `ON` | `0xbBD09F72b025360FeE5C928053Dca6248d35be54` | 10000 | 18 350 | 4 318 |
| `BULL` | `0xceF9027c7d6985b85f0BA431125073529A947A68` | 10000 | 2 240 | 4 124 |
| `INTC` | `0xc72b96e0E48ecd4DC75E1e45396e26300BC39681` | 3000 | 52 297 | 3 223 |
| `BB` | `0x48E39E56aCdbA37b09020C0b734A613C9a2f100A` | 10000 | 12 492 | 2 252 |
| `CCL` | `0x9651342CeA770aE9a2969Ba2A52611523146aef9` | 10000 | 17 014 | 2 071 |
| `SNDK` | `0xB90A19fF0Af67f7779afF50A882A9CfF42446400` | 10000 | 44 837 | 2 061 |
| `HPE` | `0x59dd09d4900C2E4B5F75b7c0d4E6796fcc234Cb1` | 3000 | 9 180 | 865 |
| `CEG` | `0xaE517A2903E68bd929Dfd15be875F8369D53e94a` | 10000 | 5 816 | 725 |
| `SHOP` | `0xF53F66751B1Eff985311b693531E3290F600c410` | 10000 | 21 856 | 674 |
| `SOXX` | `0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38` | 3000 | 2 138 | 469 |
| `NET` | `0x116F00968269B7bfbaD4109cE591d6E74c0601d4` | 10000 | 7 232 | 462 |
| `RCAT` | `0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460` | 10000 | 12 616 | 254 |
*The other 131 deployed tokens either have no USDG pool at all, or less than
$200 of depth: they are not listable.*

## Three rules that go with it

1. **The allowlist governs creation, not existing vaults.** Removing a token
   alters no basket already in place — only a `setAllocations` by the timelock
   does that, vault by vault. Otherwise removing a dried-up stock would break the
   vaults that contain it, which is worse than the problem.
2. **It gets re-measured.** Liquidity moves; this file is a dated photograph, not
   a constant. To be replayed before every allowlist review, and the diff is the
   only admissible argument for an addition or a removal.
   - **Since 2026-09-11 the chain carries a floor of its own, and it is not this
     one.** `Payd.MIN_ROUTE_DEPTH` refuses a QUOTE whose declared route holds
     less than **$500** on its thinnest hop (T-QUOTE-01) — an order of magnitude
     under the $5 000 below, on purpose. A revert at the policy figure would make
     the registry's own seed deploy or not depending on the block: the same
     cbBTC/WETH pool read $158 774, $4 166, $4 927, $2 496, $9 546 and $11 302
     inside a few hours on 2026-09-11 with its deposits unchanged. The contract
     refuses the typo — cbBTC/USDG tier 3000, a real pool holding **two
     dollars**, which `liquidity() != 0` waved straight through — and the $5 000
     stays here, dated and re-measured. STOCKS get no such floor: a basket line
     that dries up is skipped one leg at a time and the vault keeps running.
3. **Depth is computed on the active liquidity at the current tick.** It is exact
   for small amounts — our case — and becomes optimistic as soon as a purchase
   crosses a tick boundary. It does not replace the TWAP floor at execution, it
   only decides who is allowed into a basket.
4. **And since 2026-09-11 it also decides how much a leg may spend.** The column
   below is no longer read only at listing: `offchain/src/keeper.ts` re-measures
   it per purchase and clamps `buyBasket`'s `amountIn` so that no leg spends more
   than `MAX_LEG_DEPTH_BPS` — **one whole depth** — of its pool's +1 % depth
   (`offchain/src/buy.ts`). See below for why that bound is off-chain.

### The per-stock maximum leg — T-TWAP-01

`FeeVault._legFloor` floors every leg at a **constant** `MAX_SLIPPAGE_BPS = 300`
while the purchase **scales** with the reserve, and nothing in the contract
compares the two. A leg that is a few per cent of a pool therefore executes
*inside* the band and the vault eats the impact — no attacker, no event, no
revert. Measured at block 60310000 on the thinnest listed pool:

| leg | pool | spent | filled | against the TWAP |
| :--- | :--- | ---: | ---: | ---: |
| MRVL 9 000 bps of a 24 ETH reserve at `MAX_PAYOUT_BPS` | MRVL/USDG 3000, $5 312 of depth | 5 576.98 USDG | 23.0942 MRVL | **9 722 bps — 2.78 % under**, ≈ $155 |
| MRVL 9 000 bps at the steady-state size (§2.4) | the same pool | 299.90 USDG | — | 9 959 bps — 41 bps under, of which 30 is the pool's fee |

**The maximum leg per stock is one whole `depth`**, re-measured per purchase
rather than read off the table above — **and the difference between the two is
the reason it is re-measured**. The MRVL/USDG tier-3000 row below reads $5 312,
photographed 2026-09-08; the same pool at block 60310000 reads **841.86 USDG**.
Rule 3 already says this quantity moves; a ceiling read from a dated table would
be wrong by 6× in either direction.

The value of the ceiling is derived from the two fills measured at that block,
not chosen:

    leg   299.90 USDG  =   35.6 % of depth  ->   41 bps under the TWAP (30 = the pool fee)
    leg 5 576.98 USDG  =    662 % of depth  ->  278 bps under

Impact is near enough linear in the ratio, so one whole depth of leg is about
**30 bps** — a tenth of the 300 bps band, and the size at which the steady-state
purchase is not clamped at all. A tighter ceiling buys nothing: at 10 % the
harmless $300 leg above would be cut to $84 and every ordinary window would be
sliced. It is a keeper heuristic and not part of any root: nothing reconstructs
it, so it can be retuned without making an honest keeper look forged.

**Why the DEPTH is not read on-chain — and what is.** The obvious fix —
`_legFloor` reading `slot0()` and `liquidity()` off the leg's pool and refusing
above the cap — was built and sized: **+876 bytes, landing `FeeVault` at 24 842
against the 24 576 cap**. It does not deploy.

What ships instead caps the **purchase** rather than reading the pool:
`FeeVault.MAX_BUY_MULTIPLE`, forty `MIN_BUY_QUOTE` (~$1,000) per call, +74 bytes,
no oracle and no pool read. It binds **everyone**, which the keeper-side clamp
below cannot — `buyBasket` is permissionless. Measured at the pinned block it
takes the 24 ETH case from 278 bps under the TWAP to **64** (30 of which is the
pool's own fee) and leaves the steady state untouched. The per-leg clamp below
stays on top of it, because it is finer: it knows which pool. Two variants remain available and unbuilt: an external
`PoolDepth` library (~+150–250 bytes on `FeeVault`, ~+2 600 gas of `DELEGATECALL`
per leg) or moving `hookStatus` / `poolKey` / `getAllocations` to a lens
contract to pay for the inline version.

**What the off-chain bound does not cover, stated rather than implied.**
`buyBasket` is permissionless. A stranger can still call it at a size the
keeper would have refused; they gain nothing by it — the bounty is capped at
`MIN_BUY_QUOTE` either way — and the impact falls on the holders. That residual
is recorded as an accepted risk in `FLOWS.md` §7.e with the reserve sizes that
reach it: **$443k of free reserve at `payoutBps = 400`, $177k at the
`MAX_PAYOUT_BPS = 1 000` ceiling**, against a steady state of ~$8.3k at
$500k/day of volume.

## Replaying the measurement

```bash
set -a; . .env; set +a

# 1. the candidates: Robinhood's list, to be re-verified and not copied
# 2. for each token x {100, 500, 3000, 10000}:
#      UniswapV3Factory.getPool(USDG, token, fee)          0x1698ee82
# 3. for each non-zero pool:
#      USDG.balanceOf(pool)                                0x70a08231
#      pool.slot0()                                        0x3850c7bd
#      pool.liquidity()                                    0x1a686502
# 4. depth at +1 %, from the active liquidity L and sqrtP:
#      USDG = token1:  dY = L x sqrtP x (sqrt(1.01) - 1)
#      USDG = token0:  dX = L / sqrtP x (sqrt(1.01) - 1)
```

The RPC cuts off at **429 beyond ~40 requests per JSON-RPC batch**: batch by 40
with a backoff, otherwise the measurement is silently incomplete.

---

## The second measurement: the 30-minute TWAP — 2026-09-08

Depth is not enough. Every leg's floor comes from
`TwapFloor.meanTick(pool, 1800)`, and Uniswap v3 **reverts** (`OLD`) when the
pool's observation history is shorter than the window asked for.

A stock in that state is not "slightly worse": `_swapLeg` catches the revert and
skips the leg. The weight a creator gave it **never** converts, silently, for the
whole life of the vault. Listing it means handing out a basket with a dead slot
in it.

The 49 stocks kept on depth were therefore run through `observe([1800, 0])`, the
exact call the vault makes.

| | |
| :--- | ---: |
| Stocks kept on depth | 49 |
| 30-min TWAP that answers, on the morning of 2026-09-08 | 48 |
| **30-min TWAP that answers, re-probed that evening** | **47** |
| Rejected | **`MRNA`**, then **`QUBT`** |

`MRNA` (`0x43B07D15…`) reverts with `OLD`: `observationCardinality = 1`. A single
observation point, a pool too new. It will pass again as soon as its history
covers 1 800 s; `allowStocks` overwrites an existing entry, so re-listing it is
an ordinary timelock operation.

**To watch — and what I got wrong saying it the first time.** This section
announced `PFE` (cardinality 64) as the fragile stock. The next day it was
**`QUBT` that fell**, with a cardinality of 8 — ten times worse, and I had not
seen it because **my probe could not read the cardinality**: parsing `slot0()` in
shell returned empty on most pools, and I published the one figure that did come
out as if it were the minimum.

The lesson fits in one line: **the check that counts is `observe([1800, 0])`, the
exact call the vault makes.** Cardinality is a capacity, not a guarantee — a pool
with 64 spaced-out observations covers more time than a pool with 8 that trades
continuously. A behavioural probe answers straight; a structural probe demands a
decoding you can get wrong without noticing.

### A methodological trap, not to be repeated

The first pass returned **4 failures**. Three were false: the RPC returned a
timeout that the probe counted as a revert, and two `getPool` calls had come back
empty on pools that exist (`GME`, `AMZN`). Re-run serially with a probe that
**tells transport from execution**, all three pass.

A probe that treats "no answer" as "negative answer" is not measuring the chain,
it is measuring the network. The corrected version only concludes on an explicit
`execution reverted`, and retries eight times otherwise.

### The same trap, one size up — 2026-09-11

`CheckTiers` answered `2 of 46 stocks pinned on a costlier tier` on the morning of
the deployment. **Both are false**, and for a reason that is the mirror image of
the note above: it does not measure what the vault will do.

`TRADE = 500e6` — the script compares tiers by quoting **500 USDG**. At that size
a lower fee dominates; at any size the depth starts to matter, it does not.
Measured on `SLV`, the stronger of the two candidates:

| in | tier 500 | tier 3000 | |
| ---: | ---: | ---: | :--- |
| 500 USDG *(the probe)* | — | — | 500 wins, **+24 bps** |
| 1 000 USDG | 16.926 SLV | 16.974 SLV | **3000**, +28 bps |
| 10 000 USDG | 165.32 SLV | 169.57 SLV | **3000**, **+257 bps** |

Liquidity says why: **`L = 1.57e16` at tier 500 against `1.21e18` at tier 3000**,
seventy-seven times deeper. The crossover sits just above the probe. `SGOV`, the
other candidate, adds an 8-slot observation ring to the same thinness.

**And the risk is asymmetric, which is what settles it.** A tier is pinned once,
for every vault, until a timelock operation moves it. The gain is capped at 24
bps on dust; the loss grows without bound with the size of the purchase — 2.6 %
at 10 000 USDG and worse above. Neither was re-tiered.

The script is not wrong, it is narrow: it reports candidates, it does not decide.
Its output reads as a verdict, which is the part that costs time. **Quote twice,
small and large, and a candidate that only wins at one end disqualifies itself.**
The rule underneath is the one already written above, turned around: a probe
bigger than the depth measures the probe, and a probe smaller than the trade
measures the fee.

### The Chainlink feeds

19 of the 48 carry a feed; the other 29 run on the TWAP alone, which is a
**supported state** and not a hole (`ARCHITECTURE.md` §S3: equity feeds go stale
over the weekend, the TWAP never does). Chainlink only ever **tightens** the
floor when it is fresh.

Every feed address was re-read through `description()` and `decimals()` before
going into the script. **One was the token's address and not the feed's** — it
would have dropped META onto a TWAP-only floor with nothing flagging it, because
`_oracleOut` is designed never to revert.

Five stocks on the list (`ASML`, `BABA`, `USAR`, `DELL`, `MU`) have a feed
according to the recon census, but its address was never written down. They are
listed as TWAP-only; re-listing them with their feed is an ordinary timelock
operation the day we measure them.

### `$PONS` added to the STOCK list — 2026-09-10

Not a delisting, and not a stock. **$PONS is the token of the launchpad that
hosts every vault in this system**, and a creator who wants their holders paid
partly in it should be able to say so. Nothing in this list ever required an
equity: the two criteria ask about a POOL, and the word "stock" throughout these
files is a habit, not a rule.

It passes both, and the tier is the interesting part. Read on the real pools:

```
PONS/USDG tier  3000  L 1.78e16   observe([1800, 0]) -> REVERTS (OLD)
PONS/USDG tier 10000  L 6.42e18   observe([1800, 0]) -> answers
                                  depth before +1 %  -> $24 384
quoter, 500 USDG in:  tier 3000 -> 831.1 PONS
                      tier 10000 -> 853.5 PONS
```

**The 1 % tier is both deeper and cheaper** — the case `script/CheckTiers.s.sol`
exists to catch, and the reason that script compares quoter output rather than
raw `L`. Pinning 3000 because it is the smaller fee would have listed a token
whose 30-minute window does not answer: `_swapLeg` catches the revert and skips
the leg, so the weight a creator gave $PONS would never convert, silently, for
the vault's whole life. The likeliest mistake really is the right token at the
wrong tier.

No Chainlink feed exists for it, so the floor is the TWAP alone. That is the
supported state (`ARCHITECTURE.md` §S3) and here it is the better one: the equity
feeds go stale from Friday night to Monday, and this pool does not.

**The stock list goes to 47.**

**It was DELISTED as a QUOTE the same day, and the two are not in tension.**
`test_EveryListedQuoteRunsTheWholeCycle` found that Pons's own factory refuses
$PONS as a `pairToken` (`0x49285dfb`, the error WETH and `0xdead` get;
`launchConfigCount()` is 1, so no other config could accept it). Nobody can
LAUNCH a token paired against $PONS, so that row handed a creator a vault that
binds to nothing. Buying $PONS for holders asks nothing of Pons at all. Two
lists, two questions — the same reason `BE` sits on one and not the other.

### `BE` dropped from the QUOTE list — 2026-09-10

`test_EveryQuoteRouteCarriesEnoughDepth` went red: `BE` (`0x822CC93f…`, tier
3000) carries **$2 252** of depth against the pivot, against the **$8 588**
measured on 2026-09-08 and the $5 000 the test demands. Confirmed on both RPC
endpoints, and it fails identically on the code that preceded the change being
worked on — the market moved, nothing regressed.

A quote is where a launch's whole creator stream arrives, and every wei of it
crosses that pool on its way to the pivot. $2 252 of depth is not a delay, it is
a haircut on every harvest for as long as the vault lives — and a vault's quote
is stamped at birth, so nobody can move it afterwards. **Dropped from
`script/Quotelist.s.sol`: 45 quotes to 44.**

`BE` stays on the STOCK allowlist, and that is not an inconsistency. A basket leg
that cannot be bought is skipped and its pivot currency waits for the next
purchase (`FeeVault._buyLegs`), so a thin stock costs a delay. A thin quote costs
money, every time. Two lists, two thresholds, because the two failures are not
the same failure.

Re-listing is an ordinary timelock operation the day the depth comes back.

### `LLY` and `UPS` re-pinned — 2026-09-11, and what the check was missing

`script/CheckTiers.s.sol` named seven of forty-six stocks as sitting on a
costlier tier. Two were moved. **Five were not, and the reason is the half the
script did not measure.**

| | pinned | better | gain | candidate's ring | |
| :--- | ---: | ---: | ---: | :--- | :--- |
| `LLY` | 10000 | **500** | +131.2 bps | 1 800, answers | moved |
| `UPS` | 10000 | **3000** | +45.6 bps | 1 400, answers | moved |
| `SGOV` | 3000 | 500 | +47.0 bps | **8**, answers today | left alone |
| `RDDT` | 10000 | 3000 | +48.2 bps | **1**, answers today | left alone |
| `TSLA` | 3000 | 500 | +20.9 bps | 8, **reverts `OLD`** | refused |
| `RIVN` | 10000 | 3000 | +50.9 bps | 1, **reverts `OLD`** | refused |
| `F` | 10000 | 3000 | +52.0 bps | 1, **reverts `OLD`** | refused |

The script compared what a tier RETURNS — fees plus slippage at the quoter, over
the amount actually traded — and that is the right cost criterion. It said
nothing about whether the tier can serve `TWAP_WINDOW`. Moving `TSLA`, `RIVN` or
`F` onto those pools would have bought a cheaper quote and a line that converts
**never, and in silence**: no floor can be computed, `_legFloor` returns 0, the
leg is skipped every purchase and its weight piles into `pivotReserve`. That is
`BA`, delisted the same day for exactly it.

`SGOV` and `RDDT` are the subtler half. Their candidates answer **today**, on 8
and 1 slots. They will answer until the pool gets busy, and then they will not —
which is how `PFE` and `BA` both died. A ring that thin is not a saving, it is a
delay before the same note gets written again.

`CheckTiers` now asks both questions and refuses to name a tier its ring cannot
serve, printing the cardinality of the one it does name.

### `BA` delisted — 2026-09-11, the night before the deployment

Same test, same failure mode as `PFE`, and it was caught by running the suite
against the frozen tree rather than by re-reading the list.

`BA` (`0x4D21483a…`, pool `0xc6517047…`) reverts `OLD` on `observe([1800, 0])`.
Read with `cast` at block **59 798 432**, outside the fork:

| | |
| :--- | ---: |
| `observationCardinality` | **32** |
| newest observation | `1 789 084 960` |
| oldest observation (index 18) | `1 789 083 726` |
| **span of the ring** | **1 234 s = 20.6 min** |
| oldest observation's age at the read | 1 488 s |
| what the window asks for | **1 800 s** |

**Not depth**: $30 031, six times the $5 000 floor, and `liquidity()` reads
1.73e17. The pool is too BUSY for its buffer — 32 observations consumed in under
21 minutes.

**And `BA` has no Chainlink feed**, so the TWAP is the only floor it has
(`feeds[]` is the zero address, "TWAP-only floor"). With no floor the leg is
skipped every time and its weight sits in `pivotReserve` for ever — which is
exactly what the test's message says, and why a stock in this state has to leave
the list BEFORE deployment: afterwards it is a timelock operation and 48 h.

**It is repairable, and that is worth writing down rather than forgetting.**
`increaseObservationCardinalityNext(uint16)` is **permissionless** on a Uniswap
v3 pool: anyone may pay to grow another pool's observation ring, and it changes
nothing else — not the price, not the liquidity, not the fees. Taking this ring
from 32 to 64 slots is ~640 k gas, about **$0.20** at the basefee of that night.
The cardinality then grows one slot per swap until it reaches the new target, so
the span clears 1 800 s on its own within an hour or so of normal trading. The
same is true of `PFE` (64 slots, 10.7 min) and of every pool this check has
rejected for a short ring.

**Not done, and not because of the cost.** It is a transaction sent from an
address of ours to a third party's pool on the eve of a launch — an on-chain edge
that did not exist before, and an OPSEC decision rather than a fix. It belongs in
`DECISIONS.md` with whatever is decided. Re-listing afterwards is an ordinary
timelock operation, because `allowStocks` overwrites an existing entry.

**The list goes to 46** — 45 stocks and `$PONS`.

### `QUBT` delisted the same day — 2026-09-08, evening

`test_EveryListedStockHasALiveThirtyMinuteTwap` went red a few hours after being
written. It is not a false positive: `QUBT` (`0x59818904…`, pool `0x227Bbce9…`)
reverts `OLD` on `observe([1800, 0])` and still answers at 600 s. Verified
separately with `cast`, outside the fork.

**The test did exactly its job**, and sooner than expected. That is the argument
for this check living in the suite rather than in a throwaway script: the
property rots on its own, and the failure it prevents is silent.

It named `OLD` without saying which pool — fixed along the way: it catches the
revert per stock and prints the offending address. A test that rots by
construction has to say *what*.

**The list goes to 47.** `QUBT` will pass again as soon as its history covers
1 800 s; `allowStocks` overwrites an existing entry, so re-listing it is an
ordinary timelock operation.
