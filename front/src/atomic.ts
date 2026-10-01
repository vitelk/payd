/**
 * THE ONE-TRANSACTION LAUNCH, and the two addresses it has to know in advance.
 *
 * Robinhood Chain accepts EIP-7702 (measured 2026-09-27 on chain 4663, ArbOS
 * 116: a type-4 envelope with an authorization list is rejected for
 * `insufficient funds`, not for an unsupported type). So the creator's own
 * wallet can execute `createVault` -> `launchToken` -> `bind` in ONE
 * transaction, with `msg.sender` staying the creator throughout — which keeps
 * Pons's `deployer`, `FeeVault.LAUNCHER` and `FeeVault.CREATOR` on the
 * creator's wallet and puts none of our code between them and their fees.
 *
 * The price is that a batch carries STATIC calldata: the vault's address goes
 * into Pons's `creatorFeeRecipient`, and the token's into `bind`, so both must
 * be computed before anything is signed. `test/OneTx.t.sol` measured that both
 * can be:
 *
 *   - the TOKEN is a pure function of (sender, salt, params) — two strangers
 *     launching in between do not move it, and reusing a salt reverts, so no
 *     counter is involved. Read it by simulating the launch;
 *   - the VAULT is `CREATE(CREATE(modeFactory, its nonce), 2)`, because the
 *     factory `new`s a `Bootstrap` and `Bootstrap` clones the Distributor at
 *     nonce 1 and the vault at nonce 2. All three are CREATE, so the address
 *     depends on deployer and nonce alone and never on the arguments.
 *
 * **The vault's nonce is the whole risk, and atomicity is the whole answer.**
 * Another launch through the same factory between the read and the transaction
 * shifts that nonce. In an ATOMIC batch the mismatch makes `bind` revert and
 * the launch fee is never paid — a retry, nothing more. In a NON-ATOMIC one,
 * `launchToken` could land while `bind` fails, and the creator fees would be
 * pointed for ever at a vault that is not theirs, with Pons imposing three days
 * and the current recipient's consent to move them. So this module refuses to
 * batch unless the wallet guarantees atomicity, and the form falls back to the
 * three signatures it has always sent.
 */
import { getContractAddress, type Address, type Hex } from "viem";

/** Chain 4663, as `wallet_getCapabilities` keys it. */
export const CHAIN_KEY = "0x1237";

/**
 * Where `DistributionFactory.create` will put the pair, read from one public
 * number.
 *
 * @param modeFactory the mode's factory — `Payd.factory()` for the default one,
 *        or whichever `createVaultWith` will name.
 * @param nonce the factory's CURRENT nonce (`eth_getTransactionCount`).
 */
export function predictPair(modeFactory: Address, nonce: bigint): { vault: Address; distributor: Address } {
  const bootstrap = getContractAddress({ from: modeFactory, nonce });
  return {
    // Bootstrap's constructor clones the Distributor first, at nonce 1, then
    // the vault at nonce 2. Reversing these two silently produces a pair of
    // addresses that both exist and are both wrong.
    distributor: getContractAddress({ from: bootstrap, nonce: 1n }),
    vault: getContractAddress({ from: bootstrap, nonce: 2n }),
  };
}

/** What a wallet answered about atomic batching, reduced to the one bit that
 *  decides whether we may batch at all. */
export type Atomic = "supported" | "ready" | "unsupported";

/**
 * Whether this wallet will run a batch atomically on THIS chain.
 *
 * Two shapes are accepted because two are deployed: the current
 * `atomic: { status }` and the earlier draft's `atomicBatch: { supported }`.
 * Anything else — an error, a missing chain, a shape we do not know — reads as
 * `unsupported`, which sends the form back to three signatures. A wallet that
 * cannot tell us is not a wallet we bet a launch fee on.
 */
export function readAtomic(caps: unknown, chainKey: string = CHAIN_KEY): Atomic {
  if (!caps || typeof caps !== "object") return "unsupported";
  // Wallets are inconsistent about the case of the hex key, and `0x1237` vs
  // `0x1237` with a capital is the same chain.
  const rows = caps as Record<string, unknown>;
  const key = Object.keys(rows).find((k) => k.toLowerCase() === chainKey.toLowerCase());
  const row = key === undefined ? undefined : rows[key];
  if (!row || typeof row !== "object") return "unsupported";
  const r = row as { atomic?: { status?: unknown }; atomicBatch?: { supported?: unknown } };
  const status = r.atomic?.status;
  if (status === "supported" || status === "ready") return status;
  if (r.atomicBatch?.supported === true) return "supported";
  return "unsupported";
}

/** True when a batch may be sent. `ready` means the wallet will upgrade the
 *  account first and still run it atomically, which is enough. */
export const canBatch = (a: Atomic): boolean => a !== "unsupported";

export interface Eth1193 {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/** Asks the wallet, and treats a rejection as a no. An old wallet answers
 *  `method not found`, which is an answer. */
export async function atomicOf(eth: Eth1193, account: Address, chainKey = CHAIN_KEY): Promise<Atomic> {
  try {
    const caps = await eth.request({ method: "wallet_getCapabilities", params: [account, [chainKey]] });
    return readAtomic(caps, chainKey);
  } catch {
    return "unsupported";
  }
}

/** One call of a batch, as `wallet_sendCalls` takes it. */
export interface Call {
  to: Address;
  data: Hex;
  value?: Hex;
}

/**
 * Sends the batch, atomic or not at all.
 *
 * `atomicRequired: true` is the guarantee this whole module rests on: without
 * it a wallet is free to run the three calls as three transactions and stop in
 * the middle, which is the one outcome that costs the creator their fee stream.
 */
export async function sendAtomic(
  eth: Eth1193,
  account: Address,
  calls: Call[],
  chainKey = CHAIN_KEY,
): Promise<string> {
  const id = await eth.request({
    method: "wallet_sendCalls",
    params: [{ version: "2.0.0", chainId: chainKey, from: account, atomicRequired: true, calls }],
  });
  // EIP-5792 2.0.0 returns `{ id }`; the 1.0 draft returned the id bare.
  if (typeof id === "string") return id;
  const o = id as { id?: unknown };
  if (typeof o?.id === "string") return o.id;
  throw new Error("the wallet accepted the batch but returned no id");
}

/**
 * **Whether a plain value transfer to this wallet succeeds** — and this one has
 * nothing to do with batching.
 *
 * EIP-7702 gives a wallet CODE, durably, until the owner revokes it. From then
 * on every plain transfer runs the delegate. `FeeVault.CREATOR` is immutable and
 * `_pay` sends the creator's residue with `gas: 30_000`; `withdraw()` sends it
 * with all the gas there is, but it is a plain transfer too. So a delegate that
 * refuses value strands the creator's whole share, unrecoverably, with no second
 * address to redirect it to — measured in
 * `test/OneTxLaunch.t.sol:test_ADelegateThatRefusesValueStrandsTheResidue`.
 *
 * Real wallets accept value; they have to, or their users would stop being able
 * to receive ETH. But it is the wallet's choice and not ours, and the cost of
 * being wrong falls entirely on the creator. So this runs before `createVault`
 * on EVERY path — the three signatures have exactly the same exposure, since it
 * is the wallet and not the batch that carries it.
 *
 * The probe is a self-transfer under `eth_call`: no state override, so any node
 * answers it, and no gas is charged, so it costs nothing. An account with no
 * code is payable by definition and is not probed.
 *
 * **And that last sentence is why one call is not enough.** MetaMask answers
 * `atomic: {status: "ready"}` on this chain (measured 2026-09-27), which means it
 * upgrades the account to a 7702 smart account WHEN THE BATCH IS SENT. Before
 * that the account has no code, so this returns `yes` about a delegate that does
 * not exist yet — a true answer to the wrong question. Hence the SECOND call,
 * after the batch, where `code` is `0xef0100…` and the answer is about the
 * implementation that will actually receive the residue.
 *
 * What a `no` costs then is bounded, and worth stating precisely: the residue
 * waits in `pendingWithdrawal` and cannot be sent while the delegation stands —
 * but a 7702 EOA can always revoke its own delegation, after which the account
 * has no code and `withdraw()` goes through. It is stuck, not lost. A genuine
 * contract account (4337, Safe) has no such way out, which is the case to warn
 * hardest about.
 */
export type Payable = "yes" | "no" | "unknown";

export async function acceptsValue(node: Eth1193, account: Address): Promise<Payable> {
  let code: unknown;
  try {
    code = await node.request({ method: "eth_getCode", params: [account, "latest"] });
  } catch {
    return "unknown";
  }
  if (typeof code !== "string" || code === "0x" || code === "") return "yes";
  try {
    await node.request({ method: "eth_call", params: [{ from: account, to: account, value: "0x1" }, "latest"] });
    return "yes";
  } catch (e) {
    // A revert is the answer. Anything else — a node that will not simulate a
    // value transfer, a transport failure — is not, and must not be reported as
    // one: refusing a launch on a node's mood is its own kind of wrong.
    const m = String((e as { message?: unknown })?.message ?? e).toLowerCase();
    if (m.includes("revert") || m.includes("execution reverted")) return "no";
    if (m.includes("insufficient funds")) return "unknown";
    return "unknown";
  }
}

/**
 * The three calls, in the only order that works, with the launch fee on the one
 * call that spends it.
 *
 * Pure on purpose: the ORDER is the thing that can silently be wrong. `bind`
 * last because it needs the token the second call creates; the launch second
 * because its `creatorFeeRecipient` names the vault the first call builds. Put
 * `bind` before the launch and it reverts `NotOurLaunch` — which, in a
 * non-atomic batch, would be a launch pointed at a vault that never learns it
 * exists.
 */
export function oneShotCalls(a: {
  registry: Address;
  createData: Hex;
  pons: Address;
  launchData: Hex;
  launchValue: bigint;
  vault: Address;
  bindData: Hex;
}): Call[] {
  return [
    { to: a.registry, data: a.createData },
    { to: a.pons, data: a.launchData, value: `0x${a.launchValue.toString(16)}` as Hex },
    { to: a.vault, data: a.bindData },
  ];
}

/** What `wallet_getCallsStatus` reports, reduced to the outcomes that differ. */
export type BatchOutcome = "pending" | "confirmed" | "failed";

/** EIP-5792 status codes: 100 pending, 200 confirmed, 4xx never sent, 5xx and
 *  6xx reverted. Anything unknown counts as pending rather than success — a
 *  batch we cannot read is not a batch we tell the creator went through. */
export function readStatus(status: unknown): BatchOutcome {
  const n = Number(status);
  if (!Number.isFinite(n)) return "pending";
  if (n === 200) return "confirmed";
  if (n >= 400) return "failed";
  return "pending";
}

/**
 * Waits for the batch, and returns the transaction hash it landed in.
 *
 * An atomic batch is ONE transaction, so there is exactly one receipt to report
 * and one link to give the creator. A `failed` outcome means nothing happened —
 * that is what `atomicRequired` bought — so the caller may simply offer to try
 * again.
 */
export async function waitForBatch(
  eth: Eth1193,
  id: string,
  say: (m: string) => void,
  tries = 120,
): Promise<{ outcome: BatchOutcome; hash?: Hex }> {
  for (let i = 0; i < tries; i++) {
    const r = (await eth.request({ method: "wallet_getCallsStatus", params: [id] })) as {
      status?: unknown;
      receipts?: Array<{ transactionHash?: Hex }>;
    };
    const outcome = readStatus(r?.status);
    if (outcome !== "pending") return { outcome, hash: r?.receipts?.[0]?.transactionHash };
    if (i === 0) say("the batch is in — waiting for the block…");
    await new Promise((f) => setTimeout(f, 1000));
  }
  return { outcome: "pending" };
}
