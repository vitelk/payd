// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Distributor} from "../contracts/Distributor.sol";
import {CloneBase} from "./CloneBase.sol";

/// @notice **`docs/AUDIT_PLAN_2.md` §1 and §4 — the four escape hatches, taken
///         together rather than one at a time.**
///
/// @dev    Every test here asserts the property that OUGHT to hold, never the
///         behaviour observed. They were written RED against the frozen tree and
///         are green since the fix (`docs/AUDIT_FIXES_2.md`); nothing is gated,
///         because a guard that skips is a guard nobody reads. What each one
///         used to measure is in its own comment, so a regression reports the
///         old number rather than a bare failure.
///
///         The file this one is about is `test/CoSigner.t.sol`, written by the
///         author of the mechanism. What is added here is the composition:
///         `coSigner` set/unset x heartbeat fresh/stale x request
///         absent/pending/lapsed/rejected x the two `publishRoot` overloads,
///         and in particular the cell where a request is made **before the
///         second key exists at all**, which nothing in that file reaches.
contract CoSignerAudit2Test is CloneBase {
    Distributor internal dist;

    address internal feeVault = makeAddr("fee vault");
    address internal timelock = makeAddr("timelock");
    address internal keeper = makeAddr("keeper");

    uint256 internal coSignerPk = 0xC05167;
    address internal coSigner;
    uint256 internal otherPk = 0xB0B;
    address internal other;

    uint256 internal constant LEN = 30 minutes;

    /// @dev secp256k1 group order, for the malleability construction.
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        coSigner = vm.addr(coSignerPk);
        other = vm.addr(otherPk);
        dist = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);
    }

    // ---- helpers -----------------------------------------------------------

    function _name(address who) internal {
        vm.prank(timelock);
        dist.setCoSigner(who);
    }

    function _pastEpoch(uint256 epoch) internal {
        if (block.timestamp <= dist.epochEnd(epoch)) vm.warp(dist.epochEnd(epoch) + 1);
    }

    function _root(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("root", n));
    }

    function _sig(uint256 pk, uint256 epoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest)
        internal
        view
        returns (bytes memory)
    {
        // The digest is resolved into a local BEFORE anything is armed: a getter
        // written as an argument is a call, and `vm.prank`/`vm.expectRevert`
        // attach to the next one (`test/CheatcodeOrder.t.sol`).
        bytes32 h = dist.rootDigest(epoch, claimRoot, pushRoot, digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Publishes on ONE key and reports whether it went through, without
    ///      arming a cheatcode on a line that also reads the contract.
    function _publishAlone(uint256 epoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest)
        internal
        returns (bool ok)
    {
        vm.prank(keeper);
        try dist.publishRoot(epoch, claimRoot, pushRoot, digest, "cid") {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function _publishSigned(uint256 epoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest, bytes memory coSig)
        internal
        returns (bool ok)
    {
        vm.prank(keeper);
        try dist.publishRoot(epoch, claimRoot, pushRoot, digest, "cid", coSig) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function _request(uint256 epoch, bytes32 claimRoot, bytes32 pushRoot, bytes32 digest) internal {
        vm.prank(keeper);
        dist.requestCoSignature(epoch, claimRoot, pushRoot, digest);
    }

    // ---- T2-BANK-01 — the request that predates the key it is addressed to ---

    /// @notice **Asserts the property that OUGHT to hold: naming a co-signer
    ///         closes the single-key path.** After `setCoSigner` and a fresh
    ///         heartbeat, `coSignerRequired()` is true, and no root may go out
    ///         on the keeper's key alone unless the co-signer was given the
    ///         chance to refuse it — which means the request must have been put
    ///         on the record while there WAS a co-signer to put it to.
    ///
    /// @dev    RED reproduces the finding. `requestCoSignature` constrains
    ///         nothing: not `coSigner != 0`, not `coSignerRequired()`, not the
    ///         epoch. A keeper may therefore bank a lapsed request for a root of
    ///         its choosing **while no second key exists** — the state every
    ///         vault is in today, since `Payd.coSigner` is zero at deployment
    ///         and `docs/LAUNCH_2026_12_09.md` §1.1 has the operator naming it
    ///         at launch. `rejectCoSignature` cannot answer a request nobody was
    ///         co-signer for: it reverts for every caller while `coSigner == 0`.
    ///
    ///         `coSignatureLapsed` has no memory of when the second key was
    ///         named, so the banked request stays lapsed for ever. The root it
    ///         names publishes on one key at any later moment, with no fresh
    ///         event — the "slow and loud" the whole mechanism trades for
    ///         ("`Distributor.sol`:203-208") was spent before anyone was
    ///         listening.
    function test_NamingACoSignerClosesTheSingleKeyPathForRootsAskedBeforeIt() public {
        _pastEpoch(2);

        // 1. No second key yet. This is the launch-day state of every vault,
        //    and the state in which `rejectCoSignature` reverts for every
        //    caller — there is nobody holding the role that could refuse.
        assertEq(dist.coSigner(), address(0), "no co-signer yet");
        bytes32 forged = _root(0xF0);

        // **The clock cannot be started at all now.** Before the fix this
        // succeeded, aged three hours with nobody able to answer, and published
        // on one key months later against a co-signer that was named,
        // heartbeating and in force.
        vm.prank(keeper);
        bool banked;
        try dist.requestCoSignature(1, forged, _root(2), _root(3)) {
            banked = true;
        } catch {
            banked = false;
        }
        assertFalse(banked, "no clock may be started against a second key that does not exist");

        // 2. Three hours pass, the protection is switched on, and it is live.
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        _name(coSigner);
        assertTrue(dist.coSignerRequired(), "the second key is in force");

        // 3. Nothing was banked, so nothing has lapsed, and the single-key form
        //    is shut.
        assertFalse(dist.coSignatureLapsed(1, forged, _root(2), _root(3)), "nothing aged while nobody could refuse");
        bool published = _publishAlone(1, forged, _root(2), _root(3));
        assertFalse(published, "a live co-signer must be asked before any root goes out on one key");
    }

    /// @notice The same shape, from the OTHER state where the requirement is not
    ///         in force: a co-signer that has lapsed. Property: recovering the
    ///         heartbeat re-arms the requirement for every root.
    ///
    /// @dev    RED for the same reason. Requests banked during the outage
    ///         survive the recovery, so an operator who watches the heartbeat
    ///         come back has no way to know how many single-key publications
    ///         were armed while it was down.
    function test_ARecoveredHeartbeatReArmsTheRequirementForEveryRoot() public {
        _pastEpoch(2);
        _name(coSigner);

        // The co-signer stops. Past the grace the pinned key publishes alone,
        // which is the designed degradation and is not the problem.
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        assertFalse(dist.coSignerRequired(), "lapsed, by design");

        // **What used to cost one transaction here is now refused.** A request
        // banked during the outage survived the recovery for ever, and the
        // operator watching the heartbeat come back had no view listing what had
        // been armed while it was down. In this state the keeper needs no clock:
        // the single-key form is already open to it.
        bytes32 forged = _root(0xF1);
        vm.prank(keeper);
        bool banked;
        try dist.requestCoSignature(1, forged, _root(2), _root(3)) {
            banked = true;
        } catch {
            banked = false;
        }
        assertFalse(banked, "a clock may not be started while the requirement it lifts is not in force");

        // The host comes back and heartbeats. The requirement is in force again,
        // for every root and not only for the ones nobody thought to bank.
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(dist.coSignerRequired(), "back in force");
        assertFalse(dist.coSignatureLapsed(1, forged, _root(2), _root(3)), "nothing was armed during the outage");

        bool published = _publishAlone(1, forged, _root(2), _root(3));
        assertFalse(published, "a request banked during an outage must not outlive it");
    }

    // ---- T2-COMP-01 — the state space, cell by cell ------------------------

    /// @notice **The composition table.** Every cell where the request was put
    ///         on the record WHILE the co-signer was in force. The cell where it
    ///         was not is `test_NamingACoSignerClosesTheSingleKeyPath...` above,
    ///         and it is the only one that opens.
    ///
    /// @dev    GREEN is the expected result: the rule
    ///         `5-arg accepted <=> !required || lapsed(thisRoot)` and
    ///         `6-arg accepted <=> coSigner != 0 && sig recovers to it`
    ///         holds in each of these cells. Each is a fresh clone, because a
    ///         published root moves `activeRoot` forward and the next cell would
    ///         be refused for the wrong reason.
    function test_TheFourHatchesComposeWithNoCellLeftOpen() public {
        // A: unset x no request x 5-arg -> accepted.
        assertTrue(_cell(false, true, Req.None, false), "A: nobody named, one key publishes");
        // B: unset x no request x 6-arg -> refused (nothing to check against).
        assertFalse(_cell(false, true, Req.None, true), "B: a signature with no co-signer is refused");
        // C: set, fresh x no request x 5-arg -> refused.
        assertFalse(_cell(true, true, Req.None, false), "C: in force, one key is not enough");
        // D: set, fresh x no request x 6-arg -> accepted.
        assertTrue(_cell(true, true, Req.None, true), "D: in force, the co-signed form is the nominal path");
        // E: set, fresh x pending (grace not elapsed) x 5-arg -> refused.
        assertFalse(_cell(true, true, Req.Pending, false), "E: a request that has not aged is not a lapse");
        // F: set, fresh x lapsed x 5-arg -> accepted. The hostile-co-signer hatch.
        assertTrue(_cell(true, true, Req.Lapsed, false), "F: a veto not exercised is a veto lost");
        // G: set, fresh x rejected x 5-arg -> refused, for ever.
        assertFalse(_cell(true, true, Req.Rejected, false), "G: a refusal never ages into a lapse");
        // H: set, STALE heartbeat x no request x 5-arg -> accepted. The deadman.
        assertTrue(_cell(true, false, Req.None, false), "H: a co-signer that stopped does not stop the vault");
        // I: set, STALE heartbeat x no request x 6-arg -> accepted. §1.5: the
        //    co-signed form does not consult the grace, and that is a property:
        //    a key that is alive enough to sign is alive enough to be believed.
        assertTrue(_cell(true, false, Req.None, true), "I: a live signature works even while lapsed");
        // J: set, fresh x rejected x 6-arg -> accepted. A rejection kills the
        //    single-key lapse, not the root: the co-signer may still sign it.
        assertTrue(_cell(true, true, Req.Rejected, true), "J: a rejected root is still co-signable");
    }

    enum Req {
        None,
        Pending,
        Lapsed,
        Rejected
    }

    /// @dev One cell, on its own clone. Returns whether the publication went
    ///      through.
    function _cell(bool named, bool fresh, Req req, bool signed) internal returns (bool) {
        Distributor d = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);
        vm.warp(d.epochEnd(1) + 1);

        bytes32 cr = _root(11);
        bytes32 pr = _root(12);
        bytes32 dg = _root(13);

        if (named) {
            vm.prank(timelock);
            d.setCoSigner(coSigner);
            // One second, because `requestCoSignature` refuses in the block the
            // key was named in — see its own comment. A test warps where a real
            // operator simply sends two transactions.
            vm.warp(block.timestamp + 1);
        }
        if (req != Req.None) {
            vm.prank(keeper);
            d.requestCoSignature(1, cr, pr, dg);
        }
        if (req == Req.Rejected) {
            bytes32 key = d.rootDigest(1, cr, pr, dg);
            vm.prank(coSigner);
            d.rejectCoSignature(key);
        }
        if (req == Req.Lapsed) vm.warp(block.timestamp + d.CO_SIGNER_GRACE() + 1);
        // The heartbeat is the LAST thing set, so a "fresh" cell is fresh even
        // after the warp a lapse needs.
        if (named && fresh) {
            vm.prank(coSigner);
            d.heartbeat();
        }
        if (named && !fresh) vm.warp(block.timestamp + d.CO_SIGNER_GRACE() + 1);

        bytes memory sig;
        if (signed) {
            bytes32 h = d.rootDigest(1, cr, pr, dg);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(coSignerPk, h);
            sig = abi.encodePacked(r, s, v);
        }

        vm.prank(keeper);
        if (signed) {
            try d.publishRoot(1, cr, pr, dg, "cid", sig) {
                return true;
            } catch {
                return false;
            }
        }
        try d.publishRoot(1, cr, pr, dg, "cid") {
            return true;
        } catch {
            return false;
        }
    }

    // ---- T2-ROT-01 — rotation against pending state -------------------------

    /// @notice **Asserts what ought to hold: rotating the second key means the
    ///         NEW key is the one that has to be asked.** A lapse earned against
    ///         A is a refusal A declined to make; B never saw the root and never
    ///         had the three hours the mechanism promises it.
    ///
    /// @dev    RED reproduces §1.2. `rootDigest` does not commit to `coSigner`
    ///         and `coSignatureRequestedAt` is keyed on the root alone, so
    ///         `setCoSigner(B)` clears nothing. The operational consequence is
    ///         the one that matters: rotating a co-signer suspected of being
    ///         compromised or captured does not disarm what it allowed to lapse
    ///         on its watch, and there is no view that lists what is pending.
    function test_ARotationMeansTheNewKeyIsTheOneAsked() public {
        _pastEpoch(2);
        _name(coSigner);
        vm.warp(block.timestamp + 1);

        bytes32 cr = _root(21);
        _request(1, cr, _root(22), _root(23));
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);

        // B takes over. Naming it starts its own grace, so it is in force.
        _name(other);
        assertTrue(dist.coSignerRequired(), "B is in force");

        bool published = _publishAlone(1, cr, _root(22), _root(23));
        assertFalse(published, "B never had the three hours the mechanism promises it");
    }

    // ---- T2-SIG-01 — the signature itself -----------------------------------

    /// @notice Property: every malformed or malleable encoding of a valid
    ///         signature is refused. GREEN rejects the hypothesis.
    ///
    /// @dev    Four constructions, all against a genuinely valid signature by
    ///         the co-signer over the exact root being published:
    ///         the malleable twin `(r, N-s, v^1)`, a `v` outside {27,28}, an
    ///         empty `bytes`, and the 64-byte EIP-2098 compact form. Nothing is
    ///         hard-coded: `N` is the secp256k1 order and the signature comes
    ///         from `vm.sign` over `rootDigest` read off the contract.
    function test_NoMalleableOrMalformedSignaturePublishes() public {
        _pastEpoch(2);
        _name(coSigner);
        bytes32 cr = _root(31);
        bytes32 pr = _root(32);
        bytes32 dg = _root(33);
        bytes32 h = dist.rootDigest(1, cr, pr, dg);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(coSignerPk, h);

        // 1. The malleable twin. Same curve point, the other representation.
        bytes memory malleable = abi.encodePacked(r, bytes32(N - uint256(s)), uint8(v == 27 ? 28 : 27));
        assertFalse(_publishSigned(1, cr, pr, dg, malleable), "the malleable twin is refused");

        // 2. `v` outside {27, 28} — `ecrecover` answers the zero address.
        assertFalse(_publishSigned(1, cr, pr, dg, abi.encodePacked(r, s, uint8(29))), "a bad v is refused");

        // 3. Nothing at all.
        assertFalse(_publishSigned(1, cr, pr, dg, bytes("")), "an empty signature is refused");

        // 4. EIP-2098, 64 bytes: the same signature in another encoding. It must
        //    not be a second accepted form — `Distributor` takes one shape.
        bytes32 vs = bytes32((uint256(v) - 27) << 255 | uint256(s));
        assertFalse(_publishSigned(1, cr, pr, dg, abi.encodePacked(r, vs)), "the compact form is not a second encoding");

        // The positive control, LAST, so the four above cannot pass because the
        // fixture was broken.
        assertTrue(_publishSigned(1, cr, pr, dg, abi.encodePacked(r, s, v)), "the honest signature publishes");
    }

    /// @notice Property: a signature travels to no other root. §1.7 — two
    ///         distinct publications never share a digest.
    ///
    /// @dev    `rootDigest` is `abi.encode` of six STATIC fields, so it is
    ///         injective by construction; this walks the four an attacker
    ///         chooses. Deterministic, not fuzzed: a coverage guard drawn by the
    ///         fuzzer is the fifth trap `docs/AUDIT_PLAN_2.md` §7 names.
    function test_NoTwoDistinctRootsShareADigest() public view {
        bytes32 base = dist.rootDigest(1, _root(1), _root(2), _root(3));
        assertTrue(base != dist.rootDigest(2, _root(1), _root(2), _root(3)), "epoch moves it");
        assertTrue(base != dist.rootDigest(1, _root(9), _root(2), _root(3)), "claimRoot moves it");
        assertTrue(base != dist.rootDigest(1, _root(1), _root(9), _root(3)), "pushRoot moves it");
        assertTrue(base != dist.rootDigest(1, _root(1), _root(2), _root(9)), "digest moves it");
        // The swap that a packed encoding would collide on.
        assertTrue(
            dist.rootDigest(1, _root(1), _root(2), _root(3)) != dist.rootDigest(1, _root(2), _root(1), _root(3)),
            "and the fields do not commute"
        );
    }

    /// @notice Property: a signature does not travel to another Distributor.
    ///         GREEN — `address(this)` is in the preimage.
    function test_ASignatureDoesNotTravelToAnotherDistributor() public {
        _pastEpoch(2);
        Distributor twin = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);
        vm.prank(timelock);
        twin.setCoSigner(coSigner);
        _name(coSigner);

        bytes32 cr = _root(41);
        bytes32 h = dist.rootDigest(1, cr, _root(42), _root(43));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(coSignerPk, h);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(keeper);
        bool ok;
        try twin.publishRoot(1, cr, _root(42), _root(43), "cid", sig) {
            ok = true;
        } catch {
            ok = false;
        }
        assertFalse(ok, "the other Distributor's address is not in this preimage");
    }

    // ---- Axis 4 — an assertion in the NatSpec ------------------------------

    /// @notice `Distributor.heartbeat` says: "**Its own key, and nothing else
    ///         can write this slot.**" (`contracts/Distributor.sol`:601-602.)
    ///         Property asserted: the slot moves only when the co-signer writes
    ///         it.
    ///
    /// @dev    RED. `setCoSigner` writes `coSignerHeartbeat` on every call, so
    ///         the timelock — or the registry, through `Payd.rotateCoSigner` —
    ///         re-arms a lapsed requirement without the second key being alive
    ///         at all. The power is the timelock's, so this is a false sentence
    ///         rather than an open door; it is recorded because the sentence is
    ///         what a reader checks the deadman against, and the deadman is the
    ///         thing keeping a compromised keeper from publishing alone.
    function test_NamingAKeyReArmsTheGraceAndVoidsWhatPrecededIt() public {
        _name(coSigner);
        vm.warp(block.timestamp + 1);
        _pastEpoch(0);

        // A legitimate request, made while the key is in force.
        bytes32 cr = _root(71);
        _request(0, cr, _root(72), _root(73));
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        assertTrue(dist.coSignatureLapsed(0, cr, _root(72), _root(73)), "it aged against the key that was asked");

        // Re-naming the SAME address. The co-signer sends nothing, and both
        // slots move: the grace is re-armed AND every request that preceded the
        // naming is void. The second half is what `coSignerNamedAt` is for.
        uint256 heartbeatBefore = dist.coSignerHeartbeat();
        _name(coSigner);
        assertGt(dist.coSignerHeartbeat(), heartbeatBefore, "naming re-arms the grace without the key speaking");
        assertEq(dist.coSignerNamedAt(), block.timestamp, "and records when this key took the role");
        assertFalse(dist.coSignatureLapsed(0, cr, _root(72), _root(73)), "what preceded the naming is void");
        assertFalse(_publishAlone(0, cr, _root(72), _root(73)), "and it cannot publish on one key");
    }

    // ---- §1.4 — the claim that a request needs no expiry --------------------

    /// @notice `requestCoSignature` says: "No expiry, because none is needed —
    ///         the key commits to `upToEpoch` and `publishRoot` refuses an epoch
    ///         that does not move past the active root, so a request that has
    ///         been overtaken is already dead."
    ///         (`contracts/Distributor.sol`:558-562.)
    ///
    ///         Property asserted: a lapsed request is dead once the roots have
    ///         moved past it.
    ///
    /// @dev    RED, and the reasoning fails on the half nothing constrains:
    ///         `upToEpoch` may name an epoch that has not happened. A request
    ///         for a FUTURE epoch is never overtaken — no root can cover it yet
    ///         — so it lapses, waits, and is publishable on one key the moment
    ///         that epoch closes, however many months later. The `CO_SIGNER-
    ///         Requested` event that was supposed to buy three hours of notice
    ///         was emitted before any of it.
    function test_ALapsedRequestDiesWhenTheRootsMovePastIt() public {
        _pastEpoch(2);
        _name(coSigner);
        vm.warp(block.timestamp + 1);

        // A request naming an epoch that has not happened is refused at the
        // door. It used to be accepted, and it was the half the "already dead"
        // argument was silent about: an epoch no root can cover yet is an epoch
        // no root can overtake, so the request lapsed and waited indefinitely.
        uint256 far = 500;
        bytes32 forged = _root(0xFA);
        vm.prank(keeper);
        bool banked;
        try dist.requestCoSignature(far, forged, _root(52), _root(53)) {
            banked = true;
        } catch {
            banked = false;
        }
        assertFalse(banked, "a clock may not be started on an epoch that has not closed");

        // The cycle runs honestly. Roots move forward, the co-signer signs each.
        for (uint256 e = 1; e <= 3; ++e) {
            _pastEpoch(e);
            vm.prank(coSigner);
            dist.heartbeat();
            bytes memory sig = _sig(coSignerPk, e, _root(100 + e), _root(200 + e), _root(300 + e));
            assertTrue(_publishSigned(e, _root(100 + e), _root(200 + e), _root(300 + e), sig), "honest root");
        }

        // And when that epoch finally closes, nothing was waiting for it.
        vm.warp(dist.epochEnd(far) + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(dist.coSignerRequired(), "the second key is in force throughout");
        assertFalse(dist.coSignatureLapsed(far, forged, _root(52), _root(53)), "nothing aged in the meantime");
        assertFalse(
            _publishAlone(far, forged, _root(52), _root(53)),
            "a request the roots have long passed must not still publish on one key"
        );

        // **And the clock a keeper is entitled to still works**, on a closed
        // epoch, which is what keeps a hostile co-signer from holding the vault
        // shut. Asserted here so the guard above cannot pass by forbidding the
        // remedy as well as the abuse.
        vm.prank(keeper);
        dist.requestCoSignature(far, forged, _root(52), _root(53));
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(
            _publishAlone(far, forged, _root(52), _root(53)), "a veto not exercised on a closed epoch is still lost"
        );
    }

    // ---- §1.3 — who may start the three-hour clock -------------------------

    /// @notice Property asserted: the three-hour clock is started by the
    ///         Distributor's OWN pinned keeper. GREEN rejects it — and the
    ///         result is recorded rather than fixed, because it is the declared
    ///         design (`FLOWS.md` §6, `Payd.allowKeeper` is class (a)).
    ///
    /// @dev    A registry-named publisher can put a root on the record on every
    ///         vault of the registry at once. `allowKeeper` is already declared
    ///         as widening who may award themselves the undelivered balance;
    ///         what this pins is that it also widens who may open the
    ///         three-hour door, which `FLOWS.md` does not say.
    function test_ARegistryNamedPublisherAlsoStartsTheThreeHourClock() public {
        _pastEpoch(2);
        _name(coSigner);
        vm.warp(block.timestamp + 1);

        // A registry that names a second publisher, at the address the vault
        // genuinely designates. Our code, etched, slot 0 written explicitly.
        address registry = makeAddr("registry");
        vm.etch(registry, type(YesKeeper).runtimeCode);
        vm.etch(feeVault, type(VaultWithRegistry).runtimeCode);
        vm.store(feeVault, bytes32(0), bytes32(uint256(uint160(registry))));

        address extra = makeAddr("extra publisher");
        bytes32 cr = _root(61);
        vm.prank(extra);
        dist.requestCoSignature(1, cr, _root(62), _root(63));
        assertGt(dist.coSignatureRequestedAt(dist.rootDigest(1, cr, _root(62), _root(63))), 0, "the clock started");

        // And it runs to a single-key publication by that same address.
        vm.warp(block.timestamp + dist.CO_SIGNER_GRACE() + 1);
        vm.prank(coSigner);
        dist.heartbeat();
        vm.prank(extra);
        dist.publishRoot(1, cr, _root(62), _root(63), "cid");
        assertEq(dist.activeRoot(), 1, "a registry-named publisher takes the slow door like the pinned key");
    }
}

/// @dev A registry that names everybody. OUR code, at an address the vault
///      genuinely points at — nothing about Payd is faked, the contract simply
///      answers the one question `Distributor._registryAllows` asks.
contract YesKeeper {
    function isKeeper(address) external pure returns (bool) {
        return true;
    }
}

/// @dev A vault that answers `REGISTRY()` out of slot 0.
contract VaultWithRegistry {
    address public REGISTRY;
}
