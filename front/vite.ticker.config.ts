import { defineConfig } from "vite";

/**
 * The shop window's ticker, built on its own.
 *
 * A SECOND config rather than a second entry in the first: the app's build sets
 * `inlineDynamicImports`, which rollup allows for exactly one input, and the two
 * artefacts have nothing in common anyway — different page, different lifetime,
 * different place in the published tree. `emptyOutDir` is off because the output
 * directory is `site/`, which is hand-written source and not a build folder.
 *
 * The filename is fixed, not hashed: `site/index.html` refers to it by name, and
 * on IPFS every publication is a new CID already — a content hash in the
 * filename would buy nothing and cost the site a manual edit on every build.
 */
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "../site",
    emptyOutDir: false,
    lib: { entry: "src/ticker.ts", formats: ["es"], fileName: () => "ticker.js" },
    // ONE file. Lib mode splits viem's lazy CCIP path into a second chunk by
    // default, and a shop window that 404s half its script on a gateway that
    // served the other half is the failure this whole file exists to avoid.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
