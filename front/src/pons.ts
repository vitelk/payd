/**
 * The two transactions the creator used to have to send themselves: the launch
 * on Pons, then the `bind`.
 *
 * **Why the front end builds them.** Step 2 used to be signed on Pons's own
 * interface, and three of its fields are not preferences: they are conditions
 * `FeeVault.bind` checks and which, filled in wrongly, produce a permanently
 * unusable launch.
 *
 *   - `creatorFeeRecipient` must be THE vault. Any other value and the fees go
 *     elsewhere forever -- Pons imposes a 3-day delay to change recipient, and
 *     only the current recipient can do it.
 *   - `pairToken` must be THE VAULT'S CURRENCY, read from it (`QUOTE()`). The
 *     Pons escrow keeps one ledger PER CURRENCY: a launch quoted elsewhere
 *     credits a ledger that vault never reads, and the fees pile up where nobody
 *     can take them. v1 locked on native ETH, which condemned the 59 % of Pons
 *     volume quoted in USDG or in stock tokens (measured 2026-09-08).
 *   - `expectedEconomics` is a computed commitment, not something typed in.
 *
 * None of the three is exposed. The form asks only for what genuinely belongs to
 * the creator: the name, the ticker, their tax, their links.
 *
 * **This is not a router contract, and it never became one.** A router would be
 * recorded as the deployer itself (`test/Deployer.t.sol`) and, worse, as the
 * vault's `CREATOR`, since `Payd._create` passes the same `msg.sender` to both —
 * so the creator would lose their residue and `setRewardsBps` for good.
 *
 * The three calls became ONE TRANSACTION without any of that: the creator's own
 * wallet executes them, under EIP-7702, and stays `msg.sender` throughout.
 * `buildLaunch` below is shared by the two paths so that the three locked fields
 * are constructed once; `front/src/atomic.ts` holds the batch, and
 * `test/OneTxLaunch.t.sol` proves it end to end on the live chain.
 */
import { createWalletClient, custom, parseAbi, type Address, type Hex } from "viem";
import { pub, chain, provider, ensureChain } from "./chain.js";
import { EXPLORER } from "./config.js";
import { tokenFromReceipt } from "./launchlog.js";
import {
  factoryAbi, forwarderAbi, buildLaunch as buildLaunchWith, type LaunchInput, type LaunchCall,
} from "./launchcall.js";

export { factoryAbi, forwarderAbi, type LaunchInput, type LaunchCall };


export const ponsRegistryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

export const vaultBindAbi = parseAbi([
  "function bind(address token)",
  "function LAUNCHER() view returns (address)",
  "function token() view returns (address)",
  "function QUOTE() view returns (address)",
  // Read once, at creation, to build the link to the vault's page: `?vault=`
  // alone leaves the app on $PAYD's own distributor.
  "function DISTRIBUTOR() view returns (address)",
]);

/** `launchcall.ts`'s builder with the app's client bound — same signature as
 *  before the move, so neither caller changed. */
export const buildLaunch = (
  factory: Address, account: Address, input: LaunchInput, quote: Address, feeRecipient: Address,
  say: (m: string) => void,
): Promise<LaunchCall> => buildLaunchWith(pub, factory, account, input, quote, feeRecipient, say);

/**
 * The token address this launch WILL produce, without launching.
 *
 * Measured on 2026-09-27 (`test/OneTx.t.sol`): Pons derives it from the sender,
 * the salt and the params, a reused salt reverts rather than moving on, and
 * other launches landing in between do not shift it. So a simulation from the
 * same account with the same arguments returns the address the real transaction
 * will produce — which is what lets `bind` go into a batch signed beforehand.
 *
 * It MUST be simulated from the creator's own account: the sender is in the
 * derivation, and a simulation from anywhere else returns a plausible address
 * that belongs to nobody.
 */
export async function previewToken(call: LaunchCall, account: Address): Promise<Address> {
  const { result } = await pub.simulateContract({
    address: call.target,
    abi: call.abi as never,
    functionName: call.functionName as never,
    args: call.args as never,
    value: call.value,
    account,
  });
  return (result as readonly Address[])[0]!;
}

/**
 * Step 2. Returns the token's address, or throws.
 */
export async function launchOnPons(
  factory: Address,
  vault: Address,
  account: Address,
  input: LaunchInput,
  say: (m: string) => void,
): Promise<Address> {
  // The launcher MUST be whoever created the vault: `bind` compares the
  // `deployer` Pons recorded to `LAUNCHER`, and Pons records `msg.sender`.
  // Signing from another address produces a launch that binds to nothing -- and
  // Pons does not refund the launch fee.
  const launcher = (await pub.readContract({
    address: vault, abi: vaultBindAbi, functionName: "LAUNCHER",
  })) as Address;
  if (launcher.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`this payout must be launched from ${launcher} — the wallet is on ${account}`);
  }

  // The launch's currency is READ FROM THE VAULT, never typed in here. The
  // vault has exactly one, written at its birth, and `bind` refuses everything
  // else -- so asking the creator to retype it would be asking them to copy
  // something the chain already knows.
  const quote = (await pub.readContract({
    address: vault, abi: vaultBindAbi, functionName: "QUOTE",
  })) as Address;

  const call = await buildLaunch(factory, account, input, quote, vault, say);

  const eth = provider();
  if (!eth) throw new Error("connect a wallet first — the Connect button, top right");
  if (!(await ensureChain(eth, say))) throw new Error("wrong network");

  say("confirm the launch in your wallet…");
  const wallet = createWalletClient({ account, chain, transport: custom(eth) });
  const hash = await wallet.writeContract({
    address: call.target,
    abi: call.abi as never,
    functionName: call.functionName as never,
    args: call.args as never,
    value: call.value,
    account,
    chain,
  });

  say(`launch sent: ${hash.slice(0, 12)}…`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const token = tokenFromReceipt(receipt.logs as never, factory);
  if (!token) throw new Error(`launched, but the token address could not be read — ${EXPLORER}/tx/${hash}`);
  return token;
}

/** Step 3. Open to everyone: the vault already knows what it is waiting for. */
export async function bindVault(
  vault: Address,
  token: Address,
  account: Address,
  say: (m: string) => void,
): Promise<Hex> {
  const eth = provider();
  if (!eth) throw new Error("connect a wallet first — the Connect button, top right");
  if (!(await ensureChain(eth, say))) throw new Error("wrong network");

  say("confirm the bind in your wallet…");
  const wallet = createWalletClient({ account, chain, transport: custom(eth) });
  const hash = await wallet.writeContract({
    address: vault, abi: vaultBindAbi, functionName: "bind", args: [token], account, chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
