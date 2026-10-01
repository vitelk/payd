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
import { createPublicClient, createWalletClient, http, nonceManager, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { RPC_URL, chain, BATCH_WAIT_MS } from "./config.js";
import { distributorAbi, feeVaultAbi, lotteryDistributorAbi, registryAbi } from "./abis.js";
import { buildRoot } from "./buildroot.js";
import { buildTickets } from "./lottery.js";
import { scanEvents } from "./logs.js";
import { metered, meterRound } from "./cu.js";

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

/** Reads are aggregated through Multicall3. See config.ts and keeper.ts. */
const pub = createPublicClient({
  chain,
  batch: { multicall: { wait: BATCH_WAIT_MS } },
  transport: metered(http(RPC_URL, { retryCount: 3, retryDelay: 500 })),
});

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
  const mine = await buildRoot(distributor, vault, upToEpoch);
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

/** What the keeper is asking to have signed, for a lottery draw. */
export interface DrawClaim {
  root: string;
  totalTickets: string;
  targetRound: number;
  /** sha256 of the canonical ticket JSON. */
  digest: string;
}

/**
 * **The draw's decision, and the one field that is NOT reproduced.**
 *
 * `root`, `totalTickets` and `digest` are the ticket set: deterministic in the
 * window, so anything but an exact match is a refusal, exactly as for a root.
 *
 * `targetRound` is different in kind — the keeper CHOOSES it, and there is no
 * canonical answer to reproduce. What makes that safe is that every future
 * round is equally unknowable: the beacon does not exist yet, so a compromised
 * keeper gains nothing by picking one over another, and it cannot move the
 * round after the fact because the signature is over it. All this checks is the
 * bound the contract itself enforces, read from the contract's own clock so the
 * two cannot drift apart.
 */
export function cosignDrawVerdict(asked: DrawClaim, mine: DrawClaim, roundNow: number): CosignVerdict {
  const differs: string[] = [];
  if (asked.root !== mine.root) differs.push("root");
  if (asked.totalTickets !== mine.totalTickets) differs.push("totalTickets");
  if (asked.digest !== mine.digest) differs.push("digest");
  // TARGET_ROUND_MARGIN = 200, TARGET_ROUND_CAP = 28_800 (LotteryDistributor).
  if (asked.targetRound < roundNow + 200 || asked.targetRound > roundNow + 28_800) differs.push("targetRound");
  if (differs.length === 0) return { sign: true };
  return {
    sign: false,
    differs,
    detail: `REFUSED: ${differs.join(", ")} — the keeper asked for a draw this node does not reproduce`,
  };
}

/**
 * Signs a draw after rebuilding its ticket set. Same shape and same rule as
 * `cosignRoot`, and `drawDigest` is likewise read from the chain rather than
 * re-derived here.
 */
export async function cosignDraw(
  distributor: Address,
  vault: Address,
  fromEpoch: number,
  upToEpoch: number,
  asked: DrawClaim,
  privateKey: Hex,
): Promise<{ ok: true; signature: Hex } | { ok: false; detail: string; differs: string[] }> {
  const mine = await buildTickets(distributor, vault, fromEpoch, upToEpoch);
  const roundNow = Number(
    await pub.readContract({ address: distributor, abi: lotteryDistributorAbi, functionName: "currentRound" }),
  );
  const verdict = cosignDrawVerdict(
    asked,
    { root: mine.root, totalTickets: mine.totalTickets.toString(), targetRound: asked.targetRound, digest: mine.digest },
    roundNow,
  );
  if (!verdict.sign) return { ok: false, detail: verdict.detail, differs: verdict.differs };

  const digest = await pub.readContract({
    address: distributor,
    abi: lotteryDistributorAbi,
    functionName: "drawDigest",
    args: [BigInt(upToEpoch), mine.root, mine.totalTickets, BigInt(asked.targetRound), mine.digest],
  });
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
/**
 * Every transaction this process sends, and the one place its nonce is decided.
 *
 * **Two sends in one pass used to claim one nonce.** `heartbeat` and
 * `policeRequests` each built their own wallet client, so viem started from an
 * empty nonce cache on every call and fell back to the node's `pending` count —
 * which on this chain does not yet show a transaction sent milliseconds
 * earlier. `beatAll` loops over the watched vaults, so the SECOND one failed
 * with `nonce too low: tx 774 state 775` — always the same vault, roughly two
 * beats in five, measured 2026-09-20.
 *
 * It had lapsed nothing: `CO_SIGNER_GRACE` is three hours against fifteen-minute
 * beats, so twelve consecutive losses are needed. But that margin IS the signal
 * keeping a two-key publication two-key, and with a third vault the last of the
 * loop would never land at all. `rejectCoSignature` goes out of the same loop
 * and the same key, where a send that does not land is a refusal that does not
 * land.
 *
 * One account per key, KEPT, with viem's `nonceManager`: it hands out
 * `lastIssued + 1` whenever the node's answer has not caught up.
 *
 * **And it is reset on a failed send, which is the half that makes it safe.**
 * `consume()` records the nonce before the transaction goes out, so a send that
 * throws burns one; without the reset the manager would then hand out a nonce
 * the chain never reaches, and every later transaction would queue behind that
 * gap for the life of the process — silently, which is this file's own worst
 * failure mode. Re-reading the chain is the recovery, and anything that failed
 * here is retried on the next pass anyway.
 */
function makeWallet(account: ReturnType<typeof privateKeyToAccount>) {
  return createWalletClient({ account, chain, transport: metered(http(RPC_URL)) });
}
interface Signer {
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof makeWallet>;
}
const signers = new Map<Hex, Signer>();

export function signerFor(privateKey: Hex): Signer {
  let s = signers.get(privateKey);
  if (!s) {
    const account = privateKeyToAccount(privateKey, { nonceManager });
    s = { account, wallet: makeWallet(account) };
    signers.set(privateKey, s);
  }
  return s;
}

/** Runs one write with that key, and hands the nonce back to the chain if it throws. */
export async function sendFrom<T>(privateKey: Hex, write: (s: Signer) => Promise<T>): Promise<T> {
  const s = signerFor(privateKey);
  try {
    return await write(s);
  } catch (e) {
    nonceManager.reset({ address: s.account.address, chainId: chain.id });
    throw e;
  }
}

/** One `eth_getLogs` walk shared by every Distributor standing at one cursor. */
export interface SharedScan {
  head: bigint;
  logs: Array<{ address: `0x${string}`; blockNumber: bigint; args: unknown }>;
}

export async function policeRequests(
  distributor: Address,
  vault: Address,
  privateKey: Hex,
  fromBlock: bigint,
  shared?: SharedScan,
): Promise<bigint> {
  const head = shared?.head ?? await pub.getBlockNumber();
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
    // A scan already done for this whole cursor group (see `policeAll`). The
    // filter is on `log.address`, which is what tells one Distributor's requests
    // from another's in a multi-address `eth_getLogs` — `scanLogs` demultiplexes
    // nothing for us, by design.
    logs = shared
      ? shared.logs.filter((l) => l.address.toLowerCase() === distributor.toLowerCase())
      : await scanEvents(pub, {
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
    // Bound here because the guard above does not narrow through a callback.
    const rootKey = a.rootKey;
    try {
    const already = await pub.readContract({
      address: distributor, abi: distributorAbi, functionName: "coSignatureRequestedAt", args: [a.rootKey],
    });
    // `REJECTED` is the sentinel the contract writes; nothing to do twice.
    if (already === 2n ** 256n - 1n) continue;

    const mine = await buildRoot(distributor, vault, Number(a.upToEpoch));
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
    await sendFrom(privateKey, ({ wallet, account }) => wallet.writeContract({
      address: distributor, abi: distributorAbi, functionName: "rejectCoSignature", args: [rootKey], account, chain,
    }));
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

/**
 * **Polices every watched vault in one pass, and that is one `eth_getLogs`.**
 *
 * The loop this replaces asked the node for the head and for a log range PER
 * VAULT, every two minutes: 2N requests a round, growing with the registry, to
 * read the same event over very nearly the same range. `scanLogs` has taken a
 * LIST of addresses since `prefetchTransfers` needed one, so N walks collapse
 * into one — the caller demultiplexes on `log.address`, which `policeRequests`
 * now does.
 *
 * **Grouped by cursor, not merged blindly.** A vault whose last round failed
 * stands at an older block than the others and has to be re-read from there;
 * putting it in the shared range would either skip what it missed or drag every
 * other vault back with it. Vaults sharing a cursor share a scan, and in the
 * steady state that is all of them — one group, one request.
 *
 * A group whose scan fails advances NO cursor in that group. That is the same
 * property the per-vault path has and it is the one that matters: a cursor
 * advances over what it READ, never over what it failed to read.
 */
let policing = false;

export async function policeAll(
  watching: Watched[],
  privateKey: Hex,
  cursors: Map<Address, bigint>,
  from: bigint,
): Promise<void> {
  // **One round at a time.** The timer fires every two minutes whether or not
  // the previous round came back, and a round is not always quick: a cold cache
  // makes `buildRoot` replay every window since epoch 0, which took 6 min 18 at
  // 152 epochs on 2026-09-16. Three rounds then overlapped.
  //
  // They were cooperative rather than competing — `windowShares` writes each
  // window as it computes it, so the second and third found the work done and
  // cost 0 CU — but each still holds a full cumulative table, and this process
  // runs on 256 MB. Converging by luck on a machine that has no memory to spare
  // is not a design.
  //
  // Skipping is the right answer and not merely the cheap one: the cursors have
  // not moved, so the range the skipped round would have read is exactly the
  // range the next one reads. Nothing is missed, only not done twice.
  if (policing) {
    console.log("cosign: the previous policing round is still running, skipping this one");
    return;
  }
  policing = true;
  try {
    await police(watching, privateKey, cursors, from);
  } finally {
    policing = false;
  }
}

async function police(
  watching: Watched[],
  privateKey: Hex,
  cursors: Map<Address, bigint>,
  from: bigint,
): Promise<void> {
  if (watching.length === 0) return;
  // **In its own `try`, and not because a head read fails often.** This is
  // called from a `setInterval`, so a rejection here is an unhandled one — it
  // takes the process down, and a co-signer that is not running is a co-signer
  // whose requirement lifts itself three hours later.
  let head: bigint;
  try {
    head = await pub.getBlockNumber();
  } catch (e) {
    console.error("cosign: could not read the head, nothing policed this round:", (e as Error).message);
    return;
  }

  const groups = new Map<bigint, Watched[]>();
  for (const w of watching) {
    const at = cursors.get(w.distributor) ?? from;
    groups.set(at, [...(groups.get(at) ?? []), w]);
  }

  for (const [at, group] of groups) {
    if (at > head) continue;
    let shared: SharedScan;
    try {
      shared = {
        head,
        logs: await scanEvents(pub, {
          address: group.map((w) => w.distributor),
          abi: distributorAbi,
          eventName: "CoSignatureRequested",
          fromBlock: at,
          toBlock: head,
        }),
      };
    } catch (e) {
      console.error(`cosign: could NOT read requests for blocks ${at}..${head}: ${(e as Error).message}`);
      console.error(`cosign:   ${group.length} vault(s) NOT policed over that range, and their cursors do NOT advance.`);
      continue;
    }
    for (const w of group) {
      try {
        cursors.set(w.distributor, await policeRequests(w.distributor, w.vault, privateKey, at, shared));
      } catch (e) {
        console.error(`cosign: watching for requests failed for ${w.vault}:`, (e as Error).message);
      }
    }
  }
  // The co-signer has no other regular round, so this is where its cost is said.
  console.log(`cosign: ${meterRound()}`);
}

/**
 * `Distributor.heartbeat` is a timestamp write, an event and one SLOAD — under
 * 50 k gas in its most expensive shape (the first beat, writing a zero slot).
 * 100 k is the ceiling with room, and **naming it skips `eth_estimateGas`**,
 * which is 87 CU of the ~360 a beat costs, 96 beats a day per vault.
 *
 * Over-estimating costs nothing: unused gas is returned, not burnt. The reason
 * to be careful is the other direction, and the reason this is safe to pin at
 * all is that the estimate was not doing any work here — `heartbeat` reverts on
 * exactly one condition, `msg.sender != coSigner`, and `watched()` has already
 * filtered those vaults out before this is ever called.
 */
const HEARTBEAT_GAS = 100_000n;

/** The one transaction this process sends on the nominal path, and the only
 *  thing keeping its own requirement in force. */
export async function heartbeat(distributor: Address, privateKey: Hex): Promise<Hex> {
  return sendFrom(privateKey, ({ wallet, account }) => wallet.writeContract({
    address: distributor, abi: distributorAbi, functionName: "heartbeat",
    account, chain, gas: HEARTBEAT_GAS,
  }));
}

/** Minutes between beats. See the paragraph in `serve()` before changing it. */
const HEARTBEAT_MS = Number(process.env.COSIGNER_HEARTBEAT_MINUTES ?? 15) * 60_000;

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
/**
 * Vaults already resolved, and what they answered.
 *
 * `FeeVault.DISTRIBUTOR` is written by `init` and never again. `coSigner` is
 * NOT of that kind — `setCoSigner` can rotate it — so only the pairing this
 * key is named on is remembered, and a vault that named somebody else is
 * re-asked every refresh. That is the direction the mistake has to fall: a key
 * that keeps beating for a vault it was removed from wastes gas, a key that
 * stops beating for a vault it was just added to lets the requirement lift
 * itself after `CO_SIGNER_GRACE`.
 */
const mine = new Map<Address, Address>();

export async function watched(registry: Address, me: Address): Promise<Watched[]> {
  const vaults = (await pub.readContract({
    address: registry, abi: registryAbi, functionName: "vaults",
  })) as readonly Address[];

  const out = await Promise.all(vaults.map(async (vault) => {
    const known = mine.get(vault);
    if (known) return { vault, distributor: known };
    try {
      const distributor = (await pub.readContract({
        address: vault, abi: feeVaultAbi, functionName: "DISTRIBUTOR",
      })) as Address;
      const named = (await pub.readContract({
        address: distributor, abi: distributorAbi, functionName: "coSigner",
      })) as Address;
      if (named.toLowerCase() !== me.toLowerCase()) return null;
      mine.set(vault, distributor);
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
 * answers `{signature}` or, with a 409, `{detail, differs}`. `POST /sign-draw`
 * is the lottery mode's equivalent, with `{distributor, vault, fromEpoch,
 * upToEpoch, root, totalTickets, targetRound, digest}`. There is no `GET`
 * and nothing to configure over the wire — the key never leaves, and the only
 * thing this process will ever put its name to is a root it reproduced itself.
 */
async function serve() {
  const key = process.env.COSIGNER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("COSIGNER_PRIVATE_KEY missing from the environment");
  const distributor = process.env.DISTRIBUTOR as Address | undefined;
  const port = Number(process.env.COSIGNER_PORT ?? 8787);
  const { account } = signerFor(key);
  const { createServer } = await import("node:http");

  console.log(`cosign: signing as ${account.address}, listening on :${port}`);
  console.log(`cosign: replaying against ${RPC_URL} — this MUST NOT be the keeper's node`);

  createServer((req, res) => {
    const draw = !!req.url?.endsWith("/sign-draw");
    if (req.method !== "POST" || !(draw || req.url?.endsWith("/sign"))) {
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
        const out = draw
          ? await cosignDraw(q.distributor, q.vault, Number(q.fromEpoch), Number(q.upToEpoch),
            { ...q, targetRound: Number(q.targetRound) }, key)
          : await cosignRoot(q.distributor, q.vault, Number(q.upToEpoch), q, key);
        if (out.ok) {
          console.log(`cosign: signed ${draw ? "draw" : "epoch"} ${q.upToEpoch} for ${q.distributor}`);
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
  //
  // **The interval is the expensive half of this process and it is NOT being
  // lowered here.** A beat costs ~276 CU and there are 96 a day per vault, so
  // thirty minutes would halve the bill — and halve the margin, from twelve
  // consecutive failures to six, on the one signal that keeps a two-key
  // publication two-key. That is a call about who can publish alone and after
  // how long, which is not a cost decision. The environment variable exists so
  // that it can be made deliberately, in one place, with this paragraph next to
  // it; the default is the value it has always had.
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
  setInterval(beatAll, HEARTBEAT_MS);

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
  setInterval(() => void policeAll(watching, key, cursors, from), 2 * 60_000);
}

// Only when RUN, not when imported: `cosign.test.ts` loads the verdict above.
if (process.argv[1]?.endsWith("cosign.ts")) {
  serve().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
