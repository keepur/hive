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

# --- notify helper ---
notify() {
  local message="$1"
  echo "NOTIFY: $message"
  if $DRY_RUN; then return; fi

  # Source .env to get SLACK_BOT_TOKEN + DEVOPS_CHANNEL_ID. If .env is
  # unreadable (preserved by preflight but maybe in a weird state), log only.
  if [[ ! -f "$INSTANCE_DIR/.env" ]]; then
    echo "  (no .env, Slack skipped)"
    return
  fi
  # shellcheck source=/dev/null
  local token channel
  token=$(grep -E '^SLACK_BOT_TOKEN=' "$INSTANCE_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"')
  channel=$(grep -E '^DEVOPS_CHANNEL_ID=' "$INSTANCE_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"')
  if [[ -z "$token" || -z "$channel" ]]; then
    echo "  (SLACK_BOT_TOKEN or DEVOPS_CHANNEL_ID missing in .env, Slack skipped)"
    return
  fi

  local payload
  payload=$(jq -n --arg channel "$channel" --arg text "$message" \
    '{channel: $channel, text: $text}')
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "$payload" > /dev/null || echo "  (Slack POST failed, continuing)"
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
  if (( ${#LIVE_PLISTS[@]} > 0 )); then
    for plist in "${LIVE_PLISTS[@]}"; do
      local label="${plist%.plist}"
      if launchctl print "gui/$(id -u)/$label" &>/dev/null; then
        running="$running $label"
      fi
    done
  fi
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
  # Skip in dry-run: we're not mutating the instance, so lingering children
  # aren't dangerous, and a global pgrep picks up unrelated host processes
  # (e.g. the operator's own editor-side Playwright MCP) in a dev harness.
  if ! $DRY_RUN && pgrep -f playwright-mcp >/dev/null 2>&1; then
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

# =============================================================================
# Step 2 — Snapshot for rollback
# =============================================================================
step_snapshot() {
  echo "==> Step 2: snapshot → $INSTANCE_DIR.pre-0.2-bak"
  if $DRY_RUN; then
    echo "  [DRY RUN] would cp -a $INSTANCE_DIR $INSTANCE_DIR.pre-0.2-bak"
    return
  fi
  cp -a "$INSTANCE_DIR" "$INSTANCE_DIR.pre-0.2-bak"
  echo "  ✓ snapshot complete ($(du -sh "$INSTANCE_DIR.pre-0.2-bak" | awk '{print $1}'))"
}

# =============================================================================
# Step 3 — Create new skeleton namespaces
# =============================================================================
step_skeleton() {
  echo "==> Step 3: create namespace dirs"
  local dirs=(
    "$INSTANCE_DIR/agents"
    "$INSTANCE_DIR/workflow"
    "$INSTANCE_DIR/data"
    "$INSTANCE_DIR/skills"
    "$INSTANCE_DIR/plugins"
    "$INSTANCE_DIR/.hive"
    "$INSTANCE_DIR/.hive-state"
  )
  for d in "${dirs[@]}"; do
    if $DRY_RUN; then
      echo "  [DRY RUN] mkdir -p $d"
    else
      mkdir -p "$d"
    fi
  done
  echo "  ✓ skeleton created"
}

step_snapshot
step_skeleton

# =============================================================================
# Step 4 — Relocate .hive/git/ + snapshots → .hive-state/
# =============================================================================
# Spec: destination names must match Phase 2's hiveStateDir/instanceGitDir in
# src/paths.ts. Cross-reference before shipping.
step_relocate_state() {
  echo "==> Step 4: relocate .hive/git/ → .hive-state/"
  if $DRY_RUN; then
    [[ -d "$INSTANCE_DIR/.hive/git" ]] && echo "  [DRY RUN] mv .hive/git .hive-state/git"
    for f in installed-snapshot.json previous-snapshot.json upgrade-notice-emitted; do
      if [[ -e "$INSTANCE_DIR/.hive/$f" ]]; then
        echo "  [DRY RUN] mv .hive/$f .hive-state/$f"
      fi
    done
    return 0
  fi
  if [[ -d "$INSTANCE_DIR/.hive/git" ]]; then
    mv "$INSTANCE_DIR/.hive/git" "$INSTANCE_DIR/.hive-state/git"
  fi
  for f in installed-snapshot.json previous-snapshot.json upgrade-notice-emitted; do
    if [[ -e "$INSTANCE_DIR/.hive/$f" ]]; then
      mv "$INSTANCE_DIR/.hive/$f" "$INSTANCE_DIR/.hive-state/$f"
    fi
  done
  echo "  ✓ state relocated"
}

# =============================================================================
# Step 5 — Wipe engine files at instance root + prune service/
# =============================================================================
# The rm list is enumerated explicitly — NO wildcard globs that could catch
# hive.yaml or .env. service/ is preserved; only engine-shipped scripts inside
# it are removed. Live plists (discovered in preflight via LIVE_PLISTS) are
# preserved.
step_wipe_engine() {
  echo "==> Step 5: wipe old engine files"
  local targets=(
    "$INSTANCE_DIR/dist"
    "$INSTANCE_DIR/node_modules"
    "$INSTANCE_DIR/src"
    "$INSTANCE_DIR/build"
    "$INSTANCE_DIR/setup"
    "$INSTANCE_DIR/seeds"
    "$INSTANCE_DIR/templates"
    "$INSTANCE_DIR/tests"
    "$INSTANCE_DIR/scripts"
    "$INSTANCE_DIR/docs"
    "$INSTANCE_DIR/install"
    "$INSTANCE_DIR/plugins/claude-code"
    "$INSTANCE_DIR/package.json"
    "$INSTANCE_DIR/package-lock.json"
    "$INSTANCE_DIR/tsconfig.json"
    "$INSTANCE_DIR/tsconfig.plugins.json"
    "$INSTANCE_DIR/eslint.config.js"
    "$INSTANCE_DIR/vitest.config.ts"
    "$INSTANCE_DIR/AGENTS.md"
    "$INSTANCE_DIR/README.md"
    "$INSTANCE_DIR/CLAUDE.md"
    "$INSTANCE_DIR/.github"
  )
  for t in "${targets[@]}"; do
    if [[ -e "$t" ]]; then
      if $DRY_RUN; then
        echo "  [DRY RUN] rm -rf $t"
      else
        rm -rf "$t"
      fi
    fi
  done

  # Inside service/: delete engine-shipped files, preserve live plists.
  if [[ -d "$INSTANCE_DIR/service" ]]; then
    for f in "$INSTANCE_DIR/service"/*; do
      [[ -e "$f" ]] || continue
      local name
      name=$(basename "$f")
      local is_live=false
      # LIVE_PLISTS is always initialized by preflight() (declare -g -a LIVE_PLISTS=()),
      # so direct expansion is safe. The ${#...} > 0 guard avoids iterating once with
      # an empty string when the array is empty.
      if (( ${#LIVE_PLISTS[@]} > 0 )); then
        for live in "${LIVE_PLISTS[@]}"; do
          [[ "$name" == "$live" ]] && is_live=true && break
        done
      fi
      if ! $is_live; then
        if $DRY_RUN; then
          echo "  [DRY RUN] rm -f service/$name"
        else
          rm -f "$f"
        fi
      fi
    done
  fi

  echo "  ✓ engine files wiped (live plists preserved: ${LIVE_PLISTS[*]:-<none>})"
}

step_relocate_state
step_wipe_engine

# =============================================================================
# Step 6 — Classify and relocate loose agent files
# =============================================================================
# Ordering is load-bearing: agent-prefix patterns fire before content-type
# patterns. See spec §Step 6 for the canonical table.
#
# classify_file <basename>  → emits destination dir (relative to $INSTANCE_DIR)
classify_file() {
  local name="$1"
  # Agent-prefix (case-insensitive) — first match wins
  case "$name" in
    milo-*|MILO-*)         echo "agents/milo/reports/archive-pre-0.2" ;;
    river-*|RIVER-*)       echo "agents/river/reports/archive-pre-0.2" ;;
    jessica-*|JESSICA-*)   echo "agents/jessica/reports/archive-pre-0.2" ;;
    wyatt-*|WYATT-*)       echo "agents/wyatt/reports/archive-pre-0.2" ;;
    rae-*|RAE-*)           echo "agents/rae/reports/archive-pre-0.2" ;;
    chloe-*|CHLOE-*)       echo "agents/chloe/reports/archive-pre-0.2" ;;
    colt-*|COLT-*)         echo "agents/colt/reports/archive-pre-0.2" ;;
    sige-*|SIGE-*)         echo "agents/sige/reports/archive-pre-0.2" ;;

    # Social scrapes (no single agent owner)
    fb-*.md|linkedin-*.md|x-*.md|x-snapshot-*)
                           echo "data/archive-pre-0.2/social-scrapes" ;;

    # Standups — Milo's domain
    *-standup-*.md|*-standup-*.json|sales-*-standup-*)
                           echo "agents/milo/reports/archive-pre-0.2" ;;

    # Permit data — River's
    PERMIT-*|high-tier-permits*.csv|*-permits.csv)
                           echo "agents/river/reports/archive-pre-0.2" ;;

    # Pipeline data — Milo
    HUBSPOT-*|STALE-DEALS-*|stale-deals.csv|*-sales-pipeline-*)
                           echo "agents/milo/reports/archive-pre-0.2" ;;

    # Ambiguous — safer to park
    LEAD-SEGMENTATION-*|QUERY-RESULTS-*)
                           echo "data/archive-pre-0.2/unsorted" ;;

    # Ad-hoc scripts at root — keep, don't delete (may be referenced in tickets)
    analyze-*.ts|check-*.ts|create-*.ts|extract-*.ts|fetch-*.ts|get-*.ts|verify-*.ts|*.ts)
                           echo "data/archive-pre-0.2/scripts" ;;

    # Per-artifact readmes — keep alongside data
    README-*.md)           echo "data/archive-pre-0.2" ;;

    # Catch-all
    *)                     echo "data/archive-pre-0.2/unsorted" ;;
  esac
}

# =============================================================================
# Step 6 (continued) — iterate loose files at instance root
# =============================================================================
step_classify_loose_files() {
  echo "==> Step 6: classify loose agent files"

  # Build the list of "loose files" — anything at the instance root that
  # isn't one of the known config/data dirs we're preserving.
  local preserve_names=(
    ".env" ".env-personal"
    "hive.yaml" "hive-personal.yaml" "beekeeper.yaml"
    ".hive-generated.json"
    ".hive" ".hive-state" ".hive.prev" ".hive.broken"
    "agents" "workflow" "data" "skills" "plugins"
    "logs" "logs-beekeeper" "logs-personal"
    "service"
    ".git"   # removed in Step 9; leave alone here
    ".DS_Store"
  )

  declare -a moves=()
  shopt -s dotglob nullglob
  for entry in "$INSTANCE_DIR"/*; do
    local name
    name=$(basename "$entry")
    local skip=false
    for preserve in "${preserve_names[@]}"; do
      [[ "$name" == "$preserve" ]] && skip=true && break
    done
    $skip && continue

    # Special case: .playwright-mcp/ is deleted outright (spec §Step 6)
    if [[ "$name" == ".playwright-mcp" ]]; then
      local size
      size=$(du -sh "$entry" 2>/dev/null | awk '{print $1}')
      if $DRY_RUN; then
        echo "  [DRY RUN] rm -rf .playwright-mcp ($size of console logs)"
      else
        echo "  Removing .playwright-mcp ($size)..."
        rm -rf "$entry"
      fi
      continue
    fi

    local dest
    dest=$(classify_file "$name")
    moves+=("$name|$dest")
  done
  shopt -u dotglob nullglob

  # Emit the classification table
  if [[ ${#moves[@]} -eq 0 ]]; then
    echo "  (no loose files to classify)"
  else
    printf "  %-60s → %s\n" "FILE" "DESTINATION"
    for m in "${moves[@]}"; do
      IFS='|' read -r name dest <<< "$m"
      printf "  %-60s → %s\n" "$name" "$dest"
    done
  fi

  # Execute the moves (unless dry-run)
  if $DRY_RUN; then
    return
  fi
  for m in "${moves[@]}"; do
    IFS='|' read -r name dest <<< "$m"
    mkdir -p "$INSTANCE_DIR/$dest"
    mv "$INSTANCE_DIR/$name" "$INSTANCE_DIR/$dest/"
  done
  echo "  ✓ ${#moves[@]} file(s) relocated"
}

step_classify_loose_files

if $DRY_RUN; then
  echo ""
  echo "==> Dry-run complete. No filesystem mutations performed."
  echo "   Review the classification table above. If destinations look right,"
  echo "   re-run without --dry-run to migrate for real."
  exit 0
fi

# =============================================================================
# Step 7 — Populate .hive/ with the 0.2.0 engine
# =============================================================================
step_populate_engine() {
  echo "==> Step 7: populate .hive/ with @keepur/hive@0.2.0"

  # Install globally if not already on 0.2.x (any patch release — don't downgrade
  # a customer who's on 0.2.1+ back to 0.2.0).
  local current=""
  if command -v hive >/dev/null 2>&1; then
    current=$(hive --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//')
  fi
  if [[ "$current" != 0.2.* ]]; then
    echo "  Installing @keepur/hive@0.2.0 globally (current: ${current:-<none>})..."
    npm i -g "@keepur/hive@0.2.0"
  else
    echo "  Global CLI already on $current (≥0.2.0 — keeping it)."
  fi

  local cli_bin
  cli_bin=$(command -v hive)
  if [[ -z "$cli_bin" ]]; then
    echo "ERROR: hive CLI not found on PATH after npm install." >&2
    exit 1
  fi
  local cli_root
  cli_root=$(dirname "$(realpath "$cli_bin")")/..

  # PACKAGE_ENTRIES — must match Phase 4's src/setup/populate-engine.ts exactly.
  # If you change this list, change it there too (and in deploy.sh fetch_engine).
  local entries=(pkg seeds templates scripts/honeypot install package.json)
  for entry in "${entries[@]}"; do
    local src="$cli_root/$entry"
    if [[ ! -e "$src" ]]; then
      echo "ERROR: expected engine entry '$entry' missing from $cli_root." >&2
      echo "       Verify @keepur/hive@0.2.0 installed correctly: npm ls -g @keepur/hive" >&2
      exit 1
    fi
    local dst="$INSTANCE_DIR/.hive/$entry"
    mkdir -p "$(dirname "$dst")"
    if [[ -d "$src" ]]; then
      mkdir -p "$dst"
      rsync -a "$src/" "$dst/"
    else
      rsync -a "$src" "$dst"
    fi
  done

  # Sanity check
  if [[ ! -f "$INSTANCE_DIR/.hive/pkg/server.min.js" ]]; then
    echo "ERROR: .hive/pkg/server.min.js missing after populate" >&2
    exit 1
  fi
  echo "  ✓ .hive/ populated (version: $(jq -r .version "$INSTANCE_DIR/.hive/package.json"))"
}

# =============================================================================
# Step 7b — Install engine runtime deps (mirror install_engine_deps in deploy.sh)
# =============================================================================
# The npm-packed .hive/ bundle lists 14 runtime externals in package.json that
# live OUTSIDE pkg/server.min.js (native modules, large SDKs, asset loaders).
# Without node_modules/, the engine crashes at startup. Mirrors
# service/deploy.sh:211 install_engine_deps() exactly.
step_install_engine_deps() {
  echo "==> Step 7b: install engine runtime deps"
  if [[ ! -f "$INSTANCE_DIR/.hive/package.json" ]]; then
    echo "ERROR: install_engine_deps needs $INSTANCE_DIR/.hive/package.json" >&2
    exit 1
  fi
  (cd "$INSTANCE_DIR/.hive" && npm install --omit=dev --no-audit --no-fund --no-progress)
  echo "  ✓ engine deps installed"
}

step_populate_engine
step_install_engine_deps

# =============================================================================
# Step 8 — Rewrite hive.yaml paths
# =============================================================================
# Only surgery: codeTask.pluginDirs, which pointed at the shared
# ~/services/hive/plugins/claude-code/... pre-migration. Post-migration each
# instance has its own .hive/plugins/claude-code/.
step_rewrite_yaml() {
  echo "==> Step 8: rewrite hive.yaml codeTask.pluginDirs"

  # yq's sub() returns a stream for each array element; wrapping in [...]
  # is load-bearing to keep the result as an array.
  yq -i '.codeTask.pluginDirs = [
    .codeTask.pluginDirs[]
    | sub("^~/services/hive/plugins/"; "~/services/hive/'"$INSTANCE_ID"'/.hive/plugins/")
  ]' "$INSTANCE_DIR/hive.yaml"

  echo "  ✓ hive.yaml rewritten"
}

# =============================================================================
# Step 9 — Remove instance-root .git/
# =============================================================================
step_remove_git() {
  echo "==> Step 9: remove instance-root .git/"
  if [[ -d "$INSTANCE_DIR/.git" ]]; then
    rm -rf "$INSTANCE_DIR/.git"
    echo "  ✓ .git removed"
  else
    echo "  (no .git to remove)"
  fi
}

step_rewrite_yaml
step_remove_git

# =============================================================================
# Step 10 — Regenerate live plist(s) + bootstrap
# =============================================================================
step_regenerate_plists() {
  echo "==> Step 10: regenerate LaunchAgent plists"

  # 10a. Retire legacy labels that don't match com.hive.<id>.agent.
  # Only dodi has this case (live label: com.hive.agent). Keepur's label is
  # already com.hive.keepur.agent. If we add more exceptions, list them here.
  local legacy_labels=(com.hive.agent)
  for legacy in "${legacy_labels[@]}"; do
    local link="$HOME/Library/LaunchAgents/$legacy.plist"
    [[ -L "$link" ]] || continue
    local abs
    abs=$(realpath "$link" 2>/dev/null || true)
    if [[ "$abs" == "$INSTANCE_DIR/service/"* ]]; then
      echo "  Retiring legacy label: $legacy"
      launchctl bootout "gui/$(id -u)/$legacy" 2>/dev/null || true
      rm -f "$link" "$INSTANCE_DIR/service/$legacy.plist"
    fi
  done

  # 10b. Regenerate one plist per config file.
  # hive.yaml (primary) + any hive-<suffix>.yaml (e.g., hive-personal.yaml).
  # hive daemon start reads HIVE_CONFIG, derives the label from that config's
  # instance.id, writes service/<label>.plist, creates the LaunchAgents
  # symlink, and launchctl-loads it (see src/cli/daemon.ts:84 startDaemon).
  local regenerated=0
  for yaml in "$INSTANCE_DIR"/hive.yaml "$INSTANCE_DIR"/hive-*.yaml; do
    [[ -f "$yaml" ]] || continue
    local cfg
    cfg=$(basename "$yaml")
    echo "  hive daemon start (HIVE_CONFIG=$cfg)"
    if ! HIVE_HOME="$INSTANCE_DIR" HIVE_CONFIG="$cfg" hive daemon start; then
      echo "ERROR: hive daemon start failed for $cfg." >&2
      return 1
    fi
    regenerated=$((regenerated + 1))
  done

  if [[ $regenerated -eq 0 ]]; then
    echo "ERROR: no hive.yaml or hive-*.yaml found at $INSTANCE_DIR — nothing to regenerate." >&2
    return 1
  fi
  echo "  ✓ $regenerated plist(s) regenerated"

  # Note: com.hive.deploy-check.plist and com.hive.rotate-logs.plist (if present
  # in service/) are utility jobs whose ProgramArguments reference scripts
  # under service/, not the engine bundle. They need no regeneration and were
  # preserved by Step 5's LIVE_PLISTS symlink-detection filter.
}

# =============================================================================
# Step 11 — Health check
# =============================================================================
# Reads the hive.log for "Hive is running". 30s timeout matches deploy.sh.
step_health_check() {
  echo "==> Step 11: health check"
  # Try to find logs dir — defaults to $INSTANCE_DIR/logs, but instances.conf
  # may specify a different one. Peek the yaml if present.
  local logs_dir="logs"
  if command -v yq >/dev/null 2>&1; then
    local yaml_logs
    yaml_logs=$(yq -r '.logging.dir // ""' "$INSTANCE_DIR/hive.yaml" 2>/dev/null)
    [[ -n "$yaml_logs" ]] && logs_dir="$yaml_logs"
  fi
  local log_file="$INSTANCE_DIR/$logs_dir/hive.log"

  for _ in $(seq 1 30); do
    sleep 1
    if tail -20 "$log_file" 2>/dev/null | grep -q '"Hive is running"'; then
      echo "  ✓ healthy"
      return 0
    fi
  done

  echo "  ✗ health check TIMEOUT (30s)"
  return 1
}

# =============================================================================
# Step 12 — Auto-rollback
# =============================================================================
# Discovers labels via ~/Library/LaunchAgents symlink resolution (not from
# hardcoded INSTANCE_ID-derived strings, because dodi's label is legacy
# com.hive.agent, not com.hive.dodi.agent).
auto_rollback() {
  echo "==> AUTO-ROLLBACK"

  declare -a LABELS=()
  for link in "$HOME/Library/LaunchAgents"/com.hive.*.plist; do
    [[ -L "$link" ]] || continue
    local abs
    abs=$(realpath "$link" 2>/dev/null || true)
    if [[ -n "$abs" && "$abs" == "$INSTANCE_DIR/service/"* ]]; then
      LABELS+=("$(basename "$link" .plist)")
    fi
  done

  if (( ${#LABELS[@]} > 0 )); then
    for label in "${LABELS[@]}"; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    done
  fi

  rm -rf "$INSTANCE_DIR"
  mv "$INSTANCE_DIR.pre-0.2-bak" "$INSTANCE_DIR"

  if (( ${#LABELS[@]} > 0 )); then
    for label in "${LABELS[@]}"; do
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
    done
  fi

  notify "Migration to 0.2.0 FAILED and was rolled back for $INSTANCE_DIR. Instance(s) back on 0.1.x: ${LABELS[*]:-<none>}."
}

if ! step_regenerate_plists; then
  auto_rollback
  exit 1
fi

if ! step_health_check; then
  auto_rollback
  exit 1
fi

notify "Migration succeeded: $INSTANCE_DIR → 0.2.0."
echo ""
echo "==> Migration complete."
echo "   Snapshot preserved at: $INSTANCE_DIR.pre-0.2-bak"
echo "   Remove it once you've confirmed the instance is stable (24h+ recommended):"
echo "     rm -rf $INSTANCE_DIR.pre-0.2-bak"
