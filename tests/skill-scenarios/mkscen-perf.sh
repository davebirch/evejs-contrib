#!/usr/bin/env bash
# Builds the whole upstream-report-perf scenario in <scratch> (made-up data). Usage: mkscen-perf.sh <scratch>
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: mkscen-perf.sh <scratch>" >&2; exit 64; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures="$here/../fixtures"
scratch="$1"
mkdir -p "$scratch" "$scratch/config"
node "$fixtures/make-mini-repo.js" "$scratch/evejs"
node "$fixtures/make-perf-scenario.js" "$scratch"
echo "scenario ready in $scratch (set EVEJS_CONTRIB_CONFIG_DIR=$scratch/config in the agent's environment)"
