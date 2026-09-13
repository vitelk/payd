/**
 * Rebuilds a "raw" IPFS v1 CID from the sha256 digest published on-chain.
 *
 * The contract stores `sha256(canonical json)`. For a file that fits in a single
 * IPFS block (< 256 KB, which covers an epoch with a few thousand holders),
 * `ipfs add --cid-version=1 --raw-leaves` produces exactly
 * `CIDv1(raw, sha2-256, digest)`. The committed hash IS the content address.
 *
 * Beyond one block IPFS chunks the file and the root CID is no longer that
 * digest: the reconstruction fails silently (the fetch finds nothing), but
 * VERIFICATION by hash stays valid whatever the provenance. That is what is
 * authoritative, not the address.
 */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    // Makes the invariant explicit: `value` only carries the `bits` not yet
    // emitted. Without this mask the result stays correct — the useful bits fit
    // in the low 13 bits, which JS's 32-bit arithmetic preserves — but you would
    // have to prove that on every read.
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function cidFromSha256(digestHex: `0x${string}`): string {
  const digest = digestHex.slice(2);
  if (digest.length !== 64) throw new Error("expected a sha256 digest");
  // <version 1> <raw codec 0x55> <multihash sha2-256 0x12> <length 0x20> <digest>
  const bytes = new Uint8Array(4 + 32);
  bytes[0] = 0x01;
  bytes[1] = 0x55;
  bytes[2] = 0x12;
  bytes[3] = 0x20;
  for (let i = 0; i < 32; i++) bytes[4 + i] = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  return "b" + base32(bytes); // 'b' = the base32 prefix of CIDv1
}
