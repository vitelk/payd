import fs from "node:fs";
import { stringToHex } from "viem";
import {
  MAX_LEGS_BPS, MAX_POT_BPS, MIN_LEG_BPS, MIN_POT_BPS,
  modeDataFor, modeName, payScreen, readMode, MODES, type Mode, type PayScreen,
} from "./modes.js";

let bad = 0;
const eq = (got: unknown, want: unknown, what: string) => {
  if (got === want) return;
  console.error(`  FAIL ${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  bad++;
};

// The five `MODE` constants, exactly as the factories declare them: a
// right-padded ASCII word in a bytes32.
for (const m of MODES) {
  eq(modeName(stringToHex(m, { size: 32 })), m, `${m} decodes to itself`);
}

// Anything else is `unknown` and NOT a guess. A fifth factory enabled after
// this build was published is the case that matters: it must draw a state, not
// fall through to the claim table.
eq(modeName(stringToHex("carousel", { size: 32 })), "unknown", "a name we do not know stays unknown");
eq(modeName(`0x${"0".repeat(64)}`), "unknown", "and so does an empty word");
eq(modeName(null), "unknown", "…and a read that returned nothing");
eq(modeName(`0x${"ff".repeat(32)}`), "unknown", "junk bytes do not decode into a mode");

// Control bytes never reach the DOM through a mode name.
eq(modeName(stringToHex("tontine", { size: 32 })), "unknown", "a control byte is not trimmed into a valid mode");

// THE DECISION this file exists for: which button pays a holder.
const screen: [Mode, PayScreen][] = [
  ["distribution", "claim"],
  ["tontine", "claim"],       // DistributorV3 verbatim — the same claim path
  ["backing", "redeem"],      // burn is the only payment path
  ["lottery", "draw"],
  // The portfolio's distributor IS a DistributorV3 and inherits `claim`
  // unchanged; its tree names one stock, the pivot, so the claim table pays
  // dollars. The row a holder writes is a panel BESIDE that table, not a
  // payment path of its own — which is why this is "claim" and not a fifth
  // screen.
  ["portfolio", "claim"],
  ["unknown", "none"],        // never "claim": gas for a certain revert
];
for (const [m, want] of screen) eq(payScreen(m), want, `${m} pays through ${want}`);

// A build with no registry is the single-launch deployment that predates every
// other mode. It reads as distribution rather than refusing to draw.
const never = () => { throw new Error("must not be read"); };
eq(await readMode(never, null, "0x1" as never), "distribution", "no registry: the historical single launch");

// A registry that will not answer says so. It must not fall back to
// distribution — that is how a backing vault gets a claim table.
eq(await readMode(async () => { throw new Error("429"); }, "0x9" as never, "0x1" as never), "unknown",
  "a registry that did not answer leaves the mode unknown");
eq(await readMode(async () => stringToHex("lottery", { size: 32 }), "0x9" as never, "0x1" as never), "lottery",
  "…and one that does answer decides it");

// --------------------------------------------------- the per-launch parameter

// THE BOUNDS ARE THE FACTORIES'. Read out of the Solidity rather than retyped
// from memory: the form rejects a value before the creator pays for a revert,
// and a copy that drifts either refuses a legal launch or promises an illegal
// one. Both are only visible at somebody's expense.
const solc = (file: string, name: string): number => {
  const src = fs.readFileSync(new URL(`../../contracts/${file}`, import.meta.url), "utf8");
  const m = new RegExp(`uint256 public constant ${name} = ([0-9_]+);`).exec(src);
  if (!m) throw new Error(`${name} not found in ${file} — the contract moved and this check is blind`);
  return Number(m[1]!.replace(/_/g, ""));
};
eq(MIN_LEG_BPS, solc("tontine/TontineFactory.sol", "MIN_LEG_BPS"), "the tontine's minimum leg is the factory's");
eq(MAX_LEGS_BPS, solc("tontine/TontineFactory.sol", "MAX_LEGS_BPS"), "…and so is the cap on the two together");
// The SAME two, on the distribution mode's V3 factory: the legs are not a
// tontine feature, they are a V3 feature that the tontine also has. One
// encoder serves both, and it may only do so while these four agree.
eq(MIN_LEG_BPS, solc("distribution/v3/DistributionFactoryV3.sol", "MIN_LEG_BPS"),
  "distribution V3 takes the same minimum leg");
eq(MAX_LEGS_BPS, solc("distribution/v3/DistributionFactoryV3.sol", "MAX_LEGS_BPS"),
  "…and the same cap on the two together");
eq(MIN_POT_BPS, solc("lottery/LotteryFactory.sol", "MIN_POT_BPS"), "the lottery's minimum pot share is the factory's");
eq(MAX_POT_BPS, solc("lottery/LotteryFactory.sol", "MAX_POT_BPS"), "…and so is its maximum");

// Neither mode takes a parameter, and the backing factory REFUSES one
// (`UnexpectedModeData`), so empty is the only encoding.
eq(modeDataFor("distribution", {}).data, "0x", "a distribution vault with no legs passes nothing");
eq(modeDataFor("backing", { potBps: 1_000, burnBps: 1_000 }).data, "0x",
  "the backing mode drops whatever it is handed — its factory refuses any modeData");
// The legs, on the DEFAULT mode. This is the case that was missing: V3 takes
// them, so a distribution launch can burn and lock liquidity like a tontine.
eq(modeDataFor("distribution", { burnBps: 1_000, lpBps: 1_500 }).data,
  modeDataFor("tontine", { burnBps: 1_000, lpBps: 1_500 }).data,
  "distribution encodes its legs exactly as the tontine does");
eq(!!modeDataFor("distribution", { burnBps: 100 }).error, true, "and is bounded the same way");

// The tontine: empty IS "no legs". `(0, 0)` spelled out is refused by the
// factory, so there is exactly one encoding per intention.
eq(modeDataFor("tontine", {}).data, "0x", "no legs encodes as nothing at all");
eq(modeDataFor("tontine", { burnBps: 0, lpBps: 0 }).data, "0x", "…and so does asking for two zero legs");
eq(modeDataFor("tontine", { burnBps: 1_000, lpBps: 1_500 }).data,
  "0x00000000000000000000000000000000000000000000000000000000000003e8"
  + "00000000000000000000000000000000000000000000000000000000000005dc",
  "two legs encode as abi.encode(uint256,uint256), burn first");
eq(!!modeDataFor("tontine", { burnBps: 100 }).error, true, "a dust burn leg is refused here, not on-chain");
eq(!!modeDataFor("tontine", { lpBps: 499 }).error, true, "…and so is a dust liquidity leg");
eq(!!modeDataFor("tontine", { burnBps: 3_000, lpBps: 3_000 }).error, true, "the two legs cannot take more than half");
eq(modeDataFor("tontine", { burnBps: 2_500, lpBps: 2_500 }).error, undefined, "…and exactly half is legal");

// The lottery: no default, because a lottery with no pot share is a bug.
eq(modeDataFor("lottery", { potBps: 2_000 }).data,
  "0x00000000000000000000000000000000000000000000000000000000000007d0",
  "the pot share encodes as abi.encode(uint256)");
eq(!!modeDataFor("lottery", {}).error, true, "an unset pot share is refused");
eq(!!modeDataFor("lottery", { potBps: 499 }).error, true, "…and so is one below the floor");
eq(!!modeDataFor("lottery", { potBps: 5_001 }).error, true, "…or above the cap");

// A mode this build does not know cannot be built through from here.
// The portfolio takes the SAME parameter as V3 and the tontine, and it did not
// until 2026-09-22: the mode is built on `BaseModeVault` rather than on the
// deployed `FeeVaultV2`, so it left the burn and locked-LP legs behind without
// anyone deciding that a creator whose holders choose must give up
// buy-and-burn. A front that answered "0x" here would drop a creator's legs in
// silence, which is why this block is the same shape as the tontine's above.
eq(modeDataFor("portfolio", { burnBps: 1_000, lpBps: 1_500 }).data,
  modeDataFor("tontine", { burnBps: 1_000, lpBps: 1_500 }).data,
  "a portfolio launch encodes its legs exactly as a tontine does");
eq(modeDataFor("portfolio", {}).data, "0x", "no legs is still the empty parameter");
eq(modeDataFor("portfolio", {}).error, undefined, "...and that is an answer, not an error");
eq(!!modeDataFor("portfolio", { burnBps: 100 }).error, true, "a dust leg is refused here, not on-chain");
eq(!!modeDataFor("portfolio", { burnBps: 3_000, lpBps: 3_000 }).error, true,
  "and the pair still cannot take more than half");

eq(!!modeDataFor("unknown", {}).error, true, "an unknown mode has no parameter this form can produce");

// ---------------------------------------------------------------------------
// The factories the create screen names. The registry decides what each one IS
// — `create.ts` asks `factoryMode` and offers only what the chain answers — so
// what is checked here is the list itself: a duplicate would draw the same mode
// twice in the picker, and a typo would ask about an address that answers zero
// and silently drop a mode. Each entry was read on-chain 2026-09-24 with
// `cast call factoryMode`; the five modes below are what it answered.
(globalThis as { location?: unknown }).location = new URL("http://localhost/");
const { KNOWN_FACTORIES, DISTRIBUTION_FACTORY_V3 } = await import("./config.js");

eq(new Set(KNOWN_FACTORIES.map((f) => f.toLowerCase())).size, KNOWN_FACTORIES.length,
  "no factory is named twice");
for (const f of KNOWN_FACTORIES) {
  eq(/^0x[0-9a-fA-F]{40}$/.test(f), true, `${f} is an address`);
}
eq(KNOWN_FACTORIES.some((f) => f.toLowerCase() === DISTRIBUTION_FACTORY_V3.toLowerCase()), true,
  "the default factory is among them — the picker asks about it like the others");
eq(KNOWN_FACTORIES.length >= MODES.length, true,
  "every mode this build draws has at least one factory named for it");

if (bad) { console.error(`modes: ${bad} FAILED`); process.exit(1); }
console.log("modes: 48 checks OK — every MODE decodes, the pay button follows, modeData matches the factories, and the named factories are distinct");
