// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

interface IPaydCreate {
    function createVault(
        VaultTypes.Allocation[] calldata basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken
    ) external returns (address vault, address distributor);
    function factory() external view returns (address);
}

/// @notice **Can a launch be ONE transaction, signed by the creator's own
///         wallet?** (`PLAN.md` §8bis Q2, reopened 2026-09-27.)
///
/// @dev    The chain accepts EIP-7702 — measured off-test, by publishing a
///         type-4 envelope with an authorization list to chain 4663 and getting
///         `insufficient funds` rather than an unsupported-type error (ArbOS
///         116, consistent with EIP-2537 already being live, `recon.md` §14.1).
///         So the creator's EOA can execute the three calls ITSELF, and
///         `msg.sender` stays the creator for all three: Pons's `deployer`,
///         `FeeVault.LAUNCHER` and `FeeVault.CREATOR` are then the creator's
///         wallet, with none of our code in between.
///
///         What that costs is PREDICTION. A wallet batch carries static
///         calldata, so both addresses have to be known before signing:
///
///           1. the VAULT, because Pons's `creatorFeeRecipient` names it;
///           2. the TOKEN, because `bind` takes it as an argument.
///
///         This file measures whether each one can be computed in advance.
///         Nothing is mocked: the real Pons factory, the real registry.
contract OneTxTest is Test {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant REGISTRY = 0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03;

    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;

    /// @dev The live registry was born at block 61 344 426, after `[profile.ci]`'s
    ///      pin (60 310 000), so under that pin every call to it hits no code.
    ///      This file rolls to its own fixed block rather than move the pin
    ///      every other suite is measured at: 74 350 000, 2026-09-28, the day
    ///      it was written. Bump it deliberately, like the pin.
    function setUp() public {
        vm.rollFork(74_350_000);
    }

    address alice = makeAddr("the creator");
    address bob = makeAddr("another creator");

    function _launchAs(address who, bytes32 salt, string memory sym) internal returns (address token) {
        IPonsLaunch f = IPonsLaunch(PONS);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "OneTxProbe",
            symbol: sym,
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0xFEE),
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: salt
        });
        uint256 fee = f.launchFee();
        vm.deal(who, fee + 1 ether);
        vm.prank(who, who);
        (token,) = f.launchToken{value: fee}(p, 0, address(0));
    }

    /// @notice **What Pons's token address is a function of.** One launch per
    ///         snapshot, so each row differs from the reference in exactly one
    ///         input — an address that changed tells you that input is in the
    ///         derivation, and nothing else can explain it.
    function test_WhatTheTokenAddressDependsOn() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        bytes32 s1 = keccak256("salt one");
        bytes32 s2 = keccak256("salt two");

        uint256 snap = vm.snapshotState();
        address ref = _launchAs(alice, s1, "AAA");
        vm.revertToState(snap);

        address same = _launchAs(alice, s1, "AAA");
        vm.revertToState(snap);
        address otherSender = _launchAs(bob, s1, "AAA");
        vm.revertToState(snap);
        address otherSalt = _launchAs(alice, s2, "AAA");
        vm.revertToState(snap);
        address otherSymbol = _launchAs(alice, s1, "BBB");
        vm.revertToState(snap);

        console.log("reference               ", ref);
        console.log("same inputs again       ", same);
        console.log("another SENDER          ", otherSender);
        console.log("another SALT            ", otherSalt);
        console.log("another SYMBOL          ", otherSymbol);

        // Determinism is the precondition for everything below it: replayed
        // from the same state with the same inputs, the address must repeat.
        assertEq(same, ref, "the token address is not deterministic at all");

        console.log("--- what is in the derivation ---");
        console.log("the sender ?", otherSender != ref);
        console.log("the salt   ?", otherSalt != ref);
        console.log("the symbol ?", otherSymbol != ref);
    }

    /// @notice **CREATE2 or a nonce?** The one measurement that separates them:
    ///         reuse a salt WITHOUT reverting. CREATE2 collides and reverts; a
    ///         nonce-derived address simply moves on.
    function test_WhetherReusingASaltCollides() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        bytes32 s = keccak256("the same salt twice");
        address first = _launchAs(alice, s, "AAA");

        // Deliberately not `expectRevert`: this test REPORTS which of the two
        // Pons does, and pinning it would turn a measurement into a wish.
        IPonsLaunch f = IPonsLaunch(PONS);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "OneTxProbe",
            symbol: "AAA",
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: address(0xFEE),
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: s
        });
        uint256 fee = f.launchFee();
        vm.deal(alice, fee + 1 ether);
        vm.prank(alice, alice);
        (bool ok, bytes memory ret) =
            PONS.call{value: fee}(abi.encodeWithSelector(IPonsLaunch.launchToken.selector, p, uint256(0), address(0)));

        console.log("first token             ", first);
        if (ok) {
            (address second,) = abi.decode(ret, (address, address));
            console.log("the SAME salt again     ", second);
            console.log(">>> a reused salt does NOT collide: the address is not CREATE2(salt) alone.");
        } else {
            console.log(">>> a reused salt REVERTS:", ret.length >= 4 ? vm.toString(bytes4(ret)) : "no data");
            console.log(">>> the address is derived from the salt, and is therefore predictable.");
        }
    }

    /// @notice **The vault's address, before it exists.**
    ///
    /// @dev    `DistributionFactory.create` does `new Bootstrap(...)` (CREATE,
    ///         so the factory's nonce), and `Bootstrap` clones the Distributor
    ///         at its own nonce 1 and the vault at nonce 2. Both are CREATE,
    ///         whose address depends on deployer and nonce alone — never on the
    ///         arguments. So the vault is computable from one public read.
    function test_ThePredictedVaultAddressFromTheFactoryNonce() public {
        address modeFactory = IPaydCreate(REGISTRY).factory();
        uint256 n = vm.getNonce(modeFactory);
        address predictedBootstrap = vm.computeCreateAddress(modeFactory, n);
        address predictedVault = vm.computeCreateAddress(predictedBootstrap, 2);
        address predictedDist = vm.computeCreateAddress(predictedBootstrap, 1);

        VaultTypes.Allocation[] memory basket = new VaultTypes.Allocation[](2);
        basket[0] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);
        basket[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);

        vm.prank(alice, alice);
        (address vault, address dist) = IPaydCreate(REGISTRY).createVault(basket, 9_000, 30 minutes, address(0));

        console.log("the mode factory        ", modeFactory);
        console.log("its nonce               ", n);
        console.log("predicted vault         ", predictedVault);
        console.log("actual vault            ", vault);
        console.log("predicted distributor   ", predictedDist);
        console.log("actual distributor      ", dist);

        assertEq(vault, predictedVault, "the vault address is NOT predictable from the factory's nonce");
        assertEq(dist, predictedDist, "the distributor address is NOT predictable either");
    }

    /// @notice **The question a signed batch actually asks.** The address is
    ///         predicted minutes before the transaction lands, so what matters
    ///         is not that it is deterministic from a fixed state — it is
    ///         whether SOMEBODY ELSE'S launch, slipped in between, moves it.
    ///
    /// @dev    A nonce-derived address would move. A CREATE2 derivation over
    ///         (sender, salt, params) cannot. This is the difference between a
    ///         batch that works and one that reverts whenever the launchpad is
    ///         busy.
    function test_WhetherAnotherLaunchInBetweenMovesOurAddress() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        bytes32 ours = keccak256("ours");
        bytes32 theirs = keccak256("theirs");

        uint256 snap = vm.snapshotState();
        address alone = _launchAs(alice, ours, "AAA");
        vm.revertToState(snap);

        // Two strangers launch first, from a different wallet and a different
        // salt — exactly what a busy block looks like.
        _launchAs(bob, theirs, "BBB");
        _launchAs(bob, keccak256("theirs two"), "CCC");
        address afterOthers = _launchAs(alice, ours, "AAA");

        console.log("ours, alone             ", alone);
        console.log("ours, after two others  ", afterOthers);

        assertEq(afterOthers, alone, "another launch in between MOVED our predicted address");
    }

    /// @notice **Neither the sender's NONCE nor its CODE is in the derivation.**
    ///
    /// @dev    Kept because it was earned. A simulated address and a batched one
    ///         disagreed for what looked like the same sender, salt and params,
    ///         and the two candidate culprits were the nonce a 7702
    ///         authorization consumes and the code it leaves behind. Both are
    ///         ruled out here — and the real cause was a `vm.prank` eaten by a
    ///         `previewLaunchEconomics` read in an argument, so the "plain"
    ///         launch came from the test contract and not from the wallet.
    ///
    ///         What this leaves standing is the useful half: a wallet that has
    ///         been delegated changes nothing about where its launch lands, so
    ///         a creator can be upgraded between the simulation and the
    ///         transaction and the prediction still holds.
    function test_WhetherTheSendersNonceOrCodeMovesTheTokenAddress() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        bytes32 s = keccak256("nonce probe");
        uint256 snap = vm.snapshotState();

        vm.setNonce(alice, 7);
        address atNonce7 = _launchAs(alice, s, "AAA");
        vm.revertToState(snap);

        vm.setNonce(alice, 8);
        address atNonce8 = _launchAs(alice, s, "AAA");
        vm.revertToState(snap);

        // Same nonce, but the wallet now has code — what a 7702 delegation
        // leaves behind.
        vm.setNonce(alice, 7);
        vm.etch(alice, hex"ef0100000000000000000000000000000000000000dead");
        address withCode = _launchAs(alice, s, "AAA");
        vm.revertToState(snap);

        console.log("nonce 7, no code        ", atNonce7);
        console.log("nonce 8, no code        ", atNonce8);
        console.log("nonce 7, WITH code      ", withCode);
        console.log("the sender's NONCE ?", atNonce8 != atNonce7);
        console.log("the sender's CODE  ?", withCode != atNonce7);
    }
}
