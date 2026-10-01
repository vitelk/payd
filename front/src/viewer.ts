/**
 * WHO the page is looking at — which is not the same question as who is
 * connected.
 *
 * Everything this app shows about an address is a `view` call: balances,
 * shares owed, what is already claimed. None of it needs a signature, so none
 * of it needs a wallet. Only `claim` and `collect` do.
 *
 * So there are two ways in, and they set the same value:
 *   - connecting a wallet, which additionally lets you COLLECT;
 *   - pasting an address (or arriving with `?address=0x…`), which lets you
 *     LOOK and nothing more.
 *
 * It lives in its own module because the index, the launch page and the
 * Treasury all ask the same question, and a copy per screen is how the three
 * came apart in the first place.
 */
import { getAddress, type Address } from "viem";

/** The address being looked at, or null. */
export let viewer: Address | null = null;
/** True when `viewer` came from a connected wallet, i.e. it can sign. */
export let connected = false;

const subs: Array<() => void> = [];
/** Called after every change. Screens re-render from it rather than polling. */
export function onViewer(fn: () => void): void { subs.push(fn); }

export function setViewer(a: Address | null, isConnected: boolean): void {
  viewer = a;
  connected = isConnected;
  for (const fn of subs) fn();
}

/** Checksums and validates. Returns null on anything that is not an address —
 *  a mistyped one must fail here rather than read as a stranger holding zero. */
export function parseAddress(raw: string): Address | null {
  const t = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
  try { return getAddress(t); } catch { return null; }
}

/** `?address=0x…`, so a position is a link somebody can send. */
export function addressFromQuery(): Address | null {
  const a = new URLSearchParams(location.search).get("address");
  return a ? parseAddress(a) : null;
}
