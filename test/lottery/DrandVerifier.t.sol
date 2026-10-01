// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BLS} from "solady/utils/ext/ithaca/BLS.sol";
import {DrandLib} from "../../contracts/lottery/DrandLib.sol";

/// @dev A thin on-chain harness so the internal library functions run through a
///      real CALL against the precompiles.
contract DrandHarness {
    function hashToG1(bytes32 m) external view returns (BLS.G1Point memory) {
        return DrandLib.hashToG1(m);
    }

    function verify(uint64 round, BLS.G1Point calldata sig) external view returns (bool) {
        return DrandLib.verifyBeacon(round, sig);
    }

    function rand(BLS.G1Point calldata sig) external pure returns (uint256) {
        return DrandLib.randomness(sig);
    }
}

/// @notice **The drand verifier, against real quicknet beacons.** Requires the
///         EIP-2537 precompiles (`0x0b`/`0x10`/`0x0f`), so this suite runs under
///         the `prague` EVM — `docs/recon.md` §14.1. The vectors are public
///         history (round 1,000,000), not mocks: a beacon signature cannot be
///         forged, so pinning it is pinning a fact.
contract DrandVerifierTest is Test {
    DrandHarness h;

    // quicknet round 1,000,000 — signature and derived quantities, generated
    // from the drand API and @noble/curves (offchain/scripts/drand-recon.mjs).
    uint64 constant ROUND = 1_000_000;

    function setUp() public {
        h = new DrandHarness();
    }

    function _sig() internal pure returns (BLS.G1Point memory) {
        return BLS.G1Point({
            x_a: 0x0000000000000000000000000000000003ad29e4c409f9470fc2ef02f90214df,
            x_b: 0x49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72,
            y_a: 0x0000000000000000000000000000000001776ff7408b39c5f6f9fa50746efd7e,
            y_b: 0xea17fbb61f2e7b9c849ff0528e5a3deeedd029d0df345199963d75ba93b5a02a
        });
    }

    /// @notice `hashToG1(sha256(be64(round)))` matches `@noble`'s `hashToCurve`
    ///         to the byte — the recipe (`expand → 2×MAP → G1ADD`, 43-byte DST,
    ///         no cofactor multiply) reproduced on-chain.
    function test_HashToG1MatchesTheReferenceVector() public view {
        BLS.G1Point memory p = h.hashToG1(DrandLib.beaconMessage(ROUND));
        assertEq(p.x_a, 0x000000000000000000000000000000000533fbfd488393ea4e2fe335e2b768d1, "H(m).x_a");
        assertEq(p.x_b, 0x12934e2477f335d4360c1ed8b96907740b49a16947fe30f7fc76433c70d0940b, "H(m).x_b");
        assertEq(p.y_a, 0x0000000000000000000000000000000005cf7470bbc5e814f87f58627718949c, "H(m).y_a");
        assertEq(p.y_b, 0x2ba851c3f1e29220da68829d3502953f3b557c97d72fc76caf341ea244730002, "H(m).y_b");
    }

    /// @notice The real signature verifies against the pinned group key.
    function test_ARealBeaconVerifies() public view {
        assertTrue(h.verify(ROUND, _sig()), "quicknet round 1,000,000 must verify");
    }

    /// @notice The same signature against the WRONG round does not verify — the
    ///         message is bound into the pairing, so a beacon cannot be replayed
    ///         onto another round.
    function test_TheWrongRoundIsRejected() public view {
        assertFalse(h.verify(ROUND + 1, _sig()), "a beacon must not verify for another round");
    }

    /// @notice A tampered signature does not verify. A flip that keeps the point
    ///         on-curve+in-subgroup returns false; one that does not makes the
    ///         precompile revert — either way it is not accepted.
    function test_ATamperedSignatureIsRejected() public {
        BLS.G1Point memory bad = _sig();
        bad.y_b = bytes32(uint256(bad.y_b) ^ 1);
        try h.verify(ROUND, bad) returns (bool ok) {
            assertFalse(ok, "a tampered signature must not verify");
        } catch {
            // The precompile rejected the point outright — also a rejection.
        }
    }

    /// @notice The randomness word is `keccak256(uncompressed sig)`, pinned.
    function test_RandomnessIsKeccakOfTheUncompressedSignature() public view {
        assertEq(
            h.rand(_sig()), uint256(0xad2e4e54bd5f20dcb7516fae9608f9f017a6190078ea4c7406c4b787027ee10d), "winning word"
        );
    }
}
