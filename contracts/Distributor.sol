// SPDX-License-Identifier: MIT
//
//         ○   ○
//          ╲ ╱               P A Y D
//         ╭─┴─╮
//        ╱     ╲             Creator fees buy tokenised equities for a token's holders.
//       │       │            No staking, no sign-up, nothing to approve.
//        ╲_____╱             paydprotocol.eth  ·  https://paydprotocol.eth.limo  ·  x.com/PaydRH
//
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IExternal.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title  Distributor
/// @notice Receives the stocks from FeeVault and distributes them to holders,
///         based on **cumulative** Merkle roots published by the keeper.
///
/// @dev    Decisions and measurements: docs/ARCHITECTURE.md, §S18 for this model.
///
///         **Why cumulative.** One root per epoch charged, at every settlement,
///         a proof verification and a storage write PER EPOCH OWED. Measured:
///         47,000 gas per epoch. At one epoch per hour, settling a holder cost
///         1.53M gas a day — 53 % of rewards for 1,000 holders. Aggregating by
///         stock fixed nothing: it merges transfers, not verifications.
///
///         Here the leaf carries the **cumulative total since inception**:
///         `(holder, stock, cumulative)`. The contract remembers what it already
///         paid and only settles the difference. Cost therefore scales with the
///         number of STOCKS, never with the number of epochs elapsed — and
///         delivery frequency decouples from epoch length: pushing once a week
///         costs the same as pushing once an hour.
///
///         **One key on the nominal path: a keeper publishes the root, and it
///         takes effect immediately.** There is no bond and no challenge
///         window — see `publishRoot` for exactly what that costs.
///
///         "A keeper" and not "the keeper": this contract's own `keeper` may
///         publish, and so may anyone the vault's registry names. The first is
///         a single SLOAD and works whatever else is broken; the second is what
///         lets a set of publishers be managed in one place instead of vault by
///         vault. Widening it widens the exposure
///         `totalFunded(stock) - totalDistributed(stock)` measures — clamped at
///         `_one`, and monitored in quote terms as `quoteAtRisk` — and that is
///         the price of not having one hot key as a single point of failure —
///         both doors are the timelock's, both take 48 h.
///
///         Everything else stays open to anyone: `claim`, `distribute`,
///         `withdraw`. The timelock can only manage
///         the exclusion list and rotate the keeper; it never touches funds.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract Distributor {
    // ------------------------------------------------------------------ types

    /// @dev One epoch = one stock (§S16). Kept for auditability: this is what a
    ///      verifier replays. Payments themselves are cumulative.
    /// @dev A cumulative root. The next one REPLACES this one: the amounts it
    ///      carries already include the whole history.
    struct Root {
        address publisher;
        uint40 publishedAt;
        bytes32 claimRoot;
        bytes32 pushRoot;
        uint48 upToEpoch; // last epoch covered, for verification
        /// @dev sha256 of the canonical JSON — a CONTENT commitment, not an
        ///      address. The IPFS locator rides on `RootPublished` instead: an
        ///      artifact above one block (~160 holders, measured) gets a CID
        ///      that cannot be derived from this digest.
        bytes32 digest;
    }

    // ----------------------------------------------------------------- errors

    error NotFeeVault();
    error NotTimelock();
    error NotKeeper();
    error NotCoSigned();
    error BadInput();
    error BatchMismatch();
    error NoActiveRoot();
    error InvalidProof();
    error NothingDelivered();
    error BatchTooLarge(uint256 max);
    error DuplicateStock(address stock);
    error EpochNotOver(uint256 endsAt);
    error Reentrancy();
    error ZeroAddress();
    error AlreadyInitialised();
    error TransferFailed();

    // ----------------------------------------------------------------- events

    /// @notice One purchase, covering the epochs `[fromEpoch, toEpoch]` and
    ///         buying the whole basket at once.
    ///
    /// @dev    The window and the per-stock amounts live HERE and not in
    ///         storage. A verifier replays logs anyway — it is how the
    ///         exclusion list and the seeds were always read — and the contract
    ///         only needs the aggregates for its own invariants. Keeping a
    ///         per-epoch struct as well would cost an SSTORE per epoch to
    ///         record something no on-chain rule consults.
    event WindowFunded(
        uint256 indexed fromEpoch, uint256 indexed toEpoch, address[] stocks, uint256[] amounts, uint256[] quoteSpent
    );
    event RootPublished(
        uint256 indexed rootId,
        address indexed publisher,
        bytes32 claimRoot,
        bytes32 pushRoot,
        uint256 upToEpoch,
        bytes32 digest,
        /// @dev Where to fetch the artifact. Emitted, never stored: a log costs
        ///      8 gas a byte against an SSTORE's 20,000, and nothing on-chain
        ///      reads it — only the front does, and it verifies what it gets
        ///      against `digest` anyway.
        string cid
    );
    event KeeperChanged(address indexed from, address indexed to);
    event CoSignerChanged(address indexed from, address indexed to);
    /// @dev The co-signer saying it is alive. Its ABSENCE is what lets the
    ///      pinned keeper publish alone again, so the log of it is the record of
    ///      when the second key was and was not in force.
    event CoSignerHeartbeat(address indexed by, uint256 at);
    /// @dev A keeper putting a root to the co-signer ON THE RECORD. It is what
    ///      starts the clock on a veto, so it is also the line a watcher reads
    ///      as "somebody will be able to publish this alone in three hours".
    event CoSignatureRequested(bytes32 indexed rootKey, uint256 upToEpoch, uint256 at);
    /// @dev The co-signer refusing a root **on the record**. Unlike not signing,
    ///      this is a transaction by its own key: an operator can tell "the
    ///      second key is deliberately blocking" from "the second key is down",
    ///      and the two need opposite responses.
    event CoSignatureRejected(bytes32 indexed rootKey, address indexed by);
    event Delivered(address indexed holder, address indexed stock, address indexed caller, uint256 amount);
    event DeliveryFailed(address indexed holder, address indexed stock, uint256 amount);
    event GasRefunded(address indexed to, uint256 amount);
    event GasReceived(address indexed from, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ExcludedSet(address[] accounts, bool state, uint48 fromEpoch);

    // ------------------------------------------------------ set once, at init
    //
    // `immutable` while a constructor deployed this. A clone has no
    // constructor, so they live in storage and `init` is the only writer —
    // once, guarded.

    address public FEE_VAULT;
    address public TIMELOCK;
    uint256 public GENESIS;
    uint256 public EPOCH_LENGTH;

    /// @notice The only account allowed to publish a root. Rotatable by the
    ///         timelock, and by it alone.
    address public keeper;

    /// @notice **The second key on the root, and it is not a second secret — it
    ///         is a second OPINION.**
    ///
    /// @dev    A keeper key alone could publish a root awarding itself the whole
    ///         undelivered balance, in two transactions of the same block
    ///         (`publishRoot` then `claim`, nothing in between times anything).
    ///         Detection cannot fit in that gap, so what closes it has to sit
    ///         BEFORE the publication rather than after it.
    ///
    ///         `offchain/src/preflight.ts::crossCheck` already rebuilds the root
    ///         from a second node — but the keeper runs it on itself, and a
    ///         compromised keeper simply does not run it. Moving that same
    ///         recomputation behind a different key turns a self-check into a
    ///         door: the co-signer replays the epochs from its own RPC and signs
    ///         only what it reproduces. Holding both secrets is not enough; the
    ///         two machines have to lie the same way about a deterministic,
    ///         publicly reproducible computation.
    ///
    ///         Zero means no requirement, which is the state a standalone
    ///         Distributor and every clone start in.
    address public coSigner;

    /// @notice When the co-signer last said it was alive. See `CO_SIGNER_GRACE`.
    uint256 public coSignerHeartbeat;

    /// @notice When a root was first put to the co-signer, by `rootDigest` key.
    ///
    /// @dev    **The heartbeat covers a co-signer that STOPS; this covers one
    ///         that refuses.** A hostile second key can keep heartbeating — so
    ///         `coSignerRequired()` stays true — while signing nothing, and
    ///         publication is then blocked until the timelock removes it: 48 h,
    ///         ninety-six epochs, which is exactly the failure the grace exists
    ///         to prevent. The grace only ever covered SILENCE, and an adversary
    ///         is not silent.
    ///
    ///         So a veto has to be exercised to be kept. The keeper records the
    ///         root it is asking for; if `CO_SIGNER_GRACE` passes and that root
    ///         is still unpublished, the single-key form accepts **that root and
    ///         no other** — the key is `rootDigest`, which commits to every
    ///         field, to this contract and to this chain.
    ///
    ///         A thief can use the same door, and that is the accepted cost:
    ///         they must post their forged root publicly and wait three hours,
    ///         with `CoSignatureRequested` in the log the whole time. Slow and
    ///         loud instead of instant and invisible, which is the trade the
    ///         grace already makes.
    ///
    ///         **Four things bound WHEN that door is open, and none of them
    ///         existed until 2026-09-12** — the reason being that the trade
    ///         above is only honest if the three hours are spent on the day of
    ///         the theft rather than banked on a day of the keeper's choosing:
    ///
    ///           1. the epoch must be over (`requestCoSignature`), so the clock
    ///              cannot start on a root that is months from publishable;
    ///           2. the request must be younger than `coSignerNamedAt`
    ///              (`coSignatureLapsed`), so a lapse earned under the key this
    ///              one replaced dies with it;
    ///           3. the co-signer must be IN FORCE when the clock starts
    ///              (`requestCoSignature`), so a request cannot be banked during
    ///              an outage the grace was tolerating and cashed after the
    ///              recovery;
    ///           4. `publishRoot` must still find the epoch ahead of the active
    ///              root, which was already true and is what makes 1 bite.
    ///
    ///         Before them, one transaction of ~25k gas taken at launch took
    ///         the whole undelivered balance months later, on one key, with the
    ///         second key named and answering (`docs/AUDIT_EXECUTION_2.md` §1).
    mapping(bytes32 rootKey => uint256 at) public coSignatureRequestedAt;

    /// @dev The sentinel `coSignatureRequestedAt` carries for a root the
    ///      co-signer has refused. A timestamp that can never be reached, so
    ///      `coSignatureLapsed` answers false for ever — and `requestCoSignature`
    ///      will not overwrite it, since it only ever writes into a zero slot.
    uint256 internal constant REJECTED = type(uint256).max;

    // -------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;

    /// @notice ETH that funded whatever has NOT been distributed yet.
    ///
    ///         **This is the exact exposure if the keeper key is compromised**:
    ///         what a false root could award itself, in quote terms. The clamp
    ///         that enforces it is in `_one` — `owed` is capped at
    ///         `totalFunded[stock] - totalDistributed[stock]`, and at nothing
    ///         else.
    ///
    ///         **It is NOT "about one epoch", and this line used to say it
    ///         was** (T-ROOT-01/02, 2026-09-11). That sentence assumed
    ///         deliveries reach every holder. They do not: `offchain/src/epoch.ts`
    ///         pushes an entry only once its outstanding value clears the push
    ///         floor (~$10), so a holder under the floor is never pushed and
    ///         settles only by calling `claim`. The standing balance is
    ///         therefore
    ///
    ///             holders below the push floor x pushFloor  +  one window in flight
    ///
    ///         which a fork campaign measured at a peak of **three windows in
    ///         flight** on an entirely honest cycle
    ///         (`test/RootExposureInvariants.t.sol`), and which
    ///         `docs/recon.md` §6 puts in perspective with a Pons token holding
    ///         103 968 holders. Monitor the RATIO to one window's funding, not
    ///         the absolute number: a rising ratio means deliveries have
    ///         stopped, which is the failure this figure exists to show.
    ///
    /// @dev    Rises on every `fund`, falls pro-rata on every delivery. It is a
    ///         value in ETH SPENT, not a market valuation: the contract has no
    ///         reliable price for ten stocks, and we do not want this figure to
    ///         depend on an oracle.
    uint256 public quoteAtRisk;

    /// @notice ETH that funded each stock, cumulative. Used to convert a
    ///         delivered stock amount back into its ETH equivalent.
    mapping(address stock => uint256) public quoteFundedFor;

    /// @notice Hard bound on settlement loops. One entry = one stock, so 10 is
    ///         enough to settle a holder entirely; the headroom serves
    ///         multi-holder batches.
    uint256 public constant MAX_BATCH = 64;

    /// @notice How long the co-signer may be silent before the pinned keeper
    ///         publishes alone again. **Three hours, i.e. six epochs.**
    ///
    /// @dev    **The naive version of this hands the attacker the door, and that
    ///         is worth writing down.** Measuring the silence as "no root
    ///         published" puts the deadman under the control of whoever holds
    ///         the keeper key: they publish nothing, wait out the grace, and the
    ///         requirement lifts itself. So the clock runs on a HEARTBEAT the
    ///         co-signer writes itself, and an attacker has to take that machine
    ///         down for real — a second capability, and a visible one.
    ///
    ///         **Why three hours and not forty-eight.** Removing the requirement
    ///         through the timelock is the other lever and it takes 48 h: on a
    ///         protocol that promises stocks every thirty minutes that is
    ///         ninety-six epochs, which is a failure rather than a degradation.
    ///         Three hours is six epochs, nothing is lost — roots are cumulative
    ///         and the next one settles the whole gap — and six missed
    ///         heartbeats is not a hiccup.
    ///
    ///         What the grace costs, stated plainly: an attacker holding the
    ///         keeper key AND able to silence the co-signer for three hours is
    ///         back to the single-key case. During those three hours the
    ///         publication lag, `quoteAtRisk` and the heartbeat are all saying
    ///         so — see `offchain/src/check.ts`.
    uint256 public constant CO_SIGNER_GRACE = 3 hours;

    uint256 public constant MAX_REFUND = 0.02 ether;

    /// @notice **The reserve never pays more than this share of what a delivery
    ///         MOVED.** Before it, `_refund` priced the call and nothing related
    ///         it to the value that changed hands: an invariant campaign found
    ///         23 087 729 830 400 wei of refund paid against about **7 wei** of
    ///         value delivered (T-REFUND-02). No padding was needed — a small
    ///         delivery simply costs the reserve the same fixed refund as a
    ///         large one.
    ///
    /// @dev    **Derived from the keeper's own floor, not chosen.**
    ///         `offchain/src/epoch.ts` pushes an entry only once its outstanding
    ///         value clears `PUSH_K_MIN * SETTLE_GAS * basefee` — i.e. the floor
    ///         already guarantees the gas is at most **1/20 = 5 %** of what the
    ///         delivery moves. 10 % is that with a factor of two of headroom for
    ///         `REFUND_OVERHEAD` and `PUSH_MARGIN_BPS`, which sit outside
    ///         `SETTLE_GAS`. An honest push is therefore refunded in full with
    ///         about 35 % to spare at the tightest point (the gas-driven arm of
    ///         the floor) and ~2 400x to spare at the `PUSH_TARGET_WEI` arm.
    ///
    ///         It caps and never reverts, like every other bar here: a delivery
    ///         worth too little to refund still DELIVERS, and the caller fronts
    ///         the difference as everywhere else (§S8).
    uint256 public constant REFUND_VALUE_BPS = 1_000;
    uint256 internal constant REFUND_OVERHEAD = 40_000;
    /// @notice Margin above true cost: we refund `gas * basefee` while the
    ///         caller pays `gas * (basefee + priority)`. Without the margin,
    ///         pushing loses money and nobody but us would ever do it.
    ///
    /// @dev    **300 bps since 2026-09-10, down from 2 000.** The margin exists
    ///         to cover the priority fee, and `docs/recon.md` §"push economics"
    ///         measures exactly what that costs on this chain:
    ///
    ///             block.basefee   391,354,000
    ///             gas price       397,434,000     → +1.55 %
    ///
    ///         2 000 bps covered a 1.55 % need 12.9 times over. Everything past
    ///         the priority fee is not a refund, it is a bounty paid out of the
    ///         holders' reserve, and the reserve is the holders' money. 300 bps
    ///         still covers the measured premium about twice over, so pushing
    ///         stays profitable — which is the only property this constant owes
    ///         anyone (§S8).
    ///
    ///         Raise it if the chain ever runs a real priority auction; the
    ///         number to re-read is the ratio above, not this one. It is
    ///         `public` and the front reads it, so a change shows up there.
    uint256 public constant PUSH_MARGIN_BPS = 300;

    // ------------------------------------------------------------------ state

    /// @notice The first epoch no purchase has covered yet. A window runs from
    ///         here to the epoch it names, and the next one starts after.
    uint256 public nextEpoch;

    /// @notice Total received and total paid out, per stock. The latter can
    ///         never exceed the former: that is the invariant bounding the
    ///         damage of an inflated root.
    mapping(address stock => uint256) public totalFunded;
    mapping(address stock => uint256) public totalDistributed;

    /// @notice Cumulative amount already paid to a holder for a stock. This
    ///         counter is what makes cumulative roots safe and idempotent:
    ///         replaying an old proof pays nothing.
    mapping(address holder => mapping(address stock => uint256)) public claimedSoFar;

    mapping(uint256 rootId => Root) public roots;
    /// @notice Id of the latest published root (0 = none).
    uint256 public rootCount;
    /// @notice Id of the root in force. It is the only one we settle
    ///         against.
    uint256 public activeRoot;

    /// @notice ETH owed to an address that could not receive it.
    ///
    /// @dev    No payment must ever be able to block an action. A recipient that
    ///         is a contract without `receive()` would otherwise make the
    ///         calling action impossible — and anyone could freeze the system by
    ///         acting from such a contract. So we fall back to pull payments.
    mapping(address account => uint256) public pendingWithdrawal;

    /// @notice Sum of `pendingWithdrawal`. The gas reserve and the deferred
    ///         payments share one balance, so without this counter a refund
    ///         could be paid out of ETH already owed to somebody else, and their
    ///         `withdraw()` would then revert for want of funds.
    uint256 public pendingTotal;

    /// @notice CURRENT exclusion state. Handy for a front end, but it must
    ///         NEVER be used to build a root: it is a live boolean, so two
    ///         verifiers replaying the same epoch on either side of a
    ///         `setExcluded` would read different values and produce different
    ///         roots. Use `exclusionLog()` and replay it up to the target epoch.
    mapping(address account => bool) public isExcluded;
    address[] internal _excludedEver;

    /// @notice One exclusion change, dated by the epoch from which it applies.
    ///         This log — append-only, `fromEpoch` non-decreasing — is what makes
    ///         an epoch's exclusion set reconstructible by anyone, at any time.
    struct ExclusionChange {
        address account;
        bool state;
        uint48 fromEpoch;
    }

    ExclusionChange[] internal _exclusionLog;

    uint256 private _lock;

    /// @notice Set by `init`, and the reason it can only run once.
    bool public initialised;

    /// @notice When the CURRENT co-signer was named. Zero when there is none.
    ///
    /// @dev    **A request only counts against the key that was in force while
    ///         it aged.** Without this slot `coSignatureLapsed` had no notion of
    ///         WHEN the second key arrived, and `requestCoSignature` constrains
    ///         nothing — so a keeper could put a root on the record at a moment
    ///         when nobody was able to refuse it and spend the lapse later,
    ///         against a co-signer that was named, heartbeating and in force.
    ///         Two ways in, and the second needed no foresight at all:
    ///
    ///           - while `coSigner` was zero, which is what every vault is at
    ///             birth and until the registry names one. `rejectCoSignature`
    ///             reverts for EVERY caller in that state, so the refusal the
    ///             whole mechanism rests on did not exist yet;
    ///           - while the co-signer was lapsed, which `CO_SIGNER_GRACE`
    ///             deliberately tolerates — so every outage was a window in
    ///             which a future single-key publication could be armed, and
    ///             nothing listed what had been.
    ///
    ///         Measured before the fix: **12.000 NVDA, the whole undelivered
    ///         balance, on one key**, with `coSignerRequired()` true at the
    ///         moment of the call (`docs/AUDIT_EXECUTION_2.md` §1).
    ///
    ///         It also closes the rotation case for free. A lapse earned against
    ///         co-signer A is a refusal A declined to make; B never saw the root
    ///         and never had its three hours. `setCoSigner(B)` moves this slot,
    ///         so what A left pending dies with A — which is what "rotating the
    ///         second key" has to mean if it is to be an answer to anything.
    ///
    ///         **`coSignerHeartbeat` could not serve.** `heartbeat()` overwrites
    ///         it every few minutes, so it says when the key last spoke and
    ///         never when it arrived. Two different questions, and the second
    ///         one had no slot.
    uint256 public coSignerNamedAt;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Marks the IMPLEMENTATION as initialised: only clones configure.
    constructor() {
        initialised = true;
    }

    /// @notice Configures a fresh clone. **Once, and only once.**
    ///
    /// @dev    `Bootstrap` calls this in the same transaction as the clone, so
    ///         nothing can slip in between. Afterwards no function writes any
    ///         of these fields again.
    function init(address feeVault, address timelock, address keeper_, uint256 genesis, uint256 epochLength) external {
        if (initialised) revert AlreadyInitialised();
        initialised = true;
        if (feeVault == address(0) || timelock == address(0) || keeper_ == address(0)) revert ZeroAddress();
        if (genesis == 0 || epochLength == 0) revert BadInput();

        // A clone runs no constructor, so no field initialiser reaches it: at
        // zero, `nonReentrant` would revert on its very first call.
        _lock = 1;

        FEE_VAULT = feeVault;
        TIMELOCK = timelock;
        keeper = keeper_;
        GENESIS = genesis;
        EPOCH_LENGTH = epochLength;
    }

    receive() external payable {
        emit GasReceived(msg.sender, msg.value);
    }

    // ----------------------------------------------------------------- calendar

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= GENESIS) return 0;
        return (block.timestamp - GENESIS) / EPOCH_LENGTH;
    }

    function epochEnd(uint256 epoch) public view returns (uint256) {
        return GENESIS + (epoch + 1) * EPOCH_LENGTH;
    }

    // --------------------------------------------------------------- 1. fund

    /// @notice Credits one purchase of the whole basket, covering every epoch
    ///         from the last one funded up to `toEpoch`.
    ///
    /// @dev    **A window, not an epoch.** Payd credited one stock per epoch,
    ///         so a holder was paid in whatever the rotation happened to buy
    ///         while they held — an arbitrary slice of the basket, and the
    ///         shorter the holding the more arbitrary. Here every holder of the
    ///         window is paid in the whole basket, pro rata to the time they
    ///         held across it. "You own a slice of the basket" becomes a true
    ///         sentence (`PLAN.md` D8).
    ///
    ///         The window is closed and contiguous by construction: it starts
    ///         where the last one ended and cannot cover an epoch still
    ///         running. Nothing is ever skipped, so a verifier replaying the
    ///         `WindowFunded` logs sees a partition of the epochs, with no gap
    ///         and no overlap.
    function fundWindow(
        uint256 toEpoch,
        address[] calldata stocks,
        uint256[] calldata amounts,
        uint256[] calldata quoteSpent
    ) external nonReentrant {
        if (msg.sender != FEE_VAULT) revert NotFeeVault();
        uint256 n = stocks.length;
        if (n == 0 || amounts.length != n || quoteSpent.length != n) revert BadInput();

        uint256 from = nextEpoch;
        if (toEpoch < from) revert BadInput();
        uint256 endsAt = epochEnd(toEpoch);
        if (block.timestamp < endsAt) revert EpochNotOver(endsAt);
        nextEpoch = toEpoch + 1;

        uint256 totalQuote;
        for (uint256 i; i < n; ++i) {
            address stock = stocks[i];
            uint256 amount = amounts[i];
            if (stock == address(0) || amount == 0) revert BadInput();
            totalFunded[stock] += amount;
            quoteFundedFor[stock] += quoteSpent[i];
            totalQuote += quoteSpent[i];
        }
        // One write, whatever the basket holds.
        quoteAtRisk += totalQuote;

        emit WindowFunded(from, toEpoch, stocks, amounts, quoteSpent);
    }

    // ------------------------------------------------------------- 3. the root

    /// @notice Publishes the cumulative root covering epochs 0..`upToEpoch`.
    ///         It takes effect IMMEDIATELY.
    ///
    /// @dev    **Keeper-only, and this is the system's central trade-off.**
    ///
    ///         The contract cannot verify a root: doing so would mean replaying
    ///         the token's history for every holder. Two options existed, and
    ///         only one survives here:
    ///
    ///         - open publication to anyone, with a bond and a challenge window.
    ///           Anybody can take over, nobody has to trust us — at the price of
    ///           ~33 min of latency and a mechanism holders could see on screen;
    ///         - reserve it for the keeper. Immediate payout, no bond, no
    ///           window — at the price of one trusted actor.
    ///
    ///         The second was chosen. What it costs, precisely: a compromised
    ///         key can publish a root awarding itself **whatever has not been
    ///         distributed yet**, i.e. `quoteAtRisk`. Deliveries run continuously,
    ///         so that stays on the order of ONE epoch — a few tens of dollars,
    ///         not the treasury. It is the constant pushing that bounds the
    ///         blast radius, not a guard.
    ///
    ///         What remains in defence:
    ///         - the seed is anchored ON-CHAIN and drawn from a future block.
    ///           Not even the keeper picks its own sampling blocks;
    ///         - `offchain/dispute.ts` stays usable by anyone: it recomputes the
    ///           root without asking us for anything. The contract no longer
    ///           acts on its verdict, but public proof remains possible;
    ///         - `claimedSoFar` still forbids paying twice;
    ///         - the timelock can revoke the keeper in 48 h.
    /// @param digest sha256 of the canonical JSON. This is what a holder's
    ///        proof is checked against, and what anyone recomputing the epoch
    ///        must land on.
    /// @param cid    IPFS locator for that same JSON, as the node reported it.
    ///        A HINT: the content is verified against `digest`, so a hostile
    ///        gateway can only make a load fail, never change an amount.
    function publishRoot(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest, string calldata cid)
        external
        nonReentrant
    {
        uint256 g0 = gasleft();
        // **The single-key form, and it is only open when there is no second
        // key to ask.** Three ways for that to be true: none was ever named;
        // the one that was named has stopped answering for longer than
        // `CO_SIGNER_GRACE`; or THIS root was put to them and they let the same
        // grace run out without signing it. The third is what stops a hostile
        // second key holding the vault shut for the 48 h a removal takes — see
        // `coSignatureRequestedAt`.
        if (coSignerRequired() && !coSignatureLapsed(upToEpoch, claimRoot, pushRoot, digest)) revert NotCoSigned();
        _publish(g0, upToEpoch, claimRoot, pushRoot, digest, cid);
    }

    /// @notice The same, co-signed. **This is the nominal path once a co-signer
    ///         is named**, and the one a compromised keeper cannot take.
    ///
    /// @param coSig An EIP-191 signature by `coSigner` over `rootDigest(...)`.
    ///        The co-signer never sends a transaction: it signs a hash and hands
    ///        it back, so it needs no wallet, no gas and no nonce — only the
    ///        `heartbeat` below, which is what keeps its requirement in force.
    function publishRoot(
        uint256 upToEpoch,
        bytes32 claimRoot,
        bytes32 pushRoot,
        bytes32 digest,
        string calldata cid,
        bytes calldata coSig
    ) external nonReentrant {
        uint256 g0 = gasleft();
        address signer = coSigner;
        // Not "ignore the signature if nobody is named": a call that carries a
        // co-signature and is accepted without checking it reads, for ever
        // after, as a root that was co-signed.
        if (signer == address(0)) revert NotCoSigned();
        if (ECDSA.recover(rootDigest(upToEpoch, claimRoot, pushRoot, digest), coSig) != signer) revert NotCoSigned();
        _publish(g0, upToEpoch, claimRoot, pushRoot, digest, cid);
    }

    /// @notice Whether a root must be co-signed right now.
    ///
    /// @dev    `public` because the keeper reads it once a round to know which
    ///         of the two forms to call, and because an outsider should be able
    ///         to see, without asking anyone, whether the second key is in force
    ///         at this moment.
    function coSignerRequired() public view returns (bool) {
        if (coSigner == address(0)) return false;
        return block.timestamp <= coSignerHeartbeat + CO_SIGNER_GRACE;
    }

    /// @notice Exactly what the co-signer signs. **Read by the off-chain signer
    ///         rather than re-derived there**, because two implementations of
    ///         one hash is two implementations of one hash.
    ///
    /// @dev    The chain id and this contract's address are in it, so a
    ///         signature cannot be replayed onto another Distributor or another
    ///         chain; `upToEpoch` is in it and `publishRoot` refuses an epoch
    ///         that does not move forward, so it cannot be replayed here either.
    function rootDigest(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), upToEpoch, claimRoot, pushRoot, digest))
        );
    }

    /// @notice The co-signer saying it is alive. **Its own key, and the only
    ///         thing that MOVES this slot forward on a live co-signer.**
    ///
    /// @dev    This said "nothing else can write this slot" until 2026-09-12 and
    ///         that was false: `setCoSigner` writes it too, which is how naming
    ///         a co-signer starts its grace without the key having to send
    ///         anything. The distinction matters because this slot is the
    ///         deadman, and a reader checking the deadman against that sentence
    ///         would have concluded the timelock could not re-arm a lapsed
    ///         requirement. It can. What it cannot do is forge a heartbeat for a
    ///         key that is down: `setCoSigner` also moves `coSignerNamedAt`, so
    ///         re-naming restarts the grace and voids every request banked
    ///         before it.
    ///
    /// @dev    One cheap transaction on a cadence of the operator's choosing —
    ///         the keeper's own round is the obvious one. It is the ONLY thing
    ///         keeping the second key in force, which is deliberate: a deadman
    ///         measured on "no root published" would be under the control of
    ///         whoever holds the keeper key.
    function heartbeat() external {
        if (msg.sender != coSigner || msg.sender == address(0)) revert NotCoSigned();
        coSignerHeartbeat = block.timestamp;
        emit CoSignerHeartbeat(msg.sender, block.timestamp);
    }

    /// @notice Puts a root to the co-signer, on the record. **The keeper's, and
    ///         it moves nothing.**
    ///
    /// @dev    Call it when the co-signer refuses or cannot be reached. Three
    ///         hours later `publishRoot`'s single-key form accepts exactly this
    ///         root — not another, not a later one — so a second key that will
    ///         not sign cannot hold the vault shut until a vote lands.
    ///
    ///         The first request wins: re-asking does not push the clock
    ///         forward, so nothing is gained by spamming it. No expiry, because
    ///         none is needed — the key commits to `upToEpoch`, this function
    ///         refuses an epoch that is not over, and `publishRoot` refuses one
    ///         that does not move past the active root. So every request names a
    ///         CLOSED epoch that the next published root overtakes, and an
    ///         overtaken request is dead.
    ///
    ///         **That argument was written before the line that makes it true**
    ///         (2026-09-12). Until then `upToEpoch` was unconstrained, an epoch
    ///         in the future could be overtaken by nothing, and a request naming
    ///         one lapsed and waited indefinitely. The reasoning was sound about
    ///         the past and silent about the future, which is the half that was
    ///         load-bearing.
    function requestCoSignature(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest) external {
        if (msg.sender != keeper && !_registryAllows(msg.sender)) revert NotKeeper();
        // **The epoch has to be OVER, and this line is what makes the paragraph
        // above true.** It argued that no expiry was needed because a request
        // that has been overtaken is already dead — which holds for an epoch in
        // the past and not for one in the future. An epoch that has not happened
        // can be covered by no root, so it can be overtaken by none: a request
        // naming one weeks out lapsed, waited, and published on one key the
        // moment it closed, with the co-signer present and correct throughout.
        //
        // It costs no liveness, which is why it is the right shape: `_publish`
        // already refuses an epoch that is not over, so a root can never be
        // asked for before it can be published. Anything this line refuses was
        // unpublishable anyway — it just stops the CLOCK starting early.
        uint256 endsAt = epochEnd(upToEpoch);
        if (block.timestamp < endsAt) revert EpochNotOver(endsAt);
        // **And there has to BE a requirement to lift.** This function exists
        // for one situation: a second key that is in force and will not sign.
        // In every other state the keeper needs nothing from it — with no
        // co-signer named, or with one past `CO_SIGNER_GRACE`, the single-key
        // form is already open — so a request made in those states buys the
        // caller nothing it does not already have, and costs the protocol the
        // whole of what this clock is for.
        //
        // It is the half `coSignerNamedAt` does not reach, and the two are not
        // the same question. That slot asks whether the request still belongs
        // to the key being asked; this asks whether that key was in force when
        // the clock started. Without this line a request banked during an
        // OUTAGE — the state the grace deliberately tolerates, where
        // `coSignerNamedAt` is long past — survived the recovery and published
        // on one key with every indicator green
        // (`test_ARecoveredHeartbeatReArmsTheRequirementForEveryRoot`).
        if (!coSignerRequired()) revert NotCoSigned();
        // **And not in the block the key was named in.** `coSignatureLapsed`
        // compares `asked <= coSignerNamedAt`, taking the conservative side of
        // an ambiguity so that a request cannot straddle a rotation. Left to
        // itself that turns a legitimate same-block request into a slot that is
        // written, can never lapse, and cannot be re-asked — `coSignatureRequested-
        // At[key] != 0` makes the retry a no-op, so the root would be dead for
        // good and silently. A revert says so instead, and the caller waits one
        // block. Refusing loudly beats a slot that reads as pending for ever.
        if (block.timestamp <= coSignerNamedAt) revert NotCoSigned();
        bytes32 key = rootDigest(upToEpoch, claimRoot, pushRoot, digest);
        if (coSignatureRequestedAt[key] != 0) return;
        coSignatureRequestedAt[key] = block.timestamp;
        emit CoSignatureRequested(key, upToEpoch, block.timestamp);
    }

    /// @notice Refuses one root, out loud. **The co-signer's, and it moves
    ///         nothing.**
    ///
    /// @dev    **Without this, the door above is a door for a compromised keeper
    ///         too.** `requestCoSignature` is the keeper's, so a thief holding
    ///         that key posts their forged root, waits `CO_SIGNER_GRACE` and
    ///         publishes alone — in three hours, while replacing them takes the
    ///         timelock's forty-eight. The lapse has to be refusable by the one
    ///         party that knows whether the silence was deliberate.
    ///
    ///         **What it costs is the case where the co-signer is itself
    ///         hostile**: it can reject everything and block publication until
    ///         the timelock removes it. That is 48 h of delay against 48 h of
    ///         theft, and — the part that decides it — every rejection is a
    ///         transaction signed by its own key. An operator can tell a second
    ///         key that is BLOCKING from one that is DOWN, which the silence it
    ///         replaces never allowed.
    ///
    ///         A rejection is final for that root. The keeper's answer is a
    ///         different root — a fresh computation, a new key — not a second
    ///         attempt at this one.
    function rejectCoSignature(bytes32 rootKey) external {
        if (msg.sender != coSigner || msg.sender == address(0)) revert NotCoSigned();
        // **Only a root that was actually PUT to it, and this line is the
        // difference between loud and silent.** Without it the co-signer can
        // reject a key nobody has asked about yet — and it can, because
        // computing the root in advance is precisely its job: it replays the
        // epochs. A hostile one would pre-reject the honest root before the
        // keeper ever asks, `requestCoSignature` writes only into a zero slot,
        // and the keeper's whole remedy dies before it engages.
        //
        // It does not remove the block — a co-signer determined to stop the
        // vault rejects each request as it appears, one per epoch, until the
        // timelock removes it. That was always the accepted trade. What this
        // restores is that every refusal is a SIGNED TRANSACTION IN RESPONSE TO
        // A PUBLIC REQUEST, which is the whole justification for having this
        // function: an operator can tell a second key that is blocking from one
        // that is down. Rejections posted in advance and in bulk allow neither.
        if (coSignatureRequestedAt[rootKey] == 0) revert NotCoSigned();
        coSignatureRequestedAt[rootKey] = REJECTED;
        emit CoSignatureRejected(rootKey, msg.sender);
    }

    /// @notice Whether this exact root may now go out on one key despite a
    ///         co-signer being in force, because it was put to them and they let
    ///         the grace run out without signing it — and did not refuse it.
    function coSignatureLapsed(uint256 upToEpoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest)
        public
        view
        returns (bool)
    {
        uint256 asked = coSignatureRequestedAt[rootDigest(upToEpoch, claimRoot, pushRoot, digest)];
        // `REJECTED` first: the addition below would overflow on it, and a
        // refusal is not a pending request that has aged well.
        if (asked == 0 || asked == REJECTED) return false;
        // **And the request has to be younger than the key it is counted
        // against.** A lapse is a refusal somebody declined to make, so it only
        // means anything if that somebody was there to decline it. Requests
        // banked before this co-signer arrived — while none was named, or
        // during an outage, or under the key this one replaced — belong to
        // nobody and expire with the state that allowed them. `<=` and not `<`:
        // a request in the same block as the naming is the same ambiguity, and
        // the safe side of it is the one that costs a keeper one more epoch.
        if (asked <= coSignerNamedAt) return false;
        return block.timestamp > asked + CO_SIGNER_GRACE;
    }

    /// @notice Names the co-signer, or removes it. **The timelock's, and the
    ///         registry's on its own vaults** — the same two callers
    ///         `setKeeper` takes, and for the same reason: one vault at a time
    ///         does not scale to a thousand.
    ///
    /// @dev    Naming one starts its grace immediately, so a co-signer that is
    ///         named and never heartbeats lapses after `CO_SIGNER_GRACE` rather
    ///         than bricking publication for 48 h.
    function setCoSigner(address newCoSigner) external {
        if (msg.sender != TIMELOCK && msg.sender != _registry()) revert NotTimelock();
        // **The two roles cannot be one address**, which is the dumbest version
        // of the mistake the whole arrangement exists to prevent: a second key
        // that IS the first key is a second secret held by whoever holds the
        // first, and every property here would still read as satisfied.
        //
        // It does not — and cannot — check that the co-signer runs on another
        // HOST against another node, which is what the second key actually buys
        // (`.env.example`, `FLOWS.md` §7.c). One address is what a contract can
        // see; the rest is custody, and custody is written down rather than
        // enforced.
        if (newCoSigner == keeper && newCoSigner != address(0)) revert NotCoSigned();
        emit CoSignerChanged(coSigner, newCoSigner);
        coSigner = newCoSigner;
        coSignerHeartbeat = newCoSigner == address(0) ? 0 : block.timestamp;
        // The two are written together and read apart: the heartbeat says when
        // the key last spoke, this says when it arrived. Every request older
        // than this line belongs to a key that is no longer the one being
        // asked — see `coSignerNamedAt`.
        coSignerNamedAt = newCoSigner == address(0) ? 0 : block.timestamp;
    }

    function _publish(
        uint256 g0,
        uint256 upToEpoch,
        bytes32 claimRoot,
        bytes32 pushRoot,
        bytes32 digest,
        string calldata cid
    ) internal {
        // **The pinned key first, and the short-circuit is the design.** A
        // Distributor's own `keeper` is checked with one SLOAD and nothing
        // else, so the nominal publisher pays nothing for the existence of the
        // set and — the part that matters — keeps publishing even if the
        // registry is unreachable. The registry is an EXTENSION of who may
        // publish, never a condition of it: putting it first would make every
        // vault's liveness depend on another contract answering.
        if (msg.sender != keeper && !_registryAllows(msg.sender)) revert NotKeeper();
        if (claimRoot == bytes32(0)) revert BadInput();
        // The epoch must be OVER. It is the whole of what the seed used to
        // buy, and it is now one comparison: the window a share is computed
        // over is `[GENESIS + e*L, GENESIS + (e+1)*L)`, fixed by two
        // immutables, so the keeper chooses nothing. Without this line it
        // could publish over a period still running — a time-weighted average
        // truncated wherever it suited.
        uint256 endsAt = epochEnd(upToEpoch);
        if (block.timestamp < endsAt) revert EpochNotOver(endsAt);
        // Scope must move forward: republishing the same span serves nothing,
        // and would allow rewriting a root already in force.
        if (activeRoot != 0 && upToEpoch <= roots[activeRoot].upToEpoch) revert BadInput();

        uint256 id = ++rootCount;
        roots[id] = Root({
            publisher: msg.sender,
            publishedAt: uint40(block.timestamp),
            claimRoot: claimRoot,
            pushRoot: pushRoot,
            upToEpoch: uint48(upToEpoch),
            digest: digest
        });
        activeRoot = id;
        emit RootPublished(id, msg.sender, claimRoot, pushRoot, upToEpoch, digest, cid);

        // Refunded like the cycle's other actions. The goal is that the
        // keeper's wallet does not DRAIN. Without this it burned ~$8/day of its
        // own, and "it runs by itself" became false within months. Degrades
        // without reverting if the reserve is empty (§S8).
        //
        // No value ceiling: a root moves nothing, so there is nothing to relate
        // the refund to. What bounds this one is that it is keeper-only and
        // runs once an epoch, which the ceiling below exists to replace on the
        // path that is neither.
        _refund(g0, type(uint256).max);
    }

    /// @notice Changes the keeper. **The timelock's only power on this path —
    ///         and the registry's, on its own vaults.**
    ///
    /// @dev    It is the only answer to a compromised key. It takes 48 h, so it
    ///         does not stop a theft in progress — it stops it from happening
    ///         again. What actually bounds the damage is that deliveries run
    ///         continuously: at any moment there is only about one epoch inside
    ///         the contract.
    ///
    ///         **The registry was added as a second caller, and the reason the
    ///         first version refused one was backwards.** `Payd.setKeeper` used
    ///         to reach FUTURE Distributors only, so that "one call must not be
    ///         able to swap the publisher of every vault at once". But the
    ///         timelock could already do exactly that — in N calls, N × 48 h.
    ///         What N calls bought was not safety, it was an honest operator
    ///         unable to respond to a compromise across a thousand vaults. The
    ///         power is unchanged; only its cost is.
    ///
    ///         The registry is read from the vault rather than stored, so
    ///         nothing here has to be kept in step with it, and a standalone
    ///         Distributor (no registry, V1-style) simply has no second caller.
    function setKeeper(address newKeeper) external {
        if (msg.sender != TIMELOCK && msg.sender != _registry()) revert NotTimelock();
        if (newKeeper == address(0)) revert BadInput();
        // The same refusal from the other side: rotating the keeper ONTO the
        // co-signer would collapse the two roles just as quietly.
        if (newKeeper == coSigner) revert NotCoSigned();
        emit KeeperChanged(keeper, newKeeper);
        keeper = newKeeper;
    }

    // -------------------------------------------------------- 4. settlement

    /// @notice Claim your shares. One entry per stock, no matter how many
    ///         epochs have gone by since last time.
    function claim(address[] calldata stocks, uint256[] calldata cumulative, bytes32[][] calldata proofs)
        external
        nonReentrant
        returns (uint256 delivered)
    {
        (delivered,) = _settle(msg.sender, stocks, cumulative, proofs, true);
        if (delivered == 0) revert NothingDelivered();
    }

    /// @notice Pushes `account`'s shares to them. Open to anyone: the
    ///         destination is the address written in the leaf, never the
    ///         caller's.
    /// @dev    Proofs are verified against `pushRoot`, so the refund can only
    ///         fund deliveries that were already worth making (§S2.d).
    function distribute(
        address account,
        address[] calldata stocks,
        uint256[] calldata cumulative,
        bytes32[][] calldata proofs
    ) external nonReentrant returns (uint256 delivered) {
        uint256 g0 = gasleft();
        uint256 moved;
        (delivered, moved) = _settle(account, stocks, cumulative, proofs, false);
        if (delivered == 0) revert NothingDelivered();
        // **The refund is bounded by what the call MOVED**, not only by what it
        // burned. `_refund` prices the call, and nothing used to relate the two:
        // see `REFUND_VALUE_BPS`. `moved` is the quote-denominated value of the
        // deliveries, the same `backing` figure `quoteAtRisk` is decremented by,
        // so no new price is read and none can be manipulated.
        _refund(g0, (moved * REFUND_VALUE_BPS) / BPS);
    }

    /// @return delivered the raw stock amounts transferred, summed
    /// @return moved      what those transfers were worth in the currency the
    ///                    purchases were made in — `_one`'s own `backing`
    ///                    figure, accumulated. Only `distribute` reads it.
    function _settle(
        address account,
        address[] calldata stocks,
        uint256[] calldata cumulative,
        bytes32[][] calldata proofs,
        bool viaClaimRoot
    ) internal returns (uint256 delivered, uint256 moved) {
        uint256 n = stocks.length;
        if (n == 0 || cumulative.length != n || proofs.length != n) revert BatchMismatch();
        if (n > MAX_BATCH) revert BatchTooLarge(MAX_BATCH);
        if (account == address(0)) revert BadInput();

        uint256 id = activeRoot;
        if (id == 0) revert NoActiveRoot();
        bytes32 root = viaClaimRoot ? roots[id].claimRoot : roots[id].pushRoot;
        if (root == bytes32(0)) revert NoActiveRoot();

        // Accumulating the ETH backing and writing `quoteAtRisk` ONCE per
        // settlement instead of once per entry was tried on 2026-09-06 and
        // reverted: measured against real chain state it bought **15 gas** at
        // two stocks and cost 263 at one, where the SSTORE it removes is priced
        // at 2,900. Whatever the optimiser already does here, the model that
        // predicted the saving is wrong — and a tuple return through the
        // settlement path is not worth carrying for nothing.
        // Numbers in `test/Costs.t.sol::test_MeasureWhatABatchCouldSave`.
        for (uint256 i; i < n; ++i) {
            // **One entry per stock, and a repeat is refused (T-REFUND-01).**
            // This function fixes ONE account, so two entries naming the same
            // stock can never both deliver: the first writes `claimedSoFar` and
            // the rest verify their proof and return 0 at the `cumulative <=
            // paid` line below. That was free to construct and not free to
            // serve — 63 no-ops riding with one real delivery cost the reserve
            // **1.854x** the honest refund for the same delivery, because
            // `_refund` prices the whole call.
            //
            // Refusing is smaller than pricing around it, and it is the root
            // rather than the symptom: nothing legitimate repeats a stock here.
            // A holder is owed at most `MAX_BASKET` distinct lines, so the real
            // batch is 8 entries and this loop is 28 comparisons, not 2 016.
            for (uint256 j; j < i; ++j) {
                if (stocks[j] == stocks[i]) revert DuplicateStock(stocks[i]);
            }
            (uint256 owed, uint256 backing) = _one(account, stocks[i], cumulative[i], proofs[i], root);
            delivered += owed;
            moved += backing;
        }
    }

    /// @dev One stock. Three bounds, in this order:
    ///        1. the proof must verify against the active root;
    ///        2. we only pay `cumulative - already paid` — replaying an old
    ///           proof therefore pays nothing, and a root that LOWERS a
    ///           cumulative simply pays zero instead of underflowing;
    ///        3. we never pay more than this stock received, which bounds the
    ///           damage of an inflated root to that stock's scale.
    function _one(address account, address stock, uint256 cumulative, bytes32[] calldata proof, bytes32 root)
        internal
        returns (uint256, uint256)
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, stock, cumulative))));
        if (!_verify(proof, root, leaf)) revert InvalidProof();

        uint256 paid = claimedSoFar[account][stock];
        if (cumulative <= paid) return (0, 0);
        uint256 owed = cumulative - paid;

        // **The only bound on a false root, and it is this one line.** It is
        // the stock's whole undelivered balance, not one window's: see
        // `quoteAtRisk` above for why the two are not the same number and for
        // what the difference is made of. Narrowing it is not possible without
        // narrowing an honest holder's claim by exactly as much — the contract
        // cannot tell a thief's leaf from a dormant holder's, both being "an
        // account owed a lot of undelivered stock" (`docs/AUDIT_FIXES.md` §2.1).
        uint256 remaining = totalFunded[stock] - totalDistributed[stock];
        if (owed > remaining) owed = remaining;
        if (owed == 0) return (0, 0);

        // Nothing is recorded before a transfer succeeds: a paused token or a
        // blocklisted address must never burn an entitlement (§S4).
        if (!_tryTransfer(stock, account, owed)) {
            emit DeliveryFailed(account, stock, owed);
            return (0, 0);
        }

        claimedSoFar[account][stock] = paid + owed;
        totalDistributed[stock] += owed;

        // What was just delivered can no longer be siphoned: we remove its ETH
        // equivalent. Without this line `quoteAtRisk` would only ever rise, and
        // would end up as uninformative as a constant.
        uint256 backing = (owed * quoteFundedFor[stock]) / totalFunded[stock];
        quoteAtRisk = backing >= quoteAtRisk ? 0 : quoteAtRisk - backing;
        emit Delivered(account, stock, msg.sender, owed);
        // `backing` leaves with the amount: it is what `distribute` bounds its
        // refund by, and computing it twice would be the second place it could
        // drift.
        return (owed, backing);
    }

    function _tryTransfer(address stock, address to, uint256 amount) internal returns (bool) {
        try IERC20(stock).transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------- 5. timelock

    /// @notice Snapshot exclusion list. ON-CHAIN by design: in a config file,
    ///         "anyone can recompute the root" would be false (§S5).
    ///
    /// @dev    A change takes effect at the NEXT epoch, and the date is written
    ///         into the log. Without that, the exclusion set would depend on
    ///         WHEN you replay: two honest verifiers straddling a `setExcluded`
    ///         would produce different roots for the same epoch.
    ///
    ///         The current epoch is never rewritten: by the time of the call,
    ///         shares may already have been computed for it. And since the
    ///         timelock announces the change 48 h ahead, shifting by one 30-min
    ///         epoch surprises nobody.
    function setExcluded(address[] calldata accounts, bool state) external {
        if (msg.sender != TIMELOCK) revert NotTimelock();
        uint48 from = uint48(currentEpoch() + 1);
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            if (a == address(0)) continue;
            if (state && !isExcluded[a]) _excludedEver.push(a);
            isExcluded[a] = state;
            _exclusionLog.push(ExclusionChange({account: a, state: state, fromEpoch: from}));
        }
        emit ExcludedSet(accounts, state, from);
    }

    /// @notice The full log. `fromEpoch` is non-decreasing — `currentEpoch()`
    ///         never goes backwards — so a replay can stop at the first entry
    ///         past the target epoch.
    function exclusionLog() external view returns (ExclusionChange[] memory) {
        return _exclusionLog;
    }

    /// @notice Exclusion set in effect at `epoch`, rebuilt on-chain. A
    ///         convenience for a front end or a cross-check: the reference
    ///         replay is the one in `offchain/src/snapshot.ts`.
    function isExcludedAt(address account, uint256 epoch) external view returns (bool state) {
        uint256 n = _exclusionLog.length;
        for (uint256 i; i < n; ++i) {
            ExclusionChange storage c = _exclusionLog[i];
            if (c.fromEpoch > epoch) break;
            if (c.account == account) state = c.state;
        }
    }

    function excludedList() external view returns (address[] memory) {
        return _excludedEver;
    }

    // -------------------------------------------------------------- internals

    /// @dev Whether the vault's registry names `who` as a keeper. Reached only
    ///      when the pinned key did not match, so the nominal path never pays
    ///      for these two calls — and a registry that reverts is a `false`, not
    ///      a revert: an unreachable registry must not be able to stop the
    ///      pinned keeper, which the caller has already failed to be.
    function _registryAllows(address who) internal view returns (bool) {
        address reg = _registry();
        if (reg == address(0)) return false;
        (bool ok, bytes memory ret) = reg.staticcall(abi.encodeWithSignature("isKeeper(address)", who));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    /// @dev The registry our vault belongs to, or zero. Read on demand and
    ///      never stored: the vault already holds it, and a copy here would be
    ///      one more thing that can fall out of step. Only `setKeeper` calls
    ///      this — the nominal path still reads one slot.
    function _registry() internal view returns (address reg) {
        (bool ok, bytes memory ret) = FEE_VAULT.staticcall(abi.encodeWithSignature("REGISTRY()"));
        if (ok && ret.length == 32) reg = abi.decode(ret, (address));
    }

    /// @dev True cost priced at `block.basefee` — which the caller does not
    ///      choose — plus a margin, capped, and never blocking: an empty reserve
    ///      means no refund, not a revert (§S8).
    ///
    /// @param ceiling What the call MOVED will bear (`REFUND_VALUE_BPS` of it),
    ///        or `type(uint256).max` on a path that moves nothing and is
    ///        bounded some other way. Before it, the only relation between a
    ///        refund and its delivery was that both happened.
    function _refund(uint256 g0, uint256 ceiling) internal {
        uint256 owed = ((g0 - gasleft() + REFUND_OVERHEAD) * block.basefee * (BPS + PUSH_MARGIN_BPS)) / BPS;
        if (owed > ceiling) owed = ceiling;
        if (owed > MAX_REFUND) owed = MAX_REFUND;
        // Only the free part of the balance: what is already owed to a
        // deferred payee is not ours to hand out.
        uint256 bal = address(this).balance;
        uint256 held = pendingTotal;
        bal = bal > held ? bal - held : 0;
        if (owed > bal) owed = bal;
        if (owed == 0) return;
        _pay(msg.sender, owed);
        emit GasRefunded(msg.sender, owed);
    }

    /// @dev Best-effort payment: on failure the amount is set aside and stays
    ///      withdrawable. Neither lost, nor blocking.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 30_000}("");
        if (ok) return;
        pendingWithdrawal[to] += amount;
        pendingTotal += amount;
        emit PaymentDeferred(to, amount);
    }

    /// @notice Withdraw what could not be paid directly. Open to anyone, for
    ///         their own balance.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawal[msg.sender];
        if (amount == 0) revert NothingDelivered();
        pendingWithdrawal[msg.sender] = 0;
        pendingTotal -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == root;
    }

    // ------------------------------------------------------------------ views

    /// @notice Epochs waiting for a purchase: from `nextEpoch` to the last one
    ///         that has finished. Zero means everything closed is bought.
    ///
    /// @dev    What the keeper watches, and what the front turns into "the next
    ///         basket covers N epochs". The per-epoch reads that used to sit
    ///         here (`epochStock`, `epochFunded`, `epochEthSpent`) are gone with
    ///         the per-epoch struct: a window buys the whole basket, so there is
    ///         no such thing as an epoch's stock any more. Amounts are in the
    ///         `WindowFunded` logs.
    function pendingEpochs() external view returns (uint256) {
        uint256 cur = currentEpoch();
        if (cur == 0) return 0;
        uint256 lastClosed = cur - 1;
        return lastClosed < nextEpoch ? 0 : lastClosed - nextEpoch + 1;
    }

    /// @notice What is still owed to `holder` for `stock`, given a root
    ///         cumulative. Used by the front end to only send stocks worth
    ///         sending.
    function owedTo(address holder, address stock, uint256 cumulative) external view returns (uint256) {
        uint256 paid = claimedSoFar[holder][stock];
        if (cumulative <= paid) return 0;
        uint256 owed = cumulative - paid;
        uint256 remaining = totalFunded[stock] - totalDistributed[stock];
        return owed > remaining ? remaining : owed;
    }
}
