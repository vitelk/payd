# Front end: build, IPFS, ENS

**Two pages, one ENS name, one CID.** The shop window is the root of the
published tree and the app sits under `app/`:

| Path | Source | What it is |
| :--- | :--- | :--- |
| `paydprotocol.eth` | `site/index.html` + `site/ticker.js` | the shop window: what the project does, in plain words. One hand-written HTML file, plus **one deferred read-only module** since 2026-09-14 — see below. |
| `paydprotocol.eth`, until the deployment | `scripts/prelaunch.sh site/index.html` | **the same page, derived** — not a second one. It adds the banner that says nothing is deployed, turns the six contract rows from `{{REGISTRY}}` into `not deployed` with a `pending` badge instead of `verified`, and drops `?registry=` from the three call-to-action links. A hand-written second page drifts, and the copy that drifts is the one nobody is looking at. |
| `paydprotocol.eth/app` | `front/dist/` | the app: reads the chain, connects a wallet, claims. Three views (app, protocol stats, docs). |
| `paydprotocol.eth/app`, until the deployment | `soon/` | one file, no build, no JS: says the app goes live with the contracts, and that no address circulating before the launch post is ours. **Before the deployment the app must NOT be what is published there** — it would load and read a zero address. |

| `paydprotocol.eth/sdk/payd.js` | `sdk/dist/` | the embeddable card, the file the shop window tells creators to `<script src>`. |

They stay two pages for a real reason: a visitor who only wants to understand
should not download a wallet connector, a router and six views.

**The shop window is no longer JS-free, and that was a deliberate trade.** It
carries `ticker.js` — 99 KB gzipped, `type="module"` so it never blocks the
render, built by `pnpm --filter front build:ticker` from the app's own tested
modules (`metrics.ts`, `yield.ts`, `v4.ts`). It reads four numbers and writes
them into four spans. It signs nothing, connects to no wallet, and asks for
nothing.

Two things keep the trade honest, and both have to stay true of any change here:

- **the four spans already contain a value in the HTML.** They are the figures
  measured at the last publication, and `#pd-since` says so in words. With no
  script, no network, or a gateway that serves the HTML and not the module, the
  page still reads correctly and still says when it was measured — it is never
  four empty boxes, and it never claims to be live when it is not;
- **the numbers are not computed here.** A second copy of the pricing would
  drift, and two pages of ours quoting different yields for the same vault in
  the same minute is worse than neither quoting one. `front/src/metrics.ts`
  exists precisely so the app and the shop window share the read.

The cost is real: the shop window went from 51 KB of HTML to 51 KB plus 99 KB of
deferred JS. It buys the only sentence on that page a visitor can act on — what
holding the token has actually paid — which was previously nowhere on it.

**A subdomain was the obvious shape, and it does not work.** `app.paydprotocol.eth`
resolves fine for a browser that speaks ENS, but everyone else goes through
`app.paydprotocol.eth.limo` — and a TLS wildcard certificate covers exactly ONE
label. `*.eth.limo` matches `paydprotocol.eth.limo` and cannot match
`app.paydprotocol.eth.limo`, which therefore fails the handshake before any content
is served. Measured 2026-09-05, three attempts over a minute:
`tlsv1 alert internal error`, while the on-chain `contenthash` was correct and
verified. A path costs one thing in exchange — the two pages now share a CID, so
publishing a new app version republishes the tree and takes a `setContenthash`
on the main name. That is the price of being reachable.

## Assembling the tree

```
pnpm --filter front build                 # -> front/dist/
pnpm --filter front build:ticker          # -> site/ticker.js, the shop window's
pnpm --filter @paydprotocol/sdk build             # -> sdk/dist/payd.js

rm -rf public && mkdir -p public/app public/sdk
cp site/logo.svg site/og-v2.png site/ticker.js public/
cp site/og-v2.png public/og.png           # old URL keeps serving — X re-scrapes old tweets by it
scripts/prelaunch.sh site/index.html > public/index.html   # before the deployment
cp site/index.html public/index.html                       # after it
cp -R soon/. public/app/                  # before the deployment
cp -R front/dist/. public/app/            # after it
cp sdk/dist/payd.js public/sdk/payd.js    # the shop window prints this URL
cp site/llms.txt public/llms.txt          # how agents find the protocol; it links the two below
mkdir -p public/docs
cp docs/SDK.md public/docs/sdk.md
cp docs/HOW_IT_WORKS.md public/docs/how-it-works.md

pnpm --filter offchain publish:site "$PWD/public"
```

**`public/sdk/payd.js` is not optional.** The shop window's SDK section shows
`https://paydprotocol.eth.limo/sdk/payd.js` as the one line a creator pastes into
their own page. Publishing a tree without it puts a dead URL in front of every
reader of that section — and it is the section asking them to depend on us.

**The path has to be absolute.** `pnpm --filter offchain` runs the script with
`offchain/` as its working directory, so a bare `public` is looked for at
`offchain/public` and the run dies on `ENOENT: scandir 'public'` before it
touches the network.

`public/` is assembled, never edited and never committed. `publish:site` walks
the tree, sends kubo the directory parts it needs, and reads back **every**
`index.html` it published — a root that loads while `app/` 404s is the exact
failure this layout introduces, and it is invisible from the root alone.

## Build

```
pnpm --filter front build         # -> front/dist/      (the app)
pnpm --filter front build:ticker  # -> site/ticker.js    (the shop window's numbers)
pnpm --filter front test          # CID reconstruction + Merkle tree identical to OZ
pnpm --filter @paydprotocol/sdk build     # -> sdk/dist/payd.js  (the embeddable card)
```

**`site/` used to have no build step and this line used to say so.** It has one
since 2026-09-14 — `build:ticker` — and forgetting it publishes a shop window
whose four figures are whatever the last build left in `site/ticker.js`, or a
404 on a page that looks fine. It is generated into a hand-written directory and
is gitignored for that reason.

Measured 2026-09-28, what the build actually printed (the three payout modes'
screens included, the wallet picker, the redesigned shell and Tokens index, the
cumulative distribution line and the price-chart disclosure):

| | raw | gzip |
| :--- | ---: | ---: |
| `app/index.html` | 114 317 | 32 153 |
| `app/assets/index-*.js` (the entry `index.html` names) | 479 461 | 148 977 |
| `app/assets/*` (62 lazy chunks, WalletConnect) | 1 555 066 | 429 066 |
| `index.html` (shop window) | 59 783 | 18 377 |
| `ticker.js` | 379 828 | 99 303 |
| `sdk/payd.js` | 415 096 | 108 694 |

Against 2026-09-19 the page a default visitor pays for is **+9.9 KB gzip** on
the entry and **+3.6 KB** on the HTML, which is the front redesign and not one
feature; the lazy chunks went from 61 to 62 and cost that visitor nothing. The
previous reading is kept here as a row of history in git, not in the table: two
tables one under the other is how a reader ends up comparing a gzip of ours
with a gzip of Vite's.

The app's figure read **114 KB gzip** here for months against a build printing
118. Record what the build prints, not what the change was meant to cost.

**The second row is the one to read, and the third is the one not to add to
it.** WalletConnect is 3.4x the weight of the entire app, in 61 chunks behind
the `import()` in `chain.ts` — none of it fetched unless the visitor opens the
Connect menu and picks that row. Inlined into the single bundle the way
everything else here is, it took the entry from 434 kB to 1 996 kB (132 kB gzip
to 554 kB), which is what decided the split. `vite.config.ts` carries the
reasoning; the rule it bends — one file, one CID, nothing that can 404 on a
gateway — still governs everything else in the build, and the ticker below is
built under it untouched.

**What the default visit actually pays is +6.8 KB gzip** — 132 272 before all
this, 139 041 now — and neither half of it is the library. The control is the
same split build with the dynamic import pointed at a local module instead, so
it carries the picker, the Disconnect row and the split, and no WalletConnect
anywhere: **441 382 / 134 941**. Which gives **+2.7 KB gzip** for EIP-6963, the
menu, disconnecting, and the cost of the entry no longer being one inlined file
(`__vitePreload`, the module boundaries), and **+4.1 KB** for what importing
the real package leaves in the entry even when nothing calls it. No polyfill
rides along eagerly — `Buffer`, `process.env` and `global=` appear nowhere in
the entry, which was the thing worth checking.

All the gzip figures on this page are `gzip -9`. Vite prints its own, a few
hundred bytes apart on the same file; comparing one against the other is how a
change appears to cost something it did not.

`site/ticker.js` imports `chain.ts` too, and carries **none** of this:
`walletConnect()` is unreachable from `ticker.ts`, so rollup drops the function
and the `import()` with it. Measured 2026-09-20 — 379 742 bytes, no
`@walletconnect/`, no `EthereumProvider`. (`WC_PROJECT_ID` itself does survive,
70 bytes of it: its initializer calls `URLSearchParams.get`, which rollup
cannot prove pure. Harmless, and not worth a constant folded by hand.)

**That is a property of the import graph, not a guarantee**, so
`pnpm build:ticker` now ends in `front/check-ticker.mjs`: no wallet library by
name, and a size bound. This was written first as "run `git status site/` after
building" — which is worth **nothing**, because `site/ticker.js` is gitignored
(`.gitignore:109`) and that command is silent whatever the file holds. A check
that cannot fail is worse than no check: it is the reason nobody looks.

The SDK bundle is part of the tree too, because the shop window prints its URL
(`https://paydprotocol.eth.limo/sdk/payd.js`) and a page that gives an address which
404s is worse than a page that gives none. It is **109 KB gzip**, viem bundled
on purpose: the promise is a `<script>` tag with no install step.

**Weight is a criterion, not an affectation.** Two rules follow from it:

- **No request to a third party, with ONE named exception the visitor chooses.**
  No remote font, no analytics, no CDN: the page only issues calls to the RPC and
  to the IPFS gateways the user can see in the URL. A Google font means every
  visitor announced to a third party from a page that claims to depend on nobody.
  The exception is WalletConnect: picking that row of the Connect menu opens a
  socket to `relay.walletconnect.org`, under a project id registered on a
  dashboard. It is a deliberate trade for the phone browsers injection cannot
  reach, it is never on the default path, and `WC_PROJECT_ID` empty in
  `front/src/config.ts` removes the row — and with it every trace of the
  exception — without touching anything else.
- **No library for what viem already does.** `@openzeppelin/merkle-tree` weighed
  +42 KB gzip; the tree is therefore rebuilt in `src/merkle.ts` with viem's
  keccak, and `src/merkle.test.ts` compares root AND proofs against the real
  library — the one that produces the root committed on-chain — from 1 to 200
  leaves. It stays a **test** dependency, never part of the bundle.

The app has three views (app, protocol stats, docs) with no router: one JS file
for the whole app, so nothing in the page's own path can fail depending on the
gateway. The views are selected by the hash — `#app`, `#stats`, `#docs` — which
is what lets the shop window link straight into the docs. The one dynamic
import is WalletConnect's, above: a failure there is one row of a menu that
does not open, not a page that does not load.

**`base: "./"` in `vite.config.ts` is not cosmetic**: on a gateway the page is
served from `/ipfs/<cid>/`, so the slightest absolute path breaks. Check after
building:

```
grep -o 'src="[^"]*"' front/dist/index.html      # must print ./assets/...
```

## Addresses

They live in `front/src/config.ts` and can be overridden through the query
string, which lets you test a deployment without rebuilding:

```
?distributor=0x…&vault=0x…&rpc=https://…&data=https://a.gateway/ipfs/
```

For the published version, fill in the constants and rebuild — a URL with
parameters is not an address you hand out.

## Publishing to IPFS

```
ipfs add -r --cid-version=1 site          # -> CID of the shop window
ipfs add -r --cid-version=1 front/dist    # -> CID of the app
```

Pin each directory's CID with at least two providers. A single pinning point is a
single point of failure, and the content disappears silently.

**The read-back is weaker than it looks, and it got weaker on its own.**
`publish-site.ts` defaults `IPFS_GATEWAYS` to `ipfs.io` and `dweb.link`, and
measured 2026-09-28 **both answer `429` to any path-style request** — not a rate
limit, a migration notice: *"This IPFS gateway is switching to a service worker
gateway only."* They answer it for the CID that is live on the ENS name too, so
it says nothing about the content. `.env` here adds
`https://ipfs.filebase.io/ipfs/`, which is the only reason the check passes —
and Filebase is the pinning provider, so the read-back is now the provider
confirming its own write. Confirming a release on a gateway that is NOT the one
that stored it is a separate step, and today it has to be done by hand.

**Do not smoke-test the APP on `ipfs.filebase.io`.** That gateway serves
`Content-Security-Policy: default-src 'self'`, which blocks the inline theme
script in `<head>` AND every `fetch` to the RPC: the page renders and reads
nothing, which looks exactly like a broken build. `eth.limo` — the address
everyone actually uses — sends only `frame-ancestors 'self'`, and the app works
there. Measured on both, 2026-09-28.

## ENS

`paydprotocol.eth` carries the whole tree's CID in its `contenthash`. One record,
one mainnet transaction per release — and three signatures, since the name is
held by the 3-of-3 mainnet Safe.

`site/index.html` links to the app with a **relative** `app/`, which is why the
page no longer carries any script: a relative path is already correct under
`ipfs://`, behind a gateway, and on an ENS-native browser. The four lines that
used to rewrite the href for ENS visitors existed only because the target was an
absolute subdomain URL.

**Always publish two addresses, never one.** An ENS name is not a URL, and most
people cannot open one:

| Form | Who it works for |
| :--- | :--- |
| `paydprotocol.eth`, `paydprotocol.eth/app` | Brave, MetaMask's browser, ENS-aware wallets — resolves natively |
| `https://paydprotocol.eth.limo`, `https://paydprotocol.eth.limo/app/` | every normal browser, through the ENS→IPFS gateway |

The bare `.eth` is the real address and the one to say out loud; on its own it is
a dead link for most visitors. `.eth.link` is the fallback gateway if `.eth.limo`
is down. Anywhere the site is linked — README, the front-end footer, the Pons
launch form, X — both forms go together.

**Every front-end update is a new CID**, hence an ENS transaction — on the name
whose content changed, and on that one only. That is not a
drawback: it makes the version history public and verifiable — anyone can compare
the announced CID with the one the name resolves to.

Two things to watch:

- **ENS names expire.** A lapsed name points the claim interface nowhere. Register
  for several years at once rather than trusting a renewal reminder.
- The gateways are third parties. They cannot forge anything — the page checks
  every epoch artifact against the on-chain digest — but they can go down, which
  is why the ENS name and a second gateway both matter.

## What the page verifies, and what it does not

**It verifies the integrity of the epoch data.** The contract publishes
`sha256(canonical json)`. The page fetches the JSON through a gateway, recomputes
its sha256 and compares it with the on-chain hash. A hostile gateway can
therefore only make the page unusable — never falsify an amount or an address.

The address is a separate question from the hash, and they used to be conflated.
The front reads the artifact's CID from the `RootPublished` log, where the keeper
puts the address its IPFS node actually reported. `cidFromSha256` survives as a
fallback: while an epoch fits in one IPFS block (< 256 KB) the sha256 IS the raw
CIDv1, but past that — around 160 holders, measured — IPFS chunks the file and
the derived address stops existing. Verification by hash stays valid whatever
the provenance, `?data=` included.

**It does not verify the computation.** Replaying the transfer history in a
browser would be slow and brittle. The full verification — an independent
recomputation of the roots — is `dispute.ts`, which runs read-only with no key at
all:

```
DISTRIBUTOR=0x… FEE_VAULT=0x… pnpm --filter offchain dispute <rootId>
```

That distinction is what to explain to users, rather than letting them believe
the page "verifies everything".
