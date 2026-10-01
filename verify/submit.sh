#!/usr/bin/env bash
# Submits the five payout-mode contracts to Etherscan, for chain 4663.
#
# **Why this is a curl script and not `forge verify-contract`.** Forge has no
# built-in Etherscan URL for chain 4663, so it needs `--verifier-url` — and
# forge 1.7.1 then ignores `--etherscan-api-key` and refuses for want of a key
# it was just handed. `--chain robin` does not help either: `--chain` only takes
# aliases it already knows, and an `[etherscan]` block in `foundry.toml` is
# matched by alias, so it is never reached for an unknown chain id. Tried, all
# of it, 2026-09-15. The API itself is fine; only forge's path to it is not.
#
# The endpoint is Etherscan's **V2 multichain** API. `robin.etherscan.io` is the
# UI and sits behind Cloudflare; `api.robin.etherscan.io` does not resolve.
#
#   set -a && source .env && set +a && ./verify/submit.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API="https://api.etherscan.io/v2/api?chainid=4663"
SOLC="v0.8.26+commit.8a97fa7a"
: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY (see .env)}"

arg() { grep "^$1" verify/constructor-args.txt | cut -f2 | sed 's/^0x//'; }

submit() { # name, address, path:Name, constructor args (hex, no 0x, may be empty)
  # **A missing input must not hide everything after it.** `set -e` plus a
  # curl that cannot read its file killed this script at BackingFactory --
  # whose JSON had never been committed -- so LotteryFactory and the whole
  # portfolio block below were never submitted, and the run LOOKED like it had
  # only one problem. Skipped and named instead.
  if [ ! -f "verify/$1.json" ]; then
    printf '%-19s %s\n' "$1" "skipped: verify/$1.json is missing -- see README"
    return 0
  fi
  local extra=(); [ -n "$4" ] && extra=(--data-urlencode "constructorArguements=$4")
  printf '%-19s ' "$1"
  curl -s --max-time 180 -X POST "$API" \
    --data-urlencode "module=contract"   --data-urlencode "action=verifysourcecode" \
    --data-urlencode "apikey=$ETHERSCAN_API_KEY" \
    --data-urlencode "contractaddress=$2" \
    --data-urlencode "sourceCode@verify/$1.json" \
    --data-urlencode "codeformat=solidity-standard-json-input" \
    --data-urlencode "contractname=$3"   --data-urlencode "compilerversion=$SOLC" \
    "${extra[@]}"
  echo; sleep 3
}

# The implementations first: a verified factory pointing at an unreadable
# VAULT_IMPL proves nothing, and that immutable is the whole of what the
# generation key is asked to approve.
submit BackingRedeemer    0x9DB31071bd09e058e30FcEdbed695E2787b01510 contracts/backing/BackingRedeemer.sol:BackingRedeemer ""
submit LotteryDistributor 0xa19ea405F5E484949265C8d69C6BB1219da5c6c0 contracts/lottery/LotteryDistributor.sol:LotteryDistributor ""
submit TontineFactory     0xba92F9CF3E7e39975F3423CF980AFB3290E9D10b contracts/tontine/TontineFactory.sol:TontineFactory "$(arg TontineFactory)"
submit BackingFactory     0x6730b49592C2401Da4B303D4BD7F0f20CB978888 contracts/backing/BackingFactory.sol:BackingFactory "$(arg BackingFactory)"
submit LotteryFactory     0xd97c82f41EBA1FE49c41AAb7121034A73d2D08d9 contracts/lottery/LotteryFactory.sol:LotteryFactory "$(arg LotteryFactory)"

# The portfolio mode, NOT YET DEPLOYED. Its three standard-JSON inputs are
# already in this directory — they are a function of the source and the
# compiler settings, not of any address, so they can be built before the
# deployment and checked into the repository with everything else.
#
# What cannot be: the addresses, and the factory's constructor arguments. Fill
# both on deploy night from the broadcast receipt — the addresses here, the
# args into `constructor-args.txt` — and confirm each argument is the literal
# suffix of its creation transaction's input, which is what was done for the
# five above and is why they are trustworthy.
#
# **Unset, this block skips rather than posting a wrong address**, so the
# script stays runnable for the five that ARE deployed.
if [ -n "${PORTFOLIO_VAULT_IMPL:-}" ]; then
  submit PortfolioVault       "$PORTFOLIO_VAULT_IMPL" contracts/portfolio/PortfolioVault.sol:PortfolioVault ""
  submit PortfolioDistributor "$PORTFOLIO_DIST_IMPL"  contracts/portfolio/PortfolioDistributor.sol:PortfolioDistributor ""
  submit PortfolioFactory     "$PORTFOLIO_FACTORY"    contracts/portfolio/PortfolioFactory.sol:PortfolioFactory "$(arg PortfolioFactory)"
else
  echo "portfolio           skipped: set PORTFOLIO_VAULT_IMPL / _DIST_IMPL / _FACTORY once it is deployed"
fi

echo
echo "Poll a job:   curl -s \"\$API&module=contract&action=checkverifystatus&guid=<guid>&apikey=\$ETHERSCAN_API_KEY\""
echo "Or the state: curl -s \"\$API&module=contract&action=getsourcecode&address=<addr>&apikey=\$ETHERSCAN_API_KEY\""
