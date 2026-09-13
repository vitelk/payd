/**
 * Every ABI the web surfaces declare, checked against the COMPILED contracts.
 * `pnpm --filter front test` (needs `forge build` first — see the skip below).
 *
 * This exists because of a defect that no other test could have caught. The
 * detour route (`QUOTE → WETH → PIVOT`) added a `wethFee` field to
 * `Payd.quoteListing` and to `QuoteAllowed`; `front/src/create.ts` kept the
 * three-field shapes, and nothing went red:
 *
 *   - `quotes.test.ts` stubs `quoteListing`, so the stub and the declaration
 *     agreed with each other and both disagreed with the chain;
 *   - `tsc` sees a string literal, not a contract;
 *   - the fork tests exercise the contracts, never the page.
 *
 * On the live chain it would have been total, not subtle. An event's signature
 * IS its topic0, so `getLogs` for a `QuoteAllowed` of the wrong arity matches
 * NO log — the creation form would have offered native ETH and nothing else,
 * closing the 59 % of Pons volume quoted in USDG and stock tokens that the v2
 * design exists to serve. And `quoteListing` would have decoded `wethFee` as
 * `minBuy` and `minBuy` as `allowed`, throwing on the bool.
 *
 * So: compare the shapes, not the values. A name we do not declare is fine — an
 * ABI is allowed to be a subset. A name we DO declare with a different shape is
 * the bug, every time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbiItem, type AbiParameter } from "viem";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Ours. Anything else a surface declares — ERC-20, Pons, Uniswap, the Arbitrum
 *  gas oracle — is somebody else's ABI and not ours to check. */
const OURS = [
  "FeeVault", "Distributor", "Payd", "DistributionFactory",
  "Treasury", "Collector", "Timelock", "Bootstrap",
];

/** The directories whose `.ts` talk to the chain. */
const SURFACES = ["front/src", "sdk/src", "offchain/src"];

type AbiEntry = {
  type: string;
  name?: string;
  inputs?: readonly AbiParameter[];
  outputs?: readonly AbiParameter[];
};

/** A shape, flattened. Tuples recurse; `indexed` is part of an event's shape. */
function shape(xs: readonly AbiParameter[] = []): string {
  return xs
    .map((x) => {
      const t = x.type.startsWith("tuple")
        ? `(${shape((x as { components?: readonly AbiParameter[] }).components ?? [])})${x.type.slice(5)}`
        : x.type;
      return t + ((x as { indexed?: boolean }).indexed ? " indexed" : "");
    })
    .join(",");
}

const full = (e: AbiEntry): string =>
  e.type === "event"
    ? `event ${e.name}(${shape(e.inputs)})`
    : `function ${e.name}(${shape(e.inputs)})->(${shape(e.outputs)})`;

// --- the truth: what forge compiled ----------------------------------------
const byName = new Map<string, { contract: string; full: string }[]>();
let artifacts = 0;
for (const c of OURS) {
  const p = `${ROOT}/out/${c}.sol/${c}.json`;
  if (!fs.existsSync(p)) continue;
  artifacts++;
  const abi = JSON.parse(fs.readFileSync(p, "utf8")).abi as AbiEntry[];
  for (const e of abi) {
    if (e.type !== "function" && e.type !== "event") continue;
    const at = byName.get(e.name!) ?? [];
    at.push({ contract: c, full: full(e) });
    byName.set(e.name!, at);
  }
}

// `out/` is gitignored and a fresh clone has none. Skipping is right: this test
// checks the app against the contracts, and with no contracts compiled there is
// nothing to check. It must never pass silently in CI, so say so loudly.
if (artifacts === 0) {
  console.log("abi: SKIPPED — no forge artifacts in out/. Run `forge build` first.");
  process.exit(0);
}

// --- what the surfaces declare ----------------------------------------------
const LITERAL = /"((?:function|event)\s+[^"]+)"/g;
const problems: string[] = [];
let checked = 0;
let foreign = 0;

for (const dir of SURFACES) {
  for (const f of fs.readdirSync(`${ROOT}/${dir}`)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const rel = `${dir}/${f}`;
    const src = fs.readFileSync(`${ROOT}/${rel}`, "utf8");
    for (const m of src.matchAll(LITERAL)) {
      const lit = m[1];
      if (lit === undefined) continue;
      let item: AbiEntry;
      try {
        item = parseAbiItem(lit) as AbiEntry;
      } catch {
        continue; // not an ABI string, or a fragment split across lines
      }
      if (item.type !== "function" && item.type !== "event") continue;
      const cands = byName.get(item.name!);
      if (!cands) {
        foreign++;
        continue;
      }
      checked++;
      const mine = full(item);
      if (cands.some((c) => c.full === mine)) continue;
      problems.push(
        `${rel}\n      declares  ${mine}\n` +
          cands.map((c) => `      ${c.contract.padEnd(14)}${c.full}`).join("\n"),
      );
    }
  }
}

assert.equal(
  problems.length,
  0,
  `the app and the contracts disagree:\n\n    ${problems.join("\n\n    ")}\n`,
);
// A drop to zero would mean the regex stopped matching and the test stopped
// testing — the failure mode of every check that scrapes source.
assert.ok(checked > 100, `only ${checked} declarations matched a contract name — the scan is broken`);

console.log(`abi: ${checked} declarations agree with the compiled contracts (${foreign} third-party, ${artifacts} artifacts)`);
