// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";
import {FeeVault} from "../contracts/distribution/FeeVault.sol";

interface IPaydCreate {
    function createVault(
        VaultTypes.Allocation[] calldata basket,
        uint256 rewardsBps,
        uint256 epochLength,
        address intendedToken
    ) external returns (address vault, address distributor);
    function factory() external view returns (address);
    function isVault(address) external view returns (bool);
    function platformBps() external view returns (uint256);
}

/// @notice A batch executor, standing in for the wallet's own.
///
/// @dev    **What it is here to prove is not itself.** A wallet that supports
///         EIP-5792 delegates the account to ITS implementation, not to ours,
///         and substitutes its own executor. What this test measures is the
///         half that is not interchangeable: that Pons, `Payd` and `FeeVault`
///         all accept a 7702-delegated EOA as `msg.sender`, and that the two
///         predicted addresses hold inside one transaction.
///
///         No `receive()`, deliberately — `test_WhatPayCreatorDoesToADelegatedWallet`
///         needs to know what a delegate WITHOUT one costs the creator.
contract BatchExecutor {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    error CallFailed(uint256 index, bytes ret);

    function execute(Call[] calldata calls) external payable returns (bytes[] memory out) {
        out = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
            out[i] = ret;
        }
    }
}

/// @notice The same executor, with the one line that decides whether the
///         creator can be paid afterwards.
///
/// @dev    A 7702 delegation OUTLIVES the launch, so from then on every plain
///         value transfer to the creator's wallet runs this code. A delegate
///         that accepts one is paid directly; one that does not is not payable
///         at all. Real wallets are in the first camp — they have to be, or
///         their users would stop being able to receive ETH — but it is the
///         wallet's choice and not ours, so both are measured.
contract PayableBatchExecutor is BatchExecutor {
    receive() external payable {}
}

/// @notice **The one-transaction launch, end to end, signed by the creator's own
///         wallet** — `PLAN.md` §8bis Q2, settled the other way on 2026-09-27.
///
/// @dev    `test/OneTx.t.sol` measured the three preconditions: the chain takes
///         EIP-7702, Pons's token address is a pure function of inputs we
///         choose, and the vault is `CREATE(CREATE(factory, nonce), 2)`. This
///         file spends them.
///
///         The algorithm is the front end's, exactly: SIMULATE the launch to
///         learn the token's address, throw the simulation away, then send the
///         three calls as one atomic batch built on the predictions. If the
///         predictions were wrong, `bind` reverts and the whole batch with it —
///         which is why `atomicRequired` is not a preference.
contract OneTxLaunchTest is Test {
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant REGISTRY = 0x54c90f5DbBE310F71bc3B10dd87efF284ac63B03;
    address constant QQQ = 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68;
    address constant QQQ_FEED = 0x41ed2c58611790af0760e31e80Bb427e4e83D603;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;

    BatchExecutor exec;
    address creator;
    uint256 creatorPk;

    /// @dev The live registry was born at block 61 344 426, after `[profile.ci]`'s
    ///      pin (60 310 000), so under that pin every call to it hits no code.
    ///      This file rolls to its own fixed block rather than move the pin
    ///      every other suite is measured at: 74 350 000, 2026-09-28, the day
    ///      it was written. Bump it deliberately, like the pin.
    function setUp() public {
        vm.rollFork(74_350_000);
        exec = new BatchExecutor();
        (creator, creatorPk) = makeAddrAndKey("the creator");
    }

    function _basket() internal pure returns (VaultTypes.Allocation[] memory a) {
        a = new VaultTypes.Allocation[](2);
        a[0] = VaultTypes.Allocation(QQQ, 500, 5_000, QQQ_FEED);
        a[1] = VaultTypes.Allocation(NVDA, 500, 5_000, NVDA_FEED);
    }

    function _params(address feeRecipient, bytes32 salt) internal view returns (IPonsLaunch.TokenParams memory) {
        return IPonsLaunch.TokenParams({
            name: "One Transaction",
            symbol: "ONETX",
            logo: "ipfs://logo",
            description: "launched in a single signature",
            socials: IPonsLaunch.Socials("", "", "", "https://paydprotocol.eth.limo", ""),
            creatorFeeRecipient: feeRecipient,
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: IPonsLaunch(PONS).previewLaunchEconomics(0, address(0)),
            salt: salt
        });
    }

    /// @dev The vault the next `create` through the default factory will produce.
    ///      Read from one public number, exactly as the browser reads it.
    function _predictVault() internal view returns (address) {
        address modeFactory = IPaydCreate(REGISTRY).factory();
        return vm.computeCreateAddress(vm.computeCreateAddress(modeFactory, vm.getNonce(modeFactory)), 2);
    }

    function test_ALaunchInOneTransactionFromTheCreatorsOwnWallet() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        bytes32 salt = keccak256("one transaction");
        uint256 fee = IPonsLaunch(PONS).launchFee();
        vm.deal(creator, fee + 1 ether);

        // ---- 1. the two predictions, made BEFORE anything is signed --------
        address predictedVault = _predictVault();

        // The token's address is learnt by SIMULATING the launch and throwing
        // the simulation away — the browser does this with `eth_call`. It is
        // sound because the address depends only on (sender, salt, params),
        // all of which are fixed here (`test/OneTx.t.sol`).
        //
        // `_params` READS the chain (`previewLaunchEconomics`), so it is hoisted
        // out of the pranked call. `vm.prank` attaches to the NEXT CALL, and an
        // argument that makes one eats it — the launch then comes from the test
        // contract, the token address is derived from the wrong sender, and the
        // batch below fails to bind for a reason that has nothing to do with
        // the design. It cost an afternoon; `Launch.t.sol` warns about exactly
        // this above `_buyAs`.
        IPonsLaunch.TokenParams memory p = _params(predictedVault, salt);
        uint256 snap = vm.snapshotState();
        vm.prank(creator, creator);
        (address simulated,) = IPonsLaunch(PONS).launchToken{value: fee}(p, 0, address(0));
        vm.revertToState(snap);
        address predictedToken = simulated;

        // ---- 2. the account delegates to the wallet's implementation -------
        vm.signAndAttachDelegation(address(exec), creatorPk);
        assertGt(creator.code.length, 0, "the delegation did not attach");

        // ---- 3. ONE transaction, three calls ------------------------------
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](3);
        calls[0] = BatchExecutor.Call({
            to: REGISTRY,
            value: 0,
            data: abi.encodeCall(IPaydCreate.createVault, (_basket(), 9_000, 30 minutes, address(0)))
        });
        calls[1] = BatchExecutor.Call({
            to: PONS,
            value: fee,
            data: abi.encodeWithSelector(IPonsLaunch.launchToken.selector, p, uint256(0), address(0))
        });
        calls[2] = BatchExecutor.Call({
            to: predictedVault, value: 0, data: abi.encodeWithSignature("bind(address)", predictedToken)
        });

        vm.prank(creator, creator);
        BatchExecutor(payable(creator)).execute{value: fee}(calls);

        // ---- 4. what the chain now says ----------------------------------
        FeeVault v = FeeVault(payable(predictedVault));
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS).getLaunchedToken(predictedToken);

        console.log("the creator's wallet    ", creator);
        console.log("Pons deployer           ", l.deployer);
        console.log("Pons creatorFeeRecipient", l.creatorFeeRecipient);
        console.log("vault                   ", predictedVault);
        console.log("vault.LAUNCHER          ", v.LAUNCHER());
        console.log("vault.CREATOR           ", v.CREATOR());
        console.log("vault.token             ", address(v.token()));

        // **The whole point, in four lines.** Nothing of ours stands between
        // the creator and their launch: they are the Pons deployer, they are
        // the vault's LAUNCHER and its CREATOR, and the fees arrive.
        assertEq(l.deployer, creator, "Pons did not record the creator as the deployer");
        assertEq(l.creatorFeeRecipient, predictedVault, "the fees are not pointed at the vault");
        assertEq(v.LAUNCHER(), creator, "LAUNCHER is not the creator");
        assertEq(v.CREATOR(), creator, "CREATOR is not the creator");
        assertEq(address(v.token()), predictedToken, "the vault is not bound");
        assertTrue(IPaydCreate(REGISTRY).isVault(predictedVault), "the vault is not in the registry");
        (FeeVault.Hook status,,) = v.hookStatus();
        assertEq(uint256(status), uint256(FeeVault.Hook.Hooked), "the fees do not reach the vault");
    }

    /// @notice **A wrong prediction must cost the launch fee, not the stream.**
    ///
    /// @dev    The vault's address depends on the mode factory's nonce, so
    ///         another launch landing in between moves it. In an atomic batch
    ///         that has to take the whole transaction down — because the
    ///         alternative, `launchToken` landing while `bind` fails, points the
    ///         creator's fees for ever at a vault that is not theirs (Pons:
    ///         three days AND the current recipient's consent to move them).
    function test_AStalePredictionTakesTheWholeBatchDown() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        uint256 fee = IPonsLaunch(PONS).launchFee();
        vm.deal(creator, fee + 1 ether);
        address stale = _predictVault();

        // Somebody else launches through the same factory first: the nonce
        // moves and `stale` is now another creator's vault.
        address other = makeAddr("another creator");
        vm.prank(other, other);
        (address theirs,) = IPaydCreate(REGISTRY).createVault(_basket(), 9_000, 30 minutes, address(0));
        assertEq(theirs, stale, "fixture: the racing launch must take the predicted address");

        IPonsLaunch.TokenParams memory p = _params(stale, keccak256("stale"));
        vm.signAndAttachDelegation(address(exec), creatorPk);
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](3);
        calls[0] = BatchExecutor.Call({
            to: REGISTRY,
            value: 0,
            data: abi.encodeCall(IPaydCreate.createVault, (_basket(), 9_000, 30 minutes, address(0)))
        });
        calls[1] = BatchExecutor.Call({
            to: PONS,
            value: fee,
            data: abi.encodeWithSelector(IPonsLaunch.launchToken.selector, p, uint256(0), address(0))
        });
        calls[2] =
            BatchExecutor.Call({to: stale, value: 0, data: abi.encodeWithSignature("bind(address)", address(0xdead))});

        uint256 before = creator.balance;
        vm.prank(creator, creator);
        vm.expectRevert();
        BatchExecutor(payable(creator)).execute{value: fee}(calls);
        assertEq(creator.balance, before, "the launch fee left the creator on a failed batch");
    }

    /// @notice **What a 7702 wallet costs the creator afterwards, and nobody
    ///         would look for it.**
    ///
    /// @dev    The delegation outlives the launch: the creator's wallet has code
    ///         for good, until they revoke it. `FeeVault._pay` sends the
    ///         creator's residue with `gas: 30_000` and `withdraw()` sends it
    ///         with all the gas there is — but BOTH are plain value transfers,
    ///         so both run the delegate.
    ///
    ///         The differential below is the point. With a delegate that accepts
    ///         value, nothing changes. With one that does not, the residue is
    ///         parked by `_pay` AND `withdraw()` reverts on it — and `CREATOR` is
    ///         immutable, so there is no second address to send it to.
    ///
    ///         **Stuck, not lost, and the distinction is the creator's way out.**
    ///         A 7702 EOA can revoke its own delegation; the account then has no
    ///         code and `withdraw()` goes through. A genuine contract account
    ///         (4337, Safe) has no such exit, which is the case to warn hardest
    ///         about. Either way it is a precondition on the WALLET and not a
    ///         defect in `FeeVault` — and one MetaMask makes impossible to check
    ///         up front on this chain, since it answers `atomic: "ready"` and
    ///         installs the delegate only as the batch lands (`recon.md` §15.2).
    ///         `front/src/atomic.ts` therefore asks before and after.
    function _residueFixture(address impl) internal returns (FeeVault v, uint256 owed) {
        // The creator's share is the RESIDUE, so a fixture that asks for 90 %
        // to holders on top of the platform's cut leaves them exactly nothing —
        // and the assertions below would read as a bug in `payCreator`.
        uint256 rewards = 10_000 - IPaydCreate(REGISTRY).platformBps() - 1_000;
        vm.prank(creator, creator);
        (address vaultAddr,) = IPaydCreate(REGISTRY).createVault(_basket(), rewards, 30 minutes, address(0));
        v = FeeVault(payable(vaultAddr));

        IPonsLaunch.TokenParams memory p = _params(vaultAddr, keccak256("residue"));
        uint256 fee = IPonsLaunch(PONS).launchFee();
        vm.deal(creator, fee + 1 ether);
        vm.prank(creator, creator);
        (address token,) = IPonsLaunch(PONS).launchToken{value: fee}(p, 0, address(0));
        v.bind(token);

        // Delegate only now: the launch itself is not what this test is about.
        vm.signAndAttachDelegation(impl, creatorPk);

        // Credit the escrow and harvest, so `creatorPool` is real money and not
        // a poked storage slot.
        (bool credited,) =
            address(v.ESCROW()).call{value: 1 ether}(abi.encodeWithSignature("credit(address)", vaultAddr));
        assertTrue(credited, "the escrow refused the credit");
        v.harvest();
        owed = v.creatorPool();
        assertGt(owed, 0, "fixture: the creator must be owed something");
    }

    function test_ADelegateThatAcceptsValueIsPaidNormally() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        (FeeVault v, uint256 owed) = _residueFixture(address(new PayableBatchExecutor()));
        uint256 before = creator.balance;
        v.payCreator();

        console.log("owed                    ", owed);
        console.log("received                ", creator.balance - before);
        assertEq(creator.balance - before, owed, "a payable delegate was not paid directly");
        assertEq(v.pendingWithdrawal(creator), 0, "nothing should have been parked");
    }

    function test_ADelegateThatRefusesValueStrandsTheResidue() public {
        if (!IPonsLaunch(PONS).launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        (FeeVault v, uint256 owed) = _residueFixture(address(exec));
        uint256 before = creator.balance;
        v.payCreator();

        // 1. `_pay` cannot get through 30 000 gas into a delegate with no
        //    `receive`, so it parks — which is the behaviour that exists to
        //    stop one bad recipient reverting a harvest.
        assertEq(creator.balance, before, "the refusing delegate was somehow paid");
        assertEq(v.pendingWithdrawal(creator), owed, "the residue was neither paid nor parked");

        // 2. And `withdraw()` cannot rescue it: it is a plain value transfer
        //    too, so it hits the same wall and reverts rather than clearing.
        BatchExecutor.Call[] memory one = new BatchExecutor.Call[](1);
        one[0] = BatchExecutor.Call({to: address(v), value: 0, data: abi.encodeWithSignature("withdraw()")});
        vm.prank(creator, creator);
        vm.expectRevert();
        BatchExecutor(payable(creator)).execute(one);
        assertEq(v.pendingWithdrawal(creator), owed, "withdraw() moved money it could not send");

        console.log("stuck while delegated    ", owed);
        console.log(">>> the app must say so; revoking a 7702 delegation releases it, a contract account cannot.");
    }
}
