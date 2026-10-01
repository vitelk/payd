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
  // On a portfolio vault this is the `PortfolioBook`, not the platform
  // timelock — the mode's whole shape in one read (`contracts/portfolio/`).
  "function TIMELOCK() view returns (address)",
  "function QUOTE() view returns (address)",
  "function QUOTE_FEE() view returns (uint24)",
  "function QUOTE_WETH_FEE() view returns (uint24)",
  "function ETH_PIVOT_FEE() view returns (uint24)",
  "function TWAP_WINDOW() view returns (uint32)",
  "function MIN_BUY_QUOTE() view returns (uint256)",
  // Which registry stamped it — hence, through `modeOf`, which payout rule
  // builds its roots. Read from the VAULT and not from configuration, so
  // `dispute.ts` can be pointed at any vault and still reach the right rule.
  "function REGISTRY() view returns (address)",
  // What a failed payment to us fell back into, and where the stream went if
  // this vault has been retired. Both read by `stepTreasury`.
  "function pendingWithdrawal(address) view returns (uint256)",
  "function migratedTo() view returns (address)",
]);

export const escrowAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * `PonsV2LaunchFactory.locker()` — the one address every Pons launch parks its
 * locked supply at. A SINGLETON, not one per token: it holds 81,632,653 of
 * $PAYD and the same figure of BOOMER, NOVAAI, ZZZ and every other launch.
 */
export const ponsFactoryAbi = parseAbi(["function locker() view returns (address)"]);

/**
 * `PonsV2LaunchLocker`. One shared contract, state keyed BY TOKEN —
 * `isLocked(token)` is what says a given launch's supply is parked here, and it
 * is the only way to tell that `factory.locker()` still answers for OUR token
 * rather than for whatever Pons points at today.
 */
export const ponsLockerAbi = parseAbi(["function isLocked(address) view returns (bool)"]);
/** Any third-party token. Same shape as `escrowAbi` and named separately on
 *  purpose: reading a stock token through something called "escrow" is the
 *  class of misleading name this codebase has paid for five times. */
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  // The portfolio planner's per-line floor is denominated in the PIVOT, so it
  // needs the pivot's scale once per vault. Write-once state: cached.
  "function decimals() view returns (uint8)",
]);

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
  "function listing(address) view returns (uint24 poolFee, address feed, bool allowed)",
  "function vaults() view returns (address[])",
  "function vaultCount() view returns (uint256)",
  "function isVault(address) view returns (bool)",
  "function modeOf(address) view returns (bytes32)",
  "function PLATFORM() view returns (address)",
]);

/**
 * The backing mode's second contract. The keeper owes it nothing — every
 * function is permissionless and self-interested — except the sweep, which
 * nobody else has a reason to call.
 */
export const backingRedeemerAbi = parseAbi([
  "function sweepToVault() returns (uint256)",
  // Reads, for `check.ts`: this mode has no root and no frontier, so what the
  // pot holds IS the health report. `redeemPreview` is what a front end shows
  // a holder before they burn; it is here so one file declares the shape.
  "function allStocks() view returns (address[])",
  "function redeemPreview(uint256 amount) view returns (address[] stocks, uint256[] outs)",
  "function redeem(uint256 amount, uint256[] minOuts) returns (uint256)",
  "function collectStock(address stock) returns (uint256)",
  "function currentEpoch() view returns (uint256)",
]);

/**
 * The lottery mode's second contract. **Two calls a cycle and they are not the
 * same kind of call**: `publishDraw` is the keeper's, gated by the pinned key
 * and the co-signer exactly as a distribution root is; `settleDraw` is
 * anybody's, and the keeper only relays it because nobody else is watching.
 *
 * `draws` is the generated getter for the `Draw` struct, so its members come
 * back flattened and IN DECLARATION ORDER — `upToEpoch` is index 3, which is
 * what `drawScope` reads. Adding a member to the struct above it moves that
 * index, and nothing here would say so.
 */
/**
 * The personal-portfolio mode's two extra shapes.
 *
 * `PortfolioBook` is a register: it holds no money, has no privileged function
 * and the timelock never touches it. `linesOf` falls back to the creator's
 * default basket for a holder who has declared nothing, which is every holder
 * on day one — so it is the mode's normal answer and not its fallback.
 *
 * `book`, `distributeInto`, `pending` and `collect` live on the Distributor:
 * it is a `DistributorV3` in every other respect, so the root, the proofs and
 * `claimedSoFar` come from `distributorAbi` unchanged.
 */
export const portfolioBookAbi = parseAbi([
  "function linesOf(address holder) view returns ((address stock, uint16 bps)[])",
  "function defaultBasket() view returns ((address stock, uint16 bps)[])",
  "function weightOf(address holder, address stock) view returns (uint256)",
  "function vault() view returns (address)",
  "function setPortfolio((address stock, uint16 bps)[] lines)",
  "function clearPortfolio()",
  // On the DISTRIBUTOR, not the book — but declared here because it is the one
  // read that leads to the book, and a caller wanting the book has the
  // Distributor in hand.
  "function book() view returns (address)",
  "event PortfolioSet(address indexed holder, (address stock, uint16 bps)[] lines)",
]);

/** The portfolio mode's vault. `payout()` stands where `buyBasket` does. */
export const portfolioVaultAbi = parseAbi([
  // The registry, for the planner's delisting check. Write-once at `init`.
  "function REGISTRY() view returns (address)",
  "function payout() returns (uint256)",
  "function PIVOT() view returns (address)",
  "function payoutBps() view returns (uint256)",
  "function rewardsPool() view returns (uint256)",
]);

export const portfolioDistributorAbi = parseAbi([
  "function distributeInto(address stock, address[] accounts, uint256[] cumulative, bytes32[][] proofs, uint256 minOut) returns (uint256)",
  "function collect(address holder, address stock) returns (uint256)",
  "function pending(address holder, address stock) view returns (uint256)",
  "function convertedInto(address holder, address stock) view returns (uint256)",
  "function book() view returns (address)",
  "event ConvertedInto(address indexed stock, uint256 pivotIn, uint256 out, uint256 holders)",
  "event Pending(address indexed holder, address indexed stock, uint256 amount)",
]);

export const lotteryDistributorAbi = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function epochEnd(uint256) view returns (uint256)",
  "function pendingEpochs() view returns (uint256)",
  "function currentRound() view returns (uint64)",
  "function drawCount() view returns (uint256)",
  "function draws(uint256) view returns (bytes32 root, uint128 totalTickets, uint64 targetRound, uint48 upToEpoch, uint8 status, bytes32 digest, uint256 winningTicket, address publisher, uint40 publishedAt, uint40 settledAt, address winner)",
  "function prizeNow(address stock) view returns (uint256)",
  "function POT_BPS() view returns (uint256)",
  "function keeper() view returns (address)",
  "function coSigner() view returns (address)",
  "function coSignerRequired() view returns (bool)",
  "function drawDigest(uint256 upToEpoch, bytes32 root, uint128 totalTickets, uint64 targetRound, bytes32 digest) view returns (bytes32)",
  "function coSignatureLapsed(uint256 upToEpoch, bytes32 root, uint128 totalTickets, uint64 targetRound, bytes32 digest) view returns (bool)",
  "function requestCoSignature(uint256 upToEpoch, bytes32 root, uint128 totalTickets, uint64 targetRound, bytes32 digest)",
  "function publishDraw(uint256 upToEpoch, bytes32 root, uint128 totalTickets, uint64 targetRound, bytes32 digest, string cid)",
  "function publishDraw(uint256 upToEpoch, bytes32 root, uint128 totalTickets, uint64 targetRound, bytes32 digest, string cid, bytes coSig)",
  "function settleDraw(uint256 drawId, (bytes32 x_a, bytes32 x_b, bytes32 y_a, bytes32 y_b) signature)",
  "function collect(uint256 drawId, address holder, uint256 ticketStart, uint256 ticketEnd, bytes32[] proof, address[] stocks) returns (uint256)",
  "function withdraw() returns (uint256)",
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
  // The three nobody was calling either. `collectFrom` recovers a payment a
  // vault could not hand over, `followMigration` re-points the rewards pocket
  // at a migrated platform vault, `pushAll` empties a Treasury that has itself
  // migrated -- the only function left alive on one.
  "function collectFrom(address) returns (uint256)",
  "function followMigration() returns (address)",
  "function pushAll(address) returns (uint256)",
]);
