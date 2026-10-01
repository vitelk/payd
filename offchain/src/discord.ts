/**
 * discord.ts — the cycle, announced in a Discord channel.
 *
 *   DISCORD_WEBHOOK_URL=… DISTRIBUTOR=0x… FEE_VAULT=0x… \
 *     pnpm --filter offchain discord
 *
 * A **webhook**, not a bot application: this only ever talks one way, and a
 * webhook needs no gateway connection, no token to rotate and no permission
 * beyond the one the URL already carries. Create it in Channel Settings →
 * Integrations → Webhooks, and treat the URL as a secret — anyone holding it
 * can post as the channel.
 *
 * Without `DISCORD_WEBHOOK_URL` it prints instead of sending.
 */
import { watch, log, type Announcement, type Channel } from "./announce.js";
import { basketEmbed, rootEmbed, airdropEmbed, type Embed } from "./discord-format.js";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL ?? "";
const APP_URL = process.env.APP_URL ?? "https://paydprotocol.eth.limo/app/";

function render(a: Announcement): Embed {
  if (a.kind === "basket") return basketEmbed(a.toEpoch, a.legs, a.quoteIn);
  if (a.kind === "root") return rootEmbed(a.upToEpoch, APP_URL);
  return airdropEmbed(a.wallets, a.symbols);
}

const discord: Channel = {
  name: "discord",
  describe: WEBHOOK ? "posting to the Discord webhook" : "DRY RUN — no DISCORD_WEBHOOK_URL, printing instead",
  async send(a) {
    const embed = render(a);
    if (!WEBHOOK) {
      console.log(`\n--- would post ---\n${embed.title}\n${embed.description.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}\n`);
      return true;
    }
    try {
      const r = await fetch(WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
      // 429 is a rate limit, not a failure: hold the cursor and let the next
      // tick re-send. Discord tells us how long to wait; the poll interval is
      // already longer than any bucket it hands out.
      if (r.status === 429) {
        log("discord rate-limited, retrying next tick");
        return false;
      }
      if (!r.ok) {
        log(`discord refused (${r.status}):`, (await r.text()).slice(0, 200));
        return false;
      }
      return true;
    } catch (e) {
      log("discord unreachable:", (e as Error).message);
      return false;
    }
  },
};

watch(discord);
