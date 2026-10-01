/**
 * What the shop window's ticker must NOT have become.
 *
 * `site/ticker.js` imports `src/chain.ts`, which since 2026-09-19 carries the
 * WalletConnect path — a library 3.4x the weight of the whole app. Rollup
 * drops it, because `walletConnect()` is unreachable from the ticker and the
 * `import()` goes with the function. That is a property of the current import
 * graph, not a guarantee: one `export` moved around in `chain.ts` and the shop
 * window silently gains a megabyte.
 *
 * This ran as `git status site/ticker.js` for exactly one day and was worth
 * nothing: the file is gitignored (`.gitignore:109`), so that command is
 * silent whatever the file holds. A check that cannot fail is worse than no
 * check — it is the reason nobody looks.
 *
 * Two assertions, both cheap: no wallet library by name, and a size bound with
 * enough room for ordinary drift and none at all for a bundled dependency.
 */
import { readFileSync } from "node:fs";

const PATH = new URL("../site/ticker.js", import.meta.url);
/** Measured 2026-09-20: 379 763 bytes. The bound is ~18 % above it — the
 *  smallest thing it must catch is @walletconnect/ethereum-provider, which is
 *  megabytes. */
const MAX = 450_000;
const FORBIDDEN = /@walletconnect\/|EthereumProvider|@reown\/|w3m-modal/;

const src = readFileSync(PATH, "utf8");
const found = FORBIDDEN.exec(src);
if (found) {
  throw new Error(
    `site/ticker.js carries wallet code (${found[0]}) — the shop window connects nothing, ` +
    `so something in chain.ts became reachable from ticker.ts`,
  );
}
if (src.length > MAX) {
  throw new Error(`site/ticker.js is ${src.length} bytes, past the ${MAX} bound`);
}
console.log(`ticker.js: ${src.length} bytes, no wallet code`);
