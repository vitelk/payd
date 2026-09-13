# recon.md — Phase 0

**Chain**: Robinhood Chain (Arbitrum Orbit L2), **chainId 4663**
**Date of every verification**: **2026-09-02** (reference block ≈ **52,742,000–52,748,000**)
**RPC used**: `https://rpc.mainnet.chain.robinhood.com` (fallback `https://robinhood-rpc.publicnode.com`)
**Explorer**: `https://robinhoodchain.blockscout.com` (Cloudflare: requires a browser User-Agent)

Verification methods used, noted on each line:
- `cast` = on-chain call (`cast call` / `cast storage` / `cast estimate` / `cast logs`)
- `src` = verified source code read on the explorer
- `logs` = events decoded from `eth_getLogs`
- `UNVERIFIED` = no on-chain proof obtained → **to be settled with you, nothing has been assumed**. **As of 2026-09-04 none remain that block the launch — see §10.**

> **Two points change the plan**: (1) the creator fees arrive as **native ETH** but the claim is restricted to `msg.sender`, so `FeeVault` must be the `creatorFeeRecipient` and call `claim()` itself — §1.2; (2) the pushed airdrop costs **$0.40–0.61 per holder per epoch** — §6, solutions in `ARCHITECTURE.md` §S2.
>
> Corrected in the **3rd pass** on 2026-09-03: the identification of Pons v2 was wrong in passes 1 and 2. History and cause in §1.6. **Launching is open** (§9.1).

---

## 0. Short answers to the two blocking questions

> **Corrected on 2026-09-03 (3rd pass).** The two previous passes named the wrong factory. The real address was obtained by starting from `PonsV2LaunchAndBuy` (`0xe33E9E47…`, 79,462 tx), whose `factory()` points at the v2. History of the errors in §1.6.

**Pons v2 = `PonsV2LaunchFactory` `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`** — source verified, `owner() = 0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd` (the Pons operator), **`launchEnabled() = true`**.

**Q1 — Can a contract be the creator wallet, and does the claim require `msg.sender == creator`?**

- **Yes, a contract can be the `creatorFeeRecipient`.** There is no constraint on the account type; only a few system addresses are excluded.
- **Yes, the claim requires `msg.sender == recipient`.** `V2FeeEscrow.claim()` reads `_balances[msg.sender]`: nobody can claim on the recipient's behalf. **So `FeeVault` must *be* the `creatorFeeRecipient` and call `claim()` itself.**
- **The fees are in native ETH** when the launch's `pairToken` is native ETH — and `pairToken` is **an argument of `launchToken`**, so it is our choice. The escrow pays through `call{value:}`: no 2300-gas limit, a `receive()` is enough. (`creditToken`/`claimToken` exist for launches quoted in an ERC-20.)
- **Compensation**: `creatorTaxBps`, **chosen at launch**, capped at `maxCreatorTaxBps() = 1000` (10 %), *"paid entirely to the creator"*. It is added to the curve's 1 % `curveFeeBps`.

**And above all: launching is OPEN.** `launchEnabled() = true`, `launchFee() = 5e14` (0.0005 ETH), and the official forwarder `launchForwarder() = 0xe33E9E47…` processes launches continuously (the last 50 tx = 50 successful `launchAndBuy`, the most recent on **2026-09-03 at 12:13**). There is **no blocker**: my passes 1 and 2 concluded the opposite by looking at the v1.

**Q2 — Do the stock tokens accept being held by a contract, and are the pools permissionless?**

Yes to both, unchanged since the 1st pass:
- Stock tokens = upgradable `BeaconProxy`, single beacon, with a **blocklist** and not an allowlist → **a non-blocklisted contract can hold them**. Empirical proof: `PoolManager`, several `SafeProxy` and a `TimelockController` are in the NVDA top-10 holders.
- **Route chosen: `ETH → USDG → stock` on Uniswap v3, 2 hops** (§4). Measured slippage for 0.5 ETH: **0.002 % to 0.09 %** (§4.2). Stock liquidity sits against **USDG**, not against WETH.
- Uniswap v4 is permissionless (hookless pools) but its deep tiers are at 1–5 %: v3 wins by ~1.7 % on a real quote (§4.3).

## 1. Pons

### 1.1 Pons v2 — production (verified 2026-09-03)

| Role | Address | Verification |
|---|---|---|
| **`PonsV2LaunchFactory`** | **`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`** | src, solc 0.8.35; `owner()` = Pons operator |
| **`PonsV2LaunchAndBuy`** (official forwarder) | **`0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`** | src; `factory()` → the v2; **the factory's `launchForwarder()` points at it**; 79,462 tx |
| **`V2FeeEscrow`** | **`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`** | src; the factory's `feeEscrow()` |
| Locker v2 | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | `locker()` |
| BuybackVault v2 | `0x42df2a798f82289E177311362e8f5ccC45c1219c` | `buybackVault()` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | `poolManager()` — **the canonical Uniswap v4 PoolManager** (§3.2) |
| Launch deployer | `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` | `factory()` → the v2 (read 2026-09-04). Listed by docs.ponsfamily.com/v2, absent from every earlier pass. Not on our path: we launch through the forwarder `0xe33E9E47…`. |

**`phase` enum** (`LaunchedToken.phase`, from docs.ponsfamily.com/v2): `0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued`. Only **2** creates the v4 pool — a `Rescued` graduation never gets one, so `sweepPoolFees` stays unreachable in phase 3. `FeeVault` is unaffected (it branches on `curve.graduated()` and wraps both sweeps in `try`), but `offchain/src/rehearsal.ts` used to report `phase >= 2` as "post-graduation path is live"; corrected.

State measured on 2026-09-03:

| Parameter | Value |
|---|---|
| `launchEnabled()` | **true** |
| `launchFee()` | 5e14 (0.0005 ETH) |
| `maxCreatorTaxBps()` | 1000 (**10 % max**) |
| `LaunchConfig[0]` | `supply = 1e27` (1 B), `curveFeeBps = 100` (1 %) |
| `pairToken` | **an argument of `launchToken`**, not fixed in config → native ETH possible |
| `CREATOR_FEE_RECIPIENT_TIMELOCK` | **259,200 s = 3 days** |
| `CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW` | 259,200 s = 3 days |
| `snipeTaxStartBps` / `snipeTaxSeconds` | 9900 (99 %) decaying over **3 s** |

Useful signatures (verified ABI):
```
launchToken((...) params, uint256 launchConfigId, address pairToken)
launchToken((...) params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions)
getLaunchedToken(address) -> (token, curve, deployer, creatorFeeRecipient, pairToken,
    graduationThreshold, poolFee, tickSpacing, creatorTaxBps, buybackEnabled,
    phase, sweptQuote, sweptTokens, sweptAt, exists)
```

### 1.2 The fee mechanism (this is what drives `FeeVault`)

`V2FeeEscrow` — full interface:
```
credit(address recipient) payable            // credits in native ETH, permissionless
creditToken(address recipient, address token, uint256 amount)
claim()                    -> uint256        // ALL of msg.sender's balance
claim(uint256 amount)      -> uint256        // partial
claimToken(address token)  -> uint256
balanceOf(address recipient) view
balanceOfToken(address recipient, address token) view
```

```solidity
function claim() external nonReentrant returns (uint256 amount) {
    amount = _claim(_balances[msg.sender]);   // <- msg.sender, no delegation
}
```

Three architectural consequences:
1. **`creatorFeeRecipient = FeeVault`, and `FeeVault.harvest()` calls `claim()` itself.** No third party can do it on its behalf. `harvest()` stays callable by anyone — it is `FeeVault` that is `msg.sender` towards the escrow, not the keeper.
2. **`pairToken = address(0)` (native ETH) ⇒ fees in native ETH**, exactly the assumption in `docs/CONVENTIONS.md`. A `receive()` is enough.
3. **Changing the recipient ourselves is INSTANT.** `transferCreatorFeeRecipient`, called by the current recipient, applies in the same transaction. Corrected 2026-09-04 — earlier passes of this document described a 3-day procedure, confusing it with the owner-only path in §1.3b.

`credit(address)` is **permissionless**: anyone can credit anyone. The escrow's balance is therefore not proof of revenue — never read it as a metric.

### 1.3 The buffer wallet

`setCreatorFeeRecipient` is restricted to the current creator, and the change is timelocked for 3 days (§1.2). The scheme stays the one you proposed:

1. the **buffer wallet (Safe multisig)** launches the token → it is the `deployer`.
   A Safe 1.4.1, **2-of-3**. Its address is deliberately not written here: this
   file is public, `getOwners()` is a public view, and the pair turns one
   address into a list of signers for anyone who reads the repository. The
   deployment's own address lives in the private runbook;
2. `creatorFeeRecipient = FeeVault` from the launch onwards;
3. `FeeVault.harvest()` calls `escrow.claim()`, the ETH arrives, nobody else has any power over the nominal path;
4. if Pons changes or `FeeVault` has to be replaced, the buffer calls `transferCreatorFeeRecipient` — **immediate**, in that transaction. (Corrected 2026-09-04: this line still carried the 3+3 day figure that belongs to the `onlyOwner` path in §1.3b, and contradicted §1.2 point 3 four lines above it.)

The buffer can redirect the future flow: a Safe multisig is mandatory, never an EOA. And there is **no delay in our favour here** — our own path is immediate. The 3-day notice belongs only to Pons's `onlyOwner` path (§1.3b). **Corrected 2026-09-08.** That was true while `emergencyRedirect()` existed and pointed at the Safe: a compromised Safe reached an arbitrary recipient in two immediate transactions. `migrate` replaced it (§S24, `PLAN.md` D6) and closes that path — it is callable by the **timelock** alone, so 48 h of public notice, and its destination is not free: a vault of the same token, same creator and same currency, registered on `Payd` — `isVault`, written by `_create` and by nothing else — paying holders at least as well. The Safe proposes; it no longer redirects. What a compromised timelock can and cannot do is measured in `test_WhereACompromisedTimelockCanSendTheStream`.

### 1.3b Pons's owner can redirect our fees, with 3 days' notice

**Found 2026-09-04, while writing a fork test for the escape valve. Not
previously documented, and it outranks several risks that were.**

There are two paths to the `creatorFeeRecipient`, and they are not symmetric:

| Function | Caller | Effect |
|---|---|---|
| `transferCreatorFeeRecipient(token, new)` | the **current recipient** | **immediate** |
| `setCreatorFeeRecipient(token, new)` | **`onlyOwner`** — Pons | pending, `CREATOR_FEE_RECIPIENT_TIMELOCK` = 3 days, then anyone calls `executeCreatorFeeRecipientChange` |

The 3-day timelock is not a constraint on us. It is the notice period on **Pons's
standing power to redirect any launch's fees**, and the factory says so in its own
comment:

> *"the owner may redirect the recipient of any launch"* … *"`transferCreatorFeeRecipient`
> deliberately does not cancel it, so the timelock is a notice period rather than
> a window in which the creator can veto by moving the recipient themselves. The
> override is therefore a standing protocol power over creator fee routing, not a
> narrowly scoped lost-key recovery."*

**We cannot veto it.** Moving the recipient ourselves does not clear their pending
change; a matured proposal takes precedence. `cancelCreatorFeeRecipientChange` is
`onlyOwner`.

**What is and is not at risk.** Only the *future* stream. ETH and stocks already
in our contracts stay ours and stay claimable — the same boundary as our own
escape valve (`ARCHITECTURE.md` §S24).

**The only mitigation is noticing.** Watch the factory for a pending change on our
token and react inside the 3 days: tell holders, wind the cycle down, drain what
is drainable. That is a monitoring requirement, not a defence, and it belongs in
whatever alerting runs alongside the keeper.

### 1.4 Earlier deployments and namesakes — not to be confused

| Contract | Address | Actual status |
|---|---|---|
| `PonsLaunchFactory` **v1** | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | Pons v1. `launchEnabled = false`. This is what the docs call "Active factory" **in the v1 tab**. |
| `PonsLaunchLocker` v1 | `0x736D76699C26D0d966744cAe304C000d471f7F35` | v1. Fees in **WETH** through `collectFees` on a v3 LP position, creator 70 %. |
| Earlier `PonsLaunchFactory` | `0x0c37a24F5D23A486FA692d1500881d698B1F77a4` | The docs' "Legacy". Closed. |
| `HoodpadV2LaunchFactory` | `0xB1e9396F1540ba1F55aF432B5C7668C39a989451` | **Same code base as Pons v2, renamed, deployed by a third party** (`0x6b23C2fE…`) on 2026-09-03 at 10:42. Zero launches. **Not Pons.** |
| `PonsFactory` / pons-factory.fun | `0xE1aD3F2C507c2d4128c166d5Fa78Cc86CC94913c` | A third-party project built on top of Pons. Quote = the graduated PONS token. Owner `0xa1A7CC00…`. |
| Cloned `PonsLaunchFactory` | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` | Third-party clone, `protocolFeeShare = 100` → **the creator receives 0**. Never launch on it. |
| `RWAERC20LaunchpadFactory` | `0xcE9C48cFa068947f77738c81Be406B53338E5B0d` | **Another launchpad, unrelated to Pons** (owner `0x5519a8Cc…`). Alive and open (48 launches out of 50 tx). Uniswap v4, native ETH + USDG quotes, 1 % fee split CREATOR 50 / PLATFORM 30 / REFERRER 20 bps. **Its escrow has a permissionless `claimFor(recipient, currency)`** — a more flexible fee model than Pons v2. A credible alternative, see §9.1. |

### 1.5 What applies to us regardless of the launchpad

- **Snipe tax**: 99 % decaying over 3 seconds after the launch. No effect on us (we do not trade at launch), but worth knowing for the dev buy.
- **`buybackEnabled`** and a `BuybackVault` exist at the protocol level: to be decided whether we enable it, it changes the token's dynamics.
- **`sweptQuote` / `sweptTokens` / `sweptAt` / `phase`**: graduation happens in two steps (curve → sweep → v4 pool). The `FeeVault` must tolerate fees pausing during the transition.

### 1.6 History of the corrections — why I was wrong twice

For transparency, so the document stays auditable:

| Pass | Conclusion | Cause of the error |
|---|---|---|
| 1 | "Pons v2 = pons-factory.fun `0xE1aD3F2C…`" | the only system where a `launch` succeeded that day; I had no authoritative source |
| 2 | "Pons v2 = `0xA5aAb3F0…`, launching closed" | docs.ponsfamily.com has **v1 / v2 tabs**; the SSR HTML I scraped contained the **v1** tab, and I took it for the truth |
| 3 | **"Pons v2 = `0x7eD598Bc…`, launching open"** | address taken on trust from a third party; `factory()` on `PonsV2LaunchAndBuy` confirms it, `owner()` = Pons operator |

**The address was in front of me from pass 2 on**: `0x7eD598Bc…` appears 3 times in ponsfamily.com's JS bundle (chunk `c33.js`, the one that also contains `previewLaunchEconomics` and `FACTORY_ADDRESS`). I had listed it in a frequency dump and discarded it along with the library constants. Lesson taken and applied to the rest of this document: **an address found in a product's front end must be tested on-chain (`owner()`, `factory()`), not sorted by eye.**

### 1.7 Two fee regimes: before and after graduation

This is the most important point for the keeper, and it is not visible from the ABI alone.

**Before graduation (bonding curve).** The creator tax **does not go to the escrow on each trade**: it accumulates on the curve in `creatorTaxBalance`. It is only pushed to the escrow by `sweepFees`, and that function is **guarded** (`PonsV2BondingCurve`, source read):

```solidity
function sweepFees(uint256 minBuybackTokensOut) external nonReentrant {
    if (graduated) revert AlreadyGraduated();
    bool isOperator = msg.sender == feePolicy.feeSweepOperator();
    if (!isOperator && msg.sender != deployer) revert NotFeeSweepOperator();
    if (!isOperator && _requiresTrustedOperator()) revert InternalSwapRequiresOperator();
    _sweepFees(minBuybackTokensOut, true);
}
```

**CORRECTED 2026-09-04.** The field the curve calls `deployer` is **not** the
wallet that launched the token — it holds the creator FEE RECIPIENT, our
`FeeVault`. Read on a fork against a real launch of our own:

```
curve.deployer()                    = the FeeVault
sweepFees() from the launching EOA  -> NotFeeSweepOperator (0x8d42130c)
sweepFees() from the FeeVault       -> succeeds, credits the escrow
```

So, during the curve phase:
- **the `creatorFeeRecipient` (our `FeeVault`) and Pons's `feeSweepOperator` can
  trigger the sweep** — the launching Safe cannot;
- **and if `buybackEnabled` is true with a pending buyback balance, the `deployer` itself is excluded** (`InternalSwapRequiresOperator`): only the Pons operator remains.

**→ Consequence: `buybackEnabled = false`.** Otherwise we create a liveness dependency on a Pons operator to collect our own fees. With the flag false, the buffer is enough. It is the right product choice anyway: the protocol buyback buys back and then **locks for 5 years** in `V2BuybackVault` (`VESTING_DURATION = 157,680,000 s`) — it does not burn, unlike what we want to do.

**After graduation (Uniswap v4 pool + `PonsV2MemeHook`). CORRECTED on 2026-09-03 — I had written the opposite.**

I had written here: *"the fees are credited to the escrow by the hook as swaps happen, with no intervention; `FeeVault.harvest()` is then enough"*. **That is false.** The hook **accumulates** the fees; pushing them to the escrow requires an explicit call to the hook, and that call is **restricted to Pons's `feeSweepOperator`**.

Measured on BERRY (`0xDD405f43…`), a token that graduated on 2026-09-03 — detail in §1.9:

| | |
|---|---|
| Credit to the escrow | tx `0xbf3a155c…`, direct call to the hook, selector `0x3d61055e` |
| Caller | `0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2` |
| = `feePolicy.feeSweepOperator()` | yes — and `cast code` returns 0 bytes: **it is an EOA** |

A differential test on the same calldata, which separates access control from state:

| Caller | Result |
|---|---|
| Pons's `feeSweepOperator` | **passes access control** (fails further on with `0x71c4efed` = `SlippageExceeded`, not on permissions) |
| the token's `deployer` | **`NotFeeSweepOperator()`** |
| any address | **`NotFeeSweepOperator()`** |

**CORRECTED AGAIN on 2026-09-04. The conclusion above was wrong, and the
differential test was testing the wrong address.**

The hook is verified as `V2MemeHook`. Its `sweepPoolFees` reads:

```solidity
function sweepPoolFees(PoolId poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
    external nonReentrant
{
    LaunchInfo memory info = launches[poolId];
    if (!info.registered) revert UnknownPool();
    bool isOperator = msg.sender == feeSweepOperator;
    if (!isOperator && msg.sender != info.creator) revert NotFeeSweepOperator();
    if (!isOperator && _requiresTrustedOperator(poolId, info)) revert InternalSwapRequiresOperator();
```

It accepts the operator **or `info.creator`**. And `info.creator` is the creator
**fee recipient**, not the token's deployer — `setCreatorFeeRecipient` is
`onlyFactory` and writes `info.creator = newRecipient`. Read on-chain for BERRY,
poolId `0x851977f5…`:

```
launches[poolId].creator = 0x45c6C76088cd369735065654da56201c8b9e90b7
BERRY.creatorFeeRecipient = 0x45c6C76088cd369735065654da56201c8b9e90b7   <- same
```

My differential test used the token's **`deployer`**, which on BERRY is a
different address. It was correctly rejected, and I generalised that rejection to
"nobody but Pons", which does not follow.

**So `FeeVault`, being the `creatorFeeRecipient`, can sweep its own fees.**

**And the two buckets travel together.** There is no pool-fee/creator-tax split in
the gate: one call zeroes and distributes both `pendingFees` (our 70 % share of
the 1 % hook fee) and `pendingCreatorTax` (our 4 %), with
`creatorAmount = creatorBucket - buyback + taxQuote`.

**What actually gates a non-operator caller** is `_requiresTrustedOperator`:

```solidity
if (pendingFees[poolId][info.memecoin] != 0 || pendingCreatorTax[poolId][info.memecoin] != 0) return true;
return pendingBuyback[poolId][info.quoteToken] != 0;
```

The gate is the **currency**, not the bucket. Fees accrue in whichever token the
swap paid in, so sells leave memecoin-denominated fees pending; sweeping those
needs an internal memecoin→ETH swap, capped at `maxInternalPriceImpactBps = 300`,
and only the operator may trigger that. `pendingBuyback` stays 0 for us since we
launch with `buybackEnabled = false`.

Measured live on 2026-09-04:

| Pool | pendingFees[ETH] | pendingFees[memecoin] | Creator can sweep? |
|---|---|---|---|
| BERRY | 0 | 0 | nothing to sweep |
| HASH | 0.0103 ETH | 5.30e24 | **no** — memecoin pending, operator only |

**Revised assessment.** We are not fully dependent on Pons, and not fully
independent either. After any operator sweep the memecoin buckets are zero, and a
stretch of buys keeps them zero — in those windows `FeeVault` can sweep itself.
As soon as a sell lands, only the operator can. So it is opportunistic
self-service with an operator fallback, rather than the hard third-party liveness
dependency recorded before.

Practical consequence: `harvest()` should attempt `sweepPoolFees` in a
`try/catch` before claiming from the escrow. It costs one failed call when the
gate is closed, and removes the wait whenever it is open.

**What that costs when the gate is closed, measured.** The operator runs very
often across all pools — 2,328 sweeps in 300,000 blocks (~8.3 h), maximum gap
12.4 min. Per pool it is irregular: on BERRY, one sweep 0.9 min after graduation,
then **9.7 minutes of nothing** while 56 swaps and ~4 ETH of volume went through.
Pons is economically aligned, since its own 30 % share travels in the same sweep.
A 30-minute epoch can still land on an empty vault; `buyBasket` copes — it buys
less, or nothing, and the next purchase covers the epochs that went by — so
nothing breaks.

**What it imposes on the keeper: nothing.** Both phases accept the fee recipient, so `FeeVault.harvest()` sweeps for itself in either one — the curve before graduation, the hook after (`ARCHITECTURE.md` §S33). There is no "two modes" runbook and no Safe transaction in the loop. An earlier version of this document said the opposite; it was reading `deployer` as the launching wallet.

Other elements of the curve (verified source):
- `buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable` and `sell(...)` → **there is a route to buy our own token before graduation**, needed for the burn (`ARCHITECTURE.md` §S11);
- `PonsV2LauncherToken` exposes **`burn` and `burnFrom`** → the burn is direct, no need to send to `0xdead`;
- the creator tax "bypasses" the protocol split: it is paid to the creator in full (`creatorAmount = creatorBucket - buybackAmount + tax`).

---

### 1.8 What the launch interface confirms (verified 2026-09-03)

Screenshot of `www.ponsfamily.com`, **v2** tab, "Launch token" form. Three points, all cross-checked on-chain — the interface alone proves nothing.

#### Supply is not a form field, and that is normal

`launchConfigCount() = 1`: there is **only one** `LaunchConfig` on the production factory. Its first value is `1e27`.

```
cast call 0x7eD598Bc… "getLaunchConfig(uint256)" 0
word 1: 0x033b2e3c9fd0803ce8000000 = 1e27   -> supply
word 4: 0x3a4965bf58a40000        = 4.2e18 -> graduationThreshold, identical
                                              to the interface's "Graduates once
                                              the curve raises 4.2 ETH"
```

Verified against an actually launched token rather than on the decoding alone:

| | |
|---|---|
| Witness token | `0x151e97bc6E6801A83A8Cd52dcBCddF76279d3B78` (symbol `13`) |
| `decimals()` | 18 |
| `totalSupply()` | **1,000,000,000,000,000,000,000,000,000** = 1 B tokens |

**Consequence for us**: `START_BALANCE = 1,000,000` tokens is exactly **0.1 % of supply**, for every v2 launch without exception. The parameter in `offchain/src/config.ts` is calibrated correctly.

The `PonsLaunchFactory.sol` file I had locally describes a `LaunchConfig` with **10 fields** (with `pairToken`, `initialTick`, `maxWalletBps`…). The deployed factory returns **7**. That file is therefore **not** the production contract — the values above come from the on-chain decoding and from `totalSupply()`, not from it.

#### The interface's "Creator wallet" really is the `creatorFeeRecipient`

The field *"Receives creator fees and the creator tax. Leave blank to use your connected wallet"* is a launch parameter, not a cosmetic setting. Proof on the same token:

```
getLaunchedToken(0x151e97bc…)
  deployer            0xE0Daf4983372F0Dd44763B0E8A953D98CF2b6559
  creatorFeeRecipient 0x25afe12F5326bFB1931C906e101365FfC2e98ebf   <- DIFFERENT
```

The two addresses differ on a real launch: the fee recipient **is** separable from the deployer from the launch transaction onwards. That is exactly what §1.3 assumes — the buffer wallet launches, `FeeVault` collects, without ever going through the 3-day transfer procedure.

#### The creator tax is ADDITIVE — the interface says the opposite

The interface displays *"Traders pay 1.00% in total, up to 10% of it yours"*, which reads as "10 % of the 1 %", i.e. 0.1 % of volume. **That is false.** The curve's code is unambiguous:

```solidity
// Curve.sol, comment on creatorTaxBps
// Kept entirely separate from feeBps: it is layered on top of the base trade
// fee, not part of the protocol/buyback/creator split, and is paid to the
// creator in full.

uint256 fee = (spent * feeBps)        / BASIS_POINTS;   // both on `spent`,
uint256 tax = (spent * creatorTaxBps) / BASIS_POINTS;   // independently
```

and further down: *"the protocol's share, and **the tax never enters the split at all**"*.

Values read on a deployed curve (`0xf68Bc5f037f92013E28D81be6f41A26c7CD76d49`):

| | Value | What it means |
|---|---|---|
| `feeBps` | 100 | 1 % of volume, the curve fee |
| `protocolFeeShareBps` | 3000 | the protocol takes 30 % of that 1 % |
| `creatorTaxBps` | 0 | chosen by that particular launcher; ours is free |
| `maxCreatorTaxBps()` (factory) | 1000 | **10 % of volume**, the cap, on top of the 1 % |
So if we launch with `creatorTaxBps = 500`:

```
creator tax        5.0 % of volume   (entirely ours)
share of the 1 %   0.7 % of volume   (70 % of the 1 %, if buyback disabled)
                  --------
total             ~5.7 % of volume
```

The trader pays 6 % in total (1 % + 5 %), not 1 %.

#### Confirmed empirically in the interface (2026-09-03)

Typing `5` into the "Creator tax" field makes the summary display:

```
Trade fee    6.00% · 5.00% yours
```

1 % + 5 % = 6 %. **Additive, confirmed on the product side.** The field's "up to 10% of it yours" wording is simply badly written.

#### But the interface announces 5.00 % where the code gives 5.7 %

It only counts the tax. The creator receives **in addition** 70 % of the curve fee, and the sweep is explicit:

```solidity
uint256 protocolAmount = (pending * protocolFeeShareBps) / BASIS_POINTS;  // 30 % of the 1 %
uint256 creatorBucket  = pending - protocolAmount;                        // 70 % of the 1 % = 0.7 % of volume
uint256 buybackAmount  = executeBuyback ? Math.min(buybackQuoteBalance, creatorBucket) : 0;
uint256 creatorAmount  = creatorBucket - buybackAmount + tax;
```

And `buybackQuoteBalance` is fed **only** if `buybackEnabled`:

```solidity
if (buybackEnabled && fee != 0) {
    uint256 creatorSlice = fee - (fee * protocolFeeShareBps) / BASIS_POINTS;
    buybackQuoteBalance += (creatorSlice * buybackBurnBps) / BASIS_POINTS;
}
```

So with `buybackEnabled = false`, `buybackAmount = 0` and:

```
creatorAmount = 0.7 % (share of the curve fee) + 5.0 % (tax) = 5.7 % of volume
```

**→ Launch with `buybackEnabled = false`.** It is a launch field (`getLaunchedToken` returns it; it was `false` on the witness token). Enabled, a `buybackBurnBps` fraction of our 0.7 % goes into a 5-year vesting instead of coming to us, and never comes back.

**The economic model holds.** At `creatorTaxBps = 400` — the value chosen — we collect **4.70 % of volume** (4.00 of tax + 0.70 as our share of the curve fee). `FeeVault` splits it 8511 / 1489 bps, along the line where the money comes from: **rewards take the 4.00 % creator tax, dev takes the 0.70 % share of the curve fee**. It has to be a ratio rather than a rule about origin — the escrow credits one number with no breakdown — so it reproduces that division only while collection really is 4.70 %. If Pons raises `protocolFeeShareBps` (§9.5), both buckets shrink proportionally instead of dev absorbing it alone.

#### The "Holder fee sharing" toggle — mechanism IDENTIFIED (2026-09-04)

The interface offers a switch *"Creator fees go to the creator wallet"*, described as: *"Route this launch's creator fees to its holders, split pro-rata for each holder to claim from their profile menu."*

**It was marked UNVERIFIED. It no longer is.**

##### How it was found

If holder sharing exists on-chain, it must go through a contract that appears as `creatorFeeRecipient`. Across 200 launches read:

| | |
|---|---|
| `deployer == creatorFeeRecipient` | 98 / 200 (field left blank) |
| Recipients **different** from the deployer | 102 |
| Among 60 tested: **contracts** | **54** |
| Distinct bytecode fingerprints | **a single one for 50 of them**, 291 bytes |

Fifty contracts identical down to the bytecode are not a coincidence: that is a cloning pattern.

##### What it is

The bytecode contains a hard-coded address and calls `implementation()` on it before delegating — a **BeaconProxy**.

```
splitter (291 B, BeaconProxy)
  -> beacon          0xa125492aCA28449d2291F5415a818697345cFa09
       owner         0x0f963968Fb82D9227c64dff7D9c4e44A7Fe66514
  -> implementation  0xf70c5B3ac4B7Cb0d9Ef26774306aaa94F3d58A8a  (9,176 bytes)
       exposes       claim() · token() · release(address)
```

##### The answer to the question that was blocking

**The toggle REPLACES the "Creator wallet" field, it does not complement it.** It deploys a splitter and registers it as the `creatorFeeRecipient`.

Switched on, `FeeVault` **would never be the recipient** and would collect nothing — the whole system would be cut off from its source, with no visible error at launch.

**→ Leave the toggle OFF.** That was already the instruction; we now know exactly what it avoids.

An additional reason not to use it: the splitter is **upgradable** through a beacon owned by Pons. Our fees would depend on a contract they can replace at any moment.

### 1.9 BERRY — recon of the post-graduation regime (verified 2026-09-03)

Token supplied as a freshly graduated witness: `0xDD405f438E561f26c729Db69547f18806AC0B33d` (`BERRY`), supply `1e27` like every v2 launch.

```
getLaunchedToken(BERRY)
  curve               0x3DA63d21A87b1F9B1f7aF954A35Fc8371CeF25fA   graduated() = true
  deployer            0x508D65714bD241610E880327Bcea5d992a31D828
  creatorFeeRecipient 0x45c6C76088cd369735065654da56201c8b9e90b7   <- again != deployer
  pairToken           0x0000…0000  = NATIVE ETH
  graduationThreshold 4.2 ETH
  creatorTaxBps       222   (2.22 %)
  buybackEnabled      false
```

#### The creator tax survives graduation — that was the open question

Two credits to the escrow, from two different sources, tracing the regime switch exactly:

| Block | Source | Amount |
|---|---|---|
| 53,630,367 | the **curve** `0x3DA63d21…` | 0.147199 ETH |
| 53,630,369 | *graduation* | |
| 53,630,899 | the **hook** `0xE5e70264…` | 0.146753 ETH |

The hook credits the `creatorFeeRecipient` after graduation. **The creator's compensation does not stop at the curve.**

#### The measured rate: ~3.06 % for a 2.22 % tax

Between graduation and the hook's credit: **78 swaps, 4.7898 ETH** of volume (the sum of |amount0|, the ETH leg), for **0.146753 ETH** credited.

```
0.146753 / 4.7898 = 3.064 % of volume,  for creatorTaxBps = 2.22 %
```

The creator therefore receives their tax **plus ~0.84 points** — consistent with the creator's share of the base fee, as on the curve. I do not claim the exact figure: without the hook's ABI I cannot cleanly separate `baseFee × (1 - protocolShare)` from the rest, and the two plausible models (2.92 % and 3.22 %) bracket the measurement. **What is solid: the measured ratio is ~1.38x the tax alone.**

Extrapolated to our `creatorTaxBps = 400`: **4.70 % of volume**, identical before and after graduation. The exact figure is established further down by the intra-transaction split.

#### The pool

`Initialize` on the PoolManager, `currency0 = 0x0` (native ETH), `currency1 = BERRY`:
| poolId | fee | tickSpacing | hook |
|---|---|---|---|
| `0x851977f5…` | **0** | 200 | **`0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044`** |
| `0x356c13a7…` | 790000 (79 %) | 200 | — |
| `0xd7ab9f8e…` | 810000 (81 %) | 19988 | — |

The Pons pool is the first one: static `fee = 0`, everything goes through the hook. **The other two are noise created by third parties** — anyone can initialise a v4 pool on our token. Worth knowing for buyback routing: target the poolId, never "the token's pool".

The hook really is Pons's: `feeEscrow()` = `0xd3AFEB2a…` and `factory()` = `0x7eD598Bc…`, both known addresses.

#### Cross-check on HASH — a 28x larger sample

`0x260dECCF21ce76B0603fe6aB287cF1b503C66D39` (`HASH`), graduated, `creatorTaxBps = 200` (2.00 %), native ETH, `buybackEnabled = false`. Here `deployer == creatorFeeRecipient` (the "Creator wallet" field left blank), where BERRY had them distinct: **both configurations exist in production**.

Full history of the credits to its `creatorFeeRecipient`:

| Source | Credits | Total |
|---|---|---|
| the curve | 6 | 0.444066 ETH |
| the hook | 9 | 2.402038 ETH |

Rate, measured between the hook's first and last sweep (**2,187 swaps, 70.02 ETH** of volume):

```
1.849925 ETH credited / 70.0240 ETH of volume = 2.642 %   for a 2.00 % tax
```

| Token | Tax | Measured rate | Gap | Swaps |
|---|---|---|---|---|
| BERRY | 2.22 % | 3.064 % | +0.84 pt | 78 |
| **HASH** | **2.00 %** | **2.642 %** | **+0.64 pt** | **2,187** |

#### Where the 1 % goes — the split, read inside the sweep transaction

Rather than fitting a curve against noisy volume, it is enough to read the **two** credits emitted in a single sweep transaction. The escrow credits the creator and the protocol side by side:

| Sweep | Creator | Protocol `0x263ed295…` |
|---|---|---|
| HASH, tx `0x3465bcf9…` | 0.126974 ETH — **90.00 %** | 0.014108 ETH — **10.00 %** |
| HASH, tx `0x0920a597…` | 0.138120 ETH — **90.00 %** | 0.015347 ETH — **10.00 %** |
| BERRY, hook, tx `0xbf3a155c…` | 0.146753 ETH — **90.68 %** | 0.015077 ETH — **9.32 %** |
| BERRY, **curve**, tx `0x6f65398f…` | 0.147199 ETH — **90.68 %** | 0.015123 ETH — **9.32 %** |

The ratio is not a constant: it is 90.00 % on HASH and 90.68 % on BERRY. It depends on the tax, and a single model reproduces it:

```
the trader pays      1 %  (base fee)  +  creatorTax
Pons takes           30 % of the base fee            = 0.30 % of volume, fixed
the creator receives 70 % of the base fee + the tax  = 0.70 % + creatorTax
```

Verification, with no fitted parameter at all:

| Token | Tax | Creator = 0.70 + tax | Protocol | Predicted share | **Measured share** |
|---|---|---|---|---|---|
| HASH | 2.00 % | 2.70 % | 0.30 % | **90.00 %** | **90.00 %** |
| BERRY | 2.22 % | 2.92 % | 0.30 % | **90.68 %** | **90.68 %** |

Exact to the second decimal on both. `protocolFeeShareBps = 3000` read on-chain, and *"the tax never enters the split at all"* from the code: **the tax is paid to the creator in full, and Pons only takes 0.30 % of volume, whatever our tax is.**

And the split is **identical before and after graduation** — 90.68 % in both regimes on BERRY. The fee structure does not change at graduation; only *who can trigger the payout* changes (§1.7).

**→ At `creatorTaxBps = 400`: 0.70 + 4.00 = 4.70 % of volume for us, 0.30 % for Pons, 5.00 % paid by the trader.** The form will display "5.00% · 4.00% yours" — it omits our share of the base fee, which is nevertheless there.

> Written as "value chosen" when this was a one-token project. The tax is now
> **per launch**: 400 is what `test/Launch.t.sol` uses and what the arithmetic
> above is worked in, and **$PAYD itself picked 300** (4.00 % paid, 3.70 %
> received). What generalises is the shape — the tax reaches the vault in full,
> Pons keeps 0.30 % of volume whatever the tax, and the curve share is the same
> before and after graduation.

4 % rather than 5 %: at a 5 % tax we would collect 5.70 % but the trader would pay 6.00 %. The round number on the trader's side is worth more than one extra point of rewards.

#### Direct proof of the 0.70 % — the zero-tax launches

The 90/10 split could be a lucky fit. The test that leaves no room for doubt: **a launch with `creatorTaxBps = 0`**. With no tax, the only thing collected is the 1 % curve fee — so the creator's share reveals the split directly, with no model.

Across 300,000 blocks, grouping credits by transaction and keeping only those with exactly two credits (creator + protocol), we get 3,046 creators. Among them:

```
166 creators receive exactly 70.000 % of the collected fee
```

| Creator | Sweeps | Creator share | Inferred tax |
|---|---|---|---|
| `0x5124626b0816…` | 27 | **70.000 %** | 0.000 % |
| `0x3bb736ca3271…` | 26 | **70.000 %** | 0.000 % |
| `0x9e61a9a21420…` | 23 | **70.000 %** | 0.000 % |
| `0xd68f8864561f…` | 20 | **70.000 %** | 0.000 % |

**With no tax, the creator receives 70 % of the 1 %, i.e. 0.70 % of volume.** That is a direct reading, not an inference.

#### And the model recovers each launch's tax

Inverting `share = (0.70 + tax) / (1 + tax)`, the ratio alone should let us recover the `creatorTaxBps` of any launch. Against the two values we read on-chain:

| Token | Measured share | Inferred tax | On-chain tax | Gap |
|---|---|---|---|---|
| HASH | 89.995 % | 1.999 % | 2.00 % | **0.0015 pt** |
| BERRY | 90.683 % | 2.220 % | 2.22 % | **0.0000 pt** |

And across all creators, the inferred taxes land on round values — 1.000 %, 2.000 %, 5.000 % — that is, what humans type into a form. A wrong model would not produce that.

**Conclusion: the 0.70 % is established, and it adds to our tax whatever its value.**

> Method note: the "measured / volume" rate gave 2.642 % where the model predicts 2.70 %, i.e. 97.9 %. The gap comes from the denominator — I sum the swaps' `|amount0|`, which does not exactly match the fee base on exact-output swaps. **The intra-transaction ratio, by contrast, depends on no denominator: that is what is authoritative.** I first concluded "tax + 0.65 points" by fitting against volume; that was a measurement artefact, the right value is **+0.70 points**.

#### Sweep cadence — the real operational figure

On HASH, 9 hook sweeps covering 50 min of activity:

```
median 2.3 min   p90 21.0 min   max 21.0 min
```

And the gaps **lengthen as the pool cools**: 2 to 5 min during the peak, then 21 min and 19.5 min on the last two.

Overall view across 300,000 blocks (~8.3 h), 2,378 hook sweeps to 248 distinct recipients:

| Recipient | Sweeps | Median | p90 | Max |
|---|---|---|---|---|
| `0x263ed295…` (**Pons itself**) | 961 | 0.1 min | 0.6 min | 12.4 min |
| `0xfdde5a1e…` | 228 | 0.7 min | 2.5 min | 14.1 min |
| `0x21541c4f…` | 89 | 1.4 min | 3.8 min | 16.1 min |
| `0x78e68ece…` | 47 | 2.3 min | 14.9 min | 23.9 min |
| `0x0335154…` | 35 | 3.8 min | 19.6 min | **34.6 min** |

Pons sweeps **its own share** every 6 seconds at the median; creators wait from 0.7 to 4.6 min at the median, and up to **34.6 min** in the worst case observed.

**What that means for our 30-minute epochs.** The common case is several sweeps per epoch. The rare case is an epoch landing on an empty vault because the last sweep is more than 30 min old. `buyBasket` copes — it buys less, or nothing, and the next purchase catches up since the reserve is smoothed at 4 % (§S15). **Nothing breaks, but the rhythm of the purchases is not entirely ours.** To be accepted explicitly.

#### What corrected §1.7

The hook's sweep to the escrow accepts the `feeSweepOperator` **or the
`creatorFeeRecipient`** — so `FeeVault` can sweep itself whenever no
memecoin-denominated fees are pending. Source, on-chain reads and measured
cadence: see §1.7, rewritten twice.

## 2. The Stock Tokens

### 2.1 Architecture (src + cast, 2026-09-02)

- **97 stock tokens** listed on-chain (name suffixed `• Robinhood Token`), enumerated through Blockscout's tokens API over 400 ERC-20s.
- Each one is a **`BeaconProxy`** — verified with `cast storage <token> 0xa3f0…3d50` (EIP-1967 beacon slot).
- **Beacon shared by all of them**: `0xe10b6f6B275de231345c20D14Ab812db62151b00` (identical for NVDA, SPY, AAPL, TSLA — `cast`).
- **Implementation**: `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`, contract `Stock`, verified src, solc 0.8.33.
- **Access registry**: `ACCESS_CONTROLLED_REGISTRY() = 0xe10b6f6B275de231345c20D14Ab812db62151b00` (the same address as the beacon).

**All 97 tokens are upgradable in one move through that beacon.** Our system depends on them entirely. To be written into the risks.
### 2.2 Can a stock token be held in a contract? — **YES**

`Stock.transfer` (`src`):
```solidity
function transfer(address to, uint256 value) public override
    onlyNotPaused onlyNotBlocked(to) onlyNotBlocked(_msgSender()) returns (bool)
```
`onlyNotBlocked` queries `IAccessControlsRegistry.isBlocked(account)` — it is a **blocklist**, not an allowlist. No account-type check, no on-chain KYC, no `code.length` test.

Verifications:
- `cast call registry "isBlocked(address)" 0xbC3219…` → `false` (an arbitrary contract, not blocklisted)
- `cast call registry "paused()"` → `false`
- `cast call NVDA "tokenPaused()"` → `false`
- **Empirical proof**: NVDA top holders = `PoolManager` (20,920), `SafeProxy` (4,694), `UniswapV3Pool` (4,557), `TimelockController` (966). Contracts already hold these tokens in production.

### 2.3 Admin roles on the stock tokens (`src`, `Roles.sol`)

`MINTER_ROLE`, `BURNER_ROLE`, **`ADMIN_BURNER_ROLE`** (`adminBurn(from, amount)` — burns from anyone, **without even the `onlyNotPaused` check**), `BLOCKER_ROLE`, `TOKEN_PAUSER_ROLE`, `MULTIPLIER_UPDATER_ROLE`, `BEACON_UPGRADER_ROLE`.

Consequence for us: Robinhood can unilaterally **pause** a stock (our swaps and pushes would revert), **blocklist** `FeeVault`/`Distributor`, or **burn** our holdings. That is an irreducible counterparty risk, not a bug. The per-stock try/catch from `docs/CONVENTIONS.md` covers it partially (a paused stock does not block the other 9) — provided the `Distributor` also skips reverting transfers, which is already the case.

### 2.4 `uiMultiplier` — splits and corporate actions

`ERC20ScaledUIUpgradeable` (`src`):
```
balanceOfUI(a)  = balanceOf(a) * uiMultiplier() / 1e18
totalSupplyUI() = totalSupply() * uiMultiplier() / 1e18
```
`updateMultiplier(newMultiplier[, effectiveAt])` (role `MULTIPLIER_UPDATER_ROLE`) is used for **splits / reverse splits**.

- `balanceOf` (raw) **is not modified** by a multiplier change → our snapshots, our accounting and our transfers in raw units stay correct.
- But the **economic value of a raw unit changes**. Two implications:
  1. the front end must display `balanceOfUI`, never `balanceOf`;
  2. any `minOut` derived from a Chainlink USD feed must be converted with the **current multiplier**, otherwise a split will blow up or collapse the `minOut`.
- `cast call NVDA "uiMultiplier()"` → `1e18` today (no split in progress).

---

## 3. Uniswap on Robinhood Chain

Many third-party clones carry the same names. The addresses below are **the ones that actually hold the liquidity** or that are referenced by the Pons contracts — every line is cross-verified.

### 3.1 Uniswap v3 — **the production route**

| Contract | Address | How verified |
|---|---|---|
| `UniswapV3Factory` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | **Pons docs "V3 factory"** + `getDexConfig(0)` + `SwapRouter02.factory()` |
| `SwapRouter02` | `0xCaf681a66D020601342297493863E78C959E5cb2` | **Pons docs "Swap router"**; `factory()` and `WETH9()` cross-checked |
| `NonfungiblePositionManager` | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | **Pons docs "Position manager"**; `UNI-V3-POS` NFT verified |
| `QuoterV2` | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | **Pons docs "Quoter V2"**; `factory()` == canonical factory (quotes §4.2) |
| `WETH9` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | **Pons docs "WETH (quote token)"**; `SwapRouter02.WETH9()`; = `LaunchConfig[0].pairToken` |
| `USDG` (Global Dollar, **6 decimals**) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | explorer + `cast decimals()` |
| `Multicall3` | `0xcA11bde05977b3631167028862bE2a173976CA11` | `cast code` non-empty (canonical address) |
| `Permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | canonical address, verified |

### 3.2 Uniswap v4 — available, not chosen

| Contract | Address | How verified |
|---|---|---|
| `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 1st holder of NVDA and SPY; `PositionManager.poolManager()` points at it |
| `PositionManager` v4 | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | `UNI-V4-POSM` NFT verified |
| `StateView` | `0x0284Cb0bcbaa8B87A8AA409D0e41afA7a76355F2` | the only `StateView` whose `poolManager()` == canonical |
| `UniversalRouter` | `0x40d6bdac60c0810fC3ed30a988A4c3ac890fdd43` | the only one whose `poolManager()` == canonical |
| `V4Quoter` | `0x987E643e0d2B5a2b56ab52a0c0036C508D3451fa` | `poolManager()` == canonical (4 other clones also match) |

**Other DEXes present**: `RamsesV3Pool` holds SPY (top holders) → a Ramses fork exists. Not explored — **out of scope, §10.2**: we route through the Uniswap v3 pools measured here.

---

## 4. Liquidity, routes and measured slippage

### 4.1 Where the liquidity is — a counter-intuitive result

Scan of 24 stock tokens × {WETH, USDG} × {100, 500, 3000, 10000} bps = 192 pairs queried through `UniswapV3Factory.getPool`, then `liquidity()` + the pool's `balanceOf` (`cast` / JSON-RPC).

- **60 v3 pools with non-zero liquidity.**
- **The depth is against USDG, not against WETH.** Best WETH pools: SPY 330 WETH, MSTR 120 WETH, NVDA 105 WETH — not enough. Best USDG pools: NVDA **4,785,060 USDG**, RDDT 854,266, GLD 802,647, SPCX 633,970.
- First hop **WETH → USDG**: pool **fee 100 (0.01 %)** `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`, **3,904 WETH / 6,006,840 USDG**. Very deep, negligible cost.

**→ Route confirmed: `ETH → WETH →(0.01 %)→ USDG →(best pool's fee)→ stock`, exactly the "if the only route goes through USDG" case anticipated in `PLAN.md`.**

### 4.2 Slippage measured for **0.5 ETH** (`QuoterV2.quoteExactInput`, 2026-09-02)

Method: `out(0.5 ETH)` compared against an extrapolated `out(0.001 ETH)`. This isolates **price impact**; the pool fees cancel between the two quotes.

| Stock | USDG pool (fee) | USDG TVL | Output for 0.5 ETH | Price impact | Chainlink feed |
|---|---|---|---|---|---|
| SGOV | 3000 | 213,412 | 11.7454 | **0.002 %** | yes, `Robinhood SGOV-USD` (17 h stale) |
| NVDA | 500 | 4,785,060 | 5.2750 | **0.002 %** | yes, `RHNVDA / USD` |
| SPCX | 500 | 633,970 | 8.4220 | **0.002 %** | yes, `Robinhood SPCX / USD` |
| AAPL | 500 | 192,951 | 3.6427 | **0.003 %** | yes, `Robinhood AAPL / USD` |
| GLD | 3000 | 802,647 | 2.9449 | 0.003 % | **no feed** |
| QQQ | 500 | 552,675 | 1.6731 | **0.005 %** | yes, `Robinhood QQQ / USD` |
| RDDT | 10000 | 854,266 | 7.6104 | 0.005 % | **no feed** |
| HIMS | 3000 | 545,291 | 40.6859 | 0.007 % | **no feed** |
| SPY | 500 | 45,031 | 1.5516 | **0.010 %** | yes, `RHSPY / USD` |
| AMZN | 3000 | 152,308 | 4.6417 | **0.012 %** | yes, `Robinhood AMZN / USD` |
| GOOGL | 500 | 92,338 | 3.5103 | **0.019 %** | yes, `Robinhood GOOGL / USD` |
| TSLA | 3000 | 178,571 | 3.3464 | **0.022 %** | yes, `RHTSLA / USD` |
| USO | 3000 | 295,367 | 8.3615 | 0.024 % | yes, `RHUSO / USD` |
| GME | 500 | 215,789 | 63.1139 | 0.024 % | yes, `Robinhood GME / USD` |
| SLV | 3000 | 65,179 | 20.1703 | 0.034 % | yes, `Robinhood SLV / USD` |
| TSM | 10000 | 42,748 | 2.8541 | 0.034 % | yes, `Robinhood TSM / USD` |
| MSFT | 3000 | 47,867 | 2.3871 | **0.048 %** | yes, `RHMSFT / USD` |
| CRCL | 3000 | 205,048 | 13.5036 | 0.062 % | yes, `Robinhood CRCL / USD` |
| PLTR | 3000 | 24,038 | 7.0390 | 0.068 % | yes, `Robinhood PLTR / USD` |
| MSTR | 10000 | 57,111 | 9.6040 | 0.087 % | yes, `Robinhood MSTR / USD` |
| AMD | 3000 | 10,337 | 2.5799 | 0.206 % | yes, `RHAMD / USD` |
| INTC | 3000 | 14,900 | 13.1074 | 0.280 % | yes, `RHINTC / USD` |
| META | 3000 | 24,443 | 1.9844 | 0.364 % | yes, `Robinhood META / USD` |

At the size of one cycle (0.5 ETH ≈ $1,193 at ETH = $2,385.81), **price impact is not the limiting factor**. The dominant cost is the **pool fee**: 0.01 % on WETH→USDG + 0.05 % to 1 % on USDG→stock.

### 4.3 Uniswap v4 — verified permissionless, but worse

Decoding of **405,124** `Initialize` events from the `PoolManager` (`eth_getLogs` in 2 M-block slices — full-range queries fail). Among them, **1,761 pools** pair one of our stocks with {native ETH, WETH, USDG}: **992 with hooks, 769 hookless**.

**110 stock/quote pools have liquidity, and every one at the top of the ranking has `hooks = 0x0000…0000`** → **no hook allowlist on the useful route**. The deepest are **native ETH / stock** pairs: ETH/NVDA (fee 50000), ETH/SPCX (10000), ETH/TSLA (50000), ETH/GOOGL (10000), ETH/AAPL (50000), ETH/SPY.

Direct comparative quote (`V4Quoter.quoteExactInputSingle`, 0.5 ETH → NVDA, 5 % pool fee):

| Route | NVDA output for 0.5 ETH |
|---|---|
| v4 direct ETH→NVDA (fee 50000) | 5.1845 |
| **v3 ETH→USDG→NVDA** | **5.2750** |

**v3 wins by ~1.7 %**: the deep v4 tiers are at 1 % or 5 %, against 0.01 % + 0.05 % on v3. → **We implement v3 through `SwapRouter02`.** v4 stays a documented fallback; do not code it in Phase 1.

### 4.4 Full cycle path

> Corrected after the identification of Pons v2. This section was written against the v1 locker, which paid in WETH through `collectFees`. In v2 the fees arrive as **native ETH** through `V2FeeEscrow.claim()` — see §1.2, which is authoritative.

```
FeeVault.harvest()
  1. escrow.claim()                      -> native ETH arrives in FeeVault
  2. for the epoch's Allocation[i]:
       ETH -> WETH --(v3, fee 100)--> USDG --(v3, best pool's fee)--> stock[i]
       minOut derived from the Chainlink feed, tightened by the 30-min TWAP
  3. our own token: buy-and-burn, see ARCHITECTURE.md §S11
```

Fee cost per swap: **0.01 % (WETH→USDG) + 0.05 % to 1 % (USDG→stock)**, plus the price impact from §4.2 (0.002 %–0.09 %). The first hop is almost free thanks to the WETH/USDG fee-100 pool (`0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`, 3,904 WETH / 6,006,840 USDG).

**The `$PONS → WETH` route, now unnecessary** — kept only for the case where we would launch on the third-party `pons-factory.fun` (§1.1), which pays its fees in $PONS:

| Pool | Address | Reserves |
|---|---|---|
| PONS/WETH fee 10000 | `0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA` | 6,491,916 PONS / 1,005.07 WETH |
| PONS/WETH fee 3000 | `0xEd50bDeeA8aDC232f159486192a4157281D722ff` | 2,638,971 PONS / 362.89 WETH |
| PONS/USDG fee 10000 | `0x7A192E71564ec66eE0763e328a3Ac274942dE4e1` | 707,543 PONS / 210,200.60 USDG |
Liquid (~$2.4 M on the 1 % pool), but the hop would cost **1 % in fees** on top. One more argument for staying on Pons v2.

### 4.5 The two detour currencies — COIN and cbBTC, four tiers each (`cast`, 2026-09-11)

> **Why this section exists at all.** `script/Quotelist.s.sol` lists COIN and cbBTC
> as quote currencies on the strength of two depth figures — $33 144 and $158 774 —
> that appeared only in that file's own comments, in `ARCHITECTURE.md` §S40 and in
> `PAYD_RUNBOOK.md`. **Neither token's address was in this file.** These two are on
> the money path: they are the whole reason `QUOTE → WETH → PIVOT` exists (§S40), and
> between them they carry 198 of the ~220 weekly credits of the otherwise-unreachable
> set. A money-path address whose measurement is not here breaks the rule at the top
> of `CLAUDE.md`, and it broke quietly — the figure rotted and nothing re-read it.

**Block 60 339 761 – 60 340 232. ETH/USD = $2 597.16** (`0x78F3556b…d3A9`,
`latestRoundData`). Route measured is `token/WETH`, which is what both rows declare;
the second hop `WETH → USDG` (tier 100) is the pool of §4.1 and is not re-measured
here.

| Token | Address | Decimals |
|---|---|---|
| `COIN` | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | 18 |
| `cbBTC` | `0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4` | 8 |

All four v3 tiers queried per token through `UniswapV3Factory.getPool`, then
`liquidity()`, `slot0()` and both `balanceOf`s. Depth = USD absorbable before a 1 %
price move, computed on the **active** liquidity at the current tick — the formula of
`docs/allowlist.md` "Replaying the measurement", identical to the one
`test/PaydDeploy.t.sol::_depthUsd` applies.

| Token | tier | pool | active `liquidity()` | depth +1 % | verdict |
|---|---:|---|---:|---:|---|
| COIN | 100 | — | — | — | **no pool** |
| COIN | 500 | `0xad8C7ab119A9cA04480CB117A9d87C7E2d637D22` | **0** | $0 | exists, empty (14 wei WETH / 17 wei COIN) |
| **COIN** | **3000** | `0x6707aeAc7D0e519B083219d27BB427364363183A` | 6.3008e21 | **$21 513** | **the declared route, and the only live one** |
| COIN | 10000 | `0xe12eF9f26cfc947aa48BAe4625103DD914183599` | **0** | $0 | exists, empty (3 wei / 2 wei) |
| cbBTC | 100 | — | — | — | **no pool** |
| cbBTC | 500 | — | — | — | **no pool** |
| **cbBTC** | **3000** | `0xD30e44aaE604B42a63f6F9A8109FD0408F35b9fb` | 6.9221e14 | **$4 927** | **the declared route, and the only live one — under the $5 000 bar** |
| cbBTC | 10000 | `0x55cf5b80e373Cd00BcfFDe27Bf50e9832777491f` | **0** | $0 | exists, empty (6 wei / 6 wei) |

Reserves of the two live pools, same block:

| Pool | WETH | token |
|---|---:|---:|
| COIN/WETH 3000 | 33.4621 | 2 120.8652 COIN |
| cbBTC/WETH 3000 | 37.8318 | 11.1517 cbBTC |

**Three readings, and the third is the one that matters.**

1. **The declared tier is the right tier for both.** `Quotelist.s.sol` names 3000 on
   each, and 3000 is the only tier carrying anything. There is nowhere to repoint:
   "change the tier" is not a remedy available here, unlike the ten quotes of
   `FLOWS.md` §10 (2026-09-10 b) that a second hop rescued.
2. **COIN is fine and is down.** $21 513 against the $33 144 on record — roughly
   −35 % — but comfortably over the $5 000 bar of
   `test_EveryQuoteRouteCarriesEnoughDepth`. No decision needed; the row is sound.
3. **cbBTC is under the bar, and the pool has not been drained.** $4 927 against
   $158 774 on record. Read twice during the same session it gave **$4 166 then
   $4 927** — it moves, and it moves around the threshold. Meanwhile the pool still
   holds 37.83 WETH and 11.15 cbBTC. What fell is the **active liquidity at the
   current tick**, not the deposits: a concentrated range the price has walked out
   of. `docs/allowlist.md` rule 3 names exactly this fragility. So the condition can
   reverse on its own, and treating it as permanent would be wrong — but a swap fills
   against the active range, so a cbBTC-quoted vault would be badly filled **today**.

**What follows for the deployment.** `QUOTE` is stamped at a vault's birth and
`removeQuotes` reaches no existing vault, so creating a cbBTC vault is irreversible
while not creating one is not. The asymmetry decides it, not the number: hold the
cbBTC row out of `Quotelist.s.sol` until this measurement is replayed above $5 000.
Keep COIN.

**One more thing this measurement turned up, and it is not about depth.**
Observation cardinality, from `slot0()`:

| Pool | `observationCardinality` | 30-min window guaranteed? |
|---|---:|---|
| COIN/WETH 3000 | 1 500 | **no** — ~25 min at one observation per second |
| cbBTC/WETH 3000 | 1 350 | **no** — ~22.5 min |

Both sit below the **1 801** that §5.1 sets as the floor for a 30-minute TWAP under
continuous trading. They answer the window today because trading is sparse, which is
why `test_EveryQuoteRouteHasALiveThirtyMinuteTwap` passes — the same trap §S3 records
("a pool fails the window only while EVERY observation it holds is inside it, so a
quiet pool answers from its last write"). The consequence is heavier here than on a
basket leg: `FeeVault._toPivot` calls `TwapFloor.meanTick`, **not** `tryMeanTick`, so
a quote pool that stops serving the window takes the **whole purchase** down rather
than one leg. `increaseObservationCardinalityNext` is permissionless and costs ~$9
and ~$10 respectively at the rates of §S3; doing it before listing either currency is
the cheap half of this section.

**Replaying it.** Per token, per tier — nothing here needs an archive node:

```bash
# 1. the pool
cast call 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA \
  "getPool(address,address,uint24)(address)" $TOKEN $WETH $FEE --rpc-url $RPC_URL
# 2. what it carries, and where its price sits
cast call $POOL "liquidity()(uint128)"                      --rpc-url $RPC_URL
cast call $POOL "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url $RPC_URL
cast call $WETH "balanceOf(address)(uint256)" $POOL         --rpc-url $RPC_URL
# 3. depth at +1 %, WETH being token0 in all four pools above:
#      dX = L / sqrtPriceX96 * 2**96 * (sqrt(1.01) - 1)     (sqrt(1.01)-1 = 0.004987562)
#    then x ETH/USD. Same formula as docs/allowlist.md and as _depthUsd.
```

`test/PaydDeploy.t.sol::test_EveryQuoteRouteCarriesEnoughDepth` runs this over the
whole quote list and names the culprit rather than stopping at the first one. It is
the thing to watch, and on 2026-09-11 it is **red on cbBTC**.

### 4.5bis The same two currencies against the PIVOT — and the pinned re-read (`cast`, 2026-09-11, block 60 310 000)

> **Why a second section rather than an edit to §4.5.** §4.5 measured `token/WETH`,
> which is the route both rows declare, and said so. It measured nothing against the
> **pivot**, and two things turn on the pivot side: `Payd._allowQuotes` takes
> `_requirePool(quote, PIVOT, poolFee)` on a row declaring a direct route, and
> `AUDIT_PLAN.md` §2.4bis states that cbBTC has "no pivot pool at all". That second
> claim is wrong, and what replaces it is worse than a missing pool.

**Block 60 310 000 (timestamp 1 789 135 116). ETH/USD = $2 599.75.** This is the
block the audit's test run is pinned to (`foundry.toml`, `[profile.ci]`), so every
figure below can be replayed exactly.

| Token | tier | pool | active `liquidity()` | depth +1 % | verdict |
|---|---:|---|---:|---:|---|
| COIN | 100 | `0x1AA941420f6347cf004E2D21E40F0632D8862cf8` | **0** | $0 | exists, empty (15 wei USDG) |
| COIN | 500 | `0x3a6eC0aa6C702323414d449B5F60f4B742A82dED` | **0** | $0 | exists, empty (4 wei / 4 wei) |
| COIN | 3000 | `0x5C51A0035051fa2DB80AEc8781Be3bD6207d27E0` | **0** | $0 | exists, empty (776 wei / 23 wei) |
| COIN | 10000 | — | — | — | **no pool** |
| cbBTC | 100 | — | — | — | **no pool** |
| cbBTC | 500 | `0x9664D869540E9D0a76f12C6623946C6D5d201e09` | **0** | $0 | exists, empty |
| **cbBTC** | **3000** | `0x2BDA432a0bCCbFB38522824986772eDc3A569c35` | **12 397 403** | **$1** | **alive, and worth one dollar** |
| cbBTC | 10000 | `0x9628C6b2F612F5C8eF45Fe9973196002Aa1a2767` | **0** | $0 | exists, empty (1 wei / 1 wei) |

Reserves of the one live pivot pool: **0.002 264 87 cbBTC + 179.44 USDG**.

**The row that matters is cbBTC/USDG at tier 3000.** It is not "no pool": it is a
pool that exists, carries non-zero `liquidity()`, and absorbs one dollar before
moving 1 %. `Payd._requirePool` (`contracts/Payd.sol:907-912`) admits any pool on
`liquidity() != 0` and its own comment says it does not catch a thin tier — so a
timelock that copied `3000` out of the token's WETH row into the **pivot** column
would be waved straight through, and the vaults born from that row are stamped with
it for life (`removeQuotes` reaches no existing vault). That is `T-QUOTE-01`, and
this row is the fixture it uses: a real tier, thin today, with no drift needed to
make the point.

**The WETH side re-read at the same block**, so the two sections can be compared:

| Route | active `liquidity()` | depth +1 % |
|---|---:|---:|
| COIN/WETH 3000 | 4.6762e21 | **$15 979** |
| cbBTC/WETH 3000 | 3.5016e14 | **$2 496** |
| WETH/USDG 100 — the shared second hop | 3.4666e18 | **$878 787** |

The second hop is three orders of magnitude deeper than either first hop, so the
`min()` that `test_EveryQuoteRouteCarriesEnoughDepth` takes over a detour is always
the first hop. Nothing about the detour design is in question here.

**And the number nobody should quote as a constant again.** The same metric on
`cbBTC/WETH 3000`, in the order it was read:

| when | depth +1 % |
|---|---:|
| 2026-09-08, `Quotelist.s.sol:237`'s comment | $158 774 |
| 2026-09-11, §4.5, first read | $4 166 |
| 2026-09-11, §4.5, second read minutes later | $4 927 |
| 2026-09-11, block 60 310 000 (pinned) | **$2 496** |
| 2026-09-11, `latest`, during the audit run | $9 546 |
| 2026-09-11, `latest`, minutes later | $11 302 |

Six readings, a 4.5x spread inside one hour, the pool's deposits unchanged
throughout (37.83 WETH / 11.15 cbBTC in §4.5; 35.91 / 11.25 at the pinned block).
**The `$4 166` was not a bad RPC answer** — it is the same volatile quantity as the
other five. Active liquidity at the current tick is not a property you record once:
`docs/allowlist.md` rule 3 says so, and this table is what that sentence looks like
when it is measured. It is also the reason
`test_EveryQuoteRouteCarriesEnoughDepth` belongs on the scheduled `latest` job and
not on the pinned one — see `.github/workflows/ci.yml`, job `live-measurements`.

**Replaying it.** Identical to §4.5's block, with `$USDG` in place of `$WETH` and
`--block 60310000` on every call. USDG is `token0` in all four pivot pools above, so
the depth formula takes its first branch: `dX = L / sqrtPriceX96 * 2**96 * 0.004987562`,
then `/ 1e6` because USDG carries six decimals and one unit is one dollar.

---

## 5. Chainlink oracles

113 aggregator proxies enumerated from the explorer, then `description()` + `latestRoundData()` through `cast` on each one (2026-09-02).

**Useful feeds** (8 decimals, two addresses per feed — proxy + alias, identical values):

| Feed | Address (proxy) | Measured freshness |
|---|---|---|
| `ETH / USD` | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` | 0.4 h |
| `USDG / USD` | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` | 1.8 h |
| `RHNVDA / USD` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | 0.2 h |
| `Robinhood SPCX / USD` | `0x42a95341ff361e81fd934F39943c5C98F6991844` | 1.3 h |
| `Robinhood AAPL / USD` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | 0.4 h |
| `Robinhood QQQ / USD` | `0x41ed2c58611790af0760e31e80Bb427e4e83D603` | 3.0 h |
| `RHSPY / USD` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | 3.3 h |
| `Robinhood AMZN / USD` | `0x9244830430bC7D9C9A48dd47603F24AD61f7c56e` | 3.5 h |
| `Robinhood GOOGL / USD` | `0xF6f373a037c30F0e5010d854385cA89185AE638b` | 1.9 h |
| `RHTSLA / USD` | `0x4A1166a659A55625345e9515b32adECea5547C38` | 1.5 h |
| `RHMSFT / USD` | `0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E` | 1.6 h |
| `Robinhood GME / USD` | `0x27C71df6A64fB476468EdF256CF72c038baB5B67` | 3.0 h |
| `RHUSO / USD` | `0x6D054DECb74Cf8ef3675B0Abc100e02921176EdF` | 2.1 h |
| `Robinhood SLV / USD` | `0x209b73908e92Ae021826eD79609845451Ecba2ce` | 0.5 h |
| `Robinhood TSM / USD` | `0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F` | 0.2 h |
| `Robinhood CRCL / USD` | `0x025Ba3B3569Ca7d15Da7BFC1648F13F06A072851` | 0.2 h |
| `Robinhood PLTR / USD` | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | 0.7 h |
| `Robinhood MSTR / USD` | `0x2521a77F42098357e83bDea7fBb2A38745bf9280` | 0.6 h |
| `Robinhood META / USD` | `0x5cBC53D382E56cBb223f118CF8Eefb6c9c2759f5` | 2.2 h |
| `RHINTC / USD` | `0x3f390C5C24628Ac7C489515402235FeAD71D1913` | 1.2 h |
| `RHAMD / USD` | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | 0.7 h |
| `Robinhood SGOV-USD` | `0xa7a18Ca3F19E17FfA28F92302B817Ca8c1A94b06` | **17.3 h** |
| `Robinhood COIN / USD` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` | 0.5 h |
| `Robinhood ORCL / USD` | `0x2a07f8d87d369Bd8Bc36472337ae02d512a7b5e5` | 0.7 h |
| `Robinhood CRWV / USD` | `0x288b837A17fED1aa00c1df832ef79D0C77336c10` | 0.6 h |

Also available: `Robinhood` ASML, BABA, CLSK, EWY, IONQ, NBIS, RGTI, RKLB, USAR, DELL, `RHSNDK`, `RHMU`, plus BTC/USD, WBTC, CBBTC, LBTC, WEETH, WSTETH, LINK, ENA, EURC, USDC, USDT, USDE, USDS.

**Without a feed** (verified: absent from the list of 113): **GLD, RDDT, HIMS** — three of the deepest pools. Either exclude them from the selection or accept a 30-minute v3 TWAP instead. The `docs/CONVENTIONS.md` rule ("never `minOut = 0`") forces a decision.

> **This sentence is a 2026-09-03 reading of the CANDIDATES, and the shipped list is nine times longer. → §5.2.** `script/Allowlist.s.sol` deploys **27** lines with `feed = 0`, not three; the decision the paragraph above "forces" was taken in favour of the TWAP and then taken 24 more times without this section following. §5.2 records all 27 by address, dated, and `test/Deploy.t.sol::test_EveryFeedlessListedStockIsRecordedInRecon` fails the suite if one of them leaves. Neither list is edited here: this is a dated photograph of the candidate set, and §5.2 is the dated photograph of what ships.

**Watch out for staleness**: equity markets close. The measured ages run from 0.2 h to 3.5 h during trading hours, and 17.3 h for SGOV. A `require(updatedAt > block.timestamp - 1 hours)` **would block every harvest over the weekend**. What is needed is a tolerance on the order of 72 h plus an independent safety bound (for instance also requiring that the pool price not deviate by more than X % from the feed's last price). **To be decided (§9).**

---

### 5.1 Uniswap v3 observation cardinality (for the TWAP) — 2026-09-03

Measured through `slot0().observationCardinality` on the selected USDG pools. Needed because `ARCHITECTURE.md` §S3 makes the 30-minute TWAP the primary oracle (equity feeds go stale over the weekend).

| Pool | Cardinality | 30 min guaranteed? |
|---|---|---|
| NVDA/USDG | 6000 | yes |
| SPCX/USDG | 3100 | yes |
| WETH/USDG | 2500 | yes |
| AAPL, SPY, AMZN, GOOGL, TSLA, MSFT, RDDT | 1801 | yes (exactly at the limit) |
| GME | 1500 | 25 min |
| GLD | 1400 | 23 min |
| **QQQ** | **300** | no, ~5 min |
| **HIMS** | **200** | no, ~3.3 min |

Uniswap v3 writes at most one observation per second, so cardinality is a floor in seconds of continuous trading. Fix and costs: `ARCHITECTURE.md` §S3.

### 5.2 The allowlist ships 27 lines with no feed, and §5 above names three (2026-09-11)

> **This section exists because two files disagreed and only one of them was
> re-measured.** §5 and §8 below both say the same thing — *"Without a feed
> (verified: absent from the list of 113): **GLD, RDDT, HIMS**"* — and that sentence
> was true of the ten-name proposal of §8. `script/Allowlist.s.sol` ships **46**
> lines and **27** of them carry `feed = 0x0000…0000`. Neither list is edited here:
> §5's enumeration of the 113 aggregators is a correct measurement of what Chainlink
> serves, and the allowlist is a correct list of what a basket may hold. What was
> missing is the row saying that the intersection is nine times bigger than §5's
> sentence suggests, and that it is now a **majority** of the allowlist.

**What "no feed" means on the money path.** `FeeVault._oracleOut`
(`contracts/FeeVault.sol:1375`) returns 0 on its first line when
`a.feed == address(0)`, so the Chainlink tightener `docs/ARCHITECTURE.md` §S3
describes does not run on these lines at all. Their floor is
`TwapFloor.meanTick(pool, 1800)` reduced by `MAX_SLIPPAGE_BPS = 300`, and nothing
else. That is a per-stock decision the allowlist is entitled to make; what it must
not be is a decision nobody is aware of having made 27 times.

| # | symbol | address | v3 tier vs USDG |
|---:|---|---|---:|
| 1 | `GLD` | `0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e` | 3000 |
| 2 | `HIMS` | `0xCceE82fE024c36fA15E1005edE3E9e4787e23D09` | 3000 |
| 3 | `DJT` | `0x1D11f0496982706C5e14A514D4E79F2e6BdE4516` | 10000 |
| 4 | `MU` | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | 3000 |
| 5 | `AMC` | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` | 3000 |
| 6 | `RDDT` | `0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C` | 10000 |
| 7 | `LULU` | `0x4e62068525Ab11FE768e29dfD00ef909B9803016` | 3000 |
| 8 | `TTWO` | `0x5e81213613b6B86EaB4c6c50d718d34359459786` | 3000 |
| 9 | `IBM` | `0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619` | 3000 |
| 10 | `COST` | `0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2` | 3000 |
| 11 | `LLY` | `0x8005d266423c7ea827372c9c864491e5786600ea` | 500 |
| 12 | `BABA` | `0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4` | 3000 |
| 13 | `RBLX` | `0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8` | 3000 |
| 14 | `DELL` | `0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd` | 10000 |
| 15 | `NFLX` | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | 3000 |
| 16 | `FIG` | `0x41F4267525a8AFf329540eF24fD83d9044758B33` | 3000 |
| 17 | `JNJ` | `0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80` | 3000 |
| 18 | `RIVN` | `0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B` | 10000 |
| 19 | `SNAP` | `0xF6589F11Bc40b669e584073F428B05562F568733` | 3000 |
| 20 | `WYFI` | `0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E` | 3000 |
| 21 | `UPS` | `0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2` | 3000 |
| 22 | `USAR` | `0xd917B029C761D264c6A312BBbcDA868658eF86a6` | 3000 |
| 23 | `F` | `0x25C288E6D899b9BC30160965aD9644c67e73bE0C` | 10000 |
| 24 | `BE` | `0x822CC93fFD030293E9842c30BBD678F530701867` | 3000 |
| 25 | `SKHY` | `0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8` | 3000 |
| 26 | `MRVL` | `0x62fd0668e10D8B72339BE2DCF7643001688ff13B` | 3000 |
| 27 | `PONS` | `0x39dBED3a2bd333467115dE45665cC57F813C4571` | 10000 |

**Checked live at block 60 310 000, all 27.** Pool present at the declared tier,
`liquidity() != 0`, and `observe([1800, 0])` answers — i.e. the sole remaining price
source is a live one. Run by
`test/Deploy.t.sol::test_TwentySevenListedStocksArePricedByTheTwapAlone`, which also
pins the count so a silent drift fails the suite, and by
`::test_EveryFeedlessListedStockIsRecordedInRecon`, which fails if any address above
leaves this file.

**Replaying it.** The list is generated from the source rather than transcribed:

```bash
grep -oE '\(0x[0-9a-fA-F]{40}, *[0-9]+, *0x0{40}\); *// *[A-Z$]+' script/Allowlist.s.sol
```

---

## 6. Gas cost — the point that called the pushed airdrop into question

### Measurements (2026-09-02)

- `cast gas-price` → **0.4177 gwei**; base fee 0.4163 gwei. **Gas is not free.**
- ETH/USD (Chainlink feed) = **$2,385.81**.
- Block gas limit: `1,125,899,906,842,624` (no block constraint, Orbit behaviour).
- `cast estimate` of an isolated `Stock.transfer`: **61,177 gas** (vs 41,756 for WETH — the overhead of the BeaconProxy + 2 staticcalls to the registry + the second `TransferWithScaledUI` event).
- Real batch reference: tx `0xb3f42206…` through `Multicall3`, **9,997,818 gas** for 497 logs (≈ 248 stock-token transfers), **0.00404 ETH in fees** → **≈ 40,000 gas and ≈ $0.039 per transfer**.

### Requested extrapolation: a 100 holders × 10 tokens batch

| | gas | ETH | USD |
|---|---|---|---|
| 1,000 transfers @ 40 k (batch) | 40,000,000 | 0.0167 | **≈ $40** |
| 1,000 transfers @ 61 k (isolated) | 61,000,000 | 0.0255 | **≈ $61** |

**→ ≈ $0.40 to $0.61 per holder per epoch**, excluding Merkle verification (+~5 k gas/leaf) and loop overhead.

Consequences to face squarely:
- 1,000 holders served → **$400–610 per epoch**.
- 10,000 holders → **$4,000–6,100 per epoch**.
- The biggest Pons token on the chain has 103,968 holders. At that scale a full push is **unaffordable**.

**`MAX_BATCH`**: the largest tx observed in production is 10 M gas. Staying under that ceiling: **≈ 250 transfers per tx → `MAX_BATCH ≈ 25 holders** (× 10 tokens). Not 100.

**This does not break the design, but it changes the balance**: the Merkle claim can no longer be "the fallback", it becomes the economically viable route for the long tail, and the push must be reserved for the top of the ranking. The `MIN_BALANCE` from `docs/CONVENTIONS.md` is no longer a calibration detail: it is **the parameter that determines whether the system is fundable**. Recommendation: `MIN_BALANCE` set dynamically so that the number of pushed holders × $0.50 stays below a fixed fraction (e.g. 10 %) of the epoch's fees, the rest being claimable. **To be decided (§9).**

> Updated 2026-09-04, after the shift to cumulative roots. The figures above stand, but the design that followed from them is different and better: a leaf carries `(holder, stock, cumulative)` with **no epoch**, so one settlement per holder covers the whole history — the cost is per stock, not per epoch. The full measured cost of one settlement is **93,000 gas** (`SETTLE_GAS`), not 40,000: the transfer alone pays only a third of the bill. `MAX_BATCH` is **64** in the shipped contract, and the push threshold is value-based (~$10 per delivery, §S30), not a fraction of the epoch's fees.

> Second update, 2026-09-04. Every figure above, and the whole gas-refund model that rests on them, price a transaction as **L2 execution gas alone**. On an Arbitrum Orbit chain that is only true while the L1 pricer is switched off. It is — measured, not assumed: **§10.7**.

---

## 7. Keeper

- **Gelato**: no contract found (explorer search) → absent. **Out of scope, §10.2**: the keeper is ours.
- **Chainlink Automation** (`AutomationRegistry`, `OCR2Aggregator`): no contract found → absent. Only the *price feeds* are deployed. **Out of scope, §10.2**.
- **Conclusion**: a self-hosted cron, the fallback planned from the start. The compensation must cover the real gas (§6): at 0.0005 ETH (≈ $1.19) a flat tip covers a `harvest` but **not** a batch of 25 holders (≈ $10–15). **Compensation must be proportional to the gas consumed, not a constant.** That is what shipped: every cycle function refunds `gasUsed × block.basefee`, capped by `MAX_REFUND` (§S8).
- `Multicall3` is available (`0xcA11bde…`) → usable on the keeper side to group snapshot reads.

---

## 8. Proposed selection of the 10 stocks

> **Kept as the dated proposal it was; it is not the shipped basket.** `FeeVault`
> bounds a basket at `MIN_BASKET = 2` … `MAX_BASKET = 8`, and each vault composes
> its own from `docs/allowlist.md`. See §9.2.3. **Noted 2026-09-11.**

Your request said "for these 10 stocks: [your list]" — the list was not filled in, so **I propose, you decide**.

Criteria applied, all measured above: price impact < 0.05 % at 0.5 ETH **and** a Chainlink feed present (the non-negotiable `minOut` rule) **and** USDG TVL > 40 k.
| # | Stock | Address | USDG pool (fee) | Impact at 0.5 ETH | Feed |
|---|---|---|---|---|---|
| 1 | **NVDA** | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 500 | 0.002 % | `RHNVDA / USD` |
| 2 | **SPCX** | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | 500 | 0.002 % | `Robinhood SPCX / USD` |
| 3 | **AAPL** | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | 500 | 0.003 % | `Robinhood AAPL / USD` |
| 4 | **QQQ** | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | 500 | 0.005 % | `Robinhood QQQ / USD` |
| 5 | **SPY** | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 500 | 0.010 % | `RHSPY / USD` |
| 6 | **AMZN** | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 3000 | 0.012 % | `Robinhood AMZN / USD` |
| 7 | **GOOGL** | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | 500 | 0.019 % | `Robinhood GOOGL / USD` |
| 8 | **TSLA** | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 3000 | 0.022 % | `RHTSLA / USD` |
| 9 | **MSFT** | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 3000 | 0.048 % | `RHMSFT / USD` |
| 10 | **GME** | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | 500 | 0.024 % | `Robinhood GME / USD` |

All of them: 18 decimals, `uiMultiplier = 1e18`, not paused, not blocklisted, `BeaconProxy` on the shared beacon.

Possible substitutes, all qualified: **USO** (0.024 %), **SLV** (0.034 %), **TSM** (0.034 %), **CRCL** (0.062 %), **MSTR** (0.087 %), **SGOV** (0.002 % but a 17 h feed).

Rejected despite good liquidity, **for lack of a Chainlink feed**: **GLD** (802 k USDG), **RDDT** (854 k), **HIMS** (545 k). If you want them, you have to accept a 30-minute Uniswap v3 TWAP for their `minOut`.

GME is the least obvious choice of the lot (volatility, meme dimension). SGOV as a substitute would give the basket a "cash" leg but its feed is the stalest. Your call.

---

## 9. Decisions — state as of 2026-09-03

> This section has been **entirely rewritten**. It still listed a dozen points as "to be decided" that had been settled since, which is worse than listing nothing: someone opening it on launch day would believe nothing had been decided. Every line below was verified **in the code**, not from memory.

### 9.1 Settled

| # | Point | Decision | Where it lives |
|---|---|---|---|
| 1 | `pairToken` | **native ETH** (`address(0)`) | frozen at the launch |
| 2 | `creatorTaxBps` | ~~**400 (4 %)** → trader pays 5.00 %, we collect 4.70 %~~ **Per launch, not settled once.** The creator picks it at Pons; $PAYD picked **300** → trader pays 4.00 %, the vault receives 3.70 %. The MEASUREMENT this row rests on — Pons keeps 30 % of the curve fee, whatever the tax — is unchanged | §1.9, `ARCHITECTURE` §S11, `LAUNCH_PAYD.md` |
| 3 | `buybackEnabled` | **false** | §1.7 — otherwise the pre-graduation sweep depends on Pons |
| 4 | Pons v2 or `RWAERC20LaunchpadFactory` | **Pons v2** | §1.4 — you do not get a second chance with the community |
| 5 | Fees received in our own token | **moot**: `pairToken = ETH`, everything arrives as native ETH | — |
| 6 | Eligibility threshold | **value-based, derived from cumulative ETH**, capped at 1 M tokens | §S14 |
| 7 | Push vs claim | push threshold = **~$10 of value per delivery**, with a `20 × SETTLE_GAS` floor; below it, claim | §S30 |
| 8 | Feed staleness | `MAX_FEED_AGE = 12 h`. Beyond that the feed **stops tightening** but **never** blocks — markets close | `FeeVault` |
| 9 | Stocks with no Chainlink feed | **accepted**, floor from the 30-min v3 TWAP (`TWAP_WINDOW = 1800`) | `FeeVault` |
| 10 | Stock weights | **timelocked**, `setAllocations` is `onlyTimelock` | `FeeVault` |
| 11 | `MAX_BATCH` | **64** | `Distributor` |
| 12 | Compensation for the pusher | refund at **measured gas × `block.basefee`**, capped by `MAX_REFUND` | §S8 |
| 13 | Epoch length | **30 min** | §S15 |
| 14 | Challenge window | **removed** — the keeper publishes and the root takes effect immediately | §S29 |
| 15 | `payoutBps` | **400 (4 %)** per epoch, timelock-adjustable, 10 bps floor / 1,000 bps cap | §S15 |
| 16 | Split of what is collected | **8511 / 1489 bps** = 4.00 / 0.70 points of volume | §S11 |

> Rows 12 and 14 were updated on 2026-09-04. They previously read "`PROPOSER_PREMIUM`" and "challenge window: 2 h, bounded `[1 h, 7 d]`". Both belonged to the optimistic model, which the keeper model replaced (§S29): there is no bond, no premium and no window in the shipped contracts.

### 9.2 Open — human decisions

These are not technical questions: I do not have what I would need to decide for you.

1. **Buffer Safe: signers and threshold. IRREVERSIBLE.** The Safe becomes the `deployer`, and there is **no** `transferCreator` on the active locker. No correction is possible after the launch.
2. **Dev address.** Immutable in `FeeVault`. A Safe is recommended rather than an EOA.
3. ~~**Final list of the 10 stocks** — validate or amend §8.~~ **SETTLED, and the question itself no longer has that shape.** `FeeVault` bounds a basket at `MIN_BASKET = 2` … `MAX_BASKET = 8`, each line at least `MIN_ALLOC_BPS` (1 000), so there is no list of ten to validate: each vault picks its own from the allowlist (`docs/allowlist.md`, 49 stocks liquid enough). `$PAYD`'s own basket is **six lines** — QQQ · NVDA · TSLA · SPCX · SPY at 1 800 bps each, PONS at 1 000 (`script/DeployPaydVault.s.sol`). The ten-name list this row used to carry (NVDA · SPCX · AAPL · QQQ · GLD · AMZN · GOOGL · TSLA · USO · GME) was §8's proposal and was never deployed; **corrected 2026-09-11**.

### 9.3 Open — to be resolved before the launch, not after

1. ~~**The form's "Holder fee sharing" toggle.**~~ **SETTLED, see §1.8.** It deploys a `BeaconProxy` splitter and registers it as the `creatorFeeRecipient`: it **replaces** the Creator wallet. Switched on, `FeeVault` would never collect anything. It must stay **OFF** — we now know exactly what that avoids.
2. ~~**Is `protocolFeeShareBps` mutable on the hook side?**~~ **SETTLED, see §9.5.**

### 9.5 `protocolFeeShareBps` — mutable, but bounded (verified 2026-09-03)

| | |
|---|---|
| Where the value lives | **slot 5** of the hook — storage, not an `immutable` |
| Setter | `setProtocolFeeShareBps(uint256)` = `0xfc75e481`, present in the dispatcher |
| Who | the Pons owner alone; any other address reverts |
| Cap | **5000 (50 %)** — by bisection: 5000 passes, 10000 reverts |
| Proxy? | **no** — the three EIP-1967 slots are zero, the cap is in the bytecode |

**Worst case:** our share of the curve fee falls from 0.70 % to 0.50 % of volume. We would collect **4.50 % instead of 4.70 %**, i.e. −4.3 %. The 4 % tax is untouched.

That is considerably better than the 4.00 % floor I feared. **Risk acknowledged, bounded, quantified.**

### 9.4 Acknowledged risks — no decision needed, but to be written into the README

1. The 97 stock tokens are **upgradable through a single beacon** `0xe10b6f6B…`, and Robinhood has `adminBurn`, `pause` and `blockAccounts` on each of them. Our system is entirely exposed to that.
2. `uiMultiplier` (splits): `balanceOf` stays correct, but any `minOut` derived from a USD price must be converted at the current multiplier.
3. Pons can close `launchEnabled` at any time. Once our token is launched that no longer affects us.
3b. **Pons's owner can redirect our creator fees to any address, with 3 days'
   notice and no veto available to us** (§1.3b). Funds already in our contracts
   are unaffected; the future stream is not. Monitoring is the only response.
4. **Partial liveness dependency on the Pons sweeper after graduation** (§1.7).
   `FeeVault` can call `sweepPoolFees` itself as the `creatorFeeRecipient`, but
   only while no memecoin-denominated fees are pending; otherwise the sweep needs
   an internal swap that only the Pons operator may trigger. Measured operator
   cadence: median 2.3 min, up to 34.6 min in the worst case observed. An epoch
   can land on an empty vault; `buyBasket` copes and the smoothing catches up.
   **Accepted, to be monitored.**

## 10. What remains unverified — and why it does not block

Re-read on 2026-09-04, after the shift to the keeper model. **None of these points gates the launch.** They are classified by what they would cost if they went wrong.

### 10.1 Resolved since

- ~~**The "Holder fee sharing" toggle**~~ → **§1.8**. It deploys a `BeaconProxy` splitter and registers it as the `creatorFeeRecipient`: it **replaces** the Creator wallet. Beacon `0xa125492a…`, implementation `0xf70c5B3a…`, exposing `claim()` / `token()` / `release(address)`. Found by noticing that 50 recipients out of 60 share the same 291-byte bytecode.
- ~~**Is `protocolFeeShareBps` mutable?**~~ → **§9.5**. Yes, by the Pons owner, but **capped at 5000**, and the hook is not a proxy. Worst case quantified: 4.70 % → 4.50 % collected.

### 10.2 Out of scope — we do not use them

- **Ramses fork** (`RamsesV3Pool` holds SPY). We route through the Uniswap v3 pools whose liquidity was **measured stock by stock** (§4). Another DEX changes nothing as long as we do not use it.
- **Gelato / Chainlink Automation** absent from the chain. Moot: the keeper is ours, it runs in our container (§S31).
- **`quoteExactInput` v4 for the 10 stocks.** A single comparative quote (NVDA) was enough to rule v4 out for buying stocks — v3 won by ~1.7 %. Documenting the other nine would not change the decision.
- **Bytecode of factories `0x0c37a24F…` and `0xD9eC2db5…`.** They are other launchpads. We launch on `0x7eD598Bc…`, whose source is verified.

### 10.3 Informational — measured another way

- **The chain's gas waiver.** The existence of a programme is stated in a SPA we cannot extract. But we do not need it: gas was **actually measured** — 0.4177 gwei, a 10 M-gas transaction costs 0.00404 ETH. Every figure in the project rests on that measurement, not on an assumed exemption. A waiver would only improve them.
- **Exhaustive count of launches.** `eth_getLogs` is rate-limited beyond small windows. Unimportant: `launchEnabled() = true` and the recent launches prove directly that the factory is alive.

### 10.4 Future risk — to monitor, not to resolve

- **The new "rollout" Pons factory.** Its ABI is present in the front end's bundle (`previewLaunchEconomics`, `sweptTokens`, `sweptAt`) but **no deployed address was found** — the selector reverts on all three known factories.

  This is not a blocker: the current factory is alive and verified. But if Pons migrates after our launch, our token will stay on the old one. **To monitor after the launch**, not before.

### 10.5 Empirical proof not carried out

- **Launching a test token with a contract as the creator.** Not done. Reading the source answers the question, and §1.8 confirms it empirically — on real launches, `creatorFeeRecipient` is indeed a contract in 54 cases out of 60.

  Direct proof would require the **Robinhood testnet (chainId 46630)**, or forcing `launchEnabled` on a fork with `vm.prank` — a deliberate breach of the "no mock" rule, which I did not take alone.


### 10.6b `block.number` is the L1 block number — measured 2026-09-06, in production

> **Superseded on 2026-09-08, kept for the measurement.** The seed, the anchor
> and the reveal this section serves were deleted by
> [§S38](ARCHITECTURE.md#s38--the-time-weighted-average-and-the-machinery-it-deletes),
> and no contract reads `block.number` any more — the window is derived from
> `GENESIS` and `EPOCH_LENGTH`. The measurement below stays true of the chain,
> and [§S35](ARCHITECTURE.md#s35--blocknumber-is-ethereums-and-what-that-costs)
> is what it cost us.

This was the fact the seed mechanism rested on, and **no fork test can
establish it**: Foundry runs a plain EVM, where `block.number` is the forked
chain's own height and `vm.roll` advances it. On ArbOS it is the **Ethereum
mainnet** height.

Read off the first real `anchorEpoch` (epoch 2, tx `0x8bd4b510…`), which stores
`block.number + SEED_DELAY`:

```
seedBlockOf(2)                    25,914,550
                    - SEED_DELAY       - 128
block.number seen by the contract 25,914,422
Ethereum mainnet, same moment     25,914,434     <- 12 blocks later, i.e. the same clock
Robinhood Chain height            55,514,640     <- NOT this
ArbSys.arbBlockNumber()           55,515,107     <- the L2 height lives here
```

**`blockhash` follows the same numbering**, which is what makes the mechanism
work. Probed by running raw bytecode (`PUSH4 n; BLOCKHASH; …`) through
`eth_call` against the live chain:

| argument | result |
| :--- | :--- |
| `blockhash(L1 − 5)` | `0xadf1d6d8…` |
| `blockhash(L1 − 50)` | `0x5a838b68…` |
| `blockhash(L1 − 200)` | `0xc93b4a75…` |
| `blockhash(L1 − 300)` | `0x0` — past the 256-block window |
| `blockhash(L2 height − 5)` | `0x0` — wrong numbering entirely |

Two consequences for `revealSeed`:

- `SEED_DELAY = 128` sits inside the native 256-block window, so the history
  contract of §10.6 is never reached on the nominal path. It stays the fallback
  for a late reveal, and note it is keyed on **ArbSys** numbers, so it cannot
  serve an L1-numbered anchor at all — it reverts.
- the reveal window is **256 L1 blocks ≈ 51 minutes**, not 256 L2 blocks
  (~26 s). Miss it and `anchorEpoch` re-anchors, which is exactly why
  `SeedUnavailable` was made non-terminal.

### 10.6 Blockhash history buffer — measured 2026-09-04

The contract at `0x0000F90827F1C53a10cb7A02335B175320002935` is **not** the standard EIP-2935 deployment. Its bytecode carries `PUSH3 0x05ffd0` — a **393,168-block** ring buffer, not the 8,191 of the specification — and it resolves the head through the `ArbSys` precompile (`0x64`, selector `a3b1b31d`) rather than `block.number`.

```
buffer   = 0x05ffd0 = 393,168 blocks
block    = 0.1009 s (measured over 10,000 blocks, 2026-09-04)
horizon  = ~11.02 h
```

Confirmed by probing: hashes match the real block hashes at depths up to 392,623, and the call **reverts** past the buffer (it does not return zero — `_pastBlockhash` treats a failed staticcall as a miss, which is correct).

This corrects §S13 of `ARCHITECTURE.md`, which claimed "EIP-2935's verified ~8.3 h". That figure was never a measurement of the buffer: it was the ~300,000-block window of the fee-sweep survey in §1.7, borrowed by mistake. The buffer had never actually been read.

Practical consequence: the horizon is a **block count**, not a duration. Block time drifts; 393,168 does not. Nothing in the contract depends on the number any more — `revealSeed` has no deadline, and re-anchoring keys off the hash being unreachable rather than off any clock — but the keeper uses it to decide when an anchor is dead (`SEED_HISTORY_BLOCKS`).

### 10.7 The L1 pricer is off — and every gas figure in this file depends on it (measured 2026-09-04)

Robinhood Chain is an Orbit L2. On Nitro, a transaction normally pays two things: its L2 execution, and an **L1 posting surcharge** for its calldata. The surcharge is not billed as ETH on the side — ArbOS adds it to the transaction's *gas used*, above what the EVM actually executed. So `gasleft()` inside a contract **cannot see it**.

That matters here because the refund is measured from the inside:

```solidity
uint256 used = g0 - gasleft() + REFUND_OVERHEAD;   // REFUND_OVERHEAD = 40,000, flat
owed = used * block.basefee;                       // FeeVault; ×1.20 in Distributor
```

If the surcharge were live, the part of the bill that the refund misses would **scale with calldata** — and `distribute` is nearly all calldata (up to 64 Merkle proofs). The refund would under-cover exactly the largest batches, a flat 40,000 could not absorb it, and "every cycle action pays its own gas, so anyone will call it" would quietly stop being true for the calls that matter most.

It is not live. `ArbGasInfo` (`0x000000000000000000000000000000000000006C`), read on 2026-09-04:

```
getL1BaseFeeEstimate()  = 0
getPricesInArbGas()     = (0, 0, 20000)
                           |  |  └ perStorageAllocation, arbgas
                           |  └ perL1CalldataUnit  = 0
                           └ perL2Tx              = 0
getPricesInWei()        = (0, 0, 7912680000000, 20000000, 375634000, 395634000)
                           |  |                                      └ perArbGasTotal
                           |  └ perL1CalldataByte = 0
                           └ perL2Tx             = 0
```

Consistent with itself: 7,912,680,000,000 wei / 395,634,000 wei-per-arbgas = 20,000 arbgas of storage allocation, and 20,000,000 base + 375,634,000 congestion = 395,634,000 total. The two L1 columns are zero. **A transaction here pays for its execution and nothing for its calldata.**

The second half of the model checks out too — the refund prices gas at `block.basefee` while the caller pays `basefee + priority`:

```
block.basefee   391,354,000
gas price       397,434,000     → +1.55 %
```

`PUSH_MARGIN_BPS = 300` (+3 %) covers that about twice over, which is all the
constant owes anyone: pushing stays profitable, as §S8 claims. It was 2000
(+20 %) until 2026-09-10 — 12.9 times a 1.55 % need — and everything past the
priority fee was a bounty paid out of the holders' reserve, not a refund.

**What to monitor — and when.** This is a chain *configuration*, not a property of Orbit. The operator can switch the L1 pricer on at any time, and nothing on our side would notice: no revert, no event, no failing check. `REFUND_OVERHEAD` is `internal constant` in both `FeeVault` and `Distributor`, so switching it on costs us a **redeploy**, not a setter.

Which makes the timing the whole point, and it is worth being precise about it. Reading this once before the deployment is nearly worthless: it is zero today and it will be zero on launch day. The scenario that hurts is the flip happening **months in**, on a system that has been running unattended — and a one-off check at t=0 cannot see that by construction.

So the check lives in the keeper's loop, which already runs every 60 s, as a **warning and not a gate**: a live pricer does not make a root wrong, it makes pushing unprofitable, and refusing to publish would punish holders for a change none of them caused. `stepL1Pricer()` in `offchain/src/keeper.ts` re-reads `getL1BaseFeeEstimate()` every tick and warns when it is non-zero — on the flip, on process start, then hourly while it lasts, because one line at the moment it happens is a line nobody scrolls back to. It runs last in the tick and swallows its own errors: a warning must never cost an epoch.

The decision itself is `l1PricerAlert()` in `epoch.ts`, next to the other push-economics constants, and it is unit-tested rather than fork-tested on purpose. On-chain the value is 0 and will stay 0 until someone changes it, so a fork test could only ever exercise the "nothing to report" branch — it would pass for the wrong reason, forever. The branch worth proving is the one no environment we can reach will produce.

The symptom, if nobody watches: `quoteAtRisk` drifts upward and stays there. Not because anything broke — because pushing stopped paying for itself and the permissionless callers quietly went away. That is the same signal §S8 already tells us to watch, arriving from a cause nothing in the code can name.

## 12. Pons memecoins are not reachable by our router — 2026-09-09

The question asked: can a large Robinhood Chain memecoin go into a basket?
Measured on **HASH** (`0x260dECCF21ce76B0603fe6aB287cF1b503C66D39`), a
**graduated** Pons memecoin (`phase = 2`, PoolCreated):

| pair | 0.01 % | 0.05 % | 0.3 % | 1 % |
|---|---|---|---|---|
| HASH / USDG | — | — | — | — |
| HASH / WETH | — | — | — | — |

**No Uniswap v3 pool anywhere.** And it is not a matter of depth: `getPool`
returns `address(0)` on all eight combinations.

The reason is structural: **a graduated Pons launch lands in a Uniswap v4
pool** — PoolManager plus the meme hook, which `_poolKey` already builds and
`test/V4Swap.t.sol` already measures. But `FeeVault._buyLegs` swaps through
`ISwapRouter02.exactInput`, which is **v3**.

The consequence settles two questions at once:

- **A memecoin cannot be a basket leg today**, however generous the v3 routing
  is. A multi-hop `bytes path` route would change nothing: it describes v3 hops,
  and there is no v3 hop to describe.
- What it would take is a **v4 leg** in `_buyLegs`: `unlock` → `swap` →
  `settle`/`take`, per leg. The pattern already exists in the repository —
  `Treasury.unlockCallback` does it for the `$PAYD` buy-and-burn — so it is a
  port, not an invention. But it is a second swap engine inside the contract
  that holds the money, with its own floor: a v4 pool has no v3 `observe()`, so
  `TwapFloor` does not apply to it.

The Robinhood stock tokens, on the other hand, really are on v3 — which is why
everything else works.
