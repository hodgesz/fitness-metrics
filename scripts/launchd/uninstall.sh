#!/usr/bin/env bash
set -euo pipefail

LABEL="com.hodgesz.fitness-metrics-sync"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "Uninstalled: $PLIST_DST"
echo "(Log files at ~/Library/Logs/fitness-metrics/ left intact.)"
