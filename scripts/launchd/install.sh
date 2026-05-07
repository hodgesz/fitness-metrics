#!/usr/bin/env bash
# Install the launchd daily-sync agent.
# Idempotent: safe to rerun after pulling updates.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.hodgesz.fitness-metrics-sync"
PLIST_SRC="$REPO_DIR/scripts/launchd/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/fitness-metrics"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Render plist with absolute paths. We write a real file (not a symlink) so
# launchd can read it even if the repo is on a volume that isn't mounted.
sed -e "s|__REPO__|$REPO_DIR|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$PLIST_SRC" > "$PLIST_DST"

chmod +x "$REPO_DIR/scripts/launchd/sync-wrapper.sh"

# Replace any existing loaded copy (bootout is a no-op if not loaded).
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Installed: $PLIST_DST"
echo "Logs:      $LOG_DIR/sync.log (stdout), $LOG_DIR/sync.err (stderr)"
echo "Next fire: daily at 05:00 local. To trigger manually:"
echo "    launchctl kickstart gui/$(id -u)/$LABEL"
