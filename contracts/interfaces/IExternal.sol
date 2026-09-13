// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/*//////////////////////////////////////////////////////////////////////////
  External interfaces. Every signature below was read from a source verified
  on-chain on Robinhood Chain (chainId 4663) on 2026-09-03.
  References and addresses: docs/recon.md §1.1, §1.2, §3.1.
//////////////////////////////////////////////////////////////////////////*/

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice The token launched on Pons v2 (`PonsV2LauncherToken`). A typed
///         handle, nothing more: the vault only ever needs its address.
interface IPonsV2LauncherToken is IERC20 {}

/// @notice `V2FeeEscrow` — 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
/// @dev    `claim()` reads `_balances[msg.sender]`: ONLY the recipient can
///         claim. That is why FeeVault has to be the `creatorFeeRecipient`.
interface IPonsV2FeeEscrow {
    function claim() external returns (uint256 amount);
    function balanceOf(address recipient) external view returns (uint256);

    /// @notice The SAME ledger, kept per ERC-20. A launch quoted in something
    ///         other than native ETH pays its creator fee here — at the same
    ///         rate, measured in `test/PairToken.t.sol` — and `claim()` cannot
    ///         see a wei of it.
    ///
    /// @dev    Read from the deployed escrow, `docs/recon.md` §1.1. Same
    ///         `msg.sender` rule as `claim()`: only the recipient can claim.
    function claimToken(address token) external returns (uint256 amount);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

/// @notice `PonsV2LaunchFactory` — 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
interface IPonsV2LaunchFactory {
    /// @notice Starts the change of creator-fee recipient. Restricted to the
    ///         CURRENT recipient — verified on-chain: the token's `deployer` is
    ///         rejected (`docs/recon.md` §1.3).
    function transferCreatorFeeRecipient(address token, address newRecipient) external;

    /// @notice Executes the change after the delay imposed by Pons (3 days).
    function executeCreatorFeeRecipientChange(address token) external;

    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);

    /// @notice The redirection Pons has proposed on a launch, if any.
    ///
    /// @dev    Found in the dispatcher, not in a published ABI — the explorer
    ///         answers scripted requests behind Cloudflare. Semantics measured
    ///         on a fork by impersonating the Pons owner
    ///         (`docs/recon-launchpad.md` R6.c):
    ///
    ///         - `pending` is the CURRENT recipient's replacement, or zero;
    ///         - `effectiveAt` = proposal + 3 days. Executing before it reverts
    ///           `0x810c4f2a`;
    ///         - `expiresAt` = `effectiveAt` + 3 days. Executing after it
    ///           reverts `0xb79d40e8` — **the proposal dies**, and the launch
    ///           silently goes back to being ours.
    function pendingCreatorFeeRecipient(address token)
        external
        view
        returns (address pending, uint256 effectiveAt, uint256 expiresAt);
}

/// @notice `PonsV2BondingCurve` — one instance per launch, address in
///         `LaunchedToken.curve`. Buyback route BEFORE graduation.
interface IPonsV2BondingCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);

    /// @notice Pushes the curve's accrued creator tax and fee share to the
    ///         escrow. Accepts the Pons `feeSweepOperator` or the curve's
    ///         `deployer` — and that field holds the creator FEE RECIPIENT, not
    ///         the wallet that launched. Verified on a fork against a real
    ///         launch: called from `FeeVault` it credits the escrow, called from
    ///         the launching EOA it reverts `NotFeeSweepOperator`
    ///         (docs/recon.md §1.7).
    function sweepFees(uint256 minBuybackTokensOut) external;
    function graduated() external view returns (bool);
    function isNativeQuote() external view returns (bool);
    function getReserves() external view returns (uint256 quoteReserve_, uint256 tokenReserve_);
}

interface IWETH is IERC20 {
    function deposit() external payable;
    /// @notice Returns native ETH. The Treasury needs it: an ERC-20 sweep ends
    ///         in WETH, and its four pockets are in ETH.
    function withdraw(uint256 amount) external;
}

/// @notice SwapRouter02 — 0xCaf681a66D020601342297493863E78C959E5cb2
/// @dev    No `deadline`: verified, this is how PonsFactory calls it.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    function WETH9() external view returns (address);
    function factory() external view returns (address);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3PoolObserver {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
    /// @dev One slot of the observation ring. Read off-chain to measure how many
    ///      SECONDS the ring actually spans — which is not the cardinality: the
    ///      ring is a fixed number of slots, so the busier the pool the shorter
    ///      the history it holds, and popularity is what kills a TWAP window
    ///      rather than neglect (T-HYP-02).
    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );
}

/// @notice The timelock, seen from off-chain. **Everything it can ever do is
///         announced by `CallScheduled` one full delay before it happens, and
///         that announcement is the only defence there is**: the Safe is the
///         sole proposer, and through the timelock it reaches `grantRole`,
///         `revokeRole` and `updateDelay` — because `TimelockController`'s
///         constructor grants `DEFAULT_ADMIN_ROLE` to the timelock itself.
///
///         So a Safe acting against the protocol can, at one delay each, add a
///         proposer of its own, remove the Safe, and set the delay to zero —
///         after which nothing is announced at all. Mirrored here so
///         `offchain/src/watch.ts` can read it.
interface ITimelock {
    event CallScheduled(
        bytes32 indexed id,
        uint256 indexed index,
        address target,
        uint256 value,
        bytes data,
        bytes32 predecessor,
        uint256 delay
    );
    event MinDelayChange(uint256 oldDuration, uint256 newDuration);
    function getMinDelay() external view returns (uint256);
}

/// @notice Chainlink feed. Used to TIGHTEN the floor and as a witness, never as
///         a kill switch (docs/ARCHITECTURE.md §S3).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice The Payd, seen from a vault. One question, and it is the one
///         that keeps `migrate` from leading anywhere interesting: is this
///         address a vault WE made, or something someone handed us?
interface IPayd {
    /// @notice The registry, and nothing else. It is written only by
    ///         `_create`, so nobody can steer it — which is what makes it the
    ///         one non-forgeable check available to `FeeVault.migrate`.
    function isVault(address) external view returns (bool);
    /// @notice What the vault at this address promises its holders — the mode
    ///         of the factory that built it. Zero for an address the registry
    ///         never built, which is what makes the check fail closed.
    function modeOf(address) external view returns (bytes32);
    /// @notice Whether the registry currently allows a migration between two
    ///         payout modes. `false` at birth, and only the generation key
    ///         moves it.
    function crossModeMigration() external view returns (bool);
}

/// @notice The Distributor. `fund` accumulates per epoch.
interface IDistributor {
    /// @notice Credits ONE purchase of the whole basket, covering every epoch
    ///         from the last one funded through `toEpoch`.
    /// @param quoteSpent The ETH each leg cost, aligned with `stocks`. It is the
    ///        basis of the eligibility threshold, which must be a formula over
    ///        on-chain quantities rather than a parameter chosen by the
    ///        publisher.
    function fundWindow(
        uint256 toEpoch,
        address[] calldata stocks,
        uint256[] calldata amounts,
        uint256[] calldata quoteSpent
    ) external;
    function currentEpoch() external view returns (uint256);
    /// @notice The first epoch no purchase has covered yet.
    function nextEpoch() external view returns (uint256);
    /// @notice Delivers `account`'s share. Permissionless, and the beneficiary
    ///         is a PARAMETER — which is what lets `Collector` settle several
    ///         launches for one holder in a single transaction.
    function distribute(
        address account,
        address[] calldata stocks,
        uint256[] calldata cumulative,
        bytes32[][] calldata proofs
    ) external returns (uint256 delivered);
}

/// @notice PoolManager Uniswap v4 — 0x8366a39CC670B4001A1121B8F6A443A643e40951.
/// @dev    Minimal interface: only the "exact input" path concerns us.
///         `Currency` is `type Currency is address` on the v4 side, so its ABI
///         encoding is that of an `address` — the selectors match.
interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    function unlock(bytes calldata data) external returns (bytes memory);

    /// @notice Adds or removes liquidity. **Exposed on the PoolManager itself**,
    ///         so a contract holds its position directly: no NonfungiblePositionManager,
    ///         no NFT, no approval. A position keyed by (owner, ticks, salt) is
    ///         not transferable — which for protocol-owned liquidity is the
    ///         point, not a limitation.
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);

    /// @notice Marks a currency before paying it in with a plain transfer.
    function sync(address currency) external;
    /// @return delta Packed BalanceDelta: amount0 in the high bits, amount1 in the low bits.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @notice `PonsV2LaunchFactory.memeHook()` — the v4 hook shared by every
///         graduated pool. A component of the PoolKey.
interface IPonsV2MemeHookSource {
    function memeHook() external view returns (address);
}

/// @notice `V2MemeHook`, the v4 hook shared by every graduated pool. Verified
///         source, read 2026-09-04.
/// @dev    `sweepPoolFees` pushes a pool's accrued fees to the escrow. It accepts
///         the Pons `feeSweepOperator` **or** `launches[poolId].creator`, which
///         is the creator FEE RECIPIENT — `setCreatorFeeRecipient` is
///         `onlyFactory` and writes that field. `FeeVault` is that recipient, so
///         it can sweep its own fees (docs/recon.md §1.7).
///
///         A non-operator caller is refused with `InternalSwapRequiresOperator`
///         whenever fees are pending denominated in the MEMECOIN: converting
///         those needs an internal swap that moves our own price, and Pons
///         reserves that. Fees pending in the quote token (native ETH for us)
///         need no conversion, and those we can sweep ourselves.
interface IPonsV2MemeHook {
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}
