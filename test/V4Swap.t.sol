// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20, IPoolManager, IPonsV2LaunchFactory, IPonsV2MemeHookSource} from "../contracts/interfaces/IExternal.sol";

/// @notice **R2, asked of the chain.** Can anyone swap through a graduated Pons
///         pool, or does its hook reserve that for Pons?
///
/// @dev    The hook's permissions are encoded in the low bits of its address —
///         `BEFORE_SWAP` is off, `AFTER_SWAP` and `AFTER_SWAP_RETURNS_DELTA`
///         are on, and every liquidity flag is off. Read that way it says the
///         hook only takes a cut on swaps and gates nothing. This test refuses
///         to take that for an answer and executes the swap.
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

contract V4SwapTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    /// @dev A Pons v2 launch that really graduated (phase 2), paired in native ETH.
    address constant SQUEEZE = 0xD0782C1358E20FF07A4d3b420221D78F3C160485;

    V4Buyer buyer;

    function setUp() public {
        buyer = new V4Buyer();
    }

    /// @notice **Does a price limit BLOCK or does it fill partially?**
    ///
    /// @dev    The whole shape of the graduated burn hangs on this. A floor
    ///         that reverts deadlocks the moment $PLAT's price legitimately
    ///         rises more than the band — and since the reference only updates
    ///         on success, it would stay stuck for ever. A limit that fills
    ///         partially degrades instead: it buys what fits, keeps the rest,
    ///         and the reference walks toward the true price.
    function test_APriceLimitFillsPartiallyRatherThanReverting() public {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(SQUEEZE);
        IPoolManager.PoolKey memory key = IPoolManager.PoolKey({
            currency0: address(0),
            currency1: SQUEEZE,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: IPonsV2MemeHookSource(PONS_FACTORY).memeHook()
        });

        // First, unbounded, to learn where the price lands for 0.05 ETH.
        vm.deal(address(buyer), 10 ether);
        buyer.buy(key, 0.05 ether);
        uint256 fullSpend = buyer.spent();
        assertEq(fullSpend, 0.05 ether, "an unbounded swap must spend everything");

        // The pool's own price, read where v4 keeps it: `_pools` is slot 6 of
        // the PoolManager, and the first word of a pool's state packs
        // `sqrtPriceX96` in its low 160 bits. Probed against the chain rather
        // than taken from a layout document.
        bytes32 poolId = keccak256(abi.encode(key));
        uint256 word = uint256(IExtsload(POOL_MANAGER).extsload(keccak256(abi.encode(poolId, uint256(6)))));
        uint160 spot = uint160(word & ((1 << 160) - 1));
        assertGt(spot, 0, "the pool's price must be readable");

        // Buying token with ETH walks the price DOWN, so a limit just below
        // spot binds almost at once. If v4 reverted here, a limit could not be
        // our safety net and the burn would need a floor that deadlocks.
        V4Buyer tight = new V4Buyer();
        vm.deal(address(tight), 10 ether);
        tight.setLimit(uint160((uint256(spot) * 999) / 1000));
        uint256 got = tight.buy(key, 0.05 ether);

        console.log("with a tight limit: spent", tight.spent(), "for", got);
        assertLt(tight.spent(), 0.05 ether, "a limit must cap the spend, not revert");
        assertEq(address(tight).balance, 10 ether - tight.spent(), "the unspent ETH must stay put");
    }

    /// @notice **R1, asked of the chain.** Can an ordinary contract add
    ///         liquidity to a graduated Pons pool?
    ///
    /// @dev    The hook carries no liquidity flag at all, so read from its
    ///         address it gates nothing. This executes it: swap half the ETH
    ///         for the token, then `modifyLiquidity` with both sides.
    ///
    ///         And it settles the shape of the automatic LP: `modifyLiquidity`
    ///         lives on the PoolManager, so the position belongs to whoever
    ///         calls — keyed by (owner, ticks, salt), with no NFT in between.
    ///         Protocol-owned liquidity that cannot be sold because there is
    ///         nothing to sell.
    function test_AnOrdinaryContractCanAddLiquidityToAGraduatedPool() public {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(SQUEEZE);
        IPoolManager.PoolKey memory key = IPoolManager.PoolKey({
            currency0: address(0),
            currency1: SQUEEZE,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: IPonsV2MemeHookSource(PONS_FACTORY).memeHook()
        });

        vm.deal(address(buyer), 5 ether);
        // One side cannot become a position on its own: half the ETH buys the
        // token first, and whatever the ratio does not consume comes back.
        buyer.buy(key, 1 ether);
        assertGt(IERC20(SQUEEZE).balanceOf(address(buyer)), 0, "the fixture needs both sides");

        uint256 ethBefore = address(buyer).balance;
        uint256 tokBefore = IERC20(SQUEEZE).balanceOf(address(buyer));

        // A range aligned on the pool's tick spacing, around **the tick the
        // pool is at right now** — read, not remembered.
        //
        // This used to centre on a hard-coded 172258, the tick of the day the
        // test was written. The price moved, the range stopped straddling spot,
        // and one side of the position consumed nothing: the test failed with
        // `and the token: 0 <= 0`, which reads like a broken contract and was
        // only a stale constant. Production never had the bug — `Treasury`
        // reads `slot0` — so the test was measuring something the code does not
        // do.
        int24 spacing = l.tickSpacing;
        int24 spot2 = _tick(key);
        int24 mid = (spot2 / spacing) * spacing;
        (uint256 usedEth, uint256 usedTok) = buyer.addLiquidity(key, mid - 20 * spacing, mid + 20 * spacing, 8e20);

        console.log("liquidity added, spent ETH", usedEth, "and token", usedTok);
        assertGt(usedEth, 0, "a position must consume ETH");
        assertGt(usedTok, 0, "and the token");
        assertEq(ethBefore - address(buyer).balance, usedEth, "the ETH must leave");
        assertEq(tokBefore - IERC20(SQUEEZE).balanceOf(address(buyer)), usedTok, "and the token too");
        // The leftover is the point the design has to handle: a ratio never
        // consumes both sides exactly.
        assertGt(address(buyer).balance, 0, "and a remainder stays, as it always will");
    }

    function test_AnyoneCanSwapThroughAGraduatedPonsPool() public {
        IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(SQUEEZE);
        assertEq(l.phase, 2, "fixture must be a graduated launch");
        assertEq(l.pairToken, address(0), "and paired in native ETH");

        IPoolManager.PoolKey memory key = IPoolManager.PoolKey({
            currency0: address(0),
            currency1: SQUEEZE,
            fee: l.poolFee,
            tickSpacing: l.tickSpacing,
            hooks: IPonsV2MemeHookSource(PONS_FACTORY).memeHook()
        });

        vm.deal(address(buyer), 1 ether);
        uint256 before = IERC20(SQUEEZE).balanceOf(address(buyer));
        uint256 got = buyer.buy(key, 0.05 ether);

        console.log("v4 swap: 0.05 ETH ->", got);
        assertGt(got, 0, "a graduated pool must be swappable by an ordinary caller");
        assertEq(IERC20(SQUEEZE).balanceOf(address(buyer)) - before, got, "the tokens must land");
    }

    /// @dev The pool's current tick, from `slot0` — the same word `Treasury`
    ///      reads, and the same slot 6 probed above. `tick` sits in bits
    ///      160..183 as an int24.
    function _tick(IPoolManager.PoolKey memory key) internal view returns (int24) {
        bytes32 poolId = keccak256(abi.encode(key));
        uint256 word = uint256(IExtsload(POOL_MANAGER).extsload(keccak256(abi.encode(poolId, uint256(6)))));
        return int24(uint24((word >> 160) & 0xFFFFFF));
    }
}

/// @dev The v4 dance, minimal: `unlock`, then inside the callback `swap`,
///      `settle` what we owe and `take` what we are owed. Written here rather
///      than in the Treasury because the point is to learn whether it works at
///      all before committing a contract to it.
contract V4Buyer {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    IPoolManager.PoolKey private key;
    uint256 private amountIn;
    uint256 private out;

    function buy(IPoolManager.PoolKey calldata k, uint256 amount) external returns (uint256) {
        key = k;
        amountIn = amount;
        PM.unlock("");
        return out;
    }

    uint160 public limit;
    uint256 public spent;

    function setLimit(uint160 l) external {
        limit = l;
    }

    int24 private tl;
    int24 private tu;
    int256 private ld;
    uint256 public usedEth;
    uint256 public usedTok;
    bool private adding;

    function addLiquidity(IPoolManager.PoolKey calldata k, int24 lower, int24 upper, int256 liquidity)
        external
        returns (uint256, uint256)
    {
        key = k;
        tl = lower;
        tu = upper;
        ld = liquidity;
        adding = true;
        PM.unlock("");
        adding = false;
        return (usedEth, usedTok);
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(PM), "only the PoolManager");
        if (adding) return _add();

        // ETH in, token out: `zeroForOne` because native ETH always sorts as
        // currency0. A negative `amountSpecified` means "exact input".
        int256 delta = PM.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit == 0 ? 4295128740 : limit
            }),
            ""
        );

        // Packed BalanceDelta: amount0 in the high 128 bits, amount1 in the low.
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(int256(uint256(uint128(uint256(delta)))));

        // Negative is what we owe the pool, positive what it owes us.
        if (amount0 < 0) {
            spent = uint256(uint128(-amount0));
            PM.settle{value: spent}();
        }
        if (amount1 > 0) {
            out = uint256(uint128(amount1));
            PM.take(key.currency1, address(this), out);
        }
        return "";
    }

    /// @dev Settling a v4 position: what the delta says we owe, we pay. Native
    ///      ETH goes with the call; an ERC-20 needs `sync`, then a plain
    ///      transfer, then `settle`.
    function _add() internal returns (bytes memory) {
        (int256 delta,) = PM.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams({tickLower: tl, tickUpper: tu, liquidityDelta: ld, salt: 0}), ""
        );
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(int256(uint256(uint128(uint256(delta)))));

        if (amount0 < 0) {
            usedEth = uint256(uint128(-amount0));
            PM.settle{value: usedEth}();
        }
        if (amount1 < 0) {
            usedTok = uint256(uint128(-amount1));
            PM.sync(key.currency1);
            IERC20(key.currency1).transfer(address(PM), usedTok);
            PM.settle();
        }
        return "";
    }

    receive() external payable {}
}
