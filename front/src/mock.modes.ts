/**
 * Dev-only fixtures for the payout modes that are NOT distribution.
 *
 * `mock.ts` exists because the page reads everything from the chain, so with no
 * deployment there is nothing to look at. That argument is sharper here: the
 * tontine, backing and lottery factories are deployed and **inert** — no vault
 * has ever been built under them — so without these fixtures the two screens
 * that pay those holders could not be looked at at all until the timelock's
 * `enableFactory` executes, which is the moment it is too late to correct them.
 *
 * It fakes the READS and nothing else. The ticket artifact is served through the
 * real gateway path with its CID derived from its own bytes, so the sha256
 * check and the Merkle rebuild run for real — the two things that decide
 * whether a prize can actually be collected.
 *
 * Never shipped: `main.ts` imports `mock.ts` behind `import.meta.env.DEV`.
 */
import { sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import { cidFromSha256 } from "./cid.js";
import { ticketTree } from "./merkle.js";

/**
 * The factories, at the addresses they really have on Robinhood Chain
 * (`docs/recon.md`, and the deployment of 2026-09-15). Real ones rather than
 * invented: the creation screen shows the factory it will build through, and a
 * fixture that shows a plausible-looking fake teaches the reader an address
 * that does not exist.
 *
 * The default is Distribution V3 — the one `WANT_FACTORY` waits for in
 * `create.ts` — so the fixture world is on the far side of that hold and the
 * form can actually be used.
 */
export const FACTORIES: { factory: Address; mode: string; isDefault?: boolean }[] = [
  { factory: "0x4C1c21285d79e036AeFC8e609D7aBf06DA88d70C", mode: "distribution", isDefault: true },
  // The PREVIOUS distribution factory, still enabled beside V3 — the live
  // registry's state until somebody disables it. Both rows call themselves
  // `distribution`, which is what the picker has to tell apart: this one takes
  // no `modeData`, so a vault built through it can neither burn nor lock
  // liquidity. Without it in the fixture, the one selector state that reads
  // "distribution" twice cannot be looked at.
  { factory: "0x7B4B4Db9b0Dc2b3f9E0a54B5Af79DF55fF5E6C21", mode: "distribution" },
  { factory: "0xba92F9CF3E7e39975F3423CF980AFB3290E9D10b", mode: "tontine" },
  { factory: "0x6730b49592C2401Da4B303D4BD7F0f20CB978888", mode: "backing" },
  { factory: "0xd97c82f41EBA1FE49c41AAb7121034A73d2D08d9", mode: "lottery" },
];

export interface ModeWorld {
  /** `Payd.modeOf`, by vault address. */
  modeOf(vault: string): Hex;
  /** A read of one of the mode contracts, or `undefined` if this is not one. */
  read(addr: string, fn: string, args: readonly unknown[]): unknown;
  /** The ticket artifact, at the CID its digest produces. */
  serve(url: string): string | null;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const b32 = (s: string) => stringToHex(s, { size: 32 });

/**
 * Which fixture vault is which mode.
 *
 * Indices into the registry's list, so `?mock` shows the index with the chips
 * on — the state a visitor meets first — and `?vault=<that one>` opens its
 * screen. Two is enough: a backing vault and a lottery one, plus a tontine that
 * must keep drawing the ORDINARY claim page (it pays through `DistributorV3`
 * verbatim, and a page that treats it as special would be the bug).
 */
/** The settlement currency a portfolio book answers with. */
const PIVOT_ISH = "0x00000000000000000000000000000000000000e5" as Address;

const AT: Record<number, string> = { 1: "backing", 3: "lottery", 5: "tontine", 6: "portfolio" };

export function modeWorld(vaults: readonly Address[], stocks: readonly Address[], holder: Address): ModeWorld {
  const indexOf = (a: string) => vaults.findIndex((v) => v.toLowerCase() === a.toLowerCase());
  const modeAt = (i: number) => AT[i] ?? "distribution";

  // The pot, per stock. Deliberately uneven, and one leg EMPTY: a mode screen
  // that only ever renders full rows hides what it does with a stock the vault
  // has not managed to buy yet.
  const pot = (i: number) => (i === 2 ? 0n : BigInt(40 + i * 37) * 10n ** 17n);

  // --- the lottery's ticket set, and the winner hidden inside it.
  const TOTAL = 1_000_000n;
  const tickets = [
    { holder: holder.toLowerCase(), start: "0", end: "250000" },
    { holder: "0x00000000000000000000000000000000000000a1", start: "250000", end: "700000" },
    { holder: "0x00000000000000000000000000000000000000b2", start: "700000", end: "1000000" },
  ];
  const root = ticketTree(tickets).root;
  // The field order is `canonicalTicketJson`'s, in `offchain/src/lottery.ts`:
  // the digest commits to these exact bytes, so a fixture in another order
  // would verify here and nowhere else.
  const text = JSON.stringify({
    fromEpoch: 1200, upToEpoch: 1283, totalTickets: TOTAL.toString(), root, tickets,
  });
  const digest = sha256(toHex(text));
  const path = cidFromSha256(digest);
  /** Inside the demo holder's interval: the screen then shows the state that
   *  matters — a prize nobody has collected yet, with the button live. */
  const WINNING = 187_431n;

  const draw = [
    root,            // root
    TOTAL,           // totalTickets
    9_312_004n,      // targetRound
    1_283n,          // upToEpoch
    2,               // status: Settled
    digest,          // digest
    WINNING,         // winningTicket
    holder,          // publisher
    1_780_400_000n,  // publishedAt
    1_780_401_000n,  // settledAt
    ZERO,            // winner — nobody has collected yet
  ];

  return {
    modeOf(vault) {
      const i = indexOf(vault);
      return b32(i < 0 ? "distribution" : modeAt(i));
    },

    read(addr, fn, args) {
      // The registry's own two reads about factories. `factory()` answers the
      // DEFAULT, which is what the screen's hold compares against.
      if (fn === "factory") return FACTORIES[0]!.factory;
      if (fn === "factoryMode") {
        const f = FACTORIES.find((x) => x.factory.toLowerCase() === String(args[0] ?? "").toLowerCase());
        return f ? b32(f.mode) : b32("");
      }
      const i = indexOf(addr);
      // A stock's balance, asked of the mode contract — which in this world is
      // the vault itself (`DISTRIBUTOR` answers with it).
      if (fn === "balanceOf") {
        const s = stocks.findIndex((x) => x.toLowerCase() === String(args[0] ?? "").toLowerCase());
        const self = stocks.findIndex((x) => x.toLowerCase() === addr);
        if (self >= 0 && s < 0) return pot(self);
      }
      if (i < 0) return undefined;
      const mode = modeAt(i);

      if (mode === "backing") {
        switch (fn) {
          case "allStocks": return stocks;
          case "TOKEN": return undefined; // the vault's `token()` already answers
          case "stockPending":
            // One deferred leg for the demo holder, so the retry panel is
            // reachable: it is the branch a paused stock produces and the one
            // nobody would otherwise ever see.
            return String(args[0] ?? "").toLowerCase() === holder.toLowerCase()
              && String(args[1] ?? "").toLowerCase() === (stocks[1] ?? ZERO).toLowerCase()
              ? 3_400_000_000_000_000_00n
              : 0n;
          case "redeemPreview": {
            // Pro-rata of each pot, against a supply of a billion tokens — the
            // same arithmetic the contract does, so the preview reads true.
            const amount = BigInt((args[0] as bigint) ?? 0n);
            const supply = 1_000_000_000n * 10n ** 18n;
            return [stocks, stocks.map((_, k) => (pot(k) * amount) / supply)];
          }
        }
        return undefined;
      }

      if (mode === "lottery") {
        switch (fn) {
          case "POT_BPS": return 2_000n;
          case "currentEpoch": return 1_284n;
          case "pendingEpochs": return 3n;
          case "currentRound": return 9_312_050n;
          case "drawCount": return 3n;
          case "draws": return draw;
          case "prizeNow": {
            const k = stocks.findIndex((x) => x.toLowerCase() === String(args[0] ?? "").toLowerCase());
            return k < 0 ? 0n : (pot(k) * 2_000n) / 10_000n;
          }
          // One leg already paid, so the table shows both states at once.
          case "drawStockPaid":
            return String(args[1] ?? "").toLowerCase() === (stocks[0] ?? ZERO).toLowerCase();
        }
        return undefined;
      }

      // **The portfolio's book, and the holder's row inside it.**
      //
      // The book is a contract of its OWN in this mode — one per launch — but
      // this world has no second address to give it, so the vault answers for
      // it, exactly as it answers for the redeemer and the lottery
      // distributor. The panel reads `book()` and then talks to whatever came
      // back, so it cannot tell the difference and does not need to.
      //
      // The fixture's row is the interesting state, not the empty one: the
      // HOLDER has chosen two stocks unevenly and the creator's default is a
      // different pair. That is what makes the screen say "this is your own
      // choice" rather than "you are paid the creator's basket", and those two
      // sentences are the whole of what a holder comes to this panel to read.
      if (mode === "portfolio") {
        switch (fn) {
          case "book": return addr as Address;
          // The fixture's pivot. Not one of `stocks`, deliberately: the picker
          // has to offer it even though the allowlist does not carry it.
          case "pivot": return PIVOT_ISH;
          case "defaultBasket":
            return [
              { stock: stocks[0]!, bps: 5_000 },
              { stock: stocks[1]!, bps: 5_000 },
            ];
          case "linesOf":
            return String(args[0] ?? "").toLowerCase() === holder.toLowerCase()
              ? [{ stock: stocks[2]!, bps: 7_000 }, { stock: stocks[3]!, bps: 3_000 }]
              // Anybody else has chosen nothing, so the contract answers with
              // the default — which is the branch `isDefaultRow` exists for.
              : [{ stock: stocks[0]!, bps: 5_000 }, { stock: stocks[1]!, bps: 5_000 }];
          case "MAX_LINES": return 64n;
          case "MIN_LINE_BPS": return 100n;
        }
        return undefined;
      }
      return undefined;
    },

    serve(url) {
      return url.endsWith(path) ? text : null;
    },

  };
}
