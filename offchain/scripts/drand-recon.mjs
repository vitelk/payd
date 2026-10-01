// Verifies drand quicknet round 1,000,000 against the pinned group key, and
// emits the EIP-2537-encoded operands for the on-chain pairing cross-check.
import { createHash } from "node:crypto";
import { bls12_381 as bls } from "@noble/curves/bls12-381";

const PK =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
const ROUND = 1000000n;
const SIG = "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72";
const RANDOMNESS = "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3";
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NULL_";

const sha256 = (b) => createHash("sha256").update(b).digest();

// 1. randomness == sha256(signature)
const sigBytes = Buffer.from(SIG, "hex");
console.log("randomness matches sha256(sig):", sha256(sigBytes).toString("hex") === RANDOMNESS);

// 2. message = sha256(be64(round))
const roundBuf = Buffer.alloc(8);
roundBuf.writeBigUInt64BE(ROUND);
const msg = sha256(roundBuf);
console.log("message:", msg.toString("hex"));

// 3. pairing check e(sig, g2) == e(H(m), pk)
const sig = bls.G1.ProjectivePoint.fromHex(SIG);
const pk = bls.G2.ProjectivePoint.fromHex(PK);
const Hm = bls.G1.hashToCurve(new Uint8Array(msg), { DST });
const HmP = bls.G1.ProjectivePoint.fromAffine(Hm.toAffine());

const left = bls.pairing(sig, bls.G2.ProjectivePoint.BASE);
const right = bls.pairing(HmP, pk);
console.log("pairing check e(sig,g2)==e(H(m),pk):", bls.fields.Fp12.eql(left, right));

// 4. EIP-2537 encodings: 64-byte padded field elements.
const fe = (x) => x.toString(16).padStart(96, "0").padStart(128, "0");
const g1 = (p) => {
  const a = p.toAffine();
  return fe(a.x) + fe(a.y);
};
const g2 = (p) => {
  const a = p.toAffine();
  // EIP-2537 G2: c0 then c1 for x, then c0 then c1 for y.
  return fe(a.x.c0) + fe(a.x.c1) + fe(a.y.c0) + fe(a.y.c1);
};
const negG2 = bls.G2.ProjectivePoint.BASE.negate();

console.log("SIG_EIP2537=" + g1(sig));
console.log("HM_EIP2537=" + g1(HmP));
console.log("PK_EIP2537=" + g2(pk));
console.log("NEG_G2_EIP2537=" + g2(negG2));
// Pairing precompile input: (sig, -g2) then (H(m), pk) — expected output 1.
console.log("PAIRING_INPUT=0x" + g1(sig) + g2(negG2) + g1(HmP) + g2(pk));
