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

import {FeeVaultV2} from "../distribution/v2/FeeVaultV2.sol";
import {LotteryDistributor} from "./LotteryDistributor.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {VaultTypes} from "../interfaces/VaultTypes.sol";

/// @title  LotteryBootstrap
/// @notice `BootstrapV2`'s knot with the lottery's distributor: the vault and
///         the `LotteryDistributor` reference each other as init-time constants,
///         so the vault's address is predicted from this contract's nonce before
///         anything is deployed, and a final check makes it atomic.
///
/// @dev    The vault is a plain `FeeVaultV2` with no legs: the lottery changes
///         where the stocks GO (a pot, drawn by beacon) and how they are PAID
///         (one winner), never how they are bought. The buy stack is never
///         copied. Nonces: the distributor clones at 1, the vault at 2.
contract LotteryBootstrap {
    error PredictionFailed();

    LotteryDistributor public immutable DISTRIBUTOR;
    FeeVaultV2 public immutable VAULT;

    constructor(
        address vaultImpl,
        address distImpl,
        VaultTypes.Config memory cfg,
        VaultTypes.Allocation[] memory allocations,
        address keeper,
        uint256 genesis,
        uint256 epochLength,
        uint256 potBps
    ) {
        address predictedVault = _createAddress(address(this), 2);

        DISTRIBUTOR = LotteryDistributor(payable(LibClone.clone(distImpl)));
        DISTRIBUTOR.init(predictedVault, cfg.timelock, keeper, genesis, epochLength, potBps);

        cfg.distributor = address(DISTRIBUTOR);
        VAULT = FeeVaultV2(payable(LibClone.clone(vaultImpl)));
        VAULT.init(cfg, allocations, address(0), 0);

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
