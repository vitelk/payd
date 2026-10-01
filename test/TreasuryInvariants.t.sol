// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {Treasury} from "../contracts/Treasury.sol";

/// @notice Drives the Treasury at random. Every call is wrapped in a `try`: an
///         invalid sequence must not stop the campaign, it must simply change
///         nothing.
contract TreasuryHandler is Test {
    Treasury public t;
    address public immutable DEV;

    uint256 public callsSplit;
    uint256 public callsPay;
    uint256 public received;
    /// @dev What the exits actually MOVED, taken from their return values. The
    ///      balance of `dev` cannot be used for this: Foundry funds the accounts
    ///      it picks as fuzz senders, and it is pickable, so its balance measures
    ///      the fuzzer as much as the contract.
    uint256 public paidOut;

    // ---- diagnostic probes ---------------------------------------------
    /// @dev The Treasury's balance as the handler left it. Any gap observed AT
    ///      THE START of a call arrived WITHOUT going through us.
    uint256 public lastSeen;
    /// @dev The running total of those arrivals. Non-zero = somebody else is
    ///      funding the contract, and the invariant measures that somebody rather
    ///      than the contract.
    uint256 public unaccounted;

    modifier observed() {
        uint256 before = address(t).balance;
        if (before > lastSeen) unaccounted += before - lastSeen;
        _;
        lastSeen = address(t).balance;
    }

    constructor(address dev) {
        DEV = dev;
    }

    function setTreasury(Treasury t_) external {
        require(address(t) == address(0), "already wired");
        t = t_;
    }

    receive() external payable {}

    /// @dev A vault paying its platform share, or anyone donating. Both land
    ///      the same way, and `_split` measures the BALANCE rather than
    ///      trusting a parameter — which is the property worth fuzzing.
    function pay(uint96 amount) external observed {
        // The floor is not cosmetic. `payDev` refuses below `MIN_MOVE`
        // (0.005 ETH), so a payment of a few wei splits into pockets that can
        // never pay out — and a whole campaign can then run without once
        // exercising an exit. That is exactly what `afterInvariant` caught the
        // first time this file ran: 720 calls, and the guard failed with "the
        // exits saw nothing".
        //
        // 0.05 ETH stays the floor even though the LP pocket no longer has an
        // exit of its own: it is the smallest payment whose SMALLEST pocket (a
        // sixth) still clears `MIN_MOVE`, which is what keeps `payDev` reachable
        // on every draw rather than most of them.
        uint256 a = bound(uint256(amount), 0.05 ether, 30 ether);
        if (address(this).balance < a) return;
        (bool ok,) = address(t).call{value: a}("");
        if (ok) received += a;
    }

    function doSplit() external observed {
        try t.split() {
            ++callsSplit;
        } catch {}
    }

    function doPayDev() external observed {
        try t.payDev() returns (uint256 amount) {
            paidOut += amount;
            ++callsPay;
        } catch {}
    }

    function warp(uint32 dt) external observed {
        vm.warp(block.timestamp + bound(uint256(dt), 1, 2 days));
        vm.roll(block.number + 1);
    }
}

/// @notice **The money contract, fuzzed.** `Distributor` had a campaign and the
///         `Treasury` did not — the one that holds four pockets of ETH and
///         hands them to four immutable destinations.
///
///         The example-based tests prove the intended sequences work. These
///         look for the ones nobody imagined: a donation mid-cycle, a payout
///         between two splits, a split on an empty balance.
/// forge-config: default.invariant.runs = 12
/// forge-config: default.invariant.depth = 60
/// forge-config: default.invariant.fail-on-revert = false
contract TreasuryInvariants is StdInvariant, Test {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    Treasury internal t;
    TreasuryHandler internal h;
    address internal dev = makeAddr("dev");

    function setUp() public {
        h = new TreasuryHandler(dev);
        // The platform vault is frozen at the constructor. So the campaign names
        // nothing, and has nothing to name: none of the functions drawn below
        // takes a destination as an argument.
        t = new Treasury(
            Treasury.Wiring({
                timelock: makeAddr("timelock"),
                devWallet: dev,
                generationKey: makeAddr("generation key"),
                predecessor: address(0),
                ponsFactory: PONS_FACTORY,
                poolManager: POOL_MANAGER,
                router: ROUTER,
                v3Factory: V3_FACTORY,
                weth: WETH,
                pivot: USDG,
                pivotWethFee: 100
            }),
            Treasury.Seed(new address[](0), new uint24[](0), new uint24[](0))
        );
        h.setTreasury(t);
        vm.deal(address(h), 500 ether);

        bytes4[] memory sels = new bytes4[](4);
        sels[0] = TreasuryHandler.pay.selector;
        sels[1] = TreasuryHandler.doSplit.selector;
        sels[2] = TreasuryHandler.doPayDev.selector;
        sels[3] = TreasuryHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
        targetContract(address(h));
        // **The Treasury is not a sender, and leaving it as one makes the
        // fuzzer the thing being measured.** Foundry draws its senders from a
        // dictionary containing the addresses seen in storage -- the Treasury's
        // is one of them -- and it FUNDS the one it draws. Its balance then grows
        // by ~0.25 ETH that never went through `pay`, and the invariant reads
        // that money as an accounting hole.
        //
        // This is exactly the mistake the comment on
        // `invariant_EverythingPaidInIsHeldOrWasPaidOut` describes for `dev` and
        // it had been fixed on the ACCOUNTS side and left open on the CONTRACT
        // side. One campaign in twelve draws passed, one in fifty failed.
        excludeSender(address(t));
    }

    /// @notice **The pockets never promise more than the contract holds.** If
    ///         this falls, one of the four exits can be paid with another
    ///         pocket's money.
    function invariant_PocketsAreCovered() public view {
        assertGe(
            address(t).balance,
            t.devPool() + t.burnPool() + t.lpPool() + t.rewardsPool(),
            "the pockets promise more than the balance"
        );
    }

    /// @notice `_split` computes `balance - booked`, so a balance BELOW what is
    ///         booked would underflow and brick every action at once. The
    ///         invariant above forbids it; this one names the failure so a
    ///         breakage is read in one line instead of a stack trace.
    function invariant_SplitNeverUnderflows() public {
        try t.split() returns (uint256) {}
        catch {
            assertTrue(false, "split() reverted: balance fell below the booked pockets");
        }
    }

    /// @notice **Everything that entered the Treasury is either still there,
    ///         or left through its one ETH exit, `payDev`.**
    ///
    /// @dev    Both sides are measured on the CONTRACT — what was paid in, what
    ///         it still holds, and what its own functions returned as moved.
    ///         No account balance appears here, and that is the point.
    ///
    ///         Two earlier versions failed, both for the same reason and
    ///         neither because of the contract. The first compared against the
    ///         500 ETH dealt in `setUp` and read 500,282; the second dropped
    ///         that but still summed the destinations' balances, and drifted
    ///         by 0,284 ETH. **Foundry funds the accounts it picks as fuzz
    ///         senders**, and every address the harness names is pickable — so
    ///         any invariant reading a balance is reading the fuzzer too.
    function invariant_EverythingPaidInIsHeldOrWasPaidOut() public view {
        // **The probe that cost twenty minutes the first time.** A gap here says
        // the ETH arrived BETWEEN two handler calls -- so it is not the contract
        // that moved, it is the test bench. It names the failure instead of
        // leaving it to be guessed from two large numbers differing by 0.25.
        assertEq(h.unaccounted(), 0, "ETH arrived without going through the handler");
        assertEq(
            h.received(),
            address(t).balance + h.paidOut(),
            "ETH entered the Treasury and is neither held nor accounted as paid out"
        );
    }

    /// @notice Coverage guard. Foundry evaluates invariants from setup onwards,
    ///         so a coverage assertion there would always fail; `afterInvariant`
    ///         runs once. Without it, a broken harness gives a green campaign
    ///         that exercised nothing — the most insidious failure of fuzzing.
    function afterInvariant() public view {
        assertGt(h.received(), 0, "the fuzzer never funded: worthless campaign");
        assertGt(h.callsSplit(), 0, "nothing was ever split");
        assertGt(h.callsPay(), 0, "no pocket ever paid out: the exits saw nothing");
    }
}
