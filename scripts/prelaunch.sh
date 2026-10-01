#!/usr/bin/env bash
# Derives the pre-launch shop window FROM the live one.
#
# Not a second hand-written page: a copy drifts, and the copy that drifts is
# always the one nobody is looking at. `site/index.html` stays the single source
# of what the project says; this only does what the state of the chain requires.
#
#   scripts/prelaunch.sh site/index.html > public/index.html
#
# Three transforms, and each one exists because the page would otherwise LIE:
#
#   1. an unmissable banner: nothing is deployed, nothing is for sale, and any
#      address circulating today is not ours;
#   2. the six contract rows say "not deployed" instead of rendering the literal
#      text `{{REGISTRY}}`, and their "verified" badge becomes "pending" --
#      claiming verification for a contract that does not exist is the worst
#      sentence on the page;
#   3. the three call-to-action links drop `?registry={{REGISTRY}}` and point at
#      `/app/`, which before the deployment serves `soon/`.
set -euo pipefail
SRC="${1:-site/index.html}"
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

python3 - "$SRC" <<'PY'
import sys, re, pathlib
s = pathlib.Path(sys.argv[1]).read_text()

BANNER = '''
<style>
  .prelaunch { border:1px solid var(--acc); border-radius:10px; background:var(--sunk);
               padding:1.25rem 1.35rem; margin:1.6rem 0 0; }
  .prelaunch h2 { font:600 .68rem/1 var(--mono); letter-spacing:.16em; text-transform:uppercase;
                  color:var(--acc); margin:0 0 .75rem; }
  .prelaunch p { margin:0 0 .6rem; }
  .prelaunch p:last-child { margin-bottom:0; }
</style>
<div class="wrap"><div class="prelaunch">
  <h2>Nothing is deployed</h2>
  <p><b>There is no token and no contract address.</b> Nothing has been launched, so there is
  nothing to buy and no sale of any kind &mdash; no allocation, no whitelist, no presale.</p>
  <p><b>Any address circulating today is not ours.</b> Everything below describes what the
  contracts do; when they exist, their addresses appear on this page and their source is
  verified on the block explorer, so anybody can read them before touching them.</p>
</div></div>
'''

# 1. the banner, immediately after the nav
i = s.index('</nav>') + len('</nav>')
s = s[:i] + BANNER + s[i:]

# 2. the address rows: no literal placeholder, and no claim of verification
s = re.sub(r'\{\{(REGISTRY|FACTORY|TREASURY|COLLECTOR|TIMELOCK|PAYD_VAULT)\}\}', 'not deployed', s)
s = s.replace('<span class="s">verified</span>', '<span class="s">pending</span>')

# 3. the CTAs: no registry parameter to carry
s = s.replace('https://paydprotocol.eth.limo/app/?registry=not deployed',
              'https://paydprotocol.eth.limo/app/')

# and the title, so a tab and a shared link say the state too
s = s.replace('<title>', '<title>Not deployed yet &mdash; ', 1)

assert '{{' not in s, "a placeholder survived the transform"
assert 'not deployed' in s, "the transform did nothing"
sys.stdout.write(s)
PY
