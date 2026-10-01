/**
 * publish.ts — publishes an epoch's artifact and checks it can be fetched back.
 *
 * **Without this, the root committed on-chain is useless**: the contract
 * verifies proofs, but proofs are built from the JSON. A published CID whose
 * content nobody holds is an epoch nobody can claim.
 *
 * **Digest and locator are two different things**, and conflating them used to
 * cap the whole system at ~160 holders. The sha256 of the canonical JSON is the
 * COMMITMENT: it goes on-chain, anyone can recompute it, and every fetch is
 * checked against it. The CID is only an ADDRESS. For a file inside one IPFS
 * block the two coincide — a raw CIDv1 is just that sha256 — which is why
 * deriving one from the other worked at first and then stopped: past 256 KiB,
 * IPFS chunks the file into a DAG whose root hash is not the content's. The
 * derived address 404s, the read-back fails, and `keeper.ts` defers the
 * publication forever. Measured: 160 holders x 10 stocks over one day is
 * 261,595 bytes, one block to the byte.
 *
 * So we now keep the CID the node REPORTS, and hand it to `publishRoot`, which
 * emits it. Nothing on-chain reads it; the front does, and verifies what comes
 * back against the digest.
 *
 * Hence the ordering rule the keeper follows: **publish, verify, and only then
 * commit on-chain**. The reverse would commit the chain to absent content.
 *
 * Two steps, and only the second one counts:
 *   1. send it to an IPFS node (local kubo, or a pinning service);
 *   2. **read it back from a gateway** and compare the sha256. An `add` that
 *      answers 200 proves nothing about real availability.
 *
 * A local copy is always written first: if every gateway is down, we still hold
 * what is needed to republish without recomputing.
 */
import { writeFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

const IPFS_API_URL = process.env.IPFS_API_URL ?? "";
const IPFS_API_KEY = process.env.IPFS_API_KEY ?? "";
const GATEWAYS = (process.env.IPFS_GATEWAYS ?? "https://ipfs.io/ipfs/,https://dweb.link/ipfs/").split(",");
const DATA_DIR = process.env.EPOCH_DIR ?? "data";
/**
 * Give the content time to propagate before calling it a failure.
 *
 * Overridable because the read-back is the one part of this file that needs a
 * network: a test exercising the NAMING has no gateway to read from, and would
 * otherwise spend five attempts and four delays discovering that, per call.
 * Never lower them in production — an `add` that answers 200 proves nothing.
 */
const VERIFY_ATTEMPTS = Math.max(1, Number(process.env.IPFS_VERIFY_ATTEMPTS ?? 5));
const VERIFY_DELAY_MS = Math.max(0, Number(process.env.IPFS_VERIFY_DELAY_MS ?? 3_000));

/**
 * How many artifacts stay pinned **per deployment**. One per epoch, so 100 is
 * about two days of history at 30-minute epochs.
 *
 * Pinning without ever unpinning grows without bound, and it grows with the
 * holder count — every artifact carries the FULL cumulative table, not a delta.
 * At 1,000 holders that is ~1.6 MB per epoch, 75 MB a day, and a 5 GB plan is
 * gone in two months. At 5,000 holders, thirteen days. The storage runs out
 * exactly when the project succeeds, and when it does the keeper stops
 * publishing and nobody can build a proof.
 *
 * Keeping a window makes the footprint constant instead: ~157 MB at 1,000
 * holders, whatever the horizon.
 *
 * Old artifacts are safe to drop because roots are CUMULATIVE. `claim` verifies
 * against `roots[activeRoot]`, the front only fetches the active root's
 * artifact, and `dispute.ts` recomputes from chain state rather than reading any
 * stored artifact. Older ones serve auditability, nothing operational.
 */
const KEEP = Math.max(8, Number(process.env.IPFS_KEEP ?? 100));

const sha256Hex = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");

/** Raw CIDv1 + sha2-256, rebuilt from the digest. See front/src/cid.ts. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export function cidFromSha256(digestHex: string): string {
  const d = digestHex.replace("0x", "");
  if (d.length !== 64) throw new Error("digest sha256 attendu");
  const bytes = [0x01, 0x55, 0x12, 0x20];
  for (let i = 0; i < 32; i++) bytes.push(parseInt(d.slice(i * 2, i * 2 + 2), 16));
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return "b" + out;
}

export interface PublishResult {
  /** IPFS address, as the node reported it. A hint, never a proof. */
  cid: string;
  /** sha256 of the canonical JSON. This is the commitment. */
  digest: string;
  localPath: string;
  retrievable: boolean;
  from?: string;
}

/**
 * On-disk name of an artifact, keyed by the DEPLOYMENT it describes.
 *
 * **The epoch number alone is not a name.** Two Distributors number their epochs
 * from their own genesis, and one keeper serves every vault the registry has
 * made — so `epoch-42.json` meant vault A's forty-second epoch until vault B
 * reached its own, and then it silently meant B's. What the overwrite destroyed
 * was the `.cid` sidecar beside it, which `pruneArtifacts` calls "the ONLY
 * record of which CID this epoch produced": A's pin became unreachable, hence
 * unremovable, and the pinning bill grew without bound while the window of
 * artifacts that could still be unpinned shrank to whatever B had written.
 *
 * It is the same collision `windowShares` keys out with `shares-{distributor}-`
 * and the keeper with `previous-root-{distributor}-`. This file had been left
 * behind when the platform stopped being one vault.
 */
const artifactBase = (distributor: string, epoch: number) =>
  `epoch-${distributor.toLowerCase()}-${epoch}`;

/**
 * @param distributor Whose epoch this is. Part of the file name, because the
 *                    epoch number is not unique across the registry's vaults.
 * @param json Canonical serialisation. THIS byte string is what gets hashed
 *             on-chain — never reformat it here.
 */
export async function publishEpoch(distributor: string, epoch: number, json: string): Promise<PublishResult> {
  const digest = sha256Hex(json);
  let cid = cidFromSha256(digest);

  mkdirSync(DATA_DIR, { recursive: true });
  const base = artifactBase(distributor, epoch);
  const localPath = `${DATA_DIR}/${base}.json`;
  writeFileSync(localPath, json);

  if (IPFS_API_URL) {
    try {
      const form = new FormData();
      form.append("file", new Blob([json], { type: "application/json" }), `${base}.json`);
      const res = await fetch(`${IPFS_API_URL.replace(/\/$/, "")}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
        method: "POST",
        headers: IPFS_API_KEY ? { Authorization: `Bearer ${IPFS_API_KEY}` } : undefined,
        body: form,
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 120)}`);
      // The node's answer WINS. It knows how it chunked the file; we do not,
      // and we no longer pretend to. A node that ignores `raw-leaves` is
      // therefore not a problem either — it just reports a different address.
      cid = JSON.parse(body.trim().split("\n").pop()!).Hash as string;
    } catch (e) {
      // Keep the derived address: with no node configured, or a node that is
      // down, a single-block artifact is still reachable from any gateway that
      // happens to hold it.
      console.warn("  IPFS publish failed:", (e as Error).message);
    }
  }

  // Remembered next to the artifact so `pruneArtifacts` knows what to unpin.
  // It can no longer recompute it: that was only ever true in one block.
  writeFileSync(`${DATA_DIR}/${base}.cid`, cid);

  // The only test that counts: can somebody else read it?
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    for (const gw of GATEWAYS) {
      try {
        const res = await fetch(gw.trim() + cid, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) continue;
        const text = await res.text();
        if (sha256Hex(text) === digest) return { cid, digest, localPath, retrievable: true, from: gw.trim() };
        console.warn(`  ${gw} serves content that does not match the digest`);
      } catch { /* passerelle suivante */ }
    }
    if (attempt < VERIFY_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
  }

  return { cid, digest, localPath, retrievable: false };
}

/**
 * Drops every artifact older than the newest `KEEP`, locally and on the pinning
 * service — **`KEEP` per deployment, not `KEEP` in total.**
 *
 * The window has to be per Distributor for the same reason the file name is.
 * A global window shared by N vaults leaves each one `KEEP / N` artifacts, and
 * past a handful of vaults that reaches back less far than the active root:
 * the keeper would unpin the very artifact whose proofs holders are using. The
 * bound that matters is "enough history for THIS vault", and it does not get
 * cheaper because a second vault exists.
 *
 * Runs only after a publication that was read back successfully, so the artifact
 * the contract is about to point at is always among the newest and can never be
 * the one removed. `KEEP` is floored at 8 for the same reason: a misconfigured
 * `IPFS_KEEP=1` would otherwise leave a window of one, and a `publishRoot` that
 * failed after its artifact was published would leave the ACTIVE root's
 * artifact — the previous one — unpinned and its holders unable to prove
 * anything.
 *
 * Failures here are logged and swallowed. Not reclaiming space is a problem for
 * later; a throw would take down the publication that just succeeded.
 */
export async function pruneArtifacts(): Promise<{ removed: number; kept: number }> {
  interface Artifact { key: string; epoch: number; base: string }
  let found: Artifact[];
  try {
    found = readdirSync(DATA_DIR)
      .map((n): Artifact | null => {
        const keyed = /^(epoch-(0x[0-9a-f]{40})-(\d+))\.json$/.exec(n);
        if (keyed) return { key: keyed[2]!, epoch: Number(keyed[3]), base: keyed[1]! };
        // The shape this file wrote before the deployment was part of the name.
        // Given its own group rather than ignored: a data volume carried across
        // the change still holds these, and skipping them would leak their pins
        // for ever — which is the bug being fixed, one deploy later.
        const bare = /^(epoch-(\d+))\.json$/.exec(n);
        if (bare) return { key: "", epoch: Number(bare[2]), base: bare[1]! };
        return null;
      })
      .filter((a): a is Artifact => a !== null);
  } catch {
    return { removed: 0, kept: 0 };
  }

  const byDeployment = new Map<string, Artifact[]>();
  for (const a of found) {
    const g = byDeployment.get(a.key);
    if (g) g.push(a); else byDeployment.set(a.key, [a]);
  }

  let removed = 0;
  for (const group of byDeployment.values()) {
    group.sort((a, b) => b.epoch - a.epoch);
    for (const a of group.slice(KEEP)) {
      const path = `${DATA_DIR}/${a.base}.json`;
      try {
        // Written by `publishEpoch`. Falling back to the derived address covers
        // artifacts from before the sidecar existed, and single-block ones.
        let cid: string;
        try {
          cid = readFileSync(`${DATA_DIR}/${a.base}.cid`, "utf8").trim();
        } catch {
          cid = cidFromSha256(sha256Hex(readFileSync(path, "utf8")));
        }

        if (IPFS_API_URL) {
          const res = await fetch(`${IPFS_API_URL.replace(/\/$/, "")}/api/v0/pin/rm?arg=${cid}`, {
            method: "POST",
            headers: IPFS_API_KEY ? { Authorization: `Bearer ${IPFS_API_KEY}` } : undefined,
            signal: AbortSignal.timeout(8_000),
          });
          // A pin that is already gone is a success, not a failure.
          if (!res.ok && res.status !== 404) {
            console.warn(`  unpin ${cid} returned ${res.status}`);
          }
        }

        // Only after the unpin call returned. The local file is the ONLY record
        // of which CID this epoch produced — delete it first and a pin we failed
        // to remove becomes unreachable for ever. A throw above therefore leaves
        // the file in place and the next publication retries it.
        unlinkSync(path);
        try { unlinkSync(`${DATA_DIR}/${a.base}.cid`); } catch { /* sidecar absent */ }
        removed++;
      } catch (e) {
        console.warn(`  could not prune ${a.base}:`, (e as Error).message);
      }
    }
  }

  return { removed, kept: found.length - removed };
}
