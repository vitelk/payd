# @payd/sdk

Put your token's vault on your own site. Two lines of HTML, no backend, no key.

```html
<script type="module" src="https://paydprotocol.eth.limo/sdk/payd.js"></script>
<payd-vault vault="0xYourVaultAddress"></payd-vault>
```

That is the whole integration. The card reads the chain from your visitor's
browser and shows what your token pays, when the next buy happens, what is in
the basket, and a button that lets a holder collect their stocks without leaving
your page.

**The vault address is the only thing you have to know.** The distributor, the
token, the basket and the fee split are all read from it. Copying a second
address into a third-party site is how one of the two ends up stale.

Find your vault address in the Payd app, or in the receipt of your launch. It
is the same address your Pons creator fees are paid to.

---

## What the card shows

| | |
|---|---|
| `$TICKER` + status pill | whether fees are still arriving (`collecting` is the healthy one) |
| the headline | `X% of every trade comes back to holders as stock` — read from `economics()`, so it is *your* number, not a marketing one |
| Next buy / Every / Basket | countdown to the end of the current epoch, epoch length, basket size |
| stock chips | the vault's Robinhood stock tokens — 2 to 8 of them — and their weights |
| the button | connects a wallet, shows that address's pending share, then collects it |

Everything is a contract call. There is no server between your page and the
chain, nothing to host, and nothing that can go down and take the card with it.

---

## Styling

The card lives in a shadow root, so your site's CSS cannot break it and it
cannot leak into your site. Colours and fonts come in through CSS custom
properties, which do cross that boundary:

```css
payd-vault {
  --payd-bg: #101014;
  --payd-fg: #fff;
  --payd-muted: #8b8b88;
  --payd-line: #26262a;
  --payd-accent: #ccff00;   /* the button and the healthy pill */
  --payd-radius: 14px;
  --payd-font: "Inter", system-ui, sans-serif;
  --payd-font-mono: "IBM Plex Mono", monospace;
  max-width: 26rem;         /* the card fills its container */
}
```

`theme="light"` flips the four base colours to a light set in one attribute:

```html
<payd-vault vault="0x…" theme="light"></payd-vault>
```

Other attributes: `rpc="https://…"` (defaults to the public Robinhood Chain RPC)
and `gateways="https://a/ipfs/,https://b/ipfs/"` (comma-separated IPFS gateways,
tried in order).

---

## In a framework

The element is a native custom element, so it works unchanged in React, Vue,
Svelte, Astro and plain HTML.

```tsx
import "@payd/sdk";           // registers <payd-vault> once

export const Rewards = () => <payd-vault vault="0x…" theme="light" />;
```

React < 19 does not pass unknown props to custom elements as attributes; either
upgrade or call `mount` yourself:

```tsx
import { useEffect, useRef } from "react";
import { mount } from "@payd/sdk";

export function Rewards({ vault }: { vault: `0x${string}` }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => mount(ref.current!, { vault }).stop, [vault]);
  return <div ref={ref} />;
}
```

`mount` returns `{ stop }`. Call it on unmount — it clears the countdown timer.

---

## Headless

If you want your own markup, skip the element entirely and take the data:

```ts
import { createPayd, connect } from "@payd/sdk";

const payd = createPayd({ vault: "0x…" });

const info = await payd.info();
// { symbol, rewardsOfVolumeBps, epochLength, currentEpoch, epochEnd,
//   basket: [{ stock, symbol, bps }, …], hookStatus, distributor, token, … }

const me = await connect();                 // eth_requestAccounts
const shares = await payd.shares(me);       // [{ stock, symbol, decimals, owed, claimed, cumulative }]

const res = await payd.claim(me);           // null when there is nothing to take
if (res) console.log(res.hash);
```

Three notes that will save you a wasted transaction:

- **`shares()` returning `[]` is not an error.** It means that address is not in
  the current root — a wallet that bought after the last publication, or one
  whose share is below the value threshold. Say "check back after the next
  epoch", not "something went wrong".
- **`owed` is in the stock's raw units.** Use its `decimals`, which the SDK
  already fetched for you. It is *not* ETH.
- **Never cache proofs.** `claim()` re-reads the artifact right before it
  builds them, on purpose: the keeper publishes a new root every epoch, and a
  proof built against the previous one reverts the *whole* batch with
  `InvalidProof` — a bare "execution reverted" in the wallet that explains
  nothing. Do not try to be clever about this.

`createPayd` accepts `{ vault, rpc?, gateways?, client? }`. Pass `client` if
your app already has a viem `PublicClient` for Robinhood Chain.

---

## Trust

The card is read-only and holds nothing. The one write it makes is the holder's
own `claim()`, signed in their wallet.

Epoch data lives on IPFS, and gateways are not trusted: every fetched artifact
is checked against the `sha256` the distributor published on-chain before a
single number is shown. A hostile gateway can make the card fail to load. It
cannot invent an amount or an address. That check is the thing `src/payd.test.ts`
guards.

---

## Cost

`dist/payd.js` is ~110 KB gzipped, almost all of it viem — the same weight as
the Payd app itself. That is the price of reading a chain with no server in the
middle. If it is too much for a landing page:

- load it lazily (`import("@payd/sdk")` when the section scrolls into view), or
- talk to the contracts yourself with whatever you already ship —
  [`docs/SDK.md`](../docs/SDK.md) documents every call this package makes, so
  you can reimplement exactly the part you need.

---

## Local

```
pnpm install
pnpm --filter @payd/sdk test        # the gateway-cannot-lie check
pnpm --filter @payd/sdk build       # dist/payd.js
pnpm --filter @payd/sdk exec vite   # serves demo.html
```
