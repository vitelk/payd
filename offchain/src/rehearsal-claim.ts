/**
 * rehearsal-claim.ts — the last link nothing else covers. **Rehearsal only.**
 *
 * `test/Launch.t.sol` proves the contract pays a correct proof, and
 * `dispute.ts` proves the published root is reproducible. Neither proves the
 * bit between them: that a proof built by THIS pipeline, from the artifact the
 * keeper actually wrote, is the one the contract accepts.
 *
 * So it rebuilds the active root, asserts it equals what is on-chain, claims
 * with the proof it derived, checks the holder received exactly what the tree
 * promised, and replays the same proof to confirm nothing is paid twice.
 *
 *   DISTRIBUTOR=0x... FEE_VAULT=0x... HOLDER=0x... HOLDER_KEY=0x... \
 *     pnpm --filter offchain exec tsx src/rehearsal-claim.ts
 *
 * It signs with a holder's key, so it belongs to a fork, never to production.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RPC_URL, CHAIN_ID } from "./config.js";
import { distributorAbi } from "./abis.js";
import { buildCumulative } from "./epoch.js";

const D = process.env.DISTRIBUTOR as Address;
const V = process.env.FEE_VAULT as Address;
const chain = { id: CHAIN_ID, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } } as const;
const pub = createPublicClient({ transport: http(RPC_URL) });

const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;

const active = await pub.readContract({ address: D, abi: distributorAbi, functionName: "activeRoot" });
const root = await pub.readContract({ address: D, abi: distributorAbi, functionName: "roots", args: [active] });
const upTo = Number(root[4]);
console.log(`active root #${active}, covers through epoch ${upTo}`);

const built = await buildCumulative(D, V, upTo);
console.log(`rebuilt: claimRoot ${built.claimRoot}`);
console.log(`on-chain claimRoot ${root[2]}`);
if (built.claimRoot !== root[2]) { console.error("MISMATCH — rebuild does not equal the published root"); process.exit(1); }
console.log("rebuild MATCHES the published root");

const holder = (process.env.HOLDER ?? built.entries[0]!.holder).toLowerCase() as Address;
const mine = built.entries.filter((e) => e.holder.toLowerCase() === holder);
console.log(`\nholder ${holder}: ${mine.length} stock(s) owed`);

const account = privateKeyToAccount(process.env.HOLDER_KEY as Hex);
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });

const stocks = mine.map((e) => e.stock as Address);
const cum = mine.map((e) => e.cumulative);
const proofs = mine.map((e) => built.proofFor(e.holder, e.stock, "claim") as Hex[]);

const before = await Promise.all(stocks.map((s) => pub.readContract({ address: s, abi: erc20, functionName: "balanceOf", args: [holder] })));
const hash = await wallet.writeContract({ address: D, abi: [{ type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes32[][]" }], outputs: [] }] as const, functionName: "claim", args: [stocks, cum, proofs] });
const r = await pub.waitForTransactionReceipt({ hash });
console.log(`claim ${r.status}, gas=${r.gasUsed}`);

const after = await Promise.all(stocks.map((s) => pub.readContract({ address: s, abi: erc20, functionName: "balanceOf", args: [holder] })));
let ok = true;
for (let i = 0; i < stocks.length; i++) {
  const got = (after[i] as bigint) - (before[i] as bigint);
  const want = cum[i]!;
  console.log(`  ${stocks[i]}  got ${got}  owed ${want}  ${got === want ? "OK" : "MISMATCH"}`);
  if (got !== want) ok = false;
}

// Replaying the same proof must pay nothing more.
try {
  const h2 = await wallet.writeContract({ address: D, abi: [{ type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes32[][]" }], outputs: [] }] as const, functionName: "claim", args: [stocks, cum, proofs] });
  await pub.waitForTransactionReceipt({ hash: h2 });
  const again = await Promise.all(stocks.map((s) => pub.readContract({ address: s, abi: erc20, functionName: "balanceOf", args: [holder] })));
  const paidTwice = again.some((b, i) => (b as bigint) > (after[i] as bigint));
  console.log(paidTwice ? "  REPLAY PAID AGAIN — serious" : "  replay: nothing more paid");
  if (paidTwice) ok = false;
} catch {
  console.log("  replay: reverted (expected, S6)");
}
console.log(ok ? "\nCLAIM OK" : "\nCLAIM FAILED");
process.exit(ok ? 0 : 1);
