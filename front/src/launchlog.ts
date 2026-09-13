/**
 * What can be known from a Pons launch receipt, without a browser.
 *
 * Separate from `pons.ts` for the same reason `basket.ts` is separate from the
 * rest: these functions are the logic that has to be TESTABLE, and `pons.ts`
 * imports `config.js`, which reads `location.search`. One `import` was enough to
 * make the test impossible to run outside a browser.
 */
import type { Address, Hex } from "viem";

/**
 * The `topic0` of the event the factory emits at launch, MEASURED and not
 * guessed: `test/_Debug.t.sol` launched on a fork and read back the five logs.
 * The fourth comes from the factory and carries the token in `topics[1]`, the
 * curve in `topics[2]` -- checked against `launchToken`'s return values.
 *
 * The event's NAME stays unknown: none of the plausible signatures gives this
 * hash, and the explorer sits behind Cloudflare. So we lean on the measured hash
 * rather than on an assumed name -- it is less pretty and it is the only one of
 * the two we have actually verified.
 */
export const LAUNCH_TOPIC0 =
  "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607" as Hex;

/** The token's address, extracted from the launch receipt. */
export function tokenFromReceipt(
  logs: readonly { address: string; topics: readonly Hex[] }[],
  factory: Address,
): Address | null {
  const hit = logs.find(
    (l) => l.address.toLowerCase() === factory.toLowerCase() && l.topics[0] === LAUNCH_TOPIC0,
  );
  const t = hit?.topics[1];
  return t ? (`0x${t.slice(26)}` as Address) : null;
}

/** One unique salt per launch. Two launches with the same salt collide on the
 *  address and the second reverts. */
export function freshSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/**
 * What Pons writes into the token, as it is, forever.
 *
 * **Measured (`test/_Debug.t.sol`, thrown away afterwards):** the `logo` field
 * appears in NO log; it is stored on the token and read back by `logo()`. None
 * of the six plausible setters (`setLogo`, `updateLogo`, `setMetadata`,
 * `setImage`, `setDescription`, `updateMetadata`) exists -- which is not a proof
 * that there is none, but is enough to treat it as a one-shot.
 *
 * The chain itself imposes nothing: `ipfs://`, `https://` and anything else pass
 * alike. What KNOWS how to display one or the other is Pons's interface, which
 * cannot be queried from a contract. Hence the rule chosen: we accept both
 * forms, we invent neither, and we show a preview so that a dead address is seen
 * BEFORE the signature -- since afterwards, it cannot be corrected.
 */
export type LogoCheck = { ok: true; preview: string } | { ok: false; why: string };

export function checkLogo(raw: string, gateways: readonly string[]): LogoCheck {
  const v = raw.trim();
  if (v === "") return { ok: true, preview: "" }; // a launch with no logo stays legitimate

  if (v.startsWith("ipfs://")) {
    const path = v.slice(7).replace(/^ipfs\//, "");
    // A CID starts with Qm (v0) or b/z/f (v1). We do not decode it: we merely
    // refuse what plainly cannot be one.
    if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(path)) return { ok: false, why: "malformed ipfs:// address" };
    const gw = gateways[0]?.trim();
    return { ok: true, preview: gw ? gw + path : "" };
  }

  if (/^https:\/\//.test(v)) return { ok: true, preview: v };

  // `http://` is refused: the page is served over https and the browser will
  // block the image. It would be dead on display with nothing saying so.
  if (/^http:\/\//.test(v)) return { ok: false, why: "use https:// or ipfs:// — http images are blocked" };

  return { ok: false, why: "must start with ipfs:// or https://" };
}

/** What `FeeVault.bind` requires, checked BEFORE sending the transaction. */
export interface Launched {
  exists: boolean;
  token: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  curve: string;
}

/**
 * Why `bind` would refuse -- in words, not in a selector.
 *
 * **Why this diagnosis exists.** If the creator launches from Pons's own site
 * (to make use of their image upload), they fill in "Creator wallet" by hand and
 * nothing guarantees the rest. `bind` then reverts with `NotOurLaunch`, a bare
 * four-byte selector the wallet shows as it is. The same conditions read
 * beforehand say WHICH one gave way, and a failed launch is spotted before
 * paying the gas -- not after.
 *
 * Returns the list of problems; empty = `bind` will go through.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function diagnose(l: Launched, vault: string, launcher: string, quote = ZERO_ADDRESS): string[] {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const out: string[] = [];
  const ZERO = "0x0000000000000000000000000000000000000000";

  if (!l.exists) return ["this address is not a Pons launch on the factory this vault reads"];
  if (!eq(l.creatorFeeRecipient, vault)) {
    out.push(`its fees go to ${l.creatorFeeRecipient}, not to this vault (${vault}) — this one cannot be repaired here`);
  }
  if (!eq(l.deployer, launcher)) {
    out.push(`it was launched by ${l.deployer}, but this vault only accepts its own launcher ${launcher}`);
  }
  // A vault speaks ONE currency, declared at birth (`FeeVault.QUOTE`), and it
  // is not always ETH any more: 22.0 % of Pons's volume is quoted in USDG and
  // 37.2 % in stock tokens. Comparing against zero here would have condemned
  // every launch a v2 vault exists to serve.
  if (!eq(l.pairToken, quote)) {
    const want = eq(quote, ZERO) ? "native ETH" : quote;
    out.push(`it is quoted in ${l.pairToken}, not ${want} — those fees land in a ledger this vault cannot read`);
  }
  if (eq(l.curve, ZERO)) out.push("it has no bonding curve");
  return out;
}
