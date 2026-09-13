/**
 * What the bot says on Discord, as pure functions.
 *
 * Discord takes rich embeds where Telegram takes HTML, so the wording is shared
 * in spirit and not in code: an embed has a title, a body and a colour, and
 * cramming Telegram's single string into one wastes the format.
 *
 * The colour is the brand's own accent (`#ccff00`, `site/index.html`), so the
 * announcements look like the site rather than like a default webhook.
 */
import { shares, eth } from "./telegram-format.js";

export const ACCENT = 0xccff00;

export interface Embed {
  title: string;
  description: string;
  color: number;
  url?: string;
}

/// One purchase covers a WINDOW of epochs and buys the whole basket, so the
/// message names how many legs rather than which stock — there is no single
/// stock to name any more.
export function basketEmbed(toEpoch: bigint, legs: number, quoteIn: bigint): Embed {
  return {
    title: `⚡ Through epoch ${toEpoch}`,
    description: `Bought **${legs} stocks** for ${eth(quoteIn)}.`,
    color: ACCENT,
  };
}

export function rootEmbed(upToEpoch: bigint, appUrl: string): Embed {
  return {
    title: `✅ Epoch ${upToEpoch} is LIVE`,
    description: `Shares are claimable now — or wait, and the airdrop brings them to you.\n\n[Claim](${appUrl})`,
    color: ACCENT,
    url: appUrl,
  };
}

export function airdropEmbed(wallets: number, symbols: string[]): Embed {
  const list = symbols.length ? `\n${symbols.join(" · ")}` : "";
  return {
    title: "🎁 Airdrop",
    description: `${wallets} wallet${wallets === 1 ? "" : "s"} paid, nobody clicked anything.${list}`,
    color: ACCENT,
  };
}
