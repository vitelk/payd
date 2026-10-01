/**
 * The LOTTERY mode's screen: one draw, one winner, and the transaction that
 * pays them.
 *
 * **Nobody here picks the winner and nobody here can.** The keeper commits a
 * ticket tree for a FUTURE drand round (`publishDraw`); when that round's beacon
 * exists, anyone relays it (`settleDraw`) and the winning ticket falls out of a
 * signature nobody could have known in advance. This page only reads the result
 * and offers the last step — `collect`, which is **permissionless and pays the
 * leaf holder, never the caller**. So a visitor who is not the winner can still
 * send the prize to whoever is, and that is a feature: a winner who never comes
 * back still gets paid.
 *
 * **A ticket is a second of holding.** The intervals come from the artifact the
 * keeper published, and this page rebuilds their Merkle tree with the same
 * layout the contract verifies against (`merkle.ts`, held to OpenZeppelin's
 * shape by `merkle.test.ts`). The artifact itself is checked against the sha256
 * the draw committed — a gateway can withhold it, never change it.
 */
import { createWalletClient, custom, formatUnits, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { EXPLORER } from "./config.js";
import { pub, chain, erc20Abi, provider, ensureChain, logsBack } from "./chain.js";
import { fetchVerified } from "./artifact.js";
import { holderOfTicket, ticketTree, type Ticket } from "./merkle.js";
import { connected, viewer } from "./viewer.js";

/** Trimmed to what a holder's page reads and calls: the keeper's half of the
 *  ABI (`publishDraw`, the co-signature) has no button here. */
const lotteryAbi = parseAbi([
  "function currentEpoch() view returns (uint256)",
  "function pendingEpochs() view returns (uint256)",
  "function currentRound() view returns (uint64)",
  "function drawCount() view returns (uint256)",
  "function draws(uint256) view returns (bytes32 root, uint128 totalTickets, uint64 targetRound, uint48 upToEpoch, uint8 status, bytes32 digest, uint256 winningTicket, address publisher, uint40 publishedAt, uint40 settledAt, address winner)",
  "function drawStockPaid(uint256 drawId, address stock) view returns (bool)",
  "function prizeNow(address stock) view returns (uint256)",
  "function POT_BPS() view returns (uint256)",
  "function collect(uint256 drawId, address holder, uint256 ticketStart, uint256 ticketEnd, bytes32[] proof, address[] stocks) returns (uint256)",
]);

/** The two vault reads this screen makes. `chain.ts`'s `vaultAbi` is the claim
 *  page's and does not carry `DISTRIBUTOR`. */
const vaultAbi = parseAbi([
  "function DISTRIBUTOR() view returns (address)",
  "function getAllocations() view returns ((address stock, uint24 poolFee, uint16 bps, address feed)[])",
]);

/** Where the ticket artifact lives. In the log rather than in storage, exactly
 *  as `RootPublished` carries the epoch artifact's. */
const DRAW_PUBLISHED = parseAbiItem(
  "event DrawPublished(uint256 indexed drawId, address indexed publisher, bytes32 root, uint256 totalTickets, uint64 targetRound, uint256 upToEpoch, bytes32 digest, string cid)",
);

/** `DrawStatus`, as the contract declares it. */
const PUBLISHED = 1;
const SETTLED = 2;

/** How far back to look for the draw's own `DrawPublished`, in `LOG_SPAN`
 *  windows. A draw covers many epochs, so its log is older than an epoch root's
 *  — and a miss is not fatal: the CID rebuilt from the digest still serves
 *  while the ticket set fits in one IPFS block. */
const DRAW_WINDOWS = 24;

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ----------------------------------------------------------------- the maths

/** The canonical ticket JSON, as `offchain/src/lottery.ts` serialises it. */
export interface TicketSet {
  fromEpoch: number;
  upToEpoch: number;
  totalTickets: string;
  root: Hex;
  tickets: Ticket[];
}

/**
 * One holder's chance in a draw, as a percentage of the ticket set.
 *
 * Shown rather than computed on-chain because it is the one number a holder
 * actually wants before the round lands, and it is knowable the moment the root
 * is published: the tickets are a public, fixed list from then on.
 */
export function oddsOf(tickets: Ticket[], holder: string, total: bigint): number {
  if (total === 0n) return 0;
  const mine = tickets
    .filter((t) => t.holder.toLowerCase() === holder.toLowerCase())
    .reduce((sum, t) => sum + (BigInt(t.end) - BigInt(t.start)), 0n);
  // Through Number only at the end, and on a ratio: the counts are seconds ×
  // balance and run well past 2^53.
  return Number((mine * 1_000_000n) / total) / 10_000;
}

/** Whether the artifact actually belongs to the draw that committed it. The
 *  sha256 is checked by `fetchVerified`; this is the second half — that the
 *  tree it describes is the one the contract will verify a proof against. */
export function ticketsMatch(set: TicketSet, root: Hex, totalTickets: bigint): boolean {
  if (BigInt(set.totalTickets) !== totalTickets) return false;
  try {
    return ticketTree(set.tickets).root.toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- screen

interface Leg { stock: Address; symbol: string; decimals: number; prize: bigint; paid: boolean }

interface Draw {
  id: bigint;
  root: Hex;
  totalTickets: bigint;
  targetRound: bigint;
  upToEpoch: bigint;
  status: number;
  digest: Hex;
  winningTicket: bigint;
  winner: Address;
}

interface Board {
  distributor: Address;
  potBps: bigint;
  epoch: bigint;
  pending: bigint;
  round: bigint;
  legs: Leg[];
  draw: Draw | null;
  set: TicketSet | null;
  /** The interval that holds the winning ticket, once the draw is settled. */
  won: Ticket | null;
}

let board: Board | null = null;
let busy = false;
/** Cached by digest: the artifact cannot change without the draw changing. */
let cached: { digest: Hex; set: TicketSet } | null = null;

const $ = (id: string) => document.getElementById(id);
const say = (m: string) => { const n = $("lt-say"); if (n) n.textContent = m; };

const STYLE = `<style>
  .lt { display: flex; flex-direction: column; gap: .875rem; margin-top: 1.25rem; }
  .lt .box { background: var(--surface); border-radius: var(--r-lg); padding: 1.25rem 1.375rem; }
  .lt h2 { font: 600 1.0625rem/1.2 var(--sans); letter-spacing: -.02em; margin: 0 0 .35rem; }
  .lt .note { color: var(--mut); font-size: .875rem; margin: 0; text-wrap: pretty; }
  .lt table { width: 100%; border-collapse: collapse; margin-top: .875rem; }
  .lt th { font: 500 .6875rem var(--mono); letter-spacing: .09em; text-transform: uppercase;
    color: var(--dim); text-align: left; padding: .35rem .5rem; }
  .lt td { padding: .45rem .5rem; border-top: 1px solid var(--hair); font-size: .875rem; }
  .lt td.num, .lt th.num { text-align: right; font-family: var(--mono); }
  .lt .prize { color: var(--ok); }
  .lt .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%,11rem),1fr));
    gap: .75rem; margin-top: .875rem; }
  .lt .cell .k { font: 500 .6875rem var(--mono); letter-spacing: .09em; text-transform: uppercase;
    color: var(--dim); }
  .lt .cell .v { font: 500 1.0625rem var(--mono); color: var(--fg); }
  .lt .acts { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; margin-top: 1rem; }
  .lt .you { color: var(--ok); }
  .lt #lt-say { font-size: .8125rem; color: var(--mut); min-height: 1.2em; }
</style>`;

const SHELL = `${STYLE}<div class="lt">
  <div class="box">
    <h2>The draw</h2>
    <p class="note">This launch does not split its fees between holders: it buys the same basket of
    stocks and pays a share of the pot to <b>one holder per draw</b>. The winner is decided by a
    public randomness beacon (drand) for a round chosen <b>before</b> the tickets are committed — so
    no one here, the keeper included, can know or choose it. Holding longer buys more tickets.</p>
    <div class="grid" id="lt-facts"></div>
    <div class="acts">
      <button id="lt-collect" class="primary" disabled>Send the prize</button>
      <span class="note" id="lt-who"></span>
    </div>
    <p class="note" id="lt-say" style="margin-top:.6rem"></p>
  </div>
  <div class="box">
    <h2>The pot</h2>
    <p class="note">What the contract holds, and what the next draw pays out of it.</p>
    <table>
      <thead><tr><th>Stock</th><th class="num">In the contract</th><th class="num">This draw pays</th><th>Prize</th></tr></thead>
      <tbody id="lt-legs"><tr><td colspan="4" class="muted">Reading the chain…</td></tr></tbody>
    </table>
  </div>
</div>`;

/** Reads the draw, the pot and — once a draw is settled — the artifact that
 *  names its winner. Called on the same 60-second tick as every other screen. */
export async function renderLottery(host: HTMLElement, vault: Address): Promise<void> {
  if (host.innerHTML === "") {
    host.innerHTML = SHELL;
    host.hidden = false;
    $("lt-collect")?.addEventListener("click", () => void doCollect());
  }
  const distributor = await pub.readContract({
    address: vault, abi: vaultAbi, functionName: "DISTRIBUTOR",
  }) as Address;

  const read = <T>(fn: string, args: unknown[] = []) => pub.readContract({
    address: distributor, abi: lotteryAbi, functionName: fn as never, args: args as never,
  }) as Promise<T>;

  const [potBps, epoch, pending, round, count, allocations] = await Promise.all([
    read<bigint>("POT_BPS").catch(() => 0n),
    read<bigint>("currentEpoch").catch(() => 0n),
    read<bigint>("pendingEpochs").catch(() => 0n),
    read<bigint>("currentRound").catch(() => 0n),
    read<bigint>("drawCount").catch(() => 0n),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "getAllocations" })
      .catch(() => []) as Promise<readonly { stock: Address }[]>,
  ]);

  let draw: Draw | null = null;
  if (count > 0n) {
    const d = await read<readonly unknown[]>("draws", [count]);
    draw = {
      id: count,
      root: d[0] as Hex,
      totalTickets: d[1] as bigint,
      targetRound: BigInt(d[2] as bigint),
      upToEpoch: BigInt(d[3] as bigint),
      status: Number(d[4]),
      digest: d[5] as Hex,
      winningTicket: d[6] as bigint,
      winner: d[10] as Address,
    };
  }

  const legs: Leg[] = await Promise.all(allocations.map(async (a) => {
    const [symbol, decimals, prize, paid] = await Promise.all([
      pub.readContract({ address: a.stock, abi: erc20Abi, functionName: "symbol" }).catch(() => a.stock.slice(0, 8)),
      pub.readContract({ address: a.stock, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
      read<bigint>("prizeNow", [a.stock]).catch(() => 0n),
      draw ? read<boolean>("drawStockPaid", [draw.id, a.stock]).catch(() => false) : Promise.resolve(false),
    ]);
    return { stock: a.stock, symbol: symbol as string, decimals: Number(decimals), prize, paid };
  }));

  // The artifact, as soon as a draw exists — not only once it is settled. The
  // tickets are fixed the moment the root is published, so a holder can read
  // their own odds while the beacon is still in the future, which is when the
  // number is actually worth something to them. Fetched once per digest: it
  // cannot change without the draw changing.
  let set: TicketSet | null = null;
  let won: Ticket | null = null;
  if (draw && draw.status !== 0) {
    set = cached?.digest === draw.digest ? cached.set : await loadTickets(distributor, draw);
    if (set) {
      cached = { digest: draw.digest, set };
      if (draw.status === SETTLED) won = holderOfTicket(set.tickets, draw.winningTicket);
    }
  }

  board = { distributor, potBps, epoch, pending, round, legs, draw, set, won };
  paint();
}

async function loadTickets(distributor: Address, draw: Draw): Promise<TicketSet | null> {
  let hinted: string | null = null;
  try {
    const logs = await logsBack(
      (fromBlock, toBlock) => pub.getLogs({
        address: distributor, event: DRAW_PUBLISHED, args: { drawId: draw.id }, fromBlock, toBlock,
      }),
      DRAW_WINDOWS,
      true,
    );
    hinted = (logs.at(-1) as { args?: { cid?: string } } | undefined)?.args?.cid ?? null;
  } catch { /* the digest's own CID is the fallback */ }

  const text = await fetchVerified(draw.digest, hinted);
  if (text === null) return null;
  let set: TicketSet;
  try {
    set = JSON.parse(text) as TicketSet;
  } catch {
    return null;
  }
  // The sha256 matched, so this IS what the draw committed — but a draw could
  // have committed a root the artifact does not produce, and a proof built on
  // it would revert. Checked here, where it can be said in words, rather than
  // at the holder's expense.
  return ticketsMatch(set, draw.root, draw.totalTickets) ? set : null;
}

const qty = (v: bigint, decimals: number) =>
  Number(formatUnits(v, decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

function paint(): void {
  const b = board;
  if (!b) return;

  const cell = (k: string, v: string) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const d = b.draw;
  const facts = $("lt-facts");
  if (facts) {
    facts.innerHTML = [
      cell("Epoch", String(b.epoch)),
      cell("Pot share", `${Number(b.potBps) / 100} %`),
      cell("Draws so far", d ? String(d.id) : "0"),
      d ? cell("Covers through", `epoch ${d.upToEpoch}`) : cell("Next draw", `${b.pending} epoch${b.pending === 1n ? "" : "s"} waiting`),
      d ? cell("Status", drawState(d, b.round)) : "",
      d && d.status === SETTLED ? cell("Winning ticket", String(d.winningTicket)) : "",
      d && d.totalTickets > 0n ? cell("Tickets", d.totalTickets.toLocaleString("en-US")) : "",
      mineCell(b),
    ].filter(Boolean).join("");
  }

  const rows = $("lt-legs");
  if (rows) {
    rows.innerHTML = b.legs.length === 0
      ? `<tr><td colspan="4" class="muted">This token has not bought anything yet.</td></tr>`
      : b.legs.map((l) => `<tr>
          <td>${esc(l.symbol)}</td>
          <td class="num">${qty(l.prize * 10_000n / (b.potBps || 10_000n), l.decimals)}</td>
          <td class="num prize">${qty(l.prize, l.decimals)}</td>
          <td>${l.paid ? "paid" : d && d.status === SETTLED ? "waiting for the winner" : "—"}</td>
        </tr>`).join("");
  }

  // WHO WON, and what this page can still do about it.
  const who = $("lt-who");
  const btn = $("lt-collect") as HTMLButtonElement | null;
  const winner = b.won?.holder ?? (d && d.winner !== "0x0000000000000000000000000000000000000000" ? d.winner : null);
  const mine = winner && viewer && winner.toLowerCase() === viewer.toLowerCase();
  const unpaid = b.legs.some((l) => !l.paid && l.prize > 0n);

  if (who) {
    if (!d) {
      who.textContent = "no draw has been committed yet — the first one covers every funded epoch";
    } else if (d.status === PUBLISHED) {
      who.innerHTML = `tickets are committed for drand round <b>${d.targetRound}</b>`
        + (b.round > 0n && b.round < d.targetRound ? ` — ${(d.targetRound - b.round).toString()} rounds to go` : "")
        + ". Nobody can know the winner until that beacon exists.";
    } else if (d.status === SETTLED && !winner) {
      who.textContent = b.set === null
        ? "the draw is settled; its ticket list could not be fetched from any gateway, so the winning "
          + "interval cannot be shown here. The prize is still collectable by the winner."
        : "the winning ticket falls outside every interval in the published list — do not send anything.";
    } else if (winner) {
      who.innerHTML = mine
        ? `<span class="you">you won this draw</span> — the prize is ${unpaid ? "waiting" : "paid"}`
        : `won by <b>${esc(short(winner))}</b>${unpaid ? " — anyone can send it to them" : ", and paid"}`;
    }
  }

  // Enabled for ANYONE once the winner is known and a leg is unpaid: `collect`
  // pays the leaf holder, so a stranger pressing it costs them gas and pays the
  // winner. A wallet is still needed to sign — a pasted address cannot.
  if (btn) {
    btn.disabled = busy || !connected || !d || d.status !== SETTLED || !winner || !unpaid
      || (d.winner === "0x0000000000000000000000000000000000000000" && !b.won);
    btn.textContent = mine ? "Collect your prize" : "Send the prize";
  }
}

/**
 * The visitor's own chance in the committed draw.
 *
 * Empty when there is nobody to look up or no ticket list to look them up in —
 * a cell reading "0 %" for a visitor whose tickets simply could not be fetched
 * would be a lie, and this is the number somebody decides whether to keep
 * holding on.
 */
function mineCell(b: Board): string {
  if (!b.set || !viewer) return "";
  const total = BigInt(b.set.totalTickets);
  const odds = oddsOf(b.set.tickets, viewer, total);
  if (odds === 0) return "";
  return `<div class="cell"><div class="k">Your chance</div><div class="v you">${odds.toFixed(2)} %</div></div>`;
}

function drawState(d: Draw, round: bigint): string {
  if (d.status === SETTLED) return "settled";
  if (d.status === PUBLISHED) return round >= d.targetRound ? "beacon due" : "waiting for the beacon";
  return "none";
}

async function doCollect(): Promise<void> {
  const b = board;
  const d = b?.draw;
  if (!b || !d || busy) return;
  const eth = provider();
  if (!eth) return say("connect a wallet first — the Connect button, top right");
  if (!(await ensureChain(eth, say))) return;
  const me = viewer;
  if (!me || !connected) return say("connect a wallet — this transaction has to be signed by somebody");

  // The first `collect` fixes the winner and needs the proof; afterwards the
  // contract only accepts the winner it already recorded, and the interval is
  // no longer read. Both cases are the same call, with the proof carried in
  // the first and ignored in the second.
  const fixed = d.winner !== "0x0000000000000000000000000000000000000000";
  const won = b.won;
  if (!fixed && (!won || !b.set)) return say("the ticket list is not available — nothing can be proved from here");
  const holder = (fixed ? d.winner : won!.holder) as Address;
  const proof = fixed ? [] : ticketTree(b.set!.tickets).proofFor(holder) ?? [];
  if (!fixed && proof.length === 0 && b.set!.tickets.length > 1) {
    return say("could not build the winner's proof from the published list");
  }
  const stocks = b.legs.filter((l) => !l.paid && l.prize > 0n).map((l) => l.stock);
  if (stocks.length === 0) return say("every leg of this draw is already paid");

  busy = true; paint();
  try {
    say("sending…");
    const wallet = createWalletClient({ account: me, chain, transport: custom(eth) });
    const hash = await wallet.writeContract({
      address: b.distributor, abi: lotteryAbi, functionName: "collect",
      args: [
        d.id, holder,
        fixed ? 0n : BigInt(won!.start),
        fixed ? 0n : BigInt(won!.end),
        proof as Hex[], stocks,
      ],
      account: me, chain,
    });
    say(`sent: ${hash.slice(0, 10)}…`);
    await pub.waitForTransactionReceipt({ hash });
    say(`the prize is with ${short(holder)}. ${EXPLORER}/tx/${hash}`);
  } catch (e) {
    say("failed: " + String((e as Error).message).split("\n")[0]!.slice(0, 140));
  } finally {
    busy = false; paint();
  }
}
