// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeVault} from "./FeeVault.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {IUniswapV3Factory} from "./interfaces/IExternal.sol";
import {FullMath} from "./libraries/FullMath.sol";
import {VaultTypes} from "./interfaces/VaultTypes.sol";

interface IV3PoolLiquidity {
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
}

/// @title  Payd
/// @notice Makes the vault pairs, keeps their registry, and holds the two
///         parameters a creator is not allowed to choose alone: which stocks a
///         basket may contain, and what the platform takes.
///
/// @dev    **It launches nothing.** A creator makes their vault here, launches
///         their own token on Pons with that vault as `creatorFeeRecipient`,
///         and anybody then calls `FeeVault.bind`. So this contract is the Pons
///         `deployer` of no token and inherits no standing power over any of
///         them — the creator stays the owner of their launch, and we could not
///         take it from them if we wanted to.
///
///         That shape is borrowed from StockBoundRH, which got it right; the
///         rest of its trust model is what `PLAN.md` §10 declines.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract Payd {
    // ----------------------------------------------------------------- errors

    error NotTimelock();
    error NotGenerationKey();
    error NotApproved(address candidate);
    error ZeroAddress();
    error StockNotAllowed(address stock);
    error WrongPoolFee(address stock, uint24 want, uint24 got);
    error WrongFeed(address stock, address want, address got);
    error PlatformBpsTooHigh(uint256 given, uint256 cap);
    error LengthMismatch();
    /// @notice An empty rotation range. Naming a slice that contains nothing is
    ///         a mistake worth hearing about, not a no-op worth paying for.
    error EmptyRange(uint256 from, uint256 to);
    error QuoteNotAllowed(address quote);
    error RouteTooThin(address quote, uint256 depth, uint256 required);
    /// @dev The keeper and the co-signer at one address. Refused on both
    ///      setters, the same way `Distributor` refuses it on both of its own.
    error RoleCollapse(address who);
    /// @dev A vault was about to be born while this registry names a co-signer,
    ///      and its Distributor did not take it. **The creation reverts rather
    ///      than continuing single-key**: see `_create`.
    error CoSignerStampFailed(address vault, address distributor);
    error BadMode();
    error FactoryNotEnabled(address factory);
    error FactoryIsTheDefault(address factory);
    /// @notice A tier that names no pool, or an empty one. What the list
    ///         promises does not exist, and the vault would find out in
    ///         silence.
    error NoLiquidityAt(address token, address against, uint24 poolFee);

    /// @notice A quote the platform's till cannot convert back into ether.
    ///         The way in would exist and the way out would not.
    error QuoteNotSweepable(address quote);

    // ----------------------------------------------------------------- events

    event VaultCreated(
        address indexed vault,
        address indexed distributor,
        address indexed creator,
        uint256 rewardsBps,
        uint256 platformBps,
        uint256 epochLength,
        address intendedToken
    );
    event StockAllowed(address indexed stock, uint24 poolFee, address feed);
    event StockRemoved(address indexed stock);
    event QuoteAllowed(address indexed quote, uint24 poolFee, uint24 wethFee, uint256 minBuy);
    event QuoteRemoved(address indexed quote);
    event PlatformBpsSet(uint256 from, uint256 to);
    event KeeperSet(address from, address to);
    event KeeperAllowed(address indexed keeper, bool allowed);
    event KeeperRotated(address indexed keeper, uint256 from, uint256 to, uint256 rotated);
    /// @dev Named, not swallowed: a vault the rotation could not reach is the
    ///      one an operator has to go and look at by hand.
    event KeeperRotationSkipped(address indexed vault, address indexed distributor);
    event CoSignerSet(address from, address to);
    event CoSignerRotated(address indexed coSigner, uint256 from, uint256 to, uint256 rotated);
    event CoSignerRotationSkipped(address indexed vault, address indexed distributor);
    event Approved(address indexed candidate, bool approved);
    /// @dev `mode` is the new factory's `MODE`. It is in the event because a
    ///      change of MODE is a change of product for every launch that
    ///      follows, and it would otherwise be indistinguishable from a routine
    ///      upgrade of the vault code — same function, same two keys, same 48 h.
    ///      It touches no existing vault: those are stamped at birth and
    ///      `migrate` compares the stamps.
    event FactorySet(address indexed from, address indexed to, bytes32 mode);
    event CrossModeMigrationSet(bool state);
    event FactoryEnabled(address indexed factory, bytes32 mode);
    event FactoryDisabled(address indexed factory);
    event TreasurySet(address indexed from, address indexed to);

    // -------------------------------------------------------------- constants

    /// @notice Bounds on a vault's epoch, the grain of every snapshot.
    ///
    /// @notice The most the platform could ever ask of a FUTURE vault.
    ///
    /// @dev    `FeeVault.MAX_PLATFORM_BPS` refuses anything above this at the
    ///         vault's own birth, so this is a second lock on the same door —
    ///         the one a reader of THIS contract can check without opening the
    ///         other.
    uint256 public constant MAX_PLATFORM_BPS = 1_500;

    // ------------------------------------------------------------- immutables

    address public immutable TIMELOCK;
    /// @notice Where every vault sends the platform's share: the Treasury.
    address public immutable PLATFORM;

    // Pons and Uniswap, verified on-chain (`docs/recon.md` §1.1, §3.1). Passed
    // to each vault rather than read from a registry: a vault that could be
    // re-pointed at another router is a vault we could drain.
    address public immutable ESCROW;
    address public immutable PONS_FACTORY;
    address public immutable ROUTER;
    address public immutable V3_FACTORY;
    address public immutable WETH;
    address public immutable PIVOT;
    uint24 public immutable ETH_PIVOT_FEE;
    address public immutable ETH_USD;

    /// @notice The **sanity** bar on a listed quote's route, in raw `PIVOT`
    ///         units: $500 of active depth at +1 %, on the thinnest hop.
    ///
    /// @dev    **It is deliberately an order of magnitude under the policy bar,
    ///         and that is the whole design (T-QUOTE-01).**
    ///         `docs/allowlist.md` sets $5 000 and re-measures it off-chain;
    ///         this refuses only the gross error. `_requirePool` admitted any
    ///         pool on `liquidity() != 0`, and cbBTC/USDG tier 3000 — a REAL
    ///         tier, alive, with **two dollars** in range — was therefore
    ///         listable by a timelock that copied `3000` out of the token's WETH
    ///         row into the pivot column. The vault it mints is stamped with
    ///         that quote for life, `removeQuotes` reaching none of them.
    ///
    ///         **Why not $5 000 on-chain.** Active liquidity at the current tick
    ///         is not a constant: the same cbBTC/WETH pool read $158 774,
    ///         $4 166, $4 927, $2 496, $9 546 and $11 302 inside a few hours on
    ///         2026-09-11, with its DEPOSITS unchanged throughout
    ///         (`docs/recon.md` §4.5bis). At $5 000 the registry's own seed does
    ///         not deploy at half the blocks of that afternoon, which turns a
    ///         deployment into a coin toss on a quantity nobody controls. A
    ///         volatile measurement belongs behind a policy, not behind a
    ///         revert; what belongs behind a revert is the typo.
    uint256 public immutable MIN_ROUTE_DEPTH;

    uint256 internal constant Q96 = 2 ** 96;
    /// @dev `sqrt(1.01) - 1`, as a fraction: the share of a pool's active
    ///      liquidity inside a +1 % move. `docs/allowlist.md`'s own formula.
    uint256 internal constant DEPTH_K_NUM = 4_987_562;
    uint256 internal constant DEPTH_K_DEN = 1_000_000_000;
    uint256 internal constant MIN_ROUTE_DEPTH_USD = 500;

    /// @dev The name `contracts/modes/ModeFactory.sol` shipped with until
    ///      2026-09-11. Refused at the door: see `_enable`.
    bytes32 internal constant MODE_PLACEHOLDER = "TODO-name-this-mode";

    // ------------------------------------------------------------------ state

    /// @notice What each new vault will be stamped with. Changing it never
    ///         touches a vault that already exists — that is the whole point of
    ///         `PLATFORM_BPS` being written once, at the vault's birth.
    uint256 public platformBps;

    /// @notice The address allowed to publish roots on every new Distributor.
    address public keeper;

    /// @notice **The second key on a root, registry-wide.** Stamped into every
    ///         Distributor this registry creates, and pushed into the ones
    ///         already live by `rotateCoSigner`.
    ///
    /// @dev    `Distributor.coSigner` is what actually gates a publication; this
    ///         is where a new vault gets its value from, so that the protection
    ///         is on at birth rather than after a per-vault timelock call
    ///         nobody remembers to make. Zero — the state at deployment — means
    ///         new vaults are born single-key, which is what every vault made
    ///         before this existed already is.
    address public coSigner;
    /// @notice Extra publishers, on top of each Distributor's own pinned key.
    ///
    /// @dev    **The set lives here and not in each Distributor, because a set
    ///         that lived there would have to be written vault by vault.** The
    ///         whole reason for it is to stop one hot key being a single point
    ///         of failure across a thousand vaults; a remedy that needs a
    ///         thousand writes is not one.
    ///
    ///         It only ever ADDS **publication**, which is the whole of what
    ///         that sentence was ever true about. A Distributor checks its own
    ///         `keeper` first and asks here only if that did not match, so
    ///         nothing in this mapping can take publication away from a vault,
    ///         and a registry that stops answering cannot stop one either.
    ///
    ///         **What it adds can still take the SECOND KEY away, and this
    ///         comment is what hid that** (`docs/AUDIT_PAYD.md` F-1). The
    ///         sentence above is what a reader takes from this mapping, and it
    ///         answers a question nobody was going to ask. The one that
    ///         mattered: `allowKeeper(coSigner, true)` — one timelock call with
    ///         an entirely plausible operational motive, "let the second node
    ///         publish while the keeper box is down" — makes one secret both
    ///         the sender `Distributor._publish` accepts and the signer
    ///         `publishRoot` recovers, on every vault of this registry at once,
    ///         with `coSignerRequired()` still reading true and the root
    ///         recorded as co-signed. The four guards that refuse the collapse
    ///         (`setKeeper`, `setCoSigner`, and both of `Distributor`'s) all
    ///         compare against ONE address, the pinned `keeper`; not one of
    ///         them reads this mapping.
    ///
    ///         So the refusal lives here too, in both directions:
    ///         `allowKeeper` refuses to ADD the co-signer, and `setCoSigner`
    ///         refuses an address this mapping already names. Unnaming stays
    ///         legal — `allowKeeper(x, false)` has to work even when `x` is the
    ///         co-signer, or the mistake could be made and never undone.
    ///
    ///         It compares against `coSigner`, this registry's default. A
    ///         Distributor handed a different co-signer of its own is outside
    ///         the comparison — the same approximation `setKeeper` already
    ///         makes, said out loud rather than sold as complete
    ///         (`test/RoleCollapseThirdPath.t.sol` pins it).
    mapping(address keeper => bool allowed) public isKeeper;

    /// @notice **The second authority, and the only reason `setFactory` is
    ///         worth more than one signature.**
    ///
    /// @dev    Immutable, cold — a hardware wallet kept apart from the Safe
    ///         signers — and it holds nothing. It CANNOT name a factory: it can
    ///         only authorise an address to become one. The timelock still has
    ///         to schedule the operation and wait out its 48 h.
    ///
    ///         **What that closes, and what it does not.** No contract can
    ///         verify that an unknown contract is a real factory: everything
    ///         you would read from it, it writes. So this makes nothing
    ///         "legitimate". It turns one compromise into two, independent —
    ///         which is worth something only if the key is kept differently
    ///         from the Safe. Same hardware, same drawer, and we would have
    ///         added code for nothing.
    ///
    ///         **It guards one door, and one only: `setFactory`.** There were
    ///         two — `setSuccessor` named the next generation's registry, and
    ///         `recognised` walked the chain so `migrate` would accept a vault
    ///         from elsewhere. That chain has been deleted: the implementations
    ///         live in `DistributionFactory`, so a new vault version is born in THIS
    ///         registry and `migrate` recognises it through `isVault` alone.
    ///         There is no next generation to name any more, hence no weakest
    ///         link to count.
    address public immutable GENERATION_KEY;

    /// @notice The factories the generation key has looked at.
    ///
    /// @dev    **This is the vault code's lineage, readable on-chain.** What
    ///         was approved stays approved: you can see which versions were
    ///         ever judged good, not only which one runs today. The Treasury
    ///         keeps its own table for its own doors — an approval here grants
    ///         nothing there, and the reverse.
    mapping(address candidate => bool) public approved;

    /// @notice **The vault factory.** What `Payd` used to do itself, and what
    ///         weighed 40 of the 54 kilobytes of its initcode.
    ///
    /// @dev    Replaceable under the two keys, and that is what makes a
    ///         vault-code upgrade almost dull: a new `FeeVault` implementation
    ///         is a new factory, and the vaults that follow are born in THIS
    ///         registry. `migrate` then recognises them through `isVault`
    ///         alone — which is what allowed `setSuccessor`, the most dangerous
    ///         power in the system, to be deleted rather than guarded.
    ///
    ///         It is a class (a) function: a hostile factory builds vaults that
    ///         get registered here, hence valid `migrate` destinations. Hence
    ///         the two keys.
    IVaultFactory public factory;

    /// @notice **Every factory this registry will build through, and the mode
    ///         each one builds.** Zero means not enabled — which is the state
    ///         of every address in the world until both keys say otherwise.
    ///
    /// @dev    This is what makes `Payd` an interface over factories rather
    ///         than a pointer to one. `factory` above is only the DEFAULT, the
    ///         one `createVault` uses; `createVaultWith` names any enabled one.
    ///
    ///         Read from the factory once, when it is enabled, and never again:
    ///         a factory that declares no mode is refused on the spot instead
    ///         of bricking every launch that follows, and a creation pays a
    ///         warm SLOAD instead of an external call.
    ///
    ///         **Two keys to get in here, the same two as ever.** The
    ///         generation key approves the code (`approved`), the timelock
    ///         enables it, 48 h. Neither alone puts a factory in this mapping,
    ///         and being in it is what makes a factory's vaults `isVault` —
    ///         hence valid `migrate` destinations. That is the class (a) door,
    ///         and widening it to several factories does not widen who opens
    ///         it.
    mapping(address factory => bytes32 mode) public factoryMode;

    /// @notice The stocks a basket may hold, and the pool tier and Chainlink
    ///         feed each one must be declared with.
    ///
    /// @dev    **The tier and the feed are pinned, not only the address.** The
    ///         likeliest honest mistake is the right stock at a tier with no
    ///         pool, and the likeliest deliberate one is `feed = address(0)` on
    ///         a stock that has a feed — which quietly drops the vault's floor
    ///         to the TWAP alone. Neither is a theft path, both are downgrades
    ///         a creator should not be able to choose by themselves.
    struct Listing {
        uint24 poolFee;
        address feed;
        bool allowed;
    }

    mapping(address stock => Listing) public listing;

    /// @notice The currencies a launch may be quoted in, besides native ETH.
    ///
    /// @dev    **Why a second allowlist rather than reusing `listing`.** A
    ///         basket stock needs a tier and a feed; a QUOTE needs a tier and a
    ///         minimum purchase, and the two lists do not overlap — USDG is a
    ///         legitimate quote and will never be a basket line. Merging them
    ///         would mean a struct where half the fields are dead in half the
    ///         rows.
    ///
    ///         `minBuy` is here and not in the vault because `MIN_BUY` cannot
    ///         be one constant across three decimal scales: 0.01 ether of raw
    ///         USDG is ten billion dollars. It is the only per-quote number the
    ///         vault cannot derive on its own.
    struct QuoteListing {
        /// @dev Tier of the QUOTE/PIVOT pool. Zero for the pivot itself, which
        ///      makes no hop at all, and zero for a currency that goes through
        ///      the WETH detour.
        uint24 poolFee;
        /// @dev Tier of the QUOTE/WETH pool — **the fallback route**. A
        ///      currency can be deeply traded against WETH and invisible
        ///      against the pivot: measured 2026-09-08, COIN ($33 144 of WETH
        ///      depth) and cbBTC ($158 774) have no pivot pool at all and
        ///      between them carried 198 of the ~220 weekly credits of the
        ///      otherwise-unreachable pairs.
        ///
        ///      Exactly one of the two tiers is non-zero. The route is
        ///      declared, never guessed: it is the one the timelock measured.
        uint24 wethFee;
        /// @dev `FeeVault.MIN_BUY_QUOTE`, in this quote's raw units.
        uint256 minBuy;
        bool allowed;
    }

    mapping(address quote => QuoteListing) public quoteListing;

    mapping(address vault => bool) public isVault;

    /// @notice **What each vault promises its holders**, stamped at birth from
    ///         the mode of the factory that built it.
    ///
    /// @dev    `isVault` says a vault was born here; it does not say it pays
    ///         the same way. As long as one mode exists the two questions have
    ///         the same answer, which is exactly why this has to be written
    ///         before a second mode exists rather than after: this contract is
    ///         the one that cannot be replaced without stranding `migrate` for
    ///         every vault already registered.
    ///
    ///         Zero for an address this registry never built, which is what
    ///         makes the check in `FeeVault.migrate` fail closed.
    mapping(address vault => bytes32) public modeOf;

    /// @notice **The door between two modes, and it is shut.**
    ///
    /// @dev    `FeeVault.migrate` refuses a destination of another mode. This
    ///         is the one thing that lifts that refusal, and it is `false` at
    ///         birth — no constructor argument, no wiring field, nothing to get
    ///         wrong on deployment night.
    ///
    ///         **Held by the generation key, and that is the whole design.**
    ///         Flipping it moves nothing and migrates nothing: it only lets the
    ///         timelock schedule a migration it must still wait 48 h for. So
    ///         the two authorities keep the property they have everywhere else
    ///         — the cold key authorises and never triggers, the timelock
    ///         triggers and cannot authorise itself. A single compromised key,
    ///         either one, moves no holder into another promise.
    ///
    ///         **What it does NOT do.** It is global while it is open: for as
    ///         long as it stays `true`, every vault in this registry is a
    ///         cross-mode destination away from a timelock operation. It is
    ///         meant to be opened for one migration and closed after it, and
    ///         nothing in this contract enforces that discipline — making it
    ///         self-closing would mean letting a vault write here, which is a
    ///         door of its own and a worse one. `ARCHITECTURE.md` §S46.
    bool public crossModeMigration;
    address[] public allVaults;
    mapping(address creator => address[]) internal _byCreator;

    modifier onlyTimelock() {
        if (msg.sender != TIMELOCK) revert NotTimelock();
        _;
    }

    /// @notice The two lists, as they exist AT THE FIRST BLOCK.
    ///
    /// @dev    **The timelock guards changes, not the initial state.** The
    ///         deployer already chooses everything that matters — the timelock
    ///         itself, the Treasury, the keeper, `platformBps`, the factory.
    ///         Asking it for 48 h of permission on a list it has just written
    ///         is asking permission of oneself, and during those 48 h the
    ///         platform is deployed, visible, and refuses every basket.
    ///         "Deployed" reads as "open" to everyone who does not have the
    ///         runbook in front of them.
    ///
    ///         What the delay protects stays protected: `allowStocks`,
    ///         `allowQuotes`, `removeStocks` and `removeQuotes` remain
    ///         `onlyTimelock` for everything that comes AFTER. The seed goes
    ///         through the SAME checks — same internal function, same
    ///         refusals — so there is no one set of rules for birth and another
    ///         for the rest.
    ///
    ///         Empty arrays are valid: it is then a registry that opens only at
    ///         the first vote, and a test measures exactly that.
    struct Seed {
        address[] stocks;
        uint24[] stockFees;
        address[] feeds;
        address[] quotes;
        uint24[] quoteFees;
        uint24[] quoteWethFees;
        uint256[] minBuys;
    }

    struct Wiring {
        address timelock;
        address platform;
        address keeper;
        /// @dev **The second key on a root, and zero is legal.** It is here
        ///      rather than only in `setCoSigner` because the genesis vault is
        ///      minted in this contract's constructor: there is no moment
        ///      between "the registry exists" and "the first vault exists" in
        ///      which a governance call could run, and `setCoSigner` is
        ///      `onlyTimelock` behind a 48 h delay. Without this field the
        ///      platform's own vault is single-key for two days, which is the
        ///      one window where the keeper risk cannot be answered at all.
        address coSigner;
        address escrow;
        address ponsFactory;
        address router;
        address v3Factory;
        address weth;
        /// @dev The currency everything routes through. USDG on this chain,
        ///      but it is a PARAMETER: a registry redeployed with another value
        ///      builds vaults that pivot elsewhere.
        address pivot;
        /// @dev Tier of the WETH/PIVOT pool, first hop of an ETH-quoted vault.
        ///      Used to be a constant in the vault — the last welded pool on
        ///      the money path.
        uint24 ethPivotFee;
        address ethUsdFeed;
        /// @dev The second authority on `setFactory`. Cold, kept apart from
        ///      the Safe, and holding no other power.
        address generationKey;
        /// @dev The vault factory, deployed before this contract.
        address factory;
    }

    /// @notice The very first vault, the platform token's own.
    ///
    /// @dev    **It is born in this constructor, and that is what closes the
    ///         cycle.** Three immutable addresses stood in a circle: the
    ///         registry points at the Treasury, the Treasury at the platform
    ///         vault, and the vault at its registry. A cycle of three cannot be
    ///         deployed in one pass, and predicting it does not work from a
    ///         script — there, the creator of the `new` calls is the script
    ///         contract in simulation and the EOA at broadcast.
    ///
    ///         Building it here cuts the cycle: `address(this)` is known, so
    ///         the vault knows its registry from birth like every other one.
    ///         All that is left is naming the Treasury afterwards, under two
    ///         keys.
    ///
    ///         **`platformBps = 0`, and no window in which that could be true
    ///         of anyone else.** Charging the platform token the platform share
    ///         would be the Treasury paying itself through two hops, and
    ///         `economics()` would display a cut its holders do not actually
    ///         bear. Dropping the global rate to zero for the length of one
    ///         vault would open 48 h during which anyone would be born exempt;
    ///         here there is no moment to seize, the registry does not exist
    ///         yet.
    struct Genesis {
        address launcher;
        uint256 rewardsBps;
        uint256 epochLength;
        VaultTypes.Allocation[] basket;
    }

    /// @notice The platform token's vault and its Distributor, as this
    ///         constructor built them.
    address public platformVault;
    address public platformDistributor;

    constructor(Wiring memory w, uint256 platformBps_, Seed memory seed, Genesis memory g) {
        if (
            w.timelock == address(0) || w.platform == address(0) || w.keeper == address(0) || w.escrow == address(0)
                || w.ponsFactory == address(0) || w.router == address(0) || w.v3Factory == address(0)
                || w.weth == address(0) || w.pivot == address(0) || w.ethPivotFee == 0 || w.ethUsdFeed == address(0)
                || w.generationKey == address(0) || w.factory == address(0)
        ) revert ZeroAddress();
        if (platformBps_ > MAX_PLATFORM_BPS) revert PlatformBpsTooHigh(platformBps_, MAX_PLATFORM_BPS);

        TIMELOCK = w.timelock;
        PLATFORM = w.platform;
        keeper = w.keeper;
        // Before `_create` below, which stamps the genesis vault with it.
        // The same refusal both setters make: a second key that IS the first is
        // a second secret held by whoever holds the first.
        if (w.coSigner != address(0) && w.coSigner == w.keeper) revert RoleCollapse(w.coSigner);
        coSigner = w.coSigner;
        ESCROW = w.escrow;
        PONS_FACTORY = w.ponsFactory;
        ROUTER = w.router;
        V3_FACTORY = w.v3Factory;
        WETH = w.weth;
        PIVOT = w.pivot;
        ETH_PIVOT_FEE = w.ethPivotFee;
        ETH_USD = w.ethUsdFeed;
        // `decimals()` is optional in ERC-20 and the pivot is not ours, so it is
        // read defensively and falls back to the six USDG carries. A dollar bar
        // has to be in the pivot's units or it means nothing: 500 raw units of a
        // 6-decimal token is $0.0005, and of an 18-decimal one it is nothing at
        // all.
        MIN_ROUTE_DEPTH = MIN_ROUTE_DEPTH_USD * 10 ** _decimalsOf(w.pivot);
        GENERATION_KEY = w.generationKey;
        _setFactory(w.factory);
        platformBps = platformBps_;

        // Both lists, written here and not 48 h later. Same path as a vote:
        // if the seed is bad, the deployment reverts.
        _allowStocks(seed.stocks, seed.stockFees, seed.feeds);
        _allowQuotes(seed.quotes, seed.quoteFees, seed.quoteWethFees, seed.minBuys);

        // And the first vault, right after: the lists have just been written,
        // so `_checkBasket` has something to answer with.
        if (g.launcher != address(0)) {
            (platformVault, platformDistributor) = _create(
                address(factory), g.launcher, g.basket, g.rewardsBps, g.epochLength, address(0), 0, address(0), ""
            );
        }
    }

    // ------------------------------------------------------------ 1. creating

    /// @notice Makes a vault and its Distributor. **Step one of three.**
    ///
    /// @dev    The caller becomes the vault's `LAUNCHER`, which is the address
    ///         `bind` will require to be the token's Pons deployer. So the
    ///         creator launches on Pons themselves, with this vault as
    ///         `creatorFeeRecipient`, and anybody can then call `bind`. Two
    ///         conditions checked together, and neither is ours to satisfy.
    ///
    ///         A vault made and never launched costs nobody anything: it holds
    ///         nothing and binds to nothing.
    ///
    /// @param  intendedToken zero for a launch, or the token a MIGRATION vault
    ///         is allowed to bind to (`FeeVault.migrate`).
    function createVault(
        VaultTypes.Allocation[] calldata basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken
    ) external returns (address vault, address distributor) {
        // The rate of the day, read here and now. Nobody calling this path can
        // choose it — that is the whole reason it is not a parameter.
        return _create(
            address(factory), msg.sender, basket, rewardsBps, epochLength, intendedToken, platformBps, address(0), ""
        );
    }

    /// @notice The same vault, quoted in something other than native ETH.
    ///
    /// @dev    Split from `createVault` rather than added to it: the ETH path
    ///         is the one every existing caller, script and front page uses,
    ///         and a fourth positional argument on it would be a silent break
    ///         for all of them.
    ///
    ///         `quote` must be on the allowlist, and that is not a formality —
    ///         it carries the USDG tier the vault swaps through and the
    ///         minimum purchase its decimals imply. A quote nobody listed has
    ///         neither, and a vault born without them buys nothing, for good.
    ///
    /// @param  quote the launch's `pairToken`. `bind` will refuse any other.
    function createVaultQuoted(
        VaultTypes.Allocation[] calldata basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken,
        address quote
    ) external returns (address vault, address distributor) {
        return _create(
            address(factory), msg.sender, basket, rewardsBps, epochLength, intendedToken, platformBps, quote, ""
        );
    }

    /// @notice **The same launch, built by a factory the caller names** — which
    ///         is how two payout modes live in one registry.
    ///
    /// @dev    `createVault` builds through the default and always will; this
    ///         one reaches any factory both keys have enabled. The vault is
    ///         stamped with THAT factory's mode (`modeOf`), and `FeeVault.migrate`
    ///         then refuses to move a vault of one mode into a vault of another.
    ///         So the modes coexist without ever leaking into each other.
    ///
    ///         Permissionless, exactly like `createVault`, and it adds no power:
    ///         the only addresses it can reach are those already in
    ///         `factoryMode`, which takes the generation key AND the timelock to
    ///         write. What the caller chooses is which of the enabled modes they
    ///         launch under — never what code runs.
    ///
    ///         One function for both currencies rather than two: nothing existed
    ///         yesterday to break, so `quote` is a plain parameter here and
    ///         `address(0)` still means native ETH.
    ///
    /// @param  factory_ an ENABLED factory. `address(0)` is not special: it is
    ///         simply never enabled.
    /// @param  modeData **the mode's own per-launch parameter, and this registry
    ///         never looks inside it.** It is forwarded to the factory as it
    ///         arrived and decoded there, or refused there.
    ///
    ///         It exists because the three scopes were not the same and only
    ///         two had a home. Platform-wide values are this contract's
    ///         immutables; per-MODE values are the factory's, written when it is
    ///         deployed. What had nowhere to go is the value a LAUNCHER chooses
    ///         and that differs from one launch to the next — a payout currency,
    ///         a threshold, a schedule. Putting such a value in the factory
    ///         would mean one factory per value, hence one `MODE` per value, and
    ///         `migrate` compares modes: two launches of the same product would
    ///         stop being migratable into each other.
    ///
    ///         Opaque ON PURPOSE. A registry that decoded this would be learning
    ///         a mode's parameters, which is the one thing it is built not to do
    ///         — and every future mode would need it redeployed. `bytes` is what
    ///         a mode cannot outgrow.
    ///
    ///         Only on this path. `createVault` and `createVaultQuoted` are what
    ///         every front page, script and existing caller uses, and the
    ///         distribution mode has no per-launch parameter to pass: they send
    ///         `""` and their signatures do not move.
    function createVaultWith(
        address factory_,
        VaultTypes.Allocation[] calldata basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken,
        address quote,
        bytes calldata modeData
    ) external returns (address vault, address distributor) {
        if (factoryMode[factory_] == bytes32(0)) revert FactoryNotEnabled(factory_);
        return
            _create(factory_, msg.sender, basket, rewardsBps, epochLength, intendedToken, platformBps, quote, modeData);
    }

    /// @notice **The platform's own token, exempted — and nothing else.**
    ///
    /// @dev    `$PAYD` funds the platform; charging it the platform fee would
    ///         be the Treasury paying itself through two hops, and would show
    ///         up in `economics()` as a cut its holders never actually lose.
    ///         So its vault is born at `platformBps = 0`.
    ///
    ///         **Why a guarded function rather than turning the global to zero
    ///         for a moment.** The rate is stamped into a vault FOR EVER at
    ///         birth. Lowering `platformBps` to zero, creating one vault and
    ///         raising it back takes two timelock operations — 48 h each — and
    ///         during that window anyone launching would get a permanently
    ///         exempt vault. This path opens no window: it is one call, and only
    ///         the timelock can make it.
    ///
    ///         **The power this adds, stated plainly.** The timelock can now
    ///         mint a vault at any rate for anyone. That is not a new kind of
    ///         power — it already sets `platformBps` for every future vault, so
    ///         it could already forgo the platform's revenue. What changes is
    ///         precision: it can now do it for ONE launch instead of for
    ///         everyone at once. It still cannot move a wei, here or anywhere.
    ///
    /// @param  launcher the address `bind` will require to be the token's Pons
    ///         deployer. The timelock creates the vault, but it is the launcher
    ///         who must launch — those are two different keys on purpose.
    /// @param  factory_ the mode to build under. It must be ENABLED, exactly as
    ///         in `createVaultWith` — the timelock chooses among the modes both
    ///         keys admitted, never what code runs.
    /// @param  quote the launch's currency, `address(0)` for native ETH.
    /// @param  modeData the mode's per-launch parameter, forwarded unread.
    ///
    /// @dev    **These three arrived late, and the reason is worth recording.**
    ///         This function was wired to the default factory, to native ETH and
    ///         to an empty `modeData`. Its whole job is to give a MIGRATION a
    ///         destination when the launcher will not or cannot make one, and
    ///         `FeeVault.migrate` requires a destination whose `LAUNCHER`
    ///         matches — which only this function can set for someone else.
    ///
    ///         So the three constants each removed a class of vault from the
    ///         reach of any migration the launcher did not personally perform:
    ///         every vault of a SECONDARY MODE, every vault quoted in anything
    ///         but ETH, and every mode with a per-launch parameter. A vault
    ///         whose launcher has gone quiet could never be moved to a newer
    ///         implementation — for ever, since a vault's code is fixed at birth.
    ///
    ///         It grants nothing new. The timelock already names the default
    ///         factory, already writes the quote list, and still cannot make a
    ///         vault that pays more platform than the cap nor less to holders
    ///         than the floor. What changes is that the function can now reach
    ///         the vaults it exists to serve.
    function createVaultFor(
        address factory_,
        address launcher,
        VaultTypes.Allocation[] calldata basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken,
        uint256 platformBps_,
        address quote,
        bytes calldata modeData
    ) external onlyTimelock returns (address vault, address distributor) {
        if (launcher == address(0)) revert ZeroAddress();
        if (platformBps_ > MAX_PLATFORM_BPS) revert PlatformBpsTooHigh(platformBps_, MAX_PLATFORM_BPS);
        // The same gate as `createVaultWith`, and for the same reason: the
        // timelock picks among the modes BOTH keys admitted. It does not get a
        // private door to code the generation key never saw.
        if (factoryMode[factory_] == bytes32(0)) revert FactoryNotEnabled(factory_);
        return
            _create(factory_, launcher, basket, rewardsBps, epochLength, intendedToken, platformBps_, quote, modeData);
    }

    function _create(
        address factory_,
        address launcher,
        VaultTypes.Allocation[] memory basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken,
        uint256 platformBps_,
        address quote,
        bytes memory modeData
    ) internal returns (address vault, address distributor) {
        _checkBasket(basket);

        // Native ETH needs no listing: it has no hop to price, and `MIN_BUY`
        // is already denominated in it. Everything else must be listed.
        QuoteListing memory q;
        if (quote != address(0)) {
            q = quoteListing[quote];
            if (!q.allowed) revert QuoteNotAllowed(quote);
        }

        (vault, distributor) = IVaultFactory(factory_)
            .create(
                VaultTypes.Config({
                escrow: ESCROW,
                factory: PONS_FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: PIVOT,
                ethPivotFee: ETH_PIVOT_FEE,
                ethUsdFeed: ETH_USD,
                creator: launcher,
                platform: PLATFORM,
                // Written into the vault for good. A later change to this
                // registry's rate reaches the next vault and never this one.
                platformBps: platformBps_,
                rewardsBps: rewardsBps,
                timelock: TIMELOCK,
                distributor: address(0), // filled by the Bootstrap
                deployer: launcher,
                registry: address(this),
                intendedToken: intendedToken,
                quote: quote,
                quoteFee: q.poolFee,
                quoteWethFee: q.wethFee,
                minBuy: q.minBuy
            }),
                basket,
                keeper,
                block.timestamp,
                epochLength,
                modeData
            );

        // **Born with the second key, not fitted with one later.** A per-vault
        // timelock call after the fact is one nobody makes, and a vault that
        // never gets it is single-key for its whole life.
        //
        // **And the stamp is HARD: a vault that cannot take it is not born.**
        // This call was soft until 2026-09-12, with an event for the failure,
        // and the justification was that a mode with no second contract has no
        // `setCoSigner`. That case never reaches this line — it returns its own
        // vault as `distributor` (`modes/ModeFactory.sol:111`) and the condition
        // below already excludes it. So what the softness actually covered was
        // the OTHER half of the same `false`: our own Distributor refusing, or
        // running out of gas, and the vault then born single-key while
        // `Payd.coSigner()` reads as set — the protection off with every
        // indicator saying it is on, which is the T2-REG-01 direction.
        //
        // An event was the answer to that and it was the wrong shape: it makes
        // the guarantee depend on somebody subscribing, and nothing did
        // (`docs/AUDIT_PAYD.md` §4.2). Reverting makes the state unreachable
        // instead of observable, so there is nothing left to watch.
        //
        // What it costs, said plainly because `Payd` has no successor: a future
        // mode with a SEPARATE second contract that does not implement
        // `setCoSigner` can never mint a vault here while a co-signer is named.
        // The way out is the one the template already takes — return the vault
        // itself as `distributor` — so the escape is one line in that mode's
        // factory, not a new registry.
        if (coSigner != address(0) && distributor != address(0) && distributor != vault) {
            (bool stamped,) = distributor.call(abi.encodeWithSignature("setCoSigner(address)", coSigner));
            if (!stamped) revert CoSignerStampFailed(vault, distributor);
        }

        isVault[vault] = true;
        modeOf[vault] = factoryMode[factory_];
        allVaults.push(vault);
        _byCreator[launcher].push(vault);

        emit VaultCreated(vault, distributor, launcher, rewardsBps, platformBps_, epochLength, intendedToken);
    }

    /// @dev The basket's SHAPE — size, weights, duplicates — is the vault's own
    ///      rule and it checks it at `init`. What belongs here is whether these
    ///      stocks may be held at all, which the vault has no way to know.
    ///
    ///      Its own function purely for the stack: `_create` builds a
    ///      seventeen-field struct and the loop's locals no longer fit beside
    ///      it.
    /// @dev **An empty basket is legal here, and that is the point.** A basket
    ///      is the DISTRIBUTION mode's parameter, and this registry is an
    ///      interface over factories: requiring one forced every future mode to
    ///      be handed a stock it would never buy, purely to get past this line.
    ///      What stays is the half that is genuinely the registry's — the list
    ///      is governance's, written by the timelock, so a basket presented
    ///      here is still checked against it, entry by entry.
    ///
    ///      It fails closed for the mode that does want one: `FeeVault.init`
    ///      refuses anything under `MIN_BASKET` (2), so an empty basket handed
    ///      to the distribution factory reverts a step later, in the contract
    ///      that actually knows what a basket is for.
    function _checkBasket(VaultTypes.Allocation[] memory basket) internal view {
        uint256 n = basket.length;
        for (uint256 i; i < n; ++i) {
            Listing memory l = listing[basket[i].stock];
            if (!l.allowed) revert StockNotAllowed(basket[i].stock);
            if (basket[i].poolFee != l.poolFee) revert WrongPoolFee(basket[i].stock, l.poolFee, basket[i].poolFee);
            if (basket[i].feed != l.feed) revert WrongFeed(basket[i].stock, l.feed, basket[i].feed);
        }
    }

    // -------------------------------------------------------------- 2. voting

    /// @notice Lists a stock, with the pool tier and feed a basket must declare
    ///         it at. 48 hours of notice, like everything else here.
    function allowStocks(address[] calldata stocks, uint24[] calldata poolFees, address[] calldata feeds)
        external
        onlyTimelock
    {
        _allowStocks(stocks, poolFees, feeds);
    }

    /// @dev The body, shared by the vote and by the constructor's seed. One
    ///      copy of the rules — otherwise birth and everything after would
    ///      diverge at the first oversight.
    function _allowStocks(address[] memory stocks, uint24[] memory poolFees, address[] memory feeds) internal {
        uint256 n = stocks.length;
        if (poolFees.length != n || feeds.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            if (stocks[i] == address(0)) revert ZeroAddress();
            // **The pivot is the only line listed without a pool.** The tier
            // is mandatory everywhere else because the likeliest mistake is the
            // right stock at the wrong tier. There is no pool of the pivot
            // against itself: demanding one here would be demanding a lie, and
            // the vault would skip the line in silence on every purchase,
            // piling its share into `pivotReserve`. The exception is named, not
            // general — any other stock at zero is still refused.
            if (stocks[i] == PIVOT) {
                if (poolFees[i] != 0) revert WrongPoolFee(PIVOT, 0, poolFees[i]);
            }
            // **The pool must EXIST, not merely be named.** The list held
            // together through measurement discipline — `docs/allowlist.md` and
            // the TWAP test — and not through a guard: one could list the right
            // stock at the wrong tier, which `Listing`'s own comment calls "the
            // likeliest mistake". Vaults then skipped the line in silence on
            // every purchase, its share piling up in `pivotReserve`, for their
            // whole life.
            //
            // The cost: now that the seed lives in the constructor, a missing
            // pool reverts the DEPLOYMENT. That is the right moment to learn
            // it — nothing exists yet, and a second reading costs less than a
            // vault with a dead line.
            // **Tier zero declares NO v3 route, and that is now a choice
            // rather than a refusal.** The guard below is a Uniswap v3 guard,
            // and this list is read by every mode: a mode that settles on v4,
            // or on no pool at all, could not get a line listed without
            // inventing a v3 tier for a pool it would never touch. So a
            // non-zero tier is still measured, exactly as before, and zero
            // means "this line carries no v3 route".
            //
            // It fails closed for the mode that does need one:
            // `FeeVault._setAllocations` refuses a basket line at tier zero
            // that is not the pivot. The deployment-time guarantee therefore
            // still holds for every line that declares a route — which is
            // every line the distribution mode can use.
            if (stocks[i] != PIVOT && poolFees[i] != 0) _requirePool(stocks[i], PIVOT, poolFees[i]);
            listing[stocks[i]] = Listing({poolFee: poolFees[i], feed: feeds[i], allowed: true});
            emit StockAllowed(stocks[i], poolFees[i], feeds[i]);
        }
    }

    /// @notice Lists a currency a launch may be quoted in.
    ///
    /// @dev    `poolFee` is the QUOTE/USDG tier and must be zero for USDG
    ///         itself — there is no hop to make — and non-zero for anything
    ///         else, which is exactly what `FeeVault.init` re-checks. `minBuy`
    ///         is the smallest purchase worth making in this quote's units;
    ///         set it near the ETH vault's ~$25 and the decimals do the rest.
    function allowQuotes(
        address[] calldata quotes,
        uint24[] calldata poolFees,
        uint24[] calldata wethFees,
        uint256[] calldata minBuys
    ) external onlyTimelock {
        _allowQuotes(quotes, poolFees, wethFees, minBuys);
    }

    /// @dev The body, shared by the vote and by the constructor's seed.
    function _allowQuotes(
        address[] memory quotes,
        uint24[] memory poolFees,
        uint24[] memory wethFees,
        uint256[] memory minBuys
    ) internal {
        uint256 n = quotes.length;
        if (poolFees.length != n || wethFees.length != n || minBuys.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            // Native ETH is not listed here: it is allowed by construction, and
            // a row for it would be a row `_create` never reads.
            if (quotes[i] == address(0) || minBuys[i] == 0) revert ZeroAddress();
            if (quotes[i] == PIVOT) {
                // The pivot against itself: no route, hence no tier.
                if (poolFees[i] != 0 || wethFees[i] != 0) revert QuoteNotAllowed(quotes[i]);
            } else if (poolFees[i] != 0 && wethFees[i] != 0) {
                // Both: the contract would be choosing in place of whoever did
                // the measuring. Neither is no longer refused — it declares no
                // v3 route, for a mode that settles elsewhere. `FeeVault.init`
                // still refuses such a quote (`BadQuote`), so the distribution
                // mode fails closed one step later.
                revert QuoteNotAllowed(quotes[i]);
            }
            // The same guard, on the route actually declared — BOTH hops when
            // it is the detour, because a detour whose second hop is missing is
            // as dead as a direct route with no pool.
            if (poolFees[i] != 0) {
                _requirePool(quotes[i], PIVOT, poolFees[i]);
            } else if (wethFees[i] != 0) {
                _requirePool(quotes[i], WETH, wethFees[i]);
                _requirePool(WETH, PIVOT, ETH_PIVOT_FEE);
            }
            // **And the route has to hold something (T-QUOTE-01).** The guard
            // above admits any pool on `liquidity() != 0`, and its own comment
            // says so: it does not catch a thin tier. A quote is the money path
            // — every purchase this vault ever makes goes through it, and the
            // vault is stamped with it for life — so it gets the sanity bar
            // `MIN_ROUTE_DEPTH` describes, on the THINNEST hop it declares.
            // `allowStocks` deliberately does not: a basket line that dries up
            // is skipped, one leg at a time, and the vault keeps running.
            if (poolFees[i] != 0 || wethFees[i] != 0) {
                uint256 depth = _routeDepth(quotes[i], poolFees[i], wethFees[i]);
                if (depth < MIN_ROUTE_DEPTH) revert RouteTooThin(quotes[i], depth, MIN_ROUTE_DEPTH);
            }
            // **The way out must exist before the way in.**
            _requireSweepable(quotes[i]);
            quoteListing[quotes[i]] =
                QuoteListing({poolFee: poolFees[i], wethFee: wethFees[i], minBuy: minBuys[i], allowed: true});
            emit QuoteAllowed(quotes[i], poolFees[i], wethFees[i], minBuys[i]);
        }
    }

    /// @dev **Two lists, two votes, and nothing used to make them agree.**
    ///
    ///      A vault pays its platform share in ITS OWN currency, and the
    ///      `Treasury` works exclusively in ether: the pockets, the buyback and
    ///      the dev only ever see what `sweepToEth` has converted. That
    ///      function refuses a token with neither route declared
    ///      (`SweepNotAllowed`), and the sweep list is a `Treasury` vote while
    ///      this one is a `Payd` vote. Listing here without listing there
    ///      produces vaults whose platform share arrives in a currency nothing
    ///      can convert — and it does not revert, it ACCUMULATES, for ever.
    ///
    ///      The same shape as the ten quotes with no `token/WETH` pool that
    ///      `Treasury.PIVOT` exists for, one level up: there the way in and the
    ///      way out disagreed about the ROUTE, here about the LIST.
    ///
    ///      So the order is now enforced rather than remembered:
    ///      `Treasury.allowSweeps` first, this second. Both are the timelock's,
    ///      so it costs an ordering, not a key.
    ///
    ///      **It fails OPEN when the platform does not answer, and that is
    ///      deliberate.** `PLATFORM` is immutable and written at deployment; a
    ///      platform that is not a Treasury is a catastrophic wiring error this
    ///      guard is not meant to catch, and making the registry unusable
    ///      against one would be a liveness hazard in exchange for nothing. It
    ///      also keeps `Payd` testable against a plain address, which is how
    ///      its own suite isolates the registry's plumbing. What that leaves
    ///      uncovered, the keeper warns about out loud, per round.
    ///
    ///      Native ETH never reaches here: `_allowQuotes` refuses `address(0)`
    ///      above, and an ether-quoted vault pays the Treasury in ether, which
    ///      needs no sweeping at all.
    function _requireSweepable(address quote) internal view {
        (bool okDirect, bytes memory direct) = PLATFORM.staticcall(abi.encodeWithSignature("sweepFee(address)", quote));
        (bool okPivot, bytes memory viaPivot) =
            PLATFORM.staticcall(abi.encodeWithSignature("sweepPivotFee(address)", quote));
        if (!okDirect || direct.length != 32 || !okPivot || viaPivot.length != 32) return;
        if (abi.decode(direct, (uint24)) == 0 && abi.decode(viaPivot, (uint24)) == 0) {
            revert QuoteNotSweepable(quote);
        }
    }

    /// @notice Delists a quote. Like `removeStocks`, it reaches no existing
    ///         vault: a vault's quote is stamped at birth and this list is only
    ///         ever read at birth.
    function removeQuotes(address[] calldata quotes) external onlyTimelock {
        for (uint256 i; i < quotes.length; ++i) {
            delete quoteListing[quotes[i]];
            emit QuoteRemoved(quotes[i]);
        }
    }

    /// @dev **The pool exists AND carries something, or nothing is written.**
    ///
    ///      Checking EXISTENCE alone would have caught nothing here: on this
    ///      chain all four NVDA/USDG tiers exist, and `getPool` returns a
    ///      non-zero address on every one of them. LIQUIDITY is what separates
    ///      them — 1.4e19 at tier 500, which is the right one, and **zero** at
    ///      tier 10000. A guard on existence would have waved through exactly
    ///      the mistake it claimed to catch.
    ///
    ///      So what it catches is: no pool, and an empty pool. What it does NOT
    ///      catch: a tier merely thinner than the best one — NVDA's 100 and
    ///      3000 tiers do carry something, just less. Only off-chain
    ///      measurement says that (`docs/allowlist.md`,
    ///      `script/MeasureRoutes.s.sol`), and pretending otherwise would trade
    ///      a discipline for the illusion of a guarantee.
    function _requirePool(address token, address against, uint24 poolFee) internal view {
        address pool = IUniswapV3Factory(V3_FACTORY).getPool(token, against, poolFee);
        if (pool == address(0) || IV3PoolLiquidity(pool).liquidity() == 0) {
            revert NoLiquidityAt(token, against, poolFee);
        }
    }

    /// @dev `decimals()`, or 6. Optional in ERC-20, and the pivot is not ours.
    function _decimalsOf(address token) internal view returns (uint8) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        return ok && ret.length == 32 ? abi.decode(ret, (uint8)) : 6;
    }

    /// @dev One side of a pool's ACTIVE liquidity at the current tick. Zero when
    ///      the pool is empty or uninitialised, which reads as "no depth" and is
    ///      the right answer for both.
    function _side(address pool, address of_, address other) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IV3PoolLiquidity(pool).slot0();
        uint256 liq = IV3PoolLiquidity(pool).liquidity();
        if (sqrtP == 0 || liq == 0) return 0;
        // Uniswap orders a pool's tokens by address, so this is token0 without a
        // call: amount0 in range is L/sqrtP, amount1 is L*sqrtP.
        return of_ < other ? FullMath.mulDiv(liq, Q96, sqrtP) : FullMath.mulDiv(liq, sqrtP, Q96);
    }

    /// @dev The depth of `pool` on the `of_` side, at +1 %.
    function _depth(address pool, address of_, address other) internal view returns (uint256) {
        return FullMath.mulDiv(_side(pool, of_, other), DEPTH_K_NUM, DEPTH_K_DEN);
    }

    /// @dev **The thinnest hop of a declared route, valued in `PIVOT`.**
    ///
    ///      The direct route is one pool with the pivot on one side, so its
    ///      depth is already in the right units. The detour is two, and its
    ///      first hop is measured in WETH — converted through the SECOND hop's
    ///      own reserves rather than through a feed, because the pool being
    ///      converted with is the one just measured. No oracle joins the
    ///      listing path, and none can be manipulated into one: a pool moved far
    ///      enough to flatter this number is a pool that fails it on the other
    ///      side.
    function _routeDepth(address quote, uint24 poolFee, uint24 wethFee) internal view returns (uint256) {
        IUniswapV3Factory f = IUniswapV3Factory(V3_FACTORY);
        if (poolFee != 0) return _depth(f.getPool(quote, PIVOT, poolFee), PIVOT, quote);

        address ethPool = f.getPool(WETH, PIVOT, ETH_PIVOT_FEE);
        uint256 wethSide = _side(ethPool, WETH, PIVOT);
        if (wethSide == 0) return 0;
        uint256 hopOne = FullMath.mulDiv(
            _depth(f.getPool(quote, WETH, wethFee), WETH, quote), _side(ethPool, PIVOT, WETH), wethSide
        );
        uint256 hopTwo = _depth(ethPool, PIVOT, WETH);
        return hopOne < hopTwo ? hopOne : hopTwo;
    }

    /// @notice Delists a stock.
    ///
    /// @dev    **It touches no existing basket**, and must not: a vault holding
    ///         a stock that dried up keeps holding it until its own timelock
    ///         says otherwise, one vault at a time. Making a delisting reach
    ///         backwards would break every basket containing it, which is worse
    ///         than the problem (`PLAN.md` §4bis).
    function removeStocks(address[] calldata stocks) external onlyTimelock {
        for (uint256 i; i < stocks.length; ++i) {
            delete listing[stocks[i]];
            emit StockRemoved(stocks[i]);
        }
    }

    function setPlatformBps(uint256 bps) external onlyTimelock {
        if (bps > MAX_PLATFORM_BPS) revert PlatformBpsTooHigh(bps, MAX_PLATFORM_BPS);
        emit PlatformBpsSet(platformBps, bps);
        platformBps = bps;
    }

    /// @notice The keeper written into FUTURE Distributors. Existing ones do
    ///         not move until `rotateKeeper` pushes it into them.
    ///
    /// @dev    Two calls and not one, deliberately: this changes what the next
    ///         launch is born with, `rotateKeeper` changes what the live vaults
    ///         obey, and there are reasons to want either without the other —
    ///         staging a successor before cutting over, or rotating a
    ///         compromised key without changing the default.
    function setKeeper(address newKeeper) external onlyTimelock {
        if (newKeeper == address(0)) revert ZeroAddress();
        // **The two roles cannot be one address here either.** `Distributor`
        // refuses the collapse on both of its setters and is right to; this
        // registry accepted it, and the consequence was worse than the thing
        // the Distributor refuses. `_create` calls `setCoSigner` on the fresh
        // clone, that call reverts on the collapse, and the call is SOFT — so
        // the vault was born with no second key at all, with no revert and no
        // event, while `Payd.coSigner()` went on reading as though the
        // protection were on. Turning a guard off silently is the direction
        // that does not announce itself (`docs/AUDIT_EXECUTION_2.md`,
        // T2-REG-01/02).
        if (newKeeper == coSigner) revert RoleCollapse(newKeeper);
        emit KeeperSet(keeper, newKeeper);
        keeper = newKeeper;
    }

    /// @notice Pushes the current `keeper` into the Distributors of the vaults
    ///         in `[from, to)`. **The door that makes a compromised key
    ///         answerable in one operation instead of one per vault.**
    ///
    /// @dev    The first version of this contract refused to have this
    ///         function, so that "one call must not be able to swap the
    ///         publisher of every vault at once". The power was never actually
    ///         withheld — the timelock could call each `Distributor.setKeeper`
    ///         itself, N times, 48 h each. All the absence bought was an
    ///         operator who cannot answer a compromise across a thousand
    ///         vaults, which is protection pointed the wrong way.
    ///
    ///         **Bounded by a range, because a list that only grows is not a
    ///         loop bound.** Same rule as `MAX_BATCH` on the delivery side: the
    ///         caller names the slice, and a registry with a thousand vaults is
    ///         rotated in several operations rather than in one that cannot
    ///         fit. `to` is clamped, so `rotateKeeper(0, type(uint256).max)` is
    ///         the whole list whenever the whole list fits.
    ///
    ///         **A vault that refuses does not stop the others.** The same rule
    ///         as a skipped basket leg: a Distributor that reverts — migrated,
    ///         replaced, or simply not ours any more — is counted out and the
    ///         rotation carries on. A rotation that stopped on the first
    ///         awkward vault would be a rotation nobody can rely on in the one
    ///         situation it exists for.
    /// @notice Names, or unnames, an ADDITIONAL publisher for every vault of
    ///         this registry at once.
    ///
    /// @dev    **This widens the one key on the nominal path, and that has to
    ///         be said rather than sold.** A root takes effect immediately with
    ///         no bond and no challenge window, so every address in this set
    ///         can award itself whatever a Distributor holds undelivered. The
    ///         exchange is that a single hot key stops being a single point of
    ///         failure — one that can be lost, rate-limited or simply switched
    ///         off, on a cycle that has to run every thirty minutes.
    ///
    ///         Both directions take the timelock's 48 hours, which is honest
    ///         about what this is: a way to run several publishers, not an
    ///         emergency brake. The brake is `rotateKeeper` plus this, and
    ///         neither is instant.
    ///
    ///         It reaches live vaults with no loop at all — a Distributor asks
    ///         this mapping at publish time — which is the whole reason the set
    ///         is here rather than copied into each of them.
    function allowKeeper(address who, bool allowed) external onlyTimelock {
        if (who == address(0)) revert ZeroAddress();
        // **The third path to the role collapse, and it was the function
        // sitting between the two that already refused it.** Adding the
        // co-signer here gives one secret both roles on every vault at once —
        // see `isKeeper` above for why nothing downstream catches it.
        // `allowed &&` is deliberate: unnaming must stay possible whoever the
        // address is, or an approval made in error could never be withdrawn.
        if (allowed && who == coSigner) revert RoleCollapse(who);
        isKeeper[who] = allowed;
        emit KeeperAllowed(who, allowed);
    }

    /// @notice Names the co-signer NEW vaults are born with. Reaches nothing
    ///         already created — `rotateCoSigner` does that.
    ///
    /// @dev    Zero is a legal value and is what removes the requirement from
    ///         future vaults. It is not an emergency lever: the emergency lever
    ///         is `Distributor.CO_SIGNER_GRACE`, which lifts the requirement by
    ///         itself after three hours of silence, because 48 h of timelock on
    ///         a protocol that pays every thirty minutes is ninety-six epochs.
    function setCoSigner(address who) external onlyTimelock {
        // The same refusal from the other side, and `Distributor.setCoSigner`'s
        // reason applies unchanged: a second key that IS the first key is a
        // second secret held by whoever holds the first, and every property here
        // would still read as satisfied. Zero stays legal — it is what removes
        // the requirement from future vaults.
        if (who == keeper && who != address(0)) revert RoleCollapse(who);
        // And against the registry-wide publisher set, not only the default
        // keeper: an address `allowKeeper` already named can publish on every
        // vault here, so naming it co-signer collapses the two roles by the
        // other order of the same two calls.
        if (who != address(0) && isKeeper[who]) revert RoleCollapse(who);
        emit CoSignerSet(coSigner, who);
        coSigner = who;
    }

    /// @notice Pushes the current `coSigner` into the Distributors of vaults
    ///         `[from, to)`. **The same shape as `rotateKeeper`, and the
    ///         arguments are INDEX BOUNDS into `allVaults`, not addresses.**
    ///
    /// @dev    A Distributor that refuses is skipped and named, never blocking
    ///         the rest: a mode with no second contract returns its own vault
    ///         as `distributor`, and a vault has no `setCoSigner`. Ranges,
    ///         because a thousand vaults do not fit in one transaction and the
    ///         timelock pays 48 h per operation, not per vault.
    function rotateCoSigner(uint256 from, uint256 to) external onlyTimelock returns (uint256 rotated) {
        uint256 n = allVaults.length;
        if (to > n) to = n;
        if (from >= to) revert EmptyRange(from, to);
        address c = coSigner;
        for (uint256 i = from; i < to; ++i) {
            address vault = allVaults[i];
            (bool ok, bytes memory ret) = vault.staticcall(abi.encodeWithSignature("DISTRIBUTOR()"));
            if (!ok || ret.length != 32) continue;
            address dist = abi.decode(ret, (address));
            if (dist == address(0)) continue;
            (ok,) = dist.call(abi.encodeWithSignature("setCoSigner(address)", c));
            if (ok) ++rotated;
            else emit CoSignerRotationSkipped(vault, dist);
        }
        emit CoSignerRotated(c, from, to, rotated);
    }

    function rotateKeeper(uint256 from, uint256 to) external onlyTimelock returns (uint256 rotated) {
        uint256 n = allVaults.length;
        if (to > n) to = n;
        if (from >= to) revert EmptyRange(from, to);
        address k = keeper;
        for (uint256 i = from; i < to; ++i) {
            address vault = allVaults[i];
            (bool ok, bytes memory ret) = vault.staticcall(abi.encodeWithSignature("DISTRIBUTOR()"));
            if (!ok || ret.length != 32) continue;
            address dist = abi.decode(ret, (address));
            if (dist == address(0)) continue;
            (ok,) = dist.call(abi.encodeWithSignature("setKeeper(address)", k));
            if (ok) ++rotated;
            else emit KeeperRotationSkipped(vault, dist);
        }
        emit KeeperRotated(k, from, to, rotated);
    }

    /// @notice The generation key looks at a candidate. **It does nothing
    ///         with it by itself** — it only authorises the timelock to name
    ///         that address.
    ///
    /// @dev    Revocable for as long as the timelock has not executed: the key
    ///         can correct a mistake, not only make one. And the table it
    ///         writes is the **factories' lineage**: what was approved stays
    ///         approved, so you can read on-chain which versions of the vault
    ///         code were ever judged good.
    function approve(address candidate, bool ok) external {
        if (msg.sender != GENERATION_KEY) revert NotGenerationKey();
        approved[candidate] = ok;
        emit Approved(candidate, ok);
    }

    /// @notice Opens — or shuts again — migration between two payout modes.
    ///
    /// @dev    **The generation key, for the same reason it holds `approve`:
    ///         this authorises, it does not act.** No stream moves here. The
    ///         timelock must still call `FeeVault.migrate` on a named vault,
    ///         through its 48 h, and every other condition of that function
    ///         still applies — same token, same creator, same quote, and a
    ///         split no worse for the holders.
    ///
    ///         Shutting it is the same call with `false`, and it takes effect
    ///         at once: nothing schedules, so nothing has to be waited out.
    function setCrossModeMigration(bool state) external {
        if (msg.sender != GENERATION_KEY) revert NotGenerationKey();
        crossModeMigration = state;
        emit CrossModeMigrationSet(state);
    }

    /// @notice Replaces the vault factory. **Two keys, and it is the only kind
    ///         of upgrade this system needs.**
    ///
    /// @dev    **What it replaces.** There used to be a chain of successors
    ///         here: `setSuccessor` named the next generation's registry, and
    ///         `recognised` walked it so `FeeVault.migrate` would accept a
    ///         vault of another generation. It was the largest residual hole in
    ///         the system — `setSuccessor` took any address, and five lines
    ///         answering `isVault(x) = true` for every `x` opened the
    ///         migration, hence the future stream AND the reserve, onto
    ///         anything. No check could close it: everything you read from an
    ///         unknown contract is written by that contract.
    ///
    ///         It existed for one reason only: the implementations lived IN
    ///         this contract, as `immutable`, so a new vault version forced a
    ///         new registry, hence a bridge between two registries. Now that
    ///         `DistributionFactory` carries them, that reason is gone: a new version
    ///         is a new factory, and the vaults that follow are born **in this
    ///         registry**.
    ///
    ///         `migrate` therefore asks nothing but `isVault`, written by
    ///         `_create` and by nobody else.
    ///
    ///         **What it costs, and it is accepted.** If THIS contract turned
    ///         out to be broken, its vaults could never migrate again. It holds
    ///         not one wei and a vault never calls it after birth — except
    ///         here — so a broken registry strands no funds: later launches
    ///         would go to a new registry and the existing vaults would keep
    ///         running. Against that: a permanent, forgeable door onto every
    ///         vault's stream.
    ///
    ///         Class (a): a hostile factory builds vaults registered here,
    ///         hence valid `migrate` destinations.
    function setFactory(address next) external onlyTimelock {
        if (next == address(0)) revert ZeroAddress();
        if (!approved[next]) revert NotApproved(next);
        _setFactory(next);
    }

    /// @notice Enables a factory WITHOUT making it the default.
    ///
    /// @dev    **This is the whole of "several modes at once".** `setFactory`
    ///         answers "what does `createVault` build"; this one answers "what
    ///         may be built at all". A second mode is a second factory enabled
    ///         here, reached through `createVaultWith`, while `createVault` and
    ///         every existing caller keep building exactly what they built
    ///         yesterday.
    ///
    ///         Same two keys as `setFactory`, and for the same reason: a
    ///         factory enabled here builds vaults that register in `isVault`,
    ///         hence valid `migrate` destinations.
    function enableFactory(address f) external onlyTimelock {
        if (f == address(0)) revert ZeroAddress();
        if (!approved[f]) revert NotApproved(f);
        _enable(f);
    }

    /// @notice Stops a factory building anything new here. Touches no vault it
    ///         has already built — those are stamped and keep running.
    ///
    /// @dev    Necessary, not decorative: revoking `approved` does not reach
    ///         backwards into `factoryMode`, so without this an enabled factory
    ///         would keep minting registered vaults for ever after the
    ///         generation key had changed its mind.
    ///
    ///         The default cannot be disabled — `createVault` would call a
    ///         factory this registry has disowned. Point the default elsewhere
    ///         first.
    function disableFactory(address f) external onlyTimelock {
        if (f == address(factory)) revert FactoryIsTheDefault(f);
        if (factoryMode[f] == bytes32(0)) revert FactoryNotEnabled(f);
        delete factoryMode[f];
        emit FactoryDisabled(f);
    }

    /// @dev Shared with the constructor, so the platform token's own vault is
    ///      stamped with a mode like every vault after it. A factory that
    ///      declares nothing is refused here — the one place where refusing
    ///      costs a revert instead of a registry that can no longer launch.
    function _setFactory(address next) internal {
        bytes32 mode = _enable(next);
        emit FactorySet(address(factory), next, mode);
        factory = IVaultFactory(next);
    }

    /// @dev Reads the mode off the factory and records it. Idempotent:
    ///      re-enabling an enabled factory rewrites the same value, which is
    ///      what lets `setFactory` reuse it without a branch.
    function _enable(address f) internal returns (bytes32 mode) {
        mode = IVaultFactory(f).MODE();
        // **Zero, and the template's placeholder (T-MODE-02).** `modeOf` is
        // written once, at a vault's birth, and `FeeVault.migrate` compares mode
        // NAMES for ever after — that comparison is the entire upgrade path. A
        // factory admitted as `TODO-name-this-mode` therefore makes that string
        // a permanent value every later factory wanting to be a destination for
        // its vaults must also declare. `contracts/modes/ModeFactory` now takes
        // its mode as a constructor argument and refuses the same literal, so
        // this line is for a copy of that file made before it did.
        if (mode == bytes32(0) || mode == MODE_PLACEHOLDER) revert BadMode();
        factoryMode[f] = mode;
        emit FactoryEnabled(f, mode);
    }

    // ------------------------------------------------------------------ views

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    function vaultsOf(address creator) external view returns (address[] memory) {
        return _byCreator[creator];
    }

    function vaults() external view returns (address[] memory) {
        return allVaults;
    }
}
