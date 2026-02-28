#!/bin/bash
set -euo pipefail

PLIST_NAME="com.hive.orchestrator"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "Stopping Hive service..."
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null || true

echo "Removing plist..."
rm -f "$PLIST_DST"

echo "Hive service uninstalled."
