/** Structural snapshot exclusions. `pnpm --filter offchain test` */
import assert from "node:assert/strict";
import { getAddress, type Address } from "viem";
import { structuralExclusions } from "./snapshot.js";
import { POOL_MANAGER } from "./config.js";

const TOKEN = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const CURVE = "0x4461871aFcdf789Ef0016Af0519266116F5106bC" as Address;
const DISTRIBUTOR = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const VAULT = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" as Address;

const set = structuralExclusions({
  token: TOKEN, curve: CURVE, distributor: DISTRIBUTOR, creatorFeeRecipient: VAULT,
});

// 1. The five that were always there, plus the two that were not.
assert.equal(set.size, 7, "the structural set is exactly seven addresses");
for (const a of [TOKEN, CURVE, DISTRIBUTOR, VAULT]) {
  assert.ok(set.has(getAddress(a) as Address), `${a} must be excluded`);
}
assert.ok(set.has(getAddress("0x0000000000000000000000000000000000000000") as Address), "address 0");

// 2. The PoolManager. Uniswap v4 is a singleton, so after graduation it holds
//    the whole pool's balance: left in, it is the largest holder of every
//    graduated token and takes the largest share of every distribution.
assert.ok(set.has(getAddress(POOL_MANAGER) as Address), "the v4 PoolManager must be excluded");

// 3. `0xdead`. A standard ERC-20 refuses `address(0)`, so a burn lands here —
//    and a burnt balance that keeps earning pays nobody, for ever.
assert.ok(set.has(getAddress("0x000000000000000000000000000000000000dead") as Address), "0xdead");

// 4. The membership test runs against addresses the snapshot builds with
//    `getAddress`, so every entry must be in that same checksummed form. A
//    lowercase entry would silently never match a holder.
for (const a of set) assert.equal(a, getAddress(a), `${a} is not checksummed`);

// 5. And it excludes nothing else — an ordinary holder stays in the tree.
assert.ok(!set.has(getAddress("0x6903afeE2E2EdFeF12Ea2b649926549A1BdAD1a4") as Address), "a holder");

console.log("exclusions: 5 checks passed");
