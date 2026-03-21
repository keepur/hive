#!/usr/bin/env bash
set -euo pipefail

BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"

# Read instance ID for deploy dir default
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_ID=$(grep -A1 '^instance:' "$SCRIPT_DIR/../hive.yaml" 2>/dev/null | grep 'id:' | awk '{print $2}' || echo "hive")
[[ -z "$INSTANCE_ID" ]] && INSTANCE_ID="hive"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/$INSTANCE_ID}"

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

exec "$DEPLOY_DIR/service/deploy.sh"
