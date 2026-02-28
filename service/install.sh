#!/bin/bash
set -euo pipefail

PLIST_NAME="com.hive.orchestrator"
PLIST_SRC="$(dirname "$0")/${PLIST_NAME}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/hive/logs"

echo "Building Hive..."
cd "$(dirname "$0")/.."
npm run build

echo "Creating log directory..."
mkdir -p "$LOG_DIR"

echo "Installing launchd service..."
cp "$PLIST_SRC" "$PLIST_DST"

echo "Loading service..."
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "Hive service installed and running."
echo "  Logs: $LOG_DIR"
echo "  Stop: launchctl bootout gui/$(id -u)/${PLIST_NAME}"
echo "  Status: launchctl print gui/$(id -u)/${PLIST_NAME}"
