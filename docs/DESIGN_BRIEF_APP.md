# Design brief — the app (`front/`, published at `paydprotocol.eth/app`)

Read [DESIGN_BRIEF_SITE.md](./DESIGN_BRIEF_SITE.md) first: same product, same
brand, different medium, and the two must look like one thing. Where they
disagree, the site is the shop window and this is the tool.

Sources and their authority are listed at the top of the site brief:
[`BRAND.md`](../BRAND.md) wins on colour and the wordmark, and `Payd Redesign.pdf`
(untracked, at the repository root, copy in **French**) is layout intent only —
take its shapes, never its words.

## What this is

ONE page with six tabs, not six pages: **Tokens · $PAYD · Stats · Treasury ·
Launch · Docs**. Every tab is a section of the same document, shown and hidden by
`front/src/route.ts` — which is unit-tested (`route.test.ts`), so **the set of
views and which one opens for a given URL is not yours to change**. You may
restyle, reorder visually, merge panels, and change every label. You may not add
or remove a view, or change which URL opens which.

It reads the chain directly from the visitor's browser. No server, no indexer, no
API. Everything on screen is a `view` call or a log scan, which is why some panels
arrive late and some arrive empty.

## The six views, and what each is for

- **Tokens** — the index of every launch in the registry: a table plus a rail for
  switching between them. This is the first screen for everyone who is not a
  creator. Today it is dense and reads like a block explorer.
- **$PAYD** — one launch's page, our own. The same view serves ANY launch via
  `?token=0x…`, which is how the index opens one. Holds the split, the basket,
  what is waiting to buy, what a holder is owed, and the collect button.
- **Stats** — the current payout root, stock by stock. Only exists for the
  distribution mode; hidden for the others.
- **Treasury** — the platform's four pockets and what each is for.
- **Launch** — the creation form. THE screen that matters. See below.
- **Docs** — reference, in the app so it works offline from IPFS.

> **The Tokens page has its own follow-up brief**, because this file was too
> broad to fix it: [DESIGN_BRIEF_TOKENS.md](./DESIGN_BRIEF_TOKENS.md). Read it
> before touching that view.

## The screen to get right: Launch

A creator arrives here to launch a token. The form asks for, in this order today:
a basket of 2–8 stocks with weights in percent, the holders' share, the epoch
length, the launch currency, optional burn/liquidity legs, then the token's name,
ticker, logo, description, links, creator tax, and an optional first buy.

That is a lot, and most of it has a defensible default. **Your job is to make the
default path short and the full path reachable** — not to remove fields. Every
field maps to something written into an immutable contract at birth; there is no
settings page afterwards.

Two shapes exist and the app picks between them at runtime:

- **One transaction.** With MetaMask on this chain, the three calls go out as one
  atomic batch and one signature. The form shows ONE step card, and the launch
  fields have to be filled before signing, because they all leave together.
- **Three signatures.** Any other wallet: create the payout, launch on Pons, point
  the fees at it. Three step cards, the second and third appearing as the first
  completes. There is also a handoff table for a creator who launches on Pons's
  own site instead.

Design BOTH. The one-transaction shape is the one to make beautiful; the
three-step one must not look like a punishment.

## The states you have to design, because they all happen

This is the part a mockup usually skips, and where this app actually lives:

- a visitor with no wallet connected (most of them);
- two wallet extensions installed, fighting over the injected slot;
- a wallet on the wrong network;
- a panel whose RPC read failed while its neighbours succeeded — partial, not
  broken;
- a token whose fees have been redirected away (we show it, we do not hide it);
- a launch under a payout mode this build does not know;
- a holder owed an amount below the push threshold, who must collect manually;
- zero — a token with no volume yet, which is most tokens on day one.

**You can see every one of these without a wallet**: append `?mock` to any URL,
and `?mock&vaults=20` for a fuller index. Use it. It is the fastest way to find
out what the design does when the data is ugly.

## Hard constraints

- Vite + TypeScript + viem. No UI framework, no CSS framework, no component
  library, no runtime CSS-in-JS. Styling is plain CSS inside `front/index.html`.
- **One HTML entry point, one JS bundle, one CID to pin.** The app is published to
  IPFS. Do not split it into routes or add a second page.
- The bundle is already ~460 kB plus ~550 kB for the chain libraries. Add no
  dependency; a design that needs one is the wrong design.
- **Never assign `document.body.innerHTML`.** Views render into their own host
  element. Assigning the body throws away the header, the tabs and the footer,
  which is a bug this app has already had.
- Phone first. The tabs become a bottom bar and the token switcher becomes a chip;
  both behaviours exist today and are load-bearing.
- Both themes, dark default, with the exact hexes from `BRAND.md`.
- Say "token", "launch", "payout". Never "vault" — except `FeeVault` when the
  sentence names the contract.
- Invent no numbers, and change no address.
- English only.

## What not to do

- Do not add a view, remove a view, or change which URL opens which.
- Do not turn any reading into a promise. "This token distributes stocks" is false
  if the fees have been redirected; the app re-reads the live recipient on every
  call for exactly that reason, and the design must have somewhere to put the bad
  answer.
- Do not add a loading spinner that covers a whole view. Panels fill
  independently, on purpose.
- Do not hide the collect/claim action behind a menu. It is why a holder is here.

## Deliverable

1. A one-page map: the six views, what each one's first screen says, and what
   changes on a phone. Before any code.
2. The Launch screen in both shapes, as HTML/CSS you have actually rendered.
3. One other view in full — pick Tokens or $PAYD, and say why.
4. The ugly-state list above, each with the design's answer in one line.
5. What you cut, and where it went.
