import { defineConfig } from "vite";

// viem is BUNDLED, not externalised: the package's promise is a <script> to
// paste into a page, with no install step and no import map. A creator who
// already ships viem pays for one copy -- the price of a two-line integration,
// and their app's bundler deduplicates on import anyway.
export default defineConfig({
  build: {
    target: "es2022",
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "payd.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
