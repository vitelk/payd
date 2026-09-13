/**
 * Every function and event the off-chain code names must still exist in the
 * contracts. `pnpm --filter offchain test`
 *
 * This check exists because the failure it catches is INVISIBLE to TypeScript:
 * `tsc` verifies a name against the ABI literal, never the ABI against the
 * Solidity. A getter deleted from a contract leaves the TypeScript green and
 * the keeper reverting on its first call — found three times in this project
 * (`ran`, `EpochRun`, then `ran` again in `rehearsal.ts`, which the "systematic
 * sweep" had missed).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** Names declared by OUR contracts, plus the external interfaces we mirror. */
function declared(): Set<string> {
  const names = new Set<string>();
  const dirs = ["contracts", "contracts/interfaces", "contracts/libraries"];
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d)).filter((n) => n.endsWith(".sol"))) {
      const src = readFileSync(join(ROOT, d, f), "utf8");
      for (const m of src.matchAll(/\b(?:function|event)\s+([A-Za-z_]\w*)/g)) names.add(m[1]!);
      // Public state variables generate getters of the same name. Anchored on
      // `public` and on the `;`/`=` that ends the declaration, so it survives
      // `mapping(address a => mapping(address b => uint256)) public foo;` —
      // which a regex anchored on the TYPE does not, and that is how the first
      // version of this check produced six false positives.
      for (const m of src.matchAll(/\bpublic\s+(?:constant\s+|immutable\s+|override\s+)*([A-Za-z_]\w*)\s*[;=]/g)) {
        names.add(m[1]!);
      }
    }
  }
  return names;
}

/** Names the TypeScript claims exist, from `parseAbi`-style string literals. */
function referenced(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pkg of ["offchain/src", "front/src"]) {
    for (const f of readdirSync(join(ROOT, pkg)).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(ROOT, pkg, f), "utf8");
      for (const m of src.matchAll(/["'`]\s*(?:function|event)\s+([A-Za-z_]\w*)\s*\(/g)) {
        const k = m[1]!;
        out.set(k, [...(out.get(k) ?? []), `${pkg}/${f}`]);
      }
    }
  }
  return out;
}

// Names that belong to third-party contracts we call but do not mirror in
// `interfaces/`. Each one is a deliberate exception, not a blanket escape.
const EXTERNAL = new Set([
  // Uniswap
  "exactInputSingle", "quoteExactInputSingle", "quoteExactInput", "multicall",
  "unwrapWETH9", "token0",
  // Chainlink
  "latestRoundData", "description",
  // ERC-20 / ERC-8056 — `IExternal.IERC20` mirrors only what the CONTRACTS
  // need (balanceOf, transfer, approve); the off-chain side reads more.
  "symbol", "name", "decimals", "totalSupply", "allowance", "Transfer", "Approval",
  "uiMultiplier", "newUIMultiplier", "effectiveAt",
  // Pons bonding curve, read by the front only
  "quoteReserve",
  // Pons V2LaunchFactory, read by the LAUNCH FORM only. `IExternal` mirrors
  // only what the contracts call; the form quotes and sends a launch itself.
  "launchFee", "maxCreatorTaxBps", "launchEnabled", "previewLaunchEconomics", "launchToken",
  // Arbitrum gas oracle
  "getL1BaseFeeEstimate",
]);

const have = declared();
const used = referenced();

const missing: string[] = [];
for (const [name, files] of used) {
  if (have.has(name) || EXTERNAL.has(name)) continue;
  missing.push(`${name}  <- ${[...new Set(files)].join(", ")}`);
}

assert.deepEqual(
  missing,
  [],
  `the off-chain code names things the contracts no longer declare:\n  ${missing.join("\n  ")}\n` +
    "Either the contract lost it (fix the TypeScript) or it is third-party (add it to EXTERNAL).",
);

console.log(`abis: ${used.size} names referenced, all declared`);
