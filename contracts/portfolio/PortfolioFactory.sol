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

import {PortfolioBootstrap} from "./PortfolioBootstrap.sol";
import {PortfolioBook} from "./PortfolioBook.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  PortfolioFactory
/// @notice The personal-portfolio payout mode. The creator posts a default
///         basket; each holder may declare their own, **freely**, over any
///         stock the platform allows; and each is paid in theirs automatically.
///
/// @dev    **This mode adds no key and no privileged function.** The vault
///         converts the holders' share into the pivot and stops; the holders'
///         choices live in `PortfolioBook`, which holds no money and which the
///         timelock never touches; the conversion happens at delivery, one swap
///         per batch, with the weight READ from the book rather than taken from
///         the call. `FLOWS.md` §6 carries the statement in full.
///
///         **Three contracts per launch and two new implementations.** Unlike
///         backing, lottery and tontine this mode does NOT reuse the deployed
///         `FeeVaultV2`: its vault is built on `contracts/modes/BaseModeVault`
///         — the platform's half, inherited verbatim — because a vault that
///         buys no basket has no use for three quarters of `FeeVault`. It does
///         reuse that file's money path: `_toPivot` and `_route` are ported
///         unchanged, so every quote the default mode serves, this one serves.
///
///         **`MODE` is `"portfolio"`.** `FeeVault.migrate` compares mode names,
///         so a distribution vault cannot wander in here — nor one of these out
///         — unless the generation key has opened `crossModeMigration`.
///
///         The selectors `MODE()` and `create(...)` are fixed by the cast in
///         `Payd._enable` / `Payd._create`. Verify after any change:
///
///             forge inspect contracts/portfolio/PortfolioFactory.sol:PortfolioFactory methods
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract PortfolioFactory {
    error BadEpochLength(uint256 given);
    error BadModeData();
    error ZeroAddress();

    uint256 public constant MIN_EPOCH_LENGTH = 30 minutes;
    uint256 public constant MAX_EPOCH_LENGTH = 1 days;

    bytes32 public constant MODE = "portfolio";

    /// @notice The legs' bounds, `DistributionFactoryV3`'s and `TontineFactory`'s
    ///         verbatim. A leg is off or it is worth a pool interaction, and the
    ///         two together may not take more than half of what the holders were
    ///         going to be paid.
    uint256 public constant MIN_LEG_BPS = 500;
    uint256 public constant MAX_LEGS_BPS = 5_000;

    address public immutable VAULT_IMPL;
    address public immutable DIST_IMPL;
    /// @notice The `V2Legs` implementation every launch under this mode clones
    ///         when it asks for a burn or a locked-LP leg.
    address public immutable LEGS_IMPL;
    address public immutable POOL_MANAGER;
    /// @notice The Pons locker, excluded from every distributor this builds at
    ///         epoch 0. Declared from recon (`docs/recon.md` §1.1).
    address public immutable EXCLUDED_AT_BIRTH;

    /// @notice The book of every vault this factory built, so the app and the
    ///         off-chain reach it from the vault alone.
    mapping(address vault => address book) public bookOf;

    event VaultBuilt(address indexed vault, address indexed distributor, address indexed book);

    constructor(address vaultImpl, address distImpl, address legsImpl, address poolManager, address excludedAtBirth) {
        if (
            vaultImpl == address(0) || distImpl == address(0) || legsImpl == address(0) || poolManager == address(0)
                || excludedAtBirth == address(0)
        ) revert ZeroAddress();
        VAULT_IMPL = vaultImpl;
        DIST_IMPL = distImpl;
        LEGS_IMPL = legsImpl;
        POOL_MANAGER = poolManager;
        EXCLUDED_AT_BIRTH = excludedAtBirth;
    }

    /// @notice Builds the book, then the pair, wired to each other, in one
    ///         transaction.
    ///
    /// @dev    `basket` is the DEFAULT portfolio — what a holder who declares
    ///         nothing is paid in. `Payd._create` has already checked every line
    ///         against the stock allowlist, so the book only checks its shape.
    ///         An EMPTY basket is legal and means "pay the pivot until somebody
    ///         chooses".
    ///
    ///         `modeData` is `abi.encode(burnBps, lpBps)` or empty — the same
    ///         parameter V3 and the tontine take, because the burn and locked-LP
    ///         legs are orthogonal to who decides the payout. They take their
    ///         slice of the QUOTE before the pivot hop, so they never compete
    ///         with a holder's row.
    function create(
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory basket,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        bytes memory modeData
    ) external returns (address vault, address distributor) {
        if (epochLength < MIN_EPOCH_LENGTH || epochLength > MAX_EPOCH_LENGTH) {
            revert BadEpochLength(epochLength);
        }
        (uint256 burnBps, uint256 lpBps) = _decodeLegs(modeData);

        PortfolioBook book = new PortfolioBook(address(this), cfg.registry);
        PortfolioBootstrap boot = new PortfolioBootstrap(
            PortfolioBootstrap.Wiring({
                vaultImpl: VAULT_IMPL,
                distributorImpl: DIST_IMPL,
                legsImpl: LEGS_IMPL,
                poolManager: POOL_MANAGER,
                keeper: keeper,
                genesis: genesis,
                epochLength: epochLength,
                excludedAtBirth: EXCLUDED_AT_BIRTH,
                book: address(book),
                burnBps: burnBps,
                lpBps: lpBps
            }),
            cfg,
            basket
        );
        vault = address(boot.VAULT());
        distributor = address(boot.DISTRIBUTOR());

        PortfolioBook.Line[] memory lines = new PortfolioBook.Line[](basket.length);
        for (uint256 i; i < basket.length; ++i) {
            lines[i] = PortfolioBook.Line(basket[i].stock, basket[i].bps);
        }
        book.bind(vault, lines);
        bookOf[vault] = address(book);
        emit VaultBuilt(vault, distributor, address(book));
    }

    /// @dev `TontineFactory._decodeLegs`, verbatim — the same twelve lines over
    ///      the same two bounds, because a burn leg and a locked-LP leg mean
    ///      the same thing whatever decides where the REST goes.
    ///
    ///      **Empty IS the way to say "no legs"**, so there is exactly one
    ///      encoding per intention: `(0, 0)` spelled out is refused rather than
    ///      quietly accepted as nothing.
    function _decodeLegs(bytes memory modeData) internal pure returns (uint256 burnBps, uint256 lpBps) {
        if (modeData.length == 0) return (0, 0);
        if (modeData.length != 64) revert BadModeData();
        (burnBps, lpBps) = abi.decode(modeData, (uint256, uint256));
        if (burnBps + lpBps == 0) revert BadModeData();
        if (burnBps != 0 && burnBps < MIN_LEG_BPS) revert BadModeData();
        if (lpBps != 0 && lpBps < MIN_LEG_BPS) revert BadModeData();
        if (burnBps + lpBps > MAX_LEGS_BPS) revert BadModeData();
    }
}
