#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$HOME/services/hive"
DEV_DIR="$HOME/github/hive"

echo "Building in dev..."
cd "$DEV_DIR"
npm run build

echo "Pulling latest..."
cd "$DEPLOY_DIR"
git pull --ff-only

echo "Installing production dependencies..."
npm install --omit=dev

echo "Syncing build output from dev..."
rsync -a --delete "$DEV_DIR/dist/" "$DEPLOY_DIR/dist/"

echo "Syncing agents from dev..."
rsync -a --delete "$DEV_DIR/agents/" "$DEPLOY_DIR/agents/"

echo "Restarting service..."
launchctl kickstart -k "gui/$(id -u)/com.dodi.hive"

sleep 3
if tail -1 "$DEPLOY_DIR/logs/hive.log" | grep -q '"Hive is running"'; then
  echo "Deploy complete. Hive is running."
else
  echo "WARNING: Hive may not have started cleanly. Check logs:"
  tail -5 "$DEPLOY_DIR/logs/hive.log"
fi
