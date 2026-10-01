/**
 * `tokenFromReceipt` against the REAL receipt measured on a fork.
 *
 * The five logs below are the ones `test/_Debug.t.sol` read back while launching
 * on the real factory: same order, same emitters, same topics. The expected
 * token is `launchToken`'s return value in that same transaction -- not a value
 * copied from a log, or the test would only be comparing the log to itself.
 */
import assert from "node:assert/strict";
import { tokenFromReceipt, freshSalt, checkLogo, diagnose, LAUNCH_TOPIC0 } from "./launchlog.js";
import type { Address, Hex } from "viem";

const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const TOKEN = "0xC7F20D84689768476B2Fea9D2b8FD9102EC3c4bb" as Address;
const CURVE = "0x04cdd820FA1A22426A38AfeBDdeF0aB856e88378" as Address;
const w = (a: string) => `0x000000000000000000000000${a.slice(2).toLowerCase()}` as Hex;

const RECEIPT = [
  // 0 — Transfer, emitted by the TOKEN itself
  { address: TOKEN, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(64)}`, w(CURVE)] as Hex[] },
  // 1, 2 — the curve
  { address: CURVE, topics: ["0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6"] as Hex[] },
  { address: CURVE, topics: ["0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7",
      w("0xbe77972B099fa054E6e6223a232dc829E8cc1642")] as Hex[] },
  // 3 — a third party referencing the factory in topic1: the exact trap
  { address: "0x263ed295dAFaE1d9AAdD6E56c4B6F9f38eE019Dd",
    topics: ["0x3d0ce9bfc3ed7d6862dbb28b2dea94561fe714a1b4d019aa8af39730d1ad7c3d", w(FACTORY)] as Hex[] },
  // 4 — THE log: emitted BY the factory, token in topics[1]
  { address: FACTORY, topics: [LAUNCH_TOPIC0, w(TOKEN), w(CURVE),
      w("0xbe77972B099fa054E6e6223a232dc829E8cc1642")] as Hex[] },
];

// 1. The token comes out of the right log.
assert.equal(tokenFromReceipt(RECEIPT, FACTORY)?.toLowerCase(), TOKEN.toLowerCase());

// 2. Log 3 mentions the factory in topic1 but does NOT come from it. Filtering
//    on the emitter alone, or on the topic alone, returns the wrong address.
assert.notEqual(tokenFromReceipt([RECEIPT[3]!], FACTORY), FACTORY);
assert.equal(tokenFromReceipt([RECEIPT[3]!], FACTORY), null);

// 3. THE DECOY THAT MATTERS: any contract can emit this topic0 -- nothing
//    reserves it to the factory. A hostile token emitting it BEFORE the real log
//    would point `bind` at an address of its choosing if we filtered on the
//    topic alone. Verified by mutation: with the emitter filter removed, this
//    assertion fails.
const SPOOF = "0xbAdbadBAdbadBadbaDBAdBadbADbADBadBAd0001" as Address;
const spoofed = [
  { address: SPOOF, topics: [LAUNCH_TOPIC0, w(SPOOF), w(CURVE)] as Hex[] },
  ...RECEIPT,
];
assert.equal(tokenFromReceipt(spoofed, FACTORY)?.toLowerCase(), TOKEN.toLowerCase(),
  "a forged log passes ahead of the real one");

// 4. A launch whose log is missing returns null, never an invented address:
//    the caller has to be able to say "launched, but the address is unreadable".
assert.equal(tokenFromReceipt(RECEIPT.slice(0, 4), FACTORY), null);

// 5. The right factory, but a different event: null.
assert.equal(tokenFromReceipt([{ address: FACTORY, topics: [w(TOKEN), w(TOKEN)] as Hex[] }], FACTORY), null);

// 6. The salt is unique. Two launches with the same salt collide on the address
//    and the second reverts.
const salts = new Set(Array.from({ length: 500 }, freshSalt));
assert.equal(salts.size, 500, "freshSalt repeats");
for (const s of salts) assert.match(s, /^0x[0-9a-f]{64}$/);

// ---- the logo: one chance only, hence a validation that refuses early -----
const GW = ["https://ipfs.filebase.io/ipfs/", "https://ipfs.io/ipfs/"];
const okc = (v: string) => checkLogo(v, GW);

// Empty = no logo, and that is a legitimate choice, not an error.
assert.deepEqual(okc(""), { ok: true, preview: "" });
assert.deepEqual(okc("   "), { ok: true, preview: "" });

// ipfs:// -> preview through the FIRST gateway, the one we pin ourselves.
const cid = "bafkreiabc123";
assert.deepEqual(okc(`ipfs://${cid}`), { ok: true, preview: `https://ipfs.filebase.io/ipfs/${cid}` });
// The `ipfs://ipfs/<cid>` form, which some tools produce, must not give a
// doubled gateway.
assert.deepEqual(okc(`ipfs://ipfs/${cid}`), { ok: true, preview: `https://ipfs.filebase.io/ipfs/${cid}` });

// https passe tel quel.
assert.deepEqual(okc("https://x.io/a.png"), { ok: true, preview: "https://x.io/a.png" });

// http is REFUSED: the page is https, the browser would block the image and the
// creator would see nothing -- after the signature, that is no longer fixable.
assert.equal(okc("http://x.io/a.png").ok, false);

// Everything else is refused rather than guessed.
for (const bad of ["x.io/a.png", "ftp://x.io/a", "ipfs://", "javascript:alert(1)", "data:image/png;base64,AAA"]) {
  assert.equal(okc(bad).ok, false, `accepte a tort: ${bad}`);
}

// ---- the diagnosis: saying WHICH of the four checks gave way ---------------
const V = "0x1111111111111111111111111111111111111111";
const L = "0x2222222222222222222222222222222222222222";
const Z = "0x0000000000000000000000000000000000000000";
const good = { exists: true, token: TOKEN, deployer: L, creatorFeeRecipient: V, pairToken: Z, curve: CURVE };

// The nominal case complains about nothing.
assert.deepEqual(diagnose(good, V, L), []);
// Case must not matter: a wallet often returns the address in lower case.
assert.deepEqual(diagnose(good, V.toUpperCase().replace("0X", "0x"), L), []);

// An unknown launch: a single message, and we do not go on to the others.
assert.deepEqual(diagnose({ ...good, exists: false }, V, L).length, 1);

// Each condition fails ON ITS OWN, and names itself.
assert.match(diagnose({ ...good, creatorFeeRecipient: L }, V, L)[0]!, /fees go to/);
assert.match(diagnose({ ...good, deployer: V }, V, L)[0]!, /launched by/);
assert.match(diagnose({ ...good, pairToken: TOKEN }, V, L)[0]!, /native ETH/);
// A vault quoted in something other than ETH: ETH becomes the problem, and its
// own currency is what passes. Without that pairing, `diagnose` condemned the
// two thirds of the market v2 has just opened.
assert.deepEqual(diagnose({ ...good, pairToken: TOKEN }, V, L, TOKEN), []);
assert.match(diagnose(good, V, L, TOKEN)[0]!, new RegExp(TOKEN));
assert.match(diagnose({ ...good, curve: Z }, V, L)[0]!, /bonding curve/);

// And they add up: coming back from Pons's site with two errors has to show
// both of them, not the first one and then a round trip.
assert.equal(diagnose({ ...good, creatorFeeRecipient: L, pairToken: TOKEN }, V, L).length, 2);

console.log("pons: token read from the measured receipt, decoys rejected, salts unique, logo validated, bind failures named");
