/**
 * drand.ts — the beacon the lottery draws from, and the only thing in this
 * repository that talks to a randomness source.
 *
 * **Why drand at all.** A draw needs a number nobody could know when the ticket
 * root was committed. This chain has no VRF (`docs/recon.md` §14) and block
 * hashes are a sequencer's to choose, so the randomness has to come from
 * outside and be VERIFIABLE inside: quicknet publishes one BLS signature every
 * three seconds, each unique for its round, and `DrandLib` checks it on-chain
 * against the pinned group key through the EIP-2537 precompiles. Nothing here
 * is trusted — this file FETCHES and RESHAPES, and a beacon it got wrong is one
 * `settleDraw` reverts on.
 *
 * **The two encodings, and why both exist.** drand publishes a signature
 * COMPRESSED (48 bytes, x plus a sign bit). `BLS.G1Point` wants it UNCOMPRESSED
 * and EIP-2537-padded (x and y, each 64 bytes: 16 zero bytes then 48). Solidity
 * would need a modular square root to decompress, so the point is handed over
 * already expanded and the contract checks the pairing rather than the shape —
 * a wrong y simply fails `verifyBeacon`.
 */
import { createHash } from "node:crypto";
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { keccak256, type Hex } from "viem";

/** quicknet's group key, genesis and period. Pinned, not discovered: a chain
 *  hash fetched at runtime is a chain hash an attacker can answer. Same three
 *  values `DrandLib` carries — `docs/recon.md` §14.1. */
export const QUICKNET_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const QUICKNET_PUBKEY =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
export const DRAND_GENESIS = 1_692_803_367;
export const DRAND_PERIOD = 3;

/**
 * The domain separation tag, and **it is 43 bytes with ONE L**.
 *
 * `…SSWU_RO_NUL_`, not `NULL_`. The pairing fails under the 44-byte spelling
 * and passes under this one; `DrandLib.hashToG1` hard-codes the same string and
 * its length byte `0x2b`. `offchain/scripts/drand-recon.mjs` still carries the
 * 44-byte draft, which is why the local verification below is pinned by a test
 * against a real beacon rather than trusted to a constant somebody retyped.
 */
export const DRAND_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

const API = process.env.DRAND_API ?? "https://api.drand.sh";

/** The round live at `ts`, by the same arithmetic `currentRound()` runs. */
export function roundAt(ts: number): number {
  if (ts <= DRAND_GENESIS) return 1;
  return Math.floor((ts - DRAND_GENESIS) / DRAND_PERIOD) + 1;
}

/** When `round` is published, as a unix timestamp. */
export function roundTime(round: number): number {
  return DRAND_GENESIS + (round - 1) * DRAND_PERIOD;
}

/** The message a round's signature is over: `sha256(be64(round))`. */
export function beaconMessage(round: number): Uint8Array {
  const be = Buffer.alloc(8);
  be.writeBigUInt64BE(BigInt(round));
  return new Uint8Array(createHash("sha256").update(be).digest());
}

/** `BLS.G1Point` — the four words the contract reads, EIP-2537 padded. */
export interface G1Point {
  x_a: Hex;
  x_b: Hex;
  y_a: Hex;
  y_b: Hex;
}

/** One 48-byte field element as EIP-2537's 64 bytes: 16 zeros, then the value. */
const fe = (x: bigint) => x.toString(16).padStart(96, "0").padStart(128, "0");

/**
 * The compressed signature, expanded into the point the contract takes.
 *
 * Throws on anything that is not a point of G1: `fromHex` rejects a bad
 * encoding and a coordinate off the curve, which is the whole of what this
 * conversion can get wrong that the chain would then pay gas to discover.
 */
export function toG1Point(compressedSig: string): G1Point {
  const hex = compressedSig.startsWith("0x") ? compressedSig.slice(2) : compressedSig;
  const affine = bls.G1.ProjectivePoint.fromHex(hex).toAffine();
  const x = fe(affine.x);
  const y = fe(affine.y);
  return {
    x_a: `0x${x.slice(0, 64)}`,
    x_b: `0x${x.slice(64)}`,
    y_a: `0x${y.slice(0, 64)}`,
    y_b: `0x${y.slice(64)}`,
  };
}

/**
 * The winning number, **exactly as `DrandLib.randomness` computes it**:
 * `keccak256` over the four uncompressed words, NOT drand's published
 * `sha256(compressed)`. Two hashes of one signature is two chances to disagree,
 * so this one is cross-checked against a real beacon in `lottery.test.ts`.
 */
export function randomness(p: G1Point): bigint {
  return BigInt(keccak256(`0x${[p.x_a, p.x_b, p.y_a, p.y_b].map((w) => w.slice(2)).join("")}` as Hex));
}

/** Which ticket a settled beacon draws out of `totalTickets`. */
export function winningTicket(p: G1Point, totalTickets: bigint): bigint {
  if (totalTickets <= 0n) throw new Error("totalTickets is zero");
  return randomness(p) % totalTickets;
}

/**
 * Whether this signature really is quicknet's for this round.
 *
 * **Run before relaying, and the reason is gas, not trust**: `settleDraw`
 * refunds a successful call and a reverted one refunds nothing, so a beacon
 * fetched from a gateway having a bad day would cost the keeper a transaction
 * to find out. The check is the same pairing the contract does.
 */
export function verifyBeacon(round: number, compressedSig: string): boolean {
  const hex = compressedSig.startsWith("0x") ? compressedSig.slice(2) : compressedSig;
  try {
    const sig = bls.G1.ProjectivePoint.fromHex(hex);
    const pk = bls.G2.ProjectivePoint.fromHex(QUICKNET_PUBKEY);
    const hm = bls.G1.ProjectivePoint.fromAffine(
      bls.G1.hashToCurve(beaconMessage(round), { DST: DRAND_DST }).toAffine(),
    );
    return bls.fields.Fp12.eql(
      bls.pairing(sig, bls.G2.ProjectivePoint.BASE),
      bls.pairing(hm, pk),
    );
  } catch {
    return false;
  }
}

export interface Beacon {
  round: number;
  /** Compressed, as drand published it. */
  signature: string;
  point: G1Point;
}

/**
 * Fetches one round, verifies it locally, and hands back both encodings.
 *
 * Returns `null` for a round that does not exist YET — the normal answer while
 * a draw waits for its target — and throws for a round that exists and does not
 * verify, which is a gateway to stop using rather than a state to carry on in.
 */
export async function fetchBeacon(round: number): Promise<Beacon | null> {
  const res = await fetch(`${API}/${QUICKNET_CHAIN_HASH}/public/${round}`);
  if (res.status === 404 || res.status === 425) return null;
  if (!res.ok) throw new Error(`drand ${round}: HTTP ${res.status}`);
  const body = (await res.json()) as { round: number; signature: string };
  if (body.round !== round) throw new Error(`drand returned round ${body.round}, asked ${round}`);
  if (!verifyBeacon(round, body.signature)) throw new Error(`drand ${round}: signature does not verify`);
  return { round, signature: body.signature, point: toG1Point(body.signature) };
}
