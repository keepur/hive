#!/usr/bin/env bash
set -euo pipefail

# --- Configuration ---
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"

# --- Dry-run flag (must be before .env sourcing) ---
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# Source .env from deploy dir for SLACK_BOT_TOKEN and DEVOPS_CHANNEL_ID
# shellcheck source=/dev/null
source "$DEPLOY_DIR/.env"
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN not set in .env}"
: "${DEVOPS_CHANNEL_ID:?DEVOPS_CHANNEL_ID not set in .env}"

# --- Helper: Run or echo a command ---
run_cmd() {
  if $DRY_RUN; then
    echo "[DRY RUN] $*"
  else
    "$@"
  fi
}

# --- Helper: Slack notification ---
notify() {
  local message="$1"
  if $DRY_RUN; then
    echo "[DRY RUN] notify: $message"
    return
  fi
  local payload
  payload=$(jq -n --arg channel "$DEVOPS_CHANNEL_ID" --arg text "$message" \
    '{channel: $channel, text: $text}')
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    > /dev/null
}

# --- Helper: Health check with retry ---
health_check() {
  if $DRY_RUN; then
    echo "[DRY RUN] health_check: would check $DEPLOY_DIR/logs/hive.log"
    return 0
  fi
  local log_file="$DEPLOY_DIR/logs/hive.log"
  for _ in $(seq 1 30); do
    sleep 1
    if tail -5 "$log_file" | grep -q '"Hive is running"'; then
      return 0
    fi
  done
  return 1
}

# --- Helper: Rollback ---
rollback() {
  local prev_sha="$1"
  echo "Rolling back..."

  if [[ -d "$DEPLOY_DIR/dist.bak" ]]; then
    run_cmd rm -rf "$DEPLOY_DIR/dist"
    run_cmd mv "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/dist"
  fi

  if [[ -d "$DEPLOY_DIR/agents.bak" ]]; then
    run_cmd rm -rf "$DEPLOY_DIR/agents"
    run_cmd mv "$DEPLOY_DIR/agents.bak" "$DEPLOY_DIR/agents"
  fi

  echo "Restarting service with previous version..."
  run_cmd launchctl kickstart -k "gui/$(id -u)/com.hive.agent"

  if health_check; then
    notify "Deploy failed (health check). Rolled back to \`$prev_sha\`. Hive is running on previous version."
    echo "Rollback succeeded."
  else
    notify "Deploy failed AND rollback failed. Manual intervention required. Previous SHA: \`$prev_sha\`."
    echo "CRITICAL: Rollback failed. Manual intervention required."
  fi
  exit 1
}

# --- Main ---
echo "=== Hive Deploy ==="

# 1. Record current deployed SHA
cd "$DEPLOY_DIR"
PREV_SHA=$(git rev-parse --short HEAD)
echo "Current deployed SHA: $PREV_SHA"

# 2. Pull latest in build dir
echo "Pulling latest in build dir..."
cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }
run_cmd git pull --ff-only

DEPLOY_SHA=$(git rev-parse --short HEAD)
DEPLOY_MSG=$(git log -1 --pretty=%s)

# 3. Install full deps (for checks + build)
echo "Installing dependencies..."
if ! run_cmd npm install; then
  notify "Deploy aborted. \`npm install\` failed. No changes applied. Commit: \`$DEPLOY_SHA\`."
  echo "Dependency install failed. Deploy aborted."
  exit 1
fi

# 4. Run checks
echo "Running checks..."
if ! run_cmd npm run check; then
  notify "Deploy aborted. \`npm run check\` failed. No changes applied. Commit: \`$DEPLOY_SHA\`."
  echo "Checks failed. Deploy aborted."
  exit 1
fi

# 5. Build
echo "Building..."
if ! run_cmd npm run build; then
  notify "Deploy aborted. Build failed. No changes applied. Commit: \`$DEPLOY_SHA\`."
  echo "Build failed. Deploy aborted."
  exit 1
fi

# 6. Generate agents
echo "Generating agents..."
if ! run_cmd npm run setup:agents; then
  notify "Deploy aborted. Agent generation failed. No changes applied. Commit: \`$DEPLOY_SHA\`."
  echo "Agent generation failed. Deploy aborted."
  exit 1
fi

# 7. Prepare deploy dir
echo "Preparing deploy dir..."
cd "$DEPLOY_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Deploy dir not on deploy branch"; exit 1; }
run_cmd git pull --ff-only
run_cmd npm install --omit=dev

# 8. Backup current dist and agents
run_cmd rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak"
run_cmd cp -a "$DEPLOY_DIR/dist" "$DEPLOY_DIR/dist.bak" 2>/dev/null || true
run_cmd cp -a "$DEPLOY_DIR/agents" "$DEPLOY_DIR/agents.bak" 2>/dev/null || true

# 9. Rsync built artifacts
echo "Syncing build output..."
run_cmd rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"
run_cmd rsync -a --delete "$BUILD_DIR/agents/" "$DEPLOY_DIR/agents/"

# 10. Restart service
echo "Restarting service..."
run_cmd launchctl kickstart -k "gui/$(id -u)/com.hive.agent"

# 11. Health check
echo "Checking health..."
if ! health_check; then
  echo "Health check failed. Triggering rollback..."
  rollback "$PREV_SHA"
fi

# 12. Success
notify "Deploy succeeded. Commit \`$DEPLOY_SHA\`: $DEPLOY_MSG. Hive is running."
echo "Deploy complete. Hive is running."

# 13. Cleanup backups
run_cmd rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak"
