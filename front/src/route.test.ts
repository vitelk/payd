import { route, type View } from "./route.js";

let bad = 0;
const eq = (got: View, want: View, what: string) => {
  if (got === want) return;
  console.error(`  FAIL ${what}: got "${got}", wanted "${want}"`);
  bad++;
};
const at = (url: string, o: Partial<{ r: boolean; t: boolean; v: boolean; s: boolean }> = {}) => {
  const u = new URL(url, "https://paydprotocol.eth.limo/app/");
  return route({
    hash: u.hash.slice(1),
    query: u.searchParams,
    hasRegistry: o.r ?? true,
    hasTreasury: o.t ?? true,
    hasVault: o.v ?? true,
    hasStats: o.s ?? o.v ?? true,
  });
};

// THE REGRESSION. Every address is configured, as it is since the launch, and
// the app is opened at its bare URL. It answered "treasury" for weeks.
eq(at("./"), "index", "a bare /app/ opens on the list of launches");
eq(at("./?create"), "create", "?create reaches the creation screen");
eq(at("./#create"), "create", "and so does #create");
eq(at("./#docs"), "docs", "a shared #docs link lands on the docs");

// Deep links that existed before the registry did, and must keep working.
eq(at("./?vault=0x1&distributor=0x2"), "app", "a link to ONE launch opens that launch");
eq(at("./?distributor=0x2"), "app", "…and so does the half of it that names only the distributor");
eq(at("./?vault=0x1&distributor=0x2#stats"), "stats", "a hash still wins over it");

// `?token=` is what the app writes now, and `?vault=` is kept FOR EVER beside
// it: it is in published links, in `site/index.html`'s embed snippet and in the
// SDK's README. A link that stops working is a holder who cannot reach their
// claim, so both are asserted here rather than one replacing the other.
eq(at("./?token=0x1"), "app", "?token= opens the launch");
eq(at("./?token=0x1&distributor=0x2"), "app", "…with its distributor too");
eq(at("./?token=0x1", { v: false }), "index", "…and falls back like ?vault= when no launch is configured");

// The Treasury: reachable when ASKED for, never by default.
eq(at("./?treasury=0x9"), "treasury", "?treasury= opens the Treasury");
eq(at("./#treasury"), "treasury", "and so does the tab's hash");

// Builds that do not have everything. Each falls to what it does have.
eq(at("./", { r: false }), "treasury", "with no registry, the Treasury is the landing");
eq(at("./", { r: false, t: false }), "app", "with neither, the single launch is");
eq(at("./?create", { r: false }), "treasury", "?create with no registry falls through — there is no factory to build with");
eq(at("./?create", { r: false, t: false }), "app", "…and with no Treasury either, down to the launch");
eq(at("./?treasury=0x9", { t: false }), "index", "?treasury= with no Treasury falls back to the index");
eq(at("./?vault=0x1", { v: false }), "index", "…and ?vault= with no vault configured does too");

// A hash naming a view this deployment does not have falls through to what it
// does have. `#stats` is the case that bites: it is shared from a distribution
// launch and opened on a backing one, where there is no root to draw and no tab
// to leave by.
eq(at("./?vault=0x1&distributor=0x2#stats", { s: false }), "app", "#stats on a launch without stats opens the launch");
eq(at("./#stats", { v: false, s: false }), "index", "…and falls to the list when there is no launch either");
eq(at("./#create", { r: false }), "treasury", "a view the build has no registry for is not opened by its hash");
eq(at("./#treasury", { t: false }), "index", "…nor is the Treasury when this build has none");
eq(at("./#docs", { r: false, t: false, v: false }), "docs", "the docs need nothing and always open");

// Junk in the hash is ignored rather than blanking the page.
eq(at("./#d3"), "index", "a docs anchor is not a view and does not hijack the route");
eq(at("./#"), "index", "nor does an empty hash");

if (bad) { console.error(`route: ${bad} FAILED`); process.exit(1); }
console.log("route: 26 checks OK — /app/ opens on the launches, and every deep link still lands");
