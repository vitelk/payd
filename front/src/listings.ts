/**
 * listings.ts — the stocks and quote currencies the registry has listed.
 *
 * Its own module with NO import, so node can load it: `config.ts` reads
 * `location` at import time, and the MCP server (`mcp/`) needs these lists too.
 * `config.ts` re-exports them, so nothing in the app changed its import.
 */

/**
 * **The addresses the creation screen asks the registry ABOUT, and the block
 * they were read at.**
 *
 * `Payd` stores its allowlists as mappings — `listing(stock)` and
 * `quoteListing(quote)` — with no array beside them, so the chain can CONFIRM
 * an address and cannot enumerate the set. The set therefore only exists in the
 * events, and walking to them is what this replaces.
 *
 * **What the walk cost, measured 2026-09-28.** `StockAllowed` and its four
 * siblings are scanned forward from `PAYD_BLOCK` in 9 000-block windows, and
 * the registry is now 13 057 270 blocks behind the head: **1 452 windows, ~61 s
 * on a warm endpoint, to discover 92 events.** 1 451 of those windows are
 * empty. On the public RPC it does not finish at all — the node throttles, and
 * its 429 reaches the browser as a CORS error about a duplicated
 * `Access-Control-Allow-Origin`, so the Launch view failed with a message that
 * named nothing real. The cursor in `localStorage` only ever helped the second
 * visit, and the cost grows ~96 windows a day, for ever, at the chain's 0.1 s.
 *
 * So the discovery is done ONCE, here, and the registry stays the authority for
 * every row: `allowlist` and `quotelist` read the mapping for each address
 * below and offer only what it confirms, which is what `quotelist` already did
 * and `allowlist` now does too. Two consequences, and the first is the reason
 * this is safe:
 *
 *   - a stock or currency the timelock REMOVES disappears from the picker the
 *     moment it is removed, with no rebuild — `allowed: false` is read live.
 *     That is the direction that matters: offering a delisted stock builds a
 *     vault whose basket `FeeVault.init` refuses;
 *   - one the timelock ADDS is not offered until this list is refreshed and the
 *     app republished. Listings take 48 h of notice and the last one landed at
 *     block 71 443 430, ~34 days before this reading. `pnpm --filter front
 *     listings` re-reads the chain and prints the diff; run it before a
 *     release.
 *
 * Same bargain as `KNOWN_FACTORIES` above, for the same reason, and the walk
 * that used to run beside that one is gone with this: its six entries are
 * exactly the six `FactoryEnabled` leaves behind.
 *
 * Every address below was read on-chain on **2026-09-28 at block 74 404 431**,
 * folded from `StockAllowed`/`StockRemoved` and `QuoteAllowed`/`QuoteRemoved`,
 * and then re-confirmed one by one against `listing` / `quoteListing`: 46 of 46
 * and 40 of 40 answered `allowed`, with no tier drift between the event and the
 * mapping. The tier and the feed are NOT stored here — they are read live,
 * because they are what a vault is built with.
 */
export const LISTINGS_READ_AT = 74_404_431n;

/** The 46 equities the timelock has listed. Tickers are for the reader; the
 *  screen reads each one's `symbol()` from the chain. */
export const KNOWN_STOCKS = [
  "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", // AAPL
  "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", // AMC
  "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", // AMD
  "0x12f190a9F9d7D37a250758b26824B97CE941bF54", // AMZN
  "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", // BABA
  "0x822CC93fFD030293E9842c30BBD678F530701867", // BE
  "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2", // COST
  "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", // CRCL
  "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", // DELL
  "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516", // DJT
  "0x25C288E6D899b9BC30160965aD9644c67e73bE0C", // F
  "0x41F4267525a8AFf329540eF24fD83d9044758B33", // FIG
  "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", // GLD
  "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", // GME
  "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", // GOOGL
  "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", // HIMS
  "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619", // IBM
  "0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80", // JNJ
  "0x8005d266423c7ea827372c9c864491e5786600ea", // LLY
  "0x4e62068525Ab11FE768e29dfD00ef909B9803016", // LULU
  "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", // META
  "0x62fd0668e10D8B72339BE2DCF7643001688ff13B", // MRVL
  "0xe93237C50D904957Cf27E7B1133b510C669c2e74", // MSFT
  "0xec262a75e413fAfD0dF80480274532C79D42da09", // MSTR
  "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", // MU
  "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8", // NFLX
  "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA
  "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", // PLTR
  "0x39dBED3a2bd333467115dE45665cC57F813C4571", // PONS
  "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", // QQQ
  "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8", // RBLX
  "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", // RDDT
  "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B", // RIVN
  "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", // SGOV
  "0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8", // SKHY
  "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", // SLV
  "0xF6589F11Bc40b669e584073F428B05562F568733", // SNAP
  "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", // SPCX
  "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", // SPY
  "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", // TSLA
  "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", // TSM
  "0x5e81213613b6B86EaB4c6c50d718d34359459786", // TTWO
  "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2", // UPS
  "0xd917B029C761D264c6A312BBbcDA868658eF86a6", // USAR
  "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", // USO
  "0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E", // WYFI
] as const satisfies readonly `0x${string}`[];

/** The 40 currencies a launch may be quoted in, besides native ETH — which has
 *  no row, being allowed by construction (`Payd._create` only reads the list
 *  for a non-zero quote). */
export const KNOWN_QUOTES = [
  "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", // AAPL
  "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", // AMC
  "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", // AMD
  "0x12f190a9F9d7D37a250758b26824B97CE941bF54", // AMZN
  "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", // BABA
  "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", // COIN
  "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2", // COST
  "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", // CRCL
  "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", // DELL
  "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516", // DJT
  "0x41F4267525a8AFf329540eF24fD83d9044758B33", // FIG
  "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", // GLD
  "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", // GME
  "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", // GOOGL
  "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", // HIMS
  "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619", // IBM
  "0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80", // JNJ
  "0x8005d266423c7ea827372c9c864491e5786600ea", // LLY
  "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", // META
  "0xe93237C50D904957Cf27E7B1133b510C669c2e74", // MSFT
  "0xec262a75e413fAfD0dF80480274532C79D42da09", // MSTR
  "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", // MU
  "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8", // NFLX
  "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA
  "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", // PLTR
  "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", // QQQ
  "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8", // RBLX
  "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", // RDDT
  "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B", // RIVN
  "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", // SGOV
  "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", // SLV
  "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", // SPCX
  "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", // SPY
  "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", // TSLA
  "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", // TSM
  "0x5e81213613b6B86EaB4c6c50d718d34359459786", // TTWO
  "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2", // UPS
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG
  "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", // USO
  "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", // cbBTC
] as const satisfies readonly `0x${string}`[];
