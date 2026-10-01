/**
 * WHICH VIEW OPENS, as a function of nothing but its arguments.
 *
 * This lived inline in `main.ts` as a chain of `if (X) { render(); return; }`
 * over TREASURY then REGISTRY, written when both were `null` unless a query
 * string named them. The launch filled both in as constants — and from that
 * moment `/app/` opened on the TREASURY for every visitor, while the index of
 * launches and the creation screen became unreachable at every URL there is.
 * Nothing failed, nothing logged; the page simply answered a question nobody
 * had asked.
 *
 * It is a pure function here so `route.test.ts` can hold it to that, because
 * the failure was one of ORDER and no type or build step sees an order.
 */

export const VIEWS = ["index", "app", "stats", "treasury", "create", "docs"] as const;
export type View = typeof VIEWS[number];
export const isView = (v: string): v is View => (VIEWS as readonly string[]).includes(v);

export interface RouteInput {
  /** `location.hash` without its `#`. */
  hash: string;
  /** `location.search`, parsed. */
  query: URLSearchParams;
  /** Whether this build has a registry / treasury / launch configured. */
  hasRegistry: boolean;
  hasTreasury: boolean;
  /** Whether a launched TOKEN is configured. The field keeps the old name
   *  because it is the `FeeVault` address that is configured — see the note on
   *  `?token=` below: the vocabulary changed on screen, not in the contracts. */
  hasVault: boolean;
  /** Whether the Stats view applies — it reads a distribution root stock by
   *  stock, and a backing or lottery vault has none. Defaults to `hasVault`,
   *  which is what it meant while there was one payout mode. */
  hasStats?: boolean;
}

/** Whether a view exists in THIS deployment. The hash is a reader's request,
 *  not an instruction: `#stats` shared from one launch and opened on a backing
 *  one used to reveal an empty section with no tab to leave it by. */
function has(view: View, i: RouteInput): boolean {
  switch (view) {
    case "index": case "create": return i.hasRegistry;
    case "treasury": return i.hasTreasury;
    case "app": return i.hasVault;
    case "stats": return i.hasStats ?? i.hasVault;
    default: return true; // the docs need nothing
  }
}

/**
 * The order, and why each step is where it is:
 *
 *  1. **the hash**, so a shared `#docs` or `#treasury` link lands where it
 *     says and nothing below can overrule a reader's explicit request — as
 *     long as the view EXISTS here, which is what `has` decides;
 *  2. **`?create` / `?treasury=`**, the two screens a link can only mean
 *     deliberately. Asked of the QUERY STRING, never of the constants — that
 *     distinction is the whole bug;
 *  3. **`?token=` / `?vault=` / `?distributor=`**, so every link to one launch
 *     ever shared keeps opening on that launch and not on the list. `?token=` is
 *     what the app writes now; **`?vault=` is kept for ever** and not
 *     deprecated — it is in published links, in `site/index.html`'s embed
 *     snippet and in the SDK's own README, and a link that stops working is a
 *     holder who cannot reach their claim;
 *  4. **the index**, the right default for a platform with more than one
 *     token;
 *  5. the Treasury, then the launch, for a build that has no registry.
 */
export function route(i: RouteInput): View {
  if (isView(i.hash) && has(i.hash, i)) return i.hash;
  if (i.query.has("create") && i.hasRegistry) return "create";
  if (i.query.has("treasury") && i.hasTreasury) return "treasury";
  if ((i.query.has("token") || i.query.has("vault") || i.query.has("distributor")) && i.hasVault) {
    return "app";
  }
  if (i.hasRegistry) return "index";
  if (i.hasTreasury) return "treasury";
  return "app";
}
