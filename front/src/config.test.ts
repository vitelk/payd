/**
 * Every address `config.ts` hands to viem must pass viem's own check.
 * `pnpm --filter front test`
 *
 * A mis-cased address is not a typo viem forgives: `readContract` throws
 * `InvalidAddressError` before any request leaves, `create.ts` catches it as a
 * null answer, and the mode reads `unknown` — the portfolio factory was left
 * out of the creation picker that way, silently, from 2026-09-24 to
 * 2026-09-30.
 */
import assert from "node:assert/strict";
import { isAddress } from "viem";

(globalThis as { location?: unknown }).location = { search: "", hash: "", pathname: "/" };
const config = await import("./config.js");

for (const f of config.KNOWN_FACTORIES) assert.ok(isAddress(f), `bad checksum: ${f}`);
assert.ok(isAddress(config.REGISTRY), `bad checksum: ${config.REGISTRY}`);
console.log(`config: ${config.KNOWN_FACTORIES.length + 1} addresses pass viem's checksum`);
