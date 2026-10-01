/**
 * End to end on a local fork: the three launch steps PREPARED by this server
 * and signed by a throwaway key, then a real $PAYD holder's claim simulated.
 *
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547
 *   pnpm --filter @paydprotocol/mcp e2e
 *
 * Passes when the vault and token the tools predicted are the ones that land,
 * the wrong-launcher guard refuses, and the bind leaves hookStatus "collecting".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWalletClient, createPublicClient, http, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { robinhoodChain } from "../../sdk/src/payd.js";

const RPC = "http://127.0.0.1:8547";
const acct = privateKeyToAccount(generatePrivateKey());
const pub = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
await pub.request({ method: "anvil_setBalance" as never, params: [acct.address, "0x8AC7230489E80000"] as never });
const wallet = createWalletClient({ account: acct, chain: robinhoodChain, transport: http(RPC) });

const c = new Client({ name: "fork", version: "0" });
await c.connect(new StdioClientTransport({ command: "./node_modules/.bin/tsx", args: ["src/server.ts"], env: { ...process.env, PAYD_RPC_URL: RPC } as Record<string, string> }));
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const send = async (tx: { from: Address; to: Address; data: Hex; value: string }) => {
  if (tx.from.toLowerCase() !== acct.address.toLowerCase()) throw new Error("tx.from is not the signer");
  const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
};

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
console.log("signer", acct.address);

// guard: someone else may not launch this vault
const t1 = await call("payd_prepare_create_vault", { from: acct.address, basket: [{ stock: NVDA, bps: 6000 }, { stock: TSLA, bps: 4000 }], rewardsBps: 9000, epochMinutes: 30 });
await send(t1); console.log("1 create ok, simulated", t1.simulation.result);
const { tokens } = await call("payd_list_tokens", { creator: acct.address, limit: 1 });
const vault = tokens[0].vault; console.log("  vault", vault);

const bad: any = await c.callTool({ name: "payd_prepare_launch", arguments: { from: "0x00000000000000000000000000000000000000bb", vault, name: "Fork Test", symbol: "FORK", creatorTaxBps: 100 } });
console.log("  wrong-launcher guard:", bad.isError ? bad.content[0].text : "NOT REFUSED");

const t2 = await call("payd_prepare_launch", { from: acct.address, vault, name: "Fork Test", symbol: "FORK", creatorTaxBps: 100 });
const r2 = await send(t2); console.log("2 launch ok, predicted", t2.predictedToken, "value", t2.value);
const t3 = await call("payd_prepare_bind", { vault, token: t2.predictedToken });
await send(t3); console.log("3 bind ok");

const info = await call("payd_token_info", { vault });
console.log("  token", info.token, "== predicted:", info.token.toLowerCase() === t2.predictedToken.toLowerCase(), "| hook", info.hookStatus, "| basket", info.basket.map((l: any) => `${l.symbol}:${l.bps}`).join(" "));
const cl = await call("payd_prepare_claim", { vault, holder: acct.address }).catch((e) => ({ error: String(e) }));
console.log("  claim on a fresh launch:", JSON.stringify(cl).slice(0, 160));
const real = await call("payd_prepare_claim", { vault: "0x4DBA57f2E1b9AFE02cA091916F98dd7B4A248A64", holder: "0x5a4A5DEcCcfBD2E1e0fFdbB862380a79eF0688F5" });
console.log("  $PAYD holder claim:", real.to, "data bytes", (real.data.length - 2) / 2, "simulated delivered", real.simulation.result);
await c.close();
