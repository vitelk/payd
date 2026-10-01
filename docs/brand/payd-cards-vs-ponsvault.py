#!/usr/bin/env python3
"""Build the three vs-PonsVault cards, in the brand of docs/brand/payd-card-compare.svg."""
import re, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
BRAND = ROOT / "docs/brand"
SRC = (BRAND / "payd-card-compare.svg").read_text()
MARK = re.search(r"  <!-- the mark.*?</g>\n", SRC, re.S).group(0)

BG, PANEL, INK, MUTED, ACCENT, RULE = "#14130f", "#1b1a15", "#eeebe3", "#97917f", "#ccff00", "#2c2a24"
SANS = "ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', Menlo, monospace"


def head(alt, title_a, title_b, kicker):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img"
     aria-label="{alt}">
  <rect width="1200" height="630" fill="{BG}"/>

{MARK}
  <text x="164" y="116" font-family="{SANS}" font-size="52" font-weight="600"
        letter-spacing="-0.8" fill="{INK}">Payd<tspan dx="14" font-family="{MONO}" font-size="17"
        font-weight="500" letter-spacing="6.5" fill="{ACCENT}">PROTOCOL</tspan></text>

  <text x="64" y="192" font-family="{SANS}" font-size="38" font-weight="600"
        letter-spacing="-0.6" fill="{INK}">{title_a}<tspan dx="12" fill="{ACCENT}">{title_b}</tspan></text>
  <text x="64" y="218" font-family="{MONO}" font-size="14" letter-spacing="1.3" fill="{MUTED}">{kicker}</text>
"""


FOOT = f"""
  <path d="M64 600 H1136" stroke="{RULE}" stroke-width="1"/>
  <text x="64" y="622" font-family="{MONO}" font-size="16" fill="{ACCENT}">paydprotocol.eth</text>
  <text x="1136" y="622" text-anchor="end" font-family="{MONO}" font-size="13"
        letter-spacing="1.1" fill="{MUTED}">EVERY PONSVAULT LINE READ ON PONSVAULT.COM/DOCS, 28 SEP 2026</text>
</svg>
"""

# ---------------------------------------------------------------- card 1: the table
ROWS = [
    ("Who can change your vault's code",
     ["Nobody. An immutable clone — no", "proxy, no owner. We cannot patch it."],
     ["A shared beacon: one owner, every", "live vault at once. Renouncing it is", "possible, not done."]),
    ("What a share measures",
     ["Time held. ∫ balance dt / L over", "the whole 30-minute epoch."],
     ["The balance at the instant a round", "opens. One moment."]),
    ("What the fee buys",
     ["A basket of 2 to 8 stocks, weights", "in bps. A halted one is skipped."],
     ["One stock, picked at launch."]),
    ("An unclaimed share",
     ["Cumulative, never expires, and", "pushed to you at about $10."],
     ["Claimable for a fixed window, then", "it rolls into the next round."]),
    ("Where the lottery gets its number",
     ["A drand beacon verified on-chain.", "It does not exist when tickets close."],
     ["Commit–reveal."]),
]

def card_table():
    s = head("Payd against PonsVault, read 28 September 2026. Who can change your vault's code: on Payd nobody, the vault is an immutable clone with no proxy and no owner, and Payd itself cannot patch it; on PonsVault a shared beacon lets one owner replace the code in every live vault at once, and renouncing that power is possible but not done. What a share measures: on Payd the time held, the integral of balance over the whole 30-minute epoch; on PonsVault the balance at the instant a round opens. What the fee buys: on Payd a basket of 2 to 8 stocks weighted in basis points, a halted one skipped; on PonsVault one stock picked at launch. An unclaimed share: on Payd cumulative, never expiring, pushed to the holder at about ten dollars; on PonsVault claimable for a fixed window, then it rolls into the next round. Where the lottery gets its number: on Payd a drand beacon verified on-chain that does not exist when tickets close; on PonsVault commit and reveal.",
             "Same shelf.", "Different guarantees.",
             "PAYD PROTOCOL AGAINST PONSVAULT &#183; ROBINHOOD CHAIN")
    s += f'\n  <rect x="440" y="236" width="330" height="348" fill="{PANEL}"/>\n'
    s += f'  <text x="456" y="264" font-family="{MONO}" font-size="20" font-weight="500" letter-spacing="1.5" fill="{ACCENT}">PAYD</text>\n'
    s += f'  <text x="820" y="264" font-family="{MONO}" font-size="20" font-weight="500" letter-spacing="1.5" fill="{MUTED}">PONSVAULT</text>\n'
    s += f'  <path d="M64 278 H1136" stroke="{RULE}" stroke-width="1"/>\n'
    s += f'\n  <g font-family="{SANS}" font-size="15" fill="{INK}">\n'
    y = 308
    for label, ours, theirs in ROWS:
        s += f'    <text x="64" y="{y}" font-size="15" fill="{MUTED}">{label}</text>\n'
        for i, line in enumerate(ours):
            s += f'    <text x="456" y="{y + i * 19}">{line}</text>\n'
        for i, line in enumerate(theirs):
            s += f'    <text x="820" y="{y + i * 19}" fill="{MUTED}">{line}</text>\n'
        y += 19 * max(len(ours), len(theirs)) + 22
    s += "  </g>\n"
    return s + FOOT


# ---------------------------------------------------------------- card 2: the snapshot
def curve(x0, y0, w, h):
    """A holder's balance across one epoch: flat, a buy, a sell near the end."""
    pts = [(0.00, 0.30), (0.18, 0.30), (0.18, 0.78), (0.62, 0.78), (0.62, 0.42), (1.00, 0.42)]
    return [(x0 + px * w, y0 + h - py * h) for px, py in pts]


def path_of(pts):
    return "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)


def card_snapshot():
    s = head("How a share is measured. On the left, PonsVault: a round freezes its share table the instant it opens, so a holder's share is one vertical reading of their balance at that moment, and a wallet that holds for a single block is in the photograph. On the right, Payd: the share is the integral of balance over time divided by the epoch length, the whole shaded area under the balance curve across a 30-minute epoch, so a holder is paid for the seconds they actually held.",
             "A photograph,", "or the whole film.",
             "HOW A SHARE IS MEASURED &#183; ONE HOLDER, ONE EPOCH")
    for i, (title, colour, mode) in enumerate([("PONSVAULT &#8212; THE ROUND FREEZES HERE", MUTED, "snap"),
                                               ("PAYD &#8212; &#8747; balance dt / L", ACCENT, "area")]):
        x0 = 64 + i * 556
        s += f'\n  <rect x="{x0}" y="252" width="516" height="300" fill="{PANEL}"/>\n'
        s += f'  <text x="{x0 + 24}" y="290" font-family="{MONO}" font-size="16" letter-spacing="1.2" fill="{colour}">{title}</text>\n'
        gx, gy, gw, gh = x0 + 24, 318, 468, 150
        pts = curve(gx, gy, gw, gh)
        base = gy + gh
        if mode == "area":
            area = path_of(pts) + f" L {gx + gw:.1f} {base} L {gx} {base} Z"
            s += f'  <path d="{area}" fill="{ACCENT}" fill-opacity="0.28"/>\n'
        else:
            sx = pts[2][0]
            s += f'  <path d="M {sx:.1f} {gy} V {base}" stroke="{MUTED}" stroke-width="2" stroke-dasharray="5 5"/>\n'
            s += f'  <circle cx="{sx:.1f}" cy="{pts[2][1]:.1f}" r="7" fill="{MUTED}"/>\n'
        s += f'  <path d="{path_of(pts)}" fill="none" stroke="{INK}" stroke-width="2.5" stroke-linejoin="round"/>\n'
        s += f'  <path d="M {gx} {base} H {gx + gw}" stroke="{RULE}" stroke-width="1"/>\n'
        if mode == "snap":
            s += f'  <text x="{pts[2][0]:.0f}" y="{base + 22}" text-anchor="middle" font-family="{MONO}" font-size="12" letter-spacing="1" fill="{MUTED}">THE READING</text>\n'
        else:
            s += f'  <text x="{gx}" y="{base + 22}" font-family="{MONO}" font-size="12" letter-spacing="1" fill="{MUTED}">THE WINDOW OPENS</text>\n'
        s += f'  <text x="{gx + gw}" y="{base + 22}" text-anchor="end" font-family="{MONO}" font-size="12" letter-spacing="1" fill="{MUTED}">30 MIN</text>\n'
        cap = (["One vertical reading. Hold for a single block", "at the right moment and you are in the picture."] if mode == "snap"
               else ["The whole area. You are paid for the seconds", "you actually held, and for nothing else."])
        for j, line in enumerate(cap):
            s += f'  <text x="{x0 + 24}" y="{522 + j * 20}" font-family="{SANS}" font-size="15" fill="{INK if mode == "area" else MUTED}">{line}</text>\n'
    return s + FOOT


# ---------------------------------------------------------------- card 3: beacon vs clone
def card_upgrade():
    s = head("Who can replace the code after your launch. On the left, PonsVault: every vault points at one shared beacon, so the beacon's owner replaces the code inside all of them at once, and renouncing that power is possible but not done. On the right, Payd: each vault is an immutable clone of a fixed implementation with no proxy and no owner, so nobody can replace its code, Payd included. The only exit is migrate, one vault at a time, under a 48-hour timelock, refusing a destination of another mode.",
             "One key, or", "no key at all.",
             "WHO CAN REPLACE THE CODE AFTER YOUR LAUNCH")
    for i, side in enumerate(["beacon", "clone"]):
        x0 = 64 + i * 556
        s += f'\n  <rect x="{x0}" y="252" width="516" height="300" fill="{PANEL}"/>\n'
        title = "PONSVAULT &#8212; A SHARED BEACON" if side == "beacon" else "PAYD &#8212; IMMUTABLE CLONES"
        colour = MUTED if side == "beacon" else ACCENT
        s += f'  <text x="{x0 + 24}" y="290" font-family="{MONO}" font-size="16" letter-spacing="1.2" fill="{colour}">{title}</text>\n'
        vy = 424
        xs = [x0 + 60 + k * 120 for k in range(4)]
        if side == "beacon":
            bx = x0 + 258
            s += f'  <rect x="{bx - 84}" y="324" width="168" height="44" fill="none" stroke="{MUTED}" stroke-width="2"/>\n'
            s += f'  <text x="{bx}" y="352" text-anchor="middle" font-family="{MONO}" font-size="15" letter-spacing="1.2" fill="{MUTED}">BEACON OWNER</text>\n'
            for x in xs:
                s += f'  <path d="M {bx} 368 L {bx} 396 L {x + 40} 396 L {x + 40} {vy}" fill="none" stroke="{MUTED}" stroke-width="1.5"/>\n'
                s += f'  <path d="M {x + 34} {vy - 8} L {x + 40} {vy} L {x + 46} {vy - 8}" fill="none" stroke="{MUTED}" stroke-width="1.5"/>\n'
        else:
            bx = x0 + 258
            s += f'  <rect x="{bx - 84}" y="324" width="168" height="44" fill="none" stroke="{RULE}" stroke-width="2" stroke-dasharray="6 6"/>\n'
            s += f'  <text x="{bx}" y="352" text-anchor="middle" font-family="{MONO}" font-size="15" letter-spacing="1.2" fill="{RULE}">NO OWNER</text>\n'
            s += f'  <text x="{bx}" y="404" text-anchor="middle" font-family="{MONO}" font-size="13" letter-spacing="1.2" fill="{ACCENT}">NOTHING POINTS AT THEM</text>\n'
        for x in xs:
            stroke = MUTED if side == "beacon" else ACCENT
            s += f'  <rect x="{x}" y="{vy}" width="80" height="54" fill="none" stroke="{stroke}" stroke-width="2"/>\n'
            s += f'  <text x="{x + 40}" y="{vy + 33}" text-anchor="middle" font-family="{MONO}" font-size="13" letter-spacing="1" fill="{INK}">VAULT</text>\n'
        cap = (["One owner replaces the code inside every live", "vault at once. Renouncing it is possible, not done."] if side == "beacon"
               else ["Each vault is its own bytecode, for ever. Nobody", "can replace it — us included. That is the trade."])
        for j, line in enumerate(cap):
            s += f'  <text x="{x0 + 24}" y="{522 + j * 20}" font-family="{SANS}" font-size="15" fill="{MUTED if side == "beacon" else INK}">{line}</text>\n'
    return s + FOOT


for name, svg in [("payd-card-vs-ponsvault", card_table()),
                  ("payd-card-snapshot", card_snapshot()),
                  ("payd-card-upgrade", card_upgrade())]:
    (BRAND / f"{name}.svg").write_text(svg)
    print("wrote", name + ".svg", len(svg), "bytes")
