// Regenerates src/errors.json from forge's build output, so a reverted
// simulation names its error instead of a 4-byte selector.
// Run after `forge build`: pnpm --filter @paydprotocol/mcp errors
import { readFileSync, writeFileSync } from "node:fs";

const CONTRACTS = ["Payd", "FeeVault", "FeeVaultV2", "Distributor", "DistributorV3", "DistributionFactoryV3"];
const seen = new Map();
for (const c of CONTRACTS) {
  for (const e of JSON.parse(readFileSync(`../out/${c}.sol/${c}.json`, "utf8")).abi) {
    if (e.type === "error") seen.set(`${e.name}(${e.inputs.map((i) => i.type)})`, e);
  }
}
const errors = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, e]) => e);
writeFileSync("src/errors.json", JSON.stringify(errors, null, 1) + "\n");
console.log(`${errors.length} errors from ${CONTRACTS.length} contracts`);
