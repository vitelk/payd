/**
 * cosign.ts — the second opinion on a root, and the key that holds it.
 *
 * **This is not a second secret, it is a second COMPUTATION.** A keeper key
 * alone could publish a root awarding itself the whole undelivered balance, in
 * two transactions of the same block — `publishRoot` then `claim`, with nothing
 * in between that times anything. Detection cannot fit in that gap, so what
 * closes it sits before the publication: `Distributor.publishRoot` asks for a
 * signature by `coSigner`, and this process is what produces one.
 *
 * `preflight.ts::crossCheck` already rebuilds a root from a second node. The
 * difference is who runs it: there, the keeper checks itself, and a compromised
 * keeper simply does not run the check. Here the same recomputation is behind a
 * different key on a different machine, so it becomes a door rather than a
 * habit. Holding both secrets is not enough — the two machines have to lie the
 * same way about a deterministic, publicly reproducible computation.
 *
 * **Run it on a host that is NOT the keeper's**, against an RPC that is not the
 * keeper's either. Co-locating them rebuilds one key with extra steps.
 *
 *   COSIGNER_PRIVATE_KEY=0x… RPC_URL=<its own node> pnpm --filter offchain cosign
 *
 * It signs and it heartbeats; it never publishes. `heartbeat()` is the only
 * transaction it sends, and it is what keeps its own requirement in force:
 * `Distributor.CO_SIGNER_GRACE` lifts the requirement after three hours of
 * silence, because a deadman measured on "no root published" would be under the
 * control of whoever holds the keeper key.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { RPC_URL, CHAIN_ID } from "./config.js";
import { distributorAbi, feeVaultAbi, registryAbi } from "./abis.js";
import { buildCumulative } from "./epoch.js";
import { scanEvents } from "./logs.js";

/** What the keeper is asking to have signed. */
export interface RootClaim {
  claimRoot: string;
  pushRoot: string;
  /** `BuiltCumulative.cid` — the artifact's 32-byte content digest, which is
   *  what `publishRoot` takes as its `digest` argument. NOT the IPFS string,
   *  which is a hint the contract never verifies anything against. */
  cid: string;
}

export type CosignVerdict = { sign: true } | { sign: false; differs: string[]; detail: string };

/**
 * **The whole of the decision, as a pure function.**
 *
 * `asked` is what the keeper wants signed; `mine` is what this machine produced
 * by replaying the epochs itself. Anything but an exact match is a refusal —
 * there is no tolerance to apply, because the computation is deterministic and
 * two honest replays of the same chain state give the same three values.
 *
 * The refusal names the fields, so the log of a refusal is already the incident
 * report: `claimRoot` differing is entitlements altered, `pushRoot` is the
 * delivery floor manipulated, `cid` is the published data not matching the
 * roots it claims to produce.
 */
export function cosignVerdict(asked: RootClaim, mine: RootClaim): CosignVerdict {
  const differs: string[] = [];
  if (asked.claimRoot !== mine.claimRoot) differs.push("claimRoot");
  if (asked.pushRoot !== mine.pushRoot) differs.push("pushRoot");
  if (asked.cid !== mine.cid) differs.push("cid");
  if (differs.length === 0) return { sign: true };
  return {
    sign: false,
    differs,
    detail: `REFUSED: ${differs.join(", ")} — the keeper asked for a root this node does not reproduce`,
  };
}

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 3, retryDelay: 500 }) });

/**
 * Signs a root after reproducing it. Returns the signature, or the refusal.
 *
 * **The digest is read from the CHAIN, never re-derived here.** Two
 * implementations of one hash is two implementations of one hash, and the day
 * they disagree the co-signer stops being able to sign anything at all. So
 * `rootDigest` is a `public view` on the Distributor and this asks for it.
 */
export async function cosignRoot(
  distributor: Address,
  vault: Address,
  upToEpoch: number,
  asked: RootClaim,
  privateKey: Hex,
): Promise<{ ok: true; signature: Hex } | { ok: false; detail: string; differs: string[] }> {
  const mine = await buildCumulative(distributor, vault, upToEpoch);
  const verdict = cosignVerdict(asked, { claimRoot: mine.claimRoot, pushRoot: mine.pushRoot, cid: mine.cid });
  if (!verdict.sign) return { ok: false, detail: verdict.detail, differs: verdict.differs };

  const digest = await pub.readContract({
    address: distributor,
    abi: distributorAbi,
    functionName: "rootDigest",
    args: [BigInt(upToEpoch), mine.claimRoot as Hex, mine.pushRoot as Hex, mine.cid as Hex],
  });
  // `rootDigest` already carries the EIP-191 prefix, so this signs the 32 bytes
  // as they are. `signMessage` would prefix them a second time and recover to
  // an address nobody holds.
  const signature = await sign({ hash: digest as Hex, privateKey, to: "hex" });
  return { ok: true, signature };
}

/**
 * **Watches the chain for roots put on the record, and refuses the ones it does
 * not reproduce.** This is the half that actually shuts the door.
 *
 * A compromised keeper does not ask this process over HTTP — it calls
 * `requestCoSignature` on-chain and waits out `CO_SIGNER_GRACE`, at the end of
 * which it publishes alone. Three hours, against the forty-eight a rotation
 * takes. So the refusal cannot wait to be asked: it has to come from watching.
 *
 * The event carries the root's KEY and its epoch, not its fields — which is
 * enough. This node replays that epoch, hashes what it gets through the same
 * `rootDigest` the contract uses, and rejects any key that is not the one it
 * would have produced.
 */
export async function policeRequests(
  distributor: Address,
  vault: Address,
  privateKey: Hex,
  fromBlock: bigint,
): Promise<bigint> {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const head = await pub.getBlockNumber();
  // **A cursor advances over what it READ, never over what it failed to read.**
  // This used to catch the rejection into an empty array and then return
  // `head + 1` regardless, so one rate-limited `eth_getLogs` blinded this
  // process to that block range for ever — on a chain where 429s are the public
  // node's normal failure. `CoSignatureRequested` is the one event that turns a
  // three-hour clock into three hours of notice, and this is the only process
  // that acts on it. Failing here means: change nothing, say so, try the same
  // range again next tick.
  //
  // **And it is PAGED.** `getContractEvents` asked for the whole range in one
  // request; with the cursor pinned at the deployment block that range passed
  // the node's 50,000-block cap within the hour and never came back under it,
  // so the cursor froze at genesis and every root since was unpoliced. `head`
  // only moves away from `fromBlock`, which is why this one could not heal.
  let logs;
  try {
    logs = await scanEvents(pub, {
      address: distributor,
      abi: distributorAbi,
      eventName: "CoSignatureRequested",
      fromBlock,
      toBlock: head,
    });
  } catch (e) {
    console.error(`cosign: could NOT read requests for blocks ${fromBlock}..${head}: ${(e as Error).message}`);
    console.error("cosign:   the cursor is NOT advancing. This range will be re-read, and until it is");
    console.error("cosign:   a root put on the record inside it is unpoliced.");
    return fromBlock;
  }

  // The furthest block every log up to here has been handled from. A failure
  // part-way through rewinds to the last block fully policed rather than
  // dropping the rest of the range.
  let done = fromBlock;
  for (const l of logs) {
    const a = l.args as { rootKey?: Hex; upToEpoch?: bigint };
    if (!a.rootKey || a.upToEpoch === undefined) continue;
    try {
    const already = await pub.readContract({
      address: distributor, abi: distributorAbi, functionName: "coSignatureRequestedAt", args: [a.rootKey],
    });
    // `REJECTED` is the sentinel the contract writes; nothing to do twice.
    if (already === 2n ** 256n - 1n) continue;

    const mine = await buildCumulative(distributor, vault, Number(a.upToEpoch));
    const myKey = await pub.readContract({
      address: distributor, abi: distributorAbi, functionName: "rootDigest",
      args: [a.upToEpoch, mine.claimRoot as Hex, mine.pushRoot as Hex, mine.cid as Hex],
    });
    if (myKey === a.rootKey) {
      console.log(`cosign: request for epoch ${a.upToEpoch} matches this node — leaving it to lapse or be signed`);
      continue;
    }
    console.error(`cosign: REFUSING a root on the record for epoch ${a.upToEpoch}`);
    console.error(`cosign:   asked ${a.rootKey}`);
    console.error(`cosign:   mine  ${myKey}`);
    await wallet.writeContract({
      address: distributor, abi: distributorAbi, functionName: "rejectCoSignature", args: [a.rootKey], account, chain,
    });
    console.error("cosign:   rejected on-chain. It can never lapse into a single-key publication.");
    } catch (e) {
      // One request this node could not settle. Everything before it stays
      // policed; this block and after are re-read next tick.
      console.error(`cosign: FAILED to settle the request in block ${l.blockNumber}: ${(e as Error).message}`);
      return done;
    }
    if (l.blockNumber > done) done = l.blockNumber;
  }
  return head + 1n;
}

/** The one transaction this process sends on the nominal path, and the only
 *  thing keeping its own requirement in force. */
export async function heartbeat(distributor: Address, privateKey: Hex): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  return wallet.writeContract({ address: distributor, abi: distributorAbi, functionName: "heartbeat", account, chain });
}

/** One launch this key is the second signature on. */
export interface Watched {
  vault: Address;
  distributor: Address;
}

/**
 * **Every vault this key is named on, not the one an environment variable
 * remembered.** `Payd._create` stamps the registry's co-signer into each new
 * Distributor at birth, so a third-party launch names THIS key without anybody
 * touching this process. Pinning one `DISTRIBUTOR` therefore covered $PAYD and
 * left every later launch with a second key that signs but never heartbeats:
 * `setCoSigner` primes `coSignerHeartbeat`, so such a vault requires the
 * co-signature for `CO_SIGNER_GRACE` and then silently stops requiring it. The
 * keeper was moved to `vaults()` for the same reason; this is that change, on
 * this side.
 *
 * A Distributor naming a DIFFERENT co-signer is skipped rather than attempted:
 * `heartbeat()` reverts on `msg.sender != coSigner`, and a revert per vault per
 * quarter-hour is noise that hides the real failures.
 */
export async function watched(registry: Address, me: Address): Promise<Watched[]> {
  const vaults = (await pub.readContract({
    address: registry, abi: registryAbi, functionName: "vaults",
  })) as readonly Address[];

  const out = await Promise.all(vaults.map(async (vault) => {
    try {
      const distributor = (await pub.readContract({
        address: vault, abi: feeVaultAbi, functionName: "DISTRIBUTOR",
      })) as Address;
      const named = (await pub.readContract({
        address: distributor, abi: distributorAbi, functionName: "coSigner",
      })) as Address;
      if (named.toLowerCase() !== me.toLowerCase()) return null;
      return { vault, distributor };
    } catch {
      // One unreadable vault must not blind the process to the others. It will
      // be retried on the next refresh, and `vaults()` only grows.
      return null;
    }
  }));
  return out.filter((w): w is Watched => w !== null);
}

// ---------------------------------------------------------------- the process

/**
 * A minimal HTTP endpoint, and a heartbeat on a timer. No framework: the
 * surface of this process is the one thing about it that should be boring.
 *
 * `POST /sign` with `{distributor, vault, upToEpoch, claimRoot, pushRoot, cid}`
 * answers `{signature}` or, with a 409, `{detail, differs}`. There is no `GET`
 * and nothing to configure over the wire — the key never leaves, and the only
 * thing this process will ever put its name to is a root it reproduced itself.
 */
async function serve() {
  const key = process.env.COSIGNER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("COSIGNER_PRIVATE_KEY missing from the environment");
  const distributor = process.env.DISTRIBUTOR as Address | undefined;
  const port = Number(process.env.COSIGNER_PORT ?? 8787);
  const account = privateKeyToAccount(key);
  const { createServer } = await import("node:http");

  console.log(`cosign: signing as ${account.address}, listening on :${port}`);
  console.log(`cosign: replaying against ${RPC_URL} — this MUST NOT be the keeper's node`);

  createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/sign")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const q = JSON.parse(body);
        const out = await cosignRoot(q.distributor, q.vault, Number(q.upToEpoch), q, key);
        if (out.ok) {
          console.log(`cosign: signed epoch ${q.upToEpoch} for ${q.distributor}`);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signature: out.signature }));
        } else {
          // Loud, and on the co-signer's own console: this is the incident.
          console.error(`cosign: ${out.detail}`);
          res.writeHead(409, { "content-type": "application/json" })
            .end(JSON.stringify({ detail: out.detail, differs: out.differs }));
        }
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ detail: (e as Error).message }));
      }
    });
  }).listen(port);

  // **Every vault this key is named on, refreshed rather than remembered.**
  // A launch created five minutes ago has a Distributor already stamped with
  // this co-signer and a `coSignerHeartbeat` primed by `setCoSigner`, so it
  // requires the second signature for CO_SIGNER_GRACE and no longer than that.
  // Re-reading the registry every quarter-hour keeps the margin at twelve
  // beats against a three-hour grace for a vault that did not exist at boot.
  const registry = process.env.REGISTRY as Address | undefined;
  if (!registry) {
    console.error("cosign: REGISTRY is not set, so NOTHING is heartbeating and nothing is policed.");
    console.error("cosign: every vault's requirement lifts itself after CO_SIGNER_GRACE and the keeper publishes alone.");
    console.error("cosign: DISTRIBUTOR and FEE_VAULT are no longer read — they named ONE launch, and the registry has many.");
    return;
  }
  if (process.env.DISTRIBUTOR || process.env.FEE_VAULT) {
    console.error("cosign: DISTRIBUTOR/FEE_VAULT are set and IGNORED. The registry is the source; remove them.");
  }

  let watching: Watched[] = [];
  const refresh = async () => {
    try {
      const next = await watched(registry, account.address);
      const before = watching.map((w) => w.distributor).join();
      watching = next;
      if (next.map((w) => w.distributor).join() !== before) {
        console.log(`cosign: watching ${next.length} vault(s): ${next.map((w) => w.vault).join(", ") || "none"}`);
      }
      if (next.length === 0) {
        console.error("cosign: the registry names this key on NO vault. Check COSIGNER_PRIVATE_KEY against Payd.coSigner().");
      }
    } catch (e) {
      // Keep the previous list: a registry that cannot be read is a reason to
      // go on beating for what we knew about, not to stop.
      console.error("cosign: could not refresh the vault list:", (e as Error).message);
    }
  };

  // **The only transaction this process sends, and it is what keeps its own
  // requirement in force.** Every fifteen minutes against a three-hour grace:
  // a dozen consecutive failures before the second key lifts itself, which is
  // not a hiccup. One vault failing does not stop the others — that is why the
  // try sits inside the loop and not around it.
  const beatAll = async () => {
    await refresh();
    for (const w of watching) {
      try {
        await heartbeat(w.distributor, key);
      } catch (e) {
        console.error(`cosign: heartbeat failed for ${w.vault}:`, (e as Error).message);
      }
    }
  };
  await beatAll();
  setInterval(beatAll, 15 * 60_000);

  // **And the watch, which is what makes the refusal exist at all.** A
  // compromised keeper never asks over HTTP: it posts the root on-chain and
  // waits out the grace. Every two minutes against a three-hour grace leaves
  // ninety chances to catch it — per vault, each with its own cursor, because
  // a shared one would rewind every launch to the slowest.
  //
  // **From the beginning, not from the head.** Starting at the current block
  // meant a co-signer switched on today never looked at what a keeper put on
  // the record yesterday — and `rejectCoSignature` requires the role, so nobody
  // could have refused it at the time either. The contract now voids requests
  // that predate the key (`coSignerNamedAt`), which closes the hole; this closes
  // the blindness, because a request banked under the PREVIOUS co-signer is
  // still worth seeing and refusing. `COSIGNER_FROM_BLOCK` skips the backfill
  // once it has been done — set it to the block the platform was deployed in,
  // or the log scan asks for a range the node will not serve and the cursor
  // never advances (`cursor.audit2.test.ts`).
  const from = BigInt(process.env.COSIGNER_FROM_BLOCK ?? "0");
  const cursors = new Map<Address, bigint>();
  console.log(`cosign: policing requests from block ${from}`);
  setInterval(async () => {
    for (const w of watching) {
      try {
        const at = cursors.get(w.distributor) ?? from;
        cursors.set(w.distributor, await policeRequests(w.distributor, w.vault, key, at));
      } catch (e) {
        console.error(`cosign: watching for requests failed for ${w.vault}:`, (e as Error).message);
      }
    }
  }, 2 * 60_000);
}

// Only when RUN, not when imported: `cosign.test.ts` loads the verdict above.
if (process.argv[1]?.endsWith("cosign.ts")) {
  serve().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
