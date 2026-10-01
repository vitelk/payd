# Design brief — the shop window (`site/index.html`)

Published at `paydprotocol.eth` (and `https://paydprotocol.eth.limo` for browsers
without ENS). The app has its own brief: [DESIGN_BRIEF_APP.md](./DESIGN_BRIEF_APP.md).
Read this one first — same product, same brand, different medium.

**Sources, in order of authority.** [`BRAND.md`](../BRAND.md) is the only source
of truth for colour, the wordmark and the two greens; where this file repeats it,
`BRAND.md` wins. `Payd Redesign.pdf` at the repository root is a mockup — it is
**untracked**, so it may not be in your checkout, and its copy is in **French**:
take its layout intent, never its words. Everything that reaches this repository
is in English, including anything meant to be temporary.

## What Payd actually is, and the tension you have to resolve

Payd is NOT a launchpad. Pons v2 (on Robinhood Chain, an Arbitrum Orbit L2) is
the launchpad. Payd is what a creator points their Pons creator fees at: a pair
of contracts, cloned per token, that turn those fees into tokenised equities —
NVDA, QQQ, GLD — and pay them out to the token's holders. No staking, no
sign-up, nothing to approve.

So we are a plugin. But the job a creator hires us for is "launch my token", and
today's site makes them read an engineering paper first. **The site must feel
like a launchpad — one obvious thing to do, on the first screen — while never
once claiming to be one.** That sentence is the whole brief. A candidate line,
not a mandate: "Pons launches your token. Payd pays your holders."

## The reader

A creator about to launch a memecoin, on a phone, who has seen ten launchpads
this week and trusts none of them. They want to know, in this order:

1. what their holders get, in one sentence;
2. what it costs them and what they keep;
3. how long it takes and how many signatures;
4. only then: why they should believe any of it.

A second reader exists — an auditor, a Pons employee, a journalist — and today's
site is built entirely for them. Keep everything they need. Move it below.

## What exists today

`site/index.html` — ONE static HTML file, 694 lines, no build step, no framework,
no backend, published to IPFS behind an ENS name. Ten sections in this order:

> A fee plugin · The money · The cycle · The contracts · The payout ·
> On your own site · The engineering · The trust surface · Verify don't trust ·
> Hold the token

It is accurate, dense, and reads as a defence. Section 1 is called "A fee
plugin". There is no primary call to action above the fold.

The app at `paydprotocol.eth/app` is a separate one-page build with six tabs
(Tokens · $PAYD · Stats · Treasury · Launch · Docs). **Do not redesign it here.**
But the site's primary CTA hands off to its Launch screen, and the two must look
like one product.

## What the new site has to do

1. **One primary action, above the fold, on a phone**: launch a token.
   Everything else is secondary.
2. **The holder's promise in one sentence**, understandable by someone who has
   never used a launchpad.
3. **The creator's economics as a picture, not a table.** Of what a token
   collects: at least 50 % to holders (the creator sets it), the platform takes a
   rate stamped at launch (capped at 15 %), the rest is the creator's.
4. **The launch, honestly sized.** With MetaMask on this chain it is now ONE
   transaction and one signature (measured 2026-09-27: the chain supports
   EIP-7702 and MetaMask reports atomic batching — `docs/recon.md` §15). With any
   other wallet it is three signatures from the same page. Show one number, with
   the fallback in small type — not two equal paths.
5. **Five payout modes as a choice the creator makes**, each in one line:
   - **Distribution** — the fees buy a basket of stocks, every holder's share is
     theirs to collect.
   - **Tontine** — same, plus part of the token burnt or locked as liquidity, the
     rest shared between the holders who stayed.
   - **Backing** — the pot stays in the contract: burn your tokens to take your
     share.
   - **Lottery** — each draw pays one holder, from a public randomness beacon
     nobody here controls. Holding longer buys more tickets.
   - **Portfolio** — the fees become dollars and each holder picks their own
     stocks.
6. **Proof, below the fold, and shorter.** Eight contracts, no owner in any of
   them. One key can publish a payout root and nothing else. A 48-hour timelock
   with open execution. Every address on the explorer. This is our strongest
   material against a chain that has already seen a rug (StockBoundRH) — it earns
   real space, just not the first screen.
7. **The embed**, two lines of HTML, kept: `<payd-token token="0x…">` next to a
   script tag. It is the one thing that makes a creator's own site better. Say in
   one line that the older `<payd-vault vault="0x…">` still works and always
   will.

## Brand — fixed, do not reinterpret

- Wordmark: "Payd" bold sans, then "PROTOCOL" letterspaced mono, in the acid
  green. One wordmark, two words, two cuts.
- Dark: background `#14130f`, ink `#eeebe3`, muted `#97917f`, line `#2c2a24`,
  accent `#ccff00`.
- Light: background `#faf8f4`, ink `#191712`, muted `#6d685c`, line `#efeade`,
  accent `#4a6300`.
- **The two greens are not interchangeable.** `#ccff00` at small sizes on cream
  is unreadable; that is why light takes `#4a6300`.
- Both themes must work. Dark is the default.

## Hard constraints

- **One static HTML file.** Inline CSS, inline SVG, no build step, no framework,
  no bundler, no backend, no analytics, no web fonts from a CDN unless they
  degrade cleanly. It is served from IPFS: every path relative, nothing that
  assumes a server.
- **Phone first.** 16 px side gutter, no horizontal scroll, tap targets ≥ 44 px.
- **Invent no numbers.** Every figure on the page today is either measured
  on-chain or hand-baked and re-measured before each publish. Where you want a
  metric, leave `{{TVL}}`-style placeholders and list them at the end with what
  each one means. A made-up number on this page is the one failure that costs us
  the reader we are trying to win.
- **Keep every contract address and explorer link** that exists today, verbatim.
- **English only.**
- Say "token", "launch", "payout" — never "vault" — EXCEPT where the sentence
  names the contract, which is `FeeVault` and stays `FeeVault`. The contracts are
  deployed and verified; a page that calls them something the chain does not is
  worse than the word "vault".
- Accessibility: real headings in order, visible focus rings, contrast ≥ 4.5:1
  for body text in both themes.

## What not to do

- Do not call Payd a launchpad, a DEX, a protocol for "yield", or an investment
  product. The fees buy tokenised equities; that is a mechanism, not a promise of
  return.
- Do not delete the trust material. Reorder and compress it.
- Do not add a waitlist, an email capture, a Discord gate, or a countdown.
- Do not use stock photography, 3D renders, or gradient meshes. The existing
  page's monospace diagrams are an asset — keep that register.

## Deliverable

1. A section-by-section outline with the new order and one line on why each
   section earns its place, **before** any code.
2. Then the single HTML file.
3. A short list of what you cut and where it went.
4. The placeholder list from "Invent no numbers".
