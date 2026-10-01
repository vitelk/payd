import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The repository root, where `.env` lives — one file for the whole project,
 * shared with foundry and the keeper. Resolved from this file and not from the
 * working directory: `pnpm --filter front build` runs in `front/`, a build
 * driven from the root does not, and a config that reads the wrong `.env`
 * ships an app quietly missing whatever was in it.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig(({ mode }) => {
  // No prefix filter on the read, and exactly ONE key out of it below.
  //
  // Vite's own rule is a prefix — `VITE_*` reaches the bundle, everything else
  // does not — and widening that prefix is how a secret ships six months later
  // because somebody named a variable well. `.env` here holds RPC endpoints and
  // keys. So: read the file, name the one value that may cross, and let the
  // rule be the name rather than a pattern.
  const env = loadEnv(mode, ROOT, "");
  if (!env.WC_PROJECT_ID) {
    console.warn("[payd] WC_PROJECT_ID is empty — building an app with no WalletConnect row");
  }

  return {
    // `./` and not `/`: on an IPFS gateway the page is served from a subpath
    // (`/ipfs/<cid>/`), so any absolute path would break. This is THE condition
    // for the build to work equally under `ipfs://`, behind a gateway, or on an
    // ENS domain.
    base: "./",
    /**
     * The WalletConnect project id, by name and by itself.
     *
     * Public by construction — every dapp ships its id in its bundle, and this
     * one is published to IPFS where anybody can read it. It is an origin tag on
     * a relay, not a credential: there is nothing to rotate if it leaks, and the
     * empty string is a working value (the Connect menu simply has one row
     * fewer). `front/src/config.ts` reads it through `typeof`, which is what
     * lets the same file run under `tsx` in the tests, where no build replaced
     * anything.
     */
    define: { __WC_PROJECT_ID__: JSON.stringify(env.WC_PROJECT_ID ?? "") },
    /**
     * `/rpc` in DEV ONLY, forwarded to whatever `.env` names.
     *
     * **The public endpoint cannot serve this app's cold start.** Opening the
     * Launch view walks the registry's whole log history for the allowlist, and
     * the node throttles: the 429 it answers with carries
     * `Access-Control-Allow-Origin: *,*` — the header twice, which every
     * browser rejects — so the failure reaches the page as a CORS error about a
     * request that was really rate-limited. `chain.ts` already says the status
     * disappears; this is the same thing with the header duplicated rather than
     * missing. Chasing the CORS message leads nowhere: there is nothing wrong
     * with the origin, and nothing this app can send that would fix it.
     *
     * So a dev server proxies instead, which buys two things. The endpoint in
     * `.env` has a real rate budget, and the browser talks to its OWN origin, so
     * no preflight and no third-party header is involved at all. Reach it with
     * `?rpc=http://127.0.0.1:5174/rpc` — the override `config.ts` already
     * documents for testing a deployment without rebuilding.
     *
     * **The key stays in node.** `server` is ignored by `vite build`, so this
     * cannot ship; and the value is read HERE rather than through `define`,
     * which is the one rule the block above draws — one named key crosses into
     * the bundle, and this is not it.
     */
    server: env.RPC_URL
      ? {
        proxy: {
          "/rpc": {
            target: env.RPC_URL,
            changeOrigin: true,
            rewrite: () => "",
          },
        },
      }
      : undefined,
    build: {
      target: "es2022",
      // ONE chunk for the app, and exactly one thing outside it: the
      // WalletConnect library, behind the `import()` in `chain.ts`. It arrives
      // as 61 chunks of its own, because the QR modal lazy-loads its icons one
      // by one — left to rollup on purpose, rather than herded into one file by
      // an allowlist of package names that would go stale the next time
      // WalletConnect changes a dependency.
      //
      // This said "a single JS file: one less CID to pin, and no dynamic import
      // that could fail depending on the gateway", and that reasoning still
      // holds for everything it covered — it is why `manualChunks` stays off and
      // why nothing else here is split. What changed is the price. Inlined,
      // WalletConnect takes the bundle from 434 kB to 1 996 kB (132 kB to 554 kB
      // gzipped, measured 2026-09-19): a 4.2x page, paid by every visitor, for a
      // library that is of no use at all to the one with an extension.
      //
      // The gateway risk it was avoiding is bounded here: the chunk is emitted
      // next to the page, under the same directory CID, and reached by a
      // relative path — `base: "./"` above is what guarantees that. A gateway
      // that cannot serve it could not have served the page either. And the
      // failure is contained: it is one row of the Connect menu that does not
      // open, not a page that does not load.
      rollupOptions: { output: { manualChunks: undefined } },
    },
  };
});
