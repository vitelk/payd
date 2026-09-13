/**
 * announce.ts — the cycle, watched once, published anywhere.
 *
 * The chain-watching half of the announcers: it reads logs, decodes the three
 * events worth telling a human about, and hands them to a `Channel`. Telegram
 * and Discord are two thin renderers on top; neither owns a copy of the cursor,
 * the aggregation or the idempotence.
 *
 * That split is not tidiness. Duplicated stateful logic is what produced the
 * two worst bugs in this repository — a cursor that was not keyed by deployment
 * and a push set that read live state — and a second copy is a second chance to
 * fix one and forget the other.
 *
 * It holds no key, signs nothing, sends no transaction.
 */
import { createPublicClient, http, decodeEventLog, encodeEventTopics, parseAbi, type Address } from "viem";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RPC_URL } from "./config.js";
import { scanLogs } from "./logs.js";

export type Announcement =
  | { kind: "basket"; toEpoch: bigint; legs: number; quoteIn: bigint }
  | { kind: "root"; upToEpoch: bigint }
  | { kind: "airdrop"; wallets: number; symbols: string[] };

export interface Channel {
  /** Names the cursor file, so two channels advance independently. */
  readonly name: string;
  /** false = not delivered; the cursor stays put and the next tick retries. */
  send(a: Announcement): Promise<boolean>;
  /** Described once at startup, so a dry run says so out loud. */
  readonly describe: string;
}

const events = parseAbi([
  "event BasketBought(uint256 indexed toEpoch, uint256 quoteIn, uint256 usdgIn, uint256 legsBought)",
  "event RootPublished(uint256 indexed rootId, address indexed publisher, bytes32 claimRoot, bytes32 pushRoot, uint256 upToEpoch, bytes32 digest, string cid)",
  "event Delivered(address indexed holder, address indexed stock, address indexed caller, uint256 amount)",
]);
const erc20 = parseAbi(["function symbol() view returns (string)"]);

type EvtLog = { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };
type Hit = { block: number; kind: "basket" | "root" | "delivered"; log: EvtLog };

export function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from the environment`);
  return v;
}

export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

export async function watch(channel: Channel): Promise<never> {
  const DISTRIBUTOR = requireEnv("DISTRIBUTOR") as Address;
  const FEE_VAULT = requireEnv("FEE_VAULT") as Address;
  const DIR = process.env.EPOCH_DIR ?? "data";
  const cursorFile = `${DIR}/announce-${channel.name}-${DISTRIBUTOR.toLowerCase()}.json`;
  const pollMs = Number(process.env.ANNOUNCE_POLL_SECONDS ?? 30) * 1000;

  /** At 30-minute epochs, announcing every one is ~96 messages a day and a
   *  muted channel. These post one in N; airdrops are one message per wave. */
  const epochEvery = BigInt(Math.max(1, Number(process.env.ANNOUNCE_EPOCH_EVERY ?? 1)));
  const rootEvery = BigInt(Math.max(1, Number(process.env.ANNOUNCE_ROOT_EVERY ?? 1)));

  const pub = createPublicClient({ transport: http(RPC_URL, { retryCount: 5, retryDelay: 500 }) });

  const topics = {
    basket: encodeEventTopics({ abi: events, eventName: "BasketBought" })[0] as string,
    root: encodeEventTopics({ abi: events, eventName: "RootPublished" })[0] as string,
    delivered: encodeEventTopics({ abi: events, eventName: "Delivered" })[0] as string,
  };

  const symbols = new Map<string, string>();
  const symbolOf = async (stock: Address): Promise<string> => {
    const k = stock.toLowerCase();
    const hit = symbols.get(k);
    if (hit) return hit;
    try {
      const s = await pub.readContract({ address: stock, abi: erc20, functionName: "symbol" });
      symbols.set(k, s);
      return s;
    } catch {
      return stock.slice(0, 8) + "…";
    }
  };

  const readCursor = (): number | null => {
    try {
      return Number(JSON.parse(readFileSync(cursorFile, "utf8")).block);
    } catch {
      return null;
    }
  };
  const writeCursor = (block: number) => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ block, distributor: DISTRIBUTOR, channel: channel.name }));
  };

  async function tick() {
    const head = Number(await pub.getBlockNumber());
    let from = readCursor();
    if (from === null) {
      // Cold start at the head: replaying a launched token's whole history
      // would post hundreds of notifications nobody asked for.
      from = Number(process.env.ANNOUNCE_FROM_BLOCK ?? head);
      log(`${channel.name}: no cursor, starting at block ${from}`);
      writeCursor(from);
    }
    if (from >= head) return;

    const hits: Hit[] = [];
    const collect =
      (kind: Hit["kind"]) =>
      (logs: { blockNumber: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}` }[]) => {
        for (const l of logs) hits.push({ block: Number(BigInt(l.blockNumber)), kind, log: l as unknown as EvtLog });
      };

    await scanLogs(pub, { address: FEE_VAULT, fromBlock: from + 1, toBlock: head, topics: [topics.basket] }, collect("basket"));
    await scanLogs(pub, { address: DISTRIBUTOR, fromBlock: from + 1, toBlock: head, topics: [topics.root] }, collect("root"));
    await scanLogs(pub, { address: DISTRIBUTOR, fromBlock: from + 1, toBlock: head, topics: [topics.delivered] }, collect("delivered"));

    if (hits.length === 0) {
      writeCursor(head);
      return;
    }
    hits.sort((a, b) => a.block - b.block);

    // One message per wave, never one per holder.
    const paid = new Set<string>();
    const paidStocks = new Set<Address>();
    for (const h of hits) {
      if (h.kind !== "delivered") continue;
      const d = decodeEventLog({ abi: events, ...h.log }) as { args: { holder: Address; stock: Address } };
      paid.add(d.args.holder.toLowerCase());
      paidStocks.add(d.args.stock);
    }

    for (const h of hits) {
      if (h.kind === "basket") {
        // One purchase buys the WHOLE basket, so there is no single symbol to
        // name any more — the message says how many legs, not which stock.
        const d = decodeEventLog({ abi: events, ...h.log }) as {
          args: { toEpoch: bigint; quoteIn: bigint; legsBought: bigint };
        };
        if (d.args.toEpoch % epochEvery !== 0n) continue;
        const ok = await channel.send({
          kind: "basket",
          toEpoch: d.args.toEpoch,
          legs: Number(d.args.legsBought),
          quoteIn: d.args.quoteIn,
        });
        if (!ok) return; // cursor stays put; the next tick retries this window
      } else if (h.kind === "root") {
        const d = decodeEventLog({ abi: events, ...h.log }) as { args: { upToEpoch: bigint } };
        if (d.args.upToEpoch % rootEvery !== 0n) continue;
        if (!(await channel.send({ kind: "root", upToEpoch: d.args.upToEpoch }))) return;
      }
    }

    if (paid.size > 0) {
      const syms = await Promise.all([...paidStocks].map(symbolOf));
      if (!(await channel.send({ kind: "airdrop", wallets: paid.size, symbols: syms }))) return;
    }

    writeCursor(head);
    log(`${channel.name}: posted through block ${head}`);
  }

  log(`watching ${DISTRIBUTOR} and ${FEE_VAULT}`);
  log(channel.describe);
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log(`${channel.name} tick failed:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
