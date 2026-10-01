/**
 * WHICH PAYOUT MODE a vault was born under, and what that changes on screen.
 *
 * **The app used to assume there was only one.** Every vault reached from the
 * index was read with the distribution ABI and drawn with the claim table, and
 * that was true for exactly as long as `Payd` held one factory. It holds four
 * now (`factoryMode`), `createVaultWith` is permissionless once a mode is
 * enabled, and three of them pay their holders through a contract that answers
 * none of `Distributor`'s calls:
 *
 *  - **distribution** — `Distributor`, a cumulative owed per holder, `claim`;
 *  - **tontine** — `DistributorV3` VERBATIM (`TontineFactory.sol:49`), so the
 *    same reads and the same claim button. Only the accrual differs, and that
 *    is the keeper's side of it;
 *  - **backing** — `BackingRedeemer`. No root, no epoch table: a holder burns
 *    their tokens and takes their share of the pot, and `redeem` is the ONLY
 *    payment path there is;
 *  - **lottery** — `LotteryDistributor`. One winner per draw, paid by
 *    `collect` against the draw's ticket tree;
 *  - **portfolio** — `PortfolioDistributor`, which IS a `DistributorV3`, so the
 *    same reads and the same claim button. Its tree names one stock, the pivot,
 *    so `claim` pays USDG; what a holder is normally paid in is decided by the
 *    row they write in that launch's `PortfolioBook` and converted in the
 *    delivery itself. The row is the mode, so this is the one mode that needs a
 *    screen the app WRITES through and not only reads — `portfolio.ts`.
 *
 * A vault of the wrong mode does not fail loudly: `DISTRIBUTOR()` answers, the
 * reads that follow revert one by one, and the page ends up showing an empty
 * claim table — which reads as "you are owed nothing". That is the failure this
 * file exists to prevent, and it is why the mode is read from the REGISTRY
 * (`Payd.modeOf`, stamped at birth) and never inferred from what a contract
 * happens to answer.
 */
import { encodeAbiParameters, hexToString, type Address, type Hex } from "viem";

/** The five `MODE` strings, as their factories declare them. `unknown` is a
 *  mode this build has never heard of — a sixth factory enabled after it was
 *  published — and it is a state the page must be able to draw, not a bug. */
export const MODES = ["distribution", "tontine", "backing", "lottery", "portfolio"] as const;
export type Mode = typeof MODES[number] | "unknown";

/** `bytes32` → the name, or `unknown`. A right-padded ASCII string is what
 *  `bytes32 public constant MODE = "tontine"` actually is; anything that does
 *  not decode to one of ours is not guessed at. */
export function modeName(raw: Hex | null | undefined): Mode {
  if (!raw) return "unknown";
  let s: string;
  try {
    s = hexToString(raw, { size: 32 });
  } catch {
    return "unknown";
  }
  // `hexToString` stops at the padding, but a malformed word can still carry
  // control bytes — and they would reach the DOM as an attribute. Rejected
  // rather than stripped: a word that needs stripping to match is not the
  // constant a factory declares, and pretending otherwise is how the page
  // would treat a near-miss as the real mode.
  if (/[^\x20-\x7e]/.test(s)) return "unknown";
  return (MODES as readonly string[]).includes(s) ? (s as Mode) : "unknown";
}

/**
 * Which screen pays a holder under this mode — the whole reason the mode is
 * read at all.
 *
 * `unknown` maps to `none` and NOT to `claim`: a mode this build predates is
 * one whose payment path it cannot know, and offering the claim button anyway
 * is how a holder pays gas for a revert. The panel says so in words instead.
 */
export type PayScreen = "claim" | "redeem" | "draw" | "none";
export function payScreen(m: Mode): PayScreen {
  switch (m) {
    case "distribution":
    case "tontine":
    // **The portfolio claims like the other two, and that is not a shortcut.**
    // Its distributor inherits `claim` unchanged, and its tree carries one
    // stock — the pivot — so the claim table draws one row in USDG and the
    // button works. What the mode ADDS is the row a holder writes, which is a
    // panel beside this screen (`main.ts`) and not a payment path of its own:
    // a holder who never writes one is paid the creator's default basket, and
    // one who never waits for a conversion takes the pivot here.
    case "portfolio":
      return "claim";
    case "backing":
      return "redeem";
    case "lottery":
      return "draw";
    default:
      return "none";
  }
}

/** What the index row's chip says. The distribution mode gets no chip: it is
 *  the default and 100 % of the launches at the time of writing, so a chip on
 *  every row would be noise rather than information. */
export function modeChip(m: Mode): string {
  return m === "distribution" ? "" : m === "unknown" ? "other mode" : m;
}

/** One line under the launch's title, so a visitor knows what this page pays
 *  before they look for a button that is not there. */
export function modeBlurb(m: Mode): string {
  switch (m) {
    case "distribution":
      return "The fees buy a basket of stocks, and every holder's share is theirs to collect.";
    case "tontine":
      return "The fees buy a basket of stocks, part of the token is burnt or locked as liquidity, "
        + "and the rest is shared between the holders who stayed.";
    case "backing":
      return "The fees buy a basket of stocks and the pot stays here: burn your tokens to take your "
        + "share of it. There is no other way to be paid under this mode.";
    case "lottery":
      return "The fees buy a basket of stocks, and each draw pays one holder — drawn from a public "
        + "randomness beacon nobody here controls. Holding longer buys more tickets.";
    case "portfolio":
      return "The fees are converted to dollars here, and you choose what they buy for you: "
        + "name any stocks the platform allows and your share is converted into yours, "
        + "automatically. Choose nothing and you are paid the creator's basket.";
    default:
      return "This launch was created under a payout mode this page does not know. "
        + "It can still be read on the explorer.";
  }
}

/** The registry call that answers all of it. Declared here rather than in
 *  `chain.ts` so the file that decides what a mode MEANS also owns how it is
 *  read. */
export const modeOfAbi = [
  {
    type: "function",
    name: "modeOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/**
 * The mode of one vault.
 *
 * `distribution` when there is no registry to ask: a build pinned to a single
 * launch (`?vault=`, `docs/LAUNCH_NIGHT.md`) predates every other mode, and
 * refusing to draw its page because a registry was not configured would break
 * the one deployment that has been live the longest.
 */
export async function readMode(
  read: (registry: Address, vault: Address) => Promise<Hex>,
  registry: Address | null,
  vault: Address,
): Promise<Mode> {
  if (!registry) return "distribution";
  try {
    return modeName(await read(registry, vault));
  } catch {
    // A registry that will not answer is not a reason to guess: the caller
    // draws the "mode unknown" state, which says the page could not read it.
    return "unknown";
  }
}

// ------------------------------------------------------ the per-launch parameter

/**
 * `modeData` — the one parameter a mode reads at birth, forwarded by
 * `createVaultWith` and never decoded by the registry (`Payd.sol`, the comment
 * above `createVaultWith`: "opaque ON PURPOSE").
 *
 * Each factory decodes it its own way and reverts with `BadModeData` on
 * anything else. The bounds below are those factories' own constants, repeated
 * here for ONE reason: to say no before a creator pays for a revert. They are
 * not the authority — the contract is — and `modes.test.ts` pins them to the
 * values `TontineFactory` and `LotteryFactory` declare.
 */
export const MIN_LEG_BPS = 500;
export const MAX_LEGS_BPS = 5_000;
export const MIN_POT_BPS = 500;
export const MAX_POT_BPS = 5_000;

/**
 * **The two denominators, and the conversion between them.**
 *
 * The contracts measure the legs against the HOLDERS' SHARE, not against what
 * the token collects. `FeeVaultV2._fundLegs` takes `legsBps` of what a basket
 * purchase spent, and that purchase is funded out of `rewardsPool`, which is
 * `rewardsBps` of gross; inside the legs, `V2Legs.fund` splits by
 * `burnBps / (burnBps + lpBps)`, so the pair is a slice of a slice and a ratio
 * within it.
 *
 * The creation form used to hand those contract units straight to the creator,
 * beside a holders' figure measured against the whole. Three inputs, two
 * denominators, nothing on screen saying which was which — so **70 / 10 / 10
 * and 90 / 10 / 10 were both accepted and neither meant what it read.** At 90
 * the holders' line was really 72, and the form's own bar said so while the
 * field above it said 90.
 *
 * So the form now asks the three questions in ONE unit — what each of them is
 * out of what the token collects — and these two functions are the only place
 * the other unit exists. `toContract` is what `createVault` and `modeDataFor`
 * are given; `toSplit` is its inverse, and `modes.test.ts` round-trips them.
 */
export interface Split {
  /** What holders actually receive, in bps of what the token collects. */
  holdersBps: number;
  /** Burnt, same unit. */
  burnBps: number;
  /** Locked as liquidity, same unit. */
  lpBps: number;
}

export interface ContractSplit {
  /** `Payd.createVault`'s `rewardsBps`: holders AND the legs, because the legs
   *  are funded from inside it. */
  rewardsBps: number;
  /** `modeData`'s burn leg, in bps OF `rewardsBps`. */
  burnBps: number;
  /** `modeData`'s LP leg, in bps OF `rewardsBps`. */
  lpBps: number;
}

/**
 * What the chain is asked for, from what the creator typed.
 *
 * `rewardsBps` is the sum, because everything the legs consume is taken from
 * it. The legs are then re-expressed against that sum, which is integer
 * division and therefore lossy by at most one bps — about 0.005 points of the
 * total. The form never shows the typed figure back: it recomputes the bar from
 * THIS result, so what is on screen is what the vault will do.
 */
export function toContract(s: Split): ContractSplit {
  const rewardsBps = s.holdersBps + s.burnBps + s.lpBps;
  if (rewardsBps <= 0) return { rewardsBps: 0, burnBps: 0, lpBps: 0 };
  let burnBps = Math.round((s.burnBps * 10_000) / rewardsBps);
  let lpBps = Math.round((s.lpBps * 10_000) / rewardsBps);
  // **Both roundings can go up, and then the pair is one bps past the cap.**
  // `legs.test.ts` walks every combination the spinner reaches and finds it:
  // 16 held with 5 burnt and 11 locked is legal in the creator's unit — the
  // legs exactly equal the holders' line — and encodes as 1563 + 3438 = 5001
  // of 3200, which `_decodeLegs` reverts on. It is an artifact of the division
  // and never something anybody asked for, so the excess comes off the LARGER
  // leg, where one bps is the smaller relative change.
  // **Only a rounding artifact is absorbed here, and one bps per leg is all it
  // can ever be.** Taking a larger excess off the larger leg silently
  // REPROPORTIONS a pair the creator typed: 10 held with 10 burnt and 10 locked
  // — which the form must never offer, the legs exceeding the holders' line —
  // encodes as 3333 + 3333 of 3000 and came back out as 5 % burnt beside 10 %
  // locked, a split nobody asked for and no error named. So the artifact is
  // absorbed and a real violation is left standing, where `modeDataFor` refuses
  // it and the screen disables its button.
  const over = burnBps + lpBps - MAX_LEGS_BPS;
  if (over > 0 && over <= 2) {
    if (burnBps >= lpBps) burnBps -= over;
    else lpBps -= over;
  }
  return { rewardsBps, burnBps, lpBps };
}

/** The inverse: what a vault built with `c` actually pays, in the creator's
 *  unit. This is what the split bar draws, so the bar can never flatter the
 *  rounding above. */
export function toSplit(c: ContractSplit): Split {
  const burnBps = Math.round((c.rewardsBps * c.burnBps) / 10_000);
  const lpBps = Math.round((c.rewardsBps * c.lpBps) / 10_000);
  return { holdersBps: Math.max(0, c.rewardsBps - burnBps - lpBps), burnBps, lpBps };
}

/**
 * The two leg bounds, restated in the CREATOR's unit.
 *
 * `MIN_LEG_BPS` and `MAX_LEGS_BPS` are measured against `rewardsBps`, which is
 * holders plus legs — so in the unit the form now asks in, where every figure
 * is a share of what the token collects, they come out as two plain sentences:
 *
 *   - **the legs together can never exceed the holders' line.** `b + l` at most
 *     half of `h + b + l` is exactly `b + l <= h`;
 *   - **a leg is off, or at least a twentieth of the three together.** `b` at
 *     least a twentieth of `h + b + l` is `b >= (h + l) / 19`.
 *
 * Both are derived, not chosen, which is why they live beside the constants
 * they come from rather than in the screen. `modes.test.ts` checks each against
 * `toContract` rather than against the algebra, so a slip in the rearrangement
 * fails there and not on someone's launch.
 */
export function legCeiling(holdersPct: number): number {
  return Math.max(0, holdersPct);
}
export function legFloor(holdersPct: number, otherPct: number): number {
  return Math.ceil((holdersPct + otherPct) / 19);
}

/**
 * The nearest PAIR of shares, in percent, that the chain will actually take.
 *
 * **`min` and `step` on a number input cannot say "off, or at least 5 %".**
 * With `min="0"` the field accepts 3, and `_decodeLegs` reverts `BadModeData`
 * on it — as does a pair adding up past 50 %, which no per-field `max` can
 * express either. The creation screen already refuses to SUBMIT those, but
 * refusing afterwards leaves the creator reading an error about a value the
 * spinner had just offered them.
 *
 * Here rather than in the screen because the bounds are here, and so is the
 * encoder that enforces them: a field and a refusal that read the same two
 * constants cannot disagree.
 *
 * @param burnPct     what the burn field holds
 * @param lpPct       what the LP field holds
 * @param holdersPct  the holders' field — both bounds are read against it
 * @param edited      which field was just changed; it keeps its value and the
 *                    other yields, because that is what editing a form means
 */
export function snapLegs(
  burnPct: number,
  lpPct: number,
  holdersPct: number,
  edited: "burn" | "lp",
): { burnPct: number; lpPct: number } {
  const clean = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const h = clean(holdersPct);
  // The edited field is the one that keeps what was typed; the other yields.
  // Snapping them one at a time cannot work, because in this unit **each leg's
  // floor depends on the other** — `legFloor(h, other)` — so a burn of 2 that
  // was legal beside an empty LP becomes illegal the moment the LP is set to 3,
  // and nothing would go back to fix it. Measured over the reachable space, 85
  // such pairs; the sequential snap produced every one of them.
  let x = clean(edited === "burn" ? burnPct : lpPct);
  let y = clean(edited === "burn" ? lpPct : burnPct);

  for (let i = 0; i < 4; i++) {
    const before = `${x}:${y}`;
    // Neither leg, nor the pair, may exceed the holders' line.
    if (x > h) x = h;
    if (x + y > h) y = Math.max(0, h - x);
    // Then the floors, each read against what the other currently holds. A leg
    // with no legal value between its floor and the room left is off, which is
    // always a legal answer.
    const fy = legFloor(h, x);
    if (y > 0 && y < fy) y = fy <= h - x ? fy : 0;
    const fx = legFloor(h, y);
    if (x > 0 && x < fx) x = fx <= h - y ? fx : 0;
    if (`${x}:${y}` === before) break;
  }
  // A pair that still will not settle is one the holders' line cannot hold at
  // all. Turning the leg that was NOT edited off is always legal: it leaves the
  // other its own floor of `ceil(h / 19)`, which never exceeds `h`.
  if (x + y > h || (x > 0 && x < legFloor(h, y)) || (y > 0 && y < legFloor(h, x))) {
    y = 0;
    if (x > h) x = h;
    const fx = legFloor(h, 0);
    if (x > 0 && x < fx) x = fx <= h ? fx : 0;
  }
  return edited === "burn" ? { burnPct: x, lpPct: y } : { burnPct: y, lpPct: x };
}

/** The pot has no "off": a lottery with no pot share is refused outright, so
 *  this one is a plain clamp between the two bounds. */
export function snapPot(pct: number): number {
  const lo = MIN_POT_BPS / 100, hi = MAX_POT_BPS / 100;
  const v = Number.isFinite(pct) ? Math.round(pct) : lo;
  return Math.min(hi, Math.max(lo, v));
}

export interface ModeParams {
  /** Tontine: the share of each purchase burnt, and the share locked as
   *  liquidity. Either may be zero; neither may be a dust leg. */
  burnBps?: number;
  lpBps?: number;
  /** Lottery: the share of the pot one draw pays its winner. */
  potBps?: number;
}

/**
 * The encoded parameter, or the reason it cannot be encoded.
 *
 * A rejection is returned rather than thrown: this runs on every keystroke of
 * the creation form, and the message belongs next to the field.
 */
export function modeDataFor(mode: Mode, p: ModeParams): { data: Hex; error?: string } {
  const EMPTY = "0x" as Hex;
  switch (mode) {
    case "backing":
      // It refuses anything at all — `BackingFactory` reverts
      // `UnexpectedModeData`: the pot IS the payout, and a slice taken out of
      // it would be a slice taken out of the backing.
      return { data: EMPTY };


    // **The same parameter, and that is not a coincidence.**
    // `DistributionFactoryV3._decodeLegs` and `TontineFactory._decodeLegs` are
    // the same twelve lines over the same two bounds: a distribution vault
    // built through V3 can carry the burn and locked-LP legs exactly as a
    // tontine does. What differs between the two modes is who the REST is paid
    // to, not whether the legs exist.
    case "distribution":
    case "tontine":
    // **And the portfolio, since 2026-09-22.** It nearly shipped without the
    // legs: every other mode clones the deployed `FeeVaultV2`, which carries
    // them, and this one is built on `BaseModeVault` because it buys no basket
    // — so it left them behind without anyone deciding that a creator whose
    // holders choose must give up buy-and-burn. They do not compete: the legs
    // take their slice of the QUOTE before the pivot hop, and the row decides
    // what the REST becomes.
    case "portfolio": {
      const burn = p.burnBps ?? 0;
      const lp = p.lpBps ?? 0;
      // Empty IS the way to say "no legs" — `(0, 0)` spelled out is refused, so
      // there is exactly one encoding per intention (`_decodeLegs`).
      if (burn === 0 && lp === 0) return { data: EMPTY };
      if (burn !== 0 && burn < MIN_LEG_BPS) return { data: EMPTY, error: `a burn leg is off or at least ${MIN_LEG_BPS / 100} %` };
      if (lp !== 0 && lp < MIN_LEG_BPS) return { data: EMPTY, error: `a liquidity leg is off or at least ${MIN_LEG_BPS / 100} %` };
      if (burn + lp > MAX_LEGS_BPS) return { data: EMPTY, error: `the two legs cannot take more than ${MAX_LEGS_BPS / 100} % together` };
      return {
        data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(burn), BigInt(lp)]),
      };
    }

    case "lottery": {
      const pot = p.potBps ?? 0;
      // No default: a lottery with no pot share is a bug, and the factory says
      // so by refusing an empty `modeData` outright.
      if (pot < MIN_POT_BPS || pot > MAX_POT_BPS) {
        return { data: EMPTY, error: `the pot share is between ${MIN_POT_BPS / 100} % and ${MAX_POT_BPS / 100} %` };
      }
      return { data: encodeAbiParameters([{ type: "uint256" }], [BigInt(pot)]) };
    }

    default:
      return { data: EMPTY, error: "this build does not know what this mode expects" };
  }
}
