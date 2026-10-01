# Design brief — the Tokens page, and only it

A follow-up to [DESIGN_BRIEF_APP.md](./DESIGN_BRIEF_APP.md), which was too broad
to fix this one screen. Everything in that file still applies: same brand, same
constraints, `route.ts` untouchable, no dependency, `?mock` to see every state.

**The verdict on the current attempt: it got tidier, it did not become a
launchpad.** This file says exactly why, and what to do instead.

## What the page is today

A six-column HTML `<table>`, one row per launch:

| Token | Status | To holders | Creator / platform | Waiting to buy | Yours |
| :--- | :--- | ---: | ---: | ---: | ---: |
| ticker as text | pill: *collecting* | 3.29 % | 0.71 % / 0.30 % | 0.0142 ETH | — |

Filters: All · Yours · Collecting · On the curve. Sort: **To collect** (default) ·
Volume · Newest.

## Why it does not read as a launchpad

1. **A table is a ledger.** Six right-aligned numbers per row is a thing nobody
   scans. A launchpad index is a grid of cards.
2. **The default sort is "To collect"** — the order of what the protocol owes.
   A launchpad's default order is **newest**, always, because the newest launch is
   the product.
3. **The first column is a ticker in text, and there is an image available.**
   Every Pons token carries a `logo()` — an IPFS URI written at launch, with no
   setter. The SDK card already renders it. The index does not read it. This is
   the single biggest reason the page looks like an explorer.
4. **"Status" is infrastructure language.** *not launched · collecting · redirect
   scheduled · lost* answers "is the plumbing healthy", which is not the question
   a visitor arrived with. Keep the information — a redirected launch must stay
   visible — but it is a badge on a card, not a column with a heading.
5. **Four numbers compete and none of them wins.** A launchpad row has ONE number
   set large and everything else small.
6. **There is no "launch yours" in the list.** The action lives in another tab.
   A launchpad puts it in the grid, as the first cell or a persistent bar.
7. **Nothing conveys time or motion.** No age, no "2 h ago", nothing that changes
   while you look at it.

## The number that should be large, and it is ours alone

**What this token has actually paid its holders.** Not a rate, not a projection:
the amount that has left the contract.

It is readable: `Distributor.totalFunded(stock)` and `totalDistributed(stock)`
are public per-stock mappings, and `front/src/metrics.ts` already prices stocks
the same way for the shop window's figures. Sum the basket, price it, and that is
the headline of every card.

Every other launchpad's index shows market cap and 24 h volume — numbers a
visitor can get anywhere. Ours can show *dollars of equities delivered to
holders*, and today it shows a percentage of volume instead.

**It costs reads.** The index already does one multicall round per launch (token,
distributor, hookStatus, economics, reserve, mode). The logo is one more call per
row; the paid figure is two per stock per row, up to eight stocks. So: design the
card to **paint without it and fill it in**, exactly as the other panels do. A
card that waits for its best number is a card nobody sees.

## What to build

- **A responsive card grid**, one card per launch, the newest first by default.
- **Each card**: the logo, the ticker, ONE large number (paid to holders, in
  dollars), the mode as a small tag, a quiet badge only when something is wrong,
  and — when a wallet is connected — what this visitor is owed, as the one
  secondary figure that earns its place.
- **The first cell of the grid is "Launch a token"**, styled as a card, linking to
  the Launch view. It is the primary action on the page a stranger lands on.
- **Sorts**: Newest (default) · Paid to holders · Yours. Drop "To collect" and
  "Volume" unless you can say in one line what a visitor does with them.
- **Filters**: keep Yours; fold Collecting and On the curve into one "Live" toggle
  or into the card badge. Four filters on a list of a dozen items is furniture.
- **The dense view stays reachable.** An auditor and a Pons employee use those six
  columns. Put them behind one toggle — "Cards / Table" — and keep the table's
  markup as it is.
- **Empty and ugly states, as always**: no launches yet; a launch whose economics
  did not answer; a launch whose fees have been redirected; a logo that fails to
  load (fall back to the ticker in the accent colour, never a broken image).

## Do not

- Do not invent a number. If you want market cap, 24 h volume or a holder count,
  say so and leave a `{{…}}` placeholder — none of those is read today.
- Do not add a chart, a sparkline or a price. We are not a price site and we have
  no price history to draw.
- Do not hide a redirected launch to keep the grid pretty. That state is the one
  the page exists to be honest about.
- Do not remove the table. Move it behind the toggle.

## Deliverable

1. One card, in three states — healthy, redirected, no wallet connected — as
   rendered HTML/CSS, before the grid.
2. Then the grid, with the "Launch a token" cell and the Cards/Table toggle.
3. The list of reads your card needs that the page does not make today.
4. Placeholders for anything you wanted and could not read.
