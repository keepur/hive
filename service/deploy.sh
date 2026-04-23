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
ROLLBACK=false
FILTER_INSTANCE=""
OVERRIDE_TAG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --rollback) ROLLBACK=true ;;
    --instance=*) FILTER_INSTANCE="${arg#--instance=}" ;;
    --tag=*) OVERRIDE_TAG="${arg#--tag=}" ;;
    *)
      echo "ERROR: unknown arg: $arg" >&2
      echo "Usage: deploy.sh [--dry-run] [--rollback] [--instance=<id>] [--tag=<tag>]" >&2
      exit 2
      ;;
  esac
done

# --- Notification config (from dodi's .env — the primary instance) ---
# shellcheck source=/dev/null
source "$DEPLOY_DIR/.env"
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN not set in .env}"
: "${DEVOPS_CHANNEL_ID:?DEVOPS_CHANNEL_ID not set in .env}"

# --- Load instances ---
declare -a INSTANCES=()
while IFS='|' read -r id config _agents_path label logs_dir ports engine_tag; do
  [[ "$id" =~ ^[[:space:]]*# ]] && continue  # skip comments
  [[ -z "$id" ]] && continue                  # skip blank lines
  # Trim whitespace
  id=$(echo "$id" | xargs)
  config=$(echo "$config" | xargs)
  label=$(echo "$label" | xargs)
  logs_dir=$(echo "$logs_dir" | xargs)
  ports=$(echo "$ports" | xargs)
  engine_tag=$(echo "${engine_tag:-}" | xargs)
  INSTANCES+=("$id|$config|$label|$logs_dir|$ports|$engine_tag")
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

# --- Engine fetch/swap/rollback (KPR-53 / Phase 3) ---

# Resolve a tag to an npm-facing bare-semver version string.
# "v0.2.0" → "0.2.0"; "latest" → "latest"; "0.2.0" → "0.2.0"
_normalize_tag() {
  local tag="${1:-latest}"
  if [[ "$tag" == "latest" ]]; then
    echo "latest"
  else
    echo "${tag#v}"
  fi
}

# _instance_root <id>
# Returns the instance root dir: $DEPLOY_DIR/<id> if that dir exists (post-Phase-5
# per-instance layout), else $DEPLOY_DIR (today's primary-shared-dir layout).
# Lets deploy.sh be per-instance-dir aware now so Phase 5's migration is a no-op
# at the script level.
_instance_root() {
  local id="$1"
  if [[ -d "$DEPLOY_DIR/$id" ]]; then
    echo "$DEPLOY_DIR/$id"
  else
    echo "$DEPLOY_DIR"
  fi
}

# fetch_engine <instance_dir> <tag>
# Populates <instance_dir>/.hive.next/ with the tag's contents.
# Primary path: npm pack @keepur/hive@<version> + tar -xzf --strip-components=1.
# Fallback: rsync from $BUILD_DIR (developer-ergonomics path), only when npm pack
# actually fails (not merely when the tag isn't in the registry — transient
# registry errors should surface, not silently swap to rsync).
fetch_engine() {
  local instance_dir="$1"
  local tag="$2"
  local version
  version=$(_normalize_tag "$tag")

  rm -rf "$instance_dir/.hive.next"
  mkdir -p "$instance_dir/.hive.next"

  local packdir
  packdir=$(mktemp -d)
  local tarball
  # npm pack prints the tarball filename on the last line of stdout.
  # Run from a temp dir so the tarball doesn't litter $PWD.
  echo "  fetch_engine: npm pack @keepur/hive@$version"
  tarball=$(cd "$packdir" && npm pack "@keepur/hive@$version" 2>/dev/null | tail -n1)

  if [[ -n "$tarball" && -f "$packdir/$tarball" ]]; then
    tar -xzf "$packdir/$tarball" --strip-components=1 -C "$instance_dir/.hive.next/"
    rm -rf "$packdir"
  else
    rm -rf "$packdir"
    echo "  fetch_engine: npm pack failed; falling back to rsync from $BUILD_DIR" >&2
    local src="$BUILD_DIR"
    if [[ ! -f "$src/pkg/server.min.js" ]]; then
      rm -rf "$instance_dir/.hive.next"
      echo "ERROR: npm pack @keepur/hive@$version failed and fallback needs $src/pkg/server.min.js — run 'npm run bundle' in $src" >&2
      return 1
    fi
    rsync -a --delete "$src/pkg/"       "$instance_dir/.hive.next/pkg/"
    rsync -a --delete "$src/seeds/"     "$instance_dir/.hive.next/seeds/"
    rsync -a --delete "$src/templates/" "$instance_dir/.hive.next/templates/"
    # scripts/honeypot is a single binary, not the whole scripts/ dir
    mkdir -p "$instance_dir/.hive.next/scripts"
    [[ -f "$src/scripts/honeypot" ]] && cp "$src/scripts/honeypot" "$instance_dir/.hive.next/scripts/honeypot"
    cp "$src/package.json" "$instance_dir/.hive.next/"
  fi

  # Sanity check — if the tarball/rsync was broken, catch it before the swap.
  if [[ ! -f "$instance_dir/.hive.next/pkg/server.min.js" ]]; then
    rm -rf "$instance_dir/.hive.next"
    echo "ERROR: .hive.next/pkg/server.min.js missing after fetch_engine" >&2
    return 1
  fi
}

# swap_engine <instance_dir>
# Rotates: old .hive.prev → dropped; live .hive → .hive.prev; .hive.next → .hive.
# Assumes the service is already stopped. The ~50ms window where .hive/ doesn't
# exist is covered by the service being down.
swap_engine() {
  local instance_dir="$1"
  if [[ ! -d "$instance_dir/.hive.next" ]]; then
    echo "ERROR: swap_engine called but $instance_dir/.hive.next does not exist" >&2
    return 1
  fi
  if [[ -d "$instance_dir/.hive" ]]; then
    rm -rf "$instance_dir/.hive.prev"           # drop older backup
    mv "$instance_dir/.hive" "$instance_dir/.hive.prev"
  fi
  mv "$instance_dir/.hive.next" "$instance_dir/.hive"
  # Clear any .hive.broken/ from a previous failed rollback — this is a successful deploy.
  rm -rf "$instance_dir/.hive.broken"
}

# rollback_engine <instance_dir>
# Manual rollback OR auto-rollback after health-check failure.
# Moves the failed engine to .hive.broken/ (preserved for inspection) and
# restores .hive.prev → .hive.
rollback_engine() {
  local instance_dir="$1"
  if [[ ! -d "$instance_dir/.hive.prev" ]]; then
    echo "ERROR: no previous engine at $instance_dir/.hive.prev — rollback unavailable" >&2
    return 1
  fi
  rm -rf "$instance_dir/.hive.broken"
  if [[ -d "$instance_dir/.hive" ]]; then
    mv "$instance_dir/.hive" "$instance_dir/.hive.broken"
  fi
  mv "$instance_dir/.hive.prev" "$instance_dir/.hive"
}

# --- Short-circuit: --rollback mode ---
# Rollback is per-instance; requires --instance=<id> so we know which to roll.
# No build phase, no notify until after the swap.
if $ROLLBACK; then
  if [[ -z "$FILTER_INSTANCE" ]]; then
    echo "ERROR: --rollback requires --instance=<id>" >&2
    exit 2
  fi
  # Find the matching instance row so we know its logs dir + label.
  ROLLBACK_ROW=""
  for inst in "${INSTANCES[@]}"; do
    IFS='|' read -r id _config _label _logs _ports _tag <<< "$inst"
    if [[ "$id" == "$FILTER_INSTANCE" ]]; then
      ROLLBACK_ROW="$inst"
      break
    fi
  done
  if [[ -z "$ROLLBACK_ROW" ]]; then
    echo "ERROR: no instance '$FILTER_INSTANCE' in $INSTANCES_CONF" >&2
    exit 2
  fi
  IFS='|' read -r id _config label logs_dir ports _tag <<< "$ROLLBACK_ROW"
  instance_root=$(_instance_root "$id")
  echo "--- Rolling back $id (root: $instance_root) ---"
  kill_ports "$ports"
  if ! rollback_engine "$instance_root"; then
    notify "Rollback FAILED for \`$id\`: no previous engine (.hive.prev missing)."
    exit 1
  fi
  run_cmd launchctl kickstart -k "gui/$(id -u)/$label"
  if health_check "$instance_root/$logs_dir/hive.log"; then
    rollback_version=$(jq -r .version < "$instance_root/.hive/package.json" 2>/dev/null || echo "unknown")
    notify "Rollback succeeded for \`$id\` → \`$rollback_version\`."
    echo "Rollback complete."
    exit 0
  else
    notify "Rollback succeeded but health check failed for \`$id\`. Check logs."
    exit 1
  fi
fi

# =============================================================================
# Phase 1: Build (once, in $BUILD_DIR)
# =============================================================================

PREV_VERSION=$(jq -r .version < "$DEPLOY_DIR/.hive/package.json" 2>/dev/null || echo "unknown")
echo ""
echo "--- Phase 1: Build ---"
echo "Current deployed version: $PREV_VERSION"

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

echo "Bundling..."
if ! run_cmd npm run bundle; then
  notify "Deploy aborted. Bundle failed. Commit: \`$DEPLOY_SHA\`."
  exit 1
fi

# =============================================================================
# Phase 2: Deploy each instance
# =============================================================================

FAILED_INSTANCES=()

for inst in "${INSTANCES[@]}"; do
  IFS='|' read -r id config label logs_dir ports engine_tag <<< "$inst"

  # --instance=<id> filter
  if [[ -n "$FILTER_INSTANCE" && "$FILTER_INSTANCE" != "$id" ]]; then
    echo ""
    echo "--- Skipping '$id' (filtered: --instance=$FILTER_INSTANCE) ---"
    continue
  fi

  # --tag override > per-instance engine_tag > "latest"
  tag="${OVERRIDE_TAG:-${engine_tag:-latest}}"
  instance_root=$(_instance_root "$id")

  echo ""
  echo "--- Phase 2: Deploy instance '$id' @ $tag (root: $instance_root) ---"
  echo "  config=$config label=$label logs=$logs_dir ports=$ports"

  mkdir -p "$instance_root/$logs_dir"

  echo "  Stopping $label..."
  run_cmd launchctl kickstart -kp "gui/$(id -u)/$label" 2>/dev/null || true
  kill_ports "$ports"

  echo "  Fetching engine..."
  if ! fetch_engine "$instance_root" "$tag"; then
    notify "Deploy FAILED for \`$id\`: fetch_engine errored at tag \`$tag\`."
    FAILED_INSTANCES+=("$id")
    run_cmd launchctl kickstart -k "gui/$(id -u)/$label" || true  # bring old engine back up
    continue
  fi

  echo "  Swapping engine..."
  swap_engine "$instance_root"

  echo "  Restarting $label..."
  run_cmd launchctl kickstart -k "gui/$(id -u)/$label"

  echo "  Checking health..."
  if ! health_check "$instance_root/$logs_dir/hive.log"; then
    echo "  Health check FAILED for $id — rolling back"
    if rollback_engine "$instance_root"; then
      run_cmd launchctl kickstart -k "gui/$(id -u)/$label"
      notify "Deploy rolled back for \`$id\`: \`$tag\` failed health check, restored previous version."
    else
      notify "Deploy FAILED for \`$id\` and auto-rollback unavailable (.hive.prev missing). Manual intervention required."
    fi
    FAILED_INSTANCES+=("$id")
    continue
  fi

  new_version=$(jq -r .version < "$instance_root/.hive/package.json" 2>/dev/null || echo "unknown")
  echo "  Instance '$id' is healthy at version $new_version."
done

# =============================================================================
# Phase 3: Report
# =============================================================================

echo ""
echo "--- Phase 3: Report ---"

if [[ ${#FAILED_INSTANCES[@]} -gt 0 ]]; then
  failed_list=$(printf ", %s" "${FAILED_INSTANCES[@]}")
  failed_list=${failed_list:2}
  notify "Deploy partial. Build commit \`$DEPLOY_SHA\`: $DEPLOY_MSG. Failed instances: $failed_list."
  echo "Deploy completed with failures: $failed_list"
  exit 1
else
  # Count actual deploy targets (respecting --instance filter)
  deployed=${#INSTANCES[@]}
  [[ -n "$FILTER_INSTANCE" ]] && deployed=1
  notify "Deploy succeeded ($deployed instance(s)). Build commit \`$DEPLOY_SHA\`: $DEPLOY_MSG."
  echo "Deploy complete. $deployed instance(s) running."
fi
