/**
 * selfcheck.ts — checks that replaying `Transfer` events rebuilds the on-chain
 * balances exactly.
 *
 * This is the control that makes `snapshot.ts` credible: if the replay diverges
 * from the real balances, every computed root is wrong, and nobody can see it
 * from the root alone. So we replay up to the current block — the only one where
 * state is readable on a non-archive RPC — and compare.
 *
 *   pnpm --filter offchain selfcheck <token>
 */
import { createPublicClient, http, keccak256, getAddress, type Address } from "viem";
import { RPC_URL, PONS_V2_FACTORY } from "./config.js";
import { scanLogs, type RawLog } from "./logs.js";

const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 6, retryDelay: 500 }) });

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN_LAUNCHED_TOPIC = keccak256(
  new TextEncoder().encode("TokenLaunched(address,address,address,address,uint256,uint256)"),
);
const ZERO = "0x0000000000000000000000000000000000000000";

async function rawLogs(address: string, fromBlock: number, toBlock: number, topics: (string | null)[]) {
  const out: RawLog[] = [];
  await scanLogs(client, { address, fromBlock, toBlock, topics }, (l) => out.push(...l));
  return out;
}

async function main() {
  const token = getAddress(process.argv[2] ?? "") as Address;
  const head = Number(await client.getBlockNumber());

  let launchBlock = -1;
  const STEP = 5_000_000;
  for (let from = 0; from <= head && launchBlock < 0; from += STEP) {
    const logs = await rawLogs(PONS_V2_FACTORY, from, Math.min(from + STEP - 1, head), [
      TOKEN_LAUNCHED_TOPIC,
      "0x" + token.slice(2).toLowerCase().padStart(64, "0"),
    ]);
    if (logs.length) launchBlock = Number(BigInt(logs[0]!.blockNumber));
  }
  if (launchBlock < 0) throw new Error("TokenLaunched introuvable");
  console.log(`token ${token}\nlaunched at block ${launchBlock}, head ${head} (${head - launchBlock} blocks)`);

  const balances = new Map<string, bigint>();
  let transfers = 0;
  const stats = await scanLogs(
    client,
    { address: token, fromBlock: launchBlock, toBlock: head, topics: [TRANSFER_TOPIC] },
    (logs) => {
      for (const log of logs) {
        transfers++;
        const from = "0x" + log.topics[1]!.slice(26);
        const dest = "0x" + log.topics[2]!.slice(26);
        const value = BigInt(log.data);
        if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
        if (dest !== ZERO) balances.set(dest, (balances.get(dest) ?? 0n) + value);
      }
    },
  );
  const holders = [...balances].filter(([, v]) => v > 0n);
  console.log(`${transfers} transfers replayed in ${stats.requests} requests, ${holders.length} holders`);

  // Compare against the real balances AT THE SAME BLOCK as the scan.
  //
  // Reading at "latest" would be a race: the scan takes a minute, and during
  // that time active addresses — the PoolManager first among them — move. So we
  // pin `head`, which the RPC still serves since it is recent (old state, on the
  // other hand, is out of reach: see logs.ts).
  const at = ("0x" + head.toString(16)) as `0x${string}`;
  holders.sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const sample = holders.slice(0, 12);
  let mismatches = 0;
  for (const [holder, expected] of sample) {
    const actual = (await client.request({
      method: "eth_call",
      params: [{ to: token, data: ("0x70a08231" + holder.slice(2).padStart(64, "0")) as `0x${string}` }, at],
    } as never)) as unknown as `0x${string}`;
    const got = BigInt(actual);
    const ok = got === expected;
    if (!ok) mismatches++;
    console.log(`  ${ok ? "OK " : "DIFF"} ${holder} replay=${expected} onchain=${got}`);
  }

  const totalReplayed = holders.reduce((a, [, v]) => a + v, 0n);
  const supply = BigInt((await client.request({
    method: "eth_call", params: [{ to: token, data: "0x18160ddd" }, at],
  } as never)) as unknown as `0x${string}`);
  console.log(`replayed sum ${totalReplayed}\ntotalSupply  ${supply}`);
  if (totalReplayed !== supply) {
    console.log("SUPPLY MISMATCH — the replay does not rebuild the state");
    process.exit(1);
  }
  if (mismatches) { console.log(`${mismatches} balance mismatches`); process.exit(1); }
  console.log("\nreplay matches: balances and supply identical to on-chain state");
}

main().catch((e) => { console.error(e); process.exit(1); });
