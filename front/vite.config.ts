import { defineConfig } from "vite";

export default defineConfig({
  // `./` and not `/`: on an IPFS gateway the page is served from a subpath
  // (`/ipfs/<cid>/`), so any absolute path would break. This is THE condition
  // for the build to work equally under `ipfs://`, behind a gateway, or on an
  // ENS domain.
  base: "./",
  build: {
    target: "es2022",
    // A single JS file: one less CID to pin, and no dynamic import that could
    // fail depending on the gateway.
    rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } },
  },
});
