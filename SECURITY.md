# SECURITY.md

**No external audit has been done.** 184 fork tests against live chain state, 13
fuzzed invariants, Slither and an adversarial review are not a substitute for a
pair of eyes that did not write the code. Read `contracts/` before you buy, and
treat everything below as the honest description rather than a reassurance.

## Reporting something

**Do not open a public issue for anything exploitable.** DM
[@PaydRH](https://x.com/PaydRH) to arrange a private channel from there.

Anything not exploitable — a wrong number in the docs, a test that proves less
than it claims, a comment that has drifted from the code — is welcome as a
public issue or a pull request. That last category is not cosmetic here: the
worst bug this project has had was a comment that was right when it was written
and wrong by the time it mattered.

There is no bug bounty programme. If that changes it will be said here first.

## What is in scope

| | |
| :--- | :--- |
| `contracts/` | `FeeVault`, `Distributor`, `Payd`, `DistributionFactory`, `Treasury`, `Collector`, `Timelock`, `Bootstrap`, and the ported Uniswap maths in `contracts/libraries/` |
| `offchain/` | the snapshot, the Merkle build, the preflight, the keeper |
| `front/`, `site/` | the claim path in particular — a wrong proof or a wrong root read is a real finding |

## What is out of scope

Not because it does not matter, but because it is not ours to fix: Pons v2, the
Uniswap deployments, the tokenised stocks themselves and their issuer, and the
chain. `docs/recon.md` records what was verified about each and on what date.

Robinhood can pause a stock token, block an address, or burn holdings. This
protocol is exposed to that like every other holder, and no code here changes
it.

## What an attacker can already reach, by design

Stated so a researcher does not spend a day rediscovering it.

- **The keeper key can misdirect one epoch.** `publishRoot` is the single
  permissioned call on the nominal path, and the contract cannot verify a root
  without replaying every holder's history. A compromised key can publish a root
  awarding itself whatever has not been delivered yet — readable on-chain as
  `Distributor.quoteAtRisk()`, and kept to roughly one epoch by the fact that
  deliveries run continuously. The timelock can rotate the keeper in 48 h, which
  stops the next theft rather than the one in progress.
- **`buyBasket` is public and its transaction is visible.** A searcher can
  sandwich it, and it now carries the whole basket rather than one stock. The
  damage is bounded per leg by an on-chain price floor — a 30-minute Uniswap
  TWAP, tightened by a Chainlink feed where one exists — with
  `MAX_SLIPPAGE_BPS` of tolerance. Nobody has tried it against these contracts.
- **The timelock can move a vault's FUTURE fee stream, and only there.**
  `migrate` is the one door out, callable by the timelock alone, so it carries
  48 h of public notice. Its destination is not free: it must be a vault of the
  same token, same creator, same currency **and the same payout mode**, answering
  `Payd.isVault` and `Payd.modeOf` — both written by `_create` alone, which nobody
  can steer — that pays holders at least as well and takes no more for the
  platform. **Not one stock leaves the
  Distributor**: everything already credited stays claimable where it is. The
  vault's own undelivered reserve does follow the stream, into the successor's
  rewards pool and its pivot reserve, which are one-way pockets there too
  (`_moveReserve`). It replaced an `emergencyRedirect` that pointed at a
  maintainer-controlled Safe;
  `docs/ARCHITECTURE.md` §S24 keeps that version and argues against itself.
- **Two keys, one door, and the door between payout modes is the newest one.**
  A factory admitted to `Payd` builds vaults that register in `isVault`, hence
  valid `migrate` destinations — so admitting one takes the generation key
  (`approve`) **and** the timelock (`setFactory` / `enableFactory`, 48 h). No
  on-chain check separates a real factory from a hostile one: everything you
  could read off it is written by it. Separately, `crossModeMigration` — held by
  the generation key alone, shut from birth — is what lets a migration cross
  between two payout modes; open, it is open for **every** vault in the registry
  until it is shut again, and nothing enforces that it is. It moves nothing on
  its own: the timelock must still call `migrate` and still clear its 48 h.
  `docs/ARCHITECTURE.md` §S46 argues the placement and names what it does not do.
- **Nothing else has an owner.** Neither contract exposes a withdrawal to any
  privileged address. The only `withdraw()` pays the caller a payment that had
  already failed to reach that same caller; it takes no address argument.

## Verifying a root yourself

You do not have to trust the publisher. `pnpm --filter offchain dispute`
recomputes the shares from the chain alone — no key, no input from the project — and
tells you whether the published root matches. If it diverges you hold a
reproducible proof that anyone else can reproduce.

That tool is itself security-critical, and it has been wrong: until 2026-09-06
it read live state where it should have replayed history, and reported an honest
root as forged once its own airdrop had landed. Findings about `dispute.ts` are
as valuable as findings about the contracts.
