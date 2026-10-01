// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PortfolioVault} from "./PortfolioVault.sol";
import {V2Legs} from "../distribution/v2/V2Legs.sol";
import {PortfolioDistributor} from "./PortfolioDistributor.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  PortfolioBootstrap
/// @notice Ties the knot for the personal-portfolio mode: the vault and the
///         distributor each need the other's address, and the distributor also
///         needs the book.
///
/// @dev    `BootstrapV3`'s trick, unchanged — the vault's address is predicted
///         from this contract's nonce before anything is deployed and a final
///         check makes the whole thing atomic. Nonces: the Distributor clones
///         at 1, the legs at 2 when the launch asked for any, the vault at 2
///         or 3 — `BootstrapV3`'s own arithmetic. One difference from it, and
///         it is this mode's extra wire:
///
///           - `setBook` is called BEFORE `initV3`, which is what makes it
///             unreachable afterwards: it refuses once `FEE_VAULT` is set.
///
///         The timelock is the platform's on BOTH halves. This mode moves no
///         governance seat: the holders' choices need no timelock, which is the
///         whole reason this design was preferred to the one that made the
///         vault buy the aggregate.
contract PortfolioBootstrap {
    error PredictionFailed();
    error ZeroAddress();

    PortfolioDistributor public immutable DISTRIBUTOR;
    PortfolioVault public immutable VAULT;

    /// @notice Zero when the launch declared no legs — the vault then behaves
    ///         exactly as it did before this mode could carry them.
    V2Legs public immutable LEGS;

    /// @dev One struct because eleven positional arguments through a
    ///      constructor is where a wrong address goes unnoticed, and this one
    ///      predicts an address from its own nonce: an argument in the wrong
    ///      slot would fail the prediction rather than the intent, and the
    ///      revert would name neither.
    struct Wiring {
        address vaultImpl;
        address distributorImpl;
        address legsImpl;
        address poolManager;
        address keeper;
        uint256 genesis;
        uint256 epochLength;
        address excludedAtBirth;
        address book;
        uint256 burnBps;
        uint256 lpBps;
    }

    constructor(Wiring memory w, VaultTypes.Config memory cfg, VaultTypes.Allocation[] memory allocations) {
        if (w.book == address(0)) revert ZeroAddress();
        bool wantLegs = w.burnBps + w.lpBps != 0;
        address predictedVault = _createAddress(address(this), wantLegs ? 3 : 2);

        DISTRIBUTOR = PortfolioDistributor(payable(LibClone.clone(w.distributorImpl)));
        DISTRIBUTOR.setBook(w.book);
        DISTRIBUTOR.initV3(predictedVault, cfg.timelock, w.keeper, w.genesis, w.epochLength, w.excludedAtBirth);

        V2Legs legs;
        if (wantLegs) legs = V2Legs(payable(LibClone.clone(w.legsImpl)));
        LEGS = legs;

        cfg.distributor = address(DISTRIBUTOR);
        VAULT = PortfolioVault(payable(LibClone.clone(w.vaultImpl)));
        // The vault cannot learn an address from two numbers, so what goes down
        // is the CLONE and the combined weight — not the creator's `(burnBps,
        // lpBps)`, which the factory has already checked and which the legs
        // themselves are initialised with below.
        VAULT.init(cfg, allocations, abi.encode(address(legs), w.burnBps + w.lpBps));

        if (wantLegs) {
            // The legs learn their TOKEN from the vault at first use, which is
            // why this can run after `init` and must run before any purchase.
            legs.init(address(VAULT), cfg.quote, cfg.factory, w.poolManager, VAULT.MIN_BUY_QUOTE(), w.burnBps, w.lpBps);
        }

        if (address(VAULT) != predictedVault) revert PredictionFailed();
    }

    /// @dev CREATE address, for nonces 1 to 127. RLP: 22-byte list (0xd6),
    ///      address prefixed with 0x94, then the nonce on a single byte.
    function _createAddress(address deployer, uint8 nonce) internal pure returns (address) {
        require(nonce > 0 && nonce < 0x80, "nonce out of range");
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }
}
