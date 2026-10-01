/**
 * publish-site.ts — pins a static site directory on IPFS and reads it back.
 *
 * `ipfs add -r` assumes a local kubo. There is none here, and there does not
 * need to be: Filebase exposes the same RPC, and the pinning service is already
 * the one the keeper uses. Same endpoint, same per-bucket token.
 *
 * Nested trees, because the site now carries the app under `app/` and the app
 * carries its bundle under `assets/`. kubo builds the directory from the part
 * FILENAMES: a part named `app/assets/index.js` creates both directories on the
 * way. Explicit `application/x-directory` parts are what makes an EMPTY
 * directory survive, and we send them too so the shape is not left to
 * inference.
 *
 * The read-back is the point, not the `add`. A 200 from the API says the bytes
 * reached one node; it says nothing about whether a visitor can fetch them. An
 * ENS `contenthash` pointed at content no gateway serves is a dead site. With
 * one CID serving two pages, the check has to cover BOTH — a root that loads
 * while `app/` 404s is the exact failure this layout introduces.
 *
 *   pnpm --filter offchain publish:site public
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";

const API = (process.env.IPFS_API_URL ?? "").replace(/\/$/, "");
const KEY = process.env.IPFS_API_KEY ?? "";
const GATEWAYS = (process.env.IPFS_GATEWAYS ?? "https://ipfs.io/ipfs/,https://dweb.link/ipfs/").split(",");
const ATTEMPTS = 8;
const DELAY_MS = 4_000;

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: publish-site <directory>");
  if (!API) throw new Error("IPFS_API_URL not set");

  /** Depth-first walk, directories before the files they contain. */
  function walk(abs: string, rel: string, out: { rel: string; dir: boolean }[] = []) {
    for (const name of readdirSync(abs).sort()) {
      // macOS drops these next to anything a Finder window has looked at, and
      // they would go straight into the published tree.
      if (name === ".DS_Store") continue;
      const childAbs = join(abs, name);
      const childRel = rel ? posix.join(rel, name) : name;
      if (statSync(childAbs).isDirectory()) {
        out.push({ rel: childRel, dir: true });
        walk(childAbs, childRel, out);
      } else {
        out.push({ rel: childRel, dir: false });
      }
    }
    return out;
  }

  const entriesOnDisk = walk(dir, "");
  const fileCount = entriesOnDisk.filter((e) => !e.dir).length;
  if (!fileCount) throw new Error(`${dir} holds no file`);

  // Fail closed on unfilled placeholders. BRAND.md has always documented this
  // grep as the check to run before publishing anything; leaving it to a human
  // to remember is what makes it a check that gets skipped on the one day it
  // matters. A page that ANNOUNCES the token address and prints the raw slot is
  // worse than a page that says nothing about it.
  const holes = entriesOnDisk
    .filter((e) => !e.dir && /\.(html|md|json|svg|txt|js|css)$/.test(e.rel))
    .flatMap((e) => {
      const found = readFileSync(join(dir, e.rel), "utf8").match(/\{\{[A-Za-z_-]+\}\}/g) ?? [];
      return [...new Set(found)].map((h) => `${e.rel}: ${h}`);
    });
  if (holes.length) {
    throw new Error(`unfilled placeholders, refusing to publish:\n  ${holes.join("\n  ")}`);
  }

  const form = new FormData();
  for (const e of entriesOnDisk) {
    if (e.dir) {
      form.append("file", new Blob([], { type: "application/x-directory" }), e.rel);
      console.log(`  + ${e.rel}/`);
      continue;
    }
    const bytes = readFileSync(join(dir, e.rel));
    const ext = e.rel.slice(e.rel.lastIndexOf("."));
    form.append("file", new Blob([bytes], { type: TYPES[ext] ?? "application/octet-stream" }), e.rel);
    console.log(`  + ${e.rel}  ${bytes.length} B`);
  }

  const res = await fetch(`${API}/api/v0/add?cid-version=1&wrap-with-directory=true&pin=true`, {
    method: "POST",
    headers: KEY ? { Authorization: `Bearer ${KEY}` } : undefined,
    body: form,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`add ${res.status}: ${body.slice(0, 200)}`);

  // The wrapping directory is the entry with an empty name, and it is the last
  // one kubo reports. That CID is what the ENS contenthash points at.
  const entries = body.trim().split("\n").map((l) => JSON.parse(l) as { Name: string; Hash: string });
  const root = entries.find((e) => e.Name === "" || e.Name === basename(dir)) ?? entries[entries.length - 1]!;
  console.log(`\ncid: ${root.Hash}`);

  // Why the last status of each gateway is kept: a public gateway answers 429
  // when it has seen too much of you lately, and that is indistinguishable from
  // "the content is not there" unless it is printed. Failing silently here would
  // have the operator re-publish content that was already fine.
  const last: Record<string, string> = {};

  // Every page in the tree, not just the root. One CID now serves the shop
  // window AND the app, and a tree whose root loads while `app/index.html`
  // 404s is a dead app behind a live site — invisible from the root alone.
  const pages = entriesOnDisk.filter((e) => !e.dir && posix.basename(e.rel) === "index.html").map((e) => e.rel);

  for (let i = 1; i <= ATTEMPTS; i++) {
    for (const gw of GATEWAYS) {
      try {
        // **Do not compare sizes.** A public gateway is an HTTP proxy and it
        // rewrites what it hands back: ipfs.io sits behind Cloudflare, which
        // injects a hidden anti-bot anchor after `<body>` -- 291 bytes on this
        // tree, measured 2026-09-10. So the served length NEVER equals the
        // pinned length, and a size check would fail on every publish until
        // somebody learned to ignore it. A check that always cries is worse
        // than no check.
        //
        // The bytes are guaranteed by the CID itself; what a gateway can tell
        // us is the thing the CID cannot -- that a stranger's HTTP request
        // actually reaches the content. So: a 200, and a marker proving the
        // body is OUR page and not the gateway's error placeholder.
        const seen: string[] = [];
        for (const page of pages) {
          const r = await fetch(`${gw.trim()}${root.Hash}/${page}`, { signal: AbortSignal.timeout(10_000) });
          last[gw.trim()] = String(r.status);
          if (!r.ok) throw new Error(String(r.status));
          const body = await r.text();
          if (!body.includes("<title>")) throw new Error(`${page}: 200 but no <title> — not our page`);
          const title = body.slice(body.indexOf("<title>") + 7, body.indexOf("</title>")).trim();
          seen.push(`${page} "${title.slice(0, 46)}"`);
        }
        console.log(`read back from ${gw.trim()} — ${seen.join(", ")}`);
        console.log(`\ncontenthash: ipfs://${root.Hash}`);
        return;
      } catch { last[gw.trim()] ??= ""; /* gateway not warm yet, or a page missing */ }
    }
    if (i < ATTEMPTS) await sleep(DELAY_MS);
  }
  const seen = Object.entries(last).map(([g, st]) => `${g} -> ${st || "no answer"}`).join(", ");
  throw new Error(
    `pinned as ${root.Hash} but no gateway served it back (${seen || "no answer at all"}). ` +
    `A 429 is rate limiting, not absence — retry later before concluding anything. ` +
    `Do NOT point ENS at it until one gateway returns it.`,
  );
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
