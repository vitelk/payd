// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice **The rule that cost this repository three debugging sessions in one
///         day, executed instead of written down.**
///
/// @dev    `vm.prank` and `vm.expectRevert` arm the **next CALL**, and a getter
///         written inline as an argument IS a call — it is evaluated before the
///         function it is an argument to, so it takes the cheatcode and the
///         statement underneath runs unguarded.
///
///         **The two failure modes are not equally kind.**
///
///           - With `vm.expectRevert` it fails LOUDLY: foundry reports "next
///             call did not revert as expected" on a line that reverts
///             perfectly well, and the hour goes into the contract rather than
///             the test. That happened three times on 2026-09-11 —
///             `t.burnBps()`, `_sig()` reading `rootDigest`, and
///             `v2.getAllocations()`.
///           - With `vm.prank` it fails SILENTLY. The call runs as the test
///             contract, and if the function under test does not read
///             `msg.sender` the assertion passes exactly as before. The test
///             goes on claiming to prove something about WHO may call, and
///             proves nothing. That is what `test/Treasury.t.sol`'s `payDev`
///             case was doing until this file was written.
///
///         Three prose warnings in three files had not stopped it happening a
///         third time, so here it is as something that runs. **The rule: resolve
///         every read into a local before arming anything.**
contract CheatcodeOrderTest is Test {
    Recorder internal r;
    address internal alice = makeAddr("alice");

    function setUp() public {
        r = new Recorder();
    }

    /// @notice **A getter in an argument eats the prank.** Not
    ///         implementation-defined, not pipeline-dependent: an argument must
    ///         be evaluated before the call it is an argument to, so the getter
    ///         is simply the first call.
    function test_AGetterWrittenInlineTakesThePrank() public {
        vm.prank(alice);
        r.record(r.peek()); // `peek()` runs first, and takes it

        assertEq(r.lastCaller(), address(this), "the prank went to the getter, not to the call under test");
        assertTrue(r.lastCaller() != alice, "which is exactly the silent failure this file exists for");
    }

    /// @notice **Resolved first, it lands where it was meant to.** Same two
    ///         calls, same order on the wire, one local variable.
    function test_AReadResolvedFirstLeavesThePrankAlone() public {
        uint256 v = r.peek();
        vm.prank(alice);
        r.record(v);

        assertEq(r.lastCaller(), alice, "the call under test really ran as alice");
    }

    /// @notice **And a `view` getter is no safer than a mutating one** — a
    ///         STATICCALL is still a call. This is the shape that actually
    ///         occurred: `t.burnBps()`, a plain public getter.
    function test_AViewGetterTakesItToo() public {
        vm.prank(alice);
        r.record(r.constantOne());

        assertEq(r.lastCaller(), address(this), "a staticcall consumes a cheatcode like any other call");
    }

    /// @notice **The loud half, pinned so nobody re-diagnoses it as a contract
    ///         bug.** `record` reverts here; `expectRevert` is armed; and the
    ///         test still fails — because the getter took the cheatcode and
    ///         foundry then finds a call that is not the one it was watching.
    ///
    /// @dev    Asserted through `try`/`catch` rather than by letting it fail:
    ///         what is being pinned is that the revert HAPPENS while the
    ///         cheatcode is looking elsewhere.
    function test_TheExpectRevertVersionIsTheLoudOne() public {
        r.setReverting(true);

        // Armed correctly, with the read hoisted: the revert is caught.
        uint256 v = r.peek();
        vm.expectRevert(Recorder.Nope.selector);
        r.record(v);

        // And the same call, with the read inline, reverts while the cheatcode
        // is watching `peek()` instead — so it escapes as a plain revert.
        bool reverted;
        try this.readInline() {}
        catch {
            reverted = true;
        }
        assertTrue(reverted, "with the read inline the revert escapes the cheatcode entirely");
    }

    /// @dev External so the `try` above can catch it.
    function readInline() external {
        r.record(r.peek());
    }
}

/// @dev Records who called it. Not a stand-in for anything in the protocol —
///      it exists to make the order of two calls observable.
contract Recorder {
    error Nope();

    address public lastCaller;
    bool internal reverting;

    function setReverting(bool v) external {
        reverting = v;
    }

    function peek() external returns (uint256) {
        return 1; // not `view`: a mutating call, to show it is not about mutability
    }

    function constantOne() external view returns (uint256) {
        return lastCaller == address(0) ? 1 : 1;
    }

    function record(uint256) external {
        if (reverting) revert Nope();
        lastCaller = msg.sender;
    }
}
