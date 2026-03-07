#!/usr/bin/env bash
set -euo pipefail

# Install Hive as a LaunchAgent (user scope).
# Generates plists, symlinks them into ~/Library/LaunchAgents, and bootstraps.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HIVE_ROOT="$(dirname "$SCRIPT_DIR")"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

LABEL="com.hive.agent"
LABEL_LOGS="com.hive.rotate-logs"

echo "Installing Hive LaunchAgents..."

# Generate plists with correct paths for this machine
cd "$HIVE_ROOT"
npx tsx setup/generate-plist.ts

# Ensure LaunchAgents directory exists
mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload existing services if running (ignore errors if not loaded)
for lbl in "$LABEL" "$LABEL_LOGS"; do
  launchctl bootout "gui/$(id -u)/$lbl" 2>/dev/null || true
done

# Symlink plists into LaunchAgents
ln -sf "$SCRIPT_DIR/$LABEL.plist" "$LAUNCH_AGENTS_DIR/$LABEL.plist"
ln -sf "$SCRIPT_DIR/$LABEL_LOGS.plist" "$LAUNCH_AGENTS_DIR/$LABEL_LOGS.plist"

# Ensure logs directory exists
mkdir -p "$HIVE_ROOT/logs"

# Make rotate script executable
chmod +x "$SCRIPT_DIR/rotate-logs.sh"

# Bootstrap (load and start)
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL_LOGS.plist"

echo ""
echo "✓ Hive service installed (LaunchAgent, user scope)"
echo "  Label:   $LABEL"
echo "  Logs:    $HIVE_ROOT/logs/"
echo ""
echo "Manage with:"
echo "  launchctl kickstart -k gui/$(id -u)/$LABEL    # restart"
echo "  launchctl bootout gui/$(id -u)/$LABEL          # stop"
echo "  launchctl print gui/$(id -u)/$LABEL             # status"
