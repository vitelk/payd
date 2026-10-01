/**
 * How the app CHOOSES a wallet — the one question `provider()` answers, and
 * the one every signature in this app depends on.
 *
 * Two ways in, and the menu has to offer both without breaking the case that
 * has always worked:
 *   - EIP-6963, where every installed extension announces itself and the
 *     visitor picks one, instead of whichever of them overwrote
 *     `window.ethereum` last;
 *   - WalletConnect, which is one more row in that same menu and appears only
 *     when `WC_PROJECT_ID` is set.
 *
 * Nothing here opens a session: the WalletConnect row is checked for being
 * OFFERED, not for being run — running it fetches a library and opens a relay
 * socket, neither of which belongs in a test.
 *
 * TWO PROCESSES, and that is the point of the argument. `WC_PROJECT_ID` is
 * read from the query string once, when `config.ts` is imported, so "the id is
 * set" and "the id is empty" cannot both be true in one run — and "empty" is
 * the state this repository actually ships until one is registered. The parent
 * run checks that world, then re-runs itself with `wc` for the other.
 * Within a run, `?v=` gives `chain.ts` a fresh instance: it collects its
 * announcements at import, so each world needs its own.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

type Eth1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** A window that can carry listeners, which node's global cannot. */
function fakeWindow(injected?: Eth1193) {
  const w = new EventTarget() as EventTarget & { ethereum?: Eth1193 };
  if (injected) w.ethereum = injected;
  (globalThis as { window?: unknown }).window = w;
  return w;
}

const eth = (tag: string): Eth1193 => ({ request: async () => tag });

/** A FRESH instance of `chain.ts`, which is what each world below needs: the
 *  module collects its announcements once, at import. `?v=` is the only thing
 *  node's module cache keys on, and building the specifier at runtime is what
 *  stops `tsc` trying to resolve a path that has no file — `typeof import`
 *  gives the result its types back. */
const freshChain = (v: number): Promise<typeof import("./chain.js")> =>
  import(`${"./chain.js"}?v=${v}`);

/** What a wallet extension does: answer the request dispatched at import.
 *  Announcing twice is also what they do — on page load and again on request —
 *  and the second announcement must not become a second row. */
function announce(w: EventTarget, rows: Array<[string, string, Eth1193]>) {
  w.addEventListener("eip6963:requestProvider", () => {
    for (const [rdns, name, p] of rows) {
      w.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: { info: { uuid: `u-${Math.random()}`, name, icon: "data:,", rdns }, provider: p },
      }));
    }
  });
}

const rabby = eth("rabby");
const metamask = eth("metamask");

if (process.argv[2] === "wc") {
  // --- WalletConnect configured, and two extensions beside it -------------
  (globalThis as { location?: unknown }).location = new URL("http://localhost/?wc=test-project");
  const w = fakeWindow();
  announce(w, [["io.rabby", "Rabby", rabby], ["io.metamask", "MetaMask", metamask],
               ["io.rabby", "Rabby", rabby]]);

  const { walletOptions, provider, useWallet, disconnect } = await import("./chain.js");
  assert.deepEqual(walletOptions().map((o) => o.name), ["Rabby", "MetaMask", "WalletConnect"],
    "two announced wallets, deduplicated by rdns, and the third party offered LAST");

  // Nothing picked yet and nothing injected: the first announcement stands in,
  // so a page whose menu was never opened still has something to sign with.
  assert.equal(await provider()!.request({ method: "x" }), "rabby");

  // The pick is what every later signature reads back — the launch form, the
  // bind and the claim all reach their wallet through this one function, and
  // none of them is on screen when the choice is made.
  useWallet(metamask);
  assert.equal(await provider()!.request({ method: "x" }), "metamask");

  // --- disconnecting ------------------------------------------------------
  //
  // Two halves, and the test is that BOTH run. The session has to be ended on
  // the relay, or `EthereumProvider.init` restores it from localStorage on the
  // next visit and the Disconnect is undone by a reload. And the pick has to
  // be dropped here, or `provider()` goes on naming a wallet the visitor asked
  // to leave.
  let ended = 0;
  const session = { request: async () => "session", disconnect: async () => { ended += 1; } };
  useWallet(session);
  await disconnect();
  assert.equal(ended, 1, "a WalletConnect session is ended on the relay, not just forgotten here");
  // Nothing injected and no pick: back to the first announcement, which is
  // what a visitor who never opened the menu gets.
  assert.equal(await provider()!.request({ method: "x" }), "rabby");

  // A wallet with nothing to end — every extension — is forgotten all the
  // same, and the missing method is not an error.
  useWallet(metamask);
  await disconnect();
  assert.equal(await provider()!.request({ method: "x" }), "rabby");

  // A session the other side already closed: `disconnect` throwing is the
  // ordinary case, not a failure to report, and the local half still happened.
  const dead = { request: async () => "gone", disconnect: async () => { throw new Error("no session"); } };
  useWallet(dead);
  await disconnect();
  assert.equal(await provider()!.request({ method: "x" }), "rabby");

  console.log("wallet.test.ts ok (walletconnect configured)");
} else {
  (globalThis as { location?: unknown }).location = new URL("http://localhost/");

  // --- 1. nobody announces: the injected slot is still the whole story ----
  //
  // Announcing is younger than injecting. An older extension, and the in-app
  // browser of every phone wallet, fill `window.ethereum` and say nothing —
  // and they were the ONLY way into this app before the menu existed.
  {
    const injected = eth("injected");
    fakeWindow(injected);
    const { walletOptions, provider } = await import("./chain.js");
    assert.deepEqual(walletOptions().map((o) => o.name), ["Browser wallet"],
      "no announcement and no project id: one row, and no third party offered");
    assert.equal(await provider()!.request({ method: "x" }), "injected");
    assert.equal(await (await walletOptions()[0]!.open()).request({ method: "x" }), "injected");
  }

  // --- 2. extensions announce, no id: still no WalletConnect row ----------
  {
    const w = fakeWindow();
    announce(w, [["io.rabby", "Rabby", rabby], ["io.metamask", "MetaMask", metamask]]);
    const { walletOptions } = await freshChain(2);
    assert.deepEqual(walletOptions().map((o) => o.name), ["Rabby", "MetaMask"],
      "an unconfigured WalletConnect is not a row the visitor can click into a failure");
  }

  // --- 3. no wallet at all -----------------------------------------------
  {
    fakeWindow();
    const { walletOptions, provider } = await freshChain(3);
    assert.deepEqual(walletOptions(), [], "nothing to offer, and the button says so");
    assert.equal(provider(), null);
  }

  console.log("wallet.test.ts ok (no project id)");
  // `--import tsx` because the child is handed a .ts file and a bare node
  // cannot read one: the loader is what the parent was started with, and it
  // does not survive into `execFileSync`.
  execFileSync(process.execPath, ["--import", "tsx", process.argv[1]!, "wc"], { stdio: "inherit" });
}
