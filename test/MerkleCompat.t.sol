// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Cross-check between `offchain/src/merkle.ts` and what the contract
///         recomputes. The values are emitted by the TypeScript; if either side
///         changes its encoding, this test breaks here rather than in production
///         on a rejected proof.
///
///         Cumulative model: the leaf is `(holder, stock, cumulative)` — no
///         epoch (docs/ARCHITECTURE.md §S18).
contract MerkleCompatTest is Test {
    address constant HOLDER = 0x1111111111111111111111111111111111111111;
    address constant STOCK_A = 0x3333333333333333333333333333333333333333;
    address constant STOCK_B = 0x4444444444444444444444444444444444444444;

    bytes32 constant LEAF_TS = 0x2f68f27e96773bbbdf4b48ddcb1f046889d50e3ddebd05d5a7d47d580932b21d;
    bytes32 constant ROOT_TS = 0xfc9134e2fae439711295c0f99176e0179c31d250969b78b236b3ba4b0c9b57e1;
    bytes32 constant SIBLING_TS = 0x884c0747a5833f565f742803f70eaa00f18272ba10a55b2aa258a0908196da05;

    /// @dev Reproduces `Distributor._one`: double hash, as OpenZeppelin does.
    function _leaf(address holder, address stock, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(holder, stock, cumulative))));
    }

    /// @dev Reproduces `Distributor._verify`: sorted pairs.
    function _verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            computed = computed < proof[i]
                ? keccak256(abi.encodePacked(computed, proof[i]))
                : keccak256(abi.encodePacked(proof[i], computed));
        }
        return computed == root;
    }

    function test_LeafMatchesTypeScript() public pure {
        assertEq(_leaf(HOLDER, STOCK_A, 1234), LEAF_TS, "leaf encoding diverges between TS and Solidity");
    }

    function test_ProofFromTypeScriptVerifies() public pure {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = SIBLING_TS;
        assertTrue(_verify(proof, ROOT_TS, _leaf(HOLDER, STOCK_A, 300)), "proof from the TS rejected by the contract");

        // An inflated cumulative does not pass.
        assertFalse(_verify(proof, ROOT_TS, _leaf(HOLDER, STOCK_A, 999)), "a forged cumulative total went through");
        // Nor another stock with the same amount.
        assertFalse(_verify(proof, ROOT_TS, _leaf(HOLDER, STOCK_B, 300)), "substitution de stock possible");
        // Nor another holder.
        assertFalse(_verify(proof, ROOT_TS, _leaf(address(0xBEEF), STOCK_A, 300)), "substitution de holder possible");
    }
}
