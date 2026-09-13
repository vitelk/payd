/**
 * watch.ts — every published root, replayed, out loud.
 *
 * **What it is for, now that the co-signature exists.** The second key refuses
 * a root it cannot reproduce, so the nominal path is already guarded. What it
 * does not cover is the two states where the requirement is not in force:
 *
 *   - a vault whose `coSigner` was never named — every vault created before it
 *     existed, and every vault created while `Payd.coSigner` is zero;
 *   - a vault whose co-signer has been silent past `CO_SIGNER_GRACE`, where the
 *     pinned key publishes alone on purpose rather than stopping the vault.
 *
 * In both, the only thing standing between a false root and nobody noticing is
 * that somebody re-runs the computation. `dispute.ts` does exactly that and is
 * run by hand; this runs it on every root, for ever, and says so.
 *
 * It holds no key and sends no transaction. Run it anywhere — including on a
 * machine that is neither the keeper's nor the co-signer's, which is the point.
 *
 *   DISTRIBUTOR=0x… FEE_VAULT=0x… pnpm --filter offchain watch
 *
 * `ALERT_WEBHOOK_URL` posts a line to Discord or Slack as well. Without it the
 * console is the alert.
 */
import { createPublicClient, http, slice, toFunctionSelector, type Address, type Hex } from "viem";
import { RPC_URL, CHAIN_ID } from "./config.js";
import { distributorAbi, timelockAbi } from "./abis.js";
import { buildCumulative } from "./epoch.js";
import { disputeVerdict, DIVERGENCE_MEANING } from "./dispute.js";
import { scanEvents } from "./logs.js";

const chain = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;
const pub = createPublicClient({ chain, transport: http(RPC_URL, { retryCount: 5, retryDelay: 500 }) });

const POLL_MS = 60_000;

/**
 * **How far back to look, derived from the thing being watched.**
 *
 * Both look-backs in this file were `5_000n`, a round number with no relation
 * to anything. Measured at block 60 310 000 with `cast block`, 5 000 blocks span
 * **515 seconds** on this chain — 0.103 s per block — so the window covered
 * **4.8 %** of the three-hour grace it was implicitly sized against. A root put
 * on the record was shouted about for eight minutes and then silent for the
 * hour before it published on one key, and a watcher restarted after ten
 * minutes down had already missed every `CallScheduled` in between.
 *
 * So the width is now the quantity it has to cover, converted once. Rounded up
 * generously: over-reading costs one `eth_getLogs`, under-reading costs the
 * whole point of the process.
 */
const SECONDS_PER_BLOCK = 0.103;
const CO_SIGNER_GRACE_SECONDS = 3 * 60 * 60;
export const LOOKBACK_BLOCKS = BigInt(Math.ceil((CO_SIGNER_GRACE_SECONDS * 2) / SECONDS_PER_BLOCK));

/**
 * **What a scheduled call is, by its selector — and the four that end the
 * protocol's ability to warn anyone.**
 *
 * The Safe is the timelock's sole proposer, but through the timelock it reaches
 * `grantRole`, `revokeRole` and `updateDelay`, because `TimelockController`'s
 * constructor grants `DEFAULT_ADMIN_ROLE` to the timelock itself. So a Safe
 * acting against the protocol can, at one 48-hour delay each:
 *
 *   1. `grantRole(PROPOSER_ROLE, x)`  -- x proposes in its own right, and
 *      recovering the Safe afterwards no longer removes it;
 *   2. `revokeRole(PROPOSER_ROLE, safe)` -- the legitimate Safe is gone;
 *   3. `updateDelay(0)` -- and nothing is ever announced again.
 *
 * Every one of those is public for a full delay before it lands. **That
 * announcement is the entire defence, and until this existed nothing read it.**
 */
/**
 * **Derived from the signatures, never written by hand.** The first draft of
 * this table had three hand-written selectors and all three were wrong — which
 * would have printed "unrecognised selector" for exactly the calls that matter
 * most, quietly, for ever. `watchSelectors` computes them, and
 * `watch.test.ts` pins the three governance ones against their known values so
 * a rename cannot slide past.
 */
export const WATCHED: Record<string, string> = {
  // The three that change who governs, or whether anyone is warned at all.
  "grantRole(bytes32,address)": "grantRole -- SOMEBODY NEW WILL BE ABLE TO PROPOSE",
  "revokeRole(bytes32,address)": "revokeRole -- SOMEBODY WILL LOSE A ROLE, POSSIBLY THE SAFE ITSELF",
  "updateDelay(uint256)": "updateDelay -- THE WARNING WINDOW ITSELF IS BEING CHANGED",
  // The doors FLOWS.md 7 calls out as moving value to an address somebody names.
  "setFactory(address)": "Payd.setFactory -- a hostile factory would mint valid migrate destinations",
  "enableFactory(address)": "Payd.enableFactory",
  "bindPlatform(address,address)": "Treasury.bindPlatform -- names who receives a third of everything",
  "migrateTreasury(address)": "Treasury.migrateTreasury -- sends the whole Treasury to a named address",
  // The keys on the publication path.
  "setKeeper(address)": "setKeeper",
  "allowKeeper(address,bool)": "Payd.allowKeeper -- widens who may publish a root",
  "setCoSigner(address)": "setCoSigner -- the second key on a root",
  "setSplit(uint256,uint256,uint256,uint256)": "Treasury.setSplit",
};

export const GOVERNANCE = new Set([
  "grantRole(bytes32,address)",
  "revokeRole(bytes32,address)",
  "updateDelay(uint256)",
]);

/** selector -> {label, governance}, computed once. */
export function watchSelectors(): Map<string, { label: string; governance: boolean }> {
  const m = new Map<string, { label: string; governance: boolean }>();
  for (const [sig, label] of Object.entries(WATCHED)) {
    m.set(toFunctionSelector(sig), { label, governance: GOVERNANCE.has(sig) });
  }
  return m;
}

const SELECTORS = watchSelectors();

function say(line: string) {
  console.log(`[watch] ${new Date().toISOString()} ${line}`);
}

async function shout(line: string) {
  console.error(`[watch] *** ${line} ***`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: line, text: line }),
  }).catch((e) => console.error("[watch] webhook failed:", (e as Error).message));
}

/**
 * One root, replayed. Returns true when it matches.
 *
 * The replay goes through `epoch.ts`, the same code the keeper runs, so a
 * divergence reported here is a real one rather than an implementation
 * difference — the property `dispute.ts` is built on and the reason neither of
 * them takes a computation parameter.
 */
export async function checkRoot(distributor: Address, vault: Address, rootId: bigint): Promise<boolean> {
  const r = await pub.readContract({ address: distributor, abi: distributorAbi, functionName: "roots", args: [rootId] });
  const [publisher, , claimRoot, pushRoot, upToEpoch, digest] = r;
  const mine = await buildCumulative(distributor, vault, Number(upToEpoch));
  const verdict = disputeVerdict({ claimRoot, pushRoot, cid: digest }, {
    claimRoot: mine.claimRoot,
    pushRoot: mine.pushRoot,
    cid: mine.cid,
  });
  if (verdict.matches) {
    say(`root #${rootId} (epoch ${upToEpoch}, by ${publisher}) reproduces exactly`);
    return true;
  }
  await shout(`DIVERGENCE on root #${rootId}, epoch ${upToEpoch}, published by ${publisher}`);
  for (const d of verdict.differs) await shout(`  ${DIVERGENCE_MEANING[d]}`);
  await shout("  run `pnpm --filter offchain dispute " + rootId + "` and publish what it writes");
  return false;
}

/**
 * **Reads the timelock's announcements, which nothing else does.**
 *
 * A scheduled call is visible for one full delay before it can execute, and
 * that is the only thing standing between a compromised Safe and a permanent,
 * instant takeover. Reading it is not optional coverage — it is the mechanism.
 *
 * Off by default only in the sense that it needs `TIMELOCK` in the environment;
 * when it is absent this says so once per round rather than passing quietly.
 */
let govCursor = 0n;
async function watchGovernance() {
  const timelock = process.env.TIMELOCK as Address | undefined;
  if (!timelock) {
    say("TIMELOCK is not set: nothing is reading the governance announcements");
    return;
  }
  const head = await pub.getBlockNumber();
  // A restart re-enters this branch, so the window has to be wide enough that a
  // process down for a while still sees what was scheduled. `WATCH_FROM_BLOCK`
  // pins it exactly when an operator knows where to resume.
  if (govCursor === 0n) {
    const pinned = process.env.WATCH_FROM_BLOCK;
    govCursor = pinned ? BigInt(pinned) : head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    say(`reading the timelock's announcements from block ${govCursor}`);
  }

  // **The cursor does not move over a range this node failed to serve.** A
  // `CallScheduled` fires ONCE, 48 h before it lands, and FLOWS.md 7.d calls
  // that announcement the entire defence. Swallowing the rejection into `[]`
  // and advancing anyway turned one rate-limited query into a permanent blind
  // spot over exactly the window it was watching.
  let logs;
  let delays;
  try {
    // Paged, for the reason cosign.ts carries in full: a cursor that does not
    // advance leaves `head - govCursor` growing past the node's range cap, and
    // from there the watcher reads nothing at all rather than reading late.
    logs = await scanEvents(pub, {
      address: timelock, abi: timelockAbi, eventName: "CallScheduled", fromBlock: govCursor, toBlock: head,
    });
    delays = await scanEvents(pub, {
      address: timelock, abi: timelockAbi, eventName: "MinDelayChange", fromBlock: govCursor, toBlock: head,
    });
  } catch (e) {
    await shout(`could NOT read the timelock for blocks ${govCursor}..${head}: ${(e as Error).message}`);
    await shout("  the cursor is NOT advancing. Nothing in that range has been read yet.");
    return;
  }
  for (const l of logs) {
    const a = l.args as { id?: Hex; target?: Address; data?: Hex; delay?: bigint };
    const sel = a.data && a.data.length >= 10 ? (slice(a.data, 0, 4) as string) : "0x";
    const named = SELECTORS.get(sel);
    const line = `SCHEDULED on the timelock: ${named?.label ?? `unrecognised selector ${sel}`} -> ${a.target}`;
    await shout(line);
    if (named?.governance) {
      await shout(`  it executes in ${a.delay ?? "?"}s. If this was not proposed by you, that window is all there is.`);
    }
  }

  for (const l of delays) {
    const a = l.args as { oldDuration?: bigint; newDuration?: bigint };
    await shout(`THE TIMELOCK DELAY CHANGED: ${a.oldDuration}s -> ${a.newDuration}s`);
    if ((a.newDuration ?? 0n) === 0n) await shout("  it is ZERO. Nothing will be announced in advance again.");
  }
  govCursor = head + 1n;
}

async function main() {
  const distributor = process.env.DISTRIBUTOR as Address;
  const vault = process.env.FEE_VAULT as Address;
  if (!distributor || !vault) throw new Error("DISTRIBUTOR and FEE_VAULT missing from the environment");

  say(`watching ${distributor} on ${RPC_URL}`);
  let seen = 0n;
  for (;;) {
    try {
      const count = await pub.readContract({ address: distributor, abi: distributorAbi, functionName: "rootCount" });
      if (seen === 0n) {
        // Start at the frontier rather than replaying the whole history on a
        // cold start: what this process is for is the NEXT root.
        seen = count;
        say(`starting at root #${count}`);
      }
      while (seen < count) {
        seen += 1n;
        await checkRoot(distributor, vault, seen);
      }
      // Said every round, not once at startup: a requirement that lapsed three
      // hours ago is exactly the state nobody notices.
      const required = await pub.readContract({
        address: distributor, abi: distributorAbi, functionName: "coSignerRequired",
      });
      const named = await pub.readContract({ address: distributor, abi: distributorAbi, functionName: "coSigner" });
      if (named !== "0x0000000000000000000000000000000000000000" && !required) {
        await shout("the co-signer is NAMED but SILENT past the grace: roots are going out on one key");
      }
      // A root put on the record is a root that will go out on ONE key in three
      // hours. On an honest cycle it means the co-signer is refusing and should
      // be looked at; on a hostile one it is the forged root, in public, three
      // hours early. Either way it is the loudest line this process has.
      // Paged too, and this one was the quietest of the three: `LOOKBACK_BLOCKS`
      // is ~210,000, four times the node's cap, so the read failed every round
      // and `.catch(() => [])` turned the loudest line this process has into
      // silence. The `catch` stays — a watcher that throws stops watching — but
      // it no longer has a refusal to swallow on every single round.
      const watchHead = await pub.getBlockNumber();
      for (const l of await scanEvents(pub, {
        address: distributor, abi: distributorAbi, eventName: "CoSignatureRequested",
        fromBlock: watchHead - LOOKBACK_BLOCKS, toBlock: watchHead,
      }).catch(() => [])) {
        const a = l.args as { rootKey?: string; upToEpoch?: bigint };
        await shout(`a root for epoch ${a.upToEpoch} was PUT ON THE RECORD (${a.rootKey}).`);
        await shout("  it goes out on one key when CO_SIGNER_GRACE passes. Reproduce it NOW.");
      }
      await watchGovernance();
    } catch (e) {
      console.error("[watch] round failed:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1]?.endsWith("watch.ts")) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
