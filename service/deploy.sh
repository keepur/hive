#!/usr/bin/env bash
set -euo pipefail

# --- Instance helpers ---
read_instance_id() {
  local yaml_file="$1/hive.yaml"
  local id
  id=$(grep '^\s*id:' "$yaml_file" 2>/dev/null | head -1 | awk '{print $2}')
  [[ -z "$id" ]] && id="hive"
  echo "$id"
}

read_port_base() {
  local yaml_file="$1/hive.yaml"
  local port
  port=$(grep '^\s*portBase:' "$yaml_file" 2>/dev/null | head -1 | awk '{print $2}')
  [[ -z "$port" ]] && port="3100"
  echo "$port"
}

# --- Configuration ---
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
# Derive deploy dir from instance ID if not explicitly set
if [[ -z "${DEPLOY_DIR:-}" ]]; then
  INSTANCE_ID=$(read_instance_id "$BUILD_DIR")
  DEPLOY_DIR="$HOME/services/$INSTANCE_ID"
fi
INSTANCE_ID=$(read_instance_id "$DEPLOY_DIR")
PORT_BASE=$(read_port_base "$DEPLOY_DIR")
LABEL="com.hive.${INSTANCE_ID}.agent"

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

# --- Helper: Kill stale processes on instance ports ---
kill_stale_ports() {
  for offset in 0 1 2 3; do
    local port=$((PORT_BASE + offset))
    local pids
    pids=$(lsof -i :"$port" -t 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "Killing stale process(es) on port $port: $pids"
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  done
  sleep 1
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

  if [[ -d "$DEPLOY_DIR/plugins/claude-code.bak" ]]; then
    run_cmd rm -rf "$DEPLOY_DIR/plugins/claude-code"
    run_cmd mv "$DEPLOY_DIR/plugins/claude-code.bak" "$DEPLOY_DIR/plugins/claude-code"
  fi

  echo "Restarting service with previous version..."
  kill_stale_ports
  run_cmd launchctl kickstart -k "gui/$(id -u)/$LABEL"

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
echo "=== Hive Deploy ($INSTANCE_ID, ports $PORT_BASE-$((PORT_BASE + 3))) ==="

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

# 7. Preserve agent-made changes in deploy dir
echo "Checking for agent-made changes..."
cd "$DEPLOY_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Deploy dir not on deploy branch"; exit 1; }
if [[ -n "$(git status --porcelain skills/ 2>/dev/null)" ]]; then
  echo "Agent-made skill changes detected — committing and pushing..."
  run_cmd git add skills/
  run_cmd git commit -m "chore: preserve agent-made skill changes (auto-commit by deploy)"
  run_cmd git push
  # Re-pull in build dir so it has the agent changes before checks
  cd "$BUILD_DIR"
  run_cmd git pull --ff-only
  cd "$DEPLOY_DIR"
fi

# 8. Pull latest into deploy dir
echo "Preparing deploy dir..."
run_cmd git pull --ff-only
run_cmd npm install --omit=dev

# 9. Backup current dist and agents
run_cmd rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak" "$DEPLOY_DIR/plugins/claude-code.bak"
run_cmd cp -a "$DEPLOY_DIR/dist" "$DEPLOY_DIR/dist.bak" 2>/dev/null || true
run_cmd cp -a "$DEPLOY_DIR/agents" "$DEPLOY_DIR/agents.bak" 2>/dev/null || true
run_cmd cp -a "$DEPLOY_DIR/plugins/claude-code" "$DEPLOY_DIR/plugins/claude-code.bak" 2>/dev/null || true

# 10. Rsync built artifacts
echo "Syncing build output..."
run_cmd rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"
run_cmd rsync -a --delete "$BUILD_DIR/agents/" "$DEPLOY_DIR/agents/"
[[ -d "$BUILD_DIR/plugins/claude-code" ]] && run_cmd rsync -a --delete "$BUILD_DIR/plugins/claude-code/" "$DEPLOY_DIR/plugins/claude-code/"

# 11. Restart service
echo "Restarting service..."
kill_stale_ports
run_cmd launchctl kickstart -k "gui/$(id -u)/$LABEL"

# 12. Health check
echo "Checking health..."
if ! health_check; then
  echo "Health check failed. Triggering rollback..."
  rollback "$PREV_SHA"
fi

# 13. Success
notify "Deploy succeeded. Commit \`$DEPLOY_SHA\`: $DEPLOY_MSG. Hive is running."
echo "Deploy complete. Hive is running."

# 14. Cleanup backups
run_cmd rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak" "$DEPLOY_DIR/plugins/claude-code.bak"
