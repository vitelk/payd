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
export const DISTRIBUTOR = (q.get("distributor") ?? "0xe765f074650b83d95E09A22F0B87A992792705fb") as `0x${string}`;
export const FEE_VAULT = (q.get("vault") ?? "0x4DBA57f2E1b9AFE02cA091916F98dd7B4A248A64") as `0x${string}`;

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
