/**
 * What the bot says, as pure functions.
 *
 * Separate from the runner on purpose: a send that fails is loud — it logs and
 * retries — while a number rendered wrong is not. It reads perfectly well and
 * says something false to a channel of people who would have to open the
 * explorer to catch it. Pure functions with a test are the cheap defence, and
 * they are only pure if the module can be imported without an RPC or a token in
 * the environment.
 */
import { formatEther } from "viem";

/** Trailing zeros on a share count read as noise, not precision. */
export function shares(raw: bigint): string {
  const n = Number(raw) / 1e18;
  if (n === 0) return "0";
  // Dust must never render as "0": announcing a delivery of nothing is worse
  // than an ugly number.
  const s = n < 0.0001 ? n.toExponential(2) : n.toFixed(n < 1 ? 6 : 4);
  return s.includes("e") ? s : s.replace(/\.?0+$/, "");
}

export function eth(raw: bigint): string {
  const n = Number(formatEther(raw));
  // Six decimals before falling back to exponential. `2.06e-4 ETH` is correct
  // and reads as a broken template to everyone who is not a programmer, which
  // is the whole audience of a Telegram channel.
  const s = n !== 0 && n < 0.000001 ? n.toExponential(2) : n.toFixed(6);
  return (s.includes("e") ? s : s.replace(/\.?0+$/, "")) + " ETH";
}

export function basketBoughtMessage(toEpoch: bigint, legs: number, quoteIn: bigint): string {
  return `⚡ <b>Through epoch ${toEpoch}</b>\nBought <b>${legs} stocks</b> for ${eth(quoteIn)}.`;
}

export function rootMessage(upToEpoch: bigint, appUrl: string): string {
  return (
    `✅ <b>Epoch ${upToEpoch} is LIVE</b>\n` +
    `Shares are claimable now — or wait, and the airdrop brings them to you.\n\n` +
    `<a href="${appUrl}">Claim</a>`
  );
}

/** One message per wave, never one per holder: a push of forty wallets would
 *  otherwise be forty notifications for the same event. */
export function airdropMessage(wallets: number, symbols: string[]): string {
  const list = symbols.length ? `\n${symbols.join(" · ")}` : "";
  return `🎁 <b>Airdrop</b>\n${wallets} wallet${wallets === 1 ? "" : "s"} paid, nobody clicked anything.${list}`;
}
