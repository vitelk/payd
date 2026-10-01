/**
 * The prepare tools of `docs/MCP.md`: UNSIGNED transactions, simulated from the
 * account that must send them, handed back for the agent's own wallet to sign.
 *
 * This server holds no key and never will: `Payd._create` makes `msg.sender`
 * both CREATOR and LAUNCHER, and `FeeVault.bind` requires Pons's recorded
 * deployer to be that LAUNCHER. Whoever signs owns the launch — so it has to be
 * the agent, never us.
 *
 * Every builder simulates before returning, and returns an error instead of
 * calldata when the simulation reverts: Pons does not refund a launch fee.
 */
import {
  encodeFunctionData, parseAbi, BaseError, ContractFunctionRevertedError,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { createPayd } from "../../sdk/src/payd.js";
import { buildLaunch, type LaunchInput } from "../../front/src/launchcall.js";
import { validate, type Draft } from "../../front/src/basket.js";
import { acceptsValue } from "../../front/src/atomic.js";
import { REGISTRY, PONS_FACTORY, requireAddress } from "./tools.js";
import errors from "./errors.json" with { type: "json" };

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ERRORS = errors as Abi;

const registryAbi = parseAbi([
  "function createVault((address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken) returns (address vault, address distributor)",
  "function createVaultQuoted((address stock, uint24 poolFee, uint16 bps, address feed)[] basket, uint256 rewardsBps, uint256 epochLength, address intendedToken, address quote) returns (address vault, address distributor)",
  "function listing(address stock) view returns (uint24 poolFee, address feed, bool allowed)",
  "function quoteListing(address quote) view returns (uint24 poolFee, uint24 wethFee, uint256 minBuy, bool allowed)",
  "function platformBps() view returns (uint256)",
  "function isVault(address vault) view returns (bool)",
]);
const vaultAbi = parseAbi([
  "function bind(address token)",
  "function LAUNCHER() view returns (address)",
  "function token() view returns (address)",
  "function QUOTE() view returns (address)",
]);
const claimAbi = parseAbi([
  "function claim(address[] stocks, uint256[] cumulative, bytes32[][] proofs) returns (uint256 delivered)",
]);

export interface PreparedTx {
  chainId: number;
  /** The account this MUST be sent from. */
  from: Address;
  to: Address;
  data: Hex;
  /** Wei, as a decimal string. */
  value: string;
  simulation: { ok: true; result: unknown };
  next?: string;
  notes?: string[];
}

interface Call {
  from: Address;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/** Simulates from `from`, then encodes. A revert throws, named when we know it. */
async function prepare(c: PublicClient, call: Call): Promise<Omit<PreparedTx, "next" | "notes">> {
  const abi = [...call.abi, ...ERRORS] as Abi;
  let result: unknown;
  try {
    ({ result } = await c.simulateContract({
      account: call.from, address: call.to, abi, functionName: call.functionName,
      args: call.args, value: call.value,
    } as never));
  } catch (e) {
    const revert = e instanceof BaseError
      ? e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
      : null;
    const name = revert?.data?.errorName;
    throw new Error(name
      ? `simulation reverted: ${name}(${(revert!.data!.args ?? []).map(String).join(", ")}) — nothing to sign`
      : `simulation failed: ${(e as BaseError).shortMessage ?? (e as Error).message} — nothing to sign`);
  }
  return {
    chainId: c.chain!.id,
    from: call.from,
    to: call.to,
    data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never),
    value: (call.value ?? 0n).toString(),
    simulation: { ok: true, result },
  };
}

/** The node as `acceptsValue` wants it: an EIP-1193 `request`. */
const eip1193 = (c: PublicClient) => ({ request: (a: { method: string; params?: unknown[] }) => c.request(a as never) });

export interface CreateVaultInput {
  from: string;
  basket: { stock: string; bps: number }[];
  rewardsBps: number;
  epochMinutes: number;
  quote?: string;
}

export async function prepareCreateVault(c: PublicClient, i: CreateVaultInput): Promise<PreparedTx> {
  const from = requireAddress("from", i.from);
  const quote = i.quote ? requireAddress("quote", i.quote) : ZERO;
  const platformBps = Number(await c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "platformBps" }));

  // The app's own rules, so the agent reads the same sentence a creator would.
  const picks = new Map<string, Draft>(i.basket.map((l) => [requireAddress("basket stock", l.stock).toLowerCase(), { on: true, bps: l.bps }]));
  if (picks.size !== i.basket.length) throw new Error("the basket lists a stock twice");
  const invalid = validate(picks, i.rewardsBps, i.epochMinutes, platformBps);
  if (invalid) throw new Error(invalid);

  // A basket line must carry the tier and feed the registry listed it at.
  const basket = await Promise.all(i.basket.map(async (l) => {
    const stock = l.stock as Address;
    const [poolFee, feed, allowed] = await c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "listing", args: [stock] });
    if (!allowed) throw new Error(`${stock} is not a listed stock — see payd_launch_options`);
    return { stock, poolFee, bps: l.bps, feed };
  }));
  if (quote !== ZERO) {
    const [, , , allowed] = await c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "quoteListing", args: [quote] });
    if (!allowed) throw new Error(`${quote} is not an allowed quote currency — see payd_launch_options`);
  }

  // CREATOR is fixed at birth and is paid by plain transfers. A wallet that
  // refuses ETH would strand the creator share for the life of the launch.
  if ((await acceptsValue(eip1193(c), from)) === "no") {
    throw new Error(`${from} refuses plain ETH transfers (a contract or delegated account), so its creator `
      + "share could never be paid out — and the creator of a launch cannot be changed. Use another wallet.");
  }

  const common = [basket, BigInt(i.rewardsBps), BigInt(i.epochMinutes * 60), ZERO] as const;
  const tx = await prepare(c, quote === ZERO
    ? { from, to: REGISTRY, abi: registryAbi, functionName: "createVault", args: common }
    : { from, to: REGISTRY, abi: registryAbi, functionName: "createVaultQuoted", args: [...common, quote] });
  return {
    ...tx,
    notes: ["simulation.result is [vault, distributor] as of now; another launch landing first shifts both, so read the real vault after this lands."],
    next: `After this lands, call payd_list_tokens with creator=${from} — the newest vault is yours — then payd_prepare_launch with that vault and from=${from}.`,
  };
}

export interface LaunchToolInput {
  from: string;
  vault: string;
  name: string;
  symbol: string;
  creatorTaxBps: number;
  logo?: string;
  description?: string;
  website?: string;
  x?: string;
  telegram?: string;
  /** The creator's own first buy, wei, ETH-quoted launches only. */
  buyAmountWei?: string;
}

export async function prepareLaunch(c: PublicClient, i: LaunchToolInput): Promise<PreparedTx & { predictedToken: Address }> {
  const from = requireAddress("from", i.from);
  const vault = requireAddress("vault", i.vault);
  const read = <T>(functionName: "LAUNCHER" | "token" | "QUOTE") =>
    c.readContract({ address: vault, abi: vaultAbi, functionName }) as Promise<T>;

  if (!(await c.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isVault", args: [vault] }))) {
    throw new Error(`${vault} is not a vault the Payd registry built`);
  }
  const [launcher, bound, quote] = await Promise.all([read<Address>("LAUNCHER"), read<Address>("token"), read<Address>("QUOTE")]);
  // `bind` compares Pons's recorded deployer to LAUNCHER, and Pons records the
  // sender. Signed from anyone else, the launch binds to nothing and the fee is
  // not refunded.
  if (launcher.toLowerCase() !== from.toLowerCase()) {
    throw new Error(`this vault must be launched from its LAUNCHER, ${launcher} — not ${from}`);
  }
  if (bound !== ZERO) throw new Error(`this vault is already bound to ${bound}`);

  const notes: string[] = [];
  const input: LaunchInput = {
    name: i.name, symbol: i.symbol, logo: i.logo ?? "", description: i.description ?? "",
    website: i.website ?? "", x: i.x ?? "", telegram: i.telegram ?? "",
    creatorTaxBps: i.creatorTaxBps,
    buyAmount: BigInt(i.buyAmountWei ?? "0"),
  };
  // Recipient and currency are the VAULT's, never an input: those are the two
  // fields that, wrong, send the fees somewhere nobody can take them.
  const call = await buildLaunch(c, PONS_FACTORY, from, input, quote, vault, (m) => notes.push(m));
  const tx = await prepare(c, {
    from, to: call.target, abi: call.abi as Abi, functionName: call.functionName, args: call.args, value: call.value,
  });
  // Pons derives the token from (sender, salt, params): this calldata, sent
  // from `from`, produces exactly this address.
  const predictedToken = (tx.simulation.result as readonly Address[])[0]!;
  return {
    ...tx,
    predictedToken,
    notes: [...notes, "Send THIS calldata unchanged: it carries a fresh salt, and the predicted token address depends on it."],
    next: `After this lands, call payd_prepare_bind with vault=${vault} and token=${predictedToken}.`,
  };
}

export async function prepareBind(c: PublicClient, i: { vault: string; token: string; from?: string }): Promise<PreparedTx> {
  const vault = requireAddress("vault", i.vault);
  const token = requireAddress("token", i.token);
  // Anyone may send it; simulate from the launcher unless told otherwise.
  const from = i.from ? requireAddress("from", i.from)
    : await c.readContract({ address: vault, abi: vaultAbi, functionName: "LAUNCHER" });
  return {
    ...(await prepare(c, { from, to: vault, abi: vaultAbi, functionName: "bind", args: [token] })),
    next: `Once this lands the launch is live: payd_token_info with vault=${vault} should show hookStatus "collecting".`,
  };
}

export async function prepareClaim(c: PublicClient, i: { vault: string; holder: string }): Promise<PreparedTx | { nothingOwed: true; note: string }> {
  const holder = requireAddress("holder", i.holder);
  const a = await createPayd({ vault: requireAddress("vault", i.vault), client: c }).claimArgs(holder);
  if (!a) {
    return { nothingOwed: true, note: "Nothing is owed to this address in the current root. Shares also arrive by airdrop; claiming is only a shortcut." };
  }
  return {
    ...(await prepare(c, { from: holder, to: a.distributor, abi: claimAbi, functionName: "claim", args: [a.stocks, a.cumulative, a.proofs] })),
    notes: ["Proofs are valid for the CURRENT root only; a new one is published every epoch. Sign and send now, or prepare again."],
  };
}
