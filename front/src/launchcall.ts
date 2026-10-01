/**
 * launchcall.ts — the Pons launch, encoded but not sent.
 *
 * Moved out of `pons.ts` so that something other than the browser can build it:
 * that file imports `chain.js` and `config.js`, which read the page at import
 * time, and the MCP server (`mcp/`) has to build EXACTLY this call — the three
 * locked fields included — for an agent to sign. One copy, imported by both;
 * `pons.ts` re-exports it with its own client bound, so no app import changed.
 *
 * The client is a PARAMETER for that reason, and it is the only change.
 */
import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { freshSalt } from "./launchlog.js";

/** Native ETH, as Pons spells it in `pairToken`. */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

export const factoryAbi = parseAbi([
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchForwarder() view returns (address)",
]);

/**
 * `PonsV2LaunchAndBuy`, the official forwarder -- the dev buy in the launch
 * transaction.
 *
 * **It is reachable, and `docs/recon.md` said for days that it was not.** The
 * fear was `FeeVault.bind`, which requires `l.deployer == LAUNCHER`: a contract
 * launching on someone's behalf is recorded as the deployer
 * (`recon-launchpad.md`, 2026-09-08), and a launch that binds to nothing costs
 * the creator a launch fee Pons does not refund. That probe used a contract with
 * NO PARTICULAR ROLE. The factory special-cases its own `launchForwarder()` and
 * records the CALLER -- read off $PAYD's own launch, tx `0x546fe392...`, whose
 * `deployer` is the Safe that called the forwarder and whose vault is bound
 * (`recon.md` §1.6bis).
 *
 * The signature came from that transaction's calldata and is confirmed by its
 * selector, `0xf85f8e41`: the explorer serves a `StubContract.sol` for this
 * address and Sourcify has nothing for chain 4663, so there was nowhere else to
 * read it.
 */
export const forwarderAbi = parseAbi([
  "function launchAndBuy((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt) params, uint256 launchConfigId, address pairToken, uint256 buyAmount, uint256 minOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve)",
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
  /** The creator's own first buy, in the launch's currency. `0n` means none, and
   *  it is the one value that decides WHICH contract is called: the forwarder
   *  carries a `ZeroAmount()` error and a zero buy is not sent to it. */
  buyAmount: bigint;
}

/** A launch, encoded but not sent: which contract, which function, what value.
 *  Both paths go through this — the three-signature one sends it straight away,
 *  the one-transaction one puts it in a batch. */
export interface LaunchCall {
  target: Address;
  abi: typeof factoryAbi | typeof forwarderAbi;
  functionName: "launchToken" | "launchAndBuy";
  args: readonly unknown[];
  value: bigint;
}

/**
 * **The three locked fields, in one place, for both paths.**
 *
 * `creatorFeeRecipient`, the pair token and `expectedEconomics` are conditions
 * `bind` checks, not preferences — that is why this file exists. The
 * one-transaction path cannot read `QUOTE` off a vault that does not exist yet,
 * so the quote and the recipient are ARGUMENTS here and the reading is left to
 * the caller that has something to read. Duplicating the construction instead
 * would have been the first step towards the two paths disagreeing about which
 * currency a launch is quoted in, which is the failure this whole module was
 * written to make impossible.
 *
 * `expectedEconomics` and `launchFee` are read HERE, as late as possible: the
 * first is a commitment Pons rejects if it has moved, the second is paid in
 * `value`.
 */
export async function buildLaunch(
  pub: PublicClient,
  factory: Address,
  account: Address,
  input: LaunchInput,
  quote: Address,
  feeRecipient: Address,
  say: (m: string) => void,
): Promise<LaunchCall> {
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

  const [fee, economics] = await Promise.all([
    pub.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }) as Promise<bigint>,
    pub.readContract({
      address: factory, abi: factoryAbi, functionName: "previewLaunchEconomics",
      args: [0n, quote],
    }) as Promise<Hex>,
  ]);

  // **The dev buy only rides along on a native-ETH launch.** `buyAmount` is
  // denominated in the launch's currency: on an ETH quote it travels in `value`
  // alongside the launch fee, exactly as $PAYD's own launch did (0.0005 + 0.009).
  // On a USDG or stock-token quote it would have to be PULLED from the creator,
  // which means an allowance to the forwarder and a second signature -- and what
  // it pulls with has not been measured. Sending it unmeasured on the money path
  // is how a creator loses a launch fee Pons does not refund, so those launches
  // keep the plain `launchToken` until the pull is read on-chain.
  const buy = quote === ZERO_ADDR ? input.buyAmount : 0n;
  if (input.buyAmount > 0n && buy === 0n) {
    say("the first buy is only available on an ETH-quoted launch — launching without it");
  }

  const params = {
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
        creatorFeeRecipient: feeRecipient,
        creatorTaxBps: input.creatorTaxBps,
        buybackEnabled: false,
        expectedEconomics: economics,
        salt: freshSalt(),
  } as const;

  // LOCKED on the vault's quote -- not on ETH. `bind` refuses everything else,
  // and it is right to; the difference from v1 is that there are now three
  // possible "everything elses" and this is the right one.
  //
  // `launchConfigId` stays 0: the only config the factory carries (`recon.md`
  // §1.1, supply 1e27 / curveFeeBps 100).
  if (buy > 0n) {
    return {
      target: (await pub.readContract({
        // READ, never the constant. `0xe33E9E47...` is in `recon.md`, and the
        // factory is what decides which forwarder it trusts -- it is the trust
        // that matters here, not the address.
        address: factory, abi: factoryAbi, functionName: "launchForwarder",
      })) as Address,
      abi: forwarderAbi,
      functionName: "launchAndBuy",
      args: [
        params,
        0n,
        quote,
        buy,
        // `minOut = 0`, and it is sound HERE and nowhere else: the token does
        // not exist until this transaction, so there is no price to move
        // against the buyer and nothing to front-run. Not a precedent for the
        // protocol's own swaps, which are bound by an oracle.
        0n,
        // The tokens go to the creator, and the creator is the only address
        // exempted from the snipe tax -- 99 % decaying over 3 s, which is
        // exactly what this call exists to step over. $PAYD's own launch
        // passed `[the Safe]` here.
        account,
        [account],
      ],
      value: fee + buy,
    };
  }
  return {
    target: factory,
    abi: factoryAbi,
    functionName: "launchToken",
    args: [params, 0n, quote],
    value: fee,
  };
}
