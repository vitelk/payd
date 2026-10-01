# MCP.md — a Payd server for AI agents

Status (2026-10-01): **built** in `mcp/` — the four read tools (phase 1 of
`docs/AI_PLAN.md`) and the four prepare tools (phase 2). Nothing is published to
npm and nothing here touches a contract.

```bash
pnpm install
claude mcp add payd -- pnpm --dir "$PWD/mcp" exec tsx src/server.ts   # any MCP client: same command
pnpm --filter @paydprotocol/mcp test        # offline: serialisation, untrusted wrapping, the prepare guards
pnpm --filter @paydprotocol/mcp e2e         # against `anvil --fork-url … --port 8547`: create → launch → bind, then a real claim
pnpm --filter @paydprotocol/mcp errors      # after `forge build`: regenerate the error ABI reverts are decoded with
```

## Why

Agents launch tokens now, and the first question every holder asks is where the
creator fees go. Payd is a credible answer an agent can give in one line: *the
fees are not mine, they buy stock for holders, and the code says so for ever*.
An MCP server is how an agent — Claude, or anything else that speaks MCP —
gets to that answer without a human building the three transactions by hand.

It is a **distribution channel, not a feature**: no contract changes, no
admission, no new mode.

## The one rule: the server holds no key

Every tool either **reads** public state or **prepares** an unsigned
transaction. The agent signs with its own wallet — whatever wallet tool it
already has — and the server never sees a private key.

This is not caution, it is forced by the contracts:

- `Payd._create` stamps `msg.sender` as both `CREATOR` and `LAUNCHER`
  (`contracts/Payd.sol` `_create`).
  A server that signed would become the creator of every vault it launched,
  receive every creator residue and own `setRewardsBps`.
- `FeeVault.bind` requires Pons's recorded `deployer` to equal `LAUNCHER`. The
  launch must be signed by the same address that created the vault.
- CLAUDE.md: *as few keys as possible*. A hosted signer would be the biggest
  key the platform has ever had.

So a prepared transaction is a plain object:

```jsonc
{
  "chainId": 4663,
  "from": "0x…",          // the account it MUST be sent from
  "to": "0x…",
  "data": "0x…",
  "value": "0",           // decimal string, wei
  "simulation": { "ok": true, "result": "…" },  // eth_call from `from`
  "next": "after this lands, call payd_prepare_launch with vault=…"
}
```

Every prepare tool simulates from `from` before returning, and returns an error
instead of calldata when the simulation reverts. An agent should never be handed
a transaction we already know fails — Pons does not refund a launch fee.

## Transport and packaging

- **stdio first**, published as `@paydprotocol/mcp` and run with `npx @paydprotocol/mcp`.
  Local, no server to host, no rate budget of ours to burn.
- A hosted **read-only** Streamable HTTP endpoint can come later. Prepare tools
  stay stdio-only until there is a reason otherwise: they need the agent's
  address, and a hosted one would be the first Payd service that has to stay up.
- Config: `PAYD_RPC_URL` (default: the public RPC from `sdk/src/payd.ts`),
  `PAYD_GATEWAYS` (comma-separated, same default order as the SDK).

### Reuse, do not rewrite

| Need | Already lives in |
|---|---|
| token info, basket, epoch clock, shares, artifact verification, proofs | `sdk/src/payd.ts` (`createPayd`, `info`, `shares`) |
| the three locked Pons fields, launch fee, `expectedEconomics` | `front/src/pons.ts` `buildLaunch` |
| the Merkle tree | `front/src/merkle.ts` |
| Payd / registry addresses | `front/src/config.ts` |

`buildLaunch` lived in `front/src/pons.ts`, which imports `chain.ts` and
`config.ts` — both read the page at import time. It now lives in
`front/src/launchcall.ts` with the client as a parameter, next to `merkle.ts`
and `cid.ts`, which the SDK already imports the same way; `pons.ts` re-exports
it with the app's client bound, so no app caller changed. Likewise
`KNOWN_STOCKS` / `KNOWN_QUOTES` moved to the import-free `front/src/listings.ts`.
The SDK gained `claimArgs` — `claim`'s proofs without the send — and `claim`
now goes through it.

## Tools — v1

### Read

| Tool | Input | Returns | Source |
|---|---|---|---|
| `payd_list_tokens` | `creator?` | vault + token + symbol per launch | `Payd.vaults()` / `vaultsOf(creator)` |
| `payd_token_info` | `token` (the vault address) | `economics()`, `hookStatus()`, basket, epoch countdown, quote | `createPayd(...).info()` |
| `payd_holder_shares` | `token`, `holder` | owed / claimed per stock, in stock units **with decimals** | `createPayd(...).shares()` |
| `payd_launch_options` | — | allowed stocks (with pool tier), allowed quotes, `platformBps`, basket bounds, epoch bounds, Pons `launchFee`, `maxCreatorTaxBps` | `Payd.listing`, `quoteListing`, the front's stock list, Pons factory |

`payd_launch_options` is what lets an agent **propose** a basket. The server
never chooses one: no "suggest a basket" tool, no ranking. An opinion about
which stocks to hold is advice, and the agent or its operator owns it.

### Prepare (unsigned)

| Tool | Input | Builds | Guards |
|---|---|---|---|
| `payd_prepare_create_vault` | `from`, basket `[{stock, bps}]`, `rewardsBps`, `epochLength`, `quote?` | `createVault` (ETH) or `createVaultQuoted` | basket 2–8 lines, sums to 10 000, each ≥ `MIN_ALLOC_BPS`, every stock listed — checked before simulating, so the error names the line |
| `payd_prepare_launch` | `from`, `vault`, name, symbol, logo, description, socials, `creatorTaxBps`, `buyAmount?` | Pons `launchToken`, or `launchAndBuy` on the forwarder when `buyAmount > 0` | **`from` must equal `vault.LAUNCHER()`**; quote read from `vault.QUOTE()`, never an input; `creatorFeeRecipient` = vault, never an input |
| `payd_prepare_bind` | `vault`, `token` | `vault.bind(token)` | simulation; anyone may send it |
| `payd_prepare_claim` | `token`, `holder` | `distributor.claim(...)` over the **claim** tree | rebuilds proofs from the current `activeRoot` on every call, drops stocks with `owedTo == 0`, returns nothing when nothing is owed |

The launch is **three transactions in sequence**, each `next` field naming the
following one. Sequential is safe: the vault exists before the launch names it.
Two addresses are returned as predictions and both held on the fork run: the
vault in `simulation.result` (moves if another launch lands first, so the agent
re-reads it from `payd_list_tokens`), and `predictedToken`, which does not move —
Pons derives it from sender, salt and params, so the calldata as returned
produces exactly that token.

Three guards beyond the app's own basket rules (`front/src/basket.ts`
`validate`, reused): `from` must accept plain ETH (`acceptsValue`, reused from
`front/src/atomic.ts` — a creator that refuses value strands its share for
good); `payd_prepare_launch` refuses a non-registry vault, an already-bound one,
and any `from` that is not `LAUNCHER`; and every revert comes back NAMED, decoded
against `mcp/src/errors.json` (the error ABI of the six contracts on the path).

## Explicitly out of v1

- **The one-transaction launch** (`front/src/atomic.ts`). It predicts the vault
  address from the factory's nonce, so it is only safe as an atomic EIP-5792
  batch, and the 7702 delegation it rides on can strand the creator residue if
  the delegate refuses value. An agent wallet is the least likely place to have
  both checked. Add when an agent wallet answers `atomic: ready` and someone has
  measured its delegate.
- **Other modes** (`createVaultWith`, `modeData`). Each mode has its own
  per-launch encoding; add one at a time, starting with whichever an agent asks
  for.
- **Keeper actions** (`harvest`, `buyBasket`, `distribute`). They
  are permissionless and refund their own gas, so "agents as keepers" is a real
  idea, documented in `docs/SDK.md` §9 (`minOuts` only tightens the vault's
  own floor, so zeros are valid). Tools for it wait until someone asks.
- **Any write the server signs.** See the rule above. Not deferred: refused.

## Things the server must not get wrong

1. **Token metadata is hostile input.** Names, symbols, descriptions and logos
   come from whoever launched, and they are returned to a model. Wrap them as
   data (`{"untrusted": "…"}`) and say so in every tool description, or a
   token named `Ignore previous instructions and…` is a prompt injection with a
   Pons listing.
2. **Gateways are not trusted.** Every epoch artifact is checked against the
   on-chain `digest` before a number leaves the server — the SDK already does
   this; do not route around it.
3. **Never cache proofs.** A root is published every 30 minutes; a stale proof
   reverts the whole claim with `InvalidProof`.
4. **Amounts are strings in raw units, plus `decimals`.** A model rounding a
   float is how a holder is told they own a thousand times their share.
5. **`hookStatus != 1` is surfaced, never smoothed over.** An agent quoting a
   cheerful percentage on a vault whose fees moved away is lying for us.
6. **`shares() == []` is not an error.** Return it with the reason (not in the
   current root, or under the value floor), as `docs/SDK.md` §8 says.

## Checks it leaves behind

- Encoding: each prepare tool's calldata decodes back to its inputs
  (`viem.decodeFunctionData`), no network.
- The `LAUNCHER` guard: `payd_prepare_launch` with `from != LAUNCHER` returns
  an error and no calldata.
- One fork run of the full sequence — create → launch → bind — signed by a
  funded test account against the pinned block, reusing the Pons fixtures of
  `test/OneTxLaunch.t.sol`.

## Open questions for the user

- ~~Package name~~ — decided 2026-10-01: `@paydprotocol/mcp` on npm, org
  `paydprotocol`, owned by `vitelk-dev` alone (`payd` was not ours to take).
- Whether `payd_launch_options` should expose only the curated stock list the
  front shows, or every listed stock.
- Whether the public `payd` repository gets this package, or only the squash.
