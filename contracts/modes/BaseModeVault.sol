// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IPoolManager,
    IPonsV2MemeHookSource,
    IPonsV2MemeHook,
    IERC20,
    IPonsV2LauncherToken,
    IPonsV2FeeEscrow,
    IPonsV2LaunchFactory,
    IPonsV2BondingCurve,
    IAggregatorV3,
    IPayd
} from "../interfaces/IExternal.sol";
import {FeeVault} from "../FeeVault.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @dev The surface `migrate` needs on a DESTINATION vault. Declared as an
///      interface rather than a cast to this type, because the destination may
///      be a vault of another mode — a `FeeVault`, say — and pretending
///      otherwise would hide exactly the case the check is there to bound.
interface IMigrationTarget {
    function LAUNCHER() external view returns (address);
    function INTENDED_TOKEN() external view returns (address);
    function QUOTE() external view returns (address);
    function PLATFORM_BPS() external view returns (uint256);
    function rewardsBps() external view returns (uint256);
    function bind(address token) external;
    function fundRewards() external payable returns (uint256);
    function fundPivot() external returns (uint256);
}

/// @title  BaseModeVault — everything a payout mode does NOT get to invent
///
/// @notice `FeeVault` minus its payout. Fork this, inherit it, and write the one
///         thing your mode is actually about: what happens to `rewardsPool`.
///
/// @dev    **What was removed, and why it is the whole of the second mode.**
///         `FeeVault` is 23 420 bytes of runtime against a 24 576 cap, and
///         roughly a quarter of its source — `buyBasket`, `_buyLegs`,
///         `_swapLeg`, `_legFloor`, `_oracleOut*`, `_toPivot`, `_route`,
///         `_setAllocations`, plus `TwapFloor`/`FullMath`/`TickMath` — exists
///         only to turn the holders' share into a basket of stocks. That is the
///         distribution mode, not the platform. It is gone from here, which is
///         also what leaves you the bytes to write your own.
///
///         **Everything below is kept verbatim on purpose.** The Pons claim,
///         the three-way split, the deferred-payment pattern, the gas refund
///         and its cap, `migrate` and the reserve it carries — these are the
///         subtle parts, and re-typing them is where bugs come from. Change
///         them only with a reason you can write down.
///
///         **Three floors this base still enforces, and your mode inherits:**
///         holders ≥ `MIN_REWARDS_BPS`, platform ≤ `MAX_PLATFORM_BPS`, and the
///         three shares are a partition of what arrives. Nothing outside this
///         contract checks them — `Payd` validates arguments, never code — so
///         a mode that deletes these lines is admitted exactly the same.
///
///         **What `Payd` still imposes, and it is short on purpose.** The
///         registry is an interface over factories, not a mode: it stamps
///         `isVault`/`modeOf`, caps `platformBps` at 15 %, and requires the
///         quote to be on the quote allowlist when it is not native ETH. That
///         is all.
///           - the basket is OPTIONAL. Pass `[]` and nothing is checked. Pass a
///             non-empty one and every entry must be on the stock allowlist
///             with the listed `poolFee` and `feed` — the list is governance's,
///             so the registry still holds you to it;
///           - `epochLength` is unbounded here. `DistributionFactory` bounds it
///             because ITS Distributor has epochs; a mode without them never
///             reads the argument.
///
///         Deployment: see `script/DeployMode.s.sol`.
abstract contract BaseModeVault {
    // ----------------------------------------------------------------- errors

    error AlreadyBound();
    error NotOurLaunch();
    error UnsupportedPair(address pairToken);
    error BadQuote();
    error NotTimelock();
    error NothingToDo();
    error PoolNotReady();
    error Reentrancy();
    error ZeroAddress();
    error TransferFailed();
    error BadSplit();
    error BadRate();
    error AlreadyInitialised();
    error NotCreator();
    error StillHooked();
    error NotAVault();
    error NotOurMode();
    error AlreadyMigrated();
    /// @dev Raise it from `_initMode` for a `modeData` your mode did not ask for.
    error UnexpectedModeData();

    // ----------------------------------------------------------------- events

    event Harvested(uint256 gross, uint256 refund, uint256 toRewards, uint256 toCreator, uint256 toPlatform);
    event Migrated(address indexed to);
    event ReserveMoved(address indexed to, uint256 quote, uint256 pivot);
    event CreatorPaid(address indexed to, uint256 amount);
    event PlatformPaid(address indexed to, uint256 amount);
    event RewardsBpsSet(uint256 from, uint256 to);
    event GasRefunded(address indexed to, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event RewardsFunded(address indexed from, uint256 amount);
    event PivotFunded(address indexed from, uint256 amount);
    event DistGasRateSet(uint256 bps);
    event KeeperBountyRateSet(uint256 bps);
    event DistributorFunded(uint256 amount);
    event FeesSwept(bool graduated);
    event HookLost(address indexed current, uint256 at);

    // ------------------------------------------------------ set once, at init
    //
    // A clone runs no constructor, so what would be `immutable` lives in
    // storage and `init` is the only writer. ALL_CAPS is a claim enforced by
    // the `initialised` guard, not by the compiler — keep a test on it.

    IPonsV2FeeEscrow public ESCROW;
    IPonsV2LaunchFactory public FACTORY;
    address public ROUTER;
    address public V3_FACTORY;
    address public WETH;
    address public PIVOT;
    uint256 public PIVOT_ONE;
    uint24 public ETH_PIVOT_FEE;
    IAggregatorV3 public ETH_USD;

    /// @notice The ONE currency this vault speaks. `address(0)` = native ETH.
    ///         Every number here is denominated in it.
    address public QUOTE;
    uint24 public QUOTE_FEE;
    uint24 public QUOTE_WETH_FEE;
    uint256 public MIN_BUY_QUOTE;

    address public CREATOR;
    address public PLATFORM;
    uint256 public PLATFORM_BPS;
    address public TIMELOCK;
    /// @notice Optional here, unlike in `FeeVault`: a mode with no second
    ///         contract passes `address(0)` and simply skips the gas slice.
    address public DISTRIBUTOR;
    address public LAUNCHER;
    address public REGISTRY;
    address public INTENDED_TOKEN;
    address public migratedTo;

    // -------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_PLATFORM_BPS = 1_500;
    uint256 public constant MIN_REWARDS_BPS = 5_000;
    uint256 public constant MAX_REFUND = 0.01 ether;
    uint256 internal constant REFUND_OVERHEAD = 40_000;
    /// @notice Ceiling on what a harvest's gas refund may take of the creator's
    ///         residue. Without it an escrow holding one wei converts the whole
    ///         residue into gas.
    uint256 public constant HARVEST_REFUND_BPS = 50;
    uint256 public constant MIN_DIST_GAS_BPS = 300;
    uint256 public constant MAX_DIST_GAS_BPS = 2_000;
    uint256 public constant MIN_BUY = 0.01 ether;

    /// @notice Bounds on `keeperBountyBps`. The same two `FeeVault` carries, and
    ///         for the same reason: the cost of a call is fixed while the bounty
    ///         is a share of an amount, so no constant covers $20k/day and
    ///         $500k/day at once. Erring low is the rule — under-paying degrades
    ///         to the keeper fronting its own gas, over-paying moves holders'
    ///         money.
    uint256 public constant MIN_KEEPER_BOUNTY_BPS = 10;
    uint256 public constant MAX_KEEPER_BOUNTY_BPS = 300;

    // ------------------------------------------------------------------ state

    IPonsV2LauncherToken public token;
    IPonsV2BondingCurve public curve;

    /// @notice **The hole.** What `harvest` sets aside for holders and what your
    ///         mode spends. Nothing in this base ever takes from it.
    uint256 public rewardsPool;
    uint256 public creatorPool;
    uint256 public platformPool;
    /// @notice Pivot currency held and promised to nothing. Zero for a mode
    ///         that never touches the pivot; kept because `migrate` carries it
    ///         and a vault of another mode may hand you one.
    uint256 public pivotReserve;

    mapping(address account => uint256) public pendingWithdrawal;
    /// @notice Sum of `pendingWithdrawal`: here physically, already owed.
    uint256 public pendingTotal;

    /// @notice The holders' share of the gross. Set at birth, only ever RAISED.
    uint256 public rewardsBps;
    /// @notice Share of rewards funding the cycle's gas, paid to `DISTRIBUTOR`.
    uint256 public distGasBps;
    /// @notice The in-kind bounty, in bps of what a call MOVED. Read only on a
    ///         vault whose `QUOTE` is not ether — see `_bounty`.
    uint256 public keeperBountyBps;
    /// @notice When `flagHookLost` first recorded a loss. 0 = never.
    uint64 public hookLostAt;

    uint256 private _lock;
    bool public initialised;

    enum Hook {
        Unbound,
        Hooked,
        Redirecting,
        Lost
    }

    // ------------------------------------------------------------- modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyTimelock() {
        if (msg.sender != TIMELOCK) revert NotTimelock();
        _;
    }

    // ----------------------------------------------------------- construction

    /// @notice Marks the IMPLEMENTATION as initialised, so only clones can be
    ///         configured.
    constructor() {
        initialised = true;
    }

    /// @notice Configures a fresh clone. Once, and only once.
    /// @dev    Keep this signature: it is what your factory calls right after
    ///         the clone, in the same transaction, so no window exists in which
    ///         an unconfigured vault sits there for someone else to claim.
    function init(VaultTypes.Config memory c, VaultTypes.Allocation[] memory basket, bytes memory modeData) external {
        if (initialised) revert AlreadyInitialised();
        initialised = true;

        // A clone inherits no field initialiser: storage starts at zero, so
        // `_lock = 0` would revert every `nonReentrant` call on its first use.
        _lock = 1;
        distGasBps = 300;
        keeperBountyBps = 70; // 0.70 % of what a call moves, the in-kind bounty

        if (
            c.escrow == address(0) || c.factory == address(0) || c.ethUsdFeed == address(0) || c.creator == address(0)
                || c.timelock == address(0) || c.deployer == address(0) || c.pivot == address(0)
        ) revert ZeroAddress();
        // A destination is only required if it gets paid: the platform token's
        // own vault is born at `platformBps = 0` and never pays the Treasury.
        if (c.platformBps != 0 && c.platform == address(0)) revert ZeroAddress();
        if (c.platformBps > MAX_PLATFORM_BPS) revert BadSplit();
        // The creator's share is the residue, so it is the one that can vanish.
        // Thin is allowed; not a partition is not.
        if (c.rewardsBps < MIN_REWARDS_BPS || c.rewardsBps + c.platformBps > BPS) revert BadSplit();

        ESCROW = IPonsV2FeeEscrow(c.escrow);
        FACTORY = IPonsV2LaunchFactory(c.factory);
        ROUTER = c.router;
        V3_FACTORY = c.v3Factory;
        WETH = c.weth;
        PIVOT = c.pivot;
        if (c.ethPivotFee == 0) revert BadQuote();
        ETH_PIVOT_FEE = c.ethPivotFee;
        ETH_USD = IAggregatorV3(c.ethUsdFeed);
        CREATOR = c.creator;
        PLATFORM = c.platform;
        PLATFORM_BPS = c.platformBps;
        rewardsBps = c.rewardsBps;
        TIMELOCK = c.timelock;
        DISTRIBUTOR = c.distributor;
        LAUNCHER = c.deployer;
        REGISTRY = c.registry;
        INTENDED_TOKEN = c.intendedToken;

        // The quote and the three shapes it can take. Checked here because
        // `init` runs once: a vault with a quote it cannot route would bind
        // happily and then fail every conversion, for good.
        QUOTE = c.quote;
        QUOTE_FEE = c.quoteFee;
        QUOTE_WETH_FEE = c.quoteWethFee;
        // `decimals()` is optional in ERC-20 and the pivot is not ours.
        PIVOT_ONE = 10 ** _staticUint(c.pivot, 0x313ce567, 6);
        if (c.quote == address(0) || c.quote == c.pivot) {
            if (c.quoteFee != 0 || c.quoteWethFee != 0) revert BadQuote();
        } else if (c.quoteFee != 0 && c.quoteWethFee != 0) {
            // Both: the contract would be choosing in place of whoever did the
            // measuring.
            //
            // **Neither is allowed here, and `FeeVault` refuses it.** Two tiers
            // at zero declare a quote with NO Uniswap v3 route — which is what
            // a mode settling on v4, or paying without a swap at all, wants.
            // **If your mode swaps on v3, restore the stricter form**:
            //
            //     } else if ((c.quoteFee == 0) == (c.quoteWethFee == 0)) {
            //
            // A vault born with a route it cannot take binds happily and then
            // fails every conversion, for good.
            revert BadQuote();
        }
        MIN_BUY_QUOTE = c.minBuy;
        if (MIN_BUY_QUOTE == 0) {
            if (c.quote != address(0)) revert BadQuote();
            MIN_BUY_QUOTE = MIN_BUY;
        }

        _initMode(basket, modeData);
    }

    /// @notice **Your mode's slice of `init`.** Empty here.
    ///
    /// @dev    `basket` is whatever the registry let through: empty, or entries
    ///         it has already checked against the stock allowlist.
    ///
    ///         `modeData` is the launcher's per-launch parameter, forwarded by
    ///         `Payd.createVaultWith` and never decoded by it — this is where
    ///         you `abi.decode` it. **Refuse what you do not expect**: a mode
    ///         that silently ignores a non-empty `modeData` lets a launcher
    ///         believe they configured something.
    function _initMode(VaultTypes.Allocation[] memory basket, bytes memory modeData) internal virtual {}

    // ------------------------------------------------------------ funding in

    /// @dev The escrow pays with `call{value:}` and no gas limit. Plain ETH
    ///      landing here is NOT credited: this is also where `ESCROW.claim()`
    ///      lands, and crediting from inside would count the same wei twice.
    ///      `fundRewards()` is the way in.
    receive() external payable {}

    /// @notice Credits everything held here that belongs to no bucket — a
    ///         donation, a stray transfer, this call's own `msg.value` — to
    ///         `rewardsPool`. Permissionless and destination-free: it moves
    ///         nothing out, it only re-labels what is already here.
    function fundRewards() external payable nonReentrant returns (uint256 credited) {
        uint256 committed = rewardsPool + creatorPool + platformPool + pendingTotal;
        // On a vault quoted IN the pivot both pockets share one balance, and
        // `pivotReserve` is not ours to re-credit.
        if (QUOTE == PIVOT) committed += pivotReserve;
        uint256 bal = QUOTE == address(0) ? address(this).balance : IERC20(QUOTE).balanceOf(address(this));
        credited = bal > committed ? bal - committed : 0;
        if (credited == 0) revert NothingToDo();
        rewardsPool += credited;
        emit RewardsFunded(msg.sender, credited);
    }

    /// @notice `fundRewards`'s counterpart for the pivot. A migration transfers
    ///         the old vault's pivot reserve here, and this is what books it.
    function fundPivot() external nonReentrant returns (uint256 credited) {
        uint256 booked = pivotReserve;
        if (QUOTE == PIVOT) booked += rewardsPool + creatorPool + platformPool + pendingTotal;
        uint256 held = IERC20(PIVOT).balanceOf(address(this));
        credited = held > booked ? held - booked : 0;
        if (credited == 0) revert NothingToDo();
        pivotReserve += credited;
        emit PivotFunded(msg.sender, credited);
    }

    // ------------------------------------------------------------------ bind

    /// @notice Binds the vault to its token. Callable by anyone, but the two
    ///         conditions are Pons's and neither is ours to satisfy: this
    ///         contract must already be the `creatorFeeRecipient`, and
    ///         `LAUNCHER` must be the token's Pons deployer. Once, for good.
    function bind(address token_) external {
        if (address(token) != address(0)) revert AlreadyBound();
        // A migration vault binds to ONE token, named before it existed.
        if (INTENDED_TOKEN != address(0) && token_ != INTENDED_TOKEN) revert NotOurLaunch();

        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(token_);
        if (
            !l.exists || l.token != token_ || l.deployer != LAUNCHER || l.creatorFeeRecipient != address(this)
                || l.curve == address(0)
        ) revert NotOurLaunch();
        // The escrow keeps ONE LEDGER PER CURRENCY, so a vault claiming the
        // wrong one sees zero while its fees pile up on a ledger it never
        // reads. Refusing here costs one reverted transaction and says so now;
        // the alternative says never.
        if (l.pairToken != QUOTE) revert UnsupportedPair(l.pairToken);

        token = IPonsV2LauncherToken(token_);
        curve = IPonsV2BondingCurve(l.curve);
    }

    // --------------------------------------------------------------- harvest

    /// @notice Pulls the creator fees out of the Pons escrow and splits them
    ///         three ways. Permissionless; this vault is the `msg.sender`
    ///         towards the escrow, so the money can only land here.
    ///
    /// @dev    After this returns, `rewardsPool` is your mode's to spend.
    function harvest() external nonReentrant returns (uint256 gross) {
        uint256 g0 = gasleft();

        _sweepFees();

        // One ledger per currency, and this vault reads exactly one.
        if (QUOTE == address(0)) {
            if (ESCROW.balanceOf(address(this)) == 0) revert NothingToDo();
            gross = ESCROW.claim();
        } else {
            if (ESCROW.balanceOfToken(address(this), QUOTE) == 0) revert NothingToDo();
            gross = ESCROW.claimToken(QUOTE);
        }
        if (gross == 0) revert NothingToDo();

        uint256 toPlatform = (gross * PLATFORM_BPS) / BPS;
        uint256 toRewards = (gross * rewardsBps) / BPS;
        uint256 toCreator = gross - toPlatform - toRewards; // the residue, rounding included

        // The refund comes out of the CREATOR's residue: whoever chose the
        // split carries the cost of running it.
        //
        // **On a non-ETH vault it is a BOUNTY, not a refund, and this line read
        // `: 0` until 2026-09-11.** `_refundAmount` computes wei and a vault
        // holding USDG or a stock has none, so the caller was paid nothing and
        // the cycle of every second mode was unfunded on 59.1 % of Pons volume
        // (22.0 % USDG + 37.2 % stock tokens, measured 2026-09-08 over seven
        // days of `V2FeeEscrow` credits). That is the exact condition
        // `docs/ARCHITECTURE.md` §S40 and `FLOWS.md` §4.3bis closed in
        // `FeeVault` and left open in the template every future mode copies:
        // nobody takes anything, the keeper simply stops, and the vault stops
        // with it (T-MODE-01).
        //
        // `keeperBountyBps` of the gross puts no oracle on the money path — the
        // gross is already denominated in `QUOTE`, so no price is read and none
        // can be manipulated — and the cap below is unchanged, so the creator's
        // residue bounds it exactly as it bounds the wei refund.
        uint256 refund = QUOTE == address(0) ? _refundAmount(g0) : _bounty(gross);
        // It CAPS and does not revert: refusing the harvest would hold the
        // holders' rewards hostage to the creator's residue.
        uint256 cap = (toCreator * HARVEST_REFUND_BPS) / BPS;
        if (refund > cap) refund = cap;
        toCreator -= refund;

        // Delivery money, a slice of REWARDS and not of the residue — it is
        // shipping, not a cut, and taking it from the residue would let a
        // creator at the ceiling switch off a delivery holders never asked to
        // lose. Skipped entirely when there is no second contract to fund, or
        // no wei to fund it with.
        uint256 toDist = (QUOTE == address(0) && DISTRIBUTOR != address(0)) ? (toRewards * distGasBps) / BPS : 0;
        if (toDist != 0) toRewards -= toDist;

        creatorPool += toCreator;
        platformPool += toPlatform;
        rewardsPool += toRewards;

        emit Harvested(gross, refund, toRewards, toCreator, toPlatform);
        if (toDist != 0) {
            _pay(DISTRIBUTOR, toDist, false);
            emit DistributorFunded(toDist);
        }
        if (refund != 0) _pay(msg.sender, refund, true);
    }

    // --------------------------------------------------------------- payouts

    /// @notice Pays the creator's residue. Permissionless: the destination is
    ///         written at birth and has no setter.
    function payCreator() external nonReentrant returns (uint256 amount) {
        amount = creatorPool;
        if (amount == 0) revert NothingToDo();
        creatorPool = 0;
        _pay(CREATOR, amount, false);
        emit CreatorPaid(CREATOR, amount);
    }

    /// @notice Pays the platform its fixed share. Same shape, same reason.
    function payPlatform() external nonReentrant returns (uint256 amount) {
        amount = platformPool;
        if (amount == 0) revert NothingToDo();
        platformPool = 0;
        _pay(PLATFORM, amount, false);
        emit PlatformPaid(PLATFORM, amount);
    }

    /// @notice Raises the holders' share. It only turns one way.
    function setRewardsBps(uint256 bps) external {
        if (msg.sender != CREATOR) revert NotCreator();
        uint256 from = rewardsBps;
        if (bps <= from || bps + PLATFORM_BPS > BPS) revert BadSplit();
        rewardsBps = bps;
        emit RewardsBpsSet(from, bps);
    }

    function setDistGasBps(uint256 bps) external onlyTimelock {
        if (bps < MIN_DIST_GAS_BPS || bps > MAX_DIST_GAS_BPS) revert BadRate();
        distGasBps = bps;
        emit DistGasRateSet(bps);
    }

    /// @notice Reweights the in-kind bounty. Timelock, bounded, and it reaches
    ///         only vaults whose `QUOTE` is not ether — on an ether vault the
    ///         refund is the real cost at `block.basefee` and this is unread.
    function setKeeperBountyBps(uint256 bps) external onlyTimelock {
        if (bps < MIN_KEEPER_BOUNTY_BPS || bps > MAX_KEEPER_BOUNTY_BPS) revert BadRate();
        keeperBountyBps = bps;
        emit KeeperBountyRateSet(bps);
    }

    // --------------------------------------------------------------- migrate

    /// @notice Redirects this vault's FUTURE stream to another vault of this
    ///         registry, and carries the unconverted reserve with it.
    ///
    /// @dev    The only destination check worth anything is `Payd.isVault`,
    ///         written by `Payd._create` and by nothing else. Everything read
    ///         off the destination itself is written by the destination itself
    ///         — the checks below bound an honest migration, not a hostile one.
    ///         `creatorPool` and `platformPool` stay: they are owed to
    ///         immutable addresses and `payCreator`/`payPlatform` keep working
    ///         on this vault for ever.
    function migrate(address newVault) external nonReentrant onlyTimelock {
        if (address(token) == address(0)) revert NotOurLaunch();
        if (migratedTo != address(0)) revert AlreadyMigrated();

        if (REGISTRY == address(0) || !IPayd(REGISTRY).isVault(newVault)) revert NotAVault();

        IMigrationTarget v = IMigrationTarget(newVault);
        // The same token, and the same hand behind it.
        if (v.LAUNCHER() != LAUNCHER || v.INTENDED_TOKEN() != address(token)) revert NotOurLaunch();
        // Holders never lose by moving, and neither does the platform's promise.
        if (v.rewardsBps() < rewardsBps || v.PLATFORM_BPS() > PLATFORM_BPS) revert BadSplit();
        // The same currency. `bind` below would refuse a mismatch anyway and
        // take the migration down AFTER the recipient had already moved.
        if (v.QUOTE() != QUOTE) revert BadQuote();
        // The same promise. `isVault` says the destination was born here; it
        // does not say it pays the same way.
        if (
            IPayd(REGISTRY).modeOf(newVault) != IPayd(REGISTRY).modeOf(address(this))
                && !IPayd(REGISTRY).crossModeMigration()
        ) revert NotOurMode();

        migratedTo = newVault;
        // Immediate: this vault is the current recipient, which is the one role
        // the factory accepts here.
        FACTORY.transferCreatorFeeRecipient(address(token), newVault);
        // Atomic — a gap would leave a bound-to-nothing vault for anyone to race.
        v.bind(address(token));

        emit Migrated(newVault);
        _moveReserve(v);
    }

    /// @dev The cash. Pivot first: on a pivot-quoted vault the `fundRewards`
    ///      that follows counts the balance minus what is already promised.
    ///      Both go through the destination's CREDITING functions, never a bare
    ///      transfer, which would leave money in a balance nothing spends.
    function _moveReserve(IMigrationTarget v) internal {
        uint256 pivotOut = pivotReserve;
        if (pivotOut != 0) {
            pivotReserve = 0;
            if (!_send(PIVOT, address(v), pivotOut)) revert TransferFailed();
            v.fundPivot();
        }

        uint256 quoteOut = rewardsPool;
        if (quoteOut != 0) {
            rewardsPool = 0;
            if (QUOTE == address(0)) {
                v.fundRewards{value: quoteOut}();
            } else {
                if (!_send(QUOTE, address(v), quoteOut)) revert TransferFailed();
                v.fundRewards();
            }
        }

        emit ReserveMoved(address(v), quoteOut, pivotOut);
    }

    // ------------------------------------------------------------- internals

    /// @dev True cost priced at `block.basefee`, which the caller does not
    ///      choose, and capped.
    /// @dev `keeperBountyBps` of what a call moved, capped at `MIN_BUY_QUOTE`.
    ///      The twin of `FeeVault._bounty`, and deliberately the same shape: a
    ///      mode that changes it should know it is diverging.
    function _bounty(uint256 moved) internal view returns (uint256 owed) {
        owed = (moved * keeperBountyBps) / BPS;
        if (owed > MIN_BUY_QUOTE) owed = MIN_BUY_QUOTE;
    }

    function _refundAmount(uint256 g0) internal view returns (uint256 owed) {
        uint256 used = g0 - gasleft() + REFUND_OVERHEAD;
        owed = used * block.basefee;
        if (owed > MAX_REFUND) owed = MAX_REFUND;
    }

    /// @dev Pull-based payment. A payment that fails must never cancel the
    ///      action that triggered it: `CREATOR` is immutable and there is no
    ///      owner, so a payee that became unable to receive would otherwise
    ///      block `payCreator` for ever.
    function _pay(address to, uint256 amount, bool isRefund) internal {
        if (amount == 0) return;
        bool ok;
        if (QUOTE == address(0)) {
            (ok,) = to.call{value: amount, gas: 30_000}("");
        } else {
            ok = _send(QUOTE, to, amount);
        }
        if (ok) {
            if (isRefund) emit GasRefunded(to, amount);
            return;
        }
        pendingWithdrawal[to] += amount;
        pendingTotal += amount;
        emit PaymentDeferred(to, amount);
    }

    /// @dev An ERC-20 `transfer` that cannot take a payout down with it. Tokens
    ///      returning nothing are accepted, tokens returning `false` are not —
    ///      either way the amount falls back to `pendingWithdrawal`.
    function _send(address erc20, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) =
            erc20.call{gas: 100_000}(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @notice Withdraw a payment that could not go through. Open to anyone,
    ///         each for their own balance, and it takes no destination — which
    ///         is what lets `Treasury.collectFrom` recover a platform payment.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawal[msg.sender];
        if (amount == 0) revert NothingToDo();
        pendingWithdrawal[msg.sender] = 0;
        pendingTotal -= amount;
        bool ok;
        if (QUOTE == address(0)) {
            (ok,) = msg.sender.call{value: amount}("");
        } else {
            ok = _send(QUOTE, msg.sender, amount);
        }
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @dev Pushes our accrued fees from Pons to the escrow so `harvest` can
    ///      claim them in the same transaction. **Never reverts the harvest**:
    ///      not graduated, unknown to the hook, nothing pending, or pending in
    ///      the memecoin are all normal, and cost one failed call.
    function _sweepFees() internal {
        if (address(token) == address(0) || address(curve) == address(0)) return;

        if (!curve.graduated()) {
            try curve.sweepFees(0) {
                emit FeesSwept(false);
            } catch {}
            return;
        }

        try this.poolKey() returns (IPoolManager.PoolKey memory key) {
            try IPonsV2MemeHook(key.hooks).sweepPoolFees(keccak256(abi.encode(key)), 0, 0) {
                emit FeesSwept(true);
            } catch {}
        } catch {}
    }

    /// @dev External only so `_sweepFees` can wrap it in `try`; a plain
    ///      internal revert would take the whole harvest down with it.
    function poolKey() external view returns (IPoolManager.PoolKey memory) {
        return _poolKey();
    }

    function _poolKey() internal view returns (IPoolManager.PoolKey memory key) {
        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(address(token));
        if (l.pairToken != QUOTE) revert PoolNotReady();
        // Uniswap v4 sorts the pair by address, and native ETH always lands first.
        (address c0, address c1) = QUOTE < address(token) ? (QUOTE, address(token)) : (address(token), QUOTE);
        key = IPoolManager.PoolKey({
            currency0: c0,
            currency1: c1,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: IPonsV2MemeHookSource(address(FACTORY)).memeHook()
        });
    }

    function _staticUint(address target, bytes4 selector, uint256 fallbackValue) internal view returns (uint256) {
        (bool ok, bytes memory ret) = target.staticcall{gas: 30_000}(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return fallbackValue;
        return abi.decode(ret, (uint256));
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether the fees still come here. `token != 0` does not mean
    ///         they do: `bind` is one-shot and never re-checks.
    function hookStatus() public view returns (Hook status, address current, uint64 effectiveAt) {
        if (address(token) == address(0)) return (Hook.Unbound, address(0), 0);

        current = FACTORY.getLaunchedToken(address(token)).creatorFeeRecipient;
        if (current != address(this)) return (Hook.Lost, current, 0);

        (address pending, uint256 at, uint256 expires) = FACTORY.pendingCreatorFeeRecipient(address(token));
        // A proposal past its window is dead, not pending.
        if (pending != address(0) && block.timestamp <= expires) {
            return (Hook.Redirecting, pending, uint64(at));
        }
        return (Hook.Hooked, current, 0);
    }

    /// @notice Puts on record that the fees no longer come here. Informational
    ///         and deliberately not a switch: the vault keeps running on its
    ///         reserve. Permissionless, because noticing is the only defence.
    function flagHookLost() external {
        (Hook status, address current,) = hookStatus();
        if (status != Hook.Lost) revert StillHooked();
        if (hookLostAt == 0) hookLostAt = uint64(block.timestamp);
        emit HookLost(current, block.timestamp);
    }

    /// @notice What this vault really takes, in points of the token's VOLUME,
    ///         derived from Pons's live parameters. Every read DEGRADES: a Pons
    ///         upgrade that moves a getter returns zeroes rather than reverting.
    ///         A real `curveFeeBps` is never 0 — that is the caller's signal.
    function economics()
        external
        view
        returns (
            uint256 taxBps,
            uint256 curveFeeBps,
            uint256 ponsShareBps,
            uint256 grossOfVolumeBps,
            uint256 rewardsOfVolumeBps,
            uint256 creatorOfVolumeBps,
            uint256 platformOfVolumeBps
        )
    {
        if (address(token) != address(0)) {
            taxBps = FACTORY.getLaunchedToken(address(token)).creatorTaxBps;
        }
        curveFeeBps = _curveFeeBps();
        ponsShareBps = _ponsShareBps();
        if (curveFeeBps == 0) return (taxBps, 0, ponsShareBps, 0, 0, 0, 0);

        grossOfVolumeBps = taxBps + (curveFeeBps * (BPS - ponsShareBps)) / BPS;
        rewardsOfVolumeBps = (grossOfVolumeBps * rewardsBps) / BPS;
        platformOfVolumeBps = (grossOfVolumeBps * PLATFORM_BPS) / BPS;
        // The residue, exactly as `harvest` computes it.
        creatorOfVolumeBps = grossOfVolumeBps - rewardsOfVolumeBps - platformOfVolumeBps;
    }

    /// @dev Second word of `getLaunchConfig(0)`, read BY POSITION: the deployed
    ///      factory returns 7 words where the local source described 10 fields.
    function _curveFeeBps() internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            address(FACTORY).staticcall{gas: 60_000}(abi.encodeWithSelector(bytes4(0x1cad862d), uint256(0)));
        if (!ok || ret.length < 64) return 0;
        (, uint256 curveFee) = abi.decode(ret, (uint256, uint256));
        return curveFee;
    }

    /// @dev Pons's cut of the curve fee, on the HOOK and not on the factory.
    function _ponsShareBps() internal view returns (uint256) {
        address hook = address(uint160(_staticUint(address(FACTORY), IPonsV2MemeHookSource.memeHook.selector, 0)));
        if (hook == address(0)) return 0;
        uint256 share = _staticUint(hook, bytes4(0x9040f866), BPS + 1);
        return share > BPS ? 0 : share;
    }
}
