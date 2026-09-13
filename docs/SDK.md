# SDK.md — integrating a Payd vault by hand

`sdk/README.md` covers the two-line drop-in. This is the other document: every
call the SDK makes, in order, so you can rebuild exactly the part you want in
whatever stack you already ship — viem, ethers, wagmi, web3.py, a Go backend, a
Dune query, a Telegram bot.

Nothing here needs a key, a server, or our permission. It is all public state on
Robinhood Chain.

```
chain id   4663
rpc        https://rpc.mainnet.chain.robinhood.com
explorer   https://robinhoodchain.blockscout.com
```

---

## 1. The one address you need

A launch has **one vault**. Everything else hangs off it:

```solidity
vault.DISTRIBUTOR() → address   // where shares are settled
vault.token()       → address   // the launched ERC-20
vault.CREATOR()     → address   // you
vault.QUOTE()       → address   // the currency fees arrive in; 0x0 = native ETH
```

There is **one Distributor per vault**, cloned at launch. Do not hardcode it,
and do not reuse another launch's — read it from your vault every time. Same for
the token: a vault knows its token, so a page that takes both as configuration
has two chances to be wrong instead of one.

`Payd.vaultsOf(creator) → address[]` lists every vault you own, and
`Payd.vaults()` lists all of them.

---

## 2. What your token pays — `economics()`

```solidity
vault.economics() → (
  uint256 taxBps,             // creator tax on every trade
  uint256 curveFeeBps,        // the Pons curve fee
  uint256 ponsShareBps,       // the slice of that fee Pons keeps
  uint256 grossOfVolumeBps,   // what reaches the vault, as a share of VOLUME
  uint256 rewardsOfVolumeBps, // …of which, to holders as stock
  uint256 creatorOfVolumeBps, // …to you
  uint256 platformOfVolumeBps // …to Payd, fixed at creation, never raisable
)
```

**These are shares of traded volume, not of the vault.** That is deliberate: it
is what a trader actually pays, and the only one of the two figures you can
compare from one launch to another. `rewardsOfVolumeBps = 250` means *2.5 % of
every trade comes back to holders as stock* — that is your headline number, and
it is different for every launch, so it cannot be written into a template.

The call reverts to zeros if a Pons getter moves under it. Show nothing rather
than a stale percentage; that is what the SDK does.

## 3. Is it still working — `hookStatus()`

```solidity
vault.hookStatus() → (uint8 status, address current, uint64 effectiveAt)
```

| status | meaning |
|---|---|
| 0 | not launched — the vault exists, no token is paying into it yet |
| 1 | **collecting** — the healthy state |
| 2 | redirect scheduled — fees will move at `effectiveAt` |
| 3 | fees lost — the creator wallet on Pons is no longer this vault |

Anything other than 1 deserves a visible badge on your page. A card that shows a
cheerful percentage while status is 3 is lying to your holders.

## 4. The basket — `getAllocations()`

```solidity
vault.getAllocations() → (address stock, uint24 poolFee, uint16 bps, address feed)[]
```

Two to eight Robinhood stock tokens (`MIN_BASKET` / `MAX_BASKET`), weights in
bps summing to 10 000 and no line under `MIN_ALLOC_BPS` (1 000). Read the array's
length rather than assuming it. One purchase buys
the *whole* basket, each line by its weight. `poolFee` and `feed` are plumbing —
the Uniswap tier and the oracle used for the slippage floor. For a UI you want
`stock` (call `symbol()` on it) and `bps`.

`allocationOf(uint256)` and `ROTATION_STRIDE()` **no longer exist** (removed
2026-09-09). They survived from a weighted-rotation design — one stock per epoch
— replaced by buying the whole basket in one transaction. Reading them reverts.

They were removed for a measured reason, not for tidiness: `FeeVault` was 26 152
bytes of runtime, **1 576 above the EIP-170 cap**, and those two dead members
were 1 322 of the way back under.

## 5. The clock — the Distributor

```solidity
distributor.currentEpoch()      → uint256
distributor.epochEnd(epoch)     → uint256   // unix timestamp
distributor.EPOCH_LENGTH()      → uint256   // 30 min in production
```

`epochEnd(currentEpoch()) - now` is your countdown to the next buy. Nothing
about the epoch needs a subscription or a websocket; two reads on page load and
a local timer are enough, since `epochEnd` only changes when the epoch rolls.

---

## 6. Paying a holder — the settlement path

This is the part with a sharp edge. Read it before you write it.

### 6.1 The root

Every epoch the keeper publishes one root:

```solidity
distributor.activeRoot() → uint256          // 0 = none published yet
distributor.roots(id) → (
  address publisher, uint40 publishedAt,
  bytes32 claimRoot, bytes32 pushRoot,
  uint48 upToEpoch, bytes32 digest
)
```

> Decode that tuple **field for field**. Dropping one raises no error in most
> libraries — the decoder reads a word too early and everything after it shifts
> by one slot, so `digest` silently returns `upToEpoch` and you never find the
> data. This has bitten this codebase; it is why the ABI in `front/src/chain.ts`
> carries a warning comment.

### 6.2 The artifact, and why you must not trust the gateway

`digest` is `sha256(the canonical epoch JSON)`. The JSON itself lives on IPFS.
Two ways to address it, in this order:

1. the `cid` string in the `RootPublished` log for that `rootId` — the only one
   that works once the artifact exceeds one IPFS block, around 160 holders;
2. the CIDv1 rebuilt from the digest (`raw`, `sha2-256`) — correct while it fits
   in one block, and your only option if the chain no longer serves old logs.

```
event RootPublished(uint256 indexed rootId, address indexed publisher,
                    bytes32 claimRoot, bytes32 pushRoot,
                    uint256 upToEpoch, bytes32 digest, string cid)
```

**Then hash what you fetched and compare it to `digest` before you use a single
byte of it.** Gateways are a convenience, not an authority. With the check, a
hostile or broken gateway can only make your page fail to load. Without it, it
can invent amounts and addresses in your UI. Try gateways in order and take the
first whose content matches; `ipfs.io` and `dweb.link` return a 403 Cloudflare
page to any browser fetch carrying an `Origin` header, so they belong at the end
of the list, never alone.

The JSON:

```jsonc
{
  "upToEpoch": 412,
  "excluded": ["0x…"],                  // pool, curve, vault, distributor, CEXs
  "entries": [
    { "holder": "0x…", "stock": "0x…",
      "cumulative": "1234567890",       // raw units, since genesis
      "push": true }                    // large enough to be airdropped
  ]
}
```

Shares are **cumulative since genesis**, not per-epoch. One claim settles the
whole history, one transfer per stock, no matter how long the holder waited.

### 6.3 Two trees, and the mistake that costs a transaction

```solidity
distributor.claim(address[] stocks, uint256[] cumulative, bytes32[][] proofs)
```

`claim()` — signed by the holder for themselves — verifies against
**`claimRoot`**, built over **every** entry.
`distribute()` — callable by anyone for a third party, and it refunds its own
gas — verifies against **`pushRoot`**, built over the entries with
`push: true` only.

A proof built on the wrong tree passes every check you can make off-chain and
reverts on-chain with `InvalidProof`. Build the claim tree from
`entries`, the push tree from `entries.filter(e => e.push)`, and never mix them.

### 6.4 The tree shape

The leaf is a **double keccak** of `abi.encode(address holder, address stock,
uint256 cumulative)`. Leaves are sorted by hash, laid out backwards in the second
half of a complete binary tree of `2n-1` nodes, and paired with an ordered hash
(`a < b ? H(a,b) : H(b,a)`). That is OpenZeppelin's `StandardMerkleTree`, and it
is what fixes the root.

If you are in JS, use `@openzeppelin/merkle-tree` and stop thinking about it.
If you are anywhere else, port it and test it: **naively pairing sorted leaves
two by two gives the same root at 2, 3, 4, 6 and 8 leaves and diverges at 5, 7,
9** — so every quick trial passes and every real epoch reverts.
`front/src/merkle.ts` is a dependency-free implementation, checked leaf by leaf
against the real library from 1 to 200 entries in `front/src/merkle.test.ts`.

### 6.5 Before you send

```solidity
distributor.owedTo(holder, stock, cumulative) → uint256   // still to be paid
distributor.claimedSoFar(holder, stock)       → uint256   // already received
```

- **Drop any stock where `owedTo` is 0.** It passes the Merkle check and
  delivers nothing, and the caller pays for its branch anyway.
- **Re-read `activeRoot` and rebuild the proofs immediately before sending.** A
  tab left open across a publication holds proofs the contract will reject, and
  `_settle` reverts the *whole* batch on the first `InvalidProof` — the wallet
  shows a bare "execution reverted" that explains nothing to your user. One
  extra read costs less than one failed transaction.
- `owed` is in the stock token's own units. Read its `decimals()`. It is not ETH.

### 6.6 You usually do not have to do any of this

Shares arrive on their own: the automatic airdrop runs at most every 24 h, as
soon as a holder's share is worth about $20. A claim button is a *shortcut* for
someone who does not want to wait — never the only door. If building section 6
is more than you want to carry, ship sections 1–5 and link to
[paydprotocol.eth/app](https://paydprotocol.eth.limo/app/) for the collection.

`Collector.collect(account, distributors, stocks, cumulative, proofs)` settles
several launches in one transaction for holders of more than one Payd token. It
holds nothing and has no owner; it is a shortcut too, and a broken or replaced
one never stands between anyone and their share.

---

## 7. Who is not in the tree

Excluded from the snapshot, and therefore paid nothing: the Uniswap pool, the
Pons bonding curve, the vault, the distributor, address 0, and a timelocked
`excluded[]` list (CEXs, contracts). Read it with
`distributor.excludedList()`, or `isExcludedAt(account, epoch)` for a past
epoch.

Holders below the value threshold are not in the tree either, and their weight
is redistributed to the others. The threshold is expressed as the **value of the
share**, not a percentage of supply — a fixed percentage is too permissive at
launch and too restrictive later.

An epoch's balance is the **time-weighted average over the whole epoch**,
`∫ balance dt / L`, not a sample. Someone who holds for an instant is paid for
an instant. If a holder asks why their number looks lower than their balance,
that is the answer.

---

## 8. Things that will look like bugs and are not

| What you see | What it is |
|---|---|
| `shares()` returns nothing for a real holder | they are not in the *current* root — bought after the last publication, or below the threshold. Next epoch fixes it. |
| `activeRoot() == 0` | no root published yet. A brand-new launch. Show "preparing the first payout". |
| `economics()` returns zeros | a Pons getter moved. Hide the block; do not show 0 %. |
| the artifact fetch fails on every gateway | the content is fine, the gateways are not. Retry, add gateways. Never fall back to unverified content. |
| a claim reverts with `InvalidProof` | a new root was published between building and sending, or you used the push tree. See 6.3 and 6.5. |
| a vault whose `QUOTE` is not ETH refunds no gas | by design — it pays a **bounty** instead: 2 % of what the call moved, in its own currency, capped at `MIN_BUY_QUOTE`. `_refundAmount` is in wei and that vault holds none. |
| `allowQuotes` reverts `QuoteNotSweepable` | the platform's till has no route to convert that currency back into ether. `Treasury.allowSweeps` has to land first — both are timelock votes, so it is an ordering, not a blocker. |
| a vault whose `QUOTE` is not ETH uses a floor in its own currency | its delivery floor is 40 % of `MIN_BUY_QUOTE` (~$10) — the same value an ether vault uses, but `quoteSpent` is denominated in the vault's QUOTE there, so a wei constant never matched. Same cadence, different unit. |

---

## 9. Source of truth

Everything above is read from the contracts in `contracts/`. When this document
and the code disagree, the code wins — and the disagreement is a bug worth
reporting.

- `contracts/FeeVault.sol` — fees in, basket out
- `contracts/Distributor.sol` — roots, claims, exclusions
- `contracts/Payd.sol` — the vault index
- `sdk/src/payd.ts` — a working implementation of this whole document, ~300 lines
- `front/src/merkle.ts` + `merkle.test.ts` — the tree, and its proof that it is right
- `docs/ARCHITECTURE.md` — why each of these choices, at length
