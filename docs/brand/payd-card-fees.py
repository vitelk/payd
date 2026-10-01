#!/usr/bin/env python3
"""Build the fees-to-holders card, in the brand of docs/brand/payd-card-compare.svg.

Fee-rate neutral on purpose: a share of the fees COLLECTED, never a share of
volume, because a launch with a higher tax wins "per $100 traded" by charging
traders more, not by paying holders better.

Figures read 30 Sep 2026 ~12:40 UTC. Payd: on-chain — 279 Harvested events of
vault 0x4DBA57f2… (4.7062 ETH gross) and Distributor.totalFunded priced on its
v3 pools ($9,262), both at ETH $2,723.56. PonsVault: its own undocumented API,
ponsvault.com/api/pons/protocol-stats (.dividends, .volume.harvestedUsd), not
verifiable on-chain. Re-measure every figure before re-rendering.
"""
import re, pathlib

BRAND = pathlib.Path(__file__).resolve().parent
SRC = (BRAND / "payd-card-compare.svg").read_text()
MARK = re.search(r"  <!-- the mark.*?</g>\n", SRC, re.S).group(0)

BG, PANEL, INK, MUTED, ACCENT, RULE = "#14130f", "#1b1a15", "#eeebe3", "#97917f", "#ccff00", "#2c2a24"
SANS = "ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', Menlo, monospace"

ALT = ("A bar chart, Robinhood Chain, read 30 September 2026: of every dollar of fees harvested, "
       "what was paid out to holders. Payd 72 cents: 9,262 dollars paid on 12,850 dollars harvested, "
       "read on-chain. PonsVault 50 cents: 670 thousand dollars paid on 1.33 million harvested, from "
       "its own stats API.")

# (label, cents, sub, ours)
ROWS = [("PAYD", 72, "$9,262 paid on $12,850 harvested · read on-chain", True),
        ("PONSVAULT", 50, "$670K paid on $1.33M harvested · from its own stats API", False)]

X0, W = 64, 1072
BAR_X, BAR_W = X0 + 190, 700


def rows():
    s = f'  <rect x="{X0}" y="244" width="{W}" height="334" fill="{PANEL}"/>\n'
    s += f'  <text x="{X0 + 24}" y="284" font-family="{MONO}" font-size="15" letter-spacing="1.5" fill="{MUTED}">OF EVERY $1 OF FEES HARVESTED, PAID OUT TO HOLDERS</text>\n'
    y = 330
    for label, cents, sub, ours in ROWS:
        ink = ACCENT if ours else MUTED
        s += f'  <text x="{X0 + 24}" y="{y + 36}" font-family="{MONO}" font-size="18" letter-spacing="1.8" fill="{ink}">{label}</text>\n'
        s += f'  <rect x="{BAR_X}" y="{y + 12}" width="{BAR_W}" height="34" fill="{RULE}"/>\n'
        s += f'  <rect x="{BAR_X}" y="{y + 12}" width="{BAR_W * cents / 100:.1f}" height="34" fill="{ink}"/>\n'
        s += f'  <text x="{X0 + W - 24}" y="{y + 46}" text-anchor="end" font-family="{SANS}" font-size="{58 if ours else 44}" font-weight="600" fill="{ACCENT if ours else INK}">{cents}¢</text>\n'
        s += f'  <text x="{BAR_X}" y="{y + 76}" font-family="{SANS}" font-size="15" fill="{MUTED}">{sub}</text>\n'
        y += 120
    return s


svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img"
     aria-label="{ALT}">
  <rect width="1200" height="630" fill="{BG}"/>

{MARK}
  <text x="164" y="116" font-family="{SANS}" font-size="52" font-weight="600"
        letter-spacing="-0.8" fill="{INK}">Payd<tspan dx="14" font-family="{MONO}" font-size="17"
        font-weight="500" letter-spacing="6.5" fill="{ACCENT}">PROTOCOL</tspan></text>

  <text x="64" y="192" font-family="{SANS}" font-size="38" font-weight="600"
        letter-spacing="-0.6" fill="{INK}">Same fees.<tspan dx="12" fill="{ACCENT}">More of them reach holders.</tspan></text>
  <text x="64" y="220" font-family="{MONO}" font-size="14" letter-spacing="1.3" fill="{MUTED}">PAYD PROTOCOL AGAINST PONSVAULT &#183; ROBINHOOD CHAIN</text>

{rows()}
  <path d="M64 600 H1136" stroke="{RULE}" stroke-width="1"/>
  <text x="64" y="622" font-family="{MONO}" font-size="16" fill="{ACCENT}">paydprotocol.eth</text>
  <text x="1136" y="622" text-anchor="end" font-family="{MONO}" font-size="13"
        letter-spacing="1.1" fill="{MUTED}">READ 30 SEP 2026 &#183; ETH AT $2,724</text>
</svg>
"""
(BRAND / "payd-card-fees.svg").write_text(svg)
print("wrote payd-card-fees.svg", len(svg), "bytes")
