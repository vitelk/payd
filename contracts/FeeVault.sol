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

import {
    IPoolManager,
    IPonsV2MemeHookSource,
    IPonsV2MemeHook,
    IERC20,
    IPonsV2LauncherToken,
    IPonsV2FeeEscrow,
    IPonsV2LaunchFactory,
    IPonsV2BondingCurve,
    ISwapRouter02,
    IUniswapV3Factory,
    IAggregatorV3,
    IDistributor,
    IPayd
} from "./interfaces/IExternal.sol";
import {VaultTypes} from "./interfaces/VaultTypes.sol";
import {TwapFloor} from "./libraries/TwapFloor.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title  FeeVault
/// @notice Recipient of the token's creator fees on Pons v2, in the ONE
///         currency the launch is quoted in (§S40). Splits what arrives three
///         ways, converts the rewards share into the whole stock basket in one
///         purchase (§S41), and has the router deliver it to the Distributor.
///
/// @dev    Decisions and measurements: docs/recon.md and docs/ARCHITECTURE.md.
///
///         No owner. The timelock can only:
///           - reweight the Allocations (§S10)
///           - set the payout rate per epoch
///           - size the gas reserve that funds deliveries
///         It can never withdraw funds: no `withdraw` exists for it.
///
///         Every cycle action — `harvest`, `buyBasket`, `payCreator`,
///         `payPlatform` — is callable by anyone. A hostile caller can only make their own transaction fail;
///         they can neither divert funds nor worsen a price (§S3).
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract FeeVault {
    // ------------------------------------------------------------------ types

    /// @dev The three parallel arrays `fundWindow` takes, carried together so
    ///      `_buyLegs` stays under the stack limit.
    struct Legs {
        address[] stocks;
        uint256[] outs;
        uint256[] quote;
        /// @dev The share of a leg that IS the vault's own currency, kept in
        ///      QUOTE instead of making the round trip through the pivot. In
        ///      the struct and not a parameter: `_buyLegs` is already at the
        ///      edge of the stack.
        uint256 direct;
        uint256 directBps;
    }

    // ----------------------------------------------------------------- errors

    error AlreadyBound();
    error NotBound();
    error NotOurLaunch();
    error UnsupportedPair(address pairToken);
    error BadQuote();
    error NotTimelock();
    error BadWeights();
    error NothingToDo();
    error NoPool();
    error PoolNotReady();
    error MinOutZero();
    error TooLittleOut(uint256 got, uint256 floor);
    error Reentrancy();
    error ZeroAddress();
    error TransferFailed();
    error BelowMinBuy(uint256 have, uint256 need);
    error BadPayoutRate();
    error BadSplit();
    error AlreadyInitialised();
    error NotCreator();
    error StillHooked();
    error NotAVault();
    error NotOurMode();
    error AlreadyMigrated();

    // ----------------------------------------------------------------- events

    event Harvested(uint256 gross, uint256 refund, uint256 toRewards, uint256 toCreator, uint256 toPlatform);
    /// @notice This vault's future fee stream now goes to `to`. What it already
    ///         holds stays here, and stays claimable.
    event Migrated(address indexed to);
    /// @notice One purchase of the whole basket, covering every epoch up to
    ///         `toEpoch`.
    event BasketBought(uint256 indexed toEpoch, uint256 quoteIn, uint256 usdgIn, uint256 legsBought);
    /// @notice A leg the market could not fill. Its USDG waits for the next
    ///         purchase; nothing is lost and nothing else was blocked.
    event LegSkipped(address indexed stock, uint256 usdgHeld);
    event CreatorPaid(address indexed to, uint256 amount);
    event PlatformPaid(address indexed to, uint256 amount);
    /// @notice The creator raised the holders' share. It can only ever go up.
    event RewardsBpsSet(uint256 from, uint256 to);
    event AllocationsSet(VaultTypes.Allocation[] allocations);
    event GasRefunded(address indexed to, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event PayoutRateSet(uint256 bps);
    /// @notice Someone put ETH in that did not come from the creator fees, and
    ///         it was credited to the rewards reserve — where the epochs spend
    ///         it exactly like fee revenue.
    event RewardsFunded(address indexed from, uint256 amount);
    /// @notice Pivot currency came in without going through a purchase, and
    ///         joins the reserve the next leg spends.
    event PivotFunded(address indexed from, uint256 amount);
    /// @notice What the migration CARRIED with it: the currency not yet spent
    ///         and the pivot reserve. Not one stock — those are promised by an
    ///         already-published root and stay at the Distributor.
    event ReserveMoved(address indexed to, uint256 quote, uint256 pivot);
    event DistGasRateSet(uint256 bps);
    event KeeperBountyRateSet(uint256 bps);
    event DistributorFunded(uint256 amount);

    /// @notice This vault pushed its own pending fees to the escrow, rather than
    ///         waiting for the Pons operator. `graduated` says which side they
    ///         came from: the v4 hook, or the bonding curve.
    event FeesSwept(bool graduated);
    event OracleDivergence(address indexed stock, uint256 twapOut, uint256 oracleOut);

    /// @notice Somebody put on record that this vault is no longer the launch's
    ///         fee recipient. Informational: nothing stops, nothing unlocks.
    event HookLost(address indexed current, uint256 at);

    // ------------------------------------------------------ set once, at init
    //
    // These were `immutable` while the vault was deployed by a constructor. A
    // clone has no constructor, so they live in storage — and `init` is the
    // only function that writes them, once, guarded. The guarantee the ALL_CAPS
    // still claims is therefore enforced rather than structural, and
    // `test_InitHappensOnceAndOnlyOnce` is what enforces it.

    IPonsV2FeeEscrow public ESCROW;
    IPonsV2LaunchFactory public FACTORY;
    ISwapRouter02 public ROUTER;
    IUniswapV3Factory public V3_FACTORY;
    address public WETH;
    /// @notice **The currency everything routes through.** It is called
    ///         `PIVOT` and not `USDG` because it is a PARAMETER, not a
    ///         constant: it is written at `init` from the registry's config,
    ///         and a registry deployed with another value builds vaults that
    ///         pivot elsewhere. On Robinhood Chain it is USDG, because that is
    ///         where the stocks' liquidity sits — measured, not assumed
    ///         (`docs/recon.md` §4.1). The day that stops being true, `migrate`
    ///         moves a vault to a successor that pivots elsewhere, one at a
    ///         time, under the timelock: it does not compare pivots.
    address public PIVOT;

    /// @notice **The one currency this vault speaks.** `address(0)` for native
    ///         ETH, otherwise the ERC-20 the launch is quoted in.
    ///
    /// @dev    Pons takes `pairToken` as an argument of `launchToken`, and
    ///         40.9 % of its volume is quoted in ETH, 22.0 % in USDG and 37.2 %
    ///         in stock tokens (seven days of `V2FeeEscrow` credits, measured
    ///         2026-09-08). v1 refused everything but ETH and left three fifths
    ///         of the market unreachable.
    ///
    ///         **One quote per vault, declared at birth and never changed.**
    ///         Every number in this contract — the three pools, the pending
    ///         withdrawals, `MIN_BUY_QUOTE` — is denominated in it, so a vault
    ///         that could switch would be a vault whose books mean two
    ///         different things at two different times. `bind` is where that is
    ///         enforced, and it is the only place that can be.
    address public QUOTE;

    /// @notice One whole USDG, in raw units. Read from the token at `init`
    ///         rather than written as 1e6: it is somebody else's decimal.
    uint256 public PIVOT_ONE;

    /// @notice Fee tier of the `QUOTE`/USDG pool. Zero when there is no hop to
    ///         make — a vault quoted in ETH (which routes through WETH at
    ///         `ETH_PIVOT_FEE`) or in USDG itself.
    uint24 public QUOTE_FEE;

    /// @notice Tier of the `QUOTE`/WETH pool, and **the fallback route when
    ///         the pivot has none.**
    ///
    /// @dev    A currency can be deeply traded and invisible against the pivot.
    ///         Measured 2026-09-08 on the pairs Pons actually uses:
    ///
    ///             COIN    no pivot pool at all    WETH tier 3000    $33 144
    ///             cbBTC   no pivot pool at all    WETH tier 3000   $158 774
    ///
    ///         Between them, 198 of the week's ~220 credits among the
    ///         out-of-reach pairs. The detour's first hop is the same
    ///         WETH/PIVOT pool an ETH-quoted vault already uses — tier 100,
    ///         $2 790 608 of depth.
    ///
    ///         **One route per vault, declared at birth, never guessed.**
    ///         Exactly one of the two tiers is non-zero: the route is the one
    ///         the timelock measured, not the one a `getPool` finds at the
    ///         moment the money moves. Same rule as `Allocation.poolFee` — the
    ///         likeliest mistake is the right token at the wrong tier, and
    ///         probing does not catch it.
    uint24 public QUOTE_WETH_FEE;

    /// @notice `MIN_BUY`, expressed in `QUOTE` units.
    ///
    /// @dev    A constant in wei cannot serve three currencies: 0.01 ether of
    ///         raw USDG (6 decimals) is ten billion dollars, and of raw NVDA
    ///         (18 decimals) about two dollars. The Payd sets it from the
    ///         quote's listing; an ETH vault gets `MIN_BUY` and nothing to
    ///         think about.
    uint256 public MIN_BUY_QUOTE;
    IAggregatorV3 public ETH_USD;
    address public CREATOR;
    /// @notice Where the platform's fixed share goes: the registry Treasury.
    address public PLATFORM;
    /// @notice The platform's share of the gross, in bps. Immutable ON PURPOSE.
    uint256 public PLATFORM_BPS;
    address public TIMELOCK;
    address public DISTRIBUTOR;
    /// @notice The buffer wallet (Safe) that launched the token. **One use, and
    ///         only one**: checking in `bind` that the token presented really is
    ///         ours, and in `migrate` that the destination was launched by the
    ///         same hand.
    ///
    /// @dev    This comment used to name a second use — the destination of an
    ///         `emergencyRedirect` escape valve. **That function does not
    ///         exist**, here or anywhere in `contracts/`. A dead comment
    ///         describing a way out is worse than no comment: it is the first
    ///         thing a reader auditing the withdrawal paths will find, and it
    ///         says there is one.
    address public LAUNCHER;

    /// @notice The Payd that made this vault. It answers exactly one
    ///         question, in `migrate`.
    address public REGISTRY;

    /// @notice Set on a MIGRATION vault: the token it is allowed to bind to,
    ///         declared before it exists.
    ///
    /// @dev    Zero on a launch vault, which binds to whatever its `LAUNCHER`
    ///         launched. Non-zero breaks the bootstrap knot of `migrate`: the
    ///         new vault cannot bind until it is the recipient, and cannot
    ///         become the recipient until it is bound. Naming the target at
    ///         creation settles it — and since `init` runs once, the target
    ///         cannot be chosen after the fact.
    address public INTENDED_TOKEN;

    /// @notice Where this vault's fee stream was sent on, or zero. One-way.
    address public migratedTo;

    // -------------------------------------------------------------- constants

    uint256 internal constant BPS = 10_000;

    /// @notice ERC-8056 "Scaled UI Amount". Every Robinhood stock token on this
    ///         chain implements it — 194 of 194, read 2026-09-08.
    ///
    /// @dev    A raw unit is SPLIT-NEUTRAL: `balanceOf`, `transfer` and
    ///         `totalSupply` never move when the multiplier does, and
    ///         `shares = raw * uiMultiplier / 1e18`. So our balances, our
    ///         transfers and the Uniswap pool need no adjustment at all.
    ///
    ///         **Chainlink does.** A feed quotes the price of a SHARE, and the
    ///         pool trades RAW UNITS. After a 4:1 split a raw unit is worth four
    ///         shares, and an oracle floor that ignores it lands four times too
    ///         high — every purchase of that stock then reverts `TooLittleOut`,
    ///         for good and in silence, since the rotation simply skips the
    ///         allocation. `docs/recon.md` §2.4 said this in words and the code
    ///         did not do it; `docs/recon-launchpad.md` measures it.
    ///
    ///         Eleven tokens already carry a multiplier other than 1, seven of
    ///         them liquid enough for a basket, and CRWD carries exactly 4.0
    ///         from a real split.
    bytes4 internal constant UI_MULTIPLIER = 0xa60bf13d;
    bytes4 internal constant NEW_UI_MULTIPLIER = 0xdc767007;
    bytes4 internal constant UI_EFFECTIVE_AT = 0x97a4064f;
    uint256 internal constant ONE = 1e18;
    /// @notice Chainlink's scale on this chain: every feed the baskets use is
    ///         8-decimal (`docs/recon.md` §4.3).
    uint256 internal constant USD_ONE = 1e8;

    /// @notice How far either side of a scheduled multiplier change the oracle
    ///         stops being trusted.
    ///
    /// @dev    Around a corporate action, Chainlink switches from the pre-split
    ///         price to the post-split one at a moment that has no reason to
    ///         coincide with the token's own `effectiveAt`. Inside this window
    ///         the two disagree, so the feed is ignored and the floor falls back
    ///         to the TWAP alone — which is denominated in RAW units on both
    ///         sides of the pool and therefore does not care about the
    ///         multiplier at all.
    ///
    ///         Degrading, never blocking: it is the same rule a stale feed
    ///         already follows (§S3). An epoch is not worth losing over a
    ///         corporate action, and the floor never disappears.
    uint256 internal constant CORPORATE_ACTION_WINDOW = 1 hours;
    /// @notice The three ways what arrives is split, in bps of the GROSS.
    ///
    /// @dev    Three parts, three regimes, and the difference between them is
    ///         the whole trust story of a registry vault:
    ///
    ///         - **platform** — `PLATFORM_BPS`, an IMMUTABLE stamped at
    ///           creation from the Payd's value of the day. It can be
    ///           changed for FUTURE vaults and never for this one, so a creator
    ///           knows at launch what the platform takes, for good;
    ///         - **rewards** — `rewardsBps`, chosen by the creator and then
    ///           only ever RAISED (`setRewardsBps`). The promise made to
    ///           holders can improve and cannot be walked back;
    ///         - **creator** — the RESIDUE. Rounding lands there, and so does
    ///           the caller's gas refund: whoever picks the split carries the
    ///           cost of running it.
    ///
    ///         The delivery budget (`distGasBps`) still comes out of rewards,
    ///         as it did on Payd. It is shipping, not a cut, and taking it from
    ///         the residue would let a creator who raised rewards to the ceiling
    ///         switch off the airdrop that holders never asked to lose.
    uint256 public constant MAX_PLATFORM_BPS = 1_500;

    /// @notice Floor on what a vault hands to its holders.
    ///
    /// @dev    A vault under this is not a dividend vault, it is a fee splitter
    ///         with a stock-shaped logo. Half is the line, and since the
    ///         ratchet only turns one way it is a floor for the vault's whole
    ///         life, not just its first day.
    uint256 public constant MIN_REWARDS_BPS = 5_000;

    /// @notice Tier of the WETH/PIVOT pool, first hop of a natively
    ///         ETH-quoted vault.
    ///
    /// @dev    **It was the last hard-coded tier on the money path**, and so
    ///         the only pool still welded in. 100 (0.01 %) is still what the
    ///         registry passes — the deep pool measured at 3 904 WETH /
    ///         6 006 840 USDG (`docs/recon.md` §4.1) — but the value now lives
    ///         in storage, like `QUOTE_FEE` and like `Allocation.poolFee`. If
    ///         that pool empties, a redeployed registry points at the next one
    ///         without a line of contract changing.
    uint24 public ETH_PIVOT_FEE;
    /// @notice Window of the TWAP used as a price floor.
    uint32 public constant TWAP_WINDOW = 1_800;
    /// @notice Tolerance of the on-chain floor. Deliberately wide: it is a
    ///         last-resort guard, the caller tightens it (§S3).
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice Past this age the feed no longer tightens the floor. It never
    ///         blocks: equity markets close (§S3).
    uint256 public constant MAX_FEED_AGE = 12 hours;
    /// @notice Cap on the gas refund per call. `block.basefee` is not chosen by
    ///         the caller, so the real cost is not manipulable: this cap is only
    ///         a net against a basefee spike, not a nominal constraint.
    ///         `runEpoch` costs 676,697 gas, i.e. ~0.00028 ETH at 0.42 gwei — the
    ///         cap must stay well above that, otherwise the keeper works at a
    ///         loss and nobody calls (§S8).
    uint256 public constant MAX_REFUND = 0.01 ether;
    /// @notice Flat overhead outside the measured loop (calldata, base tx).
    uint256 internal constant REFUND_OVERHEAD = 40_000;

    /// @notice Ceiling on what a `harvest` refund may take from the creator's
    ///         residue: 50 bps, i.e. 0.5 %.
    ///
    /// @dev    The cost of a harvest is FIXED (~250k gas) while the residue
    ///         scales with volume, so the share gas takes is a function of
    ///         volume and basefee, not of anything the contract chose. Measured
    ///         2026-09-10 on a 1 ETH trade: 0.183 % at 0.068 gwei, and 1.511 %
    ///         at 0.56 gwei — the same tree, ninety minutes apart, which is how
    ///         `test_HarvestSweepsAndClaimsInOneCall` and its 1 % budget came to
    ///         fail on nothing but a basefee.
    ///
    ///         50 and not 100 so the 1 % budget holds with headroom instead of
    ///         sitting on its boundary, where integer division puts equality on
    ///         the failing side of a strict comparison.
    uint256 public constant HARVEST_REFUND_BPS = 50;

    /// @notice What a cycle call hands its caller on a vault that holds no
    ///         ether: a share of what the call MOVED, in the vault's own
    ///         currency.
    ///
    /// @dev    **The vault was never unable to pay — the refund was priced in
    ///         gas and paid in wei.** `_pay` has dispatched on `QUOTE` since
    ///         the quote work landed, so the paying side was already there;
    ///         the `QUOTE == address(0) ? ... : 0` was the whole obstacle. The
    ///         reason it was written that way is real and is recorded at
    ///         `harvest`: pricing GAS in NVDA needs an ETH/QUOTE oracle, and
    ///         that is a price feed on the money path for a few cents of L2
    ///         gas.
    ///
    ///         **A bounty needs no oracle, and that is the entire point.** A
    ///         percentage of an amount already denominated in `QUOTE` is
    ///         self-denominated: nothing here reads a price, so nothing here
    ///         can be moved by one. What it buys is not exactness — it is a
    ///         non-ETH vault paying for its own cycle instead of a stranger
    ///         fronting it for ever, which was 59.1 % of Pons volume (§S40).
    ///
    ///         **It is a bounty and not a refund, and that cuts both ways.**
    ///         Under roughly $75 of purchase, 2 % does not cover the gas and
    ///         the caller still fronts the difference — the same degrade
    ///         rather than revert rule as everywhere else (§S8). Over
    ///         `MIN_BUY_QUOTE` it is capped, which is the counterpart of
    ///         `MAX_REFUND` on the ether path and denominated the same way:
    ///         both are about $25. And spamming purchases at `MIN_BUY_QUOTE`
    ///         earns 2 % of ~$25 against a basket costing several times that
    ///         in gas — the floor that bounds the frequency is also what makes
    ///         the spam lose money, so nothing had to be added to guard it.
    ///
    ///         **It is a parameter and not a constant, for `distGasBps`'s own
    ///         reason.** The cost it reimburses is mostly FIXED PER CALL while
    ///         this is a share of an amount, so no single value covers the
    ///         whole range: measured against the cycle costs of
    ///         `docs/ARCHITECTURE.md` §S31, a non-ETH vault's gas runs about
    ///         38 bps of what it spends at $20k of daily volume and 15 bps at
    ///         $500k — and under $5k a day the cost curve rests on a point that
    ///         is extrapolated, not measured. Freezing a number on that would
    ///         be the §S17 trap again.
    ///
    ///         **Seeded at 70 bps, which is what the cycle actually costs on
    ///         such a vault — 65 bps measured at the $10 delivery floor, plus
    ///         margin for the basefee.**
    ///
    ///         **It is per VAULT, which is what answers the two first-hop
    ///         routes.** A vault reaching the pivot through the detour
    ///         (`QUOTE -> WETH -> PIVOT`, §S40) pays one more hop and one more
    ///         TWAP read than a direct one — 209 014 gas, +7.9 % of a batched
    ///         basket — and the bounty, being a share of what MOVED, does not
    ///         know the difference. The seed absorbs it (the margin here is
    ///         8 %), and where it does not, the timelock raises this one vault
    ///         without touching any other.
    ///         It sat at 25 for as long as the keeper was not pushing airdrops
    ///         there; putting the deliveries back put their gas on it, because
    ///         the delivery budget is wei and cannot be skimmed here. So this
    ///         is not a wider cut, it is the same cut now buying the holders
    ///         their airdrop as well as their basket.
    ///
    ///         For scale: an ETHER vault's holders pay `distGasBps` — **3.00 %
    ///         of rewards** — for that delivery service alone, and the purchase
    ///         refund on top. At 70 bps a non-ether vault's holders pay four
    ///         times less for both.
    ///
    ///         Erring low is still the rule where there is a choice: paying
    ///         less than cost degrades to the keeper fronting the difference,
    ///         which is written down (§S8), while paying more takes holders'
    ///         money with nobody voting for it. At 200 bps — the value this
    ///         shipped with for an afternoon — the simulation had the keeper
    ///         collecting nine times what the cycle costs.
    uint256 public keeperBountyBps;

    /// @notice Share of rewards passed to the Distributor to fund the cycle's
    ///         gas: publishing the root, anchoring, revealing, and above all
    ///         refunding pushed deliveries.
    ///
    /// @dev    **This value is TIED to the push threshold and cannot be chosen
    ///         alone.** The threshold allows spending up to `1 / K` of what is
    ///         delivered; the reserve must therefore at least match it:
    ///
    ///             distGasBps >= 10_000 / K   (+ margin for the fixed cost)
    ///
    ///         It sat at 300 (3 %) against a `PUSH_K = 10` that allowed 10 %.
    ///         The two constants had been chosen separately and did not talk to
    ///         each other: the reserve was structurally in deficit, and the
    ///         deficit GREW with volume — −$33/day at $50k daily volume,
    ///         −$213/day at $500k.
    ///
    ///         **What the push cadence changes.** Pushing every 24 h rather than
    ///         the moment the threshold is crossed bounds gas by the NUMBER OF
    ///         HOLDERS instead of by the VALUE distributed. That, together with
    ///         a ~$10 threshold, is what lets this stay at 300 bps — the point
    ///         is to REIMBURSE the cycle, not to build up a war chest.
    ///
    ///         The tipping point is the holders/volume ratio, not volume alone:
    ///         many holders on little volume is the case that bites. `_refund`
    ///         then degrades without reverting — the keeper fronts the
    ///         difference instead of blocking, and it shows in its balance.
    ///
    ///         **Timelock-adjustable**: the right value depends on the real
    ///         holder distribution, which we will only know after launch.
    ///         Freezing it would be the §S17 trap one more time.
    uint256 public distGasBps;

    /// @notice Bounds of the setting. The floor guarantees the Distributor
    ///         stays funded; the cap stops rewards being diverted into the
    ///         reserve under cover of gas.
    uint256 public constant MIN_DIST_GAS_BPS = 300;
    uint256 public constant MAX_DIST_GAS_BPS = 2_000;

    /// @notice Bounds of the bounty. The ceiling is what stops it becoming a
    ///         tax on holders under cover of gas — the same sentence
    ///         `MAX_DIST_GAS_BPS` exists for; the floor stops it being set to
    ///         zero, which would silently put a non-ETH vault's cycle back on
    ///         whoever runs the keeper.
    uint256 public constant MIN_KEEPER_BOUNTY_BPS = 10;
    ///
    ///         **300, and the ceiling has a rule rather than a round number.** A
    ///         non-ether vault's holders must never pay more for the WHOLE
    ///         cycle — basket and delivery together — than an ether vault's
    ///         holders already pay for delivery alone, which is `distGasBps` at
    ///         3.00 %. The first value was 100, and it was too tight to survive
    ///         a doubling of the basefee: at 70 bps seeded, 2x gas needs ~105.
    uint256 public constant MAX_KEEPER_BOUNTY_BPS = 300;

    /// @notice **The most one purchase may spend, in `MIN_BUY_QUOTE` units.**
    ///         Forty of them — about $1,000 — and it is what makes T-TWAP-01's
    ///         bound hold against a stranger rather than only against our keeper.
    ///
    /// @dev    `_legFloor` tolerates a CONSTANT `MAX_SLIPPAGE_BPS` while the
    ///         purchase SCALES with the reserve, and nothing compared the two: a
    ///         90 % leg of a 24 ETH reserve at `MAX_PAYOUT_BPS` filled **2.78 %
    ///         under the TWAP**, inside the band, ~$155 of holders' money on one
    ///         call. The reserve grows whenever nobody calls, so the first call
    ///         after a quiet stretch is the largest and the worst-priced.
    ///
    ///         **Reading the pool's depth here was built and measured at +876
    ///         bytes — 266 over the EIP-170 cap.** It does not deploy. But the
    ///         depth is not what has to be read: capping what a call may SPEND
    ///         bounds the leg just as well, and `MIN_BUY_QUOTE` is already a
    ///         per-vault dollar-denominated quantity, so no oracle joins the
    ///         money path and no pool is read.
    ///
    ///         **Forty, measured, not chosen.** At the pinned block the thinnest
    ///         listed pool (MRVL/USDG 3000) holds $842 of depth at +1 %, and the
    ///         two fills against it were 0.36 depths → 41 bps (30 of it the
    ///         pool's own fee) and 6.62 depths → 278 bps. So:
    ///
    ///             steady state, payoutBps 400        $333    0.36 depths    41 bps
    ///             steady state at MAX_PAYOUT_BPS     $830    0.89           ~60 bps
    ///             THE CAP                          $1,000    1.07           ~70 bps
    ///             the 24 ETH case, uncapped        $6,197    6.62           278 bps
    ///
    ///         It never binds in steady state, **even with `payoutBps` at its
    ///         ceiling**, and it turns the bad case into something well inside
    ///         the floor's own band.
    ///
    ///         **It strands nothing, and `buyBasket` stays permissionless** —
    ///         which is the whole point, since a keeper-side clamp binds our
    ///         keeper and not a stranger. One purchase covers one window, so the
    ///         cap allows 48 x $1,000 a day against the ~$16k/day of rewards a
    ///         $500k/day token produces: three times the drainage the steady
    ///         state needs. A pathological $177k reserve empties in 3.7 days of
    ///         calls anyone may make.
    ///
    ///         A constant and not a timelock parameter, and the reason is the
    ///         byte budget rather than taste: the parameter measured **+258
    ///         bytes, 169 over the CI gate**, against this one's +74. What a
    ///         single number costs is a deep basket capped it did not need to
    ///         be — paid in extra calls, never in stranded money, which is the
    ///         direction this codebase errs in everywhere else. Revisit it the
    ///         day a trim frees the room (`docs/AUDIT_FIXES.md` §2.3).
    uint256 public constant MAX_BUY_MULTIPLE = 40;

    /// @notice Floor of the payout rate: the timelock sets the pace, it must
    ///         never be able to freeze distribution.
    ///
    ///         ⚠️ This floor reads RELATIVE TO EPOCH LENGTH. At 10 bps per epoch
    ///         and 48 epochs a day, the reserve halves in ~14 days even if
    ///         nothing more comes in: bounded, therefore never frozen. (~29 days
    ///         was the figure for the one-hour epochs this floor was set under;
    ///         the rate did not change, the epoch did.) The previous value (500) had
    ///         been calibrated for 24 h epochs and would have become a disguised
    ///         ceiling at 1 h — it forbade exactly the low rate we wanted
    ///         (docs/ARCHITECTURE.md §S15).
    /// @notice The smallest purchase worth making, in ETH.
    ///
    /// @dev    A window accumulates until it clears this. The bar is set by the
    ///         REFUND, not by taste: a purchase that moves less than the gas it
    ///         hands back spends the holders' money on its own execution. A
    ///         basket of five costs ~1.38 M gas — about 0.0004 ETH at the
    ///         basefee measured on 2026-09-08 — so 0.01 ETH is twenty-five
    ///         times its own cost, and it is what `MAX_REFUND` could pay out at
    ///         worst.
    ///
    ///         It never strands anything: below the bar the reserve simply
    ///         grows, and the next purchase covers every epoch that went by.
    uint256 public constant MIN_BUY = 0.01 ether;

    uint256 public constant MIN_PAYOUT_BPS = 10;

    /// @notice Cap of the payout rate: one epoch must never be able to spend
    ///         the whole reserve.
    ///
    ///         The floor and the cap do NOT guard against the same thing, and
    ///         the danger is not symmetric. Too slow leaves the ETH in the
    ///         vault: reversible, 48 h later, nothing lost. Too fast is a swap
    ///         that already happened — at `payoutBps = BPS` a single `runEpoch`
    ///         pushes the entire reserve through one pool, 25x the size the
    ///         `minOut` floor was calibrated for, and no timelock undoes it.
    ///         1,000 bps caps that mistake at a tenth of the reserve while
    ///         staying 2.5x above the nominal 400.
    uint256 public constant MAX_PAYOUT_BPS = 1_000;

    /// @notice How many stocks a basket may hold.
    ///
    /// @dev    **Two, not one.** A vault distributing a single asset earns
    ///         nothing over what Pons already does on its own: its holder
    ///         fee-sharing splitter pays holders in the launch's pair token,
    ///         with no contract of ours in the path. A basket starts being a
    ///         basket at two.
    ///
    ///         Eight at the top, and the floor below decides that as much as
    ///         this line does: at 1,000 bps minimum a basket cannot hold more
    ///         than ten lines anyway.
    uint256 public constant MIN_BASKET = 2;
    uint256 public constant MAX_BASKET = 8;

    /// @notice Smallest weight a stock may carry: 10 % of the basket.
    ///
    /// @dev    **The original reason is dead, the floor stays.** It bounded
    ///         the longest run of one stock back when the vault bought ONE
    ///         stock per epoch, drawn on a weighted wheel: a thin slice was
    ///         visited rarely, and the fat one next to it over and over in
    ///         between.
    ///
    ///         A purchase now takes the WHOLE basket, each line at its own
    ///         weight: there is no run left to bound, and `allocationOf` was
    ///         removed along with the wheel (§S16). What still justifies this
    ///         floor is simpler: a line at 1 % of the basket is a swap whose
    ///         pool fees are worth more than the position, and a dust leg that
    ///         `_buyLegs` would skip every time. The number does not change;
    ///         what it protects does.
    ///
    ///         The original measurement, kept because it explains the 1 000:
    ///
    ///         Measured over a full 10,000-epoch cycle, worst case per floor,
    ///         with two stocks — the only size where it bites:
    ///
    ///             floor    basket        longest run of one stock
    ///               500    500/9500                          512
    ///               750    750/9250                          262
    ///           **1000**   1000/9000                      **12**
    ///              2500    2500/7500                            6
    ///
    ///         The cliff sits between 750 and 1,000. Above three stocks the
    ///         longest run is 1 or 2 whatever the weights, so this floor is
    ///         entirely a two-stock rule — kept uniform because a rule that
    ///         applies at one size and not another is a rule nobody remembers.
    ///
    ///         Twelve epochs is six hours at a 30-minute cadence. Bounded, and
    ///         visibly so.
    uint256 public constant MIN_ALLOC_BPS = 1_000;
    /// @dev MIN_SQRT_PRICE + 1: no price bound, the protection is `minTokensOut`.
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;

    // ------------------------------------------------------------------ state

    IPonsV2LauncherToken public token;
    IPonsV2BondingCurve public curve;

    VaultTypes.Allocation[] public allocations;

    /// @notice ETH buckets. Kept separate so a stock purchase can never eat the
    ///         dev share, and vice versa.
    uint256 public rewardsPool;

    /// @notice Payments that could not go through, recoverable by their
    ///         recipient. See `_pay`.
    mapping(address account => uint256) public pendingWithdrawal;
    uint256 public creatorPool;
    uint256 public platformPool;

    /// @notice Sum of `pendingWithdrawal`. ETH that is physically here but
    ///         already owed to someone, so `fundRewards` does not mistake it for
    ///         a donation and `_refund` cannot hand it to a third party.
    uint256 public pendingTotal;

    /// @notice Fraction of the reserve paid out each cycle, in bps.
    ///
    ///         Spending everything every time makes rewards as volatile as
    ///         volume: a spike, then zero for a week, and nobody has a reason to
    ///         keep holding. Paying out a constant fraction spreads one intake
    ///         across many epochs.
    ///
    ///         It withholds nothing: in steady state, with a regular intake I
    ///         per epoch, the reserve converges to I/rate and the payout to I.
    ///         100 % of revenue is distributed; the reserve only spreads it over
    ///         time.
    ///
    ///         ⚠️ The value only means something RELATIVE TO EPOCH LENGTH. With
    ///         30-minute epochs (48 a day), 4 % per epoch pays out ~86 % of the
    ///         reserve per day, half-life 8.5 h, and 2.0 % is left after 48 h
    ///         without volume. The reserve is then worth ~half a day of intake
    ///         in steady state: a two-day lull still pays, a week of silence
    ///         pays almost nothing — which is the intended trade, the reserve
    ///         is a smoother, not a war chest.
    ///
    ///         The same 4 % on 24 h epochs would pay only 4 % a day: the number
    ///         means nothing without the cadence (docs/ARCHITECTURE.md §S15).
    uint256 public payoutBps;

    /// @notice The holders' share of the gross, in bps. Set at creation by the
    ///         creator, and afterwards only ever RAISED.
    uint256 public rewardsBps;

    /// @notice USDG a leg could not spend — a paused stock, a dry pool — kept
    ///         for the next purchase rather than reverting the whole basket.
    uint256 public pivotReserve;

    /// @notice The QUOTE that bought `pivotReserve`, carried with it (T-RISK-01).
    ///
    /// @dev    Without this, a skipped leg's quote was recorded NOWHERE. The
    ///         legs share out `quoteIn`, which is only the CURRENT call's spend,
    ///         while `_toPivot` has already folded the carried `pivotReserve`
    ///         into `pivot` — so when that carried USDG was finally spent, no
    ///         quote followed it and `Distributor.quoteAtRisk` lost it for good.
    ///         Measured on a real skip (a TSLA/USDG pool too young for the
    ///         window): **10.2 % under-reported on two windows**, exactly one
    ///         skipped leg's 20 % share of the first.
    ///
    ///         The direction is what made it worth fixing: the published
    ///         exposure drifts LOW exactly when legs are failing, which is when
    ///         the real one is rising.
    ///
    ///         **`public`, and it nearly was not.** The getter is 41 bytes and
    ///         the first shape of this fix left 34 under the CI gate, so it went
    ///         in `internal`. Separating the accounting quote from the pricing
    ///         one (see `_buyLegs`) gave 96 bytes back, and the getter is worth
    ///         them: `quoteAtRisk + reserveQuote` is the conservation this fix
    ///         is about, and without a reader it can be asserted nowhere.
    uint256 public reserveQuote;

    uint256 private _lock;

    /// @notice Set by `init`, and the reason it can only run once.
    bool public initialised;

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

    /// @notice Marks the IMPLEMENTATION as initialised, so only its clones can
    ///         ever be configured. A live implementation is harmless — it holds
    ///         nothing and binds to nothing — but leaving it configurable would
    ///         invite somebody to point a block explorer at it and read a
    ///         config nobody uses.
    constructor() {
        initialised = true;
    }

    /// @notice Configures a fresh clone. **Once, and only once.**
    ///
    /// @dev    Called by `Bootstrap` in the same transaction as the clone, so
    ///         there is no window for anyone to get in between. The guard is
    ///         what makes the config permanent afterwards: no other function in
    ///         this contract writes any of these fields.
    function init(VaultTypes.Config memory c, VaultTypes.Allocation[] memory allocations_) external {
        if (initialised) revert AlreadyInitialised();
        initialised = true;

        // **A clone runs no constructor, so it inherits no field initialiser.**
        // These three used to be written at their declaration; on a clone that
        // storage starts at zero, which would have meant `payoutBps = 0` (an
        // epoch buying nothing, for ever) and `_lock = 0` (every `nonReentrant`
        // function reverting on its first call). Silent, and total.
        _lock = 1;
        payoutBps = 400; // 4 % per window
        distGasBps = 300; // 3 % of rewards, the delivery budget
        keeperBountyBps = 70; // 0.70 % of what a call moves, the in-kind bounty

        if (
            c.escrow == address(0) || c.factory == address(0) || c.router == address(0) || c.v3Factory == address(0)
                || c.weth == address(0) || c.pivot == address(0) || c.ethUsdFeed == address(0)
                || c.creator == address(0) || c.timelock == address(0) || c.distributor == address(0)
                || c.deployer == address(0)
        ) revert ZeroAddress();
        // **A destination is only required if it gets paid.** The platform
        // token's vault is born at `platformBps = 0`: it never pays the
        // Treasury anything, and demanding the address anyway forced it to be
        // known at birth — so the Treasury had to be deployed BEFORE it, while
        // the Treasury must know THIS vault. The cycle was in the check, not in
        // the logic.
        if (c.platformBps != 0 && c.platform == address(0)) revert ZeroAddress();
        if (c.platformBps > MAX_PLATFORM_BPS) revert BadSplit();
        // The creator's share is the residue, so it is the one that can vanish.
        // It is allowed to be thin — that is the creator's business — but the
        // three parts must still be a partition of what arrives.
        if (c.rewardsBps < MIN_REWARDS_BPS || c.rewardsBps + c.platformBps > BPS) revert BadSplit();

        ESCROW = IPonsV2FeeEscrow(c.escrow);
        FACTORY = IPonsV2LaunchFactory(c.factory);
        ROUTER = ISwapRouter02(c.router);
        V3_FACTORY = IUniswapV3Factory(c.v3Factory);
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
        // **Written at birth, and with no setter.** The platform token's vault
        // is now the FIRST one the registry builds, in its own constructor: it
        // therefore knows its registry from birth, like every other one. The
        // `setLaunchpad` function that existed only for it — and the second key
        // that guarded it — disappeared along with the special case they served.
        REGISTRY = c.registry;
        INTENDED_TOKEN = c.intendedToken;

        // The quote, and the three shapes it can take. Checked here because
        // `init` runs once: a vault with a quote it cannot swap would bind
        // happily and then fail every purchase for good.
        QUOTE = c.quote;
        QUOTE_FEE = c.quoteFee;
        QUOTE_WETH_FEE = c.quoteWethFee;
        // `decimals()` is optional in ERC-20 and USDG is not ours; 6 is what
        // was read on-chain (`docs/recon.md` §4.1) and is the fallback.
        PIVOT_ONE = 10 ** _staticUint(c.pivot, 0x313ce567, 6);
        if (c.quote == address(0) || c.quote == c.pivot) {
            // ETH goes through `ETH_PIVOT_FEE`, the pivot makes no hop at all.
            // A tier here would be a tier nothing reads.
            if (c.quoteFee != 0 || c.quoteWethFee != 0) revert BadQuote();
        } else if ((c.quoteFee == 0) == (c.quoteWethFee == 0)) {
            // Neither: no route at all. Both: two routes, and the contract
            // would be choosing in place of whoever did the measuring.
            revert BadQuote();
        }
        MIN_BUY_QUOTE = c.minBuy;
        if (MIN_BUY_QUOTE == 0) {
            if (c.quote != address(0)) revert BadQuote();
            MIN_BUY_QUOTE = MIN_BUY;
        }

        _setAllocations(allocations_);
    }

    /// @dev The escrow pays with `call{value:}`, with no gas limit.
    ///
    ///      Plain ETH sent here is NOT credited to anything: this function is
    ///      also the landing pad of `ESCROW.claim()`, and crediting from inside
    ///      it would count the same wei twice — `harvest` splits the claim
    ///      itself, right after. `fundRewards()` is the way in.
    receive() external payable {}

    /// @notice Puts ETH to work. Credits everything held here that belongs to no
    ///         bucket — a direct transfer, a donation, this call's own
    ///         `msg.value` — to `rewardsPool`, where the epochs spend it exactly
    ///         like fee revenue: `payoutBps` per epoch, on the epoch's stock,
    ///         to the holders.
    ///
    /// @dev    Permissionless and destination-free, like the rest of the cycle:
    ///         it moves nothing out, it only re-labels ETH that is already here.
    ///         A donation therefore reaches holders in full — no dev share, no
    ///         gas cut, since neither is a fraction of the reserve, only of a
    ///         harvest.
    ///
    ///         It doubles as the sweep for ETH that arrives by a path nobody
    ///         planned. Without it, anything landing in `receive()` outside a
    ///         harvest stayed here for good: no `withdraw` reaches it, and the
    ///         epoch only ever spends `rewardsPool`.
    ///
    ///         Send-then-call works as well as calling with value: the balance
    ///         is what is measured, not `msg.value`.
    function fundRewards() external payable nonReentrant returns (uint256 credited) {
        uint256 committed = rewardsPool + creatorPool + platformPool + pendingTotal;
        // **On a vault quoted IN the pivot, `pivotReserve` is inside that
        // balance.** Both pockets are denominated in the same token, and
        // `pivotReserve` was not among the commitments: a skipped leg left
        // pivot currency in reserve, and the first `fundRewards` to come along
        // credited it again into `rewardsPool` while `pivotReserve` was still
        // promising it. Nothing leaked — both pockets belong to holders — but
        // the pockets promised more than the balance, which breaks the one
        // piece of accounting `_pay` and `buyBasket` rely on.
        if (QUOTE == PIVOT) committed += pivotReserve;
        // On a non-ETH vault the donation arrives by `transfer` and this call
        // carries no value; the measured balance is the token's. Sending ETH
        // to such a vault credits nothing and is not recoverable — the same
        // sentence `receive()` already made about anything but a harvest.
        uint256 bal = QUOTE == address(0) ? address(this).balance : IERC20(QUOTE).balanceOf(address(this));
        credited = bal > committed ? bal - committed : 0;
        if (credited == 0) revert NothingToDo();
        rewardsPool += credited;
        emit RewardsFunded(msg.sender, credited);
    }

    /// @notice `fundRewards`'s counterpart for the pivot: credits any pivot
    ///         token sitting here and promised to nothing, into the reserve the
    ///         next leg spends.
    ///
    /// @dev    Permissionless and destination-free, like `fundRewards`: it only
    ///         re-labels what is already here. It exists for two reasons, and
    ///         the first is the one that got it written:
    ///
    ///           - a migration transfers the old vault's pivot reserve to the
    ///             new one, and the new one must be able to account for it;
    ///           - without it, pivot currency arriving by an unplanned path
    ///             stayed here for ever — exactly the hole `fundRewards` plugs
    ///             on the vault-currency side.
    function fundPivot() external nonReentrant returns (uint256 credited) {
        uint256 booked = pivotReserve;
        // The same trap as in `fundRewards`, mirrored: when the currency IS the
        // pivot, the three pockets and the deferred payments live in this
        // balance too, and they are not ours to take.
        if (QUOTE == PIVOT) booked += rewardsPool + creatorPool + platformPool + pendingTotal;
        uint256 held = IERC20(PIVOT).balanceOf(address(this));
        credited = held > booked ? held - booked : 0;
        if (credited == 0) revert NothingToDo();
        pivotReserve += credited;
        emit PivotFunded(msg.sender, credited);
    }

    // --------------------------------------------------------------- bind

    /// @notice Binds the vault to its token. Callable by anyone, but only
    ///         accepts a token that the Pons factory says was launched by
    ///         `DEPLOYER` with this contract as `creatorFeeRecipient`. Once,
    ///         and for good.
    function bind(address token_) external {
        if (address(token) != address(0)) revert AlreadyBound();

        // A migration vault binds to ONE token and no other, named before it
        // existed. A launch vault takes whatever its launcher launched.
        if (INTENDED_TOKEN != address(0) && token_ != INTENDED_TOKEN) revert NotOurLaunch();

        IPonsV2LaunchFactory.LaunchedToken memory l = FACTORY.getLaunchedToken(token_);
        if (
            !l.exists || l.token != token_ || l.deployer != LAUNCHER || l.creatorFeeRecipient != address(this)
                || l.curve == address(0)
        ) revert NotOurLaunch();

        // **The launch must be quoted in this vault's currency, and this is
        // the only place that can say so once and for all.**
        //
        // `launchToken` takes `pairToken` as an argument, and Pons accepts more
        // than ETH — USDG and the stock tokens themselves were measured passing
        // (`test/PairToken.t.sol`). The escrow keeps ONE LEDGER PER CURRENCY,
        // so a vault claiming the wrong one sees a zero balance while its fees
        // pile up on a ledger it never reads.
        //
        // v1 wrote `!= address(0)` here and could therefore only ever serve
        // ETH-quoted launches. The rule is now the vault's own quote: the same
        // sentence for an ETH vault, and the thing that makes the other two
        // possible. Without it such a vault binds happily, reports the right
        // token, and then reverts `NothingToDo` on every harvest and every
        // purchase, for good. Refusing at `bind` costs the creator one reverted
        // transaction and tells them immediately; the alternative tells them
        // never.
        if (l.pairToken != QUOTE) revert UnsupportedPair(l.pairToken);

        token = IPonsV2LauncherToken(token_);
        curve = IPonsV2BondingCurve(l.curve);
    }

    // ------------------------------------------------------------- 1. harvest

    /// @notice Pulls the creator fees out of the Pons escrow and splits them.
    /// @dev    `FeeVault` is the `msg.sender` towards the escrow, so the ETH can
    ///         only land here — whoever the caller is. The gas refund comes out
    ///         of the REWARDS share: dev is a fixed obligation, rewards is the
    ///         residual that absorbs running costs
    ///         (docs/ARCHITECTURE.md §S11).
    function harvest() external nonReentrant returns (uint256 gross) {
        uint256 g0 = gasleft();

        _sweepFees();

        // One ledger per currency, and this vault reads exactly one of them.
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

        // The refund comes out of the CREATOR's share, not the holders'. Payd
        // took it from rewards because the residue was ours; here the residue
        // belongs to whoever chose the split, and so does the cost of running
        // it. It degrades rather than reverts: a caller who is not covered
        // fronts the difference, as everywhere else (§S8).
        //
        // **Zero on a non-ETH vault, and that is the accepted cost of the
        // quote.** `_refundAmount` computes WEI from gas, and a vault holding
        // USDG or NVDA has none — paying it would mean a swap per harvest, on
        // every harvest, to reimburse a few cents of Orbit L2 gas. The keeper
        // fronts it instead, and what is not taken stays with the creator.
        //
        // **Superseded, and the comment above is kept for what it explains.**
        // The wei refund is still impossible here; the bounty is not. On a
        // non-ETH vault the caller takes the residue cap below — 50 bps of the
        // creator's own residue — and nothing else changes: same pocket, same
        // ceiling, same silence when there is nothing to give.
        uint256 cap = (toCreator * HARVEST_REFUND_BPS) / BPS;
        uint256 refund = QUOTE == address(0) ? _refundAmount(g0) : _bounty(gross);
        // **The gas may take at most `HARVEST_REFUND_BPS` of the residue.**
        // `harvest` was the only refunding function with no economic bar --
        // `buyBasket` has `MIN_BUY_QUOTE`, `distribute` has the ~$20 threshold
        // sealed into `pushRoot`, `publishRoot` has the keeper and one call per
        // epoch. Nothing guarded the CREATOR, so an escrow holding one wei was
        // enough to convert the whole residue into gas: the caller gained
        // nothing, being capped at their own cost, and the creator got nothing
        // either.
        //
        // It CAPS and does not revert, deliberately. `toRewards` is computed in
        // this same call, so refusing the harvest would hold the holders'
        // rewards hostage to the creator's residue -- and a rate pushed to the
        // ceiling makes that residue small BY DESIGN. Below the bar the caller
        // fronts the difference, as everywhere else (§S8), and the escrow keeps
        // the fees for the next harvest: deferred, never stranded.
        //
        // Zero on a non-ETH vault, where `refund` is already zero and there is
        // nothing to guard.
        if (refund > cap) refund = cap;
        toCreator -= refund;

        // Delivery money, and it stays a slice of REWARDS. It is shipping, not
        // a cut — and taking it from the residue would let a creator who
        // ratcheted rewards to the ceiling switch off the airdrop that holders
        // never asked to lose (docs/ARCHITECTURE.md §S11).
        // Same reason, opposite pocket: the Distributor spends WEI to push
        // deliveries, so a vault that holds none skims nothing for it. The
        // difference lands where a withheld share always should — in
        // `rewardsPool`, i.e. with the holders — and the keeper funds the
        // Distributor directly, as `receive()` there already allows.
        uint256 toDist = QUOTE == address(0) ? (toRewards * distGasBps) / BPS : 0;
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

    /// @notice Buys the WHOLE basket for every epoch since the last purchase,
    ///         in one transaction.
    ///
    /// @dev    **A window, not an epoch** (`PLAN.md` D8). Payd bought one stock
    ///         per epoch and honoured the weights by rotation, so a holder was
    ///         paid in whatever the wheel happened to land on while they held.
    ///         The value was fair; the composition was noise, and it got worse
    ///         the longer the epoch — ten days to see a whole basket at a
    ///         24-hour cadence.
    ///
    ///         What the window shares, measured on a real `runEpoch` trace:
    ///
    ///           - the **`WETH -> USDG` hop**, 139 625 gas: every leg used to
    ///             pay it. One conversion now feeds them all;
    ///           - the **TWAP of the WETH/USDG pool**, 69 389 gas: same pool,
    ///             same window, one read;
    ///           - the **ETH/USD feed**, the base transaction, the refund, and
    ///             `fundWindow` instead of one `fund` per epoch.
    ///
    ///         Roughly −60 % of gas on a basket of five, and it also removes
    ///         the per-leg `transfer`: the router delivers straight to the
    ///         Distributor, so the vault does not touch a stock at all.
    ///
    ///         **A leg may fail without taking the others down.** That is what
    ///         `try` buys back — Payd could drop it only because one swap per
    ///         transaction made a revert harmless. A leg that fails leaves its
    ///         USDG in `usdgReserve`, which the next purchase spends: a stock
    ///         Robinhood paused costs a delay, never a loss.
    ///
    /// @param  minOuts Per-leg floor from the caller, aligned with the basket.
    ///         It can only TIGHTEN: the contract applies `max(minOuts[i], its
    ///         own floor)`, so a hostile caller can only make their own
    ///         transaction fail (§S3).
    function buyBasket(uint256[] calldata minOuts) external nonReentrant returns (uint256 legsBought) {
        uint256 g0 = gasleft();

        uint256 n = allocations.length;
        if (minOuts.length != n) revert BadWeights();

        // The window is every epoch the Distributor has not been paid for, up
        // to the last one that has finished. It refuses an empty window itself.
        uint256 cur = IDistributor(DISTRIBUTOR).currentEpoch();
        if (cur == 0) revert NothingToDo();
        uint256 toEpoch = cur - 1;
        if (toEpoch < IDistributor(DISTRIBUTOR).nextEpoch()) revert NothingToDo();

        uint256 pool = rewardsPool;
        // The reserve exists only to have a refund left to pay — and a non-ETH
        // vault now pays one, so it holds one back too. `MIN_BUY_QUOTE` is the
        // bounty's ceiling exactly as `MAX_REFUND` is the wei refund's, and on
        // this chain the two are about the same $25. Without this line the
        // bounty would be paid out of whatever the purchase happened to leave
        // behind, which on a vault spending its whole reserve is nothing: the
        // caps below would truncate it to zero in silence, and only on the
        // vaults with the least to give.
        uint256 held = QUOTE == address(0) ? MAX_REFUND : MIN_BUY_QUOTE;
        if (pool <= held) revert NothingToDo();
        uint256 free = pool - held;

        // `payoutBps` of the reserve, but never less than a purchase worth
        // making. Taking the fraction alone would strand a young vault for
        // months: at 4 % per window, clearing a 0.01 ETH bar would need a
        // 0.25 ETH reserve, so a token that has collected 0.05 ETH of real fees
        // would buy nothing at all while the money sat there.
        //
        // So the fraction SMOOTHS when there is plenty, and the floor spends
        // more when there is little. Below the floor the reserve simply grows
        // and the next window covers every epoch that went by — nothing is
        // stranded, only deferred.
        uint256 spent_ = (free * payoutBps) / BPS;
        if (spent_ < MIN_BUY_QUOTE) spent_ = MIN_BUY_QUOTE;
        // **And never more than `MAX_BUY_MULTIPLE` of the floor in one call.**
        // The fraction smooths and the floor lifts a small vault off the ground;
        // neither bounds the ABSOLUTE size, and the leg's price impact is a
        // function of that. Deferred, never stranded: what the cap does not
        // spend stays in the reserve and the next window takes another slice,
        // through a call anybody may make.
        uint256 cap = MIN_BUY_QUOTE * MAX_BUY_MULTIPLE;
        if (spent_ > cap) spent_ = cap;
        if (spent_ > free) revert BelowMinBuy(free, MIN_BUY_QUOTE);
        rewardsPool = pool - spent_;

        // The leg already in the right currency does not go through the hop.
        // Set aside BEFORE the conversion rather than bought back after: a
        // round trip costs two pool fees and two slippages to end up in the
        // same place — 0.10 % measured on NVDA/USDG at tier 500.
        Legs memory legs = Legs(new address[](n), new uint256[](n), new uint256[](n), 0, 0);
        // Written INTO the struct and not into two locals: `buyBasket` already
        // barely fits on the stack.
        (legs.direct, legs.directBps) = _directShare(spent_);
        uint256 pivot = _toPivot(spent_ - legs.direct);

        legsBought = _buyLegs(pivot, spent_ - legs.direct, minOuts, legs);
        if (legsBought == 0) revert NothingToDo();

        // The arrays are sized for the WHOLE basket and a skipped leg does not
        // fill its slot. `fundWindow` refuses a zero amount, so passing them as
        // they are reverted the ENTIRE purchase as soon as a single leg gave
        // way — the exact opposite of the rule they serve.
        _fund(toEpoch, legs, legsBought);
        emit BasketBought(toEpoch, spent_, pivot, legsBought);

        // The bounty replaces the wei refund on a vault that holds no ether,
        // out of the same pocket and under the same two caps below.
        uint256 refund = QUOTE == address(0) ? _refundAmount(g0) : _bounty(spent_);
        // Never more than the purchase moved, and never out of somebody else's
        // money. A caller who is not fully covered fronts the difference, as
        // everywhere else (§S8).
        if (refund > spent_) refund = spent_;
        if (refund > rewardsPool) refund = rewardsPool;
        if (refund != 0) {
            rewardsPool -= refund;
            _pay(msg.sender, refund, true);
        }
    }

    /// @dev `keeperBountyBps` of what a call moved, capped at
    ///      `MIN_BUY_QUOTE`. Its own function because `buyBasket` barely fits
    ///      on the stack as it is — the same remedy as `_buyLegs` (§Build).
    function _bounty(uint256 moved) internal view returns (uint256 owed) {
        owed = (moved * keeperBountyBps) / BPS;
        uint256 ceiling = MIN_BUY_QUOTE;
        if (owed > ceiling) owed = ceiling;
    }

    /// @dev The share of the basket already in the vault's own currency, and
    ///      its weight. `(0, 0)` as soon as the question does not arise: an ETH
    ///      vault (nothing to hold back), a pivot-quoted vault (the hop is
    ///      already a no-op, and the pivot line is served by `_buyLegs`), or a
    ///      currency absent from the basket.
    function _directShare(uint256 spent_) internal view returns (uint256 amount, uint256 bps) {
        address quote = QUOTE;
        if (quote == address(0) || quote == PIVOT) return (0, 0);
        uint256 n = allocations.length;
        for (uint256 i; i < n; ++i) {
            if (allocations[i].stock != quote) continue;
            bps = allocations[i].bps;
            return ((spent_ * bps) / BPS, bps);
        }
        return (0, 0);
    }

    /// @dev Copies out the legs ACTUALLY bought and credits them. Its own
    ///      function for the stack, and because the truncation is the only
    ///      thing separating "a leg gave way" from "the purchase gave way".
    function _fund(uint256 toEpoch, Legs memory legs, uint256 bought) internal {
        address[] memory stocks = new address[](bought);
        uint256[] memory outs = new uint256[](bought);
        uint256[] memory spentOn = new uint256[](bought);
        for (uint256 i; i < bought; ++i) {
            stocks[i] = legs.stocks[i];
            outs[i] = legs.outs[i];
            spentOn[i] = legs.quote[i];
        }
        IDistributor(DISTRIBUTOR).fundWindow(toEpoch, stocks, outs, spentOn);
    }

    /// @dev Hop one, done ONCE for the whole basket. Its own TWAP floor, on the
    ///      deepest pool on this chain — 16.9 M USDG, 2.5 M of depth at 1 %
    ///      (`docs/allowlist.md`).
    ///
    ///      Three shapes, and the middle one is free:
    ///
    ///        - **ETH** — `WETH -> USDG` at `ETH_PIVOT_FEE`, paid with value;
    ///        - **USDG** — nothing at all. What arrived IS what the legs spend,
    ///          so a USDG-quoted vault skips a swap, a pool read and a TWAP;
    ///        - **a stock** — `QUOTE -> USDG` at `QUOTE_FEE`, an ERC-20 hop with
    ///          the same TWAP floor as the ETH one. Same shape, same guard: the
    ///          only difference is which pool it reads.
    function _toPivot(uint256 amountIn) internal returns (uint256 pivot) {
        address quote = QUOTE;
        if (quote == PIVOT) {
            pivot = amountIn;
        } else {
            if (amountIn > type(uint128).max) revert MinOutZero();
            address tokenIn = quote == address(0) ? WETH : quote;

            (bytes memory path, uint256 floorOut) = _route(tokenIn, quote == address(0), uint128(amountIn));

            ISwapRouter02.ExactInputParams memory p = ISwapRouter02.ExactInputParams({
                path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: floorOut
            });
            if (quote == address(0)) {
                pivot = ROUTER.exactInput{value: amountIn}(p);
            } else {
                IERC20(quote).approve(address(ROUTER), amountIn);
                pivot = ROUTER.exactInput(p);
            }
        }
        // Whatever a failed leg left behind last time joins this purchase.
        pivot += pivotReserve;
        pivotReserve = 0;
    }

    /// @dev The first hop's route and its floor, together because the floor
    ///      DEPENDS on the route: a two-hop path is priced on two TWAPs, not
    ///      on one.
    ///
    ///      Two shapes, and which one applies is written at birth:
    ///
    ///        - **direct** — `QUOTE -> PIVOT` at the declared tier. That is the
    ///          case for native ETH (through WETH, at `ETH_PIVOT_FEE`) and for
    ///          any currency with a pool against the pivot;
    ///        - **the detour** — `QUOTE -> WETH -> PIVOT`, when the currency is
    ///          deeply traded against WETH and invisible against the pivot.
    ///          COIN and cbBTC are exactly that case, and between them they
    ///          carried 198 of the ~220 weekly credits of the out-of-reach
    ///          pairs.
    ///
    ///      The detour's second hop is the same pool an ETH-quoted vault uses:
    ///      one pool, two uses, and nothing more to measure.
    function _route(address tokenIn, bool isEth, uint128 amountIn)
        internal
        view
        returns (bytes memory path, uint256 floorOut)
    {
        uint24 direct = isEth ? ETH_PIVOT_FEE : QUOTE_FEE;

        if (direct != 0) {
            address pool = V3_FACTORY.getPool(tokenIn, PIVOT, direct);
            if (pool == address(0)) revert NoPool();
            floorOut = TwapFloor.quoteAtTick(TwapFloor.meanTick(pool, TWAP_WINDOW), amountIn, tokenIn, PIVOT);
            path = abi.encodePacked(tokenIn, direct, PIVOT);
        } else {
            address poolA = V3_FACTORY.getPool(tokenIn, WETH, QUOTE_WETH_FEE);
            address poolB = V3_FACTORY.getPool(WETH, PIVOT, ETH_PIVOT_FEE);
            if (poolA == address(0) || poolB == address(0)) revert NoPool();
            floorOut = TwapFloor.quoteTwoHops(poolA, tokenIn, WETH, poolB, PIVOT, amountIn, TWAP_WINDOW);
            path = abi.encodePacked(tokenIn, QUOTE_WETH_FEE, WETH, ETH_PIVOT_FEE, PIVOT);
        }

        // **One tolerance, two hops.** The detour pays TWO pool fees where the
        // direct route pays one, and the floor does not know that — it comes
        // from the TWAP, which is a price, not a cost. At 300 bps the margin
        // covers 0.01 % + 1 % comfortably; two 1 % tiers would eat almost all
        // of it. It is up to the timelock not to list a currency whose detour
        // costs more than the margin, and `MeasureRoutes` is what tells it.
        floorOut = (floorOut * (BPS - MAX_SLIPPAGE_BPS)) / BPS;
        if (floorOut == 0) revert MinOutZero();
    }

    /// @dev Hop two, once per stock. Split out of `buyBasket` for the stack, not
    ///      for taste: eight legs and their floors do not fit in one frame.
    ///
    ///      `ethLegs[i]` is the leg's share of the ETH, and it is what prices
    ///      the oracle floor — the leg's USDG converted back at the rate the
    ///      first hop actually got, so a slipped hop one cannot make every leg
    ///      unbuyable.
    function _buyLegs(uint256 pivot, uint256 quoteIn, uint256[] calldata minOuts, Legs memory legs)
        internal
        returns (uint256 bought)
    {
        uint256 pivotLeft = pivot;
        // **The carried reserve's quote joins this call's (T-RISK-01).**
        // `_toPivot` folded the carried `pivotReserve` into `pivot` one line
        // earlier; this is the same fold on the other side, and without it the
        // legs share out a `quoteIn` that does not cover the pivot they spend.
        //
        // **Two quotes, and keeping them apart is the point.** `quoteAll` is
        // the ACCOUNTING one: what the pivot about to be spent cost, across
        // however many purchases it took to accumulate, and what `fundWindow`
        // is told. `quoteIn` stays what it was — THIS call's spend — because
        // `_legFloor` PRICES the Chainlink tightener off it, and folding the
        // carried quote in there raises the floor of a leg whose pivot came
        // from an older purchase at an older rate. Measured: it did, and a leg
        // that bought before stopped buying. An accounting fix must not move
        // the floor.
        uint256 quoteAll = quoteIn + reserveQuote;
        uint256 quoteLeft = quoteAll;
        uint256 last = _lastPivotLeg(legs.stocks.length);

        for (uint256 i; i < legs.stocks.length; ++i) {
            VaultTypes.Allocation memory a = allocations[i];

            // 1. The leg that IS the vault's currency: nothing to convert.
            if (legs.directBps != 0 && a.stock == QUOTE) {
                if (legs.direct != 0 && _sendQuote(DISTRIBUTOR, legs.direct)) {
                    _record(legs, bought, a.stock, legs.direct, legs.direct);
                    ++bought;
                }
                continue;
            }

            // The bps the pivot has to cover: the basket minus the leg set
            // aside. Without this the other legs would be underfunded by
            // exactly what never went through the hop.
            uint256 legPivot = i == last ? pivotLeft : FullMath.mulDiv(pivot, a.bps, BPS - legs.directBps);
            if (legPivot == 0 || legPivot > pivotLeft) continue;
            pivotLeft -= legPivot;
            uint256 quoteLeg = FullMath.mulDiv(legPivot, quoteAll, pivot);

            // 2. A pivot line: it is already in the basket's currency. No pool
            //    against itself, so no floor to compute and nothing to protect
            //    — there is no price.
            if (a.stock == PIVOT) {
                if (_sendPivot(DISTRIBUTOR, legPivot)) {
                    _record(legs, bought, a.stock, legPivot, quoteLeg);
                    quoteLeft -= quoteLeg;
                    ++bought;
                } else {
                    pivotReserve += legPivot;
                    emit LegSkipped(a.stock, legPivot);
                }
                continue;
            }

            // 3. The ordinary case: one PIVOT -> stock hop, under a floor.
            //    Priced on THIS call's quote share, not the accounting one —
            //    see `quoteAll` above.
            uint256 minOut = _legFloor(a, legPivot, FullMath.mulDiv(legPivot, quoteIn, pivot));
            if (minOut == 0) {
                pivotReserve += legPivot;
                emit LegSkipped(a.stock, legPivot);
                continue;
            }
            if (minOuts[i] > minOut) minOut = minOuts[i];

            if (_swapLeg(a, legPivot, minOut, legs, bought)) {
                legs.stocks[bought] = a.stock;
                legs.quote[bought] = quoteLeg;
                quoteLeft -= quoteLeg;
                ++bought;
            }
        }
        // Rounding dust, and anything a skipped leg left in hand.
        pivotReserve += pivotLeft;
        // The quote that bought it, on the same line. `quoteLeft` was only ever
        // decremented by a leg that WENT THROUGH, so what is left is exactly
        // the quote of every leg that did not, plus the dust's — and it cannot
        // underflow: the legs' shares are `mulDiv`s of `quoteIn` that round
        // down over pivot shares summing to at most `pivot`.
        reserveQuote = quoteLeft;
    }

    /// @dev Index of the last leg that spends pivot currency — the one that
    ///      takes the remainder, so a rounding dust does not settle into the
    ///      reserve on every purchase. The leg set aside spends none.
    function _lastPivotLeg(uint256 n) internal view returns (uint256 last) {
        last = n;
        for (uint256 i; i < n; ++i) {
            if (QUOTE != address(0) && QUOTE != PIVOT && allocations[i].stock == QUOTE) continue;
            last = i;
        }
    }

    /// @dev A leg that went through, written at the WRITE position and not at
    ///      the allocation's: `_fund` truncates on `bought`.
    function _record(Legs memory legs, uint256 k, address stock, uint256 out, uint256 spentOn) internal pure {
        legs.stocks[k] = stock;
        legs.outs[k] = out;
        legs.quote[k] = spentOn;
    }

    /// @dev Same shape as `_sendQuote`, on the pivot. A `transfer` that fails
    ///      sends its share back to the reserve instead of taking the basket
    ///      down.
    function _sendPivot(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) =
            PIVOT.call{gas: 100_000}(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @dev One leg, and the `try` that keeps a broken stock from taking the
    ///      basket down with it. Payd could do without this because one swap
    ///      per transaction made a revert harmless; a window cannot.
    function _swapLeg(VaultTypes.Allocation memory a, uint256 legPivot, uint256 minOut, Legs memory legs, uint256 i)
        internal
        returns (bool)
    {
        IERC20(PIVOT).approve(address(ROUTER), legPivot);
        try ROUTER.exactInput(
            ISwapRouter02.ExactInputParams({
                path: abi.encodePacked(PIVOT, a.poolFee, a.stock),
                // Straight to the Distributor: the vault never touches a stock,
                // which is stronger than forwarding one.
                recipient: DISTRIBUTOR,
                amountIn: legPivot,
                amountOutMinimum: minOut
            })
        ) returns (
            uint256 out
        ) {
            legs.outs[i] = out;
            return true;
        } catch {
            // A paused stock, a dry pool, a floor the market cannot meet: the
            // USDG waits for the next purchase rather than reverting the rest.
            IERC20(PIVOT).approve(address(ROUTER), 0);
            pivotReserve += legPivot;
            emit LegSkipped(a.stock, legPivot);
            return false;
        }
    }

    /// @dev The floor for one leg: the USDG/stock TWAP, tightened by Chainlink
    ///      priced on the leg's ETH share. Zero means "do not buy this leg".
    function _legFloor(VaultTypes.Allocation memory a, uint256 legPivot, uint256 quoteLeg) internal returns (uint256) {
        address pool = V3_FACTORY.getPool(PIVOT, a.stock, a.poolFee);
        if (pool == address(0) || legPivot > type(uint128).max) return 0;

        // A pool that cannot answer the window buys nothing this cycle: no
        // floor, no swap, and the leg's USDG waits in the reserve. It must not
        // take the other nine down with it — `observe` reverts `OLD` on a pool
        // whose observations are all younger than `TWAP_WINDOW`, and that is a
        // property of the pool's cardinality, not of anything we control
        // (`Payd._requirePool` admits a pool on liquidity alone).
        (bool haveTwap, int24 tick) = TwapFloor.tryMeanTick(pool, TWAP_WINDOW);
        if (!haveTwap) return 0;

        uint256 floorOut = TwapFloor.quoteAtTick(tick, uint128(legPivot), PIVOT, a.stock);
        // `quoteLeg` is the leg's share of what was SPENT, and on a non-ETH vault
        // that is not wei — crossing it through ETH/USD would price the floor
        // in a currency the vault never held. The leg's USDG is the one number
        // that means the same thing whatever the quote.
        uint256 oracleOut = QUOTE == address(0) ? _oracleOut(a, quoteLeg) : _oracleOutPivot(a, legPivot);
        if (oracleOut != 0) {
            emit OracleDivergence(a.stock, floorOut, oracleOut);
            if (oracleOut > floorOut) floorOut = oracleOut; // tightens only
        }
        return (floorOut * (BPS - MAX_SLIPPAGE_BPS)) / BPS;
    }

    /// @dev Expected output according to Chainlink, or 0 if unavailable/stale.
    ///      Never reverts: a missing feed must not block a purchase.
    function _oracleOut(VaultTypes.Allocation memory a, uint256 amountIn) internal view returns (uint256) {
        if (a.feed == address(0)) return 0;

        (, int256 ethUsd,, uint256 ethAt,) = ETH_USD.latestRoundData();
        (, int256 stockUsd,, uint256 stockAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (ethUsd <= 0 || stockUsd <= 0) return 0;
        if (block.timestamp - ethAt > MAX_FEED_AGE || block.timestamp - stockAt > MAX_FEED_AGE) return 0;

        // A raw unit is worth `uiMultiplier / 1e18` shares, and the feed prices
        // a SHARE. Without this the floor is wrong by exactly the multiplier —
        // 0.06 % on AAPL today, 300 % the day a stock splits 4:1.
        uint256 m = _uiMultiplierNow(a.stock);
        if (m == 0) return 0;

        // Both feeds are 8-decimal, the stock 18: the ratio is dimensionless,
        // only the stock's decimals matter. `mulDiv` because the numerator
        // carries an extra 1e18 and a plain product could overflow.
        return FullMath.mulDiv(amountIn, uint256(ethUsd) * ONE, uint256(stockUsd) * m);
    }

    /// @dev The same floor as `_oracleOut`, priced from USDG instead of ETH.
    ///
    ///      USDG is taken at $1.00 rather than read from its own feed. The
    ///      error that makes is bounded by the peg and lands inside
    ///      `MAX_SLIPPAGE_BPS` (300) many times over; a second feed read here
    ///      would cost gas on every leg to tighten a floor that is already a
    ///      last resort. If USDG ever moved enough to matter, the TWAP — which
    ///      knows nothing of dollars — is what the floor falls back to.
    function _oracleOutPivot(VaultTypes.Allocation memory a, uint256 amountPivot) internal view returns (uint256) {
        if (a.feed == address(0)) return 0;

        (, int256 stockUsd,, uint256 stockAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (stockUsd <= 0) return 0;
        if (block.timestamp - stockAt > MAX_FEED_AGE) return 0;

        uint256 m = _uiMultiplierNow(a.stock);
        if (m == 0) return 0;

        // USDG carries 6 decimals and a stock 18, so the amount is scaled up
        // before the cross. `USDG_ONE` is read once at init rather than
        // hardcoded: the decimals of a token nobody here controls are not a
        // constant of ours.
        uint256 amount18 = FullMath.mulDiv(amountPivot, ONE, PIVOT_ONE);
        return FullMath.mulDiv(amount18, USD_ONE * ONE, uint256(stockUsd) * m);
    }

    /// @dev The multiplier to price against, or 0 to say "do not trust the feed
    ///      right now" — which sends the floor back to the TWAP alone.
    function _uiMultiplierNow(address stock) internal view returns (uint256) {
        uint256 m = _staticUint(stock, UI_MULTIPLIER, ONE);
        uint256 next = _staticUint(stock, NEW_UI_MULTIPLIER, m);

        // `newUIMultiplier()` returns the CURRENT multiplier when nothing is
        // scheduled — it is not zero, and it is not absent. Verified on-chain
        // 2026-09-08 across NVDA, AAPL, CRWD and CCL. So a pending change is
        // exactly `next != m`, and `effectiveAt` on its own means nothing: it
        // keeps the date of the LAST applied change, which is in the past.
        if (next != m) {
            uint256 at = _staticUint(stock, UI_EFFECTIVE_AT, 0);
            if (
                at != 0 && block.timestamp + CORPORATE_ACTION_WINDOW >= at
                    && block.timestamp <= at + CORPORATE_ACTION_WINDOW
            ) return 0;
        }
        return m;
    }

    /// @dev A `uint256` read that CANNOT break us. A stock that reverts, returns
    ///      garbage or does not implement the function at all falls back to the
    ///      default instead of taking the vault down with it — these are tokens
    ///      Robinhood can upgrade, pause or replace, and none of that may ever
    ///      stop an epoch. Gas is capped for the same reason.
    function _staticUint(address target, bytes4 selector, uint256 fallbackValue) internal view returns (uint256) {
        (bool ok, bytes memory ret) = target.staticcall{gas: 30_000}(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return fallbackValue;
        return abi.decode(ret, (uint256));
    }

    /// @notice Pushes our accrued fees from Pons to the escrow, so `harvest` can
    ///         claim them in the same transaction instead of waiting for Pons.
    ///
    ///         Two phases, one rule. Before graduation the fees sit on the
    ///         bonding curve; after, in the v4 hook. **Both accept the creator
    ///         fee recipient**, which is this vault — the curve calls that field
    ///         `deployer` and the hook calls it `creator`, and neither means the
    ///         wallet that launched the token. Verified on a fork against a real
    ///         launch (docs/recon.md §1.7).
    ///
    /// @dev    **Never reverts the harvest.** It fails whenever the pool is not
    ///         graduated, is unknown to the hook, has nothing pending, or has
    ///         fees pending denominated in the MEMECOIN — that last case needs an
    ///         internal swap Pons reserves for its operator. All of those are
    ///         normal, so a failure costs one call and nothing else: `harvest`
    ///         then claims whatever the operator has already pushed.
    ///
    ///         Both minimums are 0, and that does not break the "never minOut =
    ///         0" rule of docs/CONVENTIONS.md. They only bind a conversion, and a
    ///         conversion can never run on this path: the hook refuses a
    ///         non-operator caller *before* converting whenever anything is
    ///         pending in the memecoin. Reached here, there is nothing to convert
    ///         and nothing to price. The buyback minimum is doubly moot — we
    ///         launch with `buybackEnabled = false`.
    function _sweepFees() internal {
        if (address(token) == address(0) || address(curve) == address(0)) return;

        if (!curve.graduated()) {
            // The curve's own gate is a pending buyback, which cannot exist:
            // we launch with `buybackEnabled = false` (docs/recon.md §1.7).
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
        // The pool is the one this vault's quote makes, and no other.
        if (l.pairToken != QUOTE) revert PoolNotReady();
        // Uniswap v4 sorts the pair by address, and native ETH (address(0))
        // always lands first — so this is the same key v1 wrote, generalised.
        (address c0, address c1) = QUOTE < address(token) ? (QUOTE, address(token)) : (address(token), QUOTE);
        key = IPoolManager.PoolKey({
            currency0: c0,
            currency1: c1,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: IPonsV2MemeHookSource(address(FACTORY)).memeHook()
        });
    }

    // -------------------------------------------------------------- 4. dev

    // ------------------------------------------------------- escape hatch

    /// @notice Sends this vault's FUTURE fee stream to another vault for the
    ///         same token. **The only door out, and it leads nowhere else.**
    ///
    /// @dev    Some door has to exist. Once bound, only the CURRENT recipient
    ///         can move the recipient — the Pons factory rejects the token's
    ///         own deployer (verified on-chain, `docs/recon.md` §1.3) — so
    ///         without this a bug in the vault would strand that token's fees
    ///         for good, and nobody could do anything about it.
    ///
    ///         Where the door leads is the whole design (`PLAN.md` D6):
    ///
    ///         - at the creator, it hands him back the stream he promised his
    ///           holders, in two transactions;
    ///         - at our Safe, WE can take any token's stream. That is the
    ///           disease this registry exists not to have;
    ///         - **at another vault of the same token, bound by the conditions
    ///           below**, a thief gains nothing by walking through it.
    ///
    ///         Called by the TIMELOCK, so it carries 48 hours of public notice.
    ///         Even a compromised timelock can only move the stream to a vault
    ///         that pays holders at least as well.
    ///
    ///         **What it moves, and what it will never move.**
    ///
    ///         Not one stock leaves the Distributor. What was bought was bought
    ///         for the holders of epochs already closed, it is promised by an
    ///         already-published root, and it stays claimable where it is, for
    ///         ever. A holder therefore has two claim sources after a
    ///         migration, which is what `Collector.collect` exists for.
    ///
    ///         **The reserve, though, follows** — `rewardsPool` and
    ///         `pivotReserve`, that is, the money harvested and not yet turned
    ///         into stocks. Without that transfer the migrated vault starts
    ///         empty and produces nothing until the next `harvest`, while the
    ///         old one keeps buying into its own Distributor: two baskets, two
    ///         roots, two snapshot pipelines for one token.
    ///
    ///         **The cash follows the stream, and the destination is
    ///         verifiable.** This function used to move nothing, which is what
    ///         made it harmless; it now carries money, so its destination check
    ///         has to be worth something. It is: the destination must be in
    ///         THIS vault's registry, and `isVault` is written only by
    ///         `_create`.
    ///
    ///         That is what the `Payd` / `DistributionFactory` split made possible. As
    ///         long as the implementations lived in the registry, a new vault
    ///         version forced a new registry, hence a bridge between two
    ///         registries — the `setSuccessor` chain, which nothing could
    ///         verify. A new version is now a new FACTORY, and its vaults are
    ///         born in this same registry.
    ///
    ///         One class (a) power remains, and `FLOWS.md` names it: the
    ///         timelock, together with the generation Ledger, can approve a
    ///         hostile factory whose vaults would be registered here. Two keys,
    ///         48 h of public notice.
    ///
    ///         `creatorPool` and `platformPool` also stay here: they are owed
    ///         to immutable addresses, and `payCreator` / `payPlatform` keep
    ///         working on this vault for ever.
    function migrate(address newVault) external nonReentrant {
        if (msg.sender != TIMELOCK) revert NotTimelock();
        if (address(token) == address(0)) revert NotBound();
        if (migratedTo != address(0)) revert AlreadyMigrated();

        // 1. **A vault from OUR registry, and the check is not forgeable.**
        //    `isVault` is written only by `Payd._create`: nobody can steer it,
        //    unlike everything one would read from the destination itself.
        //
        //    There used to be `recognised` here, which additionally walked a
        //    chain of `setSuccessor` pointers so a vault of another generation
        //    could be accepted. It was the largest residual hole in the system:
        //    `setSuccessor` took any address, and five lines answering
        //    `isVault(x) = true` opened this door onto anything — hence onto
        //    the future stream AND the reserve. It existed only because a new
        //    implementation forced a new registry; now that `DistributionFactory`
        //    carries the implementations, a new version is born in THIS
        //    registry.
        if (REGISTRY == address(0) || !IPayd(REGISTRY).isVault(newVault)) revert NotAVault();

        FeeVault v = FeeVault(payable(newVault));
        // 2-3. The same token, and the same creator behind it.
        if (v.LAUNCHER() != LAUNCHER || v.INTENDED_TOKEN() != address(token)) revert NotOurLaunch();
        // 4-5. Holders never lose by moving, and neither does the platform's
        //      promise: the new vault cannot take a bigger cut than this one.
        if (v.rewardsBps() < rewardsBps || v.PLATFORM_BPS() > PLATFORM_BPS) revert BadSplit();
        // 6. The same currency. `bind` below would refuse a mismatch anyway and
        //    take the whole migration down with it — after the recipient had
        //    already moved. Checking first is the difference between a
        //    migration that does not happen and one that half happens.
        if (v.QUOTE() != QUOTE) revert BadQuote();
        // 7. **The same promise.** `isVault` says the destination was born in
        //    our registry; it does not say it pays the same way. The mode is
        //    declared by the factory that built it (`DistributionFactory.MODE`) and
        //    stamped by `Payd._create`, so this compares what the two vaults
        //    promise and NOT which deployment made them: a new version of the
        //    same mode still migrates, which is the whole reason this function
        //    exists. A vault of another mode does not, however good the
        //    intention — holders bought this stream, not another one, and the
        //    only thing that lifts this is the generation key opening
        //    `crossModeMigration` on the registry. Read second and never on the
        //    ordinary path: two vaults of the same mode short-circuit before
        //    the call. Why the stamp had to exist before a second mode did:
        //    `ARCHITECTURE.md` §S46.
        if (
            IPayd(REGISTRY).modeOf(newVault) != IPayd(REGISTRY).modeOf(address(this))
                && !IPayd(REGISTRY).crossModeMigration()
        ) revert NotOurMode();

        migratedTo = newVault;
        // Immediate — this vault is the current recipient, which is the one
        // role the factory accepts here.
        FACTORY.transferCreatorFeeRecipient(address(token), newVault);
        // Atomic: the new vault is the recipient now, so it can bind now. A
        // gap would leave a bound-to-nothing vault for anyone to race.
        v.bind(address(token));

        emit Migrated(newVault);
        _moveReserve(v);
    }

    /// @dev The cash. Order matters: the pivot first, because on a
    ///      pivot-quoted vault the `fundRewards` that follows counts the
    ///      balance minus what is already promised — and `fundPivot` has just
    ///      promised the pivot that was transferred.
    ///
    ///      Both go through the destination vault's CREDITING functions and not
    ///      through a silent transfer: `fundRewards` and `fundPivot` book the
    ///      amount into the holders' pockets and emit. A bare transfer would
    ///      leave the money in a balance nothing spends.
    function _moveReserve(FeeVault v) internal {
        uint256 pivotOut = pivotReserve;
        if (pivotOut != 0) {
            pivotReserve = 0;
            if (!_sendPivot(address(v), pivotOut)) revert TransferFailed();
            v.fundPivot();
        }

        uint256 quoteOut = rewardsPool;
        if (quoteOut != 0) {
            rewardsPool = 0;
            if (QUOTE == address(0)) {
                v.fundRewards{value: quoteOut}();
            } else {
                if (!_sendQuote(address(v), quoteOut)) revert TransferFailed();
                v.fundRewards();
            }
        }

        emit ReserveMoved(address(v), quoteOut, pivotOut);
    }

    /// @notice Pays the dev share. Permissionless: the destination is immutable.
    function payCreator() external nonReentrant returns (uint256 amount) {
        amount = creatorPool;
        if (amount == 0) revert NothingToDo();
        creatorPool = 0;
        _pay(CREATOR, amount, false);
        emit CreatorPaid(CREATOR, amount);
    }

    /// @notice Pays the platform its fixed share. Permissionless, fixed
    ///         destination, exactly like `payCreator`.
    function payPlatform() external nonReentrant returns (uint256 amount) {
        amount = platformPool;
        if (amount == 0) revert NothingToDo();
        platformPool = 0;
        _pay(PLATFORM, amount, false);
        emit PlatformPaid(PLATFORM, amount);
    }

    /// @notice Raises the holders' share. **It only turns one way.**
    ///
    /// @dev    The creator can give up income, never take it back. It is the
    ///         counterpart, on the creator's side, of what `PLATFORM_BPS` being
    ///         immutable does on ours: once a holder has read the split, the
    ///         only surprise left is a good one.
    ///
    ///         The ceiling is what the platform does not take. Reaching it
    ///         leaves the creator nothing, which is allowed — and visible in
    ///         `economics()` rather than hidden in a comment.
    function setRewardsBps(uint256 bps) external {
        if (msg.sender != CREATOR) revert NotCreator();
        uint256 from = rewardsBps;
        if (bps <= from || bps + PLATFORM_BPS > BPS) revert BadSplit();
        rewardsBps = bps;
        emit RewardsBpsSet(from, bps);
    }

    // ------------------------------------------------------------ timelock

    function setAllocations(VaultTypes.Allocation[] calldata allocations_) external onlyTimelock {
        _setAllocations(allocations_);
    }

    /// @notice Sets the payout pace. It NEVER changes where funds go nor their
    ///         total, only how they are spread — and the `MIN_PAYOUT_BPS` floor
    ///         stops it being used to freeze distribution.
    function setPayoutBps(uint256 bps) external onlyTimelock {
        if (bps < MIN_PAYOUT_BPS || bps > MAX_PAYOUT_BPS) revert BadPayoutRate();
        payoutBps = bps;
        emit PayoutRateSet(bps);
    }

    /// @notice Sets the share of rewards funding the cycle's gas.
    ///         Keep it >= 10,000 / K — see `distGasBps`.
    function setDistGasBps(uint256 bps) external onlyTimelock {
        if (bps < MIN_DIST_GAS_BPS || bps > MAX_DIST_GAS_BPS) revert BadPayoutRate();
        distGasBps = bps;
        emit DistGasRateSet(bps);
    }

    /// @notice Reweights the in-kind bounty. Timelock, bounded, and it reaches
    ///         only vaults whose `QUOTE` is not ether — on an ether vault the
    ///         refund is the real cost at `block.basefee` and this is unread.
    function setKeeperBountyBps(uint256 bps) external onlyTimelock {
        if (bps < MIN_KEEPER_BOUNTY_BPS || bps > MAX_KEEPER_BOUNTY_BPS) revert BadPayoutRate();
        keeperBountyBps = bps;
        emit KeeperBountyRateSet(bps);
    }

    // ------------------------------------------------------------- internals

    function _setAllocations(VaultTypes.Allocation[] memory a) internal {
        uint256 n = a.length;
        if (n < MIN_BASKET || n > MAX_BASKET) revert BadWeights();

        delete allocations;
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (a[i].stock == address(0)) revert ZeroAddress();
            // **A line with no v3 POOL cannot be bought, and the tier alone
            // never said whether there was one.** `Payd` lists a stock at tier
            // zero for the benefit of a mode that settles elsewhere; this mode
            // swaps on v3, so it refuses here — at the moment the basket is
            // written, once, rather than by skipping the line in silence on
            // every purchase for its whole life. The pivot is the exception it
            // has always been: there is no pool of it against itself.
            //
            // **It asks the factory, and that is the fix (T-ALLOC-01).** This
            // line read `a[i].poolFee == 0` and caught only the tier nobody
            // sets by accident. The mistake a human makes is a tier that is
            // WRONG — `5000` where `500` was meant, one transposed zero, and
            // 5000 is not an enabled Uniswap v3 fee amount — which passed here
            // and cost, measured on the very next purchase: 1 leg of 2 bought,
            // 102.807424 USDG stranded in `pivotReserve`, `totalFunded` zero for
            // that stock, no revert and no alert, for the vault's whole life.
            // `Payd._allowStocks` added `_requirePool` to catch exactly this and
            // the guard was missing on the one path that reaches a LIVE vault.
            //
            // `getPool` subsumes the old test rather than joining it: the
            // factory has no pool at tier zero either, that tier never having
            // been enabled. Distinguish this from §7.5 — *delisting must not
            // reach backwards* is deliberate and stays; *writing a tier with no
            // pool at all* is not the same thing.
            if (a[i].stock != PIVOT && V3_FACTORY.getPool(a[i].stock, PIVOT, a[i].poolFee) == address(0)) {
                revert NoPool();
            }
            if (a[i].bps < MIN_ALLOC_BPS) revert BadWeights();
            // The same stock twice would pass the weight sum without anyone
            // noticing, and publish a basket describing something the vault
            // does not do.
            for (uint256 j; j < i; ++j) {
                if (a[j].stock == a[i].stock) revert BadWeights();
            }
            sum += a[i].bps;
            allocations.push(a[i]);
        }
        if (sum != BPS) revert BadWeights();
        emit AllocationsSet(a);
    }

    /// @dev True cost priced at `block.basefee`, which the caller does not
    ///      choose, and capped. See docs/ARCHITECTURE.md §S8.
    function _refundAmount(uint256 g0) internal view returns (uint256 owed) {
        uint256 used = g0 - gasleft() + REFUND_OVERHEAD;
        owed = used * block.basefee;
        if (owed > MAX_REFUND) owed = MAX_REFUND;
    }

    /// @dev Pull-based payment, as in the `Distributor`.
    ///
    ///      This function used to revert on failure. `CREATOR` being IMMUTABLE
    ///      and the contract deliberately having no owner, a payee that became unable
    ///      to receive ETH — a broken contract, a failed upgrade — blocked
    ///      `payCreator` FOREVER, and the pool accumulated with no way out.
    ///
    ///      It is the same defect fixed in `Distributor._pay`, where a proposer
    ///      with no `receive()` froze `finalize`. The lesson had not been carried
    ///      over here: a payment that fails must never cancel the action that
    ///      triggered it.
    ///
    ///      The gas cap stops a hostile recipient burning the caller's
    ///      transaction; the `Distributor` only emits an event in its `receive`,
    ///      far below it.
    function _pay(address to, uint256 amount, bool isRefund) internal {
        if (amount == 0) return;
        bool ok;
        if (QUOTE == address(0)) {
            (ok,) = to.call{value: amount, gas: 30_000}("");
        } else {
            ok = _sendQuote(to, amount);
        }
        if (ok) {
            if (isRefund) emit GasRefunded(to, amount);
            return;
        }
        pendingWithdrawal[to] += amount;
        pendingTotal += amount;
        emit PaymentDeferred(to, amount);
    }

    /// @dev An ERC-20 `transfer` that cannot take a payout down with it, the
    ///      counterpart of the 30 000-gas cap on the native path. Tokens that
    ///      return nothing are accepted, tokens that return `false` are not —
    ///      either way the amount falls back to `pendingWithdrawal` instead of
    ///      reverting the harvest that was paying it.
    function _sendQuote(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) =
            QUOTE.call{gas: 100_000}(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @notice Withdraw a payment that could not go through. Open to anyone,
    ///         each for their own balance.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = pendingWithdrawal[msg.sender];
        if (amount == 0) revert NothingToDo();
        pendingWithdrawal[msg.sender] = 0;
        pendingTotal -= amount;
        bool ok;
        if (QUOTE == address(0)) {
            (ok,) = msg.sender.call{value: amount}("");
        } else {
            ok = _sendQuote(msg.sender, amount);
        }
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice Whether the fees still come here.
    ///
    /// @dev    **`token != 0` does not mean the fees still arrive.** `bind` is
    ///         one-shot and never re-checks, so a vault can be bound and
    ///         unhooked at the same time — that is not a hypothesis, it is the
    ///         live state of Payd's own deployment
    ///         (`docs/recon-launchpad.md`). A front that reads the binding and
    ///         announces "this token distributes stocks" would be lying.
    ///
    ///         Who can actually unhook us, once bound:
    ///
    ///         - **not the creator.** `transferCreatorFeeRecipient` is reserved
    ///           to the CURRENT recipient, and the factory rejects the token's
    ///           `deployer` outright (verified on-chain, `docs/recon.md` §1.3);
    ///         - **Pons**, through its `onlyOwner` path, with three days' notice
    ///           and no veto on our side. That is what `Redirecting` reports;
    ///         - **us**, through the escape valve — and D6 bounds where it can
    ///           lead.
    ///
    ///         A matured proposal that nobody executed **expires**. So a
    ///         `Redirecting` that runs past `expiresAt` returns to `Hooked` on
    ///         its own, with no transaction from anyone.
    enum Hook {
        Unbound,
        Hooked,
        Redirecting,
        Lost
    }

    /// @notice When `flagHookLost` first recorded a loss. 0 = never.
    uint64 public hookLostAt;

    function hookStatus() external view returns (Hook status, address current, uint64 effectiveAt) {
        if (address(token) == address(0)) return (Hook.Unbound, address(0), 0);

        current = FACTORY.getLaunchedToken(address(token)).creatorFeeRecipient;
        if (current != address(this)) return (Hook.Lost, current, 0);

        (address pending, uint256 at, uint256 expires) = FACTORY.pendingCreatorFeeRecipient(address(token));
        // A proposal past its window is dead, not pending. Reporting it as
        // `Redirecting` for ever would cry wolf on every page that reads this.
        if (pending != address(0) && block.timestamp <= expires) {
            return (Hook.Redirecting, pending, uint64(at));
        }
        return (Hook.Hooked, current, 0);
    }

    /// @notice Puts on record that the fees no longer come here.
    ///
    /// @dev    **Informational, and deliberately not a switch.** It stamps a
    ///         date and emits; the vault keeps harvesting what the escrow
    ///         already credited it, keeps running epochs on its reserve, and
    ///         keeps paying claims for ever. Nothing is stuck and nothing is
    ///         lost — a flag that froze the vault would turn somebody else's
    ///         decision into our holders' problem.
    ///
    ///         Permissionless, because noticing is the only defence there is.
    function flagHookLost() external {
        (Hook status, address current,) = this.hookStatus();
        if (status != Hook.Lost) revert StillHooked();
        if (hookLostAt == 0) hookLostAt = uint64(block.timestamp);
        emit HookLost(current, block.timestamp);
    }

    /// @notice What this vault really takes, in points of the token's VOLUME,
    ///         derived from Pons's parameters as they stand at the call.
    ///
    /// @dev    Nothing here is written down. The split in storage is expressed
    ///         in bps of what ARRIVES, and what arrives depends on two Pons
    ///         numbers that are not ours:
    ///
    ///             gross = creatorTaxBps + curveFeeBps x (1 - protocolFeeShare)
    ///
    ///         At `tax = 400`, `curveFee = 100` and a Pons share of 3,000 that
    ///         is 470 bps — the 4.70 % measured in `docs/recon.md` §1.9. Pons
    ///         may raise its share to 5,000, which drops it to 450. **All three
    ///         parts shrink together** (`PLAN.md` D7), and the front shows the
    ///         new numbers the day it happens, without a redeployment and
    ///         without a lie.
    ///
    ///         Every read DEGRADES: a Pons upgrade that moves a getter returns
    ///         zeroes here rather than reverting, so a page that cannot get the
    ///         truth shows nothing instead of showing something stale. A real
    ///         `curveFeeBps` is never 0 — that is the caller's signal.
    ///
    ///         `launchConfigId` 0 is assumed: it is the only one that exists
    ///         (`launchConfigCount() = 1`, read 2026-09-08) and the launch
    ///         record does not say which one a token used. If Pons ever adds a
    ///         second, this view can misreport by at most the curve fee — one
    ///         point of volume — and no money moves on it.
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
        // The residue, exactly as `harvest` computes it — deriving it the same
        // way is what stops the page and the contract from drifting apart.
        creatorOfVolumeBps = grossOfVolumeBps - rewardsOfVolumeBps - platformOfVolumeBps;
    }

    /// @dev The curve fee, second word of `getLaunchConfig(0)`. Read by position:
    ///      the deployed factory returns 7 words and the local source we had
    ///      described 10 fields, so the names are not to be trusted — the
    ///      positions were decoded on-chain (`docs/recon-launchpad.md` R6.b).
    function _curveFeeBps() internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            address(FACTORY).staticcall{gas: 60_000}(abi.encodeWithSelector(bytes4(0x1cad862d), uint256(0)));
        if (!ok || ret.length < 64) return 0;
        (, uint256 curveFee) = abi.decode(ret, (uint256, uint256));
        return curveFee;
    }

    /// @dev Pons's cut of the curve fee, on the HOOK and not on the factory.
    ///      Mutable by Pons, capped at 5,000 (`docs/recon.md` §9.5), and read
    ///      afresh every time rather than frozen at deployment.
    function _ponsShareBps() internal view returns (uint256) {
        address hook = address(uint160(_staticUint(address(FACTORY), IPonsV2MemeHookSource.memeHook.selector, 0)));
        if (hook == address(0)) return 0;
        uint256 share = _staticUint(hook, bytes4(0x9040f866), BPS + 1);
        return share > BPS ? 0 : share;
    }

    function getAllocations() external view returns (VaultTypes.Allocation[] memory a) {
        uint256 n = allocations.length;
        a = new VaultTypes.Allocation[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = allocations[i];
        }
    }
}
