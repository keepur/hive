#!/usr/bin/env bash
# =============================================================================
# migrate-0.2.sh — migrate a 0.1.x Hive instance dir into the 0.2.0 layout
# =============================================================================
# Usage:
#   bash migrate-0.2.sh <instance_dir>
#   bash migrate-0.2.sh --dry-run <instance_dir>
#
# Standalone: does not depend on the 0.2.0 engine being installed yet (it
# installs it as part of step 7). Run before or after `npm i -g @keepur/hive@0.2.0`.
#
# Idempotent: re-running on an already-migrated dir exits 0 with "already on 0.2.0".
# =============================================================================

set -euo pipefail

DRY_RUN=false
INSTANCE_DIR=""

usage() {
  cat <<USAGE
migrate-0.2.sh — migrate a 0.1.x Hive instance into the 0.2.0 layout.

Usage:
  migrate-0.2.sh [--dry-run] <instance_dir>

Options:
  --dry-run   Run preflight + classifier only. No filesystem mutations.
  -h, --help  Show this help.

Examples:
  bash migrate-0.2.sh --dry-run ~/services/hive/dodi
  bash migrate-0.2.sh ~/services/hive/dodi
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "ERROR: unknown flag: $arg" >&2; usage; exit 2 ;;
    *)
      if [[ -z "$INSTANCE_DIR" ]]; then
        INSTANCE_DIR="$arg"
      else
        echo "ERROR: only one positional arg (instance_dir) accepted, got a second: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$INSTANCE_DIR" ]]; then
  echo "ERROR: <instance_dir> required" >&2
  usage
  exit 2
fi

INSTANCE_DIR="$(cd "$INSTANCE_DIR" && pwd)"  # resolve to absolute
INSTANCE_ID="$(basename "$INSTANCE_DIR")"

# --- notify helper (stubbed; real impl added in Task 8) ---
notify() {
  local message="$1"
  echo "NOTIFY: $message"
  if $DRY_RUN; then return; fi
  # Real Slack post lands in Task 8 — guarded by source "$INSTANCE_DIR/.env"
  :
}

# --- preflight ---
preflight() {
  echo "==> Preflight: $INSTANCE_DIR"

  if [[ ! -f "$INSTANCE_DIR/hive.yaml" ]]; then
    echo "ERROR: $INSTANCE_DIR does not look like a Hive instance (no hive.yaml)." >&2
    exit 1
  fi

  # Already migrated?
  if [[ -f "$INSTANCE_DIR/.hive/pkg/server.min.js" ]]; then
    echo "  → .hive/pkg/server.min.js already populated; already on 0.2.0."
    exit 0
  fi

  # Confirm it's 0.1.x shape — must have either dist/ (old repo layout) or
  # .hive/git/ (the instance-git internal state dir).
  if [[ ! -f "$INSTANCE_DIR/dist/index.js" && ! -d "$INSTANCE_DIR/.hive/git" ]]; then
    echo "ERROR: $INSTANCE_DIR doesn't look like 0.1.x (no dist/index.js or .hive/git/)." >&2
    echo "       Manual inspection required — refusing to proceed." >&2
    exit 1
  fi

  # Existing .pre-0.2-bak means a prior migration attempt started and didn't finish.
  if [[ -e "$INSTANCE_DIR.pre-0.2-bak" ]]; then
    echo "ERROR: $INSTANCE_DIR.pre-0.2-bak already exists." >&2
    echo "       Rename or delete it before retrying, after confirming the instance is healthy." >&2
    exit 1
  fi

  # Discover live plists in service/ — used by step 5 (engine-wipe preservation)
  # and step 12 (auto-rollback label discovery). Step 10 drives plist regen from
  # hive.yaml / hive-*.yaml files at the instance root, not from LIVE_PLISTS.
  declare -g -a LIVE_PLISTS=()
  for link in "$HOME/Library/LaunchAgents"/com.hive.*.plist; do
    [[ -L "$link" ]] || continue
    local abs
    abs=$(realpath "$link" 2>/dev/null || true)
    if [[ -n "$abs" && "$abs" == "$INSTANCE_DIR/service/"* ]]; then
      LIVE_PLISTS+=("$(basename "$abs")")
    fi
  done
  echo "  Live plists rooted here: ${LIVE_PLISTS[*]:-<none>}"

  # If any live plist is loaded right now, require the user to stop it first.
  local running=""
  for plist in "${LIVE_PLISTS[@]:-}"; do
    local label="${plist%.plist}"
    if launchctl print "gui/$(id -u)/$label" &>/dev/null; then
      running="$running $label"
    fi
  done
  if [[ -n "$running" ]]; then
    echo "WARNING: the following LaunchAgents are currently loaded:"
    echo "  $running"
    echo ""
    read -p "Stop them now via launchctl bootout? [y/N] " reply
    if [[ "$reply" =~ ^[Yy]$ ]]; then
      for label in $running; do
        launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      done
    else
      echo "ERROR: refusing to migrate while service is running. Stop it and retry." >&2
      exit 1
    fi
  fi

  # Disk space — need ~2x instance dir size for the snapshot.
  local size_kb
  size_kb=$(du -sk "$INSTANCE_DIR" | awk '{print $1}')
  local needed_kb=$((size_kb * 2))
  local free_kb
  free_kb=$(df -k "$INSTANCE_DIR" | awk 'NR==2 {print $4}')
  if [[ "$free_kb" -lt "$needed_kb" ]]; then
    echo "ERROR: need at least $((needed_kb / 1024))MB free; only $((free_kb / 1024))MB available." >&2
    exit 1
  fi

  # Required CLIs. yq (step 8 yaml surgery), jq (notify helper's Slack JSON
  # payload + step 7 version check), rsync (step 7 populate), realpath/readlink
  # (step 5 + step 12 live-plist discovery via ~/Library/LaunchAgents symlink
  # resolution), launchctl (step 10 + step 12 bootout/bootstrap). All ship on
  # macOS except yq and jq (Homebrew).
  local missing=""
  for cmd in yq jq rsync realpath readlink launchctl; do
    command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
  done
  if [[ -n "$missing" ]]; then
    echo "ERROR: missing required CLI(s):$missing" >&2
    echo "       Install via: brew install${missing}" >&2
    exit 1
  fi

  # Also check for lingering Playwright MCP children — see spec Runtime Failure Mode 6.
  if pgrep -f playwright-mcp >/dev/null 2>&1; then
    echo "WARNING: playwright-mcp child processes still running after service stop."
    echo "         Waiting up to 5 seconds for them to exit..."
    for _ in 1 2 3 4 5; do
      sleep 1
      pgrep -f playwright-mcp >/dev/null 2>&1 || break
    done
    if pgrep -f playwright-mcp >/dev/null 2>&1; then
      echo "ERROR: playwright-mcp still running. Kill manually and retry:" >&2
      echo "         pkill -f playwright-mcp" >&2
      exit 1
    fi
  fi

  echo "  ✓ preflight"
}

preflight

# --- Dry-run mode exits here, after the classifier in Task 5 ---
# (Task 5 will add `run_dry_run_classifier` + `[[ $DRY_RUN == true ]] && exit 0`.)

# --- Real migration steps land in Tasks 2-9 below this line. ---
echo "Migration steps not yet implemented (scaffold only)."
exit 0
