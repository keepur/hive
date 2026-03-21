#!/usr/bin/env bash
set -euo pipefail

# Install Hive as a LaunchAgent (user scope).
# Generates plists, symlinks them into ~/Library/LaunchAgents, and bootstraps.
#
# Set HIVE_DEPLOY_DIR to override the working directory (default: ~/services/<instance-id>)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HIVE_ROOT="$(dirname "$SCRIPT_DIR")"

# Read instance ID from hive.yaml (falls back to "hive")
INSTANCE_ID=$(grep '^\s*id:' "$HIVE_ROOT/hive.yaml" 2>/dev/null | head -1 | awk '{print $2}')
[[ -z "$INSTANCE_ID" ]] && INSTANCE_ID="hive"

DEPLOY_DIR="${HIVE_DEPLOY_DIR:-$HOME/services/$INSTANCE_ID}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

LABEL="com.hive.${INSTANCE_ID}.agent"
LABEL_LOGS="com.hive.${INSTANCE_ID}.rotate-logs"
LABEL_DEPLOY="com.hive.${INSTANCE_ID}.deploy-check"

echo "Installing Hive LaunchAgents..."
echo "  Deploy dir: $DEPLOY_DIR"

# Generate plists pointing to the deploy directory
cd "$HIVE_ROOT"
HIVE_DEPLOY_DIR="$DEPLOY_DIR" npx tsx setup/generate-plist.ts

# Ensure LaunchAgents directory exists
mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload existing services if running (ignore errors if not loaded)
for lbl in "$LABEL" "$LABEL_LOGS" "$LABEL_DEPLOY"; do
  launchctl bootout "gui/$(id -u)/$lbl" 2>/dev/null || true
done

# Symlink plists into LaunchAgents
ln -sf "$HIVE_ROOT/service/$LABEL.plist" "$LAUNCH_AGENTS_DIR/$LABEL.plist"
ln -sf "$HIVE_ROOT/service/$LABEL_LOGS.plist" "$LAUNCH_AGENTS_DIR/$LABEL_LOGS.plist"
ln -sf "$HIVE_ROOT/service/$LABEL_DEPLOY.plist" "$LAUNCH_AGENTS_DIR/$LABEL_DEPLOY.plist"

# Ensure logs directory exists
mkdir -p "$DEPLOY_DIR/logs"

# Make rotate script executable
chmod +x "$HIVE_ROOT/service/rotate-logs.sh"
chmod +x "$HIVE_ROOT/service/deploy-check.sh"

# Bootstrap (load and start)
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL_LOGS.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/$LABEL_DEPLOY.plist"

echo ""
echo "✓ Hive service installed (LaunchAgent, user scope)"
echo "  Label:      $LABEL"
echo "  Working dir: $DEPLOY_DIR"
echo "  Logs:        $DEPLOY_DIR/logs/"
echo ""
echo "Manage with:"
echo "  launchctl kickstart -k gui/$(id -u)/$LABEL    # restart"
echo "  launchctl bootout gui/$(id -u)/$LABEL          # stop"
echo "  launchctl print gui/$(id -u)/$LABEL             # status"
