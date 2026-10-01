/**
 * Artifact naming and retention, on a platform that has more than one vault.
 * `pnpm --filter offchain test`
 *
 * The bug this pins: `epoch-42.json` named vault A's forty-second epoch until
 * vault B reached its own. One keeper serves every vault the registry has made,
 * and two Distributors number their epochs from their own genesis, so the
 * collision was not a corner case — it was the second launch.
 *
 * Runs with no network and no IPFS node: `IPFS_API_URL` is left empty, so both
 * the upload and the unpin call are skipped. The read-back is pointed at a
 * closed port and given one attempt — this test is about the NAMING, and the
 * artifacts are `retrievable: false` on purpose.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "payd-publish-"));
process.env.EPOCH_DIR = DIR;
process.env.IPFS_API_URL = "";
process.env.IPFS_KEEP = "8"; // the floor, so the fixtures stay small
process.env.IPFS_GATEWAYS = "http://127.0.0.1:1/"; // refused at once, never hangs
process.env.IPFS_VERIFY_ATTEMPTS = "1";
process.env.IPFS_VERIFY_DELAY_MS = "0";

const { publishEpoch, pruneArtifacts } = await import("./publish.js");

const A = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const B = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";

let checks = 0;
const check = (c: boolean, what: string) => { assert.ok(c, what); checks++; };

// 1. The same epoch number, two deployments, two files. Before the fix the
//    second call overwrote the first — and took its `.cid` sidecar with it,
//    which `pruneArtifacts` calls the ONLY record of what to unpin.
const ra = await publishEpoch(A, 42, JSON.stringify({ vault: "A", upToEpoch: 42 }));
const rb = await publishEpoch(B, 42, JSON.stringify({ vault: "B", upToEpoch: 42 }));
check(ra.localPath !== rb.localPath, "two deployments at epoch 42 must not share a file");
check(existsSync(ra.localPath) && existsSync(rb.localPath), "both artifacts survive");
check(ra.digest !== rb.digest, "and they hold different content");

// 2. The name carries the deployment, lowercased.
check(ra.localPath.includes(A.toLowerCase()), "A's path names A");
check(rb.localPath.includes(B.toLowerCase()), "B's path names B");

// 3. The sidecar travels with it, or a pin becomes unremovable.
check(existsSync(ra.localPath.replace(/\.json$/, ".cid")), "A keeps its own .cid");
check(existsSync(rb.localPath.replace(/\.json$/, ".cid")), "B keeps its own .cid");

// 4. Retention is KEEP **per deployment**, not KEEP in total. A global window
//    shared by N vaults reaches back KEEP/N — past a handful of vaults that is
//    shorter than the active root, and the keeper would unpin the artifact
//    whose proofs holders are using.
for (let e = 0; e < 20; e++) {
  await publishEpoch(A, e, JSON.stringify({ vault: "A", upToEpoch: e }));
  await publishEpoch(B, e, JSON.stringify({ vault: "B", upToEpoch: e }));
}
await pruneArtifacts();

const left = readdirSync(DIR).filter((n) => n.endsWith(".json"));
const ofA = left.filter((n) => n.includes(A.toLowerCase()));
const ofB = left.filter((n) => n.includes(B.toLowerCase()));
check(ofA.length === 8, `A keeps 8 artifacts, found ${ofA.length}`);
check(ofB.length === 8, `B keeps 8 artifacts, found ${ofB.length}`);

// 5. And it keeps the NEWEST eight of each, epoch 42 included — the one a root
//    might still point at.
for (const [who, files] of [[A, ofA], [B, ofB]] as const) {
  const epochs = files.map((n) => Number(/-(\d+)\.json$/.exec(n)![1])).sort((x, y) => x - y);
  // 0..19 published plus 42, KEEP = 8: the eight highest epoch numbers.
  assert.deepEqual(epochs, [13, 14, 15, 16, 17, 18, 19, 42]);
  check(epochs.includes(42), `${who} still holds epoch 42`);
}

// 6. A volume carried across the change still holds bare `epoch-N.json` files.
//    They get their own group rather than being ignored: skipping them would
//    leak their pins for ever, which is the bug itself, one deploy later.
for (let e = 0; e < 12; e++) writeFileSync(join(DIR, `epoch-${e}.json`), "{}");
await pruneArtifacts();
const legacy = readdirSync(DIR).filter((n) => /^epoch-\d+\.json$/.test(n));
check(legacy.length === 8, `legacy artifacts are pruned to 8, found ${legacy.length}`);
check(readdirSync(DIR).filter((n) => n.includes(A.toLowerCase()) && n.endsWith(".json")).length === 8,
  "and pruning the legacy group does not touch a keyed one");

console.log(`publish: ${checks} checks OK`);
