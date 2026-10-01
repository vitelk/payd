/**
 * Front-end configuration.
 *
 * No key, no secret: this page is entirely static and only reads the chain.
 * Values can be overridden through the query string, which lets you test a
 * deployment without rebuilding:
 *   ?distributor=0x…&vault=0x…&data=https://…
 */
/**
 * Branding placeholders. Fill these in once, before publishing the front end.
 * Every user-visible name and link on the page reads from here.
 *
 * The token's on-chain symbol is read from the chain and always wins over
 * `TOKEN_TICKER` — this constant is only the fallback shown before the first
 * RPC response lands.
 *
 * The project and the token carry the same full name, **Payd Protocol**, and
 * only the ticker is short. `TOKEN_NAME` is an ERC-20 constructor argument, so
 * it is frozen at the launch transaction — this constant describes what was
 * passed, it does not decide it. See BRAND.md.
 */
export const PROJECT_NAME = "Payd Protocol";
export const TOKEN_NAME = "Payd Protocol";
export const TOKEN_TICKER = "PAYD";
/** ONE ENS name, one contenthash, one tree: the shop window at the root and
 *  this app under `/app`. A subdomain was the obvious shape and it does not
 *  work — a TLS wildcard covers one label, so `app.paydprotocol.eth.limo` has no
 *  certificate and fails for every browser that does not speak ENS natively.
 *  Two forms, both needed: ENS-aware clients resolve the name itself,
 *  everything else needs the .eth.limo gateway. See docs/DEPLOY_FRONT.md. */
export const WEBSITE_ENS = "paydprotocol.eth";
export const WEBSITE_URL = "https://paydprotocol.eth.limo";
export const APP_ENS = "paydprotocol.eth/app";
export const APP_URL = "https://paydprotocol.eth.limo/app/";
export const X_URL = "https://x.com/PaydRH";
/**
 * Where a reader buys the token, one path segment plus its address.
 *
 * A LINK and not a request: the page still issues nothing to a third party, and
 * the address it points at is the one the vault itself reported. Read off Pons's
 * own launchpad and checked against the live token on 2026-09-18 —
 * `/launchpad/0xc8D259fB…` answers 200 and names both PAYD and the address.
 */
export const PONS_TOKEN_URL = "https://www.ponsfamily.com/launchpad/";

/**
 * The other places a reader can look the token up, in the order they are shown.
 *
 * **Links, never requests.** The page still issues nothing to a third party, so
 * it also cannot ASK whether one of these indexes a given token — a link here
 * is shown always or never, and has to be right before it is placed. These
 * three were opened on the live $PAYD token and reported working; an automated
 * check cannot confirm them, because all three answer a script with `403`
 * whatever the URL, which is anti-bot filtering and not an answer about the
 * chain.
 *
 * **Lowercase, as they were given.** Pons was verified with the checksummed
 * form and keeps it; these were verified lowercase and keep that. Neither is
 * worth "tidying" into the other on a guess about what a third party parses.
 */
export const TOKEN_ELSEWHERE: { name: string; url: (token: string) => string }[] = [
  { name: "gmgn", url: (t) => `https://gmgn.ai/robinhood/token/${t.toLowerCase()}` },
  { name: "fomo", url: (t) => `https://fomo.family/tokens/robinhood/${t.toLowerCase()}` },
  { name: "axiom", url: (t) => `https://axiom.trade/token/${t.toLowerCase()}?chain=robinhood` },
];

const q = new URLSearchParams(location.search);

/** Not deployed / not configured. Every address below reads as absent at zero. */
const ZERO = "0x0000000000000000000000000000000000000000";

export const RPC_URL = q.get("rpc") ?? "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
/**
 * ONE launch's pair, for the page that shows a single vault.
 *
 * Zero until deployment, like every other address here, and `main.ts` says so in
 * words rather than reading it: "Addresses not configured — pass
 * ?distributor=0x…&vault=0x…".
 *
 * **They used to default to Payd V1's pair, and that was worse than empty.** V1
 * is live and its ABI is not V2's — it answers `token()` and `DISTRIBUTOR()` and
 * reverts on `economics()`, `hookStatus()` and the rest — so a visitor arriving
 * with no override got a page that filled in, degraded politely
 * (`front/src/num.ts`) and showed a real epoch counter belonging to **another
 * system**. A page that says nothing is checkable; a page that says something
 * true about the wrong contract is not. Filled on launch night,
 * `docs/LAUNCH_NIGHT.md` §7.
 */
/**
 * **$PAYD's own pair, and the default of the two below.**
 *
 * Separated from `FEE_VAULT` because the tab named "$PAYD" has to mean that
 * launch and no other. `?token=` points the launch VIEW at any launch in
 * the registry — that is how the list opens one — and the tab then named the
 * platform's token over somebody else's page. The comparison needs both values,
 * so the default cannot only exist inside the `??`.
 */
export const OWN_VAULT = "0x4DBA57f2E1b9AFE02cA091916F98dd7B4A248A64" as `0x${string}`;
export const OWN_DISTRIBUTOR = "0xe765f074650b83d95E09A22F0B87A992792705fb" as `0x${string}`;

export const DISTRIBUTOR = (q.get("distributor") ?? OWN_DISTRIBUTOR) as `0x${string}`;
/**
 * The launch this page is looking at.
 *
 * **`?token=` first, `?vault=` for ever after it.** The app writes `?token=`
 * now — the word "vault" was ours and never the reader's — but the old key is
 * read with exactly the same authority, and there is no plan to stop. It is in
 * links people have already shared, in the embed snippet on `site/index.html`
 * and in the SDK's README; a query key that stops working is a holder who
 * cannot reach their claim, which is the one failure this app cannot have.
 *
 * Both name the same thing, a `FeeVault` address, because the contracts did not
 * get renamed and must not be: they are deployed, verified, and are what
 * `FLOWS.md` and the explorer show a third party.
 */
export const FEE_VAULT = (q.get("token") ?? q.get("vault") ?? OWN_VAULT) as `0x${string}`;

/**
 * The block `Payd` was deployed in, and the floor every log scan starts from.
 *
 * **It exists because `eth_getLogs` is capped at 10 000 blocks** (`chain.ts`,
 * `LOG_SPAN`): a scan needs a bottom and `fromBlock: 0n` is not one — the node
 * refuses the range outright. This is the only number that can replace it, and
 * a wrong one silently truncates the allowlist rather than failing.
 *
 * **Read on-chain, not assumed**: binary search on `eth_getCode` against the
 * ARCHIVE endpoint, 2026-09-15. The public node prunes state and answers `0x`
 * for any block past its horizon, which puts the same search on the pruning
 * boundary — it returned a block eleven minutes old for a contract deployed on
 * 2026-09-12.
 *
 * `DeployPayd.s.sol` builds the whole platform in ONE transaction, so all 86
 * listing events of the launch allowlist sit in this single block; everything
 * scanned after it is the timelock's later changes, of which there are none
 * yet. It moves with `?registry=`, which is why it reads from the query string
 * too — a different registry has a different birth and the cache is keyed on
 * both.
 */
export const PAYD_BLOCK = BigInt(q.get("padblock") ?? 61_344_426);

/**
 * The registry, and the Treasury it names.
 *
 * The published build had NO entry point to the registry at all: both views
 * existed but only opened on `?registry=` / `?treasury=`, so a visitor arriving
 * at `/app/` landed on one hard-coded launch and there was no way, from the
 * app, to reach the list of the others.
 *
 * Zero until deployment, and zero behaves exactly as before — the single-vault
 * page stays the default. Once `REGISTRY` is filled the app opens on the LIST,
 * and a launch's page is reached from it: the reverse of today, and the right
 * way round for a platform with more than one token. An explicit `?vault=`
 * still wins over both, which is what makes a link to one launch keep working.
 *
 * `TREASURY` is a convenience, not a source: `Payd.PLATFORM()` is the truth and
 * `renderTreasury` reads it from the registry when this is zero.
 */
export const REGISTRY = (q.get("registry") ?? "0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03") as `0x${string}`;

/**
 * **Distribution V3's factory — the one a vault must be built through.**
 *
 * It seeds the Pons locker into every Distributor's exclusion log at epoch 0,
 * and a vault is immutable once built: one created through the previous default
 * carries the per-vault `setExcluded` ritual and its 48 h window for its whole
 * life. So both faces of the site refuse to send anybody to a creation that
 * would build the old one, and both ask the CHAIN whether it still would —
 * `Payd.factory()`, never a date. The timelock's operation is executable by
 * anyone from 2026-09-17 21:01:26 UTC, which is not the same thing as executed,
 * and a clock would open the door on a registry that had not moved.
 *
 * Here rather than in `create.ts` because the shop window asks the same
 * question (`ticker.ts`) and two copies of an address are two addresses.
 */
export const DISTRIBUTION_FACTORY_V3 = "0x4C1c21285d79e036AeFC8e609D7aBf06DA88d70C" as `0x${string}`;

/**
 * **The factories the create screen ASKS the registry about by name.**
 *
 * `Payd` has no array of them — a factory is discovered from `FactoryEnabled`,
 * and that walk starts at the registry's deployment block and moves FORWARD.
 * It cannot reach the newest events any more: measured 2026-09-24, a cold walk
 * covered 216 k blocks before the node throttled it, while the head moves
 * ~864 k blocks a day at the chain's 0.1 s. The cursor in `localStorage`
 * resumes, but it resumes into a head that has run further away — so a mode
 * enabled today was invisible in the picker however many times you reloaded,
 * and tontine, backing and lottery had been invisible since 2026-09-18.
 *
 * So the list below is the CANDIDATES, and the registry is still the authority:
 * `create.ts` asks `factoryMode(address)` for each one and offers only what the
 * chain names — a disabled factory answers `bytes32(0)`, which reads as
 * `unknown` and is not offered. Six calls, no logs, before the first paint.
 * Each was read on-chain on 2026-09-24 (`cast call factoryMode`), never
 * assumed; the walk still runs beside this and adds anything enabled after this
 * build shipped.
 */
export const KNOWN_FACTORIES = [
  "0x4C1c21285d79e036AeFC8e609D7aBf06DA88d70C", // distribution V3 — the default
  "0x1228E61aba98260dC8b5eAf3D40A899bA766753b", // distribution V1, still enabled beside it
  "0xba92F9CF3E7e39975F3423CF980AFB3290E9D10b", // tontine
  "0x6730b49592C2401Da4B303D4BD7F0f20CB978888", // backing
  "0xd97c82f41EBA1FE49c41AAb7121034A73d2D08d9", // lottery
  "0xcAb51015Bcc6e82c6b0650592EE77eC07027E0fc", // portfolio — enabled 2026-09-24 14:31 UTC
] as const satisfies readonly `0x${string}`[];

export { LISTINGS_READ_AT, KNOWN_STOCKS, KNOWN_QUOTES } from "./listings.js";

export const TREASURY = (q.get("treasury") ?? "0x943Cb95441B26622a1c3c606E20cB60b2Dc94694") as `0x${string}`;

/**
 * The router that claims several launches in one transaction.
 *
 * Zero until it is deployed, and the page then behaves exactly as before: the
 * batch button does not show, and every launch is claimed from its own page. It
 * is a SHORTCUT, never a required step -- a Collector that is missing, broken or
 * replaced stops nobody from getting their share.
 *
 * It holds nothing and has no owner: redeploying it costs one line here.
 */
export const COLLECTOR = (q.get("collector") ?? "0xf3102FfE59DC2147bC0DF7e5b64d40E6b8Fed9f7") as `0x${string}`;

/**
 * Where to look for the epoch JSON. This is only a HINT: the fetched content is
 * checked against the on-chain hash, so a malicious gateway can only make the
 * load fail, never falsify an amount.
 *
 * The address comes from the `RootPublished` log, which carries the CID the
 * keeper's IPFS node actually reported. The raw CIDv1 rebuilt from the on-chain
 * sha256 is only a fallback: it is the real address just while the artifact
 * fits in one IPFS block, which stops around 160 holders — see `cidFromSha256`
 * and `offchain/src/publish.ts`.
 */
/**
 * Tried in order, first one that serves a matching sha256 wins.
 *
 * **Filebase first because it is OUR pinning service**: the keeper writes every
 * artifact there, so it is the one gateway that always holds the content rather
 * than having to find it.
 *
 * `ipfs.io` and `dweb.link` used to be the whole list, and that broke the app
 * for every holder on 2026-09-06. They serve a scripted `curl` fine, but a
 * request carrying an `Origin` header — which is to say EVERY browser fetch —
 * gets a 403 Cloudflare page. The app then reported, truthfully, that the epoch
 * data was unavailable from every gateway it tried. They stay at the end of the
 * list: a fallback that works some of the time is still worth having, it just
 * cannot be the only thing standing between a holder and their share.
 */
export const GATEWAYS = (
  q.get("data") ??
  "https://ipfs.filebase.io/ipfs/,https://gateway.pinata.cloud/ipfs/,https://ipfs.io/ipfs/,https://dweb.link/ipfs/"
).split(",");

export const EXPLORER = "https://robinhoodchain.blockscout.com";

/**
 * The addresses the YIELD panel prices against, and the ones it refuses to
 * count. Read on-chain and dated in `docs/recon.md`; `offchain/src/config.ts`
 * holds the same four for the keeper, which is a second copy and a deliberate
 * one — the front is a separate package with no build step in common, and a
 * shared module for four constants would be a package to publish.
 * `yield.test.ts` pins them against that file so a drift fails a test rather
 * than quietly pricing against the wrong pool.
 */
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
/** Uniswap v4 is a singleton: after graduation the whole pool's balance sits
 *  here, which is why it is excluded from the tree and from the float. */
export const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
/** Where a burn lands — a standard ERC-20 refuses `address(0)`. */
export const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
/** The WETH/USDG tier the vault's own ETH→pivot hop uses (recon §4.1). */
export const WETH_USDG_FEE = 100;

/**
 * Pons v2, and the hook that identifies OUR pool among the ones anyone may open
 * on our token.
 *
 * The factory is `docs/recon.md` §1.1's, read on-chain and dated. The hook was
 * read off BERRY's graduation (§"The pool") and confirmed on $PAYD's own pool
 * on 2026-09-14 — a key carrying it reproduces a price the market independently
 * quoted at 7.5k, and no other key does. It is a constant because Pons deploys
 * one hook for every v2 launch, not a per-launch parameter: `getLaunchedToken`
 * returns the fee and the tick spacing and does NOT return this.
 */
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
export const PONS_V4_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const;

/**
 * WalletConnect's project id — the ONE third party this page ever talks to,
 * and only when the visitor asks for it by name.
 *
 * Injection covers every desktop extension and every wallet's in-app browser.
 * What it does not cover is a phone's own browser, where `window.ethereum`
 * is simply absent and the visitor's only way in today is to retype the URL
 * inside MetaMask. WalletConnect is the standard answer to exactly that, and
 * it costs what it costs: a relay (`relay.walletconnect.org`) sees that a
 * session was opened, and the id below is registered on a dashboard. Neither
 * is reachable from a page that nobody clicks it on — `walletOptions()` only
 * offers the row when this is non-empty, and `chain.ts` only loads the library
 * once that row is clicked.
 *
 * Public by construction: every dapp ships its id in its bundle. It is an
 * origin tag on a relay, not a credential, and there is nothing to rotate if
 * it leaks. `?wc=` overrides it, which is how a second deployment is tested
 * without rebuilding.
 *
 * It comes from `WC_PROJECT_ID` in the repository's `.env`, named one by one
 * into the bundle by `vite.config.ts` — not from `import.meta.env`, whose rule
 * is a prefix, and not from a constant here, because `.env` is gitignored and
 * this file is not. A build that cannot find it says so and ships an app with
 * one row fewer in the Connect menu; empty is a working state, and it is the
 * state every test runs in.
 *
 * `typeof` and not a plain read: under `tsx` no build replaced anything and
 * the identifier does not exist at all, which is legal to ask `typeof` about
 * and a `ReferenceError` to read.
 */
declare const __WC_PROJECT_ID__: string;
export const WC_PROJECT_ID =
  q.get("wc") ?? (typeof __WC_PROJECT_ID__ === "string" ? __WC_PROJECT_ID__ : "");
