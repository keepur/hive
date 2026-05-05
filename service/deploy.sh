#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Hive Deploy — build once, deploy to all instances
# =============================================================================

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
INSTANCES_CONF="${HIVE_INSTANCES_CONF:-$SCRIPT_DIR/instances.conf}"

# Health check tunables (KPR-185). Cold-start can transiently exceed a single
# 30s window — DNS, Slack handshake, MongoDB warmup occasionally tip past the
# original budget on otherwise-healthy boots. Three retries × 30s with 10s
# waits between covers that without changing happy-path latency: a healthy
# engine still resolves on the first attempt, typically well under 30s.
HEALTH_CHECK_RETRIES=3
HEALTH_CHECK_WINDOW=30
HEALTH_CHECK_WAIT_BETWEEN=10

# Single-instance mode (KPR-70): when invoked by `hive update` for a customer
# install, the calling instance passes its own facts via env, and we skip the
# build-from-source phase + the shipped instances.conf entirely. The instance
# running the update is the only instance to update — no global registry read.
SINGLE_INSTANCE_MODE=false
if [[ "${HIVE_SINGLE_INSTANCE:-}" == "1" ]]; then
  SINGLE_INSTANCE_MODE=true
fi

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

# --- Notification config ---
# Source $DEPLOY_DIR/.env if present so SLACK_BOT_TOKEN / DEVOPS_CHANNEL_ID
# can populate from the dev convention. Customer installs have neither file
# nor tokens — that's fine; notify() degrades to a silent no-op below.
if [[ -f "$DEPLOY_DIR/.env" ]]; then
  # shellcheck source=/dev/null
  source "$DEPLOY_DIR/.env"
fi

# --- Load instances ---
declare -a INSTANCES=()
if $SINGLE_INSTANCE_MODE; then
  : "${HIVE_SINGLE_ID:?HIVE_SINGLE_ID required in single-instance mode}"
  : "${HIVE_SINGLE_CONFIG:?HIVE_SINGLE_CONFIG required in single-instance mode}"
  : "${HIVE_SINGLE_LOGS:?HIVE_SINGLE_LOGS required in single-instance mode}"
  : "${HIVE_SINGLE_PORTS:?HIVE_SINGLE_PORTS required in single-instance mode}"
  : "${HIVE_SINGLE_ROOT:?HIVE_SINGLE_ROOT required in single-instance mode}"
  INSTANCES+=("$HIVE_SINGLE_ID|$HIVE_SINGLE_CONFIG|com.hive.${HIVE_SINGLE_ID}.agent|$HIVE_SINGLE_LOGS|$HIVE_SINGLE_PORTS|${HIVE_SINGLE_TAG:-}")
else
  if [[ ! -f "$INSTANCES_CONF" ]]; then
    echo "ERROR: instances.conf not found at $INSTANCES_CONF"
    echo "       For single-instance updates, set HIVE_SINGLE_INSTANCE=1 and the HIVE_SINGLE_* env vars."
    echo "       For multi-instance dev, point HIVE_INSTANCES_CONF at a workspace-level conf."
    exit 1
  fi
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
  # Slack notification is opt-in. Customer installs without devops Slack
  # tokens silently skip — never fail-closed on a missing notification config.
  if [[ -z "${SLACK_BOT_TOKEN:-}" || -z "${DEVOPS_CHANNEL_ID:-}" ]]; then
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
  for attempt in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    if [[ "$attempt" -gt 1 ]]; then
      echo "  Health check attempt $attempt/$HEALTH_CHECK_RETRIES (waiting ${HEALTH_CHECK_WAIT_BETWEEN}s before retry)..."
      sleep "$HEALTH_CHECK_WAIT_BETWEEN"
    fi
    for _ in $(seq 1 "$HEALTH_CHECK_WINDOW"); do
      sleep 1
      if tail -5 "$log_file" 2>/dev/null | grep -q '"Hive is running"'; then
        return 0
      fi
    done
    echo "  Health check attempt $attempt/$HEALTH_CHECK_RETRIES failed (no 'Hive is running' in last ${HEALTH_CHECK_WINDOW}s)."
  done
  return 1
}

kill_ports() {
  local ports_str="$1"
  if $DRY_RUN; then
    echo "[DRY RUN] kill_ports: would scan $ports_str"
    return
  fi
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
# Returns the instance root dir. In single-instance mode (KPR-70) the caller
# tells us via HIVE_SINGLE_ROOT — we don't probe DEPLOY_DIR. Otherwise:
# $DEPLOY_DIR/<id> if that dir exists (post-Phase-5 per-instance layout), else
# $DEPLOY_DIR (today's primary-shared-dir layout). Lets deploy.sh be
# per-instance-dir aware now so Phase 5's migration is a no-op at the script level.
_instance_root() {
  local id="$1"
  if $SINGLE_INSTANCE_MODE; then
    echo "$HIVE_SINGLE_ROOT"
    return
  fi
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

  if $DRY_RUN; then
    echo "[DRY RUN] fetch_engine: would populate $instance_dir/.hive.next/ from @keepur/hive@$version"
    return 0
  fi

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
    rsync -a --delete "$src/install/"   "$instance_dir/.hive.next/install/"
    rsync -a --delete "$src/service/"   "$instance_dir/.hive.next/service/"
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

# install_engine_deps <instance_dir>
# Runs `npm install --omit=dev` inside .hive.next/ so the bundle's runtime
# externals (native modules, large SDKs, asset loaders — 14 of them) resolve
# from .hive/pkg/. Node walks up to .hive/node_modules/ to find them.
# Mirrors src/setup/populate-engine.ts so `hive init` and `hive update`
# produce byte-identical .hive/ layouts.
install_engine_deps() {
  local instance_dir="$1"
  if $DRY_RUN; then
    echo "[DRY RUN] install_engine_deps: would npm install --omit=dev in $instance_dir/.hive.next/"
    return 0
  fi
  if [[ ! -f "$instance_dir/.hive.next/package.json" ]]; then
    echo "ERROR: install_engine_deps needs $instance_dir/.hive.next/package.json" >&2
    return 1
  fi
  echo "  install_engine_deps: npm install --omit=dev in .hive.next/"
  (cd "$instance_dir/.hive.next" && npm install --omit=dev --no-audit --no-fund --no-progress >&2)
}

# swap_engine <instance_dir>
# Rotates: old .hive.prev → dropped; live .hive → .hive.prev; .hive.next → .hive.
# Assumes the service is already stopped. The ~50ms window where .hive/ doesn't
# exist is covered by the service being down.
swap_engine() {
  local instance_dir="$1"
  if $DRY_RUN; then
    echo "[DRY RUN] swap_engine: would rotate $instance_dir/.hive{,.prev,.next}"
    return 0
  fi
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
  if $DRY_RUN; then
    if [[ ! -d "$instance_dir/.hive.prev" ]]; then
      echo "[DRY RUN] rollback_engine: would fail — no $instance_dir/.hive.prev"
      return 1
    fi
    echo "[DRY RUN] rollback_engine: would swap $instance_dir/.hive ↔ .hive.prev (failed engine → .hive.broken)"
    return 0
  fi
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
  IFS='|' read -r id _config _conf_label logs_dir ports _tag <<< "$ROLLBACK_ROW"
  # Label is derived from instance id, not read from the conf (the conf's label
  # column is historical — the installer builds labels as com.hive.<id>.agent
  # per service/install.sh). See KPR-63.
  label="com.hive.${id}.agent"
  instance_root=$(_instance_root "$id")
  plist_path="$instance_root/service/$label.plist"
  echo "--- Rolling back $id (root: $instance_root) ---"
  # Stop LaunchAgent BEFORE rotating .hive/. KPR-182: use bootout (true unload)
  # rather than kickstart -kp — kickstart is fundamentally a *start* operation,
  # and KeepAlive auto-respawns the service mid-rollback otherwise.
  echo "  Stopping $label..."
  run_cmd launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  # Wait for ports to release (KeepAlive can't fire — service is unloaded).
  if ! $DRY_RUN; then
    for port in $ports; do
      for _ in $(seq 1 10); do
        if ! lsof -i :"$port" -t >/dev/null 2>&1; then break; fi
        sleep 0.5
      done
    done
  fi
  kill_ports "$ports"  # defensive — catches anything bound elsewhere
  if ! rollback_engine "$instance_root"; then
    notify "Rollback FAILED for \`$id\`: no previous engine (.hive.prev missing)."
    exit 1
  fi
  run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"
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

# --- Guard: shared instance_root with diverging pins ---
# When multiple instances resolve to the same instance_root (today: dodi+personal
# both share $DEPLOY_DIR until Phase 5 migrates them into per-instance dirs),
# they share a single .hive/ — their ENGINE_TAG pins MUST agree. Otherwise
# per-instance deploys silently clobber each other and deploy-check.sh
# oscillates between versions on every poll. Compares the configured pins
# (not the effective tag for this run) so even an explicit --tag override
# can't sneak past a misconfigured pinning state. Fail fast before any work.
# Skipped in single-instance mode: one row can't conflict with itself.
if ! $SINGLE_INSTANCE_MODE; then
  declare -a _seen_roots=()
  declare -a _seen_pins=()
  for inst in "${INSTANCES[@]}"; do
    IFS='|' read -r _id _config _label _logs _ports _engine_tag <<< "$inst"
    _root=$(_instance_root "$_id")
    _pin="${_engine_tag:-latest}"
    for i in "${!_seen_roots[@]}"; do
      if [[ "${_seen_roots[$i]}" == "$_root" && "${_seen_pins[$i]}" != "$_pin" ]]; then
        echo "ERROR: instances share root '$_root' but pin different ENGINE_TAGs ('${_seen_pins[$i]}' vs '$_pin')." >&2
        echo "       Set the same ENGINE_TAG for all instances under one root, or migrate them to per-instance dirs (Phase 5)." >&2
        exit 2
      fi
    done
    _seen_roots+=("$_root")
    _seen_pins+=("$_pin")
  done
  unset _seen_roots _seen_pins _id _config _label _logs _ports _engine_tag _root _pin i
fi

# =============================================================================
# Phase 1: Build (once, in $BUILD_DIR)
# =============================================================================
# Skipped in single-instance mode (KPR-70): customer installs consume the
# published @keepur/hive npm tarball via fetch_engine in Phase 2 — there is no
# $BUILD_DIR, no `deploy` branch, nothing to rebuild from source.

DEPLOY_SHA=""
DEPLOY_MSG=""

if $SINGLE_INSTANCE_MODE; then
  echo ""
  echo "--- Phase 1: Build (skipped in single-instance mode) ---"
else
  echo ""
  echo "--- Phase 1: Build ---"
  # Per-instance current versions are reported in Phase 2 after each health check.

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
fi

# =============================================================================
# Phase 2: Deploy each instance
# =============================================================================

FAILED_INSTANCES=()

for inst in "${INSTANCES[@]}"; do
  IFS='|' read -r id config _conf_label logs_dir ports engine_tag <<< "$inst"
  # Derive label from instance id — conf's label column is ignored (see KPR-63).
  label="com.hive.${id}.agent"

  # --instance=<id> filter
  if [[ -n "$FILTER_INSTANCE" && "$FILTER_INSTANCE" != "$id" ]]; then
    echo ""
    echo "--- Skipping '$id' (filtered: --instance=$FILTER_INSTANCE) ---"
    continue
  fi

  # --tag override > per-instance engine_tag > "latest"
  tag="${OVERRIDE_TAG:-${engine_tag:-latest}}"
  instance_root=$(_instance_root "$id")
  plist_path="$instance_root/service/$label.plist"

  echo ""
  echo "--- Phase 2: Deploy instance '$id' @ $tag (root: $instance_root) ---"
  echo "  config=$config label=$label logs=$logs_dir ports=$ports"

  mkdir -p "$instance_root/$logs_dir"

  # KPR-182: bootout (true unload) so KeepAlive can't auto-respawn the old
  # engine during fetch/install/swap. kickstart is a *start* operation — the
  # `-k` flag merely kills-then-restarts, leaving the plist loaded.
  echo "  Stopping $label..."
  run_cmd launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  if ! $DRY_RUN; then
    for port in $ports; do
      for _ in $(seq 1 10); do
        if ! lsof -i :"$port" -t >/dev/null 2>&1; then break; fi
        sleep 0.5
      done
    done
  fi
  kill_ports "$ports"  # defensive — catches anything bound elsewhere

  echo "  Fetching engine..."
  if ! fetch_engine "$instance_root" "$tag"; then
    notify "Deploy FAILED for \`$id\`: fetch_engine errored at tag \`$tag\`."
    FAILED_INSTANCES+=("$id")
    run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path" || true  # bring old engine back up
    continue
  fi

  echo "  Installing engine deps..."
  if ! install_engine_deps "$instance_root"; then
    notify "Deploy FAILED for \`$id\`: install_engine_deps errored at tag \`$tag\`."
    FAILED_INSTANCES+=("$id")
    rm -rf "$instance_root/.hive.next"
    run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path" || true  # bring old engine back up
    continue
  fi

  echo "  Swapping engine..."
  swap_engine "$instance_root"

  echo "  Restarting $label..."
  run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"

  echo "  Checking health..."
  if ! health_check "$instance_root/$logs_dir/hive.log"; then
    echo "  Health check FAILED for $id — rolling back"
    # New engine bound the port and failed health check — bootout it before swap.
    run_cmd launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    if ! $DRY_RUN; then
      for port in $ports; do
        for _ in $(seq 1 10); do
          if ! lsof -i :"$port" -t >/dev/null 2>&1; then break; fi
          sleep 0.5
        done
      done
    fi
    kill_ports "$ports"
    if rollback_engine "$instance_root"; then
      run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"
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

# Build-commit clause appears only in multi-instance mode (Phase 1 ran).
build_clause=""
if [[ -n "$DEPLOY_SHA" ]]; then
  build_clause=" Build commit \`$DEPLOY_SHA\`: $DEPLOY_MSG."
fi

if [[ ${#FAILED_INSTANCES[@]} -gt 0 ]]; then
  failed_list=$(printf ", %s" "${FAILED_INSTANCES[@]}")
  failed_list=${failed_list:2}
  notify "Deploy partial.${build_clause} Failed instances: $failed_list."
  echo "Deploy completed with failures: $failed_list"
  exit 1
else
  # Count actual deploy targets (respecting --instance filter)
  deployed=${#INSTANCES[@]}
  [[ -n "$FILTER_INSTANCE" ]] && deployed=1
  notify "Deploy succeeded ($deployed instance(s)).${build_clause}"
  echo "Deploy complete. $deployed instance(s) running."
fi
