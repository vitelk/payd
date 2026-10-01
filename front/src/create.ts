/**
 * The launch form: `createVault`, from the browser.
 *
 * A section of the registry index rather than a page of its own — same reason
 * as everything else here, one HTML entry point keeps the build to one JS file
 * and one CID to pin.
 *
 * **This is step one of three, and the form says so.** Creating a vault
 * launches nothing: the creator then launches on Pons themselves with this
 * vault as `creatorFeeRecipient`, and anybody calls `bind` afterwards. A form
 * that implied otherwise would leave people waiting for fees that were never
 * pointed at them.
 */
import {
  BaseError, ContractFunctionRevertedError,
  createWalletClient, custom, encodeFunctionData, parseAbi, parseEther,
  type Address, type Hex,
} from "viem";
import { pub, chain, provider, ensureChain, symbolsOf } from "./chain.js";
import {
  APP_URL, DISTRIBUTION_FACTORY_V3, EXPLORER, GATEWAYS, KNOWN_FACTORIES, KNOWN_QUOTES,
  KNOWN_STOCKS, LISTINGS_READ_AT,
} from "./config.js";
import { checkLogo, diagnose } from "./launchlog.js";
import { connected, onViewer } from "./viewer.js";
import {
  launchOnPons, bindVault, buildLaunch, previewToken,
  factoryAbi, ponsRegistryAbi, vaultBindAbi, type LaunchInput,
} from "./pons.js";
import {
  acceptsValue, atomicOf, canBatch, oneShotCalls, predictPair, sendAtomic, waitForBatch,
} from "./atomic.js";
import {
  modeBlurb, modeDataFor, modeName, payScreen, snapLegs, snapPot, toContract, toSplit,
  type ContractSplit, type Mode,
} from "./modes.js";
import {
  validate, checks, spread, pct, bpsFromPct, MIN_BASKET, MAX_BASKET, MIN_ALLOC_BPS, BPS,
  MIN_REWARDS_BPS, holdersFloorPct, type Draft,
} from "./basket.js";

/**
 * The errors the creation path can end in, and what each one means to a
 * creator.
 *
 * **The app used to sign without asking first.** `writeContract` goes straight
 * to the wallet, so a refusal arrived as whatever that wallet chooses to say —
 * "Échec de la simulation de transaction (execution revert #-39000)" in one of
 * them — and the creator was left with four rules and no way to know which one
 * they had broken. The registry names its refusal precisely; there is no reason
 * to throw that away. Declared here because a custom error viem cannot find in
 * the ABI decodes to nothing.
 */
const CREATE_ERRORS = parseAbi([
  "error BadSplit()",
  "error BadWeights()",
  "error BadEpochLength(uint256 given)",
  "error BadModeData()",
  "error BadQuote()",
  "error StockNotAllowed(address stock)",
  "error QuoteNotAllowed(address quote)",
  "error FactoryNotEnabled(address factory)",
  "error WrongPoolFee(address stock, uint24 want, uint24 got)",
  "error WrongFeed(address stock, address want, address got)",
  "error NoLiquidityAt(address token, address against, uint24 poolFee)",
  "error RouteTooThin(address quote, uint256 depth, uint256 required)",
  "error PlatformBpsTooHigh(uint256 given, uint256 cap)",
  "error CoSignerStampFailed(address vault, address distributor)",
  "error NoPool()",
  "error LengthMismatch()",
]);

/** What to put on screen for each, in the screen's own words. `null` means the
 *  registry's name is the clearest thing anyone can say about it. */
function whyRefused(name: string, args: readonly unknown[]): string {
  const short = (a: unknown) => String(a).slice(0, 10) + "…";
  switch (name) {
    case "BadSplit":
      return "the share paid to holders is out of bounds — at least 50 %, and holders plus the "
        + "platform's fixed share can never exceed 100 %";
    case "BadWeights":
      return "the basket is refused — 2 to 8 stocks, each at least 10 %, adding up to exactly 100 %";
    case "BadEpochLength":
      return `an epoch of ${Number(args[0] ?? 0) / 60} minutes is out of bounds — between 30 minutes and 24 hours`;
    case "BadModeData":
      return "the burn and liquidity legs are refused — each is off or at least 5 %, and the two "
        + "never take more than 50 % together";
    case "StockNotAllowed":
      return `${short(args[0])} is not on the timelock's allowlist`;
    case "WrongPoolFee":
      return `${short(args[0])} is listed at another fee tier — reload, the allowlist has moved`;
    case "WrongFeed":
      return `${short(args[0])} is listed with another price feed — reload, the allowlist has moved`;
    case "QuoteNotAllowed":
    case "BadQuote":
      return "that launch currency is not listed";
    case "NoLiquidityAt":
      return `no pool for ${short(args[0])} at that fee tier`;
    case "RouteTooThin":
      return "the launch currency has too little depth to price a purchase";
    case "FactoryNotEnabled":
      return "the registry does not build through that factory";
    default:
      return `the registry refused it: ${name}`;
  }
}

const padAbi = parseAbi([
  "function platformBps() view returns (uint256)",
  "function factory() view returns (address)",
  "function factoryMode(address) view returns (bytes32)",
  "function createVaultWith(address factory, (address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken, address quote, bytes modeData) returns (address vault, address distributor)",
  "function PONS_FACTORY() view returns (address)",
  "function createVault((address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken) returns (address vault, address distributor)",
  "function createVaultQuoted((address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken, address quote) returns (address vault, address distributor)",
  // FOUR fields, not three. `wethFee` arrived with the detour route
  // (`QUOTE -> WETH -> PIVOT`) and this declaration never followed: viem then
  // decoded `wethFee` as `minBuy` and `minBuy` as `allowed`, and a bool that
  // is neither 0 nor 1 throws — so every row was skipped by the `.catch`
  // below and the selector offered nothing but native ETH.
  "function quoteListing(address) view returns (uint24 poolFee, uint24 wethFee, uint256 minBuy, bool allowed)",
  // A stock's state, live. It carries everything the event carried — the tier
  // and the feed — plus the one thing the event cannot: whether it is STILL
  // listed. That is why the screen no longer replays
  // `StockAllowed`/`StockRemoved` and reads this instead.
  "function listing(address) view returns (uint24 poolFee, address feed, bool allowed)",
]);
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * **The only factory this screen will let anybody build through.**
 *
 * Distribution V3 seeds the Pons locker into every Distributor's exclusion log
 * at epoch 0. A vault is immutable once built and only the timelock can migrate
 * one, so a vault created through the previous default would carry the
 * per-vault `setExcluded` ritual and its 48 h window for its whole life — for
 * the sake of the few hours between reading this and `setFactory` executing.
 *
 * Asked of `Payd.factory()` and not of a date: the timelock's operation is
 * executable by anyone from 2026-09-17 21:01:26 UTC, which is not the same
 * thing as executed. A clock would open the form on a registry that had not
 * moved yet, and closes it again on nothing if the Safe reschedules.
 *
 * When V3 has been the default long enough that this is only noise, delete the
 * constant and `held` with it — not the check, the whole block.
 */
const WANT_FACTORY = DISTRIBUTION_FACTORY_V3.toLowerCase();
const erc20 = parseAbi(["function symbol() view returns (string)"]);

/**
 * The allowlists, read from the registry's own mappings.
 *
 * **There is no array on-chain and there is no longer a walk either.** `Payd`
 * keeps `listing(stock)` and `quoteListing(quote)`, both mappings, so the chain
 * confirms an address and cannot enumerate the set. That set used to be
 * recovered by scanning `StockAllowed` and its four siblings forward from
 * `PAYD_BLOCK` — 1 452 windows and ~61 s to find 92 events, growing ~96
 * windows a day, and on the public RPC it never finished at all
 * (`config.ts`, `KNOWN_STOCKS`, has the measurement and why the failure
 * arrived as a CORS error).
 *
 * So the addresses are shipped, dated, and every one of them is CHECKED here
 * before it reaches the picker. `quotelist` already worked this way — the
 * events found the addresses, the mapping said their state — and `allowlist`
 * now does the same, which is what lets the event fold, its `localStorage`
 * cache, its cursor and its partial-scan warning all go: two batched rounds,
 * the same two on every visit, first one and last one alike.
 *
 * What is gained is not only speed. The fold replayed `StockAllowed` to learn a
 * tier, so a stock re-listed at a different tier was right only because the
 * last event won; the mapping IS the tier. And a delisted stock now vanishes
 * from the picker the moment it is delisted, rather than when a scan reaches
 * the block that says so.
 */
let namesMissing = 0;

/** The candidate list is a DEFAULTED PARAMETER on both readers below, not a
 *  hard reference: it is the seam `quotes.test.ts` drives them through, and the
 *  seam `pnpm --filter front listings` re-reads the chain with. A default keeps
 *  every caller in the app unchanged.
 *
 *  What a shipped candidate turned out to be. `null` = the registry does not
 *  list it (removed, or never listed under this deployment), which is a real
 *  answer and not a failure; `undefined` would be the read failing, and that is
 *  the case the caller has to tell apart. */
async function listingOf(pad: Address, stock: Address) {
  const row = await pub.readContract({
    address: pad, abi: padAbi, functionName: "listing", args: [stock],
  }).catch(() => null) as readonly [number, Address, boolean] | null;
  if (!row || !row[2]) return null;
  return { stock, poolFee: Number(row[0]), feed: row[1] };
}

export interface Listed { stock: Address; poolFee: number; feed: Address; symbol: string }

/**
 * The current allowlist: every shipped candidate the registry still confirms.
 *
 * Two batched rounds. `listing` says which are live and at what tier — one
 * `eth_call` for all 46, because they go out in one tick — then `symbolsOf`
 * names the survivors. A candidate the registry does not list is simply absent
 * from the result, which is how a delisting reaches the picker with no rebuild
 * and no scan.
 */
export async function allowlist(
  pad: Address,
  candidates: readonly Address[] = KNOWN_STOCKS,
): Promise<Listed[]> {
  const seen = [...new Set(candidates.map((a) => a.toLowerCase()))] as Address[];
  const live = (await Promise.all(seen.map((stock) => listingOf(pad, stock))))
    .filter((r) => r !== null);

  // One batched, RETRIED round for every ticker: `symbolsOf` folds them into a
  // single `eth_call` and asks again if the node refused the lot. It used to
  // catch per token and fall back to the address, so one refused batch put 46
  // addresses on screen with nothing saying why.
  const syms = await symbolsOf(live.map((r) => r.stock));
  namesMissing = syms.filter((x) => x === null).length;
  const out = live.map((r, i) => ({
    stock: r.stock,
    poolFee: r.poolFee,
    feed: r.feed,
    symbol: syms[i] ?? r.stock.slice(0, 8),
  }));
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

export interface Quoted { quote: Address; symbol: string }

/**
 * The currencies a launch can be quoted in, plus native ETH.
 *
 * The shipped list FINDS the addresses, the mapping says their state — which
 * is what this function always did, and what `allowlist` above now does too.
 * Reading `quoteListing` is exact by construction: a removed currency comes
 * back `allowed: false` with nothing to replay.
 *
 * Native ETH has no row: it is allowed by construction (`_create` only reads the
 * list for a non-zero quote) and it has neither a pool nor decimals to declare.
 * It is the form that adds it at the top.
 */
export async function quotelist(
  pad: Address,
  candidates: readonly Address[] = KNOWN_QUOTES,
): Promise<Quoted[]> {
  // De-duplicated, because the candidate list is data and a repeated address
  // would put the same currency in the selector twice. It cost nothing to keep
  // when the addresses came from a log stream where a re-listing emits a second
  // event, and it costs nothing now.
  const seen = [...new Set(candidates.map((a) => a.toLowerCase()))] as Address[];

  // Two batched rounds rather than two calls per currency: the listings first,
  // because they say which currencies are still allowed, then the symbols of
  // the survivors.
  const rows = await Promise.all(seen.map((quote) =>
    pub.readContract({ address: pad, abi: padAbi, functionName: "quoteListing", args: [quote] })
      .then((r) => ({ quote, row: r as readonly [number, number, bigint, boolean] }))
      .catch(() => ({ quote, row: null }))
  ));
  const allowed = rows.filter((r) => r.row?.[3]).map((r) => r.quote);
  const out = await Promise.all(allowed.map(async (quote) => ({
    quote,
    symbol: await pub
      .readContract({ address: quote, abi: erc20, functionName: "symbol" })
      .catch(() => quote.slice(0, 8)),
  })));
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/// Markup taken from `Payd Payd.dc.html`, styles included. The structure I had
/// lost by flattening it: TWO COLUMNS, the right one STICKY -- the split preview
/// and the conditions stay in view while the basket is filled on the left. That
/// is the whole point of the screen, and it does not survive being stacked into
/// one column.
export const FORM = `
  <style>
    /* The shell's grammar: a head, three step cards, then panels. No 1px
       outline anywhere — a surface is what separates, and the one border left
       carries a state (the step you are on, a picked stock). */
    .mk { display: flex; flex-direction: column; gap: 1.25rem; }
    .mk .hd { padding: 0; border-bottom: 0; max-width: none; }
    .mk .hd h1 { font: 600 2.25rem/1.05 var(--sans); letter-spacing: -.03em; margin: 0; }
    .mk .hd p { color: var(--mut); margin: .6rem 0 0; max-width: 34rem; text-wrap: pretty; }
    .mk .hd p.hold { margin-top: 1rem; padding: .7rem .85rem; color: var(--fg);
      background: var(--raised); border: 0; border-left: 2px solid var(--bad);
      border-radius: 0 var(--r-md) var(--r-md) 0; font-size: .875rem; max-width: none; }
    .mk .hd p.hold b { color: var(--bad); }
    /* Three steps, three columns. The margins are gone — the column's own gap
       spaces them — and an empty row disappears entirely: on hold, its margins
       left 93px of nothing between the head and the form. */
    .mk .stepcards { display: grid; grid-template-columns: repeat(3, minmax(0,1fr));
      gap: .875rem; margin: 0; }
    .mk .stepcards:empty { display: none; }
    @media (max-width: 56.25rem) { .mk .stepcards { grid-template-columns: minmax(0,1fr); } }
    .mk .stepcard { border: 0; border-radius: var(--r-lg); background: var(--surface);
      padding: .875rem 1rem; display: flex; flex-direction: column; gap: .35rem; }
    .mk .stepcard[data-now="1"] { box-shadow: inset 0 0 0 1px rgba(204,255,0,.22); }
    .mk .stepcard .top { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .mk .stepcard .tag { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .mk .stepcard[data-now="1"] .tag { color: var(--ok); }
    .mk .stepcard .who { font: .6875rem var(--mono); color: var(--dim); }
    .mk .stepcard .label { font: 500 .875rem var(--sans); }
    .mk .stepcard p { margin: 0; font-size: .78125rem; line-height: 1.5; color: var(--mut);
      text-wrap: pretty; }
    .mk .stepcard code { font: .7rem var(--mono); color: var(--dim); }

    .mk .cols { display: flex; gap: .875rem; align-items: flex-start; flex-wrap: wrap; }
    .mk .left { flex: 1 1 24rem; min-width: 0; display: flex; flex-direction: column; gap: .875rem; }
    .mk .right { flex: 1 1 18rem; min-width: 0; position: sticky; top: 3.5rem;
      display: flex; flex-direction: column; gap: .75rem; }
    .mk .box { border: 0; border-radius: var(--r-lg); background: var(--surface);
      padding: 1.25rem 1.375rem; }
    .mk .box.tall { padding: 1.25rem 1.375rem 1.375rem; }
    .mk .boxhd { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
      flex-wrap: wrap; }
    .mk .boxt { font: 500 .875rem var(--sans); }
    .mk .boxt .opt { color: var(--dim); font-weight: 400; }
    .mk .hint { font: .75rem var(--mono); color: var(--dim); margin-top: .3rem; }
    .mk button.even { font: 500 .75rem var(--sans); padding: .35rem .6rem; border: 0;
      border-radius: 6px; background: var(--raised); color: var(--mut); cursor: pointer; }
    .mk button.even:hover { color: var(--fg); background: var(--raised); }

    .mk .picks { display: grid; gap: .4rem; grid-template-columns: repeat(auto-fill, minmax(min(100%,13rem),1fr));
      margin-top: 1rem; }
    .mk .pick { display: flex; align-items: center; gap: .5rem; border: 0; background: var(--bg);
      border-radius: var(--r-sm); padding: .5rem .6rem; font-size: .875rem; cursor: pointer; }
    .mk .pick[data-on="1"] { box-shadow: inset 0 0 0 1px rgba(204,255,0,.22); }
    .mk .pick input[type=checkbox] { margin: 0; cursor: pointer; accent-color: var(--ok); }
    .mk .pick .sym { font-weight: 500; }
    .mk .pick .tier { font: .65rem var(--mono); color: var(--dim); }
    .mk .pick .w { margin-left: auto; display: flex; align-items: baseline; gap: .2rem; }
    .mk .pick .w .pc { font: .7rem var(--mono); color: var(--mut); }
    .mk .pick input[type=number] { width: 3.6rem; font: .8125rem var(--mono);
      text-align: right; background: var(--raised); color: var(--fg); border: 0;
      border-radius: 6px; padding: .25rem .35rem; }
    .mk .pick input[type=number]:disabled { color: var(--dim); }
    /* The step is 0.01 %, so the spinner nudges by a hundredth of a percent —
       forty clicks to move a weight by a point. It costs ~1rem of a box that
       now has to fit a number and a sign, and buys nothing. */
    .mk .pick input[type=number]::-webkit-inner-spin-button,
    .mk .pick input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    .mk .pick input[type=number] { -moz-appearance: textfield; appearance: textfield; }
    .mk .sumrow { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      flex-wrap: wrap; margin-top: .875rem; padding-top: .875rem; border-top: 1px solid var(--hair); }
    .mk .sumrow .a { font: .8125rem var(--mono); color: var(--mut); }
    .mk .sumrow .b { font: .75rem var(--mono); color: var(--dim); }

    .mk .badge { font: .8125rem var(--mono); color: var(--ok); }
    .mk .field { display: flex; align-items: center; gap: .75rem; margin-top: .875rem; flex-wrap: wrap; }
    /* A flex basis, and not width alone: as a flex item the field shrank to
       its content, and in the narrower column the epoch input came out 18px
       wide — a number field nobody can read or type in. It measured the same
       before this redesign; the column only made it visible. */
    .mk .field input[type=number] { flex: 0 0 6rem; width: 6rem; font: 500 1.125rem var(--mono);
      font-variant-numeric: tabular-nums; background: var(--bg); color: var(--fg);
      border: 0; border-radius: 6px; padding: .45rem .6rem; }
    .mk .field .u { font: .8125rem var(--mono); color: var(--mut); }
    .mk .field input[type=range] { flex: 1; min-width: 9rem; accent-color: var(--ok); }
    .mk .field .right { margin-left: auto; font: .75rem var(--mono); color: var(--dim); }
    .mk .box p.n { margin: .875rem 0 0; font-size: .78125rem; line-height: 1.55; color: var(--mut);
      text-wrap: pretty; }
    .mk .duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,15rem),1fr));
      gap: .75rem; }
    .mk input[type=text], .mk select { width: 100%; margin-top: .875rem; font: .8125rem var(--mono);
      background: var(--bg); color: var(--fg); border: 0; border-radius: 6px;
      padding: .45rem .55rem; }

    .mk .eyebrow { font: 500 .6875rem var(--mono); letter-spacing: .16em; text-transform: uppercase;
      color: var(--ok); }
    .mk .bars { display: flex; height: 40px; border-radius: var(--r-md); overflow: hidden;
      border: 0; margin-top: .875rem; }
    .mk .bars i { display: block; }
    .mk .mkleg { display: flex; flex-direction: column; gap: .45rem; margin-top: .875rem; }
    .mk .mkleg .r { display: flex; justify-content: space-between; gap: 1rem; font-size: .8125rem;
      align-items: baseline; }
    .mk .mkleg .r .k { display: flex; align-items: center; gap: .5rem; color: var(--mut); }
    .mk .mkleg .mkdot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    .mk .mkleg .mkv { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .mk .tot { display: flex; justify-content: space-between; gap: 1rem; font-size: .8125rem;
      margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--hair); }
    .mk .tot .k { font: 500 .6875rem var(--mono); letter-spacing: .1em; text-transform: uppercase;
      color: var(--dim); }
    .mk .tot .mkv { font: 500 .8125rem var(--mono); font-variant-numeric: tabular-nums; }

    .mk .checks { display: flex; flex-direction: column; gap: .5rem; }
    .mk .checks .r { display: flex; gap: .55rem; align-items: flex-start; font-size: .8125rem; }
    .mk .checks .mkmark { font: .6875rem var(--mono); color: var(--dim); flex-shrink: 0; }
    .mk .checks .r[data-ok="1"] .mkmark { color: var(--ok); }
    .mk .checks .lab { color: var(--mut); text-wrap: pretty; }
    .mk button.cta { width: 100%; margin-top: 1.125rem; font: 600 .9375rem var(--sans);
      padding: .625rem 1rem; border: 0; border-radius: 8px; background: var(--ok); color: var(--bg);
      cursor: pointer; }
    .mk button.cta[disabled] { background: var(--raised); color: var(--dim); cursor: not-allowed; }
    .mk .ctan { margin: .75rem 0 0; font-size: .75rem; line-height: 1.55; color: var(--dim);
      text-wrap: pretty; }
    .mk .ctan code { font-family: var(--mono); color: var(--mut); }
    .mk .out { margin-top: .8rem; font-size: .875rem; }
    .mk .out.bad { color: var(--bad); }
    .mk table.hand { border-collapse: collapse; width: 100%; margin: .6rem 0; }
    .mk table.hand td { padding: .3rem .4rem; border-bottom: 1px solid var(--hair); vertical-align: baseline; }
    .mk table.hand td.k { color: var(--mut); white-space: nowrap; width: 1%; }
    .mk table.hand td.mkv { font-family: var(--mono); word-break: break-all; }
    .mk table.hand button { font: .75rem var(--sans); padding: .2rem .5rem; background: var(--raised);
      color: var(--fg); border: 0; background: var(--raised); border-radius: 6px; cursor: pointer; }
    .mk table.hand tr.critical td.mkv { color: var(--ok); font-weight: 600; }
    /* These were the only controls on the screen with no styling at all: a
       bare input with no type="text" matched neither the .mk rule below
       nor anything global, so Name, Ticker, Description and the three links
       rendered as white browser boxes on a near-black page. That is what made
       steps 2 and 3 look like another site. */
    .mk label.f { display: block; font: .8125rem var(--sans); color: var(--mut); margin-top: .7rem; }
    .mk label.f input { width: 100%; margin-top: .3rem; font: .8125rem var(--mono);
      background: var(--bg); color: var(--fg); border: 0; border-radius: 6px; padding: .45rem .55rem; }
    .mk label.f input::placeholder, .mk input[type=text]::placeholder { color: var(--dim); }
    .mk summary { cursor: pointer; font-size: .875rem; color: var(--mut); margin-top: 1.2rem; }
    /* The three stages are the same page, so they are the same shape: one
       .cols each, the form on the left, what is decided FOR you and the button
       on the right. Steps 2 and 3 were a single flat box of stacked labels. */
    .mk #mk-s2, .mk #mk-s3 { margin-top: 1.5rem; }
    .mk .right .mkleg .r .mkv { color: var(--fg); }
  </style>
  <section class="mk" id="mk">
    <div class="hd">
      <h1>Launch a token</h1>
      <p id="mk-intro">Three signatures from this wallet, all sent from this page: the payout contracts,
      the launch on Pons, then the bind that points the fees at them. Until the three are done they
      hold nothing and bind to nothing, so an abandoned attempt costs no one anything.</p>
      <p class="hold" id="mk-hold" hidden></p>
    </div>

    <div class="stepcards" id="mk-stepcards"></div>

    <!-- Step one folds away once it is done: it is a long form, and leaving it
         open above step 2 put the launch form at the bottom of a page whose top
         half was a vault that already exists. A details element and not a hidden
         div: native, keeps every field in the DOM (the code reads them), and
         reopening it is how a second vault is created. -->
    <details id="mk-s1" open>
      <summary id="mk-s1-sum">Step 1 — the basket, the split and the currency</summary>
    <div class="cols">
      <div class="left">
        <!-- Hidden while the registry has exactly one mode to build under,
             which is its state until the timelock enables a second factory:
             a selector with one option is a question nobody was asking. -->
        <div class="box" id="mk-modebox" hidden>
          <div class="boxt">Payout mode</div>
          <select id="mk-mode"></select>
          <p class="n" id="mk-mode-note"></p>
          <div class="field" id="mk-mode-tontine" hidden>
            <span class="u">burnt</span>
            <input type="number" id="mk-burn" value="0" min="0" max="45" step="1">
            <span class="u">%</span>
            <span class="u">locked as liquidity</span>
            <input type="number" id="mk-lp" value="0" min="0" max="45" step="1">
            <span class="u">%</span>
          </div>
          <p class="n" id="mk-mode-legs-note">Both are a share <b>of what this token collects</b> — the
          same unit as the holders' share below, so the four lines add up to 100 and raising one lowers
          another. They come out of what would have gone to holders, never out of your share or the
          platform's.</p>
          <div class="field" id="mk-mode-lottery" hidden>
            <span class="u">paid to the winner of each draw</span>
            <input type="number" id="mk-pot" value="20" min="5" max="50" step="1">
            <span class="u">% of the pot</span>
          </div>
          <p class="n bad" id="mk-mode-err" hidden></p>
        </div>

        <div class="box tall">
          <div class="boxhd">
            <div class="boxt">Basket — ${MIN_BASKET} to ${MAX_BASKET} stocks, each at least ${pct(MIN_ALLOC_BPS)}, adding up to 100 %</div>
            <button type="button" class="even" id="mk-even">Even the split</button>
          </div>
          <div class="hint" id="mk-listed">reading the allowlist…</div>
          <div class="picks" id="mk-picks"></div>
          <div class="sumrow">
            <span class="a" id="mk-sum"></span>
            <span class="b">ticking a stock re-evens the split; editing a weight never does</span>
          </div>
        </div>

        <div class="box">
          <div class="boxhd">
            <div class="boxt">Share of fees paid to holders, in stock</div>
            <span class="badge" id="mk-rewards-vol"></span>
          </div>
          <!-- In PERCENT, like every other figure on this form. It read
               "7000 bps" next to a badge saying "70.00 % of what reaches the
               vault" — the same number twice, in two units, and the one you
               had to type in was the one nobody thinks in. -->
          <!-- BOTH bounds are set from the code, not written here: the max is
               100 - platform - burnt - locked and the min is 50 - burnt - locked,
               so they move as the legs do. That is the whole point of this
               change — three fields in one unit, each one visibly taking room
               from the others. The two written below are what they are with no
               legs, so the field is never wrong before the first recompute. -->
          <div class="field">
            <input type="number" id="mk-rewards" value="70" min="50" max="90" step="1">
            <span class="u">%</span>
            <input type="range" id="mk-rewards-range" value="70" min="50" max="90" step="1">
          </div>
          <p class="n" id="mk-rewards-note"></p>
        </div>

        <div class="box">
          <div class="boxt">Currency the launch is quoted in</div>
          <select id="mk-quote"><option value="0x0000000000000000000000000000000000000000">native ETH</option></select>
          <p class="n" id="mk-quote-note">Written in for good. Pons keeps <strong>one fee
          ledger per currency</strong>, so a launch claims exactly one and <code>bind</code> refuses a
          launch quoted in any other. Step 2 fills Pons's field from this by itself — you never type
          it twice.</p>
        </div>

        <div class="duo">
          <div class="box">
            <div class="boxt">Epoch length</div>
            <div class="field">
              <input type="number" id="mk-epoch" value="30" min="30" max="1440" step="30">
              <span class="u">minutes</span>
              <span class="right" id="mk-buys"></span>
            </div>
            <p class="n">How often the snapshot closes, and therefore how often the whole basket is
            bought. 30 minutes to 1 day.</p>
          </div>
          <div class="box">
            <div class="boxt">Intended token <span class="opt">— optional</span></div>
            <input type="text" id="mk-intended" placeholder="0x… leave empty to accept any">
            <p class="n">Pins the address this launch will accept at bind time. Left empty, it
            binds to whichever token names it <em>and</em> was deployed by you.</p>
          </div>
        </div>
      </div>

      <div class="right">
        <div class="box tall">
          <div class="eyebrow">What a trade will pay</div>
          <div class="bars" id="mk-bars"></div>
          <div class="mkleg" id="mk-preview"></div>
          <div class="tot"><span class="k">Of what this token collects</span>
            <span class="mkv">100.00 % total</span></div>
        </div>

        <div class="box tall">
          <div class="checks" id="mk-checks"></div>
          <button id="mk-go" class="cta pinme" disabled>Connect a wallet</button>
        <p class="note" id="mk-one" hidden></p>
          <p class="ctan">One transaction, and it launches nothing. You become the payout's
          <code>LAUNCHER</code> — step 3 checks the token's Pons deployer against it, so nobody else
          can bind a token to your payout.</p>
          <div class="out" id="mk-out"></div>
        </div>
      </div>
    </div>
    </details>

    <!-- Outside the fold, because it is the one thing the creator needs once
         step 1 is closed: which vault they own, and its page. -->
    <div class="out" id="mk-done"></div>

    <div id="mk-s2" hidden>
      <div class="cols">
        <div class="left">
          <div class="box tall">
            <div class="boxt">The token</div>
            <div class="duo">
              <label class="f">Name <input id="mk-name" maxlength="64" placeholder="Payd"></label>
              <label class="f">Ticker <input id="mk-sym" maxlength="16" placeholder="PAYD"></label>
            </div>
            <label class="f">Description <input id="mk-desc" maxlength="280" placeholder="one line"></label>
            <p class="n">Written into the token by the launch. Pons keeps them on-chain and exposes no
            setter, so they are as permanent as the address itself.</p>
          </div>

          <div class="box tall">
            <div class="boxhd">
              <div class="boxt">Logo</div>
              <div id="mk-logo-prev" hidden><img alt="" id="mk-logo-img"
                style="width:40px;height:40px;object-fit:cover;border-radius:8px;border:1px solid var(--hair)"></div>
            </div>
            <input type="text" id="mk-logo" placeholder="ipfs://bafk… or https://…">
            <p class="n" id="mk-logo-note">stored on the token forever — there is no setter to fix it later</p>
          </div>

          <div class="duo">
            <div class="box">
              <div class="boxt">Your creator tax</div>
              <div class="field">
                <input type="number" id="mk-tax" value="3" min="0" max="10" step="0.25">
                <span class="u">%</span>
              </div>
              <p class="n" id="mk-tax-note">on top of the curve fee; it is what funds the payout</p>
            </div>
            <div class="box">
              <div class="boxt">Your first buy <span class="opt">— optional</span></div>
              <div class="field">
                <input type="number" id="mk-buy" value="0" min="0" step="0.001" placeholder="0">
                <span class="u">ETH</span>
              </div>
              <p class="n" id="mk-buy-note">bought in the same transaction as the launch, and you are
              the only address exempt from the 3-second snipe tax. Native-ETH launches only.</p>
            </div>
          </div>

          <div class="box">
            <div class="boxt">Links <span class="opt">— optional</span></div>
            <label class="f">Website <input id="mk-site" placeholder="https://…"></label>
            <label class="f">X <input id="mk-x" placeholder="https://x.com/…"></label>
            <label class="f">Telegram <input id="mk-tg" placeholder="https://t.me/…"></label>
            <p class="n" id="mk-links-note">Website is filled with your token's own page on Payd as
            soon as the payout is created — it is where a holder of your token reaches what they are
            owed. Type your own site over it if you have one, and put that link on it instead.</p>
          </div>
        </div>

        <div class="right">
          <div class="box tall">
            <div class="eyebrow">Set for you, never asked</div>
            <div class="mkleg">
              <div class="r"><span class="k">Creator wallet</span><span class="mkv">your payout contract</span></div>
              <div class="r"><span class="k">Pair token</span><span class="mkv" id="mk-s2-quote">read from the payout</span></div>
              <div class="r"><span class="k">Economics</span><span class="mkv">computed</span></div>
            </div>
            <div class="tot"><span class="k">The three bind checks</span>
              <span class="mkv">cannot be mistyped</span></div>
            <p class="n">They are not preferences, which is why there is no field for them: a launch
            that gets one of the three wrong cannot be repaired.</p>
          </div>

          <div class="box tall">
            <button id="mk-launch" class="cta">Launch on Pons</button>
            <p class="ctan">Your second signature. The launch fee goes to Pons, and the first buy, if
            you asked for one, rides in the same transaction.</p>
            <div class="out" id="mk-out2"></div>
          </div>
        </div>
      </div>
    </div>

    <details id="mk-hand" hidden>
      <summary>…or launch on the Pons site instead (keeps their image uploader)</summary>
      <div class="box tall" style="margin-top:.6rem">
        <p class="n" style="margin-top:0">Pons hosts the logo for you; its upload endpoint refuses calls
        from any other site, so that is the only way to use it. The cost is that you fill their form by
        hand — so here is every value, ready to copy. <strong>Creator wallet is the one that cannot be
        repaired.</strong></p>
        <table class="hand" id="mk-hand-rows"></table>
        <p class="n">Their “Creator tax” is in <strong>percent</strong>, and so is the value above —
        copy it across as it stands. Leave every other field of theirs alone.</p>
      </div>
    </details>

    <div id="mk-s3" hidden>
      <div class="cols">
        <div class="left">
          <div class="box tall">
            <div class="boxt">The token to bind</div>
            <input type="text" id="mk-token" placeholder="0x…">
            <p class="n">Filled in by itself if you launched above. Paste it if you launched on Pons's
            own site — the payout accepts the token whichever of the two built it.</p>
            <div class="out" id="mk-diag"></div>
          </div>
        </div>

        <div class="right">
          <div class="box tall">
            <div class="eyebrow">What bind compares</div>
            <div class="mkleg">
              <div class="r"><span class="k">Pons deployer</span><span class="mkv">your payout's LAUNCHER</span></div>
              <div class="r"><span class="k">Creator wallet</span><span class="mkv">the payout contract</span></div>
              <div class="r"><span class="k">Pair token</span><span class="mkv">the launch currency</span></div>
            </div>
            <div class="tot"><span class="k">Who may send it</span><span class="mkv">anyone</span></div>
            <p class="n">The destination is written in the launch and not in the caller, so this last
            step belongs to nobody in particular — it costs gas and nothing else.</p>
          </div>

          <div class="box tall">
            <button id="mk-bind" class="cta">Bind</button>
            <p class="ctan">The conditions are read before anything is sent, so a refusal names the one
            that gave way instead of a bare <code>NotOurLaunch</code> in your wallet.</p>
            <div class="out" id="mk-out3"></div>
          </div>
        </div>
      </div>
    </div>
  </section>`;

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** Mounts the form. Returns nothing: everything after this is event-driven. */
/**
 * The current mount's capability probe, and the single subscriber that runs it.
 *
 * `renderCreate` replaces the view's HTML and calls `mountCreate` again on every
 * visit to the tab, so registering `onViewer` inside the mount would stack one
 * subscriber per visit — each firing the same three wallet calls. One
 * subscriber, pointed at whichever mount is current, costs nothing and cannot
 * accumulate.
 */
let probeNow: (() => void) | null = null;
let probeHooked = false;

export async function mountCreate(pad: Address): Promise<void> {
  const out = (msg: string, bad = false) => {
    const el = $("mk-out");
    el.textContent = msg;
    el.className = bad ? "out bad" : "out";
  };

  let platformBps = 0;
  try {
    platformBps = Number(await pub.readContract({ address: pad, abi: padAbi, functionName: "platformBps" }));
  } catch { /* shown as unknown below; the contract still enforces it */ }

  $("mk-rewards-note").textContent = platformBps
    ? `the platform takes ${platformBps / 100} % of what your token collects, fixed at launch and never raisable on you; the rest is yours`
    : "the rest is yours, less the platform's fixed share";

  // **The hold.** `createVault` builds through whatever `Payd.factory()` points
  // at, and until the timelock has moved it to V3 that is the previous default.
  // A read that FAILS holds too: we cannot promise V3 from a registry we could
  // not reach, and the cost of being wrong is a vault nobody but the timelock
  // can move. See WANT_FACTORY.
  let held = "";
  /** The factory `createVault` builds through — the DEFAULT mode. Read once,
   *  and the mode picker below offers it first. */
  let defaultFactory: Address | null = null;
  try {
    const f = await pub.readContract({ address: pad, abi: padAbi, functionName: "factory" });
    defaultFactory = f as Address;
    if (f.toLowerCase() !== WANT_FACTORY) {
      held = `<b>Creation is on hold.</b> The registry still builds through ` +
        `<code>${esc(f)}</code>. Distribution V3 — the version that seeds the Pons locker into ` +
        `every distributor's exclusion log at birth — becomes the default when the timelock's ` +
        `<code>setFactory</code> executes, from 17 September 2026 21:01 UTC. A launch is immutable ` +
        `once built, so this screen waits rather than build you the old one. Everything below is ` +
        `live and yours to set up meanwhile.`;
    }
  } catch (e) {
    held = `<b>Creation is on hold.</b> Could not read which factory the registry builds through ` +
      `(${esc((e as Error).message)}), and this screen will not create a payout it cannot name the ` +
      `version of. Reload in a moment.`;
  }
  if (held) { $("mk-hold").innerHTML = held; $("mk-hold").hidden = false; }

  /**
   * THE MODES this registry will build under, default first.
   *
   * Folded from `FactoryEnabled` / `FactoryDisabled` in the same walk as the
   * stock allowlist — the registry has no array to read, exactly as for the
   * listings. The default factory is added even if the walk missed its event
   * (it was enabled in the deployment block, and a scan that fell short would
   * otherwise leave the form with nothing to build through at all).
   *
   * One mode is the state today, and then this box stays hidden.
   */
  const modeSel = $("mk-mode") as HTMLSelectElement;
  const modes: { mode: Mode; factory: Address; isDefault: boolean }[] = [];

  // **The default mode is TWO CALLS, and must not wait on the walk.** It used
  // to be read after `listings(pad)` — the 268-window scan of the stock
  // allowlist — so a node that cut that walk short left the form with no mode
  // at all, and with it no burn and no locked-LP field on a registry that
  // builds through V3. The factory is already in hand from `Payd.factory()`
  // above; naming its mode is one more call. The events are what find the
  // OTHER modes, and only those can afford to depend on the walk.
  if (defaultFactory) {
    try {
      const mode = modeName(await pub.readContract({
        address: pad, abi: padAbi, functionName: "factoryMode", args: [defaultFactory],
      }) as Hex);
      modes.push({ mode, factory: defaultFactory, isDefault: true });
    } catch { /* unnamed: the box below stays shut rather than promise a version */ }
  }

  /** Re-drawn whenever the list of modes changes, which is twice: the default
   *  alone, then again if the walk finds more. Split out because the wiring
   *  used to sit BELOW the walk — so a registry building through V3 showed no
   *  burn and no locked-LP field until 268 windows of logs had come back, and
   *  showed none at all when the node cut them short. The default mode is known
   *  two calls in; there is nothing for it to wait for. */
  /** The mode's own fields. Called from `paintModes` so they are on screen as
   *  soon as the default mode is named, and again from `recompute` on every
   *  edit — it used to live only in `recompute`, whose first run is after the
   *  allowlist walk, so the burn and locked-LP inputs waited on 268 windows of
   *  logs they have nothing to do with. */
  const paintModeFields = () => {
    const mode = chosenMode()?.mode ?? "distribution";
    const withLegs = legsAllowed();
    $("mk-mode-tontine").hidden = !withLegs;
    $("mk-mode-legs-note").hidden = !withLegs;
    $("mk-mode-lottery").hidden = mode !== "lottery";
    $("mk-mode-note").textContent = modeBlurb(mode);
  };

  const paintModes = () => {
    const keep = modeSel.value;
    modeSel.innerHTML = modes
      .map((m, i) => `<option value="${i}">${esc(modeLabel(m))}${m.isDefault ? " — the default" : ""}</option>`)
      .join("");
    if (keep && Number(keep) < modes.length) modeSel.value = keep;
    // A selector with one option is a question nobody asked, but the BOX may
    // still have something in it: a distribution vault built through V3 carries
    // the burn and locked-LP legs, and that is the only place to set them.
    modeSel.hidden = modes.length <= 1;
    $("mk-modebox").hidden = modes.length <= 1 && !legsAllowed();
    paintModeFields();
  };



  /** The row the selector points at, and the default whenever there is nothing
   *  to choose from. */
  const chosenMode = () => modes[Number(modeSel.value) || 0] ?? modes[0] ?? null;

  /**
   * Whether the launch being built can carry the two legs.
   *
   * **They are a V3 feature, not a tontine one.**
   * `DistributionFactoryV3._decodeLegs` and `TontineFactory._decodeLegs` are the
   * same twelve lines over the same bounds, so a DISTRIBUTION vault built
   * through V3 burns and locks liquidity exactly as a tontine does — what
   * differs between the two modes is who the rest is paid to. Asked of the
   * factory's address and not of the mode's name, because the previous
   * distribution factory takes no `modeData` at all and the registry only stops
   * pointing at it when `setFactory` executes.
   */
  const legsOn = (m: { mode: Mode; factory: Address } | null): boolean => {
    if (!m) return false;
    if (m.mode === "tontine") return true;
    // The portfolio carries them too, since 2026-09-22. It is the one mode not
    // built on the deployed `FeeVaultV2`, so it left the legs behind by
    // accident rather than by decision; there is exactly one factory for it and
    // it takes the same parameter, so the mode's name is enough here.
    if (m.mode === "portfolio") return true;
    return m.mode === "distribution" && m.factory.toLowerCase() === WANT_FACTORY;
  };
  const legsAllowed = () => legsOn(chosenMode());

  /**
   * What to call a row in the selector.
   *
   * **Two distribution factories are offered at once** for as long as the
   * previous one stays enabled beside V3, and they both call themselves
   * `distribution` — that is the MODE, and a mode is exactly what they share.
   * A selector reading "distribution" twice tells the reader nothing about the
   * only thing that separates them, which is whether the vault can burn and
   * lock liquidity. Named from `legsOn`, the same test the fields use, so the
   * label cannot promise a leg the form then refuses to show.
   */
  const modeLabel = (m: { mode: Mode; factory: Address }): string =>
    m.mode !== "distribution" ? m.mode : legsOn(m) ? "distribution + burn + LP" : "distribution only";
  /** The two legs as the FORM has them: bps of what the token collects, the
   *  same unit as the holders' field. Zero whenever the fields are not on
   *  screen, so a value left behind by another mode cannot reach a factory that
   *  takes no `modeData`.
   *
   *  NOT what the contracts take — `splitNow()` converts. Everything below this
   *  line that speaks to a factory goes through it. */
  const legsNow = () => {
    const on = legsAllowed();
    const of = (id: string) => (on ? bpsFromPct(Number(($(id) as HTMLInputElement).value)) : 0);
    return { burnBps: of("mk-burn"), lpBps: of("mk-lp") };
  };
  /**
   * The three fields, converted to the two denominators the chain counts in.
   *
   * THE boundary. Above it every figure is a share of what the token collects,
   * which is the only unit a creator is ever shown; below it `rewardsBps` holds
   * the holders AND their legs, and the legs are a slice of that. Reading
   * `mk-rewards` as `rewardsBps` — which is what this screen used to do — is
   * what let 90 / 10 / 10 be entered for a launch that pays holders 72.
   */
  const splitNow = (): ContractSplit => {
    const { burnBps, lpBps } = legsNow();
    return toContract({
      holdersBps: bpsFromPct(Number(($("mk-rewards") as HTMLInputElement).value)),
      burnBps,
      lpBps,
    });
  };
  /** The parameter this launch would carry, and therefore which of the three
   *  `create…` functions signs it. */
  const modeDataNow = () => {
    const m = chosenMode();
    // `splitNow()` and NOT `legsNow()`: `modeData` is read by the factory, which
    // measures the legs against `rewardsBps`. Handing it the creator's unit
    // would burn a tenth more than was asked for on a 90 % holders' share, and
    // rather less than asked on a 55 % one.
    const { burnBps, lpBps } = splitNow();
    return m
      ? modeDataFor(m.mode, { burnBps, lpBps, potBps: bpsFromPct(Number(($("mk-pot") as HTMLInputElement).value)) })
      : { data: "0x" as const, error: undefined as string | undefined };
  };
  /** `createVaultWith` is needed for a mode that is not the default — and for
   *  the default one WITH legs, which `createVault` has no argument for. */
  const usesWith = () => {
    const m = chosenMode();
    if (!m) return false;
    return !m.isDefault || modeDataNow().data !== "0x";
  };
  paintModes();

  /** Puts one factory in the picker, whichever of the two paths below found it.
   *
   *  A mode this build has no screen for is NOT offered: the vault would be
   *  created, permanently, and then be unreadable in the app that created it.
   *  `payScreen` is the same test the launch page makes, and it is also what
   *  refuses a factory the registry no longer names — `factoryMode` answers
   *  `bytes32(0)` for a disabled one, which reads as `unknown`. */
  const offer = (factory: Address, mode: Mode) => {
    if (defaultFactory && factory.toLowerCase() === defaultFactory.toLowerCase()) return;
    if (modes.some((m) => m.factory.toLowerCase() === factory.toLowerCase())) return;
    if (payScreen(mode) === "none") return;
    modes.push({ mode, factory, isDefault: false });
  };

  // **The other modes are ASKED FOR by name — they are not waited for.**
  // They used to come only from `FactoryEnabled` in the stock allowlist's walk,
  // which starts at the registry's deployment block and moves forward, and that
  // walk can no longer reach the newest events: 216 k blocks before the node
  // throttled it, measured 2026-09-24, against a head moving ~864 k blocks a
  // day. The `localStorage` cursor resumes into a head that has run further
  // away, so reloading never caught up — the portfolio mode was enabled at
  // 14:31 UTC and the picker did not offer it, and tontine, backing and lottery
  // had been missing since 2026-09-18. Six `factoryMode` calls answer before
  // the first paint, and the chain still decides: see `KNOWN_FACTORIES`.
  void Promise.all(KNOWN_FACTORIES.map(async (factory) => ({
    factory: factory as Address,
    mode: modeName(await pub.readContract({
      address: pad, abi: padAbi, functionName: "factoryMode", args: [factory as Address],
    }).catch(() => null) as Hex | null),
  }))).then((rows) => {
    for (const r of rows) offer(r.factory, r.mode);
    paintModes();
  });

  // A walk used to run beside this one to catch a factory enabled after the
  // build shipped. It is gone with the rest of the scan: it was the same 1 452
  // windows the allowlist paid, for an event that has fired six times in the
  // registry's life — and the six it found are the six named above. A seventh
  // wants a refreshed build, which is the bargain `config.ts` states in full.

  let listed: Listed[] = [];
  try {
    listed = await allowlist(pad);
  } catch (e) {
    $("mk-picks").innerHTML =
      `<p class="note">could not read the allowlist — the node did not answer: ` +
      `${esc(String((e as Error).message).split("\n")[0]!.slice(0, 160))}. Reload to try again.</p>`;
    return;
  }
  if (listed.length === 0) {
    $("mk-picks").innerHTML = `<p class="note">no stock is listed yet — the timelock has not run its first allowlist</p>`;
    return;
  }

  // The currencies are added to native ETH, which stays the first option and
  // the default. A read that fails leaves the form on ETH alone rather than
  // blocking it: that is the case v1 already served.
  const quoteSel = $("mk-quote") as HTMLSelectElement;
  let quoted: Quoted[] = [];
  try {
    quoted = await quotelist(pad);
  } catch { /* the select keeps its single option */ }
  for (const q of quoted) {
    const o = document.createElement("option");
    o.value = q.quote;
    o.textContent = `${q.symbol} — ${q.quote}`;
    quoteSel.appendChild(o);
  }
  const quoteName = () =>
    quoteSel.value === ZERO ? "native ETH" : (quoteSel.selectedOptions[0]?.textContent ?? quoteSel.value).split(" — ")[0]!;
  const syncQuote = () => {
    $("mk-s2-quote").textContent = quoteName();
    step(current);
    handoff();
  };
  quoteSel.addEventListener("change", syncQuote);
  // The initial call is further down, after `step`: `syncQuote` redraws the
  // cards, and an arrow const is not hoisted.

  const picks = new Map<string, Draft>();
  for (const l of listed) picks.set(l.stock, { on: false, bps: 0 });

  // Every row on screen was confirmed against `Payd.listing` a moment ago, so
  // what is shown is live. What the sentence has to admit is the other
  // direction: the ADDRESSES were collected when this build was made, so a
  // stock listed since is not here and nobody could tell that from a list.
  $("mk-listed").textContent =
    `${listed.length} listed by the timelock · pool fee tier and price feed come from the allowlist, not from you`
    + ` · read from the registry just now, from addresses collected at block ${LISTINGS_READ_AT}`
    + (namesMissing > 0
      ? ` · ${namesMissing} ticker${namesMissing > 1 ? "s" : ""} could not be read and show as an address — the tier and the weight are still exact`
      : "");

  $("mk-picks").innerHTML = listed
    .map(
      (l) => `<label class="pick" data-on="0" data-stock="${l.stock}">
        <input type="checkbox" data-k="on">
        <span class="sym">${esc(l.symbol)}</span>
        <span class="tier">pool ${(l.poolFee / 10_000).toFixed(2)} %</span>
        <span class="w">
          <input type="number" data-k="bps" min="0" max="100" step="0.01" value="0" disabled>
          <span class="pc">%</span>
        </span>
      </label>`,
    )
    .join("");

  /** THIS session's vault, once created. Steps 2 and 3 depend on it. */
  let mine: Address | null = null;
  let launched: Address | null = null;
  /**
   * Whether this wallet will do the whole launch in ONE transaction.
   *
   * It needs two things and refuses on either: EIP-5792 atomic batching, so the
   * three calls cannot stop in the middle, and a 7702 delegate that accepts a
   * plain value transfer, so the creator's residue can reach them afterwards.
   * Both are the WALLET's properties and neither is ours to fix, so the screen
   * falls back to the three signatures it has always sent rather than arguing.
   */
  let oneShot = false;
  const out2 = (m: string, bad = false) => {
    const el = $("mk-out2"); el.textContent = m; el.className = bad ? "out bad" : "out";
  };
  const out3 = (m: string, bad = false) => {
    const el = $("mk-out3"); el.textContent = m; el.className = bad ? "out bad" : "out";
  };
  /** The three steps, and WHO signs each -- that is the column that matters:
   *  the third belongs to nobody, and a card that says so beats a paragraph that
   *  explains it. */
  const STEPS = [
    { tag: "01", who: "you", label: "Prepare the payout", n: "Nothing is launched. You become its LAUNCHER.", call: "Payd.createVault" },
    // Card 01 names the function actually called: a chosen currency sends
    // `createVaultQuoted`, and a card showing the other one would be wrong on
    // screen while the wallet displays the right one.
    // Card 02 names its function for the same reason card 01 does. A first buy
    // routes through the official forwarder instead of the factory -- a
    // different contract, shown by the wallet, and the card has to agree with
    // it. Pons records the forwarder's CALLER as `deployer`, so `bind` is
    // indifferent to which of the two was used (`recon.md` §1.6bis).
    { tag: "02", who: "you", label: "Launch on Pons", n: "Built here, so the three checked fields cannot be mistyped.", call: "PonsV2.launchToken" },
    { tag: "03", who: "anyone", label: "Point the fees at it", n: "Open to all: the destination is written in the launch, not in the caller.", call: "FeeVault.bind" },
  ];
  let current = 1;
  const step = (n: number) => {
    current = n;
    STEPS[0]!.call = usesWith()
      ? "Payd.createVaultWith"
      : quoteSel.value === ZERO ? "Payd.createVault" : "Payd.createVaultQuoted";
    const withBuy = quoteSel.value === ZERO && Number(($("mk-buy") as HTMLInputElement | null)?.value ?? 0) > 0;
    STEPS[1]!.call = withBuy ? "PonsV2LaunchAndBuy.launchAndBuy" : "PonsV2.launchToken";
    STEPS[1]!.n = withBuy
      ? "Your first buy rides in the same transaction, and only you are exempt from the snipe tax."
      : "Built here, so the three checked fields cannot be mistyped.";
    // One card, because there is one signature. Three cards numbered 01-02-03
    // next to a button that does all three is the screen contradicting itself,
    // and the "who" column — the whole reason the cards exist — has one answer.
    if (oneShot) {
      $("mk-stepcards").innerHTML =
        `<div class="stepcard" data-now="1" style="grid-column:1/-1">
           <div class="top"><span class="tag">01</span><span class="who">you, once</span></div>
           <div class="label">Create, launch and point the fees at it</div>
           <p class="note">One transaction. Either all three land or none of them do — and if none
             do, no launch fee is spent.</p>
           <code>${esc(STEPS[0]!.call)} &middot; ${esc(STEPS[1]!.call)} &middot; FeeVault.bind</code>
         </div>`;
      return;
    }
    $("mk-stepcards").innerHTML = STEPS.map((x, i) =>
      `<div class="stepcard" data-now="${i === n - 1 ? 1 : 0}">
         <div class="top"><span class="tag">${x.tag}</span><span class="who">${esc(x.who)}</span></div>
         <div class="label">${esc(x.label)}</div>
         <p class="note">${esc(x.n)}</p>
         <code>${esc(x.call)}</code>
       </div>`).join("");
  };
  step(1);
  syncQuote(); // step 2 has to say "native ETH" before anything is touched

  /**
   * Steps 2 and 3 for a vault created BEFORE this page load.
   *
   * `mine` only ever lived in this closure, so refreshing the page after
   * signing step 1 lost it — and with it every way of launching or binding
   * from the app. The vault was built, the creator's ETH was spent, and the
   * screen offered them nothing but building a second one. The browser
   * remembers the last vault created here, and `?mine=0x…` names one by hand
   * (another browser, another machine).
   *
   * Nothing is verified here: `launchOnPons` reads `LAUNCHER` from the address
   * and refuses it by name, which is a better check than any this could make.
   */
  const REMEMBER = "payd:mine";
  const adopt = (vault: Address, note: string): void => {
    mine = vault;
    step(2);
    // Fold step one away and say, in its summary, what it produced. Reopening
    // it is how a second vault is created: nothing is destroyed, and the
    // creator is no longer scrolling past a form they have finished with.
    const s1 = $("mk-s1") as HTMLDetailsElement;
    s1.open = false;
    $("mk-s1-sum").textContent = `Step 1 — done: payout at ${vault} · reopen to prepare another`;
    $("mk-done").innerHTML = note;
    $("mk-s2").hidden = false;
    $("mk-hand").hidden = false;
    $("mk-s3").hidden = false;
    handoff();
  };
  {
    const asked = new URLSearchParams(location.search).get("mine");
    let kept: string | null = null;
    try { kept = localStorage.getItem(REMEMBER); } catch { /* private mode, no memory */ }
    const earlier = [asked, kept].find((v) => v && /^0x[0-9a-fA-F]{40}$/.test(v)) as Address | undefined;
    if (earlier) {
      adopt(earlier, `<p>Payout prepared earlier from this browser: <span class="mono">${esc(earlier)}</span>` +
        ` — carry on below, or create another one above and this one is replaced here.</p>`);
    }
  }

  /**
   * Asks the wallet, once per page load, whether it can do this in one
   * transaction — and reshapes the screen if it can.
   *
   * Silent: `eth_accounts` never opens a prompt, so a visitor who has not
   * connected sees nothing and the classic three-step screen stands. A wallet
   * connected later is caught by `accountsChanged`, and the click handler
   * re-asks before it commits, because a wallet can be switched in between.
   */
  async function probeOneShot(): Promise<void> {
    // **Only once a wallet has been DELIBERATELY picked.** `provider()` falls back
    // to `window.ethereum` before the EIP-6963 announcements, and with two
    // extensions installed that slot belongs to whichever of them wrote it last
    // — not to the one the visitor will sign with. Probing it produced a real
    // wrong answer: a second extension answered `wallet_getCapabilities` with
    // `doesn't has corresponding handler`, and the banner told the creator their
    // wallet could not batch when the wallet in question was never theirs.
    //
    // `connected` is true only after `connectWith` ran, which is also when
    // `chosen` is set — so from here `provider()` is the picked wallet and
    // nothing else.
    if (!connected) return;
    const eth = provider();
    if (!eth) return;
    let account: Address | undefined;
    try {
      [account] = (await eth.request({ method: "eth_accounts" })) as Address[];
    } catch { return; }
    if (!account) return;

    const atomic = await atomicOf(eth, account);
    const payable = await acceptsValue(eth, account);
    const next = canBatch(atomic) && payable !== "no";
    const note = $("mk-one");

    if (payable === "no") {
      // Said HERE and not only at the moment of signing: it is the one thing on
      // this screen that cannot be undone afterwards, and a creator should read
      // it before they have filled anything in.
      note.hidden = false;
      note.className = "n bad";
      note.textContent =
        "This wallet has a smart-account delegation that refuses plain ETH transfers. Your creator "
        + "share could never be paid out to it, and a launch's CREATOR is fixed at birth — revoke the "
        + "delegation, or launch from another wallet.";
      return;
    }
    if (!next) {
      // **Silence used to mean two different things**: "no wallet connected yet"
      // and "this wallet cannot do it". A creator seeing the ordinary three-step
      // screen had no way to tell whether the app had asked. It says which now.
      note.hidden = false;
      note.className = "n";
      note.textContent =
        `This wallet does not offer atomic batching on this chain (${atomic}), so the launch stays `
        + `three signatures — normal, and nothing is lost by it: the same contracts, the same order.`;
    }
    if (next === oneShot) return;
    oneShot = next;
    if (oneShot) {
      note.hidden = false;
      note.className = "n";
      note.textContent =
        "Your wallet can send the three calls as one transaction: prepare the payout, launch on Pons "
        + "and point the fees at it, in a single signature. Fill in the launch below before pressing "
        + "the button — all of it goes out together, or none of it does.";
      // The launch form has to be fillable BEFORE anything is signed, which is
      // the one structural difference: in the three-step flow it appears after
      // the vault exists. The handoff table goes — there is no other form to
      // copy anything into — and so does step 3, which is inside the batch.
      $("mk-s2").hidden = false;
      $("mk-hand").hidden = true;
      $("mk-s3").hidden = true;
      launchBtn.hidden = true;
    }
    step(current);
    recompute();
  }
  const go = $("mk-go") as HTMLButtonElement;


  /**
   * **The whole launch, in one transaction, signed once.**
   *
   * Proven end to end against the live chain in `test/OneTxLaunch.t.sol`: the
   * creator's own wallet executes the three calls under EIP-7702, so
   * `msg.sender` stays THEM throughout — Pons records them as the `deployer`,
   * the vault's `LAUNCHER` and `CREATOR` are their address, and none of our code
   * sits between them and their fees. That is what a router contract could not
   * do: `Payd._create` passes the same `msg.sender` to `creator` and `deployer`,
   * so a router would take the creator's residue and their `setRewardsBps` with
   * it, and `Payd` has no successor to fix that in.
   *
   * The price is two predictions, and `test/OneTx.t.sol` measured both:
   *
   *   - the VAULT is `CREATE(CREATE(modeFactory, its nonce), 2)`;
   *   - the TOKEN is derived from the sender, the salt and the params, so
   *     simulating the launch from this account returns the address the real
   *     transaction will produce.
   *
   * **The nonce is the only real risk and atomicity is the entire answer.**
   * Another launch through the same factory between the read and the block moves
   * the vault, `bind` then reverts, and an atomic batch takes the launch down
   * with it — the fee is never paid and the creator tries again. Non-atomic, the
   * launch could land while `bind` fails, and the creator fees would point for
   * ever at somebody else's vault, with Pons imposing three days AND the current
   * recipient's consent to move them. Hence `atomicRequired`, and hence the
   * refusal to take this path at all on a wallet that will not promise it.
   */
  async function oneTransaction(
    eth: NonNullable<ReturnType<typeof provider>>,
    account: Address,
    fn: string,
    args: readonly unknown[],
    modeFactory: Address | null,
    quote: Address,
  ): Promise<void> {
    const input = launchInput();
    if (typeof input === "string") return out(input, true);

    // The factory whose nonce decides the address is the one that will BUILD:
    // the default for `createVault`, and the named one for `createVaultWith`.
    // Reading the default here would predict the wrong vault for every
    // secondary mode — and the batch would revert rather than misfire, but it
    // would revert every single time.
    const built = modeFactory
      ?? ((await pub.readContract({ address: pad, abi: padAbi, functionName: "factory" })) as Address);
    const nonce = await pub.getTransactionCount({ address: built });
    const { vault } = predictPair(built, BigInt(nonce));

    out("working out where the payout and the token will land…");
    const ponsFactory = (await pub.readContract({
      address: pad, abi: padAbi, functionName: "PONS_FACTORY",
    })) as Address;
    // `buildLaunch` is the SAME code the three-signature path uses, so the three
    // fields `bind` checks are constructed once. The quote comes from the
    // selector here because there is no vault to read it off yet — and the
    // registry has already agreed to that quote, two dozen lines above.
    const call = await buildLaunch(ponsFactory, account, input, quote, vault, out);
    // Simulated FROM THE CREATOR'S ACCOUNT: the sender is in the derivation, so
    // a simulation from anywhere else returns a plausible address belonging to
    // nobody, and `bind` would refuse it after the launch had happened.
    const token = await previewToken(call, account);

    const calls = oneShotCalls({
      registry: pad,
      createData: encodeFunctionData({ abi: padAbi, functionName: fn as never, args: args as never }),
      pons: call.target,
      launchData: encodeFunctionData(
        { abi: call.abi, functionName: call.functionName, args: call.args } as never,
      ),
      launchValue: call.value,
      vault,
      bindData: encodeFunctionData({ abi: vaultBindAbi, functionName: "bind", args: [token] }),
    });

    out("confirm the launch in your wallet — one signature for all three calls…");
    const id = await sendAtomic(eth, account, calls);
    const { outcome, hash } = await waitForBatch(eth, id, out);
    if (outcome === "failed") {
      return out(
        "the batch did not go through, and nothing happened — no launch fee was spent. The usual "
        + "cause is another launch landing in the same moment, which moves the payout's address. "
        + "Press the button again.", true);
    }
    if (outcome === "pending") {
      return out(
        "the wallet has not reported the batch as settled yet. Nothing is lost — reload this page "
        + "and it will pick it up from where it landed.", true);
    }

    launched = token;
    try { localStorage.setItem(REMEMBER, vault); } catch { /* private mode */ }

    // **The delegate check, now that there IS one.** MetaMask reports
    // `atomic: "ready"` on this chain, meaning it upgraded this account to a
    // 7702 smart account as part of the batch that just landed. The check before
    // `createVault` therefore looked at an account with no code and answered
    // about a delegate that did not exist. This is the same question asked of
    // the implementation that will actually receive the creator's residue.
    //
    // It does not block anything — the launch is done and it was the right thing
    // to do — and the way out is the creator's own: revoking the delegation
    // leaves the account codeless and `withdraw()` goes through. Said now rather
    // than discovered at the first `payCreator`.
    if ((await acceptsValue(eth, account)) === "no") {
      out(
        "Launched — but your wallet was upgraded to a smart account in the same transaction, and that "
        + "account refuses plain ETH transfers. Your creator share will pile up in the payout's "
        + "`pendingWithdrawal` instead of reaching you. Revoking the smart-account upgrade in MetaMask "
        + "releases it; the holders' share is unaffected either way.", true);
    }
    const link = hash ? ` — <a href="${EXPLORER}/tx/${hash}">transaction</a>` : "";
    adopt(vault,
      `<p>Done, in one transaction${link}.</p>`
      + `<p>Payout <span class="mono">${esc(vault)}</span><br>`
      + `Token <span class="mono">${esc(token)}</span></p>`
      + `<p class="note">The fees already point at it and it is bound: there is nothing left `
      + `to sign. The two sections below are only there if you want to check them.</p>`);
    ($("mk-token") as HTMLInputElement).value = token;
    out2(`Launched: ${token}`);
    out3("Bound in the same transaction.");
  }


  /** The token this vault will accept, or zero for "any". Invalid input counts
   *  as zero rather than failing: the field is optional, and `validate` does not
   *  cover it. */
  const intended = (): Address => {
    const v = ($("mk-intended") as HTMLInputElement).value.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : "0x0000000000000000000000000000000000000000";
  };

  /** `rewardsBps` as the registry counts it — the holders' field PLUS the two
   *  legs, because the legs are funded from inside it (`splitNow`). It is no
   *  longer what the field holds, and that is the fix. */
  const rewardsNow = () => splitNow().rewardsBps;
  /** The epoch, in SECONDS. The field holds minutes. */
  const epochNow = () => Number(($("mk-epoch") as HTMLInputElement).value) * 60;

  function recompute() {
    const chosen = [...picks.values()].filter((p) => p.on);
    const sum = chosen.reduce((a, c) => a + c.bps, 0);
    // The fields are in percent; everything below them, and the contract, are
    // in bps. `legsNow()` is the creator's unit (a share of what the token
    // collects) and `rewardsNow()` is the chain's (holders AND their legs) —
    // `splitNow` is the one place they meet.
    const { burnBps, lpBps } = legsNow();
    const rewards = rewardsNow();
    const epochMin = Number(($("mk-epoch") as HTMLInputElement).value);

    // "6 stocks, 8000 / 10000 bps" asked the reader to subtract in
    // ten-thousandths to learn the one thing they need: whether the basket is
    // full, and by how much it is not.
    $("mk-sum").textContent = !chosen.length
      ? ""
      : `${chosen.length} stock${chosen.length > 1 ? "s" : ""} · ` + (
        sum === BPS
          ? "100 % allocated"
          : sum < BPS
          ? `${pct(sum)} allocated, ${pct(BPS - sum)} left`
          : `${pct(sum)} allocated, ${pct(sum - BPS)} too much`
      );
    // **What the holders' field may hold, and it is not a constant any more.**
    // The four lines are in ONE unit now, so the room left is literally what
    // the other three have not taken: 100 less the platform's fixed share, less
    // the two legs. This is the fix — with 10 % burnt and 10 % locked and a
    // platform at 10 %, the holders' field stops at 70, where it used to accept
    // 90 and quietly pay 72.
    const legsPct = (burnBps + lpBps) / 100;
    const room = Math.max(1, 100 - platformBps / 100 - legsPct);
    // And the floor moves the same way, in the other direction: the contract's
    // `MIN_REWARDS_BPS` is on holders PLUS the legs, so what the field may hold
    // is `50 - burnt - locked`. Static at 1, it was the one bound of the four
    // this screen did not express.
    const floor = holdersFloorPct(burnBps + lpBps);
    const rw = $("mk-rewards") as HTMLInputElement;
    const rg = $("mk-rewards-range") as HTMLInputElement;
    rw.max = String(room);
    rg.max = String(room);
    rw.min = String(floor);
    rg.min = String(floor);
    // The `max` attribute alone does not clamp a value already in the field —
    // it only bounds the spinner — so raising a leg past what the holders' line
    // leaves has to push the field down itself.
    if (Number(rw.value) > room) rw.value = String(room);
    rg.value = rw.value;
    $("mk-rewards-vol").textContent = "of what this token collects";
    // `Number(...)` drops a trailing `.0`: at the default 30 minutes the field
    // read "48.0 buys a day", which is a decimal announcing a precision the
    // figure does not have. 2.4 keeps its tenth.
    $("mk-buys").textContent = epochMin > 0
      ? `${Number((1440 / epochMin).toFixed(1))} buys a day`
      : "";

    // THE MODE. Its fields, its one-line description, and the parameter the
    // factory will decode — refused HERE when it is out of bounds, so nobody
    // pays for a `BadModeData` revert.
    const chosen2 = chosenMode();
    const mode: Mode = chosen2?.mode ?? "distribution";
    paintModeFields();
    const data = modeDataNow();
    $("mk-mode-err").textContent = data.error ?? "";
    $("mk-mode-err").hidden = !data.error;
    // The hold is about the DEFAULT factory's version. A mode chosen
    // explicitly is another factory, admitted by the generation key and the
    // timelock together, and waiting on `setFactory` would hold it for a
    // reason that does not apply to it.
    const onHold = held !== "" && (chosen2?.isDefault ?? true);
    $("mk-hold").hidden = !onHold;

    // The share of VOLUME, not the share of the vault: it is what a trader
    // pays, and it is the only one of the two a creator can compare against
    // another launch. The real figure will come from `economics()` once the
    // token is bound -- here the creator tax is not known yet, so we announce
    // what we do know: the split of what ARRIVES at the vault.
    const creator = Math.max(0, BPS - rewards - platformBps);
    // **Drawn from what the CHAIN was asked for, never from what was typed.**
    // `toSplit` is `toContract`'s inverse, so this is the split a vault built
    // from this form actually performs — including the one bps the conversion
    // can lose. The fields say 70 / 10 / 10 and so does the bar, but if ever
    // they could not, the bar is the one that would be right.
    const done = toSplit(splitNow());
    const burnt = data.error ? 0 : done.burnBps;
    const locked = data.error ? 0 : done.lpBps;
    const parts: [string, number, string][] = [
      ["to holders, in stock", Math.max(0, rewards - burnt - locked), "var(--ok)"],
      ...(burnt > 0 ? [["burnt", burnt, "var(--bad)"] as [string, number, string]] : []),
      ...(locked > 0 ? [["locked as liquidity", locked, "var(--warn)"] as [string, number, string]] : []),
      ["to you, the creator", creator, "var(--mut)"],
      ["to the platform", platformBps, "var(--dim)"],
    ];
    $("mk-bars").innerHTML = parts
      .map(([, v, c]) => `<i style="flex-grow:${v};background:${c}"></i>`).join("");
    $("mk-preview").innerHTML = parts
      .map(([k, v, c]) =>
        `<div class="r"><span class="k"><span class="mkdot" style="background:${c}"></span>${esc(k)}</span>` +
        `<span class="mkv">${pct(v)}</span></div>`).join("");

    // `burnt + locked` is passed so the checklist can name what the floor
    // really bounds: it is on `rewardsBps`, which the legs are funded from.
    $("mk-checks").innerHTML = checks(picks, rewards, epochMin, platformBps, burnt + locked)
      .map((c) =>
        `<div class="r" data-ok="${c.ok ? 1 : 0}">` +
        `<span class="mkmark">${c.ok ? "\u2713" : "\u00b7"}</span>` +
        `<span class="lab">${esc(c.label)}</span></div>`).join("");

    const err = validate(picks, rewards, epochMin, platformBps, burnt + locked);
    // In one transaction the launch fields are signed WITH the basket, so they
    // are part of what this button waits for. In three, they belong to step 2
    // and are checked when step 2 is pressed — which is why this is asked of
    // `oneShot` and not of the fields.
    const li = oneShot ? launchInput() : null;
    const launchErr = typeof li === "string" ? li : null;
    // The hold wins over the basket: the form stays fully usable and the one
    // button that signs does not.
    go.disabled = onHold || err !== null || data.error !== undefined || launchErr !== null;
    go.textContent = onHold
      ? "Waiting for V3"
      : data.error
      ? "Fix the mode"
      : err
      ? "Fix the basket"
      : launchErr
      ? "Fix the launch"
      : oneShot
      ? "Create, launch and bind — one signature"
      : "Prepare the payout";
    if (data.error && !onHold) out(data.error, true);
    else if (err && !onHold) out(err, true);
    else if (launchErr && !onHold) out(launchErr, true);
    else out("");
  }

  /** Applies the even split to whatever is currently ticked. */
  function reweigh() {
    const on = listed.filter((l) => picks.get(l.stock)!.on);
    const w = spread(on.length);
    on.forEach((l, i) => { picks.get(l.stock)!.bps = w[i]!; });
    for (const l of listed) {
      const box = document.querySelector<HTMLInputElement>(`[data-stock="${l.stock}"] [data-k="bps"]`)!;
      // The box is in percent and `bps` is the truth: 1250 shows as 12.5, and
      // `bpsFromPct` takes it straight back to 1250 if the reader never edits
      // it. `spread` still divides 10 000, so the sum is exact whatever the
      // display rounds to.
      box.value = String(picks.get(l.stock)!.bps / 100);
    }
  }

  $("mk-picks").addEventListener("change", (ev) => {
    const el = ev.target as HTMLInputElement;
    const row = el.closest<HTMLElement>(".pick");
    if (!row) return;
    const stock = row.dataset.stock!;
    const d = picks.get(stock)!;
    if (el.dataset.k === "on") {
      d.on = el.checked;
      row.dataset.on = d.on ? "1" : "0";
      row.querySelector<HTMLInputElement>('[data-k="bps"]')!.disabled = !d.on;
      if (!d.on) d.bps = 0;
      reweigh(); // re-even the split whenever the SET changes, never on a manual edit
    } else {
      d.bps = bpsFromPct(Number(el.value));
    }
    recompute();
  });
  // Changing the holders' line moves both legs' bounds, so it snaps them the
  // same way a leg does — the legs are what yields, because the holders' field
  // is the one that was touched.
  const snapLegsToHolders = () => {
    const read = (x: string) => Number(($(x) as HTMLInputElement).value);
    const { burnPct, lpPct } = snapLegs(read("mk-burn"), read("mk-lp"), read("mk-rewards"), "lp");
    ($("mk-burn") as HTMLInputElement).value = String(burnPct);
    ($("mk-lp") as HTMLInputElement).value = String(lpPct);
    recompute();
  };
  $("mk-rewards").addEventListener("change", snapLegsToHolders);
  for (const id of ["mk-rewards", "mk-epoch"]) $(id).addEventListener("input", recompute);
  /** The mode's numbers, snapped to what the chain will take. The arithmetic is
   *  `snapLeg` / `snapPot` in `modes.ts`, next to the bounds the encoder reads,
   *  so the field and the refusal cannot drift apart. */
  const snap = (id: string) => {
    const read = (x: string) => Number(($(x) as HTMLInputElement).value);
    if (id === "mk-pot") {
      ($(id) as HTMLInputElement).value = String(snapPot(read(id)));
      return;
    }
    // BOTH legs, from one call, because in this unit each one's floor is read
    // against the other: fixing only the field that was touched leaves the
    // other under a bound that just moved. The field that WAS touched keeps
    // what was typed and the other yields, which is what editing a form means.
    const { burnPct, lpPct } = snapLegs(
      read("mk-burn"), read("mk-lp"), read("mk-rewards"), id === "mk-burn" ? "burn" : "lp",
    );
    ($("mk-burn") as HTMLInputElement).value = String(burnPct);
    ($("mk-lp") as HTMLInputElement).value = String(lpPct);
  };

  // The mode's own fields move the step card too: setting a leg changes which
  // function is signed, and a card naming `createVault` over a wallet showing
  // `createVaultWith` is the disagreement this screen exists to remove.
  for (const id of ["mk-burn", "mk-lp", "mk-pot"]) {
    $(id).addEventListener("input", () => { recompute(); step(current); });
    // ON `change`, NOT on `input`: snapping while somebody is still typing
    // fights them for the caret. This runs when the field is left, or when the
    // spinner is used.
    $(id).addEventListener("change", () => { snap(id); recompute(); step(current); });
  }
  // The selector moves the CALL as well as the fields, so the step card is
  // redrawn with it: a card naming `createVault` while the wallet is about to
  // show `createVaultWith` is the kind of disagreement this screen exists to
  // remove.
  modeSel.addEventListener("change", () => { recompute(); step(current); });
  // The slider writes the SAME field, so it owes the legs the same snap. It did
  // not, and that was the one way into the state the form otherwise refuses:
  // dragging the holders' line under legs already set left `b + l > h` with
  // nothing to correct it, and `toContract` reproportioned the pair in silence.
  // On `change` rather than `input`, so a leg is not turned off mid-drag while
  // passing through a value the creator is not stopping at.
  $("mk-rewards-range").addEventListener("input", (ev) => {
    ($("mk-rewards") as HTMLInputElement).value = (ev.target as HTMLInputElement).value;
    recompute();
  });
  $("mk-rewards-range").addEventListener("change", snapLegsToHolders);
  // Both are in percent now, so the slider and the field agree without a
  // conversion between them — the conversion happens once, in `recompute`.
  $("mk-even").addEventListener("click", () => { reweigh(); recompute(); });

  go.addEventListener("click", async () => {
    const eth = provider();
    if (!eth) return out("connect a wallet first — the Connect button, top right", true);
    go.disabled = true;
    try {
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) return out("the wallet returned no account", true);
      if (!(await ensureChain(eth, (m) => out(m, true)))) return;

      // **The delegate gate, and it has nothing to do with batching.** A wallet
      // with an EIP-7702 delegation that refuses a plain value transfer strands
      // the creator's ENTIRE residue: `FeeVault._pay` parks it, and `withdraw()`
      // is a plain transfer too so it cannot send it either — while `CREATOR` is
      // immutable, so there is no second address to redirect to. Measured in
      // `test/OneTxLaunch.t.sol:test_ADelegateThatRefusesValueStrandsTheResidue`.
      //
      // It stands HERE, before the branch below, because the exposure is the
      // wallet's and not the batch's: the three signatures carry it identically.
      // And it only fires on an explicit revert — a node that will not simulate
      // answers `unknown`, and refusing a launch on an RPC's mood would be its
      // own kind of wrong.
      if ((await acceptsValue(eth, account)) === "no") {
        return out(
          "this wallet has a smart-account delegation that refuses plain ETH transfers, so your "
          + "creator share could never be paid out to it — and a launch's CREATOR is fixed at birth. "
          + "Revoke the delegation in your wallet, or launch from another one.", true);
      }

      const basket = listed
        .filter((l) => picks.get(l.stock)!.on)
        .map((l) => ({ stock: l.stock, poolFee: l.poolFee, bps: picks.get(l.stock)!.bps, feed: l.feed }));

      out("confirm in your wallet…");
      const wallet = createWalletClient({ account, chain, transport: custom(eth) });
      // Two functions rather than one more argument on a single one: it is the
      // Payd that made that choice, and following it here keeps the ETH path
      // exactly as it was -- same selector, same calldata, same gas.
      const quote = quoteSel.value as Address;
      // **The field is in PERCENT and the registry counts in BPS.** This line
      // sent the field's own number, so "90 %" reached `FeeVaultV2.init` as
      // `rewardsBps = 90` — 0.9 %, under `MIN_REWARDS_BPS`, and every creation
      // came back `BadSplit`. The checklist above said nothing because it reads
      // the same field through `bpsFromPct` (see `recompute`): it was checking
      // 9000 while the transaction carried 90. Every reader of these two fields
      // now goes through `rewardsNow` / `epochNow`, so there is one conversion
      // per field and no second place to forget it.
      const common = [basket, BigInt(rewardsNow()), BigInt(epochNow()), intended()];

      // `createVaultWith` is taken for TWO reasons, not one: a mode that is not
      // the default, and a parameter to carry. The second is the case the first
      // version missed — a distribution vault with burn or locked-LP legs is
      // built through the DEFAULT factory and still needs its `modeData`, which
      // `createVault` has no argument for.
      //
      // With no legs and the default mode, the two original selectors are
      // untouched: same calldata as every launch so far.
      const picked = chosenMode();
      const modeData = modeDataNow();
      if (modeData.error) return out(modeData.error, true);
      const bespoke = picked && usesWith() ? picked : null;

      const fn = bespoke ? "createVaultWith" : quote === ZERO ? "createVault" : "createVaultQuoted";
      const args = (bespoke
        ? [bespoke.factory, ...common, quote, modeData!.data]
        : quote === ZERO ? common : [...common, quote]) as never;

      // ASK BEFORE SIGNING. The registry names its refusal — `BadSplit`,
      // `BadWeights`, `BadEpochLength`, `BadModeData` — and going straight to
      // the wallet threw that name away: the creator got whatever their wallet
      // says about a failed simulation and four rules to guess between.
      //
      // A refusal we can READ stops here. Anything else does not: a node that
      // is rate-limiting us answers the same way as a revert with no reason,
      // and refusing to let somebody sign because we could not reach the chain
      // would be this screen deciding for them on no evidence.
      out("checking with the registry…");
      try {
        await pub.simulateContract({ address: pad, abi: [...padAbi, ...CREATE_ERRORS], functionName: fn, args, account });
      } catch (e) {
        const revert = (e as BaseError)?.walk?.((x) => x instanceof ContractFunctionRevertedError) as
          ContractFunctionRevertedError | null;
        const named = revert?.data?.errorName;
        if (named) return out(whyRefused(named, revert!.data!.args ?? []), true);
      }

      // One transaction, if the wallet can guarantee it. Everything above this
      // line is shared: the same basket, the same selector, the same calldata,
      // and the same refusal read out of the registry before anything is signed.
      if (oneShot && canBatch(await atomicOf(eth, account))) {
        await oneTransaction(eth, account, fn, args, bespoke?.factory ?? null, quote);
        return;
      }

      const hash = (await wallet.writeContract({
        address: pad,
        abi: padAbi,
        functionName: fn,
        args,
        account,
        chain,
      })) as Hex;

      out(`sent: ${hash}`);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      // The vault is the first contract the transaction created. Reading it
      // from the receipt rather than re-reading the registry keeps the answer
      // tied to THIS transaction — `vaults()` would also return one somebody
      // else created in the same block.
      const created = receipt.logs.find((l) => l.address.toLowerCase() === pad.toLowerCase());
      const vault = created?.topics?.[1] ? (`0x${created.topics[1].slice(26)}` as Address) : null;

      if (!vault) {
        $("mk-out").innerHTML = `<p>Created. <a href="${EXPLORER}/tx/${hash}">transaction</a></p>
          <p class="note">The payout address could not be read from the receipt, so the next two steps
          cannot be prefilled. Find it in the list above and launch on Pons with it as the creator fee
          recipient, native ETH as the pair.</p>`;
        return;
      }

      // The vault exists: we go straight on to step 2 rather than sending the
      // creator off to fill in a form elsewhere. That is the WHOLE point -- the
      // three fields `bind` checks are no longer asked of them.
      // So a refresh does not lose it: the vault is built and paid for, and the
      // only place its address existed was a variable in this closure.
      try { localStorage.setItem(REMEMBER, vault); } catch { /* private mode */ }
      // Step 3 is revealed here and not after the launch: one may have come
      // back from a launch made at Pons's own site.
      adopt(vault,
        `<p>Payout ready: <span class="mono">${esc(vault)}</span> — <a href="${EXPLORER}/tx/${hash}">transaction</a></p>`);
      $("mk-s2").scrollIntoView({ behavior: "smooth", block: "start" });
      // This vault's own page, filled into the launch's "Website" field a few
      // boxes down: it is where a holder of the token reaches their claim, and
      // Pons shows it on the token's page. BOTH addresses are in the link —
      // `?token=` alone leaves the app reading $PAYD's own distributor
      // (`config.ts`), so the page would open on the right vault with the wrong
      // claims. Never overwrites a website already typed in.
      //
      // **After the reveal, never before it.** Written above `step(2)` it put
      // an RPC read on the path between "Vault created" and the launch form:
      // a slow node — or a mode whose vault has no `DISTRIBUTOR` at all, which
      // reverts — left the creator on step one with their vault already built.
      // Nothing on this screen may wait on a read that is a convenience.
      try {
        const dist = (await pub.readContract({
          address: vault, abi: vaultBindAbi, functionName: "DISTRIBUTOR",
        })) as Address;
        const link = `${APP_URL}?token=${vault}&distributor=${dist}`;
        const site = $("mk-site") as HTMLInputElement;
        if (site.value.trim() === "") {
          site.value = link;
          handoff();
          // Said IN the form as well, not only in the block above it: a URL
          // that appears by itself in a field the creator did not fill reads
          // like a leftover unless the box says whose it is.
          $("mk-links-note").innerHTML =
            `Website is <strong>your token's page on Payd</strong>, filled in for you: ` +
            `<a href="${esc(link)}">${esc(link)}</a>. Type your own site over it if you have one, ` +
            `and put this link on that page instead.`;
        }
        $("mk-done").insertAdjacentHTML("beforeend",
          `<p class="note">Its page: <a href="${esc(link)}">${esc(link)}</a> — filled into ` +
          `“Website” below, and copyable from the handoff table.</p>`);
      } catch { /* the vault exists either way; the link is a convenience */ }
      // The cap comes from Pons, not from here. `launchOnPons` re-validates it
      // anyway -- this is only the visible version.
      try {
        const factory = (await pub.readContract({
          address: pad, abi: padAbi, functionName: "PONS_FACTORY",
        })) as Address;
        const max = await pub.readContract({
          address: factory, abi: factoryAbi, functionName: "maxCreatorTaxBps",
        });
        const tax = $("mk-tax") as HTMLInputElement;
        // `maxCreatorTaxBps` is Pons's, in bps; the field is in percent.
        tax.max = String(Number(max) / 100);
        $("mk-tax-note").textContent = `on top of the curve fee; Pons caps it at ${pct(Number(max))}`;
      } catch { /* the field keeps its default bound; the contract decides */ }
    } catch (e) {
      out("failed: " + String((e as Error).message).split("\n")[0], true);
      go.disabled = false;
    }
  });

  // The preview is the real protection: the field is written ONCE on the token
  // and no known setter takes it back. A dead address has to be seen before the
  // signature, not after.
  $("mk-buy").addEventListener("input", () => { step(current); recompute(); });

  $("mk-logo").addEventListener("input", () => {
    const r = checkLogo(($("mk-logo") as HTMLInputElement).value, GATEWAYS);
    const box = $("mk-logo-prev");
    const note = $("mk-logo-note");
    if (!r.ok) {
      box.hidden = true;
      note.textContent = r.why;
      note.className = "n bad";
      recompute();
      return;
    }
    note.textContent = "stored on the token forever — there is no setter to fix it later";
    note.className = "n";
    box.hidden = r.preview === "";
    if (r.preview) ($("mk-logo-img") as HTMLImageElement).src = r.preview;
    // A bad logo blocks the one-transaction button, so the button has to hear
    // about it — `launchInput` refuses on `checkLogo` and nothing else re-ran.
    recompute();
  });

  /** The values to copy into Pons's form, under THEIR labels. The labels are
   *  the ones read on their page: a creator switching between tabs has to
   *  recognise the fields without translating. */
  function handoff(): void {
    if (!mine) return;
    const v = (id: string) => ($(id) as HTMLInputElement).value.trim();
    const tax = Number(v("mk-tax"));
    const rows: [string, string, boolean][] = [
      ["Creator wallet", mine, true], // the only unrepairable one: first, and in colour
      // The pair only shows when it is not ETH: on their form that is the
      // default, and a row saying "leave it as it is" reads as an action to
      // take. When it is NOT the default, it is as unrepairable as the creator
      // wallet -- hence in colour.
      ...(quoteSel.value === ZERO ? [] : [["Pair token", quoteSel.value, true] as [string, string, boolean]]),
      ["Name", v("mk-name"), false],
      ["Ticker", v("mk-sym"), false],
      // Theirs is in percent and so is ours now, so this is a straight copy. It
      // used to divide by 100, which is the conversion that goes missing the
      // day one of the two fields changes unit and the other does not.
      ["Creator tax", Number.isFinite(tax) ? String(tax) : "", false],
      ["Description", v("mk-desc"), false],
      ["Website", v("mk-site"), false],
      ["X profile", v("mk-x"), false],
      ["Telegram", v("mk-tg"), false],
    ];
    $("mk-hand-rows").innerHTML = rows
      .filter(([, val]) => val !== "")
      .map(([k, val, crit]) =>
        `<tr class="${crit ? "critical" : ""}"><td class="k">${esc(k)}</td>` +
        `<td class="mkv">${esc(val)}</td>` +
        `<td><button type="button" data-copy="${esc(val)}">copy</button></td></tr>`)
      .join("");
  }

  // Delegated: the rows are rebuilt on every keystroke.
  $("mk-hand-rows").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("button[data-copy]") as HTMLButtonElement | null;
    if (!b) return;
    void navigator.clipboard.writeText(b.dataset.copy!).then(
      () => { b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1200); },
      () => { b.textContent = "copy failed"; },
    );
  });
  for (const id of ["mk-name", "mk-sym", "mk-tax", "mk-desc", "mk-site", "mk-x", "mk-tg"]) {
    // `recompute` as well as `handoff`: in the one-transaction shape these
    // fields decide whether the button that signs is enabled, and a form whose
    // button stays dead while you type into it reads as broken.
    $(id).addEventListener("input", () => { handoff(); recompute(); });
  }

  /**
   * What the creator typed for Pons, or the reason it cannot be sent.
   *
   * Shared by the two paths — the three-signature one reads it when step 2's
   * button is pressed, the one-transaction one before it signs anything. A
   * second copy of these eleven reads is a second place for the percent/bps
   * conversion and the `badInput` check to go missing.
   */
  function launchInput(): LaunchInput | string {
    const input: LaunchInput = {
      name: ($("mk-name") as HTMLInputElement).value.trim(),
      symbol: ($("mk-sym") as HTMLInputElement).value.trim(),
      logo: ($("mk-logo") as HTMLInputElement).value.trim(),
      description: ($("mk-desc") as HTMLInputElement).value.trim(),
      website: ($("mk-site") as HTMLInputElement).value.trim(),
      x: ($("mk-x") as HTMLInputElement).value.trim(),
      telegram: ($("mk-tg") as HTMLInputElement).value.trim(),
      creatorTaxBps: bpsFromPct(Number(($("mk-tax") as HTMLInputElement).value)),
      buyAmount: 0n,
    };
    if (!input.name || !input.symbol) return "a name and a ticker are required";

    // Typed in ether and spent in wei. `parseEther` throws on anything that is
    // not a number, which is the whole point: this value travels in `value`
    // next to the launch fee, and a wrong one is spent, not rejected.
    const buyEl = $("mk-buy") as HTMLInputElement;
    // **An empty `value` is not the same as an empty FIELD.** `type="number"`
    // hands back "" for anything it could not parse, and what counts as
    // parseable depends on the browser's locale -- the field renders `0,009` on
    // a French one. Read as "no first buy", that silently launches without the
    // purchase the creator just typed, and the launch cannot be redone.
    // `badInput` is the only thing that tells the two apart.
    if (buyEl.validity.badInput) return "the first buy is not a number the browser could read";
    const raw = buyEl.value.trim();
    try {
      input.buyAmount = raw === "" ? 0n : parseEther(raw);
    } catch {
      return "the first buy must be an amount in ETH";
    }
    if (input.buyAmount < 0n) return "the first buy cannot be negative";
    const logo = checkLogo(input.logo, GATEWAYS);
    if (!logo.ok) return `logo: ${logo.why}`;
    return input;
  }

  // --- step 2: the launch on Pons ----------------------------------------
  const launchBtn = $("mk-launch") as HTMLButtonElement;
  launchBtn.addEventListener("click", async () => {
    if (!mine) return out2("prepare the payout first", true);
    const input = launchInput();
    if (typeof input === "string") return out2(input, true);

    launchBtn.disabled = true;
    try {
      const eth = provider();
      if (!eth) return out2("connect a wallet first — the Connect button, top right", true);
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) return out2("the wallet returned no account", true);

      const factory = (await pub.readContract({
        address: pad, abi: padAbi, functionName: "PONS_FACTORY",
      })) as Address;

      launched = await launchOnPons(factory, mine, account, input, out2);
      $("mk-out2").innerHTML = `<p>Launched: <span class="mono">${esc(launched)}</span></p>`;
      ($("mk-token") as HTMLInputElement).value = launched;
      step(3);
    } catch (e) {
      out2("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 160), true);
      launchBtn.disabled = false;
    }
  });

  // --- step 3: bind -----------------------------------------------------
  const bindBtn = $("mk-bind") as HTMLButtonElement;
  bindBtn.addEventListener("click", async () => {
    if (!mine) return out3("prepare the payout first", true);
    const typed = ($("mk-token") as HTMLInputElement).value.trim();
    const target = (typed || launched || "") as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) return out3("paste the token address", true);

    bindBtn.disabled = true;
    try {
      const eth = provider();
      if (!eth) return out3("connect a wallet first — the Connect button, top right", true);
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) return out3("the wallet returned no account", true);

      // The same conditions as `bind`, read BEFORE sending. The contract
      // re-checks them -- this replaces nothing, it explains. A bare
      // `NotOurLaunch` in a wallet does not say WHICH of the four gave way, and
      // that is precisely what you need to know coming back from Pons's site.
      out3("checking the launch…");
      const factory = (await pub.readContract({
        address: pad, abi: padAbi, functionName: "PONS_FACTORY",
      })) as Address;
      const [l, launcher, vaultQuote] = await Promise.all([
        pub.readContract({ address: factory, abi: ponsRegistryAbi, functionName: "getLaunchedToken", args: [target] }),
        pub.readContract({ address: mine, abi: vaultBindAbi, functionName: "LAUNCHER" }) as Promise<Address>,
        // Read FROM THE VAULT and not taken from the selector: at step 3 the
        // vault may come from an earlier session, or from a launch made on
        // Pons's site. The selector only says what this browser chose; the vault
        // says what `bind` is going to compare.
        pub.readContract({ address: mine, abi: vaultBindAbi, functionName: "QUOTE" }) as Promise<Address>,
      ]);
      const problems = diagnose(l as never, mine, launcher, vaultQuote);
      if (problems.length > 0) {
        $("mk-diag").className = "out bad";
        $("mk-diag").innerHTML =
          `<p>This launch cannot be bound to this payout:</p><ul>${
            problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
        bindBtn.disabled = false;
        return;
      }
      $("mk-diag").className = "out";
      $("mk-diag").textContent = "";

      const hash = await bindVault(mine, target, account, out3);
      $("mk-out3").innerHTML =
        `<p>Bound. Fees now arrive at your token's payout. <a href="${EXPLORER}/tx/${hash}">transaction</a></p>`;
    } catch (e) {
      out3("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 160), true);
      bindBtn.disabled = false;
    }
  });

  recompute();

  // Last, because `probeOneShot` hides `mk-launch` and reshapes step 2 — both
  // declared above it. Called after the first `recompute` so the button's label
  // is written once, by whichever of the two runs second.
  //
  // **And again when a wallet is actually picked**, which is the whole reason
  // this exists. At page load nothing is connected: `eth_accounts` comes back
  // empty and the probe returns having learnt nothing. It used to listen for
  // `accountsChanged` on `provider()` — read at MOUNT, so on the wallet the
  // visitor had not chosen yet, and MetaMask does not reliably fire it on a
  // first connection anyway. `onViewer` is the signal that means it: `connectWith`
  // calls `setViewer` after `useWallet` and after the chain switch, so by then
  // `provider()` is the chosen wallet and it is on the right chain.
  probeNow = () => { void probeOneShot(); };
  if (!probeHooked) {
    probeHooked = true;
    onViewer(() => probeNow?.());
  }
  void probeOneShot();
}
