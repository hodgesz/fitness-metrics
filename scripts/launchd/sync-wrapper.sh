#!/usr/bin/env bash
# Wrapper invoked by launchd. Runs `fm sync`, notifies on failure, never
# exits non-zero itself (we don't want launchd to KeepAlive-retry us).
set -u
set -o pipefail

REPO_DIR="${FITNESS_METRICS_REPO:-$HOME/VsCodeProjects/fitness-metrics}"
UV_BIN="${UV_BIN:-/opt/homebrew/bin/uv}"
SKIP_WITHIN="${SKIP_IF_WITHIN_MINUTES:-360}"

cd "$REPO_DIR" || {
    osascript -e 'display notification "Repo not found" with title "fitness-metrics sync"' || true
    exit 0
}

echo "--- $(date '+%Y-%m-%d %H:%M:%S %Z') launchd sync start ---"
if "$UV_BIN" run fm sync --skip-if-within "$SKIP_WITHIN"; then
    echo "--- sync ok ---"
else
    rc=$?
    echo "--- sync FAILED (rc=$rc) ---"
    osascript -e "display notification \"sync failed (rc=$rc) — check ~/Library/Logs/fitness-metrics/\" with title \"fitness-metrics\"" || true
fi
