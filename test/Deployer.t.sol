// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPonsLaunch} from "./Launch.t.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";

/// @dev A stand-in for the one-transaction factory we do not have: it does
///      nothing but call `launchToken` from contract code.
contract WouldBeFactory {
    function launch(address factory, address feeRecipient, bytes32 salt) external returns (address token) {
        IPonsLaunch f = IPonsLaunch(factory);
        IPonsLaunch.TokenParams memory p = IPonsLaunch.TokenParams({
            name: "FactoryProbe",
            symbol: "PROBE",
            logo: "",
            description: "",
            socials: IPonsLaunch.Socials("", "", "", "", ""),
            creatorFeeRecipient: feeRecipient,
            creatorTaxBps: 400,
            buybackEnabled: false,
            expectedEconomics: f.previewLaunchEconomics(0, address(0)),
            salt: salt
        });
        (token,) = f.launchToken{value: f.launchFee()}(p, 0, address(0));
    }

    receive() external payable {}
}

/// @notice **The measurement that decides whether a one-transaction factory is
///         possible at all** (`PLAN.md` §8bis Q2).
///
/// @dev    `FeeVault.bind` refuses unless `l.deployer == LAUNCHER`. If Pons
///         records `msg.sender`, a factory that launches on a creator's behalf
///         is recorded as the deployer and the creator's identity is lost —
///         which is the whole reason `bind` checks it. If Pons records
///         `tx.origin`, the creator stays the deployer through a contract call
///         and the factory becomes possible with no change to `bind` at all.
///
///         Nothing here is mocked: the real factory, at the real address.
contract DeployerTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function test_WhatPonsRecordsAsDeployerWhenAContractLaunches() public {
        IPonsLaunch f = IPonsLaunch(FACTORY);
        if (!f.launchEnabled()) {
            console.log("SKIPPED: Pons has closed launching");
            return;
        }

        address eoa = makeAddr("the creator");
        WouldBeFactory fac = new WouldBeFactory();
        uint256 fee = f.launchFee();
        vm.deal(address(fac), fee + 1 ether);

        // msg.sender AND tx.origin are the EOA, so the two candidates are
        // distinct addresses and the answer cannot be read two ways.
        vm.prank(eoa, eoa);
        address token = fac.launch(FACTORY, address(0xFEE), bytes32(uint256(0xC0FFEE)));

        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(FACTORY).getLaunchedToken(token);

        console.log("token          ", token);
        console.log("deployer       ", l.deployer);
        console.log("the contract   ", address(fac));
        console.log("the EOA        ", eoa);
        console.log("pairToken      ", l.pairToken);

        assertTrue(l.exists, "a contract CAN launch on Pons");

        if (l.deployer == address(fac)) {
            console.log(">>> Pons records msg.sender: the FACTORY becomes the deployer.");
            console.log(">>> A one-transaction factory therefore loses `deployer == LAUNCHER`.");
        } else if (l.deployer == eoa) {
            console.log(">>> Pons records tx.origin: the CREATOR stays the deployer.");
            console.log(">>> A one-transaction factory needs no change to bind.");
        } else {
            console.log(">>> Pons records neither. Read the value above before deciding anything.");
        }

        // The assertion is deliberately weak: this test exists to REPORT what
        // Pons does, and pinning it to one answer would turn a measurement into
        // a wish. What it does guard is that a contract can launch at all —
        // if that stops being true, every branch above is moot.
        assertTrue(l.deployer != address(0), "a launch must record some deployer");
    }
}
