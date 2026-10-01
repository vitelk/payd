/**
 * rpcstub.ts — the one thing every test stub needs now that reads are batched.
 *
 * **Test support, not production code.** Nothing under `keeper`, `cosign` or
 * `snapshot` imports it.
 *
 * Since `config.ts` declares `contracts.multicall3` and the clients set
 * `batch: { multicall }`, a stub that only understands a bare `eth_call` sees
 * every read arrive as `aggregate3` calldata addressed to Multicall3 and
 * answers none of them — which reads as "the contract reverted" and is not one.
 * Three stubs needed the same unwrapping; this is it, written once.
 */
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from "viem";

/** The address Multicall3 has on every chain that has one. */
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

const aggregateAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/**
 * Multicall3's own views, which viem folds into the batch alongside ours.
 *
 * `getBalance` is the one that matters: with batching on, viem does not send
 * `eth_getBalance` at all, it appends `getEthBalance(address)` to the aggregate
 * — so a balance read costs nothing on top of a batch that was going out
 * anyway. A stub that does not answer it fails the whole round with "execution
 * reverted for an unknown reason", which names nothing and is how this was
 * found.
 *
 * Zero is the answer, because a stub asserting on cadence has no balances. A
 * test that needs one special-cases it before calling in.
 */
const SELF_VIEWS: Record<string, Hex> = {
  "0x4d2301cc": ("0x" + "00".repeat(32)) as Hex, // getEthBalance(address)
  "0x0f28c97d": ("0x" + "00".repeat(32)) as Hex, // getCurrentBlockTimestamp()
  "0x42cbb15c": ("0x" + "00".repeat(32)) as Hex, // getBlockNumber()
};

/**
 * Answers one `eth_call`, unwrapping Multicall3 when that is what it is.
 *
 * `answer` is the stub's own single-read answer: it returns ABI-encoded return
 * data, or THROWS to mean "this one reverts". Inside an `aggregate3` a throw
 * becomes one failed entry rather than a failed batch, which is what the real
 * contract does with `allowFailure` — and what keeps a per-call `try` in the
 * code under test behaving the way it does against a real node.
 */
export function answerEthCall(
  to: string,
  data: Hex,
  answer: (to: string, data: Hex) => Hex,
): Hex {
  if (to.toLowerCase() !== MULTICALL3) return answer(to, data);

  const { args } = decodeFunctionData({ abi: aggregateAbi, data });
  const calls = args![0] as readonly { target: Address; callData: Hex }[];
  const out = calls.map((c) => {
    const target = c.target.toLowerCase();
    const self = target === MULTICALL3 ? SELF_VIEWS[c.callData.slice(0, 10)] : undefined;
    if (self) return { success: true, returnData: self };
    try {
      return { success: true, returnData: answer(target, c.callData) };
    } catch {
      return { success: false, returnData: "0x" as Hex };
    }
  });
  return encodeFunctionResult({ abi: aggregateAbi, functionName: "aggregate3", result: out } as never);
}
