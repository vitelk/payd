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

import {FeeVault} from "./FeeVault.sol";
import {Distributor} from "./Distributor.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {VaultTypes} from "./interfaces/VaultTypes.sol";

/// @title  Bootstrap
/// @notice Deploys `Distributor` and `FeeVault` in ONE transaction.
///
/// @dev    The two contracts reference each other as `immutable`: the vault must
///         know the distributor to credit purchases to it, and the distributor
///         must know the vault to accept funds from it alone. Neither can
///         therefore be deployed first with a plain CREATE2 — each address would
///         depend on the other's bytecode, which depends on its address.
///
///         The way out: CREATE addresses depend only on the deployer and its
///         nonce, NOT on constructor arguments. So this contract computes the
///         address of its second deployment before making the first one.
///
///         It all happens in a single transaction, and a final `require` checks
///         the prediction: either both contracts are deployed and correctly
///         wired, or nothing is. Predicting from an EOA would work too, but any
///         transaction slipped in between would shift the nonce and leave an
///         orphaned `Distributor` pointing at an empty address.
/// @custom:project  Payd Protocol
/// @custom:token    Payd Protocol ($PAYD)
/// @custom:website  paydprotocol.eth — the project, and the way to the app.
///                  For browsers without ENS: https://paydprotocol.eth.limo
/// @custom:x        https://x.com/PaydRH
/// @custom:telegram https://t.me/Payd_RH
/// @custom:discord  https://discord.gg/F4D2szShME
contract Bootstrap {
    error PredictionFailed();

    Distributor public immutable DISTRIBUTOR;
    FeeVault public immutable VAULT;

    /// @param vaultImpl       the `FeeVault` logic every launch clones
    /// @param distributorImpl the `Distributor` logic every launch clones
    constructor(
        address vaultImpl,
        address distributorImpl,
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory allocations,
        address keeper,
        uint256 genesis,
        uint256 epochLength
    ) {
        // The two clones still reference each other, so the prediction trick
        // survives the move: `LibClone.clone` deploys with CREATE, whose
        // address depends on the deployer and its nonce and NOT on what is
        // being deployed. A contract's nonce starts at 1, so this constructor
        // clones the Distributor at nonce 1 and the vault at nonce 2.
        address predictedVault = _createAddress(address(this), 2);

        DISTRIBUTOR = Distributor(payable(LibClone.clone(distributorImpl)));
        DISTRIBUTOR.init(predictedVault, cfg.timelock, keeper, genesis, epochLength);

        cfg.distributor = address(DISTRIBUTOR);
        VAULT = FeeVault(payable(LibClone.clone(vaultImpl)));
        // Cloned and configured in the SAME transaction: there is no block in
        // which an uninitialised vault exists for someone else to claim.
        VAULT.init(cfg, allocations);

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
