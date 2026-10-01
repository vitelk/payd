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

import {IERC20} from "../interfaces/IExternal.sol";

/// @dev The vault, from the redeemer's side: where the launched token is read
///      from, and where a stray ETH balance is sent back to.
interface IBackingVault {
    function token() external view returns (address);
    function fundRewards() external payable returns (uint256);
}

/// @dev The one thing this mode asks of the launched token. Verified on-chain
///      before this contract existed: `PonsV2LauncherToken` exposes `burn` and
///      `burnFrom`, so the burn is direct — it reduces `totalSupply` — and no
///      `0xdead` detour is needed (`docs/recon.md` §1.5).
interface IBurnable {
    function burnFrom(address from, uint256 amount) external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @title  BackingRedeemer
/// @notice The "backing" mode's second contract: `Distributor` with the whole
///         root machinery cut out. The vault buys the basket exactly as the
///         distribution mode does and the stocks land here — and stay. Anyone
///         burns launch tokens to take their pro-rata slice of every stock
///         held. No keeper, no Merkle root, no co-signature on the money path,
///         no epoch a holder has to know about: the token itself is the claim
///         ticket, and burning it is the claim.
///
/// @dev    **What was deleted, and why it is safe to delete.** `publishRoot`,
///         `claim`/`distribute`, `claimedSoFar`, the push floor and the whole
///         co-signer stack exist because the distribution mode needs an
///         off-chain computation — the time-weighted snapshot — carried
///         on-chain by a trusted publisher. This mode has no off-chain
///         computation: the pro-rata is `balance × amount / supply`, every
///         term read on-chain in the block of the call. There is nothing to
///         publish, so there is nothing a compromised publisher could forge.
///         The only key left standing anywhere near this contract is the
///         timelock's, and it can only change the basket being bought.
///
///         **What was kept is kept verbatim from `Distributor`**, because
///         re-typing shared machinery is where bugs come from: the clone+init
///         shape, the epoch calendar, `fundWindow`'s closed contiguous
///         windows (the vault's `buyBasket` refuses to run without them), and
///         `_tryTransfer`'s rule that a paused stock must never burn an
///         entitlement.
///
///         **`setCoSigner` survives with nothing to guard.** `Payd._create`
///         stamps the platform co-signer onto any distributor that is not the
///         vault itself, and the stamp is HARD — a vault whose distributor
///         cannot take it is not born. This contract has no publication for a
///         co-signature to gate, so the address is stored, shown, and asked
///         nothing. Cheaper than the vault-as-distributor escape, and honest:
///         the registry's invariant is "every second contract remembers the
///         second key", not "every second contract has a root".
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract BackingRedeemer {
    // ----------------------------------------------------------------- errors

    error NotFeeVault();
    error NotTimelock();
    error BadInput();
    error EpochNotOver(uint256 endsAt);
    error Reentrancy();
    error ZeroAddress();
    error AlreadyInitialised();
    error TransferFailed();
    error NotBound();
    error NothingToRedeem();
    /// @dev The holder's own floor, not ours: the pro-rata moved between the
    ///      preview they signed on and the block that mined them.
    error BelowMinimum(address stock, uint256 out, uint256 minOut);

    // ----------------------------------------------------------------- events

    /// @notice One purchase, covering the epochs `[fromEpoch, toEpoch]`. Same
    ///         shape as `Distributor`'s, so a verifier replays either mode's
    ///         funding history with one decoder.
    event WindowFunded(
        uint256 indexed fromEpoch, uint256 indexed toEpoch, address[] stocks, uint256[] amounts, uint256[] quoteSpent
    );
    /// @notice `holder` burned `amount` of the launch token against a
    ///         redeemable supply of `supply`. The per-stock movements are the
    ///         `Delivered`/`DeliveryDeferred` events of the same transaction.
    event Redeemed(address indexed holder, uint256 amount, uint256 supply);
    event Delivered(address indexed holder, address indexed stock, address indexed caller, uint256 amount);
    /// @notice A leg that could not be transferred — a paused stock, mostly.
    ///         The entitlement is credited, not lost: `collectStock` retries.
    event DeliveryDeferred(address indexed holder, address indexed stock, uint256 amount);
    event StockCollected(address indexed holder, address indexed stock, uint256 amount);
    event CoSignerChanged(address indexed from, address indexed to);
    event GasReceived(address indexed from, uint256 amount);
    event SweptToVault(uint256 amount);

    // ------------------------------------------------------ set once, at init
    //
    // `immutable` while a constructor deployed this. A clone has no
    // constructor, so they live in storage and `init` is the only writer —
    // once, guarded.

    address public FEE_VAULT;
    address public TIMELOCK;
    uint256 public GENESIS;
    uint256 public EPOCH_LENGTH;

    /// @notice The launched token. NOT an init parameter: the vault is created
    ///         BEFORE the launch exists (it is the `creatorFeeRecipient` the
    ///         launch names), so it is read from the vault on first use and
    ///         cached — the same shape as `V2Legs.TOKEN`.
    address public TOKEN;

    /// @notice The platform's second key, stamped at birth by `Payd._create`.
    ///         Stored and shown; this contract publishes nothing it could
    ///         co-sign. See the contract doc for why it exists at all.
    address public coSigner;

    // -------------------------------------------------------------- constants

    /// @notice Hard bound on the redemption loop. The basket holds at most 8
    ///         legs and a reallocation retires lines rather than multiplying
    ///         them, so the ever-funded set reaching this is a configuration
    ///         error — refused at `fundWindow`, where it is one purchase that
    ///         fails loudly, not here, where it would brick every redemption
    ///         for good.
    uint256 public constant MAX_BATCH = 64;

    /// @notice Where a burn lands when it cannot reduce supply. The Pons token
    ///         burns directly, but a balance parked here by anyone is a
    ///         balance that can never call `redeem` — so it is struck from the
    ///         redeemable supply rather than left to strand its share of the
    ///         backing forever.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------ state

    /// @notice The first epoch no purchase has covered yet. A window runs from
    ///         here to the epoch it names, and the next one starts after.
    uint256 public nextEpoch;

    /// @notice Total received per stock, cumulative. The audit ledger a
    ///         verifier checks `WindowFunded` logs against; nothing on-chain
    ///         spends from it — the pot is the balance itself.
    mapping(address stock => uint256) public totalFunded;

    /// @notice Every stock ever funded, in first-seen order. What `redeem`
    ///         iterates: the pot's table of contents, bounded by `MAX_BATCH`.
    address[] internal _stocksEver;

    /// @notice A leg that could not be delivered, per holder. The launch
    ///         tokens are already burned by then, so this credit IS the
    ///         entitlement — a paused stock defers it, nothing erases it.
    mapping(address holder => mapping(address stock => uint256)) public stockPending;

    /// @notice Sum of `stockPending` per stock. Deferred legs stay on this
    ///         contract's balance, so without this counter the next redeem
    ///         would count them in the pot and pay the same tokens twice.
    mapping(address stock => uint256) public pendingStockTotal;

    uint256 private _lock;

    /// @notice Set by `init`, and the reason it can only run once.
    bool public initialised;

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
    /// @dev    `BackingBootstrap` calls this in the same transaction as the
    ///         clone, so nothing can slip in between. No keeper parameter: the
    ///         one thing a keeper is for — publishing — does not exist here.
    function init(address feeVault, address timelock, uint256 genesis, uint256 epochLength) external {
        if (initialised) revert AlreadyInitialised();
        initialised = true;
        if (feeVault == address(0) || timelock == address(0)) revert ZeroAddress();
        if (genesis == 0 || epochLength == 0) revert BadInput();

        // A clone runs no constructor, so no field initialiser reaches it: at
        // zero, `nonReentrant` would revert on its very first call.
        _lock = 1;

        FEE_VAULT = feeVault;
        TIMELOCK = timelock;
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
    /// @dev    Verbatim `Distributor.fundWindow` minus the `quoteAtRisk`
    ///         accounting: that figure measured what a false root could award
    ///         itself, and there is no root here. The window discipline stays
    ///         — closed, contiguous, a partition of the epochs — because the
    ///         vault's `buyBasket` is built against it and because it is what
    ///         keeps the funding history replayable by anyone.
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

        for (uint256 i; i < n; ++i) {
            address stock = stocks[i];
            uint256 amount = amounts[i];
            if (stock == address(0) || amount == 0) revert BadInput();
            if (totalFunded[stock] == 0) {
                // See MAX_BATCH: an ever-funded set past the redemption loop's
                // bound is refused where it is one loud failed purchase.
                if (_stocksEver.length == MAX_BATCH) revert BadInput();
                _stocksEver.push(stock);
            }
            totalFunded[stock] += amount;
        }

        emit WindowFunded(from, toEpoch, stocks, amounts, quoteSpent);
    }

    // --------------------------------------------------------------- 2. redeem

    /// @notice Burn `amount` of the launch token, take `amount / supply` of
    ///         every stock held. Open to any holder, at any time, with nothing
    ///         published in between: the token is the claim ticket.
    ///
    /// @dev    `minOuts` is the holder's own slippage floor, aligned with
    ///         `allStocks()`: the pro-rata is read at execution, so between
    ///         the preview a holder signed on and the block that mines them,
    ///         someone else's burn — or a fresh purchase — moves every leg.
    ///         Checked BEFORE the burn: a refusal must cost the holder
    ///         nothing.
    ///
    ///         The redeemable supply is `totalSupply` minus the `0xdead`
    ///         balance: the Pons token's own `burnFrom` reduces supply
    ///         directly, but a balance anyone parks at `0xdead` can never
    ///         redeem, and counting it would strand its share of the backing
    ///         rather than pass it to the holders who stayed.
    ///
    ///         A leg whose transfer fails — a paused stock, `docs/recon.md`
    ///         §2.3 — is credited to `stockPending`, never lost and never
    ///         blocking: the launch tokens are already burned by that point,
    ///         so the credit IS the entitlement (`Distributor._one`'s rule,
    ///         carried to the mode where it matters most).
    ///
    ///         No gas refund: a redemption is the holder's own trade, like
    ///         `claim`, not a service to the protocol.
    function redeem(uint256 amount, uint256[] calldata minOuts) external nonReentrant returns (uint256 delivered) {
        if (amount == 0) revert BadInput();
        address tok = _token();
        if (tok == address(0)) revert NotBound();
        uint256 n = _stocksEver.length;
        if (n == 0) revert NothingToRedeem();
        if (minOuts.length != n) revert BadInput();

        uint256 supply = IBurnable(tok).totalSupply() - IBurnable(tok).balanceOf(DEAD);

        // Every leg is priced before anything moves, so `BelowMinimum` is a
        // free refusal — and the pro-rata is against the PRE-burn supply,
        // matching what `redeemPreview` showed.
        uint256[] memory outs = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address stock = _stocksEver[i];
            uint256 pot = IERC20(stock).balanceOf(address(this)) - pendingStockTotal[stock];
            uint256 out = (pot * amount) / supply;
            if (out < minOuts[i]) revert BelowMinimum(stock, out, minOuts[i]);
            outs[i] = out;
        }

        // The burn is the payment, and it happens before the payout: a token
        // that lies about burning reverts here and nothing has left.
        IBurnable(tok).burnFrom(msg.sender, amount);

        for (uint256 i; i < n; ++i) {
            uint256 out = outs[i];
            if (out == 0) continue;
            address stock = _stocksEver[i];
            if (_tryTransfer(stock, msg.sender, out)) {
                emit Delivered(msg.sender, stock, msg.sender, out);
                delivered += 1;
            } else {
                stockPending[msg.sender][stock] += out;
                pendingStockTotal[stock] += out;
                emit DeliveryDeferred(msg.sender, stock, out);
            }
        }

        emit Redeemed(msg.sender, amount, supply);
    }

    /// @notice Retry a deferred leg — a stock that was paused when its
    ///         redemption ran. Open to anyone, for their own credit.
    function collectStock(address stock) external nonReentrant returns (uint256 amount) {
        amount = stockPending[msg.sender][stock];
        if (amount == 0) revert NothingToRedeem();
        stockPending[msg.sender][stock] = 0;
        pendingStockTotal[stock] -= amount;
        // Still paused reverts — which restores the two writes above and
        // keeps the entitlement, exactly like `Distributor.withdraw`.
        if (!_tryTransfer(stock, msg.sender, amount)) revert TransferFailed();
        emit StockCollected(msg.sender, stock, amount);
    }

    /// @notice What `amount` would redeem right now, aligned with
    ///         `allStocks()`. The numbers move with every burn and every
    ///         purchase — hence `minOuts`.
    function redeemPreview(uint256 amount) external view returns (address[] memory stocks, uint256[] memory outs) {
        stocks = _stocksEver;
        uint256 n = stocks.length;
        outs = new uint256[](n);
        address tok = TOKEN;
        if (tok == address(0)) tok = IBackingVault(FEE_VAULT).token();
        if (tok == address(0) || amount == 0 || n == 0) return (stocks, outs);
        uint256 supply = IBurnable(tok).totalSupply() - IBurnable(tok).balanceOf(DEAD);
        for (uint256 i; i < n; ++i) {
            uint256 pot = IERC20(stocks[i]).balanceOf(address(this)) - pendingStockTotal[stocks[i]];
            outs[i] = (pot * amount) / supply;
        }
    }

    function allStocks() external view returns (address[] memory) {
        return _stocksEver;
    }

    // ------------------------------------------------------------ 3. plumbing

    /// @notice Sends this contract's ETH back to the vault's rewards pool.
    ///         Open to anyone; there is nothing here for ETH to do.
    ///
    /// @dev    An ETH-quoted vault's `harvest` skims a delivery budget for its
    ///         distributor — this mode delivers nothing, so the budget would
    ///         only pile up. `fundRewards` books it back into `rewardsPool`,
    ///         where the next `buyBasket` spends it on stocks: the holders'
    ///         money returns to the holders' side of the ledger.
    function sweepToVault() external nonReentrant returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToRedeem();
        IBackingVault(FEE_VAULT).fundRewards{value: amount}();
        emit SweptToVault(amount);
    }

    /// @notice Stores the platform's second key. **The timelock's, and the
    ///         registry's on its own vaults** — the same two callers as
    ///         `Distributor.setCoSigner`, because `Payd._create` stamps
    ///         through this door at birth and the stamp is hard.
    function setCoSigner(address newCoSigner) external {
        if (msg.sender != TIMELOCK && msg.sender != _registry()) revert NotTimelock();
        emit CoSignerChanged(coSigner, newCoSigner);
        coSigner = newCoSigner;
    }

    // -------------------------------------------------------------- internals

    /// @dev The token, from the vault, cached on first sight. An unbound vault
    ///      answers zero, which is NOT cached — the same shape as
    ///      `V2Legs._token()`, and for the same reason: the vault exists
    ///      before the launch does.
    function _token() internal returns (address t) {
        t = TOKEN;
        if (t == address(0)) {
            t = IBackingVault(FEE_VAULT).token();
            if (t != address(0)) TOKEN = t;
        }
    }

    /// @dev The registry our vault belongs to, or zero. Read on demand and
    ///      never stored — verbatim `Distributor._registry`.
    function _registry() internal view returns (address reg) {
        (bool ok, bytes memory ret) = FEE_VAULT.staticcall(abi.encodeWithSignature("REGISTRY()"));
        if (ok && ret.length == 32) reg = abi.decode(ret, (address));
    }

    function _tryTransfer(address stock, address to, uint256 amount) internal returns (bool) {
        try IERC20(stock).transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
