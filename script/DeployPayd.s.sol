// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Timelock} from "../contracts/Timelock.sol";
import {Treasury} from "../contracts/Treasury.sol";
import {Payd} from "../contracts/Payd.sol";
import {DistributionFactory} from "../contracts/DistributionFactory.sol";
import {Collector} from "../contracts/Collector.sol";
import {Allowlist} from "./Allowlist.s.sol";
import {Quotelist} from "./Quotelist.s.sol";
import {Bootstrap} from "../contracts/Bootstrap.sol";
import {FeeVault} from "../contracts/FeeVault.sol";
import {Distributor} from "../contracts/Distributor.sol";
import {DeployPaydVault} from "./DeployPaydVault.s.sol";
import {VaultTypes} from "../contracts/interfaces/VaultTypes.sol";

/// @notice Deploys the registry: one Timelock, one Treasury, one Payd —
///         and, inside the Payd's constructor, the two implementations
///         every future vault clones.
///
///   forge script script/DeployPayd.s.sol --rpc-url $RPC_URL --broadcast
///
///      Without --verify: the explorer sits behind Cloudflare and 403s a
///      scripted request. Verify by hand, with --show-standard-json-input.
///
/// @dev **This deploys the platform, and it opens it.** No token is launched —
///      that is the Safe's own step on Pons, and `docs/PAYD_RUNBOOK.md`
///      runs the sequence in order. But the two allowlists ARE written here, in
///      the Payd's constructor, from `Allowlist` and `Quotelist`: a
///      platform deployed with empty lists is a platform that refuses every
///      basket while looking open, and the timelock guards changes to those
///      lists, not their initial state.
///
///      **And $PAYD's vault is born here, BEFORE the Treasury.** It used to be a
///      separate script, and the order was the other way round. It changed for a
///      substantive reason: the Treasury's rewards pocket -- a third of
///      everything that enters it -- went to an address NAMED after the fact, and
///      any verification done at that point reads a contract the caller may have
///      written themselves. It is now an `immutable`, which requires the vault to
///      exist first.
///
///      **And the cycle is cut instead of being predicted.** Three immutables
///      hold hands -- Payd -> Treasury -> vault -> Payd -- and a cycle of three
///      does not deploy in one stroke. The first version of this script PREDICTED
///      the two missing addresses from the deployer's nonce. That does not work at
///      this level, and the test showed it: in a Foundry script the creator of the
///      `new`s is the script contract in simulation and the EOA at broadcast, so
///      the simulated and deployed addresses are not the same. `Bootstrap` makes
///      its prediction INSIDE a contract, where creator and nonce are identical on
///      both sides; here there is no contract.
///
///      **So we cut it by having the vault born INSIDE the registry's
///      constructor**, where `address(this)` is known. $PAYD's vault is therefore
///      the registry's first vault, like any other: it knows its `REGISTRY` from
///      birth, it appears in `vaults()` and in the front end's index, and
///      `migrate` recognises it through `isVault` alone.
///
///      All that is left for the Treasury is to be wired afterwards, under TWO
///      KEYS -- `approvePlatform` by the Ledger, `bindPlatform` by the timelock.
///      That waits on nothing: this contract is EMPTY at genesis, it only fills
///      with the platform shares of THIRD-PARTY launches, and $PAYD's vault pays
///      its holders without ever going through it.
///
///      The two immutables that designate where money goes -- `Payd.PLATFORM`
///      and `FeeVault.PLATFORM` -- stay written at birth, with no setter.
///
///      Every external address below was read on-chain and dated in
///      `docs/recon.md` and `docs/recon-launchpad.md`. None is assumed.
contract DeployPayd is Script {
    /// @dev The two measured lists, taken where they are written rather than
    ///      copied here: `Allowlist` and `Quotelist` are already the files the
    ///      runbook has re-read, and a third copy would be the first to
    ///      diverge.
    function _seed() internal returns (Payd.Seed memory) {
        (address[] memory stocks, uint24[] memory stockFees, address[] memory feeds) = new Allowlist().listings();
        (address[] memory quotes, uint24[] memory qFees, uint24[] memory qWethFees, uint256[] memory minBuys) =
            new Quotelist().quotes();
        return Payd.Seed(stocks, stockFees, feeds, quotes, qFees, qWethFees, minBuys);
    }

    /// @dev **The Treasury's sweep list is DERIVED from the quote list, not
    ///      measured again.** A vault pays its platform share in its own
    ///      currency, so the currencies that can land in the Treasury are
    ///      exactly the ones a vault may be quoted in — and the pool each one
    ///      converts through is the pool its quote route already declares,
    ///      measured for depth and for a live 30-minute window by
    ///      `test_EveryQuoteRoute*`. A second hand-written list would be a
    ///      second thing to keep in step, and the first to drift.
    ///
    ///      The mapping is the route read backwards:
    ///        - the PIVOT itself leaves directly, through `ETH_PIVOT_FEE`;
    ///        - a quote with a `token/PIVOT` tier leaves through the pivot;
    ///        - a quote reached through WETH (COIN, cbBTC) leaves the way it
    ///          came, on that same `token/WETH` pool.
    ///
    ///      **Seeded at birth**, like `Payd.Seed`: the 48 hours protect changes,
    ///      not the initial state. Without it the Treasury spends its first two
    ///      days able to be paid in forty currencies and to spend none of them.
    function _sweeps() internal returns (Treasury.Seed memory) {
        (address[] memory quotes, uint24[] memory qFees, uint24[] memory qWethFees,) = new Quotelist().quotes();
        uint24[] memory wethFees = new uint24[](quotes.length);
        uint24[] memory pivotFees = new uint24[](quotes.length);
        for (uint256 i; i < quotes.length; ++i) {
            if (quotes[i] == USDG) {
                wethFees[i] = ETH_PIVOT_FEE;
            } else if (qFees[i] != 0) {
                pivotFees[i] = qFees[i];
            } else {
                wethFees[i] = qWethFees[i];
            }
        }
        return Treasury.Seed(quotes, wethFees, pivotFees);
    }

    // --- Pons v2 (docs/recon.md §1.1)
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    // --- Uniswap (docs/recon.md §3, docs/recon-launchpad.md)
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    // --- Chainlink (docs/recon.md §5)
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    /// @notice The `WETH/USDG` tier -- the last welded pool on the money path,
    ///         $2.7 M deep (`docs/recon.md` §4.1). Every ETH-quoted vault
    ///         crosses it, the detour of a quote with no pivot pool crosses it,
    ///         and now the Treasury's sweep crosses it in the other direction.
    uint24 constant ETH_PIVOT_FEE = 100;

    /// @notice The platform's cut of what reaches a child vault: 10 %.
    ///
    /// @dev    Set at construction and changeable only through the timelock,
    ///         capped at `MAX_PLATFORM_BPS` (1 500) by BOTH the Payd and
    ///         the vault — the second check is what makes the cap real, since a
    ///         vault trusts nothing the Payd tells it.
    ///
    ///         It applies to NEW vaults. An existing vault carries the rate it
    ///         was born with, in storage, and no one can raise it afterwards.
    uint256 constant PLATFORM_BPS = 1_000;

    /// @notice $PAYD's vault: 81.09 % to the holders, nothing to the platform.
    ///
    /// @dev    **The split follows where the money comes from** (docs/recon.md
    ///         438). At `creatorTaxBps = 300` the vault collects 3.70 % of
    ///         volume: the 3.00 % creator tax, which Pons pays us in full, plus
    ///         0.70 % — our 70 % of the 1 % curve fee, Pons keeping 0.30 % of
    ///         volume whatever the tax is. 8 109 is the ratio that hands the
    ///         holders exactly the tax (3.00 %) and leaves the creator exactly
    ///         the curve share (0.70 %).
    ///
    ///         **It is 8 109 and not 8 108 because the division is integer.**
    ///         `economics()` computes `(370 * rewardsBps) / 10000` in bps of
    ///         volume, so 8 108 lands on 299 -- 2.99 % to holders, 0.71 % to the
    ///         creator -- and 8 109 on 300. The exact ratio 3.00/3.70 is
    ///         8 108.108..., which no integer reaches; [8 109, 8 135] all give
    ///         300/70 and the low end is the closest to it. The suite caught
    ///         this: `test_TheWholeOfP7` and
    ///         `test_TheWholeEveningWithoutASingleDelay` read the split off
    ///         `economics()` rather than recomputing it, which is why one bps
    ///         could not slip through.
    ///
    ///         It replaced 8 649 on 2026-09-12, before the broadcast. That
    ///         value targeted a round creator residue — 50 bps of volume,
    ///         "8 648 would give 51" — which is a tidy number rather than a
    ///         line anyone can explain to a holder. It also paid the creator
    ///         0.50 % instead of 0.70 %, 28.6 % less.
    ///
    ///         **It only turns one way.** `FeeVault.setRewardsBps` refuses
    ///         `bps <= from`, so the holders' share can be raised from the Safe
    ///         at any time and never lowered. Being born at 8 108 keeps 8 649
    ///         reachable; being born at 8 649 would not.
    uint256 constant PAYD_REWARDS_BPS = 8_109;
    uint256 constant PAYD_EPOCH = 30 minutes;

    /// @dev Proposers = the Safe. Executors = `address(0)`, which OpenZeppelin
    ///      reads as "anyone": the Safe decides, anybody executes once the 48 h
    ///      have run, so nobody can hold a made decision hostage by staying
    ///      silent. Its own function for the stack, not for taste.
    function _timelock(address safe) internal returns (Timelock) {
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        return new Timelock(proposers, executors);
    }

    /// @dev The four addresses the deployer brings, grouped because `run` has no
    ///      room left in the stack for four more locals.
    struct Keys {
        address safe;
        address dev;
        address keeper;
        /// @dev **The second authority, and it is only useful kept apart.** A
        ///      Ledger held separately from the Safe's signers: it holds
        ///      nothing, signs nothing else, and can do NOTHING on its own. It
        ///      approves, the timelock executes. On the same hardware as the
        ///      Safe, it would add nothing but code.
        address generation;
    }

    function run()
        external
        returns (Timelock timelock, Treasury treasury, Payd pad, Collector col, FeeVault vault, Distributor dist)
    {
        Keys memory k = Keys({
            safe: vm.envAddress("SAFE_MULTISIG"), // timelock proposer
            dev: vm.envAddress("DEV_ADDRESS"), // the dev pocket's only exit
            keeper: vm.envAddress("KEEPER_ADDRESS"), // hot key, holds nothing but gas
            generation: vm.envAddress("GENERATION_KEY") // cold, separate from the Safe
        });
        require(k.generation != k.safe, "the generation key must not be the Safe");
        // **Two exits reach the maintainer, so they need two addresses.**
        // `Treasury.payDev` pays `DEV_WALLET`, and the platform vault's
        // `payCreator` pays its `LAUNCHER`, which is the Safe. There used to be a
        // third, `withdrawLp` to an `LP_SAFE`; it was deleted rather than
        // narrowed. Collapsed onto one address, the two that remain become one
        // line of accounting and the question "how many doors lead to you?" stops
        // having a one-sentence answer. Distinct, they are two ledgers an indexer
        // separates without being told how.
        require(k.dev != k.safe, "the dev pocket must not be the timelock's proposer");

        VaultTypes.Allocation[] memory basket = new DeployPaydVault().allocations();

        vm.startBroadcast();

        // 1. The timelock, shared by the whole platform.
        timelock = _timelock(k.safe);

        // 2. The factory. It carries the two implementations every launch
        //    clones -- 40 of the 54 kilobytes `Payd` weighed when it did that
        //    work itself.
        DistributionFactory factory = new DistributionFactory();

        // 3. The Treasury. **Before the registry**, whose immutable `PLATFORM`
        //    it is -- and that is why it has no setter.
        //
        //    It is born without knowing who receives its rewards pocket: that
        //    vault does not exist yet, it will come out of the registry at the
        //    next step. The two keys name it afterwards, once. That costs
        //    nothing: this contract is EMPTY at genesis, it only fills with the
        //    platform shares of third-party launches.
        treasury = new Treasury(
            Treasury.Wiring({
                timelock: address(timelock),
                devWallet: k.dev,
                generationKey: k.generation,
                predecessor: address(0), // the first one has no predecessor
                ponsFactory: PONS_FACTORY,
                poolManager: POOL_MANAGER,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                pivotWethFee: ETH_PIVOT_FEE
            }),
            _sweeps()
        );

        // 4. The registry, **and $PAYD's vault inside its constructor**.
        //
        //    The seed is taken out into a local only so the closing printout can
        //    say how many rows actually went in. It said "the allowlist is
        //    EMPTY" for as long as `_seed()` has been filling it, which is the
        //    failure this one line exists to stop repeating.
        //
        //    This is what closes the cycle of the three immutables without
        //    predicting anything: `address(this)` is known in there, so the
        //    vault knows its registry from birth like all the others.
        Payd.Seed memory seed = _seed();
        pad = new Payd(
            Payd.Wiring({
                timelock: address(timelock),
                platform: address(treasury),
                keeper: k.keeper,
                coSigner: vm.envOr("COSIGNER_ADDRESS", address(0)),
                escrow: ESCROW,
                ponsFactory: PONS_FACTORY,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                ethPivotFee: ETH_PIVOT_FEE,
                ethUsdFeed: ETH_USD,
                generationKey: k.generation,
                factory: address(factory)
            }),
            PLATFORM_BPS,
            seed,
            Payd.Genesis({launcher: k.safe, rewardsBps: PAYD_REWARDS_BPS, epochLength: PAYD_EPOCH, basket: basket})
        );
        vault = FeeVault(payable(pad.platformVault()));
        dist = Distributor(payable(pad.platformDistributor()));

        // 5. The Collector: the router that claims several launches in one
        //    transaction. Stateless and without powers.
        col = new Collector();

        // Wired, and verified rather than assumed.
        require(pad.PLATFORM() == address(treasury), "registry not wired to the treasury");
        require(vault.REGISTRY() == address(pad), "the platform vault must know its registry");
        require(vault.PLATFORM_BPS() == 0, "the platform token must not tax itself");
        require(vault.LAUNCHER() == k.safe, "the Safe must be the one who launches");
        require(pad.GENERATION_KEY() == k.generation, "registry has no generation key");
        require(treasury.GENERATION_KEY() == k.generation, "treasury has no generation key");
        require(address(pad.factory()) == address(factory), "registry not wired to the factory");

        vm.stopBroadcast();

        console.log("FACTORY     ", address(factory));
        console.log("TIMELOCK    ", address(timelock));
        console.log("PAYD_VAULT  ", address(vault));
        console.log("DISTRIBUTOR ", address(dist));
        console.log("TREASURY    ", address(treasury));
        console.log("REGISTRY   ", address(pad));
        console.log("VAULT_IMPL  ", factory.VAULT_IMPL());
        console.log("DIST_IMPL   ", factory.DIST_IMPL());
        console.log("KEEPER      ", pad.keeper());
        console.log("CO-SIGNER   ", pad.coSigner());
        // **Loud, because the failure is silent otherwise.** A mistyped env var
        // name deploys a single-key platform while every indicator reads normal,
        // which is the T2-REG-01 class: the protection turned off in the
        // direction that does not announce itself. `setCoSigner` afterwards is
        // `onlyTimelock` behind 48 h and reaches no vault already minted, so the
        // genesis vault would stay single-key until a `rotateCoSigner` lands.
        if (pad.coSigner() == address(0)) {
            console.log("!! COSIGNER_ADDRESS was not set: this platform is SINGLE-KEY.");
            console.log("!! One key publishes roots and takes totalFunded - totalDistributed.");
            console.log("!! Fixing it costs setCoSigner + rotateCoSigner, both onlyTimelock, 48 h.");
        }
        console.log("PLATFORM_BPS", pad.platformBps());
        console.log("");
        console.log("STILL TO DO, and it takes BOTH keys:");
        console.log("  1. GENERATION_KEY  -> TREASURY.approvePlatform($PAYD, PAYD_VAULT)");
        console.log("  2. TIMELOCK (48 h) -> TREASURY.bindPlatform($PAYD, PAYD_VAULT)");
        console.log("  wires the buyback, the liquidity and the rewards pocket. $PAYD's");
        console.log("  vault pays its holders without waiting on any of it.");
        console.log("COLLECTOR   ", address(col));

        console.log("");
        // **What this block said until 2026-09-12 was the opposite of the
        // truth.** It sent the operator to `script/Allowlist.s.sol` and 48 h of
        // timelock for a list the constructor has been writing since `_seed()`
        // landed — so the night it matters, the operator schedules a no-op and
        // concludes the platform is shut when it is open. The counts are read
        // back off the seed rather than written here, so the next change to
        // either list cannot make this printout wrong again.
        console.log("The allowlist is SEEDED, in the constructor, both lists:");
        console.log("  stocks listed ", seed.stocks.length);
        console.log("  quotes listed ", seed.quotes.length);
        console.log("createVault works NOW, on any basket drawn from those stocks.");
        console.log("script/Allowlist.s.sol and script/Quotelist.s.sol are the");
        console.log("SOURCES the constructor read: running them against a live");
        console.log("registry ADDS to the lists, and takes the timelock's 48 h.");
        console.log("");
        console.log("The one thing not yet done is the two-key platform binding");
        console.log("printed above: approvePlatform, then bindPlatform. Until it");
        console.log("lands the Treasury holds third-party shares it cannot spend.");
        console.log("See docs/PAYD_RUNBOOK.md.");
        console.log("");
        console.log("COLLECTOR goes into front/src/config.ts. Unowned, stateless,");
        console.log("holds nothing: it can be redeployed at any time.");
    }
}
