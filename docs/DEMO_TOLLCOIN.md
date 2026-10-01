# DEMO_TOLLCOIN.md — everything to copy or type, in the order the form asks it

The demo launch recorded for the video: one vault, one token, three signatures.
Cue cards for the recording are `docs/brand/demo-cues.html` (`F` full screen,
space to advance, `N` for the shot notes).

Every address and tier below was **read on the live registry on 2026-09-19**,
not copied from a document. Re-read them if the take slips by more than a day —
the allowlist is a timelock operation and it moves.

---

## 0. Before the camera rolls

| | |
| :--- | :--- |
| Wallet | the one that will sign **all three** steps. Step 1 makes it the vault's `LAUNCHER`, and `bind` compares Pons's recorded `deployer` against it. |
| Balance | `launchFee` 0.0005 ETH + gas, on Robinhood Chain. Add the first buy if you do one. |
| Network | Robinhood Chain (4663). The page's chip says so — leave it visible in frame. |

Three things to re-check the morning of the take:

```bash
set -a && . ./.env && set +a
P=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e          # Pons v2 factory
cast call $P 'launchEnabled()(bool)'       --rpc-url $RPC_URL   # -> true
cast call $P 'launchFee()(uint256)'        --rpc-url $RPC_URL   # -> 500000000000000
cast call $P 'maxCreatorTaxBps()(uint256)' --rpc-url $RPC_URL   # -> 1000

curl -s https://ipfs.io/ipfs/bafkreic7g2otec46adxf6htyngyunxqpvzbgqotzomcvxruadw5quhrgam | shasum -a 256
# -> 5f369d320b9e00ee5f1e7869b146de0fae42683a7973055bc6801dbb0a1e2603
```

All three were `true / 5e14 / 1000` and the logo served the right bytes on
2026-09-19.

---

## 1. Create the vault — `Payd.createVault`

Open the app on `#create`. Field by field:

| field | value | why this one |
| :--- | :--- | :--- |
| Payout mode | **distribution** | the registry's default factory is `0x4C1c21285d79e036AeFC8e609D7aBf06DA88d70C`, mode `distribution`. Three other modes are enabled and listed — tontine, backing, lottery — so the selector is visible and the right one has to be picked on purpose. |
| Basket | the four lines below | 2 to 8 stocks, each ≥ 1 000 bps, summing to 10 000 |
| Share of fees to holders | `70` % | the default; the floor the vault enforces is 50 % |
| Currency | **native ETH** | lets the first buy ride in the launch transaction, and keeps the gas refund path the ether vaults have |
| Epoch length | `30` minutes | the minimum, and the number said out loud in the script |
| Intended token | leave empty | it pins the address the vault will accept at bind time; empty, it accepts whichever token names it and was deployed by this wallet |

### The basket

| symbol | address | tier | weight | depth +1 % | feed |
| :--- | :--- | ---: | ---: | ---: | :--- |
| `TSLA` | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 3000 | **4000** | $506 867 | Chainlink |
| `USO`  | `0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344` | 3000 | **3000** | $75 983 | Chainlink |
| `SGOV` | `0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5` | 3000 | **2000** | $1 997 598 | Chainlink |
| `GLD`  | `0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e` | 3000 | **1000** | $690 010 | **none — TWAP only** |

The car, the fuel, the ballast, and one line with no oracle at all. Every pool
here is six figures deep, so the story costs nothing in execution.

`UPS` (`0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2`, tier 3000) held that last
slot — the trucks that pay the tolls, which is the better line to say out loud.
It was dropped on depth: $10 370, no feed, and a pool that cannot serve the
30-minute TWAP window gives no floor, so the leg is **skipped** and its share
waits in `pivotReserve` (`docs/allowlist.md` §406). A zero row on camera is not
worth the pun.

You never type the tiers: the form reads them from the registry's
`StockAllowed` events and `Payd._checkBasket` refuses a line declared at the
wrong one (`WrongPoolFee`).

**`GLD` is the one without an oracle**, and it is deliberate: its floor comes
from the 30-minute Uniswap TWAP instead of a Chainlink feed, on $690 010 of
depth. Worth saying out loud on camera — it is the answer to "and if there is
no price feed?".

---

## 2. Launch on Pons — `PonsV2.launchToken`

Built from the same page, so the three fields `bind` checks cannot be mistyped.

| field | value |
| :--- | :--- |
| Name | `TollCoin` |
| Ticker | `TOLL` |
| Your creator tax | `3` — in **percent**, cap read on-chain is 10 |
| Logo | `ipfs://bafkreic7g2otec46adxf6htyngyunxqpvzbgqotzomcvxruadw5quhrgam` |
| Description | `Launched on Pons. Fee plugin by Payd Protocol.` |
| Website | leave empty |
| X | `https://x.com/PaydRH` |
| Telegram | leave empty |
| Your first buy | `0` — raise it only if you want the `launchAndBuy` variant on camera |

Three fields are **not** asked, and that is the point of the step: the fee
recipient is set to the vault from step 1, the pair token is read from the
vault, and the economics commitment is computed.

### The logo

`logo-512.png`, 66 418 B, one IPFS block, from
`~/orca/workspaces/toll/knifefish/brand/`. Pinned on Filebase through the
endpoint the keeper already uses, on 2026-09-19:

```bash
set -a && . ./.env && set +a
curl -s -X POST "$IPFS_API_URL/api/v0/add?cid-version=1&raw-leaves=true&pin=true" \
  -H "Authorization: Bearer $IPFS_API_KEY" \
  -F "file=@path/to/logo-512.png"
```

Served by `ipfs.filebase.io`, `gateway.pinata.cloud` and `ipfs.io`, bytes
checked against the local file. It lives in **one** bucket: for anything that
is not a demo, add a second provider (`docs/DEPLOY_FRONT.md` §163).

---

## 3. Point the fees at it — `FeeVault.bind`

| field | value |
| :--- | :--- |
| Token address | filled in automatically by step 2 |

Callable by anyone — the destination was written into the launch, not into the
caller. If it refuses, the page names which of the three conditions gave way
before spending the gas (`front/src/launchlog.ts`, `diagnose`).

---

## What cannot be repaired afterwards

1. **The signing wallet.** A launch signed by anything other than the vault's
   `LAUNCHER` binds to nothing, and Pons does not refund the launch fee.
2. **The logo URL.** Written on the token, no setter. A dead pin is a dead logo
   for good.
3. **The quote currency.** Written into the vault at birth; `bind` refuses a
   launch quoted in any other.
4. **The creator fee recipient**, if you ever fill Pons's own form by hand
   instead of this page.
