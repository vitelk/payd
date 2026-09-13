// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice Deploys the pair the way `Bootstrap` does: clones of a shared
///         implementation, configured in the same transaction.
///
/// @dev    `new FeeVault()` builds an IMPLEMENTATION, not a vault — its
///         constructor marks it initialised so it can never be configured,
///         which is exactly the point. Every test that wants a working vault
///         goes through here.
///
///         The implementations are made once per test contract and reused, so
///         the tests pay what production pays: one deployment, then clones.
abstract contract CloneBase is Test {
    address internal vaultImpl;
    address internal distImpl;

    /// @dev Deploys both implementations NOW.
    ///
    ///      Call it before any test that predicts a CREATE address: a lazy
    ///      deployment inside the helpers would slip an extra nonce between the
    ///      prediction and the clone, and the prediction would miss by one.
    function _impls() internal {
        if (vaultImpl == address(0)) vaultImpl = address(new FeeVault());
        if (distImpl == address(0)) distImpl = address(new Distributor());
    }

    /// @dev A bare clone, unconfigured. For the tests that arm a cheatcode on
    ///      `init` itself: a `CREATE` would otherwise swallow the
    ///      `vm.expectRevert` before `init` ever runs.
    function _bareVault() internal returns (FeeVault) {
        _impls();
        return FeeVault(payable(LibClone.clone(vaultImpl)));
    }

    function _cloneVault(VaultTypes.Config memory c, VaultTypes.Allocation[] memory a) internal returns (FeeVault v) {
        v = _bareVault();
        v.init(c, a);
    }

    /// @dev A bare Distributor clone, unconfigured. Same reason as `_bareVault`.
    function _bareDistributor() internal returns (Distributor) {
        _impls();
        return Distributor(payable(LibClone.clone(distImpl)));
    }

    function _cloneDistributor(address feeVault, address timelock_, address keeper_, uint256 genesis, uint256 len)
        internal
        returns (Distributor d)
    {
        d = _bareDistributor();
        d.init(feeVault, timelock_, keeper_, genesis, len);
    }
}
