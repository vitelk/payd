// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";

/// @notice **The second key on a root, and the deadman that keeps it honest.**
///
/// @dev    `AUDIT_PLAN.md` §1.1 and `FLOWS.md` §7.c declare the shape of the
///         keeper risk: one key publishes, the root applies within the second,
///         and the timelock takes 48 h to revoke — which stops the next theft
///         and not this one. `docs/AUDIT_FIXES.md` §2.1 then showed the bound is
///         the whole undelivered balance rather than one epoch.
///
///         **What settled the design is the ORDER of two transactions.** A
///         thief holding the keeper key sends `publishRoot` and `claim` with
///         consecutive nonces, in the same block; nothing in `claim` times
///         anything. No watcher and no freeze fits in that gap, so whatever
///         closes it has to sit BEFORE the publication.
///
///         So the root is co-signed by a key that **recomputes it first**.
///         `crossCheck` already rebuilds the root from a second node, but the
///         keeper runs it on itself and a compromised keeper simply does not
///         run it; behind a second key the same computation becomes a door.
///
///         The whole file is about one question the naive version gets wrong:
///         **who controls the silence.** See
///         `test_TheKeeperCannotLiftTheRequirementByStayingQuiet`.
contract CoSignerTest is CloneBase {
    Distributor internal dist;

    address internal feeVault = makeAddr("fee vault");
    address internal timelock = makeAddr("timelock");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    uint256 internal coSignerPk = 0xC05167;
    address internal coSigner;
    uint256 internal otherPk = 0x0DDBA11;

    uint256 internal constant LEN = 30 minutes;

    function setUp() public {
        coSigner = vm.addr(coSignerPk);
        dist = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);
    }

    // ---- helpers -----------------------------------------------------------

    function _sig(uint256 pk, uint256 epoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, dist.rootDigest(epoch, claimRoot, pushRoot, digest));
        return abi.encodePacked(r, s, v);
    }

    function _pastEpoch(uint256 epoch) internal {
        if (block.timestamp <= dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
    }

    function _root(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("root", n));
    }

    function _name(address who) internal {
        vm.prank(timelock);
        dist.setCoSigner(who);
    }

    // ---- 1. with no co-signer, nothing changes -----------------------------

    /// @notice **Unnamed, the contract behaves exactly as it did**, which is the
    ///         state every Distributor made before this existed is in — and the
    ///         state a standalone V1 Distributor stays in for ever.
    function test_WithNoCoSignerTheSingleKeyFormIsTheOnlyOne() public {
        _pastEpoch(0);
        assertFalse(dist.coSignerRequired(), "nobody named, nothing required");

        // And the co-signed form is REFUSED rather than accepted-and-ignored: a
        // call carrying a signature nobody checked would read, for ever after,
        // as a root that was co-signed.
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid", hex"00");

        vm.prank(keeper);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid");
        assertEq(dist.activeRoot(), 1, "the single-key form still works");
    }

    // ---- 2. named, the second key is the nominal path ----------------------

    /// @notice **Named, one key is no longer enough — and the right one is.**
    function test_OnceNamedARootNeedsBothKeys() public {
        _name(coSigner);
        _pastEpoch(0);
        assertTrue(dist.coSignerRequired(), "named and fresh: required");

        // **Both signatures made BEFORE anything is armed.** `_sig` reads
        // `rootDigest` off the contract, and `vm.expectRevert` attaches to the
        // NEXT CALL — inline, it swallows the cheatcode and the test reports
        // "did not revert" on a line that reverts. The same trap
        // `test/Treasury.t.sol` records about `makeAddr`, and it caught this
        // file too.
        bytes memory wrong = _sig(otherPk, 0, _root(1), _root(1), bytes32("d"));
        bytes memory right = _sig(coSignerPk, 0, _root(1), _root(1), bytes32("d"));

        // The keeper alone, by either form.
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid");

        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid", wrong);

        // Both, and it goes through.
        vm.prank(keeper);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid", right);
        assertEq(dist.activeRoot(), 1, "keeper plus co-signer publishes");
    }

    /// @notice **A signature covers ONE root, exactly.**
    ///
    /// @dev    Every field is in the digest, so a co-signer who signed an honest
    ///         root has not signed the keeper's edit of it. This is what stops
    ///         the obvious bypass: get one legitimate signature, then publish
    ///         something else with it.
    function test_ASignatureCoversExactlyTheRootItWasGiven() public {
        _name(coSigner);
        _pastEpoch(0);
        bytes memory sig = _sig(coSignerPk, 0, _root(1), _root(2), bytes32("d"));

        // The claim tree swapped — the field the money is actually in.
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(9), _root(2), bytes32("d"), "cid", sig);

        // The push tree swapped.
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(9), bytes32("d"), "cid", sig);

        // The artifact's digest swapped: same roots, different data behind them.
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(2), bytes32("x"), "cid", sig);

        // The epoch swapped.
        _pastEpoch(1);
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(1, _root(1), _root(2), bytes32("d"), "cid", sig);

        // And the one it WAS given still works.
        vm.prank(keeper);
        dist.publishRoot(0, _root(1), _root(2), bytes32("d"), "cid", sig);
        assertEq(dist.activeRoot(), 1, "the root it signed goes through");
    }

    /// @notice **A signature is bound to this Distributor and this chain.**
    ///
    /// @dev    A thousand vaults run the same code with the same co-signer. If
    ///         the digest did not carry the address, one signature obtained for
    ///         a vault nobody cares about would publish on all of them.
    function test_ASignatureDoesNotTravelToAnotherVault() public {
        _name(coSigner);
        Distributor other = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);
        vm.prank(timelock);
        other.setCoSigner(coSigner);

        _pastEpoch(0);
        assertTrue(
            dist.rootDigest(0, _root(1), _root(1), bytes32("d"))
                != other.rootDigest(0, _root(1), _root(1), bytes32("d")),
            "two vaults must not hash one root to the same thing"
        );

        bytes memory sigForOther;
        {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(coSignerPk, other.rootDigest(0, _root(1), _root(1), bytes32("d")));
            sigForOther = abi.encodePacked(r, s, v);
        }
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid", sigForOther);
    }

    // ---- 3. the deadman, and who controls the silence ----------------------

    /// @notice **THE ONE THAT MATTERS: staying quiet does not lift the
    ///         requirement.**
    ///
    /// @dev    The obvious deadman measures the silence as "no root published"
    ///         — and that clock is under the control of whoever holds the keeper
    ///         key. They publish nothing, wait out the grace, and the second key
    ///         removes itself. The deadman would hand the attacker the door it
    ///         was built to close.
    ///
    ///         So the clock runs on a heartbeat the CO-SIGNER writes, and this
    ///         asserts the difference: a keeper who publishes nothing for four
    ///         times the grace is still locked out, as long as the co-signer is
    ///         alive.
    function test_TheKeeperCannotLiftTheRequirementByStayingQuiet() public {
        _name(coSigner);

        // Four graces of a keeper doing nothing at all, while the co-signer
        // keeps saying it is there.
        for (uint256 i; i < 4; ++i) {
            vm.warp(block.timestamp + dist.CO_SIGNER_GRACE());
            vm.prank(coSigner);
            dist.heartbeat();
        }
        assertTrue(dist.coSignerRequired(), "a live co-signer stays required however long the keeper sulks");

        uint256 e = dist.currentEpoch() - 1;
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(e, _root(1), _root(1), bytes32("d"), "cid");
    }

    /// @notice **A co-signer that really stops is not allowed to stop the
    ///         vault.**
    ///
    /// @dev    Removing the requirement through the timelock is the other lever
    ///         and it takes 48 h — ninety-six epochs on a protocol that pays
    ///         every thirty minutes, which is a failure and not a degradation.
    ///         After `CO_SIGNER_GRACE` of real silence the pinned key publishes
    ///         alone again, by itself, and nothing is lost: roots are cumulative
    ///         and the next one settles the whole gap.
    function test_ASilentCoSignerLapsesRatherThanStoppingTheVault() public {
        _name(coSigner);
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        assertFalse(dist.coSignerRequired(), "silence past the grace lifts the requirement");

        uint256 e = dist.currentEpoch() - 1;
        vm.prank(keeper);
        dist.publishRoot(e, _root(1), _root(1), bytes32("d"), "cid");
        assertEq(dist.activeRoot(), 1, "the vault keeps paying rather than waiting 48 h");

        // And it comes BACK the moment the co-signer does, with no vote.
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(dist.coSignerRequired(), "one heartbeat puts the second key back in force");
    }

    /// @notice **Only the co-signer can say it is alive.**
    ///
    /// @dev    If anyone could heartbeat, the keeper would keep the requirement
    ///         "in force" while holding a key nobody is actually watching —
    ///         or, worse, a stranger could hold a dead co-signer's requirement
    ///         up and brick publication for as long as they liked.
    function test_OnlyTheCoSignerHeartbeats() public {
        _name(coSigner);
        vm.prank(stranger);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.heartbeat();
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.heartbeat();

        // And with nobody named, there is nothing to be alive: the slot cannot
        // be written by the zero address either.
        _name(address(0));
        vm.prank(address(0));
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.heartbeat();
    }

    /// @notice **Naming one starts its clock**, so a co-signer that is named and
    ///         never answers lapses on its own rather than bricking the vault
    ///         until a vote lands.
    function test_NamingACoSignerStartsItsGraceImmediately() public {
        _name(coSigner);
        assertTrue(dist.coSignerRequired(), "named: in force at once");
        assertEq(dist.coSignerHeartbeat(), block.timestamp, "and its clock starts now");

        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        assertFalse(dist.coSignerRequired(), "a co-signer that never answers lapses like any other");
    }

    // ---- 4. a co-signer that REFUSES, which the heartbeat does not cover ---

    /// @notice **A hostile second key cannot hold the vault shut.**
    ///
    /// @dev    The heartbeat covers a co-signer that STOPS. It does not cover
    ///         one that keeps beating — so `coSignerRequired()` stays true — and
    ///         signs nothing: publication would then be blocked until the
    ///         timelock removes it, 48 h, ninety-six epochs, which is exactly
    ///         the failure the grace exists to prevent. The grace only ever
    ///         covered SILENCE, and an adversary is not silent.
    ///
    ///         So a veto has to be exercised to be kept: the keeper puts the
    ///         root on the record, and if the same grace passes without it being
    ///         signed, it goes out on one key.
    function test_ACoSignerThatRefusesLosesItsVetoOnThatRoot() public {
        _name(coSigner);
        _pastEpoch(0);

        // It beats, so it is in force — and it signs nothing.
        vm.prank(coSigner);
        dist.heartbeat();
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid");

        // On the record, publicly.
        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
        assertFalse(dist.coSignatureLapsed(0, _root(1), _root(1), bytes32("d")), "not yet: the grace has not run");

        // Still refusing, still beating, three hours later.
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(dist.coSignerRequired(), "it is still nominally in force");
        assertTrue(dist.coSignatureLapsed(0, _root(1), _root(1), bytes32("d")), "but its veto on this root is spent");

        vm.prank(keeper);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid");
        assertEq(dist.activeRoot(), 1, "the vault keeps paying rather than waiting for a vote");
    }

    /// @notice **The lapse is for THAT root and nothing else.**
    ///
    /// @dev    Otherwise the door is worse than the one it closes: put an honest
    ///         root on the record, wait three hours, publish a forged one. The
    ///         key is `rootDigest`, which commits to every field — so waiting out
    ///         the grace buys the right to publish exactly what was shown.
    function test_ALapsedVetoDoesNotCoverAnyOtherRoot() public {
        _name(coSigner);
        _pastEpoch(0);
        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(2), bytes32("d"));
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(coSigner);
        dist.heartbeat();

        // Every field, one at a time.
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(9), _root(2), bytes32("d"), "cid");
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(9), bytes32("d"), "cid");
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(2), bytes32("x"), "cid");

        // And a later epoch is a different root too, so it needs its own wait.
        _pastEpoch(1);
        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(1, _root(1), _root(2), bytes32("d"), "cid");

        // The one that was shown goes through.
        vm.prank(keeper);
        dist.publishRoot(0, _root(1), _root(2), bytes32("d"), "cid");
        assertEq(dist.activeRoot(), 1, "what was put on the record is what may be published");
    }

    /// @notice **Asking again does not move the clock**, so the wait cannot be
    ///         restarted and cannot be shortened.
    function test_TheFirstRequestIsTheOneThatCounts() public {
        _name(coSigner);
        _pastEpoch(0);

        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
        uint256 first = dist.coSignatureRequestedAt(dist.rootDigest(0, _root(1), _root(1), bytes32("d")));

        vm.warp(block.timestamp + 2 hours);
        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
        assertEq(
            dist.coSignatureRequestedAt(dist.rootDigest(0, _root(1), _root(1), bytes32("d"))),
            first,
            "re-asking must not push the clock forward"
        );

        // So the grace is counted from the FIRST ask, and it has now passed.
        vm.warp(block.timestamp + 1 hours + 1);
        assertTrue(dist.coSignatureLapsed(0, _root(1), _root(1), bytes32("d")), "three hours from the first ask");
    }

    /// @notice **Only a keeper may put a root on the record.**
    ///
    /// @dev    A stranger who could would be starting the clock on roots nobody
    ///         is asking for — and, worse, pre-warming the door for a keeper key
    ///         that has not been compromised yet.
    function test_OnlyAKeeperPutsARootOnTheRecord() public {
        _name(coSigner);
        vm.prank(stranger);
        vm.expectRevert(Distributor.NotKeeper.selector);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));

        vm.prank(coSigner);
        vm.expectRevert(Distributor.NotKeeper.selector);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
    }

    /// @notice **THE OTHER ONE THAT MATTERS: the record is a door for a
    ///         compromised keeper too, and the co-signer shuts it.**
    ///
    /// @dev    `requestCoSignature` is the keeper's, so a thief holding that key
    ///         posts their forged root, waits the grace and publishes alone — in
    ///         three hours, while replacing them takes the timelock's
    ///         forty-eight. Without a refusal the anti-veto would have opened a
    ///         path to theft while closing one to blocking.
    ///
    ///         So the one party that knows whether the silence was deliberate
    ///         can say so, and a rejection is final for that root: the keeper's
    ///         answer is a different root, not a second attempt at this one.
    function test_TheCoSignerCanRefuseARootAndThatIsFinal() public {
        _name(coSigner);
        _pastEpoch(0);

        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
        bytes32 key = dist.rootDigest(0, _root(1), _root(1), bytes32("d"));

        vm.prank(coSigner);
        dist.rejectCoSignature(key);

        // Not now, and not after any amount of waiting.
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() * 10);
        vm.prank(coSigner);
        dist.heartbeat();
        assertFalse(dist.coSignatureLapsed(0, _root(1), _root(1), bytes32("d")), "a refusal does not age into a lapse");

        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.publishRoot(0, _root(1), _root(1), bytes32("d"), "cid");

        // Nor can the keeper re-open it by asking again.
        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        assertFalse(dist.coSignatureLapsed(0, _root(1), _root(1), bytes32("d")), "and asking again does not undo it");

        // The remedy is a DIFFERENT root, which the co-signer has not refused.
        // The heartbeat is a FIXTURE line, added 2026-09-12 with the bounds on
        // `requestCoSignature`: the warp above has left the co-signer lapsed, and
        // a clock may only be started against a key that is in force. Nothing
        // this test asserts moved — in that state the keeper does not need the
        // slow door, the single-key form is already open to it.
        vm.prank(coSigner);
        dist.heartbeat();
        vm.prank(keeper);
        dist.requestCoSignature(0, _root(7), _root(7), bytes32("d"));
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        vm.prank(keeper);
        dist.publishRoot(0, _root(7), _root(7), bytes32("d"), "cid");
        assertEq(dist.activeRoot(), 1, "a root it never refused still takes the slow door");
    }

    /// @notice **A refusal answers a request; it cannot precede one.**
    ///
    /// @dev    **Found while writing the second audit plan, in code committed
    ///         hours earlier.** `rejectCoSignature` took any `bytes32` and wrote
    ///         the sentinel, and `requestCoSignature` only ever writes into a
    ///         ZERO slot — so a pre-emptive rejection blocks that root's lapse
    ///         for good. The co-signer can compute the root in advance, because
    ///         replaying the epochs is its entire job, so a hostile one would
    ///         reject the honest root before the keeper asked and the keeper's
    ///         remedy would die before it engaged.
    ///
    ///         The guard does not remove the block — a determined co-signer
    ///         rejects each request as it appears, one per epoch, until the
    ///         timelock removes it, and that was always the accepted trade. What
    ///         it restores is that every refusal is a signed transaction IN
    ///         RESPONSE TO A PUBLIC REQUEST. Rejections posted in advance and in
    ///         bulk are neither attributable nor timely, and telling a second
    ///         key that is BLOCKING from one that is DOWN is the whole reason
    ///         this function exists.
    function test_ACoSignerCannotRejectARootNobodyHasAskedAbout() public {
        _name(coSigner);
        bytes32 key = dist.rootDigest(0, _root(1), _root(1), bytes32("d"));

        vm.prank(coSigner);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.rejectCoSignature(key);

        // And the slot is untouched, so the keeper's request still lands and
        // still starts the clock.
        assertEq(dist.coSignatureRequestedAt(key), 0, "a refused rejection writes nothing");
        _pastEpoch(0);
        vm.prank(keeper);
        dist.requestCoSignature(0, _root(1), _root(1), bytes32("d"));
        assertGt(dist.coSignatureRequestedAt(key), 0, "the remedy is still available");

        // Answering the request is what it may do, and that still works.
        vm.prank(coSigner);
        dist.rejectCoSignature(key);
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        assertFalse(dist.coSignatureLapsed(0, _root(1), _root(1), bytes32("d")), "an answered request stays refused");
    }

    /// @notice **Only the co-signer refuses**, or the keeper would be holding
    ///         its own veto and the whole arrangement would be decorative.
    function test_OnlyTheCoSignerRefuses() public {
        _name(coSigner);
        bytes32 key = dist.rootDigest(0, _root(1), _root(1), bytes32("d"));

        vm.prank(keeper);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.rejectCoSignature(key);

        vm.prank(stranger);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.rejectCoSignature(key);

        vm.prank(timelock);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.rejectCoSignature(key);
    }

    // ---- 5. who may name one ----------------------------------------------

    /// @notice **The second key may not BE the first one.**
    ///
    /// @dev    A co-signer that is the keeper is a second secret held by whoever
    ///         holds the first, and every property in this file would still read
    ///         as satisfied — the signature verifies, the heartbeat beats, the
    ///         requirement is in force, and one compromise takes both.
    ///
    ///         What the contract CANNOT check is the thing that actually matters:
    ///         that the co-signer runs on another host against another node.
    ///         One address is what is visible from here; the rest is custody,
    ///         and `.env.example` and `FLOWS.md` §7.c say so in words because
    ///         words are all that is available.
    function test_TheCoSignerMayNotBeTheKeeper() public {
        vm.prank(timelock);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.setCoSigner(keeper);

        // And from the other side: rotating the keeper ONTO the co-signer
        // collapses the same two roles just as quietly.
        _name(coSigner);
        vm.prank(timelock);
        vm.expectRevert(Distributor.NotCoSigned.selector);
        dist.setKeeper(coSigner);

        // Removal is still a value: zero is not "the keeper".
        vm.prank(timelock);
        dist.setCoSigner(address(0));
        assertEq(dist.coSigner(), address(0), "removing the requirement is not blocked by this guard");
    }

    /// @notice **The timelock names the co-signer, and so may the vault's
    ///         registry** — the same two callers `setKeeper` takes, for the same
    ///         reason: one vault at a time does not scale to a thousand.
    function test_OnlyTheTimelockOrTheRegistryNamesACoSigner() public {
        vm.prank(stranger);
        vm.expectRevert(Distributor.NotTimelock.selector);
        dist.setCoSigner(coSigner);

        vm.prank(keeper);
        vm.expectRevert(Distributor.NotTimelock.selector);
        dist.setCoSigner(coSigner);

        _name(coSigner);
        assertEq(dist.coSigner(), coSigner, "the timelock may");

        // And it may take it away, which is the 48-hour lever the grace exists
        // to make unnecessary in a hurry.
        _name(address(0));
        assertEq(dist.coSigner(), address(0), "and remove it");
        assertEq(dist.coSignerHeartbeat(), 0, "clearing the name clears the clock with it");
        assertFalse(dist.coSignerRequired(), "so nothing is required");
    }
}
