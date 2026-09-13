// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";

/// @notice **`PLAN.md` §8bis Q2 — what `LaunchedToken.deployer` actually gates.**
///
/// @dev    The measurement that decides whether a one-transaction factory is
///         worth its cost. Pons records `msg.sender` as the deployer
///         (`test/Deployer.t.sol`), so such a factory would be the deployer of
///         **every** launch on the platform, for good. Whether that is a
///         concentration worth avoiding depends entirely on what the field can
///         do — and nobody had asked.
///
///         Method: launch a real token with three distinct roles, then call
///         each candidate from each role and record what comes back. A
///         DIFFERENTIAL, because a revert on its own says nothing: it might be
///         access control, or it might be state. What separates them is one
///         role failing where another succeeds on identical calldata.
///
///         The candidates are not guessed. They are the selectors actually
///         present in the factory's deployed bytecode, matched offline against
///         a list of plausible signatures.
contract DeployerPowersTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    address deployer_ = makeAddr("the launching wallet");
    address recipient = makeAddr("the fee recipient");
    address stranger = makeAddr("a stranger");

    address token;
    address owner_;

    function setUp() public {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        if (!f.launchEnabled()) return;
        (, bytes memory o) = FACTORY.staticcall(abi.encodeWithSelector(0x8da5cb5b));
        owner_ = abi.decode(o, (address));

        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "PowerProbe",
            symbol: "POWER",
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: recipient,
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: bytes32(uint256(0x9001))
        });

        // Every read hoisted before the prank: inside `{value: ...}`,
        // `launchFee()` is still a call and would eat it.
        uint256 fee = f.launchFee();
        vm.deal(deployer_, fee + 1 ether);
        vm.prank(deployer_);
        (token,) = f.launchToken{value: fee}(p, 0, address(0));

        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token);
        assertEq(l.deployer, deployer_, "fixture: the launching wallet must be the deployer");
        assertEq(l.creatorFeeRecipient, recipient, "fixture: and the recipient must be someone else");
    }

    /// @dev Calls `data` on the factory as `who` and returns a short verdict.
    function _as(address who, bytes memory data) internal returns (string memory) {
        vm.prank(who);
        (bool ok, bytes memory ret) = FACTORY.call(data);
        if (ok) return "OK";
        if (ret.length >= 4) {
            return string.concat("revert ", vm.toString(bytes4(ret)));
        }
        return "revert (no data)";
    }

    /// @dev The OWNER row is what makes the other three readable. Without it,
    ///      a function that reverts identically for deployer, recipient and
    ///      stranger is ambiguous: it could be gated on a role none of them
    ///      hold, or it could be a STATE check that fires before any role check
    ///      is reached. If the owner passes where the others fail, it is access
    ///      control; if the owner fails the same way, the differential is
    ///      inconclusive on roles and says so rather than pretending.
    function _row(string memory name, bytes memory data) internal {
        console.log(name);
        string memory d = _as(deployer_, data);
        string memory r = _as(recipient, data);
        string memory x = _as(stranger, data);
        string memory o = _as(owner_, data);
        console.log("  from the DEPLOYER :", d);
        console.log("  from the RECIPIENT:", r);
        console.log("  from a STRANGER   :", x);
        console.log("  from the OWNER    :", o);

        // **The property, and the reason this test stays in the suite.**
        // The deployer must fare exactly as a stranger does. The day Pons ships
        // an upgrade that gives the field a power, these two diverge and this
        // line fails — which is the only warning we would get before a factory
        // that owns every launch's deployer slot becomes a concentration.
        assertEq(d, x, string.concat("the deployer gained a power a stranger lacks: ", name));
    }

    function test_WhatTheDeployerFieldCanDo() public {
        if (token == address(0)) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }
        address target = makeAddr("somewhere else");

        _row("setCreatorFeeRecipient(token, elsewhere)", abi.encodeWithSelector(0xe102c9aa, token, target));
        _row("transferCreatorFeeRecipient(token, elsewhere)", abi.encodeWithSelector(0x2931861b, token, target));
        _row("setBuybackEnabled(token, true)", abi.encodeWithSelector(0xb18f1db1, token, true));
        _row("graduate(token)", abi.encodeWithSelector(0xff6d8d05, token));

        // Each `_row` asserts the finding: deployer == stranger, everywhere.
        // Nothing is asserted about WHICH other role wins — that belongs to
        // Pons and may change without concerning us.
    }
}
