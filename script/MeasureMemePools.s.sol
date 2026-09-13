// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager, IPonsV2LaunchFactory, IPonsV2MemeHookSource} from "../contracts/interfaces/IExternal.sol";
import {FullMath} from "../contracts/libraries/FullMath.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IMeta {
    function symbol() external view returns (string memory);
}

/// @notice **How deep are the pools of graduated Pons memecoins?**
///
///   forge script script/MeasureMemePools.s.sol --rpc-url $RPC_URL
///
/// @dev    The question that decides whether a v4 leg is worth writing. Two
///         isolated measurements (SQUEEZE $63, HASH $12) do not make a
///         distribution: the sample below comes from the v4 pools that were
///         ACTUALLY initialised over the last 20 000 blocks, quoted in native ETH.
///
///         The threshold applied to any other basket line is $5 000
///         (`docs/allowlist.md`).
contract MeasureMemePools is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    uint256 constant K_NUM = 4_987_562;
    uint256 constant K_DEN = 1_000_000_000;
    uint256 constant Q96 = 2 ** 96;
    /// @dev ETH/USD at the 2026-09-08 feed, in cents.
    uint256 constant ETH_USD_CENTS = 249_106;

    function run() external {
        address[] memory m = new address[](40);
        m[0] = address(0x35289aFD73B05Be3A07cC9F64BF8b123b39498aC);
        m[1] = address(0x74ae577163A5B63c0c45041Df44d235C53e721cc);
        m[2] = address(0x7247DcF58D97EDBe0Bdfc5925E77Bc87CA8f439b);
        m[3] = address(0x14c183B302249eF05B0bf0aCbf229416B77e9FCc);
        m[4] = address(0x3f1166a3329E289c5ea8Ef1eE7BCbffda5023f0D);
        m[5] = address(0x1f7F918780f90EA0aEeb7a1567D501D67Aff4e5e);
        m[6] = address(0x708a929028a76C95efE4aF46934C8fA98A883e30);
        m[7] = address(0xfA03c55F7e99D8b0Bb952A34dE28B3438d8CB3cB);
        m[8] = address(0x13d2afFecf7E2D041D5860f884AE3F78Fc590123);
        m[9] = address(0x823F7a8316F1a3a52e8b3A22f0f2d70BA5091E18);
        m[10] = address(0x6e3A9d59ad6a9aBa295c7e7a7EF0aF0AC5f11E18);
        m[11] = address(0x4839A061876639993628526B386ee5EB87161E18);
        m[12] = address(0x7410c0C0b1CBd77Af45B05d92263427cc902129F);
        m[13] = address(0x19f3857642b7B1808204B9dA28a26e199409D91B);
        m[14] = address(0x78BF0A564d33D6205654c90B97A560dD79e46fcc);
        m[15] = address(0x71De6461f3BC54fb7004Ac3F70c280D11CdA1EB4);
        m[16] = address(0xA9e8e2Bf5e73Ec85553CFD325f91cE0b3A2a560F);
        m[17] = address(0xfF94aF196058D5EDE78559E269f045a2AcFc08cb);
        m[18] = address(0xb7eaeCc89d3e2f9Fd597D61726aE824900dB8360);
        m[19] = address(0x2B3e2FaC98AE06A778a7Dd3464a121d2d7190123);
        m[20] = address(0x5D83CDbf00dCdBA18e494ECd904D8806Fa9a7754);
        m[21] = address(0x40c44515B1E86f19D6B36f518c1E64DBeF9698ac);
        m[22] = address(0xB7Bc1e61087830411c1Ad168C727Cc9Ddb6B1e18);
        m[23] = address(0xef5F944a00C87075F6B13dB40b67AdB52c5fF40f);
        m[24] = address(0xadbc4953595768E9a93D60DF13811FC5093698Ac);
        m[25] = address(0xc90613D9b79e61C5D0Bb59b6C281A80F67F87648);
        m[26] = address(0xcBaB9dAF7Fdc0f4059dBd3Fdc7787Dd551C998AC);
        m[27] = address(0x8A82F156f5e9Af247d06f194F96291384a575534);
        m[28] = address(0xfBCa247e14f460b074D985f287C38D26206246ea);
        m[29] = address(0xbA7320AC86230c1ceFC4539926905599270d1e18);
        m[30] = address(0x2a0d59557935b54b63652ff7EdD1afe1976f1E18);
        m[31] = address(0xDaB4d5Ba446E6cECAB8C21fD951CE722E2E7990D);
        m[32] = address(0xFb9bDf97e255D40c38A0092d594a5FFdbCF18a68);
        m[33] = address(0xe3b524BA0E073C01Fb7cE36814CC3d8A680A1e18);
        m[34] = address(0x32bB883D09A0597Db0111AfdE6c5E10BdD96Aa4d);
        m[35] = address(0x0d79109924bAc69b96f31942a3fffD38a1683462);
        m[36] = address(0x4672799B55139D448A1cba198564C090Ab78519f);
        m[37] = address(0xfDb1324544c2b02D5eD44baCC6223d3C3A8734a1);
        m[38] = address(0x9887d2aE551FCAf35932d78c12cFB5D073e11aE8);
        m[39] = address(0xe610F1e53DDFa90726f0887109717a57e69adf0A);
        uint256 above;
        uint256 total;
        console.log("sym            phase   depth $");
        for (uint256 i; i < m.length; ++i) {
            IPonsV2LaunchFactory.LaunchedToken memory l = IPonsV2LaunchFactory(PONS_FACTORY).getLaunchedToken(m[i]);
            IPoolManager.PoolKey memory k = IPoolManager.PoolKey({
                currency0: address(0),
                currency1: m[i],
                fee: l.poolFee,
                tickSpacing: l.tickSpacing,
                hooks: IPonsV2MemeHookSource(PONS_FACTORY).memeHook()
            });
            bytes32 base = keccak256(abi.encode(keccak256(abi.encode(k)), uint256(6)));
            uint160 sqrtP = uint160(uint256(IExtsload(POOL_MANAGER).extsload(base)) & ((1 << 160) - 1));
            uint128 liq = uint128(uint256(IExtsload(POOL_MANAGER).extsload(bytes32(uint256(base) + 3))));
            uint256 usd;
            if (sqrtP != 0 && liq != 0) {
                uint256 wei_ = FullMath.mulDiv(FullMath.mulDiv(liq, Q96, sqrtP), K_NUM, K_DEN);
                usd = FullMath.mulDiv(wei_, ETH_USD_CENTS, 100) / 1e18;
            }
            if (usd >= 5_000) ++above;
            total += usd;
            console.log(string.concat(_sym(m[i]), "  phase=", vm.toString(uint256(l.phase)), "  $", vm.toString(usd)));
        }
        console.log("");
        console.log("pools measured       :", m.length);
        console.log("above $5 000         :", above);
        console.log("total depth $        :", total);
    }

    function _sym(address t) internal view returns (string memory) {
        try IMeta(t).symbol() returns (string memory s) {
            return s;
        } catch {
            return "?";
        }
    }
}
