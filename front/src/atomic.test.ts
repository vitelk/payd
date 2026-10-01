/**
 * The one-transaction launch, held to the two things that can lose a creator
 * their fee stream: a wrong predicted vault, and a batch that is allowed to
 * stop halfway.
 *
 * The vault fixture is not invented. It is what `test/OneTx.t.sol`
 * (`test_ThePredictedVaultAddressFromTheFactoryNonce`) read on the live chain:
 * the enabled mode factory at nonce 3 produced exactly this pair. If viem's
 * CREATE arithmetic and Bootstrap's ever disagree, this is where it shows.
 */
import assert from "node:assert/strict";
import { predictPair, readAtomic, canBatch, acceptsValue, oneShotCalls, readStatus, CHAIN_KEY } from "./atomic.js";

const FACTORY = "0x4C1c21285d79e036AeFC8e609D7aBf06DA88d70C" as const;

{
  // Measured on chain 4663, block ~74 153 548.
  const { vault, distributor } = predictPair(FACTORY, 3n);
  assert.equal(vault, "0x932105fFd96713C7D85d4B68f14F693737AE7496", "vault prediction drifted from the fork measurement");
  assert.equal(distributor, "0xCf9dC1EDDe197dd1dfb750A0921610024D69F23c", "distributor prediction drifted");
  console.log("ok  the predicted pair matches what the chain produced");
}

{
  // The two are NOT interchangeable: swapping Bootstrap's nonces gives two
  // addresses that both exist and are both wrong, which is the failure a
  // simple "does it look like an address" test would pass.
  const a = predictPair(FACTORY, 3n);
  assert.notEqual(a.vault, a.distributor);
  // And the nonce genuinely moves it — this is the race atomicity covers.
  assert.notEqual(predictPair(FACTORY, 4n).vault, a.vault, "the prediction ignores the factory's nonce");
  console.log("ok  the nonce is in the prediction, so the race is real");
}

{
  assert.equal(readAtomic({ [CHAIN_KEY]: { atomic: { status: "supported" } } }), "supported");
  assert.equal(readAtomic({ [CHAIN_KEY]: { atomic: { status: "ready" } } }), "ready");
  assert.equal(readAtomic({ [CHAIN_KEY]: { atomic: { status: "unsupported" } } }), "unsupported");
  // The earlier draft's shape, still served by deployed wallets.
  assert.equal(readAtomic({ [CHAIN_KEY]: { atomicBatch: { supported: true } } }), "supported");
  console.log("ok  both capability shapes are read");
}

{
  // Everything unknown is a no. A wallet that cannot say is not one we bet a
  // launch fee on, because the fee is unrefundable and `creatorFeeRecipient`
  // takes three days and the recipient's consent to move.
  assert.equal(readAtomic(undefined), "unsupported");
  assert.equal(readAtomic(null), "unsupported");
  assert.equal(readAtomic({}), "unsupported");
  assert.equal(readAtomic({ "0x1": { atomic: { status: "supported" } } }), "unsupported", "another chain's answer was accepted");
  assert.equal(readAtomic({ [CHAIN_KEY]: {} }), "unsupported");
  assert.equal(readAtomic({ [CHAIN_KEY]: { atomic: {} } }), "unsupported");
  assert.equal(readAtomic({ [CHAIN_KEY]: { atomicBatch: { supported: false } } }), "unsupported");
  console.log("ok  anything we cannot read is a refusal, not a guess");
}

{
  // Wallets are inconsistent about the case of the hex key.
  assert.equal(readAtomic({ "0X1237": { atomic: { status: "supported" } } }), "supported");
  console.log("ok  the chain key is matched case-insensitively");
}

{
  assert.equal(canBatch("supported"), true);
  assert.equal(canBatch("ready"), true);
  assert.equal(canBatch("unsupported"), false);
  console.log("ok  only a guaranteed-atomic wallet may batch");
}

{
  const node = (code: string, callThrows?: unknown) => ({
    request: async (a: { method: string }) => {
      if (a.method === "eth_getCode") return code;
      if (a.method === "eth_call") {
        if (callThrows) throw callThrows;
        return "0x";
      }
      throw new Error("unexpected " + a.method);
    },
  });
  const A = "0x000000000000000000000000000000000000dEaD" as const;

  // A plain EOA is payable by definition and is never probed.
  assert.equal(await acceptsValue(node("0x"), A), "yes");
  // A delegated wallet whose implementation takes the transfer.
  assert.equal(await acceptsValue(node("0xef0100" + "11".repeat(20)), A), "yes");
  // One that reverts on it — the case that strands the creator's residue.
  assert.equal(
    await acceptsValue(node("0xef0100" + "11".repeat(20), new Error("execution reverted")), A),
    "no",
  );
  // A node that will not simulate is NOT a refusal. Reporting it as one would
  // block a launch on a transport failure.
  assert.equal(await acceptsValue(node("0xef0100" + "11".repeat(20), new Error("rate limited")), A), "unknown");
  assert.equal(
    await acceptsValue(node("0xef0100" + "11".repeat(20), new Error("insufficient funds for transfer")), A),
    "unknown",
  );
  console.log("ok  a delegate that refuses value is caught, and only it");
}

{
  const calls = oneShotCalls({
    registry: "0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03",
    createData: "0xaaaa",
    pons: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    launchData: "0xbbbb",
    launchValue: 500_000_000_000_000n,
    vault: "0x932105fFd96713C7D85d4B68f14F693737AE7496",
    bindData: "0xcccc",
  });
  // The ORDER is the whole test. `bind` needs the token the launch creates, and
  // the launch names the vault the create builds: any other order reverts, and
  // in a non-atomic batch a reverting `bind` leaves a launch pointed at a vault
  // that never learns it exists.
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.data, "0xaaaa", "create must come first");
  assert.equal(calls[1]!.data, "0xbbbb", "the launch must come second");
  assert.equal(calls[2]!.data, "0xcccc", "bind must come last");
  // And the fee travels on the launch, nowhere else.
  assert.equal(calls[0]!.value, undefined);
  assert.equal(calls[1]!.value, "0x1c6bf52634000");
  assert.equal(calls[2]!.value, undefined);
  assert.equal(BigInt(calls[1]!.value!), 500_000_000_000_000n);
  console.log("ok  the three calls are ordered, and only the launch carries value");
}

{
  assert.equal(readStatus(100), "pending");
  assert.equal(readStatus(200), "confirmed");
  assert.equal(readStatus(400), "failed");
  assert.equal(readStatus(500), "failed");
  assert.equal(readStatus(600), "failed");
  // A status we cannot read is NOT a success. Telling a creator their launch
  // went through when we do not know is the one lie this screen must not tell.
  assert.equal(readStatus(undefined), "pending");
  assert.equal(readStatus("banana"), "pending");
  console.log("ok  an unreadable batch status is never reported as confirmed");
}

console.log("atomic.test.ts — all green");
