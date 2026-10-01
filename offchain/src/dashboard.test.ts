/**
 * The renderer, which is the one part of the dashboard that can fail SILENTLY.
 * A page that throws is obvious; a page that paints a FAIL row in the same
 * colour as an OK one reads perfectly well and says the platform is fine. Same
 * argument as `telegram-format.ts`: the pure function gets the test.
 *
 *   tsx src/dashboard.test.ts
 */
import assert from "node:assert/strict";
import { render, worst } from "./dashboard.js";
import type { Report } from "./check.js";

const rep = (rows: Report["rows"]): Report => ({
  at: "2026-09-12T00:00:00.000Z",
  block: "1234",
  chainId: 4663,
  vault: "0x1111111111111111111111111111111111111111",
  distributor: "0x2222222222222222222222222222222222222222",
  rows,
  fails: rows.filter((r) => r.state === "fail").length,
});

// One FAIL must not hide behind any number of OKs — the reason `worst` exists.
assert.equal(worst([{ state: "ok", label: "a", detail: "" }, { state: "fail", label: "b", detail: "" }]), "fail");
assert.equal(worst([{ state: "ok", label: "a", detail: "" }, { state: "warn", label: "b", detail: "" }]), "warn");
assert.equal(worst([{ state: "wait", label: "a", detail: "" }]), "wait");
assert.equal(worst([]), "ok");

// A failing vault says FAIL in the banner, in its card, and on its row.
const bad = render([rep([
  { state: "ok", label: "keeper", detail: "0.5 ETH" },
  { state: "fail", label: "publishRoot", detail: "9 epoch(s) behind" },
])]);
assert.match(bad, /banner fail">1 FAIL across 1 vault\(s\)/);
assert.match(bad, /<section class="card fail">/);
assert.match(bad, /<tr class="fail">/);
assert.match(bad, /9 epoch\(s\) behind/);

// All green must NOT be able to render the fail banner.
const good = render([rep([{ state: "ok", label: "keeper", detail: "0.5 ETH" }])]);
assert.match(good, /banner ok">all green/);
assert.doesNotMatch(good, /banner fail/);
assert.doesNotMatch(good, /tr class="fail"/);

// Warnings are their own state: neither green nor a call to get out of bed.
const warn = render([rep([{ state: "warn", label: "distribute", detail: "12.00 window(s)" }])]);
assert.match(warn, /banner warn">no FAIL · 1 warning\(s\)/);

// Chain-supplied text is escaped. A vault's `detail` carries a token symbol,
// and a symbol is whatever the launcher typed.
const evil = render([rep([{ state: "ok", label: "token", detail: '<script>alert(1)</script>' }])]);
assert.doesNotMatch(evil, /<script>alert/);
assert.match(evil, /&lt;script&gt;/);

console.log("dashboard.test.ts ok");
