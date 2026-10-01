/**
 * buildroot.ts — which payout rule builds this vault's root.
 *
 * **One entry point, every caller.** The keeper publishes, `dispute.ts`
 * verifies, `cosign.ts` co-signs, `watch.ts` watches and `recompute.ts`
 * cross-checks — and all five must reach the SAME root for the same vault, or
 * an honest publication reads as fraud. That was already true when one mode
 * existed; a second one makes it a question with an answer to look up, and
 * looking it up in five places is how four of them end up right.
 *
 * The answer comes from the chain and from nothing else: the vault names its
 * registry, the registry names the vault's mode (`Payd.modeOf`, stamped at
 * birth by the factory that built it and never written again). No flag, no
 * environment variable, nothing a keeper could get wrong and nothing a verifier
 * has to be told.
 */
import { createPublicClient, http, stringToHex, type Address, type Hex } from "viem";
import { RPC_URL } from "./config.js";
import { feeVaultAbi, registryAbi } from "./abis.js";
import { buildCumulative, plainAccrual, type BuiltCumulative, type WindowAccrual } from "./epoch.js";
import { tontineAccrual } from "./tontine.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 400 }) });

/** The stamp every vault carried before there was a second mode to tell apart. */
export const MODE_DISTRIBUTION = stringToHex("distribution", { size: 32 });
/** Burn-to-redeem: no root, no keeper. It never reaches this file. */
export const MODE_BACKING = stringToHex("backing", { size: 32 });
/** Distribution's calendar and machinery, one rule harsher. */
export const MODE_TONTINE = stringToHex("tontine", { size: 32 });
/** A pot and one winner per draw. It publishes a TICKET tree, not a cumulative
 *  one, so it deliberately has no rule below: `lottery.ts` builds its root and
 *  `keeper.ts` routes to it before this file is reached. Anything landing here
 *  with this stamp is a caller that skipped the dispatcher. */
export const MODE_LOTTERY = stringToHex("lottery", { size: 32 });

/**
 * The personal-portfolio mode.
 *
 * **Its root IS the distribution mode's, and that is a design result rather
 * than a shortcut.** The vault funds ONE line — the pivot — so a holder's
 * cumulative is denominated in USDG and `plainAccrual` builds it with no rule
 * of its own. What each holder is paid IN is decided at delivery, by
 * `PortfolioDistributor` reading `PortfolioBook`, and never by the tree. So
 * eligibility, exclusions, the trees and the CID are the default mode's,
 * unexamined and unchanged.
 *
 * **One thing is not: the push target, and `PORTFOLIO_PUSH_TARGET_DIV` is it.**
 */
export const MODE_PORTFOLIO = stringToHex("portfolio", { size: 32 });

/**
 * The portfolio mode's push target is a TENTH of the standard one — ~$1 of
 * outstanding pivot rather than ~$10.
 *
 * **Because in this mode the push tree grants permission and the planner
 * decides the spend.** Everywhere else the two are the same act: an entry in
 * `pushRoot` is delivered, once, for the amount it names. Here an entry is a
 * pivot balance that `stepConvert` then cuts into one swap per stock the holder
 * chose, and it is THOSE slices that have to carry their own gas —
 * `offchain/src/portfolio.ts`, `LINE_FLOOR_USD`, measured.
 *
 * Leaving the target at ~$10 would have set the entry bar ten times higher than
 * anything the economics ask for: a holder with $3 and two lines of $1.50 can
 * be served at a profit and would never have been in the tree to be served at
 * all. A tenth puts the tree just under the planner, so the planner is always
 * the binding gate and the tree never silently is.
 *
 * **It is not a dated rule and does not need to be.** Every rule that changes
 * what a root contains is dated here, so that `dispute.ts` still reproduces
 * what was published; this one is keyed on the mode stamp instead, which is
 * written at birth and never written again. A portfolio vault therefore has
 * had this target since its epoch 0, whenever it is rebuilt — and no other
 * mode's roots move by a wei.
 */
export const PORTFOLIO_PUSH_TARGET_DIV = 10n;

/** Modes that publish roots, and the rule each one's roots are built by. */
const RULES: ReadonlyMap<Hex, WindowAccrual> = new Map([
  [MODE_DISTRIBUTION, plainAccrual],
  [MODE_TONTINE, tontineAccrual],
  [MODE_PORTFOLIO, plainAccrual],
]);

/**
 * Both reads below are of write-once state — `FeeVault.REGISTRY` is set by
 * `init`, and the mode is "stamped at birth by the factory that built it and
 * never written again", which is the paragraph above. The co-signer calls
 * `buildRoot` once per HTTP request AND once per on-chain request it polices,
 * so this was two sequential round trips on every rebuild of every root.
 *
 * A zero answer is not cached: that is a vault this node could not read, not a
 * vault with no mode.
 */
const modeCache = new Map<Address, Hex>();

export async function modeOfVault(vault: Address): Promise<Hex> {
  const known = modeCache.get(vault);
  if (known) return known;
  const registry = await client.readContract({ address: vault, abi: feeVaultAbi, functionName: "REGISTRY" });
  const mode = await client.readContract({
    address: registry as Address, abi: registryAbi, functionName: "modeOf", args: [vault],
  }) as Hex;
  if (mode !== ZERO32) modeCache.set(vault, mode);
  return mode;
}

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

/**
 * The root for `vault`, built under its own mode's rule.
 *
 * **An unknown mode throws.** Falling back to the distribution rule would
 * publish a root that is wrong in exactly the way nobody notices: every proof
 * verifies, every amount is plausible, and the holders of a mode we did not
 * understand are paid by somebody else's promise. A mode that publishes
 * nothing (backing) never gets here — `keeper.ts` decides that before the
 * build — so reaching this line with an unknown stamp is a keeper that has
 * been upgraded past its own dispatcher.
 */
export async function buildRoot(distributor: Address, vault: Address, upToEpoch: number): Promise<BuiltCumulative> {
  const mode = await modeOfVault(vault);
  const rule = RULES.get(mode);
  if (!rule) throw new Error(`vault ${vault}: no root rule for mode ${mode}`);
  const div = mode === MODE_PORTFOLIO ? PORTFOLIO_PUSH_TARGET_DIV : undefined;
  return buildCumulative(distributor, vault, upToEpoch, rule, div);
}
