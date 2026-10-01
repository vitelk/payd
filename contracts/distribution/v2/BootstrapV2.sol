// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeVaultV2} from "./FeeVaultV2.sol";
import {V2Legs} from "./V2Legs.sol";
import {Distributor} from "../Distributor.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {VaultTypes} from "../../interfaces/VaultTypes.sol";

/// @title  BootstrapV2
/// @notice `Bootstrap` with a third clone: the V2 legs. Same knot, same trick —
///         the vault and the distributor reference each other as `immutable`,
///         so the vault's address is predicted from this contract's nonce
///         before anything is deployed, and a final check makes the whole
///         thing atomic: either all three are deployed and wired, or nothing.
///
/// @dev    Nonces: the Distributor clones at 1, the legs at 2 (when the launch
///         asked for any), the vault at 2 or 3. `initLegs` is called HERE, in
///         the same transaction as `init` — that is what lets it need no key.
contract BootstrapV2 {
    error PredictionFailed();

    Distributor public immutable DISTRIBUTOR;
    FeeVaultV2 public immutable VAULT;
    /// @notice Zero when the launch declared no legs — the vault then behaves
    ///         exactly like a V1.
    V2Legs public immutable LEGS;

    constructor(
        address vaultImpl,
        address distributorImpl,
        address legsImpl,
        address poolManager,
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory allocations,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        uint256 burnBps,
        uint256 lpBps
    ) {
        bool wantLegs = burnBps + lpBps != 0;
        address predictedVault = _createAddress(address(this), wantLegs ? 3 : 2);

        DISTRIBUTOR = Distributor(payable(LibClone.clone(distributorImpl)));
        DISTRIBUTOR.init(predictedVault, cfg.timelock, keeper, genesis, epochLength);

        V2Legs legs;
        if (wantLegs) legs = V2Legs(payable(LibClone.clone(legsImpl)));
        LEGS = legs;

        cfg.distributor = address(DISTRIBUTOR);
        VAULT = FeeVaultV2(payable(LibClone.clone(vaultImpl)));
        VAULT.init(cfg, allocations, address(legs), burnBps + lpBps);

        if (wantLegs) {
            // The legs learn their TOKEN from the vault at first use — the
            // launch does not exist yet. `cfg.factory` is the Pons factory,
            // the same one the vault harvests from, and the minimum move is
            // the vault's own `MIN_BUY_QUOTE`, because "0.005 ether" means
            // nothing in a quote with other decimals.
            legs.init(address(VAULT), cfg.quote, cfg.factory, poolManager, VAULT.MIN_BUY_QUOTE(), burnBps, lpBps);
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
