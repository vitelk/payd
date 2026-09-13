/**
 * custody.ts — the two pre-launch checks that were still prose.
 *
 * `docs/LAUNCH_2026_12_09.md` §1 is the whole of the control on the residual
 * that no code can close: anyone holding **both** the keeper key and the
 * co-signer key takes the Distributor's entire undelivered balance. §1.1, §1.4
 * and §1.5 each ship a command. **§1.2 and §1.3 did not** — they said "walk the
 * explorer by hand" and "confirm on the two machines, and record who confirmed
 * it", with a blank form. A check whose output is a blank somebody fills in is a
 * check that passes on a busy day.
 *
 *   pnpm --filter offchain custody funding    # 1.2 — where each key was funded from
 *   pnpm --filter offchain custody attest     # 1.3 — sign what THIS host is
 *   pnpm --filter offchain custody verify     # 1.3 — diff two attestations
 *
 * **What this does not do.** §1.3 is not observable and no code makes it so:
 * two signed statements do not prove two machines, they make the claim
 * attributable to the key that made it and comparable to the other one. It
 * catches co-location by an honest operator, which is the realistic failure. It
 * does not catch a liar, and `verify` says so on every run.
 */
import { createPublicClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { hashMessage, recoverAddress } from "viem";
import { RPC_URL, CHAIN_ID } from "./config.js";
import { distributorAbi } from "./abis.js";

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 3, retryDelay: 500 }) });

// ---------------------------------------------------------------- 1.2

export interface Funding {
  address: Address;
  /** Lowest block at which the balance is non-zero. */
  fundedAt: bigint | null;
  /** Who sent the transaction that credited it, when that is a top-level send. */
  funder: Address | null;
  /** Set when the credit was internal to a contract call, which this cannot follow. */
  note?: string;
}

/**
 * **The first block at which an address held anything**, by bisection.
 *
 * The explorer is behind Cloudflare and wants a browser User-Agent, so it is not
 * a dependency a check can rest on. `eth_getBalance` at a historical block is,
 * **against the archive endpoint** — the public node prunes and answers
 * `metadata is not found` a few thousand blocks back, which is the same trap
 * `CLAUDE.md` records for the fork suite. Run this with `RPC_URL` pointed at the
 * archive one.
 *
 * ~26 calls for a 60M-block chain, against scanning which is not finishable.
 */
export async function firstFundedBlock(address: Address, head: bigint): Promise<bigint | null> {
  if ((await pub.getBalance({ address, blockNumber: head })) === 0n) return null;
  let lo = 0n;
  let hi = head;
  // Invariant: balance is zero at `lo` and non-zero at `hi`.
  if ((await pub.getBalance({ address, blockNumber: 0n })) !== 0n) return 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await pub.getBalance({ address, blockNumber: mid })) === 0n) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Who credited `address` in `block`, when a top-level transfer did it. */
export async function funderIn(address: Address, blockNumber: bigint): Promise<Address | null> {
  const block = await pub.getBlock({ blockNumber, includeTransactions: true });
  const lower = address.toLowerCase();
  for (const tx of block.transactions) {
    if (typeof tx === "string") continue;
    if (tx.to?.toLowerCase() === lower && tx.value > 0n) return tx.from as Address;
  }
  return null;
}

export async function fundingOf(address: Address, head: bigint): Promise<Funding> {
  const fundedAt = await firstFundedBlock(address, head);
  if (fundedAt === null) return { address, fundedAt: null, funder: null, note: "never held a wei" };
  const funder = await funderIn(address, fundedAt);
  return {
    address,
    fundedAt,
    funder,
    // A withdrawal routed through a contract credits the address inside a call,
    // not as a top-level `to`. Saying so is the honest answer; guessing is not.
    note: funder ? undefined : "credited inside a contract call — open this block on the explorer by hand",
  };
}

/**
 * **The verdict §1.2 asks for.** Two keys funded from the same place are one key
 * wearing two hats, and the whole arrangement is decorative.
 */
export function sameOrigin(a: Funding, b: Funding): boolean {
  return a.funder !== null && b.funder !== null && a.funder.toLowerCase() === b.funder.toLowerCase();
}

// ---------------------------------------------------------------- 1.3

export interface Attestation {
  role: "keeper" | "cosigner";
  host: string;
  /** The RPC is hashed, NEVER printed: these URLs carry API keys. */
  rpcHash: Hex;
  clientVersion: string;
  chainId: number;
  at: string;
  signer: Address;
  signature: Hex;
}

/** Exactly what is signed. Read by `verify` rather than re-derived there. */
export function attestationPayload(a: Omit<Attestation, "signature" | "signer">): string {
  return [a.role, a.host, a.rpcHash, a.clientVersion, String(a.chainId), a.at].join("\n");
}

export async function attest(role: Attestation["role"], privateKey: Hex): Promise<Attestation> {
  const { hostname } = await import("node:os");
  const account = privateKeyToAccount(privateKey);
  let clientVersion = "unknown";
  try {
    clientVersion = (await pub.request({ method: "web3_clientVersion" } as never)) as string;
  } catch {
    /* a node that will not say is itself worth recording */
  }
  const body = {
    role,
    host: hostname(),
    rpcHash: keccak256(toHex(RPC_URL)),
    clientVersion,
    chainId: CHAIN_ID,
    at: new Date().toISOString(),
    signer: account.address,
  };
  const signature = await sign({ hash: hashMessage(attestationPayload(body)), privateKey, to: "hex" });
  return { ...body, signature };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

/**
 * **Diffs two attestations and says what is wrong with the pair.** Same host,
 * same RPC, or a signature that does not recover to the address the Distributor
 * actually names — each of those is the arrangement being decorative.
 */
export async function verifyPair(
  keeper: Attestation,
  cosigner: Attestation,
  onChain: { keeper: Address; coSigner: Address },
): Promise<VerifyResult> {
  const problems: string[] = [];

  for (const [a, expected, label] of [
    [keeper, onChain.keeper, "keeper"],
    [cosigner, onChain.coSigner, "co-signer"],
  ] as const) {
    const recovered = await recoverAddress({
      hash: hashMessage(attestationPayload({ ...a })),
      signature: a.signature,
    });
    if (recovered.toLowerCase() !== a.signer.toLowerCase()) {
      problems.push(`${label}: the attestation does not recover to the key that claims to have made it`);
    } else if (recovered.toLowerCase() !== expected.toLowerCase()) {
      problems.push(`${label}: signed by ${recovered}, but the Distributor names ${expected}`);
    }
  }

  // The two failures this check exists for.
  if (keeper.host === cosigner.host) {
    problems.push(`both processes report the SAME HOST (${keeper.host}) — the second key buys nothing`);
  }
  if (keeper.rpcHash === cosigner.rpcHash) {
    problems.push("both processes replay against the SAME RPC — the second key is a second signature, not a second computation");
  }
  if (keeper.signer.toLowerCase() === cosigner.signer.toLowerCase()) {
    problems.push("one address is attesting to both roles");
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- the process

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing from the environment`);
  return v;
}

async function main() {
  const mode = process.argv[2];

  if (mode === "funding") {
    const distributor = need("DISTRIBUTOR") as Address;
    const [keeper, coSigner] = await Promise.all([
      pub.readContract({ address: distributor, abi: distributorAbi, functionName: "keeper" }),
      pub.readContract({ address: distributor, abi: distributorAbi, functionName: "coSigner" }),
    ]);
    console.log(`custody 1.1  keeper    ${keeper}`);
    console.log(`custody 1.1  co-signer ${coSigner}`);
    if ((coSigner as string) === "0x0000000000000000000000000000000000000000") {
      console.error("custody 1.1  NO CO-SIGNER NAMED. §1 of the launch doc does not apply yet, and one key publishes.");
      process.exit(1);
    }
    if ((keeper as string).toLowerCase() === (coSigner as string).toLowerCase()) {
      console.error("custody 1.1  THE TWO KEYS ARE ONE ADDRESS.");
      process.exit(1);
    }

    const head = await pub.getBlockNumber();
    console.log(`custody 1.2  bisecting to block ${head} — point RPC_URL at the ARCHIVE endpoint or this lies`);
    const k = await fundingOf(keeper as Address, head);
    const c = await fundingOf(coSigner as Address, head);
    for (const [label, f] of [["keeper   ", k], ["co-signer", c]] as const) {
      console.log(`custody 1.2  ${label} first funded at block ${f.fundedAt} by ${f.funder ?? "?"}`);
      if (f.note) console.log(`custody 1.2  ${label}   ${f.note}`);
    }
    if (sameOrigin(k, c)) {
      console.error(`custody 1.2  SAME FUNDER (${k.funder}). Two hats, one key. NO-GO.`);
      process.exit(1);
    }
    console.log("custody 1.2  different funders — record both blocks in docs/recon.md with today's date");
    return;
  }

  if (mode === "attest") {
    const role = process.argv[3] as Attestation["role"];
    if (role !== "keeper" && role !== "cosigner") throw new Error("usage: custody attest <keeper|cosigner>");
    const key = need(role === "keeper" ? "KEEPER_PRIVATE_KEY" : "COSIGNER_PRIVATE_KEY") as Hex;
    const a = await attest(role, key);
    console.log(JSON.stringify(a, null, 2));
    console.error(`\ncustody 1.3  written as ${role} on host ${a.host}. Save this to ${role}.attestation.json`);
    console.error("custody 1.3  and run `custody verify` with BOTH files, on a third machine.");
    return;
  }

  if (mode === "verify") {
    const { readFile } = await import("node:fs/promises");
    const [, , , kPath, cPath] = process.argv;
    if (!kPath || !cPath) throw new Error("usage: custody verify <keeper.json> <cosigner.json>");
    const distributor = need("DISTRIBUTOR") as Address;
    const [keeper, coSigner] = await Promise.all([
      pub.readContract({ address: distributor, abi: distributorAbi, functionName: "keeper" }),
      pub.readContract({ address: distributor, abi: distributorAbi, functionName: "coSigner" }),
    ]);
    const k = JSON.parse(await readFile(kPath, "utf8")) as Attestation;
    const c = JSON.parse(await readFile(cPath, "utf8")) as Attestation;
    const r = await verifyPair(k, c, { keeper: keeper as Address, coSigner: coSigner as Address });
    console.log(`custody 1.3  keeper    host ${k.host}  rpc ${k.rpcHash.slice(0, 10)}  at ${k.at}`);
    console.log(`custody 1.3  co-signer host ${c.host}  rpc ${c.rpcHash.slice(0, 10)}  at ${c.at}`);
    for (const p of r.problems) console.error(`custody 1.3  ${p}`);
    console.error(
      "\ncustody 1.3  THIS DOES NOT PROVE TWO MACHINES. Two signed statements are attributable\n" +
        "custody 1.3  and comparable, which catches co-location by an honest operator. A hostname\n" +
        "custody 1.3  is self-reported. §1.3 still needs a named person, and this is what they sign.",
    );
    if (!r.ok) process.exit(1);
    console.log("custody 1.3  two hosts, two RPCs, both signatures match the on-chain roles");
    return;
  }

  throw new Error("usage: custody <funding|attest|verify>");
}

if (process.argv[1]?.endsWith("custody.ts")) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
