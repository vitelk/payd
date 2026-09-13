/**
 * watch.ts — the selectors it recognises, recomputed rather than trusted.
 *
 * **This file exists because the first draft of that table was hand-written and
 * three of its entries were wrong.** A wrong selector there does not fail: it
 * prints "unrecognised selector" for the call it was meant to name, once, in a
 * log nobody re-reads — which is the exact failure mode the watcher exists to
 * prevent, reproduced inside the watcher.
 *
 * The three governance selectors are pinned against their known values as well
 * as recomputed, because those are the calls that end the protocol's ability to
 * warn anyone at all: a new proposer, the Safe removed, the delay set to zero.
 */
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { WATCHED, GOVERNANCE, watchSelectors } from "./watch.js";

let checks = 0;
function ok(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checks++;
}

const sels = watchSelectors();

// 1. Every entry is derived from its signature, and no two collide.
{
  ok(sels.size === Object.keys(WATCHED).length, "every signature yields a distinct selector");
  for (const sig of Object.keys(WATCHED)) {
    ok(sels.has(toFunctionSelector(sig)), `${sig} is in the table under its real selector`);
  }
}

// 2. The three that end the warning, pinned against their known values. These
//    come from OpenZeppelin's AccessControl and TimelockController and do not
//    move; if one of these assertions fails, the ABI string was edited.
{
  ok(toFunctionSelector("grantRole(bytes32,address)") === "0x2f2ff15d", "grantRole");
  ok(toFunctionSelector("revokeRole(bytes32,address)") === "0xd547741f", "revokeRole");
  ok(toFunctionSelector("updateDelay(uint256)") === "0x64d62353", "updateDelay");
}

// 3. And they are the ones flagged as governance — the difference decides
//    whether the watcher adds the "that window is all there is" line.
{
  ok(GOVERNANCE.size === 3, "three, and only three, change who governs");
  for (const sig of GOVERNANCE) {
    ok(sels.get(toFunctionSelector(sig))!.governance, `${sig} is flagged as governance`);
  }
  ok(!sels.get(toFunctionSelector("setSplit(uint256,uint256,uint256,uint256)"))!.governance,
    "a configuration change is watched but is not a change of governance");
}

// 4. The doors FLOWS.md 7 names are all present. A door missing from this table
//    is a door nobody is told about.
{
  for (const sig of ["setFactory(address)", "bindPlatform(address,address)", "migrateTreasury(address)"]) {
    ok(sels.has(toFunctionSelector(sig)), `${sig} -- a FLOWS.md 7 door -- is watched`);
  }
}

console.log(`watch: ${checks} checks OK`);
