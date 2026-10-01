/**
 * telegram.ts — the cycle, announced in a Telegram channel.
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… DISTRIBUTOR=0x… FEE_VAULT=0x… \
 *     pnpm --filter offchain telegram
 *
 * Create the bot with @BotFather, add it to the channel as an admin, then read
 * the chat id from `getUpdates`. It holds no key beyond that token, signs
 * nothing and sends no transaction.
 *
 * Without `TELEGRAM_BOT_TOKEN` it prints instead of sending, which is how to
 * look at a day of output before pointing it at real people.
 *
 * The watching lives in `announce.ts` — shared with Discord, so the cursor and
 * the idempotence exist once.
 */
import { watch, log, type Announcement, type Channel } from "./announce.js";
import { basketBoughtMessage, rootMessage, airdropMessage } from "./telegram-format.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const APP_URL = process.env.APP_URL ?? "https://paydprotocol.eth.limo/app/";

function render(a: Announcement): string {
  if (a.kind === "basket") return basketBoughtMessage(a.toEpoch, a.legs, a.quoteIn);
  if (a.kind === "root") return rootMessage(a.upToEpoch, APP_URL);
  return airdropMessage(a.wallets, a.symbols);
}

const telegram: Channel = {
  name: "telegram",
  describe:
    BOT_TOKEN && CHAT_ID
      ? `posting to chat ${CHAT_ID}`
      : "DRY RUN — no TELEGRAM_BOT_TOKEN, printing instead",
  async send(a) {
    const text = render(a);
    if (!BOT_TOKEN || !CHAT_ID) {
      console.log("\n--- would post ---\n" + text.replace(/<[^>]+>/g, "") + "\n");
      return true;
    }
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
      if (r.status === 429) {
        log("telegram rate-limited, retrying next tick");
        return false;
      }
      if (!r.ok) {
        log(`telegram refused (${r.status}):`, (await r.text()).slice(0, 200));
        return false;
      }
      return true;
    } catch (e) {
      log("telegram unreachable:", (e as Error).message);
      return false;
    }
  },
};

watch(telegram);
