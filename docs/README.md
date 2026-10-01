# docs/

Start with whichever heading matches why you came.

## Understand the system

| | |
| :--- | :--- |
| [**HOW_IT_WORKS.md**](HOW_IT_WORKS.md) | **Start here.** The whole system in one pass: the contracts, the cycle, the snapshot, the two roots, who can do what. Written for someone who intends to read the code next. |
| [CONVENTIONS.md](CONVENTIONS.md) | The rules this codebase is held to, and the measurement behind each — what a change has to satisfy before it lands. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 46 decisions, each with the measurement that drove it — and the ones we got wrong, kept with the correction. It opens with a map by subject; the numbering is chronological and never renumbered, because the contract comments point at it. |
| [recon.md](recon.md) | Every external address — Pons, Uniswap, Chainlink, the stock tokens — with how it was verified and on what date. Nothing in this repository was written against an assumed address or ABI. |
| [recon-launchpad.md](recon-launchpad.md) | The same measurements, for what `Payd` had to learn: the quote currencies, the routes, the split multipliers. |
| [allowlist.md](allowlist.md) | The stocks a basket may draw from — 49 of the 194 listed are liquid enough — and the quote currencies a vault may be launched in: each with its pool, its tier, its measured depth and the reason it is on the list or off it. |

## Put the contracts live

| | |
| :--- | :--- |
| [SDK.md](SDK.md) | Integrating a launch by hand: every call the SDK makes, in order, so a third party can rebuild the part they want in whatever stack they already ship. `sdk/README.md` covers the two-line drop-in. |

## Verify what is claimed

| | |
| :--- | :--- |
| [../SECURITY.md](../SECURITY.md) | What is in scope, what an attacker can already reach by design, and how to report something. No audit has been done. |

## Build and publish the pages

| | |
| :--- | :--- |
| [DEPLOY_FRONT.md](DEPLOY_FRONT.md) | Building the two pages, pinning to IPFS, and pointing the ENS name at them. |

> **The runbooks, the planning, the roadmap and the audit record are
> deliberately not in this repository.** The runbooks name the Safe's signers,
> carry environment variables and describe key hygiene — published, that is a
> targeting package rather than documentation. The planning documents carry
> deliberation and options that were never shipped. A published roadmap reads as
> a set of commitments made by an identifiable team, which is the one thing a
> protocol's documentation should not do. And the audit documents are written in
> the present tense about findings that are still open, with the contract line
> numbers beside them — a map rather than a credential.
>
> **So a `PLAN.md §8ter` or `AUDIT_PLAN.md §4` in a code comment points at a
> file you will not find here.** Those citations are kept rather than stripped:
> they record that the line was argued somewhere before it was written, and
> which document to ask for if you are reviewing under an agreement. Every
> reference that resolves inside this repository still resolves.
>
> **Nothing they contain changes what the contracts do.** Everything a reader
> needs to verify the system — every address, every measurement, every rule the
> code is held to — is here.

## Brand

| | |
| :--- | :--- |
| [brand/](brand/) | The mark, the banners and the social card, with the source they are exported from. |

---

**A note on the tone.** These documents argue with themselves. Sections are
struck through and corrected in place rather than rewritten, wrong numbers are
left visible next to the right ones, and several record a bug that had been
written, reviewed, documented and never run. That is deliberate: a document that
only records the final answer cannot be checked, and the corrections are usually
the interesting part.
