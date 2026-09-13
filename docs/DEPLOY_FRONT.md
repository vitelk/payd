# Front end: build, IPFS, ENS

**Two pages, one ENS name, one CID.** The shop window is the root of the
published tree and the app sits under `app/`:

| Path | Source | What it is |
| :--- | :--- | :--- |
| `paydprotocol.eth` | `site/index.html` | the shop window: what the project does, in plain words. One HTML file, no build, no JS at all. |
| `paydprotocol.eth`, until the deployment | `scripts/prelaunch.sh site/index.html` | **the same page, derived** — not a second one. It adds the banner that says nothing is deployed, turns the six contract rows from `{{REGISTRY}}` into `not deployed` with a `pending` badge instead of `verified`, and drops `?registry=` from the three call-to-action links. A hand-written second page drifts, and the copy that drifts is the one nobody is looking at. |
| `paydprotocol.eth/app` | `front/dist/` | the app: reads the chain, connects a wallet, claims. Three views (app, protocol stats, docs). |
| `paydprotocol.eth/app`, until the deployment | `soon/` | one file, no build, no JS: says the app goes live with the contracts, and that no address circulating before the launch post is ours. **Before the deployment the app must NOT be what is published there** — it would load and read a zero address. |

| `paydprotocol.eth/sdk/payd.js` | `sdk/dist/` | the embeddable card, the file the shop window tells creators to `<script src>`. |

They stay two pages for a real reason: a visitor who only wants to understand
should not download 114 KB of JS and a wallet connector.

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
pnpm --filter @payd/sdk build             # -> sdk/dist/payd.js

rm -rf public && mkdir -p public/app public/sdk
cp site/logo.svg site/og.png public/
scripts/prelaunch.sh site/index.html > public/index.html   # before the deployment
cp site/index.html public/index.html                       # after it
cp -R soon/. public/app/                  # before the deployment
cp -R front/dist/. public/app/            # after it
cp sdk/dist/payd.js public/sdk/payd.js    # the shop window prints this URL

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
pnpm --filter front test          # CID reconstruction + Merkle tree identical to OZ
pnpm --filter @payd/sdk build     # -> sdk/dist/payd.js  (the embeddable card)
                                  # site/ has no build step: publish the folder as-is
```

Output: `index.html` plus a single JS file — **114 KB gzip**, measured
2026-09-09. Two files, one CID to pin.

The SDK bundle is part of the tree too, because the shop window prints its URL
(`https://paydprotocol.eth.limo/sdk/payd.js`) and a page that gives an address which
404s is worse than a page that gives none. It is **109 KB gzip**, viem bundled
on purpose: the promise is a `<script>` tag with no install step.

**Weight is a criterion, not an affectation.** Two rules follow from it:

- **No request to a third party.** No remote font, no analytics, no CDN: the page
  only issues calls to the RPC and to the IPFS gateways the user can see in the
  URL. A Google font means every visitor announced to a third party from a page
  that claims to depend on nobody.
- **No library for what viem already does.** `@openzeppelin/merkle-tree` weighed
  +42 KB gzip; the tree is therefore rebuilt in `src/merkle.ts` with viem's
  keccak, and `src/merkle.test.ts` compares root AND proofs against the real
  library — the one that produces the root committed on-chain — from 1 to 200
  leaves. It stays a **test** dependency, never part of the bundle.

The app has three views (app, protocol stats, docs) with no router and no dynamic
import: one JS file, so one CID, and nothing that could fail depending on the
gateway. The views are selected by the hash — `#app`, `#stats`, `#docs` — which
is what lets the shop window link straight into the docs.

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
