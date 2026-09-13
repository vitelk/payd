import { parseAbi } from "viem";

export const distributorAbi = parseAbi([
  // errors — listed so viem decodes them BY NAME. The keeper branches on
  // `SeedUnavailable` to tell "this anchor is dead, re-anchor" apart from
  // "not ready yet", and an undecoded selector cannot be branched on.
  "error SeedUnavailable()",
  "error SeedNotReady(uint256 atBlock)",
  "error AlreadyAnchored()",
  "error NotAnchored()",
  // reads
  "function currentEpoch() view returns (uint256)",
  "function epochEnd(uint256) view returns (uint256)",
  "function EPOCH_LENGTH() view returns (uint256)",
  "function GENESIS() view returns (uint256)",
  "function MAX_BATCH() view returns (uint256)",
  "function nextEpoch() view returns (uint256)",
  "function pendingEpochs() view returns (uint256)",
  "function claimedSoFar(address, address) view returns (uint256)",
  "function totalFunded(address) view returns (uint256)",
  "function quoteFundedFor(address) view returns (uint256)",
  "function totalDistributed(address) view returns (uint256)",
  "function owedTo(address holder, address stock, uint256 cumulative) view returns (uint256)",
  "function rootCount() view returns (uint256)",
  "function activeRoot() view returns (uint256)",
  "function excludedList() view returns (address[])",
  "function exclusionLog() view returns ((address account, bool state, uint48 fromEpoch)[])",
  "function isExcluded(address) view returns (bool)",
  // This tuple must match `Distributor.Root` field for field. Dropping one
  // raises no error at all: viem simply decodes a word too early and everything
  // after it shifts by one slot. Any change to `Root` has to be mirrored here
  // AND in `front/src/chain.ts`.
  "function roots(uint256) view returns (address publisher, uint40 publishedAt, bytes32 claimRoot, bytes32 pushRoot, uint48 upToEpoch, bytes32 digest)",
  // writes
  "function publishRoot(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest, string cid)",
  // The co-signed form. Once `coSignerRequired()` answers true the single-key
  // one above reverts `NotCoSigned`, so the keeper reads that first and chooses.
  "function publishRoot(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest, string cid, bytes coSig)",
  "function coSigner() view returns (address)",
  "function coSignerRequired() view returns (bool)",
  "function coSignerHeartbeat() view returns (uint256)",
  "function CO_SIGNER_GRACE() view returns (uint256)",
  // Read rather than re-derived: two implementations of one hash is two
  // implementations of one hash, and the day they disagree the co-signer can
  // sign nothing at all.
  "function rootDigest(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest) view returns (bytes32)",
  "function heartbeat()",
  // The anti-veto: the heartbeat covers a co-signer that STOPS, this covers one
  // that refuses. Three hours after a root is put on the record it may go out on
  // one key -- that root, and no other.
  "function requestCoSignature(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest)",
  "function coSignatureLapsed(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest) view returns (bool)",
  "function coSignatureRequestedAt(bytes32) view returns (uint256)",
  // The co-signer shutting the same door for one root. Without it the record is
  // a three-hour path to theft for a compromised keeper, against the 48 h a
  // rotation takes.
  "function rejectCoSignature(bytes32 rootKey)",
  "event CoSignatureRejected(bytes32 indexed rootKey, address indexed by)",
  "event CoSignatureRequested(bytes32 indexed rootKey, uint256 upToEpoch, uint256 at)",
  "event RootPublished(uint256 indexed rootId, address indexed publisher, bytes32 claimRoot, bytes32 pushRoot, uint256 upToEpoch, bytes32 digest, string cid)",
  "function keeper() view returns (address)",
  "function FEE_VAULT() view returns (address)",
  "function quoteAtRisk() view returns (uint256)",
  // Read by `check.ts` to turn `quoteAtRisk` into a RATIO. The absolute number
  // means nothing on its own — a big vault's honest one window is a small
  // vault's disaster — and the bound §S29 publishes is expressed in windows.
  "event WindowFunded(uint256 indexed fromEpoch, uint256 indexed toEpoch, address[] stocks, uint256[] amounts, uint256[] quoteSpent)",
  "function distribute(address account, address[] stocks, uint256[] cumulative, bytes32[][] proofs) returns (uint256)",
]);

export const feeVaultAbi = parseAbi([
  "function harvest() returns (uint256)",
  "function MIN_BUY() view returns (uint256)",
  "function pivotReserve() view returns (uint256)",
  // The quote that bought `pivotReserve`, carried with it (T-RISK-01). Read by
  // `check.ts` to report how far the refund ceiling has drifted from the rate
  // the stock in hand was actually bought at (T2-REFUND-01).
  "function reserveQuote() view returns (uint256)",
  "function buyBasket(uint256[] minOuts) returns (uint256)",
  "function payCreator() returns (uint256)",
  "function payPlatform() returns (uint256)",
  "function fundRewards() payable returns (uint256)",
  "function pendingTotal() view returns (uint256)",
  "function rewardsPool() view returns (uint256)",
  "function creatorPool() view returns (uint256)",
  "function platformPool() view returns (uint256)",
  "function rewardsBps() view returns (uint256)",
  "function hookStatus() view returns (uint8 status, address current, uint64 effectiveAt)",
  "function hookLostAt() view returns (uint64)",
  "function flagHookLost()",
  "function economics() view returns (uint256 taxBps, uint256 curveFeeBps, uint256 ponsShareBps, uint256 grossOfVolumeBps, uint256 rewardsOfVolumeBps, uint256 creatorOfVolumeBps, uint256 platformOfVolumeBps)",
  "function PLATFORM_BPS() view returns (uint256)",
  "function CREATOR() view returns (address)",
  "function PLATFORM() view returns (address)",
  "function payoutBps() view returns (uint256)",
  "function MAX_REFUND() view returns (uint256)",
  "function getAllocations() view returns ((address stock, uint24 poolFee, uint16 bps, address feed)[])",
  "function token() view returns (address)",
  "function DISTRIBUTOR() view returns (address)",
  "function QUOTE() view returns (address)",
  "function QUOTE_FEE() view returns (uint24)",
  "function QUOTE_WETH_FEE() view returns (uint24)",
  "function ETH_PIVOT_FEE() view returns (uint24)",
  "function TWAP_WINDOW() view returns (uint32)",
  "function MIN_BUY_QUOTE() view returns (uint256)",
]);

export const escrowAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** Any third-party token. Same shape as `escrowAbi` and named separately on
 *  purpose: reading a stock token through something called "escrow" is the
 *  class of misleading name this codebase has paid for five times. */
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96After, uint32[] initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Uniswap v3, read-only: what a leg's pool can absorb. Mirrors
 *  `IUniswapV3Factory` / `IUniswapV3PoolObserver` in contracts/interfaces and
 *  `IV3PoolLiquidity` in contracts/Payd.sol. */
export const v3FactoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
export const v3PoolAbi = parseAbi([
  "function liquidity() view returns (uint128)",
  // The ring, and the remedy. `increaseObservationCardinalityNext` is
  // PERMISSIONLESS: anyone can grow another pool's history for gas, which is
  // why a route whose window has shrunk is a transaction to send and not a row
  // to delist (T-HYP-02).
  "function observations(uint256) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
  "function increaseObservationCardinalityNext(uint16 next)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/** The timelock, read-only. Everything it can do is announced by
 *  `CallScheduled` one full delay ahead, and that announcement is the whole of
 *  the defence -- see `contracts/interfaces/IExternal.sol`. */
export const timelockAbi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
  "function getMinDelay() view returns (uint256)",
]);

export const arbGasInfoAbi = parseAbi(["function getL1BaseFeeEstimate() view returns (uint256)"]);

/// @notice The Payd, from the keeper's side: the registry it walks and the
///         one question `migrate` asks of it.
export const registryAbi = parseAbi([
  "function vaults() view returns (address[])",
  "function vaultCount() view returns (uint256)",
  "function isVault(address) view returns (bool)",
  "function PLATFORM() view returns (address)",
]);

/**
 * The platform's till. **Every function here is permissionless and none of them
 * refunds gas** — deliberately, per `Treasury.sol`: "the platform has every
 * reason to call them itself". Which is true, and was also the reason nobody
 * had written the code that calls them.
 */
export const treasuryAbi = parseAbi([
  "function devPool() view returns (uint256)",
  "function burnPool() view returns (uint256)",
  "function lpPool() view returns (uint256)",
  "function rewardsPool() view returns (uint256)",
  "function devBps() view returns (uint256)",
  "function burnBps() view returns (uint256)",
  "function lpBps() view returns (uint256)",
  "function rewardsBps() view returns (uint256)",
  "function MIN_MOVE() view returns (uint256)",
  "function BURN_COOLDOWN() view returns (uint256)",
  "function lastBurnAt() view returns (uint256)",
  "function platformVault() view returns (address)",
  "function migratedTo() view returns (address)",
  "function sweepFee(address) view returns (uint24)",
  "function sweepPivotFee(address) view returns (uint24)",
  "function split() returns (uint256)",
  "function payDev() returns (uint256)",
  "function buyAndBurn() returns (uint256)",
  "function addLiquidity() returns (uint256, uint256)",
  "function fundPlatformRewards() returns (uint256)",
  "function sweepToEth(address, uint256) returns (uint256)",
]);
