/** The guards `prepare.ts` must hold before anything is simulated — no network. */
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { prepareCreateVault, prepareLaunch } from "./prepare.js";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const ZERO = "0x0000000000000000000000000000000000000000";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";

/** A client answering reads by function name; anything else is a test failure. */
const stub = (reads: Record<string, unknown>) => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (!(functionName in reads)) throw new Error(`unexpected read: ${functionName}`);
    return reads[functionName];
  },
  simulateContract: async () => { throw new Error("must not simulate"); },
}) as unknown as PublicClient;

// The launch is refused BEFORE anything is built when `from` is not LAUNCHER:
// signed by anyone else it binds to nothing and Pons keeps the launch fee.
const vault = stub({ isVault: true, LAUNCHER: A, token: ZERO, QUOTE: ZERO });
await assert.rejects(
  prepareLaunch(vault, { from: B, vault: A, name: "T", symbol: "T", creatorTaxBps: 100 }),
  /must be launched from its LAUNCHER/,
);
await assert.rejects(
  prepareLaunch(stub({ isVault: true, LAUNCHER: A, token: B, QUOTE: ZERO }), { from: A, vault: A, name: "T", symbol: "T", creatorTaxBps: 100 }),
  /already bound/,
);
await assert.rejects(
  prepareLaunch(stub({ isVault: false }), { from: A, vault: A, name: "T", symbol: "T", creatorTaxBps: 100 }),
  /not a vault the Payd registry built/,
);

// The basket rules are the app's, read before any listing.
const reg = stub({ platformBps: 1000n });
await assert.rejects(prepareCreateVault(reg, { from: A, basket: [{ stock: NVDA, bps: 10_000 }], rewardsBps: 9000, epochMinutes: 30 }), /at least 2/);
await assert.rejects(prepareCreateVault(reg, { from: A, basket: [{ stock: NVDA, bps: 5000 }, { stock: TSLA, bps: 4000 }], rewardsBps: 9000, epochMinutes: 30 }), /add up to/);
await assert.rejects(prepareCreateVault(reg, { from: A, basket: [{ stock: NVDA, bps: 5000 }, { stock: NVDA, bps: 5000 }], rewardsBps: 9000, epochMinutes: 30 }), /twice/);

// An unlisted stock is named, not left to a revert.
const unlisted = stub({ platformBps: 1000n, listing: [0, ZERO, false] });
await assert.rejects(prepareCreateVault(unlisted, { from: A, basket: [{ stock: NVDA, bps: 5000 }, { stock: TSLA, bps: 5000 }], rewardsBps: 9000, epochMinutes: 30 }), /not a listed stock/);

console.log("payd mcp prepare: ok");
