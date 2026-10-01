// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Payd} from "../contracts/Payd.sol";
import {BackingFactory} from "../contracts/backing/BackingFactory.sol";
import {BackingRedeemer} from "../contracts/backing/BackingRedeemer.sol";
import {LotteryFactory} from "../contracts/lottery/LotteryFactory.sol";
import {LotteryDistributor} from "../contracts/lottery/LotteryDistributor.sol";
import {TontineFactory} from "../contracts/tontine/TontineFactory.sol";
import {PortfolioFactory} from "../contracts/portfolio/PortfolioFactory.sol";
import {PortfolioVault} from "../contracts/portfolio/PortfolioVault.sol";
import {PortfolioDistributor} from "../contracts/portfolio/PortfolioDistributor.sol";
import {DistributionFactoryV3} from "../contracts/distribution/v3/DistributionFactoryV3.sol";

/// @notice The four SECONDARY payout modes' factories — backing, lottery,
///         tontine, portfolio — and the two governance calls that admit each
///         one.
///
///   PAYD=0x… FACTORY_V3=0x… forge script script/DeployPayoutModes.s.sol \
///       --sig "backing()" --rpc-url $RPC_URL --broadcast
///
///   …the same with `--sig "lottery()"`, `--sig "tontine()"` and
///   `--sig "portfolio()"`.
///
///      Without --verify: the explorer sits behind Cloudflare and 403s a
///      scripted request. Verify by hand, with --show-standard-json-input.
///
/// @dev  **One file, four entrypoints, because the four deployments differ in
///       one line each.** What they share is everything that matters — the
///       shared implementations, the two-key admission, and the rule that a
///       secondary mode is admitted with `enableFactory` and NEVER `setFactory`
///       — and four copies of that is four places for it to drift.
///
///       **`FACTORY_V3` is where the implementations come from, and that is the
///       point.** Backing, lottery and tontine clone the SAME deployed
///       `FeeVaultV2`: the first two change where the stocks go, the third
///       changes only how the off-chain root is built, and none of them
///       changes how a basket is bought. Reading the impls off the live V3
///       factory rather than passing them by hand means the address that ends
///       up in a new mode's immutable is, provably, the one the default mode
///       is already running — a typo here would otherwise deploy a second
///       `FeeVaultV2` that behaves identically and shares nothing, and nobody
///       would notice for months.
///
///       **The portfolio is the exception, and it takes `FACTORY_V3` for one
///       value only.** It buys no basket at all, so it shares no vault: it
///       deploys its own `PortfolioVault` (built on `contracts/modes/
///       BaseModeVault`) and its own `PortfolioDistributor`. What it still
///       reads off the live factory is `EXCLUDED_AT_BIRTH`, and it requires
///       the match — a mode that seeded a different locker would pay an
///       address that cannot claim.
///
///       **Deploying admits NOTHING.** A factory sitting on-chain is inert
///       until the generation Ledger calls `Payd.approve` and the timelock
///       calls `Payd.enableFactory` 48 h later — two keys, in that order,
///       `approved` being checked at execution and not at scheduling. The
///       calldata for both is printed below so a third party can recompute it
///       from this repository. When one lands, `FLOWS.md` §6 is the file to
///       update.
contract DeployPayoutModes is Script {
    /// @dev What the live V3 factory is wired to. Read, never assumed: these
    ///      five values are immutables on it, so one `cast call` by anybody
    ///      reproduces what this script passed.
    struct Shared {
        address vaultImpl;
        address distImpl;
        address legsImpl;
        address poolManager;
        address excludedAtBirth;
    }

    function _shared() internal view returns (Shared memory s, address payd) {
        payd = vm.envAddress("PAYD");
        // **The deployed factory's own type, and not a type that happens to
        // answer the same selectors.** This read went through `TontineFactory`
        // for one commit because the five getters share their selectors — it
        // compiled, it returned the right values, and it said that the address
        // at `FACTORY_V3` was a tontine factory. Anything relying on a selector
        // collision is correct until the day one of the two sides renames a
        // getter, and then it is wrong with no compiler to say so.
        DistributionFactoryV3 f = DistributionFactoryV3(vm.envAddress("FACTORY_V3"));
        s = Shared(f.VAULT_IMPL(), f.DIST_IMPL(), f.LEGS_IMPL(), f.POOL_MANAGER(), f.EXCLUDED_AT_BIRTH());
        require(s.vaultImpl != address(0), "FACTORY_V3 has no VAULT_IMPL: wrong address");
        console.log("shared FeeVaultV2 impl  ", s.vaultImpl);
        console.log("shared DistributorV3    ", s.distImpl);
        console.log("shared V2Legs impl      ", s.legsImpl);
        console.log("PoolManager             ", s.poolManager);
        console.log("excluded at birth       ", s.excludedAtBirth);
        console.log("");
    }

    /// @dev The check that says "this is a NEW mode", and it is the opposite of
    ///      the one `DeployModeV3.s.sol` makes. V3 is a new VERSION of the
    ///      default mode, so its `MODE` must MATCH — that match is what lets a
    ///      vault migrate to it. These three are new modes, so a match would
    ///      mean a vault could migrate between two contracts that pay by
    ///      entirely different rules with no generation key involved, which is
    ///      exactly what `crossModeMigration` exists to forbid.
    function _admit(address payd, address factory, bytes32 mode, string memory modeData) internal view {
        require(mode != bytes32(0), "MODE is zero: Payd.enableFactory would revert BadMode");
        require(
            mode != Payd(payd).factoryMode(address(Payd(payd).factory())),
            "MODE must DIFFER from the default factory's: this is a new mode, not a new version"
        );
        console.log("factory                 ", factory);
        console.log("MODE                    ", vm.toString(mode));
        console.log("");
        console.log("1. generation Ledger -> Payd.approve");
        console.log("   to  ", payd);
        console.log("   data", vm.toString(abi.encodeCall(Payd.approve, (factory, true))));
        console.log("");
        console.log("2. Safe proposes -> Timelock -> Payd.enableFactory (48 h)");
        console.log("   to  ", payd);
        console.log("   data", vm.toString(abi.encodeCall(Payd.enableFactory, (factory))));
        console.log("");
        console.log("   enableFactory and NOT setFactory: a secondary mode is REACHABLE,");
        console.log("   never the default. createVault keeps building the distribution mode.");
        console.log("");
        console.log("Then launch under it with Payd.createVaultWith(", factory, ", ...)");
        console.log("modeData:", modeData);
    }

    /// @notice Burn-to-redeem. The token is the claim ticket, so there is no
    ///         root, no keeper on the money path and no epoch a holder has to
    ///         know about — only a `BackingRedeemer` implementation to deploy
    ///         beside the shared vault.
    function backing() external returns (BackingFactory factory) {
        (Shared memory s, address payd) = _shared();

        vm.startBroadcast();
        address redeemerImpl = address(new BackingRedeemer());
        factory = new BackingFactory(s.vaultImpl, redeemerImpl);
        vm.stopBroadcast();

        console.log("BackingRedeemer impl    ", redeemerImpl);
        _admit(payd, address(factory), factory.MODE(), "EMPTY - this mode has no per-launch parameter");
    }

    /// @notice A pot and one winner per draw, settled by a drand beacon nobody
    ///         can know at publication time. `POT_BPS` is the per-launch
    ///         parameter AND the per-draw blast radius, which is why the
    ///         factory refuses an empty `modeData`.
    function lottery() external returns (LotteryFactory factory) {
        (Shared memory s, address payd) = _shared();

        vm.startBroadcast();
        address distImpl = address(new LotteryDistributor());
        factory = new LotteryFactory(s.vaultImpl, distImpl);
        vm.stopBroadcast();

        console.log("LotteryDistributor impl ", distImpl);
        _admit(payd, address(factory), factory.MODE(), "abi.encode(uint256 potBps), bounded [500, 5000]");
        console.log("");
        console.log("The keeper needs nothing new configured: it reads the mode from the");
        console.log("registry. The CO-SIGNER does - it must be running a build with");
        console.log("POST /sign-draw, or every draw waits out CO_SIGNER_GRACE.");
    }

    /// @notice Diamond hands: an unclaimed share is forfeited on a sale and
    ///         redistributed to the holders who stayed.
    ///
    /// @dev    **The only mode here that deploys no implementation at all.**
    ///         The rule is entirely off-chain — it is which `WindowAccrual`
    ///         builds the root — so a tontine vault is a `FeeVaultV2` and a
    ///         `DistributorV3`, byte for byte the ones the default mode
    ///         already runs, and the factory exists only to stamp a different
    ///         `MODE` on them. The five arguments are asserted against V3's
    ///         rather than merely passed, because "byte for byte" is the whole
    ///         claim and this is where it could quietly stop being true.
    function tontine() external returns (TontineFactory factory) {
        (Shared memory s, address payd) = _shared();

        vm.startBroadcast();
        factory = new TontineFactory(s.vaultImpl, s.distImpl, s.legsImpl, s.poolManager, s.excludedAtBirth);
        vm.stopBroadcast();

        require(factory.VAULT_IMPL() == s.vaultImpl, "tontine vault impl is not V3's");
        require(factory.DIST_IMPL() == s.distImpl, "tontine distributor impl is not V3's");
        require(factory.LEGS_IMPL() == s.legsImpl, "tontine legs impl is not V3's");
        require(factory.EXCLUDED_AT_BIRTH() == s.excludedAtBirth, "tontine birth exclusion is not V3's");
        console.log("no new implementation - V3's, verbatim");
        _admit(payd, address(factory), factory.MODE(), "same as V3: abi.encode(burnBps, lpBps), or empty");
    }

    /// @notice Personal portfolio: the creator posts a default basket, each
    ///         holder may declare their own — **freely, over any stock the
    ///         platform allows** — and each is paid in theirs automatically.
    ///
    /// @dev    **Unlike the tontine it deploys two implementations of its own.**
    ///         This is the one mode whose vault is not `FeeVaultV2`: it buys no
    ///         basket at all, so it is built on `contracts/modes/BaseModeVault`
    ///         and its `payout()` converts the holders' share into the PIVOT and
    ///         stops. What each holder ends up holding is decided at DELIVERY,
    ///         by `PortfolioDistributor` reading `PortfolioBook` — one swap per
    ///         batch of holders who want the same stock.
    ///
    ///         Every vault this factory builds also gets a `PortfolioBook`,
    ///         deployed in the launch's own transaction, which holds the rows.
    ///
    ///         **What to read before signing: this mode adds NO key and moves
    ///         NO seat.** The book holds no money and has no privileged
    ///         function; the timelock of both halves is the platform's, as in
    ///         every other mode. The weight a conversion uses is READ from the
    ///         book inside `distributeInto`, never taken from the keeper's
    ///         call, so the worst a compromised keeper can do is convert what a
    ///         holder actually asked for, sooner or later than they hoped.
    ///         `FLOWS.md` §6 states the blast radius in full.
    function portfolio() external returns (PortfolioFactory factory) {
        (Shared memory s, address payd) = _shared();
        // `_shared` has just printed three implementations this mode does not
        // clone. Said out loud, because a log that lists them right above two
        // freshly deployed ones invites exactly the wrong conclusion.
        console.log("this mode shares no VAULT with the three above: it buys no basket.");
        console.log("It does share the V2Legs impl - a portfolio launch can carry the same");
        console.log("burn and locked-LP legs V3 and the tontine carry - plus EXCLUDED_AT_BIRTH.");
        console.log("");

        vm.startBroadcast();
        address vaultImpl = address(new PortfolioVault());
        address distImpl = address(new PortfolioDistributor());
        factory = new PortfolioFactory(vaultImpl, distImpl, s.legsImpl, s.poolManager, s.excludedAtBirth);
        vm.stopBroadcast();

        require(factory.EXCLUDED_AT_BIRTH() == s.excludedAtBirth, "portfolio birth exclusion is not V3's");
        console.log("PortfolioVault impl     ", vaultImpl);
        console.log("PortfolioDistributor    ", distImpl);
        console.log("plus one PortfolioBook per launch, deployed by the factory");
        _admit(payd, address(factory), factory.MODE(), "same as V3: abi.encode(burnBps, lpBps), or empty for no legs");
        console.log("");
        console.log("The keeper needs nothing new configured: it reads the mode from the");
        console.log("registry, calls payout() where it would call buyBasket(), and settles");
        console.log("each batch with distributeInto(). The vault's TIMELOCK() is");
        console.log("Payd.TIMELOCK like every other mode's - this one moves no seat.");
    }
}
