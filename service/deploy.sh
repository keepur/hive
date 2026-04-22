#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Hive Deploy — build once, deploy to all instances
# =============================================================================

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
INSTANCES_CONF="$SCRIPT_DIR/instances.conf"

# --- Flags ---
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# --- Notification config (from dodi's .env — the primary instance) ---
# shellcheck source=/dev/null
source "$DEPLOY_DIR/.env"
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN not set in .env}"
: "${DEVOPS_CHANNEL_ID:?DEVOPS_CHANNEL_ID not set in .env}"

# --- Load instances ---
declare -a INSTANCES=()
while IFS='|' read -r id config _agents_path label logs_dir ports; do
  [[ "$id" =~ ^[[:space:]]*# ]] && continue  # skip comments
  [[ -z "$id" ]] && continue                  # skip blank lines
  # Trim whitespace
  id=$(echo "$id" | xargs)
  config=$(echo "$config" | xargs)
  label=$(echo "$label" | xargs)
  logs_dir=$(echo "$logs_dir" | xargs)
  ports=$(echo "$ports" | xargs)
  INSTANCES+=("$id|$config|$label|$logs_dir|$ports")
done < "$INSTANCES_CONF"

if [[ ${#INSTANCES[@]} -eq 0 ]]; then
  echo "ERROR: No instances found in $INSTANCES_CONF"
  exit 1
fi

echo "=== Hive Deploy (${#INSTANCES[@]} instances) ==="
for inst in "${INSTANCES[@]}"; do
  echo "  - $(echo "$inst" | cut -d'|' -f1)"
done

# --- Helpers ---
run_cmd() {
  if $DRY_RUN; then
    echo "[DRY RUN] $*"
  else
    "$@"
  fi
}

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

health_check() {
  local log_file="$1"
  if $DRY_RUN; then
    echo "[DRY RUN] health_check: would check $log_file"
    return 0
  fi
  for _ in $(seq 1 30); do
    sleep 1
    if tail -5 "$log_file" 2>/dev/null | grep -q '"Hive is running"'; then
      return 0
    fi
  done
  return 1
}

kill_ports() {
  local ports_str="$1"
  for port in $ports_str; do
    local pids
    pids=$(lsof -i :"$port" -t 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "  Killing stale process(es) on port $port: $pids"
      echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  done
  sleep 1
}

# =============================================================================
# Phase 1: Build (once)
# =============================================================================

cd "$DEPLOY_DIR"
PREV_SHA=$(git rev-parse --short HEAD)
echo ""
echo "--- Phase 1: Build ---"
echo "Current deployed SHA: $PREV_SHA"

# Preserve agent-made changes before pulling.
# Skill edits made in the deploy dir are committed to MAIN (the source of truth),
# regardless of what branch the deploy dir happens to be on. The change reaches
# runtime on the next /deploy + deploy.sh run — not this one.
if [[ -n "$(git status --porcelain skills/ 2>/dev/null)" ]]; then
  echo "Agent-made skill changes detected — committing to main..."
  ORIGINAL_BRANCH=$(git branch --show-current)
  if [[ -z "$ORIGINAL_BRANCH" ]]; then
    notify "Deploy aborted. Deploy dir is in detached HEAD; cannot auto-commit skill changes."
    exit 1
  fi

  if ! run_cmd git stash push --include-untracked -m "deploy-auto-skills" -- skills/; then
    notify "Deploy aborted. Could not stash agent-made skill changes."
    exit 1
  fi

  if ! run_cmd git fetch origin main; then
    run_cmd git stash pop || true
    notify "Deploy aborted. Could not fetch main."
    exit 1
  fi

  if ! run_cmd git checkout main; then
    run_cmd git stash pop || true
    notify "Deploy aborted. Could not check out main to preserve skill changes."
    exit 1
  fi

  if ! run_cmd git pull --ff-only; then
    run_cmd git checkout "$ORIGINAL_BRANCH"
    run_cmd git stash pop || true
    notify "Deploy aborted. Could not fast-forward main."
    exit 1
  fi

  if ! run_cmd git stash pop; then
    notify "Deploy aborted. Conflict applying agent-made skill changes onto main. Resolve manually in $DEPLOY_DIR."
    exit 1
  fi

  run_cmd git add skills/
  run_cmd git commit -m "chore: preserve agent-made skill changes (auto-commit by deploy)"
  run_cmd git push origin main

  # Switch back to the original branch — this deploy run uses whatever is on that branch.
  run_cmd git checkout "$ORIGINAL_BRANCH"
fi

echo "Pulling latest in build dir..."
cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }
run_cmd git pull --ff-only

DEPLOY_SHA=$(git rev-parse --short HEAD)
DEPLOY_MSG=$(git log -1 --pretty=%s)

echo "Installing dependencies..."
if ! run_cmd npm install; then
  notify "Deploy aborted. \`npm install\` failed. Commit: \`$DEPLOY_SHA\`."
  exit 1
fi

echo "Running checks..."
if ! run_cmd npm run check; then
  notify "Deploy aborted. \`npm run check\` failed. Commit: \`$DEPLOY_SHA\`."
  exit 1
fi

echo "Building..."
if ! run_cmd npm run build; then
  notify "Deploy aborted. Build failed. Commit: \`$DEPLOY_SHA\`."
  exit 1
fi

# Pull latest into deploy dir + install prod deps
echo "Preparing deploy dir..."
cd "$DEPLOY_DIR"
run_cmd git pull --ff-only
run_cmd npm install --omit=dev

# Sync shared artifacts (dist, plugins)
echo "Syncing shared build output..."
# Ensure engine dir exists (wipe-and-replace target)
run_cmd mkdir -p "$DEPLOY_DIR/.hive"
run_cmd rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/.hive/dist/"
[[ -d "$BUILD_DIR/plugins/claude-code" ]] && run_cmd rsync -a --delete "$BUILD_DIR/plugins/claude-code/" "$DEPLOY_DIR/.hive/plugins/claude-code/"

# =============================================================================
# Phase 2: Deploy each instance
# =============================================================================

FAILED_INSTANCES=()

for inst in "${INSTANCES[@]}"; do
  IFS='|' read -r id config label logs_dir ports <<< "$inst"

  echo ""
  echo "--- Phase 2: Deploy instance '$id' ---"
  echo "  config=$config label=$label logs=$logs_dir ports=$ports"

  cd "$DEPLOY_DIR"

  # Ensure logs dir exists
  mkdir -p "$DEPLOY_DIR/$logs_dir"

  # Restart this instance
  echo "  Restarting $label..."
  kill_ports "$ports"
  run_cmd launchctl kickstart -k "gui/$(id -u)/$label"

  # Health check
  echo "  Checking health..."
  if ! health_check "$DEPLOY_DIR/$logs_dir/hive.log"; then
    echo "  Health check FAILED for $id"
    FAILED_INSTANCES+=("$id")
    continue
  fi

  echo "  Instance '$id' is healthy."
done

# =============================================================================
# Phase 3: Report
# =============================================================================

echo ""
echo "--- Phase 3: Report ---"

if [[ ${#FAILED_INSTANCES[@]} -gt 0 ]]; then
  failed_list=$(printf ", %s" "${FAILED_INSTANCES[@]}")
  failed_list=${failed_list:2}
  notify "Deploy partial. Commit \`$DEPLOY_SHA\`: $DEPLOY_MSG. Failed instances: $failed_list."
  echo "Deploy completed with failures: $failed_list"
  exit 1
else
  notify "Deploy succeeded (${#INSTANCES[@]} instances). Commit \`$DEPLOY_SHA\`: $DEPLOY_MSG."
  echo "Deploy complete. All ${#INSTANCES[@]} instances running."
fi
