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
 * **This is not a router contract.** The three transactions stay three
 * signatures from the SAME address -- `bind` requires `l.deployer == LAUNCHER`,
 * and Pons records `msg.sender`. A router would become the deployer itself: it
 * works (`test/Deployer.t.sol`) and it adds code to audit in order to solve a
 * form problem.
 */
import { createWalletClient, custom, parseAbi, type Address, type Hex } from "viem";
import { pub, chain, provider, ensureChain } from "./chain.js";
import { EXPLORER } from "./config.js";
import { tokenFromReceipt, freshSalt } from "./launchlog.js";

export const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
]);

export const ponsRegistryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);

export const vaultBindAbi = parseAbi([
  "function bind(address token)",
  "function LAUNCHER() view returns (address)",
  "function token() view returns (address)",
  "function QUOTE() view returns (address)",
]);

export interface LaunchInput {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
  creatorTaxBps: number;
}

/**
 * Step 2. Returns the token's address, or throws.
 *
 * `expectedEconomics` and `launchFee` are re-read JUST before sending: the first
 * is a commitment Pons rejects if it has moved, the second is paid in `value`.
 * Reading them when the page loads and sending them ten minutes later is a
 * transaction that reverts explaining nothing.
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
    throw new Error(`this vault must be launched from ${launcher} — the wallet is on ${account}`);
  }

  if (!(await pub.readContract({ address: factory, abi: factoryAbi, functionName: "launchEnabled" }))) {
    throw new Error("Pons has launches disabled right now");
  }

  // The cap is READ, not copied. `docs/recon.md` gives it as 1 000 bps and the
  // form uses that to bound its field -- but a copied constant becomes silently
  // wrong the day Pons moves it, and the creator would see nothing but a bare
  // revert.
  const maxTax = Number(await pub.readContract({
    address: factory, abi: factoryAbi, functionName: "maxCreatorTaxBps",
  }));
  if (!Number.isInteger(input.creatorTaxBps) || input.creatorTaxBps < 0 || input.creatorTaxBps > maxTax) {
    throw new Error(`the creator tax must be a whole number of bps between 0 and ${maxTax}`);
  }

  // The launch's currency is READ FROM THE VAULT, never typed in here. The
  // vault has exactly one, written at its birth, and `bind` refuses everything
  // else -- so asking the creator to retype it would be asking them to copy
  // something the chain already knows. It is also what makes a mismatch
  // impossible on this path: only Pons's own form is left to fill by hand, and
  // there the value is displayed to be copied.
  const quote = (await pub.readContract({
    address: vault, abi: vaultBindAbi, functionName: "QUOTE",
  })) as Address;

  const [fee, economics] = await Promise.all([
    pub.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }) as Promise<bigint>,
    pub.readContract({
      address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics",
      args: [0n, quote],
    }) as Promise<Hex>,
  ]);

  const eth = provider();
  if (!eth) throw new Error("no wallet detected");
  if (!(await ensureChain(eth, say))) throw new Error("wrong network");

  say("confirm the launch in your wallet…");
  const wallet = createWalletClient({ account, chain, transport: custom(eth) });
  const hash = await wallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "launchToken",
    args: [
      {
        name: input.name,
        symbol: input.symbol,
        logo: input.logo,
        description: input.description,
        // The five slots are (twitter, telegram, discord, website, farcaster) --
        // read from Pons's own bundle, which carries the verified signature
        // `socials() view returns (string twitter, string telegram, string
        // discord, string website, string farcaster)`. This file used to name
        // slots 3 and 4 `website` and `ens`, so a creator's site was written
        // one slot early, where nothing displays it, and the slot every
        // launchpad reads went out empty -- with no setter to fix it after.
        socials: {
          twitter: input.x, telegram: input.telegram, discord: "", website: input.website, farcaster: "",
        },
        // LOCKED: the fees have to reach the vault, or none of this serves any
        // purpose at all.
        creatorFeeRecipient: vault,
        creatorTaxBps: input.creatorTaxBps,
        buybackEnabled: false,
        expectedEconomics: economics,
        salt: freshSalt(),
      },
      0n,
      // LOCKED on the vault's quote -- not on ETH. `bind` refuses everything
      // else, and it is right to; the difference from v1 is that there are now
      // three possible "everything elses" and this is the right one.
      quote,
    ],
    value: fee,
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
  if (!eth) throw new Error("no wallet detected");
  if (!(await ensureChain(eth, say))) throw new Error("wrong network");

  say("confirm the bind in your wallet…");
  const wallet = createWalletClient({ account, chain, transport: custom(eth) });
  const hash = await wallet.writeContract({
    address: vault, abi: vaultBindAbi, functionName: "bind", args: [token], account, chain,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
