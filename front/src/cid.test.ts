/**
 * Checks the CID reconstruction. `pnpm --filter front test`
 *
 * We do NOT compare against CIDs copied from memory: that is what I did first,
 * and the constants were wrong while the code was right — a test that accuses
 * wrongly is worse than no test.
 *
 * We compare against a BigInt reimplementation, immune to the 32-bit overflows
 * that are the only real trap in this encoding. The two implementations share
 * the alphabet and nothing else.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cidFromSha256 } from "./cid.js";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Reference: accumulate everything, then slice. Readable, slow, no overflow. */
function referenceCid(digestHex: string): string {
  const d = digestHex.replace("0x", "");
  const bytes = [0x01, 0x55, 0x12, 0x20];
  for (let i = 0; i < 32; i++) bytes.push(parseInt(d.slice(i * 2, i * 2 + 2), 16));

  let v = 0n;
  let nbits = 0n;
  for (const b of bytes) { v = (v << 8n) | BigInt(b); nbits += 8n; }
  const pad = (5n - (nbits % 5n)) % 5n; // right-padding zeros
  v <<= pad;
  nbits += pad;

  let out = "";
  for (let i = nbits - 5n; i >= 0n; i -= 5n) out += B32[Number((v >> i) & 31n)];
  return "b" + out;
}

// Fixed vectors, plus randomness: randomness is what would catch a
// data-dependent overflow.
const inputs = ["", "hello", "a", '{"epoch":1}'];
for (let i = 0; i < 200; i++) inputs.push(randomBytes(24).toString("hex"));

for (const input of inputs) {
  const digest = ("0x" + createHash("sha256").update(input).digest("hex")) as `0x${string}`;
  assert.equal(cidFromSha256(digest), referenceCid(digest), `CID mismatch for ${JSON.stringify(input.slice(0, 16))}`);
}

// Shape: a raw CIDv1 + sha2-256 is always 59 base32 characters.
const one = cidFromSha256(("0x" + "ab".repeat(32)) as `0x${string}`);
assert.equal(one.length, 59, "unexpected CIDv1 length");
assert.ok(one.startsWith("bafkrei"), "expected a raw/sha256 CIDv1 prefix");

assert.throws(() => cidFromSha256("0xdead" as `0x${string}`), /sha256/);

console.log(`cid: ${inputs.length} vectors match the reference`);
