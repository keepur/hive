#!/usr/bin/env bash
set -euo pipefail

BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"

cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }

echo "Checking for updates on deploy branch..."
git fetch origin deploy --quiet

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/deploy)

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  echo "Up to date ($LOCAL_SHA). Nothing to deploy."
  exit 0
fi

echo "New commits detected: $LOCAL_SHA -> $REMOTE_SHA"
echo "Starting deploy..."

DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
exec "$DEPLOY_DIR/service/deploy.sh"
