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

interface IStockListing {
    function listing(address stock) external view returns (uint24 poolFee, address feed, bool allowed);
}

interface IPivot {
    function PIVOT() external view returns (address);
}

/// @title  PortfolioBook — one per launch: what each holder wants to be paid in
///
/// @notice The creator posts a default basket at birth like every other launch.
///         A holder may then declare their own, **freely**, over any stock the
///         platform allows — not only the creator's lines — and is paid in it
///         automatically, with nothing left to do afterwards.
///
/// @dev    **This contract holds no money and has no privileged function.** It
///         is a register: the holder writes their own row, the
///         `PortfolioDistributor` reads it when it converts, and the timelock
///         is not involved at any point. That is the whole difference from the
///         first design of this mode, which made the vault buy the aggregate of
///         the holders' wishes and therefore had to move the vault's timelock
///         seat to reweight the basket every purchase. It was abandoned for a
///         reason worth writing down: `FeeVault.MAX_BASKET` is 8 and the
///         platform allows ~46 stocks, so "the vault buys what the holders
///         asked for" and "the holder chooses freely" cannot both be true. The
///         mode that keeps the freedom converts at DELIVERY instead, and needs
///         no new power at all.
///
///         **The universe is `Payd.listing`, read live and never copied.** A
///         stock the timelock delists stops being choosable for a new row from
///         that block; rows already written keep naming it, and the
///         Distributor's own `_requireListed` is what decides whether a
///         conversion still happens. That is the same posture as everywhere
///         else here: delisting must not reach backwards (`FLOWS.md` §7.5).
///         Reading the registry also means the pool TIER is never stored twice
///         — a retier by the timelock reaches this mode with no migration.
///
///         **Why the line count is barely capped, and what the cap USED to be
///         for.** It was 8, and the reason written here was that the delivery
///         floor is multiplied by the number of lines being settled
///         (`pushFloorParts`). **That reason was wrong for this mode.** The
///         floor multiplies by the number of (holder, STOCK-OF-THE-TREE) pairs,
///         and this mode's tree has exactly ONE leg — the pivot — so the
///         multiplier is always 1. A portfolio holder was gated on ~$10 of
///         whole pivot share and then had it cut into as many slices as they
///         had lines, with nothing pricing the slices. The cap of 8 was the
///         only thing bounding that, by accident.
///
///         The bound now lives where it belongs: `offchain/src/portfolio.ts`
///         converts a line only once that LINE is worth the floor, measured
///         (`test_ConversionGasPerLineIsWhatTheFloorIsPricedOn`). A line under
///         it is not lost, it is deferred — the targets are cumulative, so it
///         converts when it grows. That is what lets a holder name as many
///         stocks as the platform allows.
///
///         What remains of the cap is a sanity bound, not an economic one:
///         `_write` and the off-chain planner both walk the row. `weightOf`,
///         the read that happens once per holder per conversion batch and is
///         therefore charged to the whole BATCH, is O(1) — see `_weight`.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract PortfolioBook {
    error AlreadyBound();
    error BadWeights();
    error NotBound();
    error NotFactory();
    error NotListed(address stock);
    error TooManyLines();
    error ZeroAddress();

    /// @notice One holder's row: at most this many stocks. A sanity bound on
    ///         the two loops that remain (`_write` here, the planner
    ///         off-chain), NOT an economic one — see the NatSpec. 64 is
    ///         `Distributor.MAX_BATCH`'s number and sits above any plausible
    ///         allowlist; the platform allows ~46 today.
    uint256 public constant MAX_LINES = 64;
    /// @notice The smallest share of their own payout a holder may point at one
    ///         stock: 1 %.
    ///
    /// @dev    It was 500 — five per cent — which with a row summing to exactly
    ///         `BPS` capped a holder at TWENTY lines whatever `MAX_LINES` said,
    ///         and was the real bound on the freedom this mode exists for. The
    ///         argument for it was dust: "a 0.5 % slice of a $10 delivery is 5
    ///         cents of stock and costs a swap to produce". True, and now
    ///         answered where it arises rather than here: a line is converted
    ///         only once it is worth the delivery floor, so a 1 % line simply
    ///         waits until the holder's cumulative reaches a hundred times it.
    ///         Nothing is lost by waiting — the targets are cumulative.
    uint256 public constant MIN_LINE_BPS = 100;
    uint256 public constant BPS = 10_000;

    /// @notice Who may `bind`: the factory, in the launch's own transaction.
    address public immutable FACTORY;
    /// @notice `Payd`. Read for the stock allowlist and for nothing else — this
    ///         contract has no call into the registry that writes.
    address public immutable REGISTRY;

    address public vault;
    /// @notice The vault's settlement currency, learned at `bind`.
    ///
    /// @dev    **A holder may name it, and that is what "pay me in dollars"
    ///         is.** Without this line the only way to keep dollars was for the
    ///         CREATOR to have left the default basket empty: a holder on a
    ///         launch with a default had no way to opt out of it, because
    ///         `clearPortfolio` returns them TO that default and the next push
    ///         converts them into it. Their only escape was to `claim` before
    ///         every delivery, which is the "nothing to do" this protocol
    ///         promises, inverted.
    ///
    ///         The pivot is exempt from the stock allowlist below because it is
    ///         not a stock the platform picked — it is the currency the vault
    ///         already holds and already owes. `PortfolioDistributor` delivers
    ///         such a line by TRANSFER rather than by swap, the same way
    ///         `FeeVault._setAllocations` accepts a USDG line in a basket at
    ///         tier zero: there is no pool of a currency against itself, so
    ///         there is no floor to compute and nothing to protect.
    address public pivot;

    struct Line {
        address stock;
        uint16 bps;
    }

    /// @notice The creator's basket, frozen at birth. What a holder who has
    ///         declared nothing is paid in — which is every holder on day one,
    ///         so this is the mode's normal behaviour and not its fallback.
    Line[] internal _default;
    /// @notice A holder's own row. Empty means "no choice made".
    mapping(address holder => Line[]) internal _chosen;

    /// @notice The same two rows, keyed by stock, so that `weightOf` is one
    ///         SLOAD instead of a walk.
    ///
    /// @dev    **This is what lets the row be long.** `weightOf` is read once
    ///         per holder inside every conversion batch, and that gas is paid
    ///         by the BATCH — by the keeper's refund and by the other holders
    ///         sharing the swap. Walking the row would have let one holder with
    ///         forty lines tax the other sixty-three, which is a griefing
    ///         vector and the one real argument the cap of 8 had left. Keyed,
    ///         the length of a row costs its author and nobody else.
    ///
    ///         The arrays stay: they are the enumeration `linesOf` and the
    ///         off-chain planner need, and the pair is written in one place
    ///         (`_write`) so it cannot drift.
    mapping(address stock => uint256 bps) internal _defaultWeight;
    mapping(address holder => mapping(address stock => uint256 bps)) internal _weight;

    event Bound(address indexed vault, Line[] defaultBasket);
    event PortfolioSet(address indexed holder, Line[] lines);

    constructor(address factory, address registry) {
        if (factory == address(0) || registry == address(0)) revert ZeroAddress();
        FACTORY = factory;
        REGISTRY = registry;
    }

    /// @notice Learns the vault and the creator's default basket. Once, by the
    ///         factory, in the birth transaction.
    ///
    /// @dev    The basket arrives from `Payd._create`, which has already checked
    ///         every line against the stock allowlist, so it is not re-checked
    ///         here — only its shape is. An EMPTY default is legal and means
    ///         "a holder who declares nothing is paid in the pivot", which is
    ///         a coherent launch and cheaper for everyone who never chooses.
    function bind(address vault_, Line[] calldata lines) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (vault != address(0)) revert AlreadyBound();
        if (vault_ == address(0)) revert ZeroAddress();
        vault = vault_;
        pivot = IPivot(vault_).PIVOT();
        if (lines.length != 0) {
            _write(_default, _defaultWeight, lines);
        }
        emit Bound(vault_, lines);
    }

    // ------------------------------------------------------------- holders

    /// @notice Declares the caller's own portfolio. Their row and nobody
    ///         else's; no balance is read, so buying tokens to write here buys
    ///         nothing but the right to be asked.
    function setPortfolio(Line[] calldata lines) external {
        if (vault == address(0)) revert NotBound();
        if (lines.length == 0) revert BadWeights();
        address p = pivot;
        for (uint256 i; i < lines.length; ++i) {
            // The pivot is always nameable: see the field's NatSpec. Everything
            // else has to be a stock the platform allows AT THIS BLOCK.
            if (lines[i].stock == p) continue;
            (,, bool allowed) = IStockListing(REGISTRY).listing(lines[i].stock);
            if (!allowed) revert NotListed(lines[i].stock);
        }
        _write(_chosen[msg.sender], _weight[msg.sender], lines);
        emit PortfolioSet(msg.sender, lines);
    }

    /// @notice Goes back to the creator's default basket.
    function clearPortfolio() external {
        Line[] storage row = _chosen[msg.sender];
        mapping(address => uint256) storage w = _weight[msg.sender];
        // The keyed copy has to go too, or a cleared row would keep answering
        // `weightOf` — the one read the Distributor trusts.
        while (row.length != 0) {
            w[row[row.length - 1].stock] = 0;
            row.pop();
        }
        emit PortfolioSet(msg.sender, new Line[](0));
    }

    // --------------------------------------------------------------- views

    /// @notice What `holder` is paid in: their own row, or the creator's
    ///         default when they have declared nothing.
    function linesOf(address holder) external view returns (Line[] memory out) {
        Line[] storage src = _chosen[holder].length == 0 ? _default : _chosen[holder];
        out = new Line[](src.length);
        for (uint256 i; i < src.length; ++i) {
            out[i] = src[i];
        }
    }

    /// @notice `holder`'s weight on `stock`, in bps of their whole share.
    ///
    /// @dev    **The Distributor's one read, and the reason it reads rather
    ///         than trusts.** A conversion is driven by a keeper naming a stock
    ///         and a batch of holders; if the weight came from that call, a
    ///         compromised keeper could convert a holder's entire share into a
    ///         stock they gave 5 % to. It comes from here, so the worst that
    ///         call can do is convert what the holder actually asked for,
    ///         sooner or later than they hoped.
    ///
    ///         Zero for a stock the holder does not name — and zero for every
    ///         stock when a holder has declared nothing and the creator left
    ///         the default empty, which is how "keep paying me the pivot"
    ///         is expressed.
    function weightOf(address holder, address stock) external view returns (uint256) {
        return _chosen[holder].length == 0 ? _defaultWeight[stock] : _weight[holder][stock];
    }

    function defaultBasket() external view returns (Line[] memory out) {
        out = new Line[](_default.length);
        for (uint256 i; i < _default.length; ++i) {
            out[i] = _default[i];
        }
    }

    // ------------------------------------------------------------ internals

    /// @dev The shape every row obeys, in one place: at most `MAX_LINES`, no
    ///      duplicate, no line under `MIN_LINE_BPS`, and a sum of exactly
    ///      `BPS` — so a row always says what to do with the WHOLE of a
    ///      holder's share and never leaves a remainder nobody decided about.
    ///
    ///      **The duplicate check is the keyed copy doing double duty.** It was
    ///      a nested loop, O(n²), which at eight lines was free and at
    ///      sixty-four would not have been. Writing the weight first and
    ///      refusing a slot that is already non-zero is the same check in one
    ///      pass — and it is the same write the row needs anyway.
    function _write(Line[] storage dst, mapping(address => uint256) storage w, Line[] calldata lines) internal {
        uint256 n = lines.length;
        if (n > MAX_LINES) revert TooManyLines();
        // `delete` refuses a storage array of structs behind a pointer; popping
        // is the same thing and it is what the compiler will accept. The keyed
        // copy is cleared with it, or the old row would keep answering
        // `weightOf` for a stock the new one does not name.
        while (dst.length != 0) {
            w[dst[dst.length - 1].stock] = 0;
            dst.pop();
        }
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address stock = lines[i].stock;
            if (stock == address(0)) revert ZeroAddress();
            if (lines[i].bps < MIN_LINE_BPS) revert BadWeights();
            if (w[stock] != 0) revert BadWeights(); // the same stock twice
            w[stock] = lines[i].bps;
            sum += lines[i].bps;
            dst.push(lines[i]);
        }
        if (sum != BPS) revert BadWeights();
    }
}
