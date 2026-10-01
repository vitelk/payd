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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

/** Every `.sol` under `contracts/`, however deep.
 *
 *  It used to be a hand-written list of four directories, and the day
 *  `contracts/distribution/` was created — `FeeVault`, `Distributor` and both
 *  their versions moving one level down — that list silently stopped covering
 *  the two contracts the keeper talks to most. Twenty names the off-chain
 *  legitimately uses were reported missing at once, which is the shape a
 *  false alarm takes here. A walk cannot go stale: a new mode's directory is
 *  covered the moment it exists. */
function solFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...solFiles(full));
    else if (entry.endsWith(".sol")) out.push(full);
  }
  return out;
}

/** Names declared by OUR contracts, plus the external interfaces we mirror. */
function declared(): Set<string> {
  const names = new Set<string>();
  {
    for (const f of solFiles(join(ROOT, "contracts"))) {
      const src = readFileSync(f, "utf8");
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
  // The Pons LAUNCHED TOKEN's own metadata, read by `prospect.ts` alone. The
  // launch form's socials live here and nowhere else on-chain — not in any
  // factory event, which is where they were looked for first. No contract of
  // ours reads it, so it does not belong in `interfaces/`.
  "socials",
  // Same token, same reason: `logo()` is the image the launch form wrote,
  // read by the front's token cards (`cardreads.ts`) and by no contract.
  "logo",
  // Pons V2LaunchFactory, read by the LAUNCH FORM only. `IExternal` mirrors
  // only what the contracts call; the form quotes and sends a launch itself.
  "launchFee", "maxCreatorTaxBps", "launchEnabled", "previewLaunchEconomics", "launchToken",
  // `PonsV2LaunchAndBuy`, the official forwarder — the path a launch actually
  // takes, and the only one that carries `snipeTaxExemptions`, so the creator's
  // own first buy is not taxed 99 %. `launchForwarder()` is the factory getter
  // that names it, and checking it is how the form refuses to post a launch at
  // a forwarder the factory has stopped pointing at. Neither belongs in
  // `interfaces/`: no contract of ours calls either one — $PAYD's own launch
  // went through the Safe, and a third-party creator goes through the form.
  "launchAndBuy", "launchForwarder",
  // `factory.locker()` — the shared supply locker every Pons launch parks part
  // of its supply at. The keeper reads it to know which holder it must never
  // PUSH to: the contract cannot move an ERC-20, so a delivery there is burnt.
  "locker",
  // `PonsV2LaunchLocker.isLocked(token)` — asked to confirm that the locker the
  // factory names is the one holding THIS token's supply, before the keeper
  // trusts it enough to filter on it.
  "isLocked",
  // Arbitrum gas oracle
  "getL1BaseFeeEstimate",
  // `Multicall3.aggregate3` — the batching the keeper and the co-signer read
  // through. No contract of ours calls it: viem wraps the reads, and the only
  // place the name is written out is the stub that has to answer it
  // (`rpcbudget.test.ts`).
  "aggregate3",
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
