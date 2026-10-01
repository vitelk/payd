# Verifying the payout-mode factories

Five contracts deployed 2026-09-15, plus the portfolio mode's three, built
ahead of its deployment. Two explorers, two routes.

**Etherscan — scripted, and already done.** Chain 4663 is served by the V2
multichain API at `api.etherscan.io/v2/api?chainid=4663`. `./verify/submit.sh`
posts all five there. Note that `robin.etherscan.io` is the UI and sits behind
Cloudflare, and `api.robin.etherscan.io` — which the UI's own error message
suggests — does not resolve. This README claimed for one revision that chain
4663 had no Etherscan instance at all; it was written from `docs/recon.md`,
which only records Blockscout, instead of from a request.

**Blockscout — by hand, in a browser.** `https://robinhoodchain.blockscout.com`
serves a Cloudflare MANAGED CHALLENGE to any scripted client — a JavaScript
page, not a 403 — so no verifier flag will reach it. Tested 2026-09-15. The
files below are what its form wants.

## The form

For each contract: **Verify & Publish → Solidity (Standard JSON Input)**.

| Field | Value |
|---|---|
| Compiler | `v0.8.26+commit.8a97fa7a` |
| Standard Input JSON | the matching `.json` in this directory |
| Constructor arguments | see below — leave EMPTY for the two implementations |

The settings that must match are already inside each JSON — optimizer on at 200
runs, `viaIR: true`, `evmVersion: cancun`, `bytecodeHash: ipfs`. Do not
retype them into the form; upload the file.

## The five

| Contract | Address | Constructor args |
|---|---|---|
| `TontineFactory` | `0xba92F9CF3E7e39975F3423CF980AFB3290E9D10b` | see `constructor-args.txt` |
| `BackingFactory` | `0x6730b49592C2401Da4B303D4BD7F0f20CB978888` | see `constructor-args.txt` |
| `BackingRedeemer` | `0x9DB31071bd09e058e30FcEdbed695E2787b01510` | **none** |
| `LotteryFactory` | `0xd97c82f41EBA1FE49c41AAb7121034A73d2D08d9` | see `constructor-args.txt` |
| `LotteryDistributor` | `0xa19ea405F5E484949265C8d69C6BB1219da5c6c0` | **none** |

**Forge's broadcast summary swapped the names** for backing and lottery — it
attributes contract names by bytecode heuristic and got both pairs backwards.
The table above is what the chain says: a factory answers `MODE()` and
`VAULT_IMPL()`; an implementation answers `FEE_VAULT()` or `POT_BPS()` and
reverts on `MODE()`.

The constructor arguments in `constructor-args.txt` were not merely computed —
each was confirmed to be the literal suffix of its creation transaction's input
on-chain.

## The portfolio mode, ahead of its deployment

`PortfolioVault.json`, `PortfolioDistributor.json` and `PortfolioFactory.json`
are here already. **A standard-JSON input is a function of the source and the
compiler settings and of nothing else** — no address enters it — so it can be
built before the deployment and read by anybody against this repository. All
three carry the same settings as the five above: optimizer on at 200 runs,
`viaIR: true`, `evmVersion: cancun`, `bytecodeHash: ipfs`.

What is NOT here is the only part a deployment produces: the three addresses,
and `PortfolioFactory`'s constructor arguments
(`vaultImpl, distImpl, excludedAtBirth`). Fill them on deploy night — the
addresses into `submit.sh`'s guarded block, the arguments into
`constructor-args.txt` — and confirm each argument against the literal suffix
of its creation transaction's input, as was done for the five.

Two more contracts are worth a thought and neither belongs in `submit.sh`:
**`PortfolioBook` and `PortfolioBootstrap` are deployed per LAUNCH**, by the
factory, not by the deployment script. The book is the contract holders write
their own rows into, so it is the one an explorer visitor will actually want
verified; its standard-JSON input is generated the same way
(`forge verify-contract <addr> contracts/portfolio/PortfolioBook.sol:PortfolioBook
--show-standard-json-input`) and its constructor arguments are
`(factory, registry)` — both readable off the book itself.

## Why it matters

`docs/PAYD_RUNBOOK.md` §Step 2: an unverified link in the provenance chain is
exactly what a careful reader flags. A factory nobody can read is a factory
nobody can check the `VAULT_IMPL` of — and that immutable is the whole of what
the generation key is being asked to approve.
