// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {IPonsV2LaunchFactory} from "../contracts/interfaces/IExternal.sol";

interface IPonsLaunch {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    function launchToken(TokenParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);

    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function launchFee() external view returns (uint256);
    function launchEnabled() external view returns (bool);
}

/// @notice Launches a token on Pons v2 and binds it to an already-deployed
///         `FeeVault`, in one transaction.
///
///         Used twice: for the REHEARSAL, with a throwaway name and a wallet
///         that is not the real Safe, and for the REAL launch, from the Safe.
///         The only difference is who broadcasts and what the env vars say —
///         which is the point. A rehearsal that runs different code proves
///         nothing about the launch.
///
///         See docs/REHEARSAL.md for the full procedure.
///
/// @dev    `FeeVault.bind` requires `l.deployer == LAUNCHER` — the vault's
///         immutable, set to `SAFE_MULTISIG` at deployment. So whoever
///         broadcasts THIS script must be the address passed as `SAFE_MULTISIG`
///         when `Deploy.s.sol` ran. For a rehearsal, deploy with your own EOA.
contract Rehearsal is Script {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    uint256 constant LAUNCH_CONFIG_ID = 0;
    address constant NATIVE_ETH = address(0);

    /// @notice `PonsV2LaunchAndBuy`, the factory's own `launchForwarder()`.
    ///         Launching THROUGH it puts our first buy inside the launch
    ///         transaction; calling the factory directly leaves the first buy to
    ///         whoever is fastest (docs/recon.md §1.1).
    address constant LAUNCH_FORWARDER = 0xe33E9E479dF8802cb0866d5d05258bEc4cF62948;

    /// @notice The forwarder's launch-and-buy entry point.
    ///
    /// @dev    **Called by selector because its NAME is not public.** The
    ///         explorer will not serve the ABI, 4byte does not know the
    ///         selector, and a dozen plausible names hash to something else. The
    ///         argument layout, however, is certain: it was recovered from our
    ///         own first launch (tx `0x863c566e…`) and re-encoded byte for byte
    ///         against the original calldata.
    ///
    ///             0xf85f8e41(
    ///                 TokenParams params,
    ///                 uint256     launchConfigId,
    ///                 address     pairToken,
    ///                 uint256     buyAmount,      // ETH spent on the first buy
    ///                 uint256     minTokensOut,   // bound on that buy
    ///                 address     recipient,      // who receives them
    ///                 bytes       extra           // empty in ours
    ///             )
    ///             msg.value = launchFee + buyAmount
    bytes4 constant LAUNCH_AND_BUY = 0xf85f8e41;

    function run() external {
        FeeVault vault = FeeVault(payable(vm.envAddress("FEE_VAULT")));
        string memory name_ = vm.envString("TOKEN_NAME");
        string memory symbol_ = vm.envString("TOKEN_SYMBOL");
        uint16 taxBps = uint16(vm.envUint("CREATOR_TAX_BPS"));

        IPonsLaunch factory = IPonsLaunch(PONS_FACTORY);

        require(factory.launchEnabled(), "Pons: launching is closed");

        // `bind` will reject the launch unless the broadcaster is this address.
        // Stated up front so a mismatch reads as a configuration error rather
        // than an opaque `NotOurLaunch()` after the launch fee is spent.
        console.log("must be broadcast by (vault LAUNCHER):", vault.LAUNCHER());

        // Pins the terms we checked. Covers the curve's shape, the graduation
        // threshold AND the fee policy — including `protocolFeeShareBps`, which
        // Pons can raise to 5000 (docs/recon.md §9.5). Without this pin, a
        // change landing between our reading and our transaction would silently
        // reprice the launch instead of reverting it.
        bytes32 economics = factory.previewLaunchEconomics(LAUNCH_CONFIG_ID, NATIVE_ETH);
        console.log("economics digest pinned:");
        console.logBytes32(economics);

        IPonsLaunch.TokenParams memory params = IPonsLaunch.TokenParams({
            name: name_,
            symbol: symbol_,
            logo: vm.envOr("TOKEN_LOGO", string("")),
            description: vm.envOr("TOKEN_DESCRIPTION", string("")),
            // All five, from the environment. The Pons form only ever collected
            // `twitter`, so the first launch sent four empty strings — and the
            // socials live ONLY in this calldata: they are absent from the
            // stored launch record and from the `TokenLaunched` event, so an
            // indexer that shows them has read this transaction. An empty slot
            // is a link that cannot be displayed anywhere, ever.
            socials: IPonsLaunch.Socials({
                twitter: vm.envOr("TOKEN_X", string("")),
                telegram: vm.envOr("TOKEN_TELEGRAM", string("")),
                discord: vm.envOr("TOKEN_DISCORD", string("")),
                website: vm.envOr("TOKEN_WEBSITE", string("")),
                farcaster: vm.envOr("TOKEN_FARCASTER", string(""))
            }),
            // The whole point of the launch: the vault receives the fees, and it
            // is the vault that can claim them (docs/recon.md §1.2).
            creatorFeeRecipient: address(vault),
            creatorTaxBps: taxBps,
            // Otherwise the pre-graduation sweep depends on a Pons operator
            // (docs/recon.md §1.7).
            buybackEnabled: false,
            expectedEconomics: economics,
            salt: bytes32(0)
        });

        uint256 fee = factory.launchFee();

        // The first buy, inside the launch transaction. It is the one buy nobody
        // can get in front of: there is no prior state to sandwich, the token
        // does not exist until the same call creates it.
        uint256 buyAmount = vm.envUint("BUY_AMOUNT_WEI");
        uint256 minTokensOut = vm.envUint("MIN_TOKENS_OUT");
        address buyer = vm.envOr("BUY_RECIPIENT", vault.LAUNCHER());
        require(buyAmount > 0, "BUY_AMOUNT_WEI must be set: launching without a first buy leaves it to the fastest bot");
        require(minTokensOut > 0, "MIN_TOKENS_OUT must be set: never send an unbounded buy");

        console.log("first buy (wei)    ", buyAmount);
        console.log("min tokens out     ", minTokensOut);
        console.log("bought for         ", buyer);

        vm.startBroadcast();

        (address token, address curve) = _launchAndBuy(params, fee + buyAmount, buyAmount, minTokensOut, buyer);

        // Permissionless, but it only accepts a launch whose deployer is our
        // DEPLOYER and whose creatorFeeRecipient is this vault.
        //
        // This is a SECOND transaction, not the same one: forge broadcasts each
        // top-level call on its own. The gap is unreachable from outside — both
        // conditions together mean a third party would have to get our own Safe
        // to launch the token, and the only one that qualifies between the two
        // calls is ours. What keeping them in one run buys is narrower: `bind`
        // is one-shot with no rebind, so if the Safe ever launched a second
        // qualifying token, the wrong one could be latched for good.
        vault.bind(token);

        vm.stopBroadcast();

        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(token);

        console.log("token              ", token);
        console.log("curve              ", curve);
        console.log("creatorFeeRecipient", l.creatorFeeRecipient);
        console.log("deployer           ", l.deployer);
        console.log("creatorTaxBps      ", l.creatorTaxBps);
        console.log("buybackEnabled     ", l.buybackEnabled);
        console.log("pairToken (0 = ETH)", l.pairToken);
        console.log("graduationThreshold", l.graduationThreshold);

        require(l.creatorFeeRecipient == address(vault), "fee recipient is not the vault");
        require(l.pairToken == NATIVE_ETH, "pairToken is not native ETH");
        require(!l.buybackEnabled, "buyback must be disabled");
        require(address(vault.token()) == token, "vault did not bind");

        console.log("");
        console.log("Next: pnpm --filter offchain rehearsal");
    }

    /// @dev Its own frame: `run()` runs out of stack otherwise.
    function _launchAndBuy(
        IPonsLaunch.TokenParams memory params,
        uint256 value,
        uint256 buyAmount,
        uint256 minTokensOut,
        address buyer
    ) internal returns (address token, address curve) {
        (bool ok, bytes memory ret) = LAUNCH_FORWARDER.call{value: value}(
            abi.encodeWithSelector(
                LAUNCH_AND_BUY, params, LAUNCH_CONFIG_ID, NATIVE_ETH, buyAmount, minTokensOut, buyer, bytes("")
            )
        );
        // Surfaces the forwarder's own revert reason rather than a bare false:
        // this call is the launch, and a mute failure here is the worst place
        // in the whole procedure to have to guess.
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("launchAndBuy reverted with no reason");
        }
        (token, curve) = abi.decode(ret, (address, address));
    }
}
