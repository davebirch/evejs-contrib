#!/usr/bin/env bash
# Builds the upstream-report-perf throughput scenario in <scratch> (made-up data). Usage: mkscen-tick.sh <scratch>
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: mkscen-tick.sh <scratch>" >&2; exit 64; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$1"
mkdir -p "$scratch" "$scratch/config"
node "$here/../fixtures/make-tick-scenario.js" "$scratch"
EVEJS_CONTRIB_CONFIG_DIR="$scratch/config" node "$here/../../skills/upstream-report/scripts/bundle.js" init "$scratch/bundle" --area fighter-tick --version 000000.1 --no-identity >/dev/null
: > "$scratch/names.txt"
: > "$scratch/hosts.txt"
echo "scenario ready in $scratch (set EVEJS_CONTRIB_CONFIG_DIR=$scratch/config in the agent's environment)"
