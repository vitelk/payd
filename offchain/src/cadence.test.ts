/**
 * **What a round does when nothing has happened, and what it does again when a
 * round failed.**
 *
 * The keeper ticks every 60 s against an epoch of 30 minutes, so twenty-nine
 * rounds out of thirty can only observe. Pricing four legs, their pools and the
 * first hop's TWAP window in each of them asked the chain the same question
 * thirty times per window and paid for the answer thirty times — which, billed
 * per method, is where the invoice was.
 *
 * The steps that cannot act between two epochs are now gated on the epoch
 * having turned. That gate has exactly one dangerous failure mode, and it is
 * the one this file exists for: **a round that threw must stay fresh.** If
 * `epochSeen` were written before `tickVault` rather than after it, a purchase
 * that failed on a dry pool, or a publication that failed on IPFS, would not be
 * retried for half an hour instead of in sixty seconds — silently, with the log
 * saying nothing at all because no step ran.
 *
 * Nothing external is simulated: the stub is an HTTP JSON-RPC endpoint, i.e.
 * OUR transport. It answers every view of our own contracts with the zero of
 * its declared return type, which is what puts the whole round on its "nothing
 * to do" path, and fails `eth_estimateGas` so that no transaction is ever
 * built — `send()` logs the skip, exactly as it does against a call that would
 * revert.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData,
  encodeFunctionResult,
  toFunctionSelector,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { answerEthCall } from "./rpcstub.js";
import { build, key } from "./merkle.js";
import {
  arbGasInfoAbi, distributorAbi, erc20Abi, escrowAbi, feeVaultAbi,
  ponsFactoryAbi, portfolioBookAbi, portfolioDistributorAbi, portfolioVaultAbi,
  registryAbi, treasuryAbi, v3FactoryAbi, v3PoolAbi,
} from "./abis.js";

let checks = 0;
const failed: string[] = [];
function ok(cond: unknown, msg: string) {
  checks++;
  if (!cond) failed.push(msg);
}
function fixture(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

const REGISTRY = "0x00000000000000000000000000000000000000e1" as Address;
const VAULT = "0x00000000000000000000000000000000000000a1" as Address;
const DIST = "0x00000000000000000000000000000000000000d1" as Address;
const TOKEN = "0x00000000000000000000000000000000000000c1" as Address;
const TREASURY = "0x00000000000000000000000000000000000000f1" as Address;
const BOOK = "0x00000000000000000000000000000000000000b1" as Address;
const PIVOT = "0x00000000000000000000000000000000000000e5" as Address;
const NVDA_ISH = "0x00000000000000000000000000000000000000f5" as Address;
const QQQ_ISH = "0x00000000000000000000000000000000000000f6" as Address;
const HOLDER = "0x00000000000000000000000000000000000000a7" as Address;
const HOLDER2 = "0x00000000000000000000000000000000000000a8" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MODE_DISTRIBUTION = ("0x" + Buffer.from("distribution").toString("hex").padEnd(64, "0")) as Hex;
const MODE_PORTFOLIO = ("0x" + Buffer.from("portfolio").toString("hex").padEnd(64, "0")) as Hex;

/** What the chain is doing, driven by the test between rounds. */
const state = {
  epoch: 1n, hookReverts: false, platformPool: 0n,
  /** What a vault could not hand to the Treasury, sitting in its `pendingWithdrawal`. */
  pendingWithdrawal: 0n,
  /** The Treasury's `platformVault`, and where that vault says it has moved. */
  platformVault: ZERO as Address, vaultMigratedTo: ZERO as Address,
  /** Where the TREASURY itself says it has moved, and what keeps arriving on it. */
  treasuryMigratedTo: ZERO as Address, treasuryToken: 0n,
  /** The vault's QUOTE, i.e. the one currency the Treasury can hold besides ether. */
  quote: ZERO as Address,
  /** What `Payd.modeOf` says this vault is. The round's whole shape hangs off
   *  it, which is the point of the portfolio block at the end of this file. */
  mode: MODE_DISTRIBUTION as Hex,
  /** What `roots(activeRoot)` answers. All zeros by default — a root with
   *  nothing over the floor — which is what keeps every earlier block on the
   *  "nothing to deliver" path. The portfolio block fills it in so the shared
   *  `deliveryPlan` guard lets a round THROUGH for the first time here. */
  pushRoot: (`0x${"0".repeat(64)}`) as Hex,
  rootEpoch: 0n,
  /** The rows `PortfolioBook.linesOf` answers with, BY HOLDER, and the pivot
   *  the holders are owed in. Only the portfolio round reads either.
   *
   *  Keyed rather than shared, because what `stepConvert` does with two
   *  holders depends on whether they asked for the same stock: same, and they
   *  share one swap; different, and they get one each. A single row for
   *  everybody cannot tell those apart. An unknown holder answers `[]`, which
   *  is "no row and no default" and the step's own skip. */
  pivot: ZERO as Address,
  lines: {} as Record<string, { stock: Address; bps: number }[]>,
  /** What `decimals()` answers on the pivot. The per-line delivery floor is
   *  denominated in it, so zero — the stub's default for any unlisted view —
   *  would put the floor at one unit and let everything through. */
  pivotDecimals: 6,
  /** Stocks the registry has DELISTED. `distributeInto` refuses one, so the
   *  planner has to drop it rather than plan a call that fails its gas estimate
   *  every interval for ever. Everything not named here is allowed — the stub's
   *  own default for `listing` would be `false`, which would drop the lot. */
  delisted: new Set<string>(),
};
const SUCCESSOR = "0x00000000000000000000000000000000000000b1" as Address;
const QUOTE_TOKEN = "0x0000000000000000000000000000000000000041" as Address;

const BY_SELECTOR = new Map<string, AbiFunction>();
for (const abi of [
  distributorAbi, feeVaultAbi, registryAbi, treasuryAbi, escrowAbi,
  erc20Abi, arbGasInfoAbi, v3FactoryAbi, v3PoolAbi, ponsFactoryAbi,
  portfolioVaultAbi, portfolioDistributorAbi, portfolioBookAbi,
]) {
  for (const item of abi) {
    if (item.type === "function") BY_SELECTOR.set(toFunctionSelector(item), item as AbiFunction);
  }
}

/**
 * The zero of a declared return type.
 *
 * Enumerating every view the round touches would be a list to maintain against
 * a keeper that keeps growing; the ABI already says what shape each answer has,
 * and "all zeros" is precisely the state in which there is nothing to do.
 */
function zero(p: AbiParameter): unknown {
  const t = p.type;
  if (t.endsWith("]")) return [];
  if (t === "address") return ZERO;
  if (t === "bool") return false;
  if (t === "string") return "";
  if (t === "bytes") return "0x";
  if (t.startsWith("bytes")) return ("0x" + "00".repeat(Number(t.slice(5)))) as Hex;
  if (t.startsWith("uint") || t.startsWith("int")) {
    // viem takes a number below 53 bits and a bigint at or above it.
    const bits = Number(t.replace(/^u?int/, "") || "256");
    return bits <= 48 ? 0 : 0n;
  }
  if (t === "tuple") return (p as unknown as { components: readonly AbiParameter[] }).components.map(zero);
  throw new Error(`no zero for ${t}`);
}

/** Every contract read the node was asked for, this round. */
let reads: string[] = [];
/**
 * Every transaction the round tried to SEND, decoded.
 *
 * `eth_estimateGas` fails here so nothing is ever built, and for most steps the
 * attempt is all there is to assert on — which `reads` already carries. For
 * `distributeInto` it is not enough: the claim of this mode is that holders who
 * want the same stock share ONE swap, and only the arguments say whether they
 * did.
 */
let sends: { name: string; args: readonly unknown[] }[] = [];

function answer(to: string, data: Hex): Hex {
  const item = BY_SELECTOR.get(data.slice(0, 10));
  if (!item) throw new Error(`unstubbed selector ${data.slice(0, 10)} on ${to}`);
  reads.push(item.name);

  if (item.name === "hookStatus" && state.hookReverts) throw new Error("execution reverted");

  const override = ((): unknown | undefined => {
    switch (item.name) {
      case "vaults": return [VAULT];
      case "DISTRIBUTOR": return DIST;
      case "token": return TOKEN;
      case "modeOf": return state.mode;
      // `[publisher, publishedAt, claimRoot, pushRoot, upToEpoch, digest]`.
      case "roots":
        return [ZERO, 0, `0x${"0".repeat(64)}`, state.pushRoot, state.rootEpoch, `0x${"0".repeat(64)}`];
      case "PIVOT": return state.pivot;
      case "book": return BOOK;
      case "linesOf": {
        const { args } = decodeFunctionData({ abi: [item], data });
        return state.lines[String(args?.[0]).toLowerCase()] ?? [];
      }
      case "decimals": return state.pivotDecimals;
      case "REGISTRY": return REGISTRY;
      case "listing": {
        const { args } = decodeFunctionData({ abi: [item], data });
        const stock = String(args?.[0] ?? "").toLowerCase();
        return [3_000, ZERO, !state.delisted.has(stock)];
      }
      case "PLATFORM": return TREASURY;
      case "currentEpoch": return state.epoch;
      // A window is waiting to be covered, which is what puts the round on the
      // purchase path at all.
      case "pendingEpochs": return 3n;
      // Non-zero, so `stepPublish` reads `roots()` and concludes from it rather
      // than from the absence of any root.
      case "activeRoot": return 1n;
      // The platform's pocket, which only `stepPlatform` reads.
      case "platformPool": return state.platformPool;
      case "pendingWithdrawal": return state.pendingWithdrawal;
      case "platformVault": return state.platformVault;
      // One selector, two contracts: `FeeVault.migratedTo` says the platform
      // vault has been retired, `Treasury.migratedTo` says this whole contract
      // has. They lead to opposite branches, so the address decides.
      case "migratedTo":
        return to.toLowerCase() === TREASURY.toLowerCase() ? state.treasuryMigratedTo : state.vaultMigratedTo;
      case "QUOTE": return state.quote;
      // Only the Treasury's own holding: `balanceOf` is asked about half a
      // dozen addresses in a round, and answering them all would be answering
      // a question this file is not asking.
      case "balanceOf": {
        const { args } = decodeFunctionData({ abi: [item], data });
        return String(args?.[0]).toLowerCase() === TREASURY.toLowerCase() ? state.treasuryToken : 0n;
      }
      default: return undefined;
    }
  })();

  const outs = item.outputs;
  const result = override !== undefined
    ? override
    : outs.length === 1 ? zero(outs[0]!) : outs.map(zero);
  return encodeFunctionResult({ abi: [item], functionName: item.name, result } as never);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const q = JSON.parse(body);
    const one = (r: { id: number; method: string; params?: unknown[] }) => {
      // **A step that decided to SEND is a step that ran**, and it says so on
      // the first RPC of the send rather than in the round's reads: no
      // transaction is ever built here, so the attempt is all there is to
      // observe. Any method carrying calldata names its function.
      const sent = (r.params?.[0] ?? {}) as { data?: Hex };
      if (r.method !== "eth_call" && sent.data) {
        const item = BY_SELECTOR.get(sent.data.slice(0, 10));
        if (item) {
          reads.push(item.name);
          const { args } = decodeFunctionData({ abi: [item], data: sent.data });
          sends.push({ name: item.name, args: args ?? [] });
        }
      }
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
      const fail = (message: string) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message } });
      switch (r.method) {
        case "eth_chainId": return reply("0x1237");
        case "eth_blockNumber": return reply("0x1000");
        case "eth_getBalance": return reply("0x0");
        case "eth_getBlockByNumber":
          return reply({ number: "0x1000", timestamp: "0x1000", baseFeePerGas: "0x1", hash: `0x${"11".repeat(32)}`, transactions: [] });
        // No transaction is ever built: every `send` becomes a logged skip,
        // which is the same path a call that would revert takes.
        case "eth_estimateGas": return fail("execution reverted");
        case "eth_call": {
          const p = (r.params?.[0] ?? {}) as { to?: string; data?: Hex };
          try {
            return reply(answerEthCall(p.to!, p.data!, answer));
          } catch (e) {
            return fail((e as Error).message);
          }
        }
        default: return fail(`unstubbed ${r.method}`);
      }
    };
    const out = Array.isArray(q) ? q.map(one) : one(q);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const dir = mkdtempSync(join(tmpdir(), "payd-cadence-"));
// Recent enough that `stepDistribute` returns on its own timer, before any
// read: the delivery cadence is not what this file is about.
writeFileSync(join(dir, `last-push-${DIST.toLowerCase()}.json`), JSON.stringify({ at: Date.now() }));

process.env.RPC_URL = `http://127.0.0.1:${port}`;
process.env.REGISTRY = REGISTRY;
process.env.KEEPER_PRIVATE_KEY = ("0x" + "11".repeat(32)) as Hex;
process.env.EPOCH_DIR = dir;
// So `stepPublish` always defers rather than trying to build a root: what it
// does once it decides to publish is `publish.test.ts`'s subject, not this one.
process.env.ROOT_INTERVAL_EPOCHS = "1000";

const { tick } = await import("./keeper.js");

const round = async () => {
  reads = [];
  sends = [];
  await tick();
  return reads;
};

// `payoutBps` is read by `stepBuyBasket` and by nothing else in a round;
// `hookStatus` by `stepHook` and by nothing else. Either one appearing means
// the epoch-gated half ran.
const priced = (r: string[]) => r.includes("payoutBps");
const watchedHook = (r: string[]) => r.includes("hookStatus");

const cold = await round();
fixture(priced(cold), "fixture: a cold round prices the basket");
fixture(watchedHook(cold), "fixture: a cold round looks at the fee hook");

const same = await round();
ok(!priced(same), "a round inside the same epoch does not re-price the basket");
ok(!watchedHook(same), "...nor re-read the fee hook, which comes with three days of notice");
ok(
  !same.includes("activeRoot"),
  "...nor re-ask what is published, once this epoch has been found to have nothing to cover",
);
// The money path is NOT gated: harvest, the sweep and the deliveries keep their
// sixty seconds, and so does the registry itself.
ok(same.includes("vaults"), "the registry is still read every round");
ok(same.includes("currentEpoch"), "and so is the clock that decides the rest");

// The epoch turns, and the round that follows fails partway through.
state.epoch = 2n;
state.hookReverts = true;
const broke = await round();
ok(priced(broke), "a new epoch prices the basket again");

// **The property.** The previous round threw after pricing; the vault is still
// owed the rest of its round, so the next tick redoes it rather than waiting
// out the window.
state.hookReverts = false;
const retried = await round();
ok(
  priced(retried),
  "a round that threw leaves the vault fresh: the next tick redoes the epoch-gated half",
);
ok(watchedHook(retried), "...including the step that threw");

const settled = await round();
ok(!priced(settled), "and once a round completes, the epoch is finally marked seen");

// **An empty push set must not consume the delivery interval.** The stub's
// `roots()` answers all zeros, which is exactly what a root cut with nothing
// over the floor publishes: `pushRoot == 0`. Rewind the timer so the gate is
// open and the round reaches `stepDistribute` for the first time in this file.
//
// This is the bug that lost the ~$1 sweeps of epochs 58, 104, 155 and 304: the
// tick used to rebuild the tree, find no pair, send nothing, and mark itself
// pushed anyway -- closing a gate hours wide over a floor override one epoch
// wide. The file it writes IS the damage, so the file is what this asserts on.
const pushFile = join(dir, `last-push-${DIST.toLowerCase()}.json`);
writeFileSync(pushFile, JSON.stringify({ at: 0 }));
// The published artifact the tick serves from, at the epoch the stub's
// `roots()` answers with: one holder, nobody flagged for a push. That is a tree
// which builds, matches the chain's zero `pushRoot`, and has nothing to send --
// the production state of every root between two sweeps.
writeFileSync(
  join(dir, `previous-root-${DIST.toLowerCase()}.json`),
  JSON.stringify({
    upToEpoch: 0,
    windows: [],
    excluded: [],
    entries: [{ holder: `0x${"a2".repeat(20)}`, stock: `0x${"b3".repeat(20)}`, cumulative: "1", push: false }],
  }),
);
const empty = await round();
fixture(empty.includes("roots"), "fixture: the rewound timer really did reach stepDistribute");
ok(!empty.includes("owedTo"), "an empty pushRoot serves nobody, and does not rebuild a tree to find that out");
ok(
  JSON.parse(readFileSync(pushFile, "utf8")).at === 0,
  "...and it does NOT consume the interval: the next root may be the one carrying a swept set",
);

// **The platform share reaches the Treasury only because somebody calls for
// it.** `harvest` CREDITS `platformPool`; `payPlatform` is what moves it, it is
// permissionless, unrefunded, and for a while no keeper step called it at all —
// found on the TOLL vault on 2026-09-19, 0.0011058 ETH accrued against a
// Treasury that had never received a wei. Same shape as `stepDev`: over its own
// gas bar it pays, under it waits.
state.epoch += 1n;
state.platformPool = 10n ** 15n; // ~$3, far over 20 x 40 000 x the stub's 1 wei basefee
const owed = await round();
ok(owed.includes("payPlatform"), "a platform pocket worth its gas is paid to the Treasury");

state.epoch += 1n;
state.platformPool = 1n;
const dust = await round();
ok(!dust.includes("payPlatform"), "...and dust waits, rather than paying a fixed cost to move one wei");

// -------------------------------------------------------------------------
// **The Treasury's own functions, which nothing was calling either.**
//
// `stepTreasury` is a ROUND-LEVEL watch: it runs on `SLOW_MS`, so only the
// first round of a process reaches it and `slowAt` is module state with no
// setter. A fresh module instance is the whole trick — a distinct specifier
// gives a distinct module, hence a `slowAt` back at zero.
let instance = 0;
const freshRound = async () => {
  const { tick: t } = await import(`./keeper.js?slow=${++instance}`);
  reads = [];
  sends = [];
  await t();
  return reads;
};

// **A payment a vault could not hand over.** `FeeVault._pay` never reverts the
// harvest that was paying us: the amount falls into that vault's
// `pendingWithdrawal` under the Treasury's name, where `withdraw()` is callable
// by nobody else. Nothing retried it and nothing complained about it.
state.pendingWithdrawal = 10n ** 15n; // ~$3, far over 20 x 40 000 x the stub's 1 wei basefee
const stuck = await freshRound();
ok(stuck.includes("collectFrom"), "a payment a vault could not hand over is collected, not left to sit");

state.pendingWithdrawal = 1n;
const stuckDust = await freshRound();
ok(!stuckDust.includes("collectFrom"), "...and one wei of it is not worth a call nothing refunds");
state.pendingWithdrawal = 0n;

// **A retired platform vault kept being fed.** `fundPlatformRewards` pays
// whatever `platformVault` names; after a `migrate` that is the old vault, with
// its old basket and its old Distributor. `followMigration` takes no argument —
// the destination is the one the vault declares itself.
state.platformVault = VAULT;
state.vaultMigratedTo = SUCCESSOR;
const moved = await freshRound();
ok(moved.includes("followMigration"), "a migrated platform vault is followed, not left drawing the rewards pocket");

state.vaultMigratedTo = ZERO;
const stayed = await freshRound();
ok(!stayed.includes("followMigration"), "...and a vault that has not moved is not chased every round");

// **A migrated Treasury still receives.** `PLATFORM` is immutable on every
// vault — that is what promises a creator the platform will not re-point itself
// at their expense — so the shares keep arriving here after the migration.
// `pushAll` is the one function left alive to carry them across.
//
// Asserted on a QUOTE token rather than on ether: with batching on, viem folds
// a balance read into Multicall3's own `getEthBalance`, which `rpcstub` answers
// zero for every stub. The token is also the half that had no code at all.
state.treasuryMigratedTo = SUCCESSOR;
state.quote = QUOTE_TOKEN;
state.treasuryToken = 10n ** 15n;
const emptied = await freshRound();
ok(emptied.includes("pushAll"), "a migrated Treasury pushes on what keeps arriving to its successor");
ok(!emptied.includes("payDev"), "...and stops spending it: everything else on it reverts AlreadyMigrated");

// ---------------------------------------------------------------------------
// **A portfolio vault takes a DIFFERENT round, and nothing but `modeOf` says
// so.**
//
// The mode was wired into `tickVault` with no test reaching it: `planBatches`
// and `sliceFor` are covered by `portfolio.test.ts`, but the two steps that
// call them — `stepPayout` where `stepBuyBasket` stands, `stepConvert` where
// `stepDistribute` does — ran in production and nowhere else. This block is
// that gap.
//
// It asserts on the SHAPE of the round rather than on the transactions, for
// the reason the whole file does: `eth_estimateGas` fails here, so nothing is
// ever sent, and what a round READ is the honest record of which branch it
// took.
{
  state.mode = MODE_PORTFOLIO;
  // Open the delivery gate so the round reaches the convert step, and give it
  // an artifact whose tree matches the stub's all-zero `roots()`.
  writeFileSync(join(dir, `last-push-${DIST.toLowerCase()}.json`), JSON.stringify({ at: 0 }));

  const r = await freshRound();

  // The purchase half: `payout()` replaces `buyBasket`, so nothing prices a
  // basket. `payoutBps` and `getAllocations` are `stepBuyBasket`'s and no
  // other step's — their ABSENCE is what says the swap was taken.
  ok(!r.includes("getAllocations"), "a portfolio round never prices a basket: there is none to buy");
  ok(r.includes("nextEpoch"), "...it asks whether a window is waiting, which is `stepPayout`'s first read");

  // The delivery half: `stepConvert` stands where `stepDistribute` does, and
  // enters the SAME shared preamble. `owedTo` is `stepDistribute`'s own read
  // and no other step's, so its absence says the distribution push was not the
  // branch taken.
  ok(r.includes("roots"), "a portfolio round enters the shared delivery preamble");
  ok(!r.includes("owedTo"), "...but never the distribution push: that is `stepConvert`'s slot now");

  // **Now through the guard, and into the body.** Every earlier block in this
  // file runs against an all-zero `roots()` — a root with nothing over the
  // floor — so `deliveryPlan` returns early and nothing downstream of it has
  // ever run here. Give the stub a real `pushRoot`, and the artifact that
  // rebuilds to exactly it, and the round goes the whole way.
  //
  // The root is computed with the SAME `build()` the keeper uses, so this
  // fixture cannot drift from what `fromPublished` produces: if the tree
  // changes shape, both sides change together and the guard still matches.
  const publishFor = (rows: { holder: Address; stock: Address; cumulative: bigint }[]) => {
    const tree = build(rows, new Set(rows.map((r) => key(r.holder, r.stock))));
    writeFileSync(
      join(dir, `previous-root-${DIST.toLowerCase()}.json`),
      JSON.stringify({
        upToEpoch: 0,
        windows: [],
        excluded: [],
        entries: rows.map((r) => ({ ...r, cumulative: r.cumulative.toString(), push: true })),
      }),
    );
    state.pushRoot = tree.pushRoot;
    state.rootEpoch = 0n;
    writeFileSync(join(dir, `last-push-${DIST.toLowerCase()}.json`), JSON.stringify({ at: 0 }));
  };
  /** The conversions a round attempted, as (stock, holders). */
  const converts = () =>
    sends.filter((x) => x.name === "distributeInto")
      .map((x) => ({ stock: String(x.args[0]).toLowerCase(), holders: (x.args[1] as Address[]).length }));

  state.pivot = PIVOT;
  // Six decimals, like USDG: the per-line floor is $1.50, i.e. 1_500_000 here.
  state.pivotDecimals = 6;

  publishFor([{ holder: HOLDER, stock: PIVOT, cumulative: 2_000_000n }]);
  state.lines = { [HOLDER.toLowerCase()]: [{ stock: NVDA_ISH, bps: 10_000 }] };

  const full = await freshRound();
  fixture(full.includes("roots"), "fixture: the portfolio round reached the delivery preamble");
  ok(full.includes("book"), "a portfolio round reads the launch's book");
  ok(full.includes("PIVOT"), "...and the pivot its holders are owed in");
  ok(full.includes("linesOf"), "...and what the holder over the floor asked to be paid in");
  ok(full.includes("convertedInto"), "...and how much of their share is already converted");
  ok(full.includes("decimals"), "...and the pivot's scale, which the per-line floor is denominated in");
  ok(
    full.includes("distributeInto"),
    "...and it SENDS: one swap for the batch, which is the whole economic claim of this mode",
  );
  ok(!full.includes("distribute"), "and never the plain transfer: a portfolio holder is owed pivot, not stock");
  assert.deepEqual(
    converts(),
    [{ stock: NVDA_ISH.toLowerCase(), holders: 1 }],
    "one conversion, into the stock the holder asked for",
  );
  checks++;

  // **The per-line floor gates, and it is the reason this block reads
  // `decimals()`.** $1.00 of pivot against a $1.50 floor: the holder is in the
  // push tree — the tree admits at ~$1, deliberately below the floor so the
  // planner is the gate — and the planner declines to spend a swap on them.
  // Nothing is lost: the target is cumulative, so it converts once it grows.
  //
  // This case passed before the floor existed AND would pass today against a
  // stub answering `decimals()` with its default zero, which puts the floor at
  // one unit and lets everything through. That is what it is here to catch.
  publishFor([{ holder: HOLDER, stock: PIVOT, cumulative: 1_000_000n }]);
  const thin = await freshRound();
  ok(thin.includes("linesOf"), "a holder under the per-line floor is still looked at");
  assert.deepEqual(converts(), [], "...and converted for nothing: $1.00 does not pay for its own swap");
  checks++;

  // **Two holders who want the same stock share ONE swap.** The claim the
  // whole mode is built on, and the only thing that says so is the argument
  // list.
  publishFor([
    { holder: HOLDER, stock: PIVOT, cumulative: 2_000_000n },
    { holder: HOLDER2, stock: PIVOT, cumulative: 3_000_000n },
  ]);
  state.lines = {
    [HOLDER.toLowerCase()]: [{ stock: NVDA_ISH, bps: 10_000 }],
    [HOLDER2.toLowerCase()]: [{ stock: NVDA_ISH, bps: 10_000 }],
  };
  await freshRound();
  assert.deepEqual(
    converts(),
    [{ stock: NVDA_ISH.toLowerCase(), holders: 2 }],
    "two holders wanting the same stock are one swap, not two",
  );
  checks++;

  // ...and two who want different stocks are one swap each, because a swap
  // buys one thing.
  //
  // `publishFor` again and not just new rows: `stepConvert` marks the push
  // interval on its way out, so a second round against the same file finds it
  // too soon and does nothing. Re-publishing reopens it, which is also what
  // the keeper sees in production once the interval has elapsed.
  publishFor([
    { holder: HOLDER, stock: PIVOT, cumulative: 2_000_000n },
    { holder: HOLDER2, stock: PIVOT, cumulative: 3_000_000n },
  ]);
  state.lines = {
    [HOLDER.toLowerCase()]: [{ stock: NVDA_ISH, bps: 10_000 }],
    [HOLDER2.toLowerCase()]: [{ stock: QQQ_ISH, bps: 10_000 }],
  };
  await freshRound();
  assert.deepEqual(
    converts().sort((a, b) => (a.stock < b.stock ? -1 : 1)),
    [{ stock: NVDA_ISH.toLowerCase(), holders: 1 }, { stock: QQQ_ISH.toLowerCase(), holders: 1 }],
    "two stocks are two swaps, one holder each",
  );
  checks++;

  // **A stock the registry has delisted is dropped, not planned.**
  // `distributeInto` refuses it, so planning it anyway produced a call that
  // failed its gas estimate every interval — no transaction, no gas, and a
  // holder whose line silently stopped converting. Delisting stops the
  // conversion; it does not reach backwards, and the pivot entitlement stays
  // claimable in full.
  // $4.00 split in two, so each half is $2.00 and clears the $1.50 per-line
  // floor on its own: what removes a line here is the delisting and nothing
  // else. At $2.00 split in two the floor would drop both, and this test would
  // pass for the wrong reason.
  publishFor([{ holder: HOLDER, stock: PIVOT, cumulative: 4_000_000n }]);
  state.lines = {
    [HOLDER.toLowerCase()]: [{ stock: NVDA_ISH, bps: 5_000 }, { stock: QQQ_ISH, bps: 5_000 }],
  };
  state.delisted = new Set([QQQ_ISH.toLowerCase()]);
  await freshRound();
  assert.deepEqual(
    converts(),
    [{ stock: NVDA_ISH.toLowerCase(), holders: 1 }],
    "the delisted half is dropped and the other half is still served",
  );
  checks++;

  publishFor([{ holder: HOLDER, stock: PIVOT, cumulative: 4_000_000n }]);
  state.delisted = new Set([NVDA_ISH.toLowerCase(), QQQ_ISH.toLowerCase()]);
  await freshRound();
  assert.deepEqual(converts(), [], "with every named stock delisted, nothing is planned at all");
  checks++;
  state.delisted = new Set<string>();

  // **What the step refuses to touch.** An entry naming anything but the pivot
  // is a tree this keeper does not understand — the vault funds one line and
  // only one — and a holder with no row and no default keeps their pivot. Both
  // are skips rather than errors, and both leave the round serving the one
  // entry it does understand.
  publishFor([
    { holder: HOLDER, stock: PIVOT, cumulative: 2_000_000n },
    { holder: HOLDER, stock: NVDA_ISH, cumulative: 9_000_000n },
    { holder: HOLDER2, stock: PIVOT, cumulative: 9_000_000n },
  ]);
  state.lines = { [HOLDER.toLowerCase()]: [{ stock: NVDA_ISH, bps: 10_000 }] };
  await freshRound();
  assert.deepEqual(
    converts(),
    [{ stock: NVDA_ISH.toLowerCase(), holders: 1 }],
    "a non-pivot leaf and a holder with no row are both skipped, and the round still serves the rest",
  );
  checks++;

  // Put the stub back so the closing assertions run against the same state
  // every earlier block established.
  state.pushRoot = (`0x${"0".repeat(64)}`) as Hex;
  state.pivot = ZERO;
  state.lines = {};

  // And the mode is the ONLY thing that changed: put it back and the round is
  // the distribution one again, basket and all.
  state.mode = MODE_DISTRIBUTION;
  const back = await freshRound();
  ok(back.includes("getAllocations"), "back on the default mode, the basket is priced again");
  ok(!back.includes("book"), "...and nothing looks for a book that does not exist");
}


// ---------------------------------------------------------------------------
// What a skipped round SAYS.
//
// Most harvest ticks revert `NothingToDo()` and that is the healthy case, so
// the line is only useful if it names the selector. viem puts the selector on
// the line AFTER the header, and logging line 0 alone printed every failure —
// benign or not — as the same colon-terminated sentence. Measured on
// payd-protocol-keeper 2026-09-27: the reason had to be re-derived with `cast`.

// `announce.js` reaches `config.js`, which reads the environment ONCE at
// import — so it is loaded HERE, after the stub's URL is in place, the same
// way `rpcbudget.test.ts` loads `keeper.js`.
const { reason } = await import("./announce.js");

const viemRevert = new Error(
  [
    'The contract function "harvest" reverted with the following signature:',
    "0x5c52a868",
    "",
    "Unable to decode signature \"0x5c52a868\"",
    "Contract Call:",
    "  address: 0x4DBA57f2E1b9AFE02cA091916F98dd7B4A248A64",
  ].join("\n"),
);
ok(reason(viemRevert).includes("0x5c52a868"), "a revert log names the selector, not just the header");
ok(reason(new Error("nonce too low\nat sendRawTransaction")) === "nonce too low", "a one-line error is unchanged");
ok(reason(new Error("")) === "", "an empty message is empty, not a crash");
ok(reason(new Error("header:")) === "header:", "a header with nothing after it does not invent a second line");
ok(reason(new Error(`x:\n${"y".repeat(400)}`)).length === 160, "the line stays bounded");

server.closeAllConnections();
server.close();
if (failed.length) {
  for (const f of failed) console.error(`cadence: RED - ${f}`);
  throw new assert.AssertionError({
    message: `${failed.length} of ${checks} assertions RED`,
    actual: failed.length,
    expected: 0,
  });
}
console.log(`cadence: ${checks} checks OK`);
