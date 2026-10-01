#!/usr/bin/env bash
# The liquidity the Treasury adds is permanent, and this is what keeps it that
# way. There is no NFT to burn and no locker contract: the guarantee IS that no
# code path removes the position. A guarantee made of absence needs a test that
# fails when the absence ends.
#
# Run from the repo root. Wire it into CI and into .git/hooks/pre-commit.
set -euo pipefail
f=contracts/Treasury.sol
fail=0

# 1. Exactly one call site. A second one is not necessarily a removal -- but it
#    is a decision nobody should be able to make without this failing first.
n=$(grep -c 'POOL_MANAGER.modifyLiquidity' "$f")
if [ "$n" -ne 1 ]; then
  echo "FAIL: $n modifyLiquidity call sites in $f, expected 1"; fail=1
fi

# 2. Its delta is a widened unsigned value, so it cannot be negative. Anything
#    else -- a unary minus, a signed local, an int cast of something signed --
#    means liquidity can now leave.
if ! grep -q 'liquidityDelta: int256(uint256(_adding.liquidity))' "$f"; then
  echo "FAIL: the liquidityDelta is no longer a widened uint128."
  grep -n 'liquidityDelta' "$f" | sed 's/^/      /'
  fail=1
fi

# 3. No negative-delta idiom anywhere in the file.
if grep -nE 'liquidityDelta: *-|liquidityDelta: *int256\(-|-int256\(uint256\(_adding' "$f"; then
  echo "FAIL: a negative liquidityDelta appears in $f"; fail=1
fi

[ "$fail" -eq 0 ] && echo "ok: the Treasury's liquidity position has no exit" || exit 1
