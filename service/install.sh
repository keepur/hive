#!/bin/bash
set -euo pipefail

PLIST_NAME="com.hive.orchestrator"
HIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="${HIVE_DIR}/service/${PLIST_NAME}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="${HIVE_DIR}/logs"

# Generate plist with correct paths if it doesn't exist
if [ ! -f "$PLIST_SRC" ]; then
  echo "Generating launchd plist..."
  cd "$HIVE_DIR"
  npx tsx setup/generate-plist.ts
fi

echo "Building Hive..."
cd "$HIVE_DIR"
npm run build

echo "Creating log directory..."
mkdir -p "$LOG_DIR"

echo "Installing launchd service..."
cp "$PLIST_SRC" "$PLIST_DST"

echo "Loading service..."
launchctl bootout "gui/$(id -u)/${PLIST_NAME}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo ""
echo "Hive service installed and running."
echo "  Logs: $LOG_DIR"
echo "  Stop: launchctl bootout gui/$(id -u)/${PLIST_NAME}"
echo "  Status: launchctl print gui/$(id -u)/${PLIST_NAME}"
