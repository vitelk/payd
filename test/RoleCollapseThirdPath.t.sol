// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {CloneBase} from "./CloneBase.sol";

/// @notice **The third path to the role collapse was `Payd.allowKeeper`, and
///         this file is the regression that keeps it shut.**
///
/// @dev    `Payd.setKeeper` and `Payd.setCoSigner` both refuse `RoleCollapse`,
///         and `Distributor.setKeeper` / `setCoSigner` refuse it again from the
///         other side. All four compare against ONE address: the Distributor's
///         pinned `keeper`. None of them looks at `Payd.isKeeper`, the
///         registry-wide set `allowKeeper` writes — and `Distributor._publish`
///         accepts `msg.sender != keeper && _registryAllows(msg.sender)`.
///
///         So `allowKeeper(coSigner, true)` — one timelock call with a
///         plausible operational motive ("let the second node publish during an
///         outage") — handed ONE secret both roles on EVERY vault of the
///         registry at once, with `coSignerRequired()` still reading `true` and
///         the published root recorded as co-signed. `docs/AUDIT_PAYD.md` F-1.
///
///         The property asserted is the one the four existing guards exist to
///         hold: a root must never be producible by a single secret while a
///         second key is named and in force. The refusal that holds it is in
///         `Payd`, in both orders of the same two calls — so this file drives
///         the real registry rather than the state it used to produce. What the
///         guard does NOT reach is recorded below, in its own test, because a
///         guard sold as complete is worse than one whose edge is written down.
///
///         No fork: an empty `Seed` and a zero `Genesis.launcher` make the
///         constructor read nothing off the chain.
contract RoleCollapseThirdPathTest is CloneBase {
    Payd internal pad;
    DistributionFactory internal factory;
    Distributor internal dist;

    address internal feeVault = makeAddr("fee vault");
    address internal timelock = makeAddr("timelock");
    address internal keeper = makeAddr("keeper");

    uint256 internal coSignerPk = 0xC05167;
    address internal coSigner;

    uint256 internal constant LEN = 30 minutes;

    function setUp() public {
        coSigner = vm.addr(coSignerPk);
        dist = _cloneDistributor(feeVault, timelock, keeper, block.timestamp, LEN);

        factory = new DistributionFactory();
        pad = new Payd(
            Payd.Wiring({
                timelock: timelock,
                platform: makeAddr("treasury"),
                keeper: keeper,
                coSigner: address(0),
                escrow: makeAddr("escrow"),
                ponsFactory: makeAddr("pons factory"),
                router: makeAddr("router"),
                v3Factory: makeAddr("v3 factory"),
                weth: makeAddr("weth"),
                pivot: makeAddr("pivot"),
                ethPivotFee: 100,
                ethUsdFeed: makeAddr("eth/usd"),
                generationKey: makeAddr("generation key"),
                factory: address(factory)
            }),
            1_000,
            Payd.Seed(
                new address[](0),
                new uint24[](0),
                new address[](0),
                new address[](0),
                new uint24[](0),
                new uint24[](0),
                new uint256[](0)
            ),
            Payd.Genesis(address(0), 0, 0, new VaultTypes.Allocation[](0))
        );
    }

    /// @notice Property: the registry cannot be made to name one secret as both
    ///         the publisher and the second key, by either order of the two
    ///         calls that could do it.
    function test_TheRegistryKeeperSetIsNotAThirdPathToTheRoleCollapse() public {
        // 1. The second key is named on the registry. Every indicator green.
        vm.prank(timelock);
        pad.setCoSigner(coSigner);
        assertEq(pad.coSigner(), coSigner, "the second key is the registry's default");

        // 2. Naming that same address an additional publisher is the collapse,
        //    and it is refused. One call, `onlyTimelock`, and the motive is
        //    entirely plausible — which is why the contract has to be the thing
        //    that says no.
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.RoleCollapse.selector, coSigner));
        pad.allowKeeper(coSigner, true);
        assertFalse(pad.isKeeper(coSigner), "and nothing was written");

        // 3. The other order of the same two calls, which is the half that
        //    lives on `setCoSigner`: an address the registry ALREADY publishes
        //    for cannot then become the second key.
        address second = makeAddr("second node");
        vm.prank(timelock);
        pad.allowKeeper(second, true);
        assertTrue(pad.isKeeper(second), "a genuine extra publisher is still admitted");
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Payd.RoleCollapse.selector, second));
        pad.setCoSigner(second);
        assertEq(pad.coSigner(), coSigner, "and the co-signer did not move");

        // 4. **Unnaming stays legal whoever the address is.** `allowed &&` in
        //    the guard is what makes this pass: a refusal that also refused the
        //    withdrawal would turn one mistake into a permanent one.
        vm.prank(timelock);
        pad.allowKeeper(coSigner, false);
        assertFalse(pad.isKeeper(coSigner), "the co-signer can always be un-named");

        // 5. And zero is still what removes the requirement from future vaults:
        //    `isKeeper[address(0)]` is false, so the new guard cannot catch it,
        //    and `allowKeeper` refuses zero on its own line.
        vm.prank(timelock);
        pad.setCoSigner(address(0));
        assertEq(pad.coSigner(), address(0), "the requirement can still be removed");
    }

    /// @dev The positive control: the same call from the pinned keeper, with the
    ///      co-signer's signature, is the NOMINAL path and must go through.
    ///      Without this the test above would pass on a contract that refuses
    ///      every publication.
    function test_ControlTheNominalTwoKeyPathStillPublishes() public {
        vm.prank(timelock);
        dist.setCoSigner(coSigner);
        vm.prank(coSigner);
        dist.heartbeat();

        uint256 epoch = 1;
        bytes32 claimRoot = keccak256("honest claim");
        bytes32 pushRoot = keccak256("honest push");
        bytes32 digest = keccak256("honest digest");
        vm.warp(dist.epochEnd(epoch) + 1);
        bytes32 h = dist.rootDigest(epoch, claimRoot, pushRoot, digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(coSignerPk, h);

        vm.prank(keeper);
        dist.publishRoot(epoch, claimRoot, pushRoot, digest, "cid", abi.encodePacked(r, s, v));
        assertEq(dist.activeRoot(), 1, "two keys, one root");
    }

    /// @notice **The edge of the guard, recorded rather than sold.** The
    ///         refusal above compares against `Payd.coSigner`, the registry's
    ///         DEFAULT. A Distributor whose co-signer was set by hand — a
    ///         direct `Distributor.setCoSigner`, which only refuses the pinned
    ///         keeper — is outside that comparison, and nothing downstream
    ///         catches it: `_publish` asks the registry whether the sender is a
    ///         publisher and `publishRoot` asks only that the signature recover
    ///         to `coSigner`, never that the two are different parties.
    ///
    /// @dev    GREEN rejects this, and the result is recorded rather than
    ///         fixed: it is the same approximation `Payd.setKeeper` has always
    ///         made (`docs/AUDIT_PAYD.md` F-1, last paragraph). Two timelock
    ///         calls on two contracts, not one, and `allowKeeper` is already
    ///         class (a) in `FLOWS.md` §6 for what it lets an address publish.
    ///         The day a Distributor-side guard is wanted, this is the test
    ///         that inverts.
    function test_TheGuardIsTheRegistrysAndACoSignerSetByHandIsOutsideIt() public {
        // A second key that is the vault's own, not the registry's default.
        vm.prank(timelock);
        dist.setCoSigner(coSigner);
        vm.prank(coSigner);
        dist.heartbeat();
        assertTrue(dist.coSignerRequired(), "the second key is in force");
        assertTrue(pad.coSigner() != coSigner, "and it is not the registry's default");

        // So `allowKeeper` has nothing to compare it against, and admits it.
        vm.prank(timelock);
        pad.allowKeeper(coSigner, true);
        assertTrue(pad.isKeeper(coSigner), "the registry names it, and cannot know better");

        // A registry that names exactly that address, at the address the vault
        // genuinely designates. OUR code, slot 0 written explicitly.
        address registry = makeAddr("registry");
        vm.etch(registry, type(NamesTheCoSigner).runtimeCode);
        vm.store(registry, bytes32(0), bytes32(uint256(uint160(coSigner))));
        vm.etch(feeVault, type(VaultWithRegistry).runtimeCode);
        vm.store(feeVault, bytes32(0), bytes32(uint256(uint160(registry))));
        assertTrue(NamesTheCoSigner(registry).isKeeper(coSigner), "the registry names it");
        assertFalse(NamesTheCoSigner(registry).isKeeper(keeper), "and names nobody else");

        // One secret, both roles: the co-signer signs the digest and sends the
        // transaction itself. The pinned keeper key is never used.
        uint256 epoch = 1;
        bytes32 claimRoot = keccak256("forged claim");
        bytes32 pushRoot = keccak256("forged push");
        bytes32 digest = keccak256("forged digest");
        vm.warp(dist.epochEnd(epoch) + 1);
        bytes32 h = dist.rootDigest(epoch, claimRoot, pushRoot, digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(coSignerPk, h);

        vm.prank(coSigner);
        dist.publishRoot(epoch, claimRoot, pushRoot, digest, "cid", abi.encodePacked(r, s, v));
        assertEq(dist.activeRoot(), 1, "a hand-set co-signer is outside the registry's comparison");
    }
}

/// @dev A registry that names exactly one address, out of slot 0. OUR code, at
///      the address the vault genuinely designates — nothing about `Payd` is
///      faked, it answers the one question `Distributor._registryAllows` asks.
contract NamesTheCoSigner {
    address public named;

    function isKeeper(address who) external view returns (bool) {
        return who == named;
    }
}

/// @dev A vault that answers `REGISTRY()` out of slot 0.
contract VaultWithRegistry {
    address public REGISTRY;
}
