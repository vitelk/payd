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

import {BLS} from "solady/utils/ext/ithaca/BLS.sol";

/// @title  DrandLib
/// @notice Verifies a drand `quicknet` beacon on-chain, and turns its signature
///         into a uniform random number. The randomness the lottery draws from
///         — no key of ours in it, relayed permissionlessly by anyone.
///
/// @dev    **Everything here was measured on Robinhood Chain before it was
///         written** (`docs/recon.md` §14.1, 2026-09-15). quicknet is the
///         `bls-unchained-g1-rfc9380` scheme: signatures on G1, the group key
///         on G2, message `sha256(be64(round))`. Verification is one pairing:
///
///             e(sig, −g2) · e(H(m), pk) == 1   ⟺   e(sig, g2) == e(H(m), pk)
///
///         `pk` and `−g2` are the two constants below, read from the drand API
///         and cross-checked byte-for-byte across four relays. The pairing
///         precompile (`0x0f`) does the on-curve and subgroup checks on `sig`
///         itself, so a submitted signature needs no separate validation.
///
///         **The hash-to-curve is `hashToG2` transposed to G1**, using solady's
///         vendored BLS assembly patterns (`lib/solady/.../ithaca/BLS.sol`).
///         Two facts a real beacon corrected, and both are load-bearing:
///
///         1. **The DST is the 43-byte `…SSWU_RO_NUL_`**, single-L. The pairing
///            fails under the 44-byte `NULL_` a draft guessed and passes under
///            this one — `test/lottery/DrandVerifier.t.sol` pins a real beacon
///            precisely so this cannot regress silently.
///         2. **`MAP_FP_TO_G1` already clears the cofactor** on this chain, so
///            `H(m)` is `expand → 2×MAP → G1ADD` with NO extra multiply. Proven:
///            `MAP(u0)+MAP(u1)` matched noble's full `hashToCurve` to the byte.
///
///         The winning number is `keccak256(uncompressed sig)`, NOT drand's
///         published `sha256(compressed sig)`: hashing the uncompressed point
///         avoids writing point compression in Solidity, and a BLS signature is
///         deterministic and unique for a fixed (key, message), so the draw
///         stays a pure function of (committed leaves, beacon signature).
library DrandLib {
    /// @dev quicknet's group public key (G2), EIP-2537 encoding. §14.1.
    function _pubkey() private pure returns (BLS.G2Point memory) {
        return BLS.G2Point({
            x_c0_a: 0x000000000000000000000000000000000d1fec758c921cc22b0e17e63aaf4bcb,
            x_c0_b: 0x5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a,
            x_c1_a: 0x0000000000000000000000000000000003cf0f2896adee7eb8b5f01fcad39122,
            x_c1_b: 0x12c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451,
            y_c0_a: 0x000000000000000000000000000000000e5db2b6bfbb01c867749cadffca88b3,
            y_c0_b: 0x6c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273,
            y_c1_a: 0x0000000000000000000000000000000001a714f2edb74119a2f2b0d5a7c75ba9,
            y_c1_b: 0x02d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b
        });
    }

    /// @dev The negated G2 generator, EIP-2537 encoding. A constant, so the
    ///      pairing needs no G2 negation at run time. §14.1.
    function _negG2() private pure returns (BLS.G2Point memory) {
        return BLS.G2Point({
            x_c0_a: 0x00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051,
            x_c0_b: 0xc6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8,
            x_c1_a: 0x0000000000000000000000000000000013e02b6052719f607dacd3a088274f65,
            x_c1_b: 0x596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e,
            y_c0_a: 0x000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bc,
            y_c0_b: 0xb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa,
            y_c1_a: 0x0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d,
            y_c1_b: 0x993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed
        });
    }

    /// @notice The beacon message for a round: `sha256(be64(round))`.
    function beaconMessage(uint64 round) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(round));
    }

    /// @notice Hashes a 32-byte message to a G1 point per RFC 9380
    ///         (`expand_message_xmd(SHA-256)` → two Fp → `MAP_FP_TO_G1` each →
    ///         `G1ADD`), with the drand-G1 DST. Transposed from solady's
    ///         `hashToG2`: five sha256 blocks not nine, two field reductions not
    ///         four, `MAP_FP_TO_G1` not `MAP_FP2_TO_G2`.
    function hashToG1(bytes32 message) internal view returns (BLS.G1Point memory) {
        BLS.Fp memory u0;
        BLS.Fp memory u1;
        assembly ("memory-safe") {
            // I2OSP(0,1) ‖ DST ‖ I2OSP(len(DST),1). Only the suite name differs
            // from solady's G2 version: `…G1_XMD…`, and the length byte 0x2b=43.
            function dstPrime(o_, i_) -> _o {
                mstore8(o_, i_)
                mstore(add(o_, 0x01), "BLS_SIG_BLS12381G1_XMD:SHA-256_S")
                mstore(add(o_, 0x21), "SWU_RO_NUL_\x2b")
                _o := add(0x2d, o_)
            }
            function sha2(data_, n_) -> _h {
                if iszero(and(eq(returndatasize(), 0x20), staticcall(gas(), 2, data_, n_, 0x00, 0x20))) {
                    revert(calldatasize(), 0x00)
                }
                _h := mload(0x00)
            }
            // Reduce a 64-byte big-endian value mod p via MODEXP (exp = 1),
            // since p > 2^256 and mulmod cannot. Verbatim from solady.
            function modfield(s_, b_) {
                mcopy(add(s_, 0x60), b_, 0x40)
                if iszero(and(eq(returndatasize(), 0x40), staticcall(gas(), 5, s_, 0x100, b_, 0x40))) {
                    revert(calldatasize(), 0x00)
                }
            }

            let b := mload(0x40)
            let s := add(b, 0x100)
            // Z_pad: 64 zero bytes (the SHA-256 block size).
            calldatacopy(s, calldatasize(), 0x40)
            // msg (32 bytes), then I2OSP(len_in_bytes = 128, 2).
            mstore(add(0x40, s), message)
            let o := add(add(0x40, s), 0x20)
            mstore(o, shl(240, 128))
            // b0 = sha256(Z_pad ‖ msg ‖ I2OSP(128,2) ‖ dstPrime(0)).
            let b0 := sha2(s, sub(dstPrime(add(0x02, o), 0), s))
            mstore(0x20, b0)
            mstore(s, b0)
            // b_1 = sha256(b0 ‖ I2OSP(1,1) ‖ DST').
            mstore(b, sha2(s, sub(dstPrime(add(0x20, s), 1), s)))
            // b_i = sha256((b0 ^ b_{i-1}) ‖ I2OSP(i,1) ‖ DST'), i = 2..4.
            // Four 32-byte blocks = 128 bytes = two field elements.
            let j := b
            for { let i := 2 } 1 {} {
                mstore(s, xor(b0, mload(j)))
                j := add(j, 0x20)
                mstore(j, sha2(s, sub(dstPrime(add(0x20, s), i), s)))
                i := add(i, 1)
                if eq(i, 5) { break }
            }

            // MODEXP call frame: base_len 64, exp_len 32, mod_len 64, exp 1, mod p.
            mstore(add(s, 0x00), 0x40)
            mstore(add(s, 0x20), 0x20)
            mstore(add(s, 0x40), 0x40)
            mstore(add(s, 0xa0), 1)
            mstore(add(s, 0xc0), 0x000000000000000000000000000000001a0111ea397fe69a4b1ba7b6434bacd7)
            mstore(add(s, 0xe0), 0x64774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab)
            modfield(s, add(b, 0x00)) // u0 = reduce(b_1 ‖ b_2)
            modfield(s, add(b, 0x40)) // u1 = reduce(b_3 ‖ b_4)

            mcopy(u0, add(b, 0x00), 0x40)
            mcopy(u1, add(b, 0x40), 0x40)
        }
        // MAP each field element (cofactor cleared by the precompile) and add.
        return BLS.add(BLS.toG1(u0), BLS.toG1(u1));
    }

    /// @notice True iff `signature` is the quicknet beacon for `round`.
    ///
    /// @dev    One pairing check. The precompile validates `signature` is a
    ///         canonical, on-curve, in-subgroup G1 point, so a forged encoding
    ///         cannot slip through as a different point.
    function verifyBeacon(uint64 round, BLS.G1Point memory signature) internal view returns (bool) {
        BLS.G1Point memory h = hashToG1(beaconMessage(round));
        BLS.G1Point[] memory g1 = new BLS.G1Point[](2);
        BLS.G2Point[] memory g2 = new BLS.G2Point[](2);
        g1[0] = signature;
        g2[0] = _negG2();
        g1[1] = h;
        g2[1] = _pubkey();
        return BLS.pairing(g1, g2);
    }

    /// @notice The uniform random word a verified signature yields.
    ///
    /// @dev    `keccak256` over the uncompressed point's four words — not
    ///         drand's `sha256(compressed)` — so no point compression is needed
    ///         on-chain. Deterministic in the signature, which is unique per
    ///         (key, round).
    function randomness(BLS.G1Point memory signature) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(signature.x_a, signature.x_b, signature.y_a, signature.y_b)));
    }
}
