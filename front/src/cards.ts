/**
 * The Tokens index as CARDS: the view-model one launch becomes, the markup it
 * fills, and the arithmetic behind the one number the card is for.
 *
 * **Why a card rather than a row.** The table answered "compare these six
 * numbers across twenty launches", which is a question somebody auditing the
 * registry asks. The question everybody else arrives with is "has this one
 * actually paid anybody?", and a row of six columns answers it in the third
 * one, in bps of volume — a rate, not an amount. The card answers it with one
 * number: dollars of equities that have LEFT the contract and reached holders.
 * The table is still there, one toggle away, because the comparison is a real
 * need; it is no longer what the page opens on.
 *
 * **Nothing here imports `chain.js` or `config.js`**, which is the same rule
 * `yield.ts`, `curve.ts` and `basket.ts` follow and for the same reason: the
 * arithmetic a reader may act on has to be checkable under node with no chain
 * in the way, and a module that reaches `location.search` at import is not.
 * `cardreads.ts` is the half that goes and gets the numbers, exactly as
 * `metrics.ts` is to `yield.ts`. `cards.test.ts` imports THIS file, plainly.
 */
import { formatUnits } from "viem";

/**
 * How long ago, in the shortest true unit.
 *
 * Coarse on purpose: a launch's exact minute is on its own page and in the
 * explorer, and "3 d ago" is what the reader is actually asking. The unit
 * changes at the point where the next one stops being a lie — 90 minutes is
 * "1 h ago" and not "2 h ago", because rounding the age of a launch UP is the
 * direction that flatters it.
 */
export function ago(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const m = Math.floor(seconds / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d} d ago`;
  return `${Math.floor(d / 365)} y ago`;
}

/**
 * Dollars, as the card prints them.
 *
 * Cents under a thousand and none above it: "$8,930.42" on a card 14 rem wide
 * wraps, and the two digits it wrapped for are worth nothing at that size. A
 * figure too small to show as cents is `<$0.01` rather than `$0.00`, which
 * would read as "nothing" over an amount that is not nothing.
 */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  const d = n < 1000 ? 2 : 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** One line of a basket, as the card's arithmetic needs it. */
export interface Leg {
  /** Units delivered to holders, at the stock's own precision, or `null` when
   *  the read did not answer. */
  units: bigint | null;
  decimals: number;
  /** Dollars per whole unit. Zero means "no pool priced it", which is NOT the
   *  same sentence as "worth nothing" — see `paidOf`. */
  price: number;
}

/**
 * The headline, or `null` when it cannot be told truthfully.
 *
 * **A missing price is only fatal on a leg that actually delivered.** Summing
 * an unpriced leg as zero understates what holders were paid, silently and in
 * our favour, which is the direction to refuse. But a basket line that has
 * never been bought contributes nothing whatever its price, so a stock with no
 * pool and no delivery must not blank the whole card — that is the common case
 * on a young launch whose exotic leg has never cleared its floor.
 */
export function paidOf(legs: readonly Leg[]): number | null {
  let total = 0;
  for (const l of legs) {
    if (l.units === null) return null; // the chain did not answer: not a zero
    if (l.units === 0n) continue;
    if (!(l.price > 0)) return null; // delivered, and nothing priced it
    total += Number(formatUnits(l.units, l.decimals)) * l.price;
  }
  return total;
}

/** The mode, spelled out under the ticker. `distribution` included: the tag is
 *  what this launch IS, and leaving the default one blank made the other four
 *  look like warnings. */
export const modeTag = (m: string) => (m === "unknown" ? "other mode" : m);

/** Everything a card draws, resolved. Kept as data so the markup is a pure
 *  function of it and every state is one object in a test. */
export interface Card {
  href: string;
  sym: string;
  mode: string;
  /** The image, already resolved to an https URL, or "" for the ticker
   *  fallback. A card NEVER shows a broken image: `onerror` puts the fallback
   *  back, because a launch whose gateway is down still has a ticker. */
  logo: string;
  age: string;
  /** "" when nothing is wrong. The badge is the only place the card raises its
   *  voice, so it says nothing on a healthy launch. */
  badge: string;
  badgeInk: string;
  /** `--bad` ring and a muted headline: the fees no longer arrive here. */
  alarm: boolean;
  /** Not launched yet — the whole card at .6, and no figure to show. */
  dim: boolean;
  paid: string;
  paidMuted: boolean;
  secondaryK: string;
  secondaryV: string;
  /** The secondary line is the viewer's own money, so it is in the accent. */
  secondaryOk: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The ticker's first four letters, which is what stands in for a logo. Four
 *  because it fits a 40 px square at .75rem and every Pons symbol is at most
 *  that wide in practice. */
export const initials = (sym: string) => sym.slice(0, 4).toUpperCase();

/** One launch, as a cell of the grid. The whole card is the link — but it is an
 *  `<a>` and not a `<div>` with a handler, so middle-click and the keyboard
 *  reach a launch, the same rule the table's ticker follows. */
export function cardHtml(c: Card): string {
  const fb = esc(initials(c.sym));
  const logo = c.logo
    // The fallback is written BESIDE the image, not instead of it: `onerror`
    // only has to reveal what is already in the DOM, so there is no moment
    // where the square is empty and no second render.
    ? `<img src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()"><i>${fb}</i>`
    : `<i>${fb}</i>`;
  return `<a class="tc${c.dim ? " dim" : ""}${c.alarm ? " alarm" : ""}" href="${esc(c.href)}">
    <div class="hdr">
      <span class="lg">${logo}</span>
      <span class="nm">
        <span class="t1"><b>${esc(c.sym)}</b><span class="mt">${esc(modeTag(c.mode))}</span></span>
        <span class="age">${esc(c.age)}</span>
      </span>
      ${c.badge ? `<span class="bdg" style="color:${c.badgeInk}">${esc(c.badge)}</span>` : ""}
    </div>
    <span class="fig">
      <span class="eyebrow">Paid to holders</span>
      <b${c.paidMuted ? ` class="soft"` : ""}>${esc(c.paid)}</b>
    </span>
    <span class="ft">
      <span class="k">${esc(c.secondaryK)}</span>
      <span class="v${c.secondaryOk ? " ok" : ""}">${esc(c.secondaryV)}</span>
    </span>
  </a>`;
}

/** The first cell of the grid, and the only one that is not a launch.
 *
 *  It is a cell rather than a button above the grid because an index whose
 *  first tile is "make one of these" reads as a place where launching is normal
 *  — and on an EMPTY registry it is the only thing there is to show, which is
 *  the state a button above a blank grid handles worst. */
export function launchCellHtml(): string {
  return `<button type="button" class="tc newcell" data-view="create">
    <span class="plus">+</span>
    <span class="nct">Launch a token</span>
    <span class="ncp">Pons launches it. Payd pays your holders in tokenised stock, from the
    first trade. One signature with a wallet that batches, three otherwise.</span>
    <span class="ncb">Start</span>
  </button>`;
}
