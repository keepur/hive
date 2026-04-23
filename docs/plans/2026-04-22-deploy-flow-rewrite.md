# Deploy Flow Rewrite Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Ticket:** [KPR-53](https://linear.app/keepur/issue/KPR-53) (Phase 3 of KPR-50, v0.2.0)
**Spec:** [2026-04-21-deploy-flow-rewrite-design.md](../specs/2026-04-21-deploy-flow-rewrite-design.md)
**Depends on:** [KPR-52](https://linear.app/keepur/issue/KPR-52) (Phase 2 — engine relocated into `.hive/`) must be merged to `deploy` before this plan runs on a real instance. The code changes here are authored against the post-Phase-2 tree; the `deploy.sh` rewrite references `$DEPLOY_DIR/.hive/` paths that only exist after Phase 2.
**Branch:** `kpr-53` (branch from `deploy` after KPR-52 is merged there)

**Goal:** Retire `git pull` against the instance dir and the skill auto-commit hack. New deploy flow fetches an npm tarball (fallback: rsync from `$BUILD_DIR/pkg/`), extracts flat into `.hive.next/`, swaps with `.hive/`, restarts. One-command rollback via `.hive.prev/` directory swap. Per-instance version pinning via a new `ENGINE_TAG` column in `instances.conf`.

**Architecture:** `deploy.sh` becomes the single implementation of fetch/swap/rollback. `src/cli/update.ts` is rewritten to shell out to `deploy.sh --tag=...`; new `src/cli/rollback.ts` shells out to `deploy.sh --rollback --instance=...`. The deploy script grows three helpers (`fetch_engine`, `swap_engine`, `rollback_engine`) and a `--instance=<id>` / `--tag=<tag>` / `--rollback` flag set. `deploy-check.sh` switches from SHA-compare (against `origin/deploy`) to per-instance version-compare (against `npm view @keepur/hive`).

**Tech Stack:** Bash (`deploy.sh`, `deploy-check.sh`), TypeScript strict (`src/cli/*.ts`), Vitest, `bats` or plain `set -e` shell test harness.

---

## File Structure

### New files
- `src/cli/rollback.ts` — typed wrapper around `deploy.sh --rollback --instance=<id>`.
- `service/deploy.test.sh` — shell smoke harness for `fetch_engine` / `swap_engine` / `rollback_engine` against a scratch temp dir.
- `docs/deployment.md` — customer/operator-facing description of the new deploy flow, pinning, and rollback.

### Modified files
- `service/deploy.sh` — major rewrite. Keeps the outer shape (load instances → build phase → deploy phase → report phase) but replaces the Phase 1 auto-commit block and the per-instance sync logic.
- `service/deploy-check.sh` — SHA compare replaced with per-instance `npm view` version compare.
- `service/instances.conf` — add `ENGINE_TAG` column (7th pipe-separated field).
- `src/cli/update.ts` — rewrite to shell out to `deploy.sh --tag=...`.
- `src/cli.ts` — register new `rollback` command; update `--help` output.
- `src/cli/update.test.ts` — extend (or create, if not present) to cover the new shell-out behavior.

### Intentionally NOT touched (per spec, §Files touched / Not touched in Phase 3)
- `src/*` engine code outside `cli/update.ts`, `cli/rollback.ts`, and `cli.ts` — deploy mechanics only.
- `service/install.sh` — Phase 4 rewrites the fresh-install path.
- Existing instance layout migration — Phase 5.
- `.github/workflows/publish.yml` — the npm publish pipeline is unchanged; Phase 3 just *consumes* the published package differently downstream.
- `package.json` `files` field — already correct per Phase 2.

### Precondition check before starting
- KPR-52 must be merged to `deploy`. Verify by inspecting `$BUILD_DIR` on the deploy machine:
  ```bash
  ls ~/build/hive/.hive/ ~/build/hive/pkg/ 2>/dev/null
  ```
  If `.hive/` doesn't exist as an engine dir and `pkg/` doesn't contain `server.min.js`, KPR-52 hasn't landed — stop and wait.
- Verify `@keepur/hive` is published on npm at a version that includes the Phase 2 tree: `npm view @keepur/hive version` → expect `0.2.0-*` or later.

---

## Task 1: Extend `instances.conf` with `ENGINE_TAG` column

**Files:**
- Modify: `service/instances.conf`

- [ ] **Step 1:** Update the comment block and data rows to add the 7th column.

Replace the entire contents of `service/instances.conf`:

```
# Hive instance definitions — one per line
# Fields: INSTANCE_ID | HIVE_CONFIG | (unused) | LAUNCHAGENT_LABEL | LOGS_DIR | PORTS (space-separated) | ENGINE_TAG
#
# HIVE_CONFIG is relative to DEPLOY_DIR
# Agents are stored in MongoDB (agent_definitions collection), not on disk
# PORTS are checked/killed on deploy restart
# ENGINE_TAG is the npm version tag to deploy for this instance. Accepts `v0.2.0` or `0.2.0`
#   (leading `v` stripped before npm calls). Omit to default to the `latest` dist-tag.

dodi|hive.yaml|-|com.hive.agent|logs|3100 3200|v0.2.0
personal|hive-personal.yaml|-|com.hive.personal.agent|logs-personal|3400 3403|v0.2.0
```

Rationale for starting both instances at the same `v0.2.0` pin: Phase 3 ships the *mechanism* for independent pinning but doesn't exercise it. Phase 5 is where keepur and dodi diverge (keepur as canary on the `0.2.0` migration, dodi follows 48h later). For Phase 3 acceptance tests, both riding the same tag is the natural setup.

- [ ] **Step 2:** Verify format

Run:
```bash
awk -F'|' 'NF != 7 && !/^[[:space:]]*#/ && NF > 0 { print "bad row (NF="NF"):", $0; exit 1 } END { print "ok" }' service/instances.conf
```
Expected: prints `ok`. Any row with fewer than 7 pipe-separated fields errors.

- [ ] **Step 3:** Commit

```bash
git checkout -b kpr-53
git add service/instances.conf
git commit -m "chore(instances): add ENGINE_TAG column for per-instance pinning (KPR-53)"
```

---

## Task 2: Update `instances.conf` parser in `deploy.sh`

**Files:**
- Modify: `service/deploy.sh:25-36`

- [ ] **Step 1:** Replace the `while IFS='|' read` loop that populates `INSTANCES`. The current parser reads 6 fields and silently swallows the 7th into `ports`, which breaks `kill_ports`.

Find (lines 25-36):

```bash
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
```

Replace with:

```bash
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
```

- [ ] **Step 2:** Update the downstream IFS split in the Phase 2 deploy loop (line 204). It currently unpacks 5 fields; now it must unpack 6.

Find:

```bash
  IFS='|' read -r id config label logs_dir ports <<< "$inst"
```

Replace with:

```bash
  IFS='|' read -r id config label logs_dir ports engine_tag <<< "$inst"
```

- [ ] **Step 3:** Verify

Run:
```bash
bash -n service/deploy.sh
```
Expected: syntax OK (no output).

- [ ] **Step 4:** Don't commit yet — Task 3 replaces the block this parser feeds into, so the two changes land as one coherent commit.

---

## Task 3: Add CLI flag parsing to `deploy.sh`

**Files:**
- Modify: `service/deploy.sh:14-16`

The script needs to accept `--tag=<tag>`, `--instance=<id>`, and `--rollback` in addition to the existing `--dry-run`. The `--instance` flag filters the deploy to a single instance; `--tag` overrides the per-instance pinned tag; `--rollback` swaps `.hive` ↔ `.hive.prev`.

- [ ] **Step 1:** Replace the flag block (lines 14-16).

Find:

```bash
# --- Flags ---
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
```

Replace with:

```bash
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
```

- [ ] **Step 2:** Verify

Run:
```bash
bash -n service/deploy.sh
```
Expected: syntax OK.

- [ ] **Step 3:** Don't commit yet — coherent commit at end of Task 5.

---

## Task 4: Add engine fetch/swap/rollback helpers to `deploy.sh`

**Files:**
- Modify: `service/deploy.sh` (insert new helpers after the existing `kill_ports` helper, before the Phase 1 build block)

The three helpers encapsulate the new deploy primitives:

- `fetch_engine <instance_dir> <tag>` — populates `<instance_dir>/.hive.next/` with the tag's contents. Preferred path is `npm pack @keepur/hive@<version>`; fallback is `rsync -a` from `$BUILD_DIR/pkg/`, `seeds/`, `templates/`, `scripts/honeypot`, `package.json`.
- `swap_engine <instance_dir>` — atomically rotates `.hive → .hive.prev → (discard)` and `.hive.next → .hive`. Drops any pre-existing `.hive.prev/` first so only one backup is retained.
- `rollback_engine <instance_dir>` — swaps `.hive` and `.hive.prev`. Leaves the failed engine at `.hive.broken/` for operator inspection. Errors out if `.hive.prev/` doesn't exist.

- [ ] **Step 1:** Insert the helpers after `kill_ports()` (after line 99 in the current file — after the `sleep 1` that closes `kill_ports`).

```bash
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

# fetch_engine <instance_dir> <tag>
# Populates <instance_dir>/.hive.next/ with the tag's contents.
# Primary path: npm pack @keepur/hive@<version> + tar -xzf --strip-components=1.
# Fallback: rsync from $BUILD_DIR (developer-ergonomics path).
fetch_engine() {
  local instance_dir="$1"
  local tag="$2"
  local version
  version=$(_normalize_tag "$tag")

  rm -rf "$instance_dir/.hive.next"
  mkdir -p "$instance_dir/.hive.next"

  if [[ "$version" == "latest" || -n "$(npm view "@keepur/hive@$version" version 2>/dev/null)" ]]; then
    echo "  fetch_engine: npm pack @keepur/hive@$version"
    local packdir
    packdir=$(mktemp -d)
    local tarball
    # npm pack prints the tarball filename on the last line of stdout.
    # Run from a temp dir so the tarball doesn't litter $PWD.
    tarball=$(cd "$packdir" && npm pack "@keepur/hive@$version" 2>/dev/null | tail -n1)
    if [[ -z "$tarball" || ! -f "$packdir/$tarball" ]]; then
      rm -rf "$packdir" "$instance_dir/.hive.next"
      echo "ERROR: npm pack @keepur/hive@$version produced no tarball" >&2
      return 1
    fi
    tar -xzf "$packdir/$tarball" --strip-components=1 -C "$instance_dir/.hive.next/"
    rm -rf "$packdir"
  else
    echo "  fetch_engine: npm view failed; falling back to rsync from $BUILD_DIR"
    local src="$BUILD_DIR"
    if [[ ! -f "$src/pkg/server.min.js" ]]; then
      rm -rf "$instance_dir/.hive.next"
      echo "ERROR: fallback rsync needs $src/pkg/server.min.js — run 'npm run bundle' in $src" >&2
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
```

- [ ] **Step 2:** Verify

Run:
```bash
bash -n service/deploy.sh
```
Expected: syntax OK.

- [ ] **Step 3:** Don't commit yet.

---

## Task 5: Replace the Phase 1 build block and Phase 2 per-instance block

**Files:**
- Modify: `service/deploy.sh` (replace the Phase 1 block after line 100 through end of Phase 2 at line 229)

This is the load-bearing change. The replacement is broken into three sub-steps for clarity: handle `--rollback` early, rewrite Phase 1 (build), rewrite Phase 2 (per-instance deploy).

- [ ] **Step 1:** Handle `--rollback` before any build work. Insert this block immediately after the `# --- Engine fetch/swap/rollback ---` helpers you added in Task 4, and before the Phase 1 heading.

```bash
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
  echo "--- Rolling back $id ---"
  kill_ports "$ports"
  if ! rollback_engine "$DEPLOY_DIR"; then
    notify "Rollback FAILED for \`$id\`: no previous engine (.hive.prev missing)."
    exit 1
  fi
  run_cmd launchctl kickstart -k "gui/$(id -u)/$label"
  if health_check "$DEPLOY_DIR/$logs_dir/hive.log"; then
    rollback_version=$(jq -r .version < "$DEPLOY_DIR/.hive/package.json" 2>/dev/null || echo "unknown")
    notify "Rollback succeeded for \`$id\` → \`$rollback_version\`."
    echo "Rollback complete."
    exit 0
  else
    notify "Rollback succeeded but health check failed for \`$id\`. Check logs."
    exit 1
  fi
fi
```

Note: `rollback_version` is a plain top-level variable (no `local` since this block runs at script scope, not inside a function).

- [ ] **Step 2:** Replace the Phase 1 build block (lines 101-195 in current file — starting with the `# ============================================================================= # Phase 1: Build (once)` banner through the `[[ -d "$BUILD_DIR/plugins/claude-code" ]]` rsync).

Find the entire block from:

```bash
# =============================================================================
# Phase 1: Build (once)
# =============================================================================

cd "$DEPLOY_DIR"
PREV_SHA=$(git rev-parse --short HEAD)
```

…through…

```bash
echo "Syncing shared build output..."
run_cmd rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"
[[ -d "$BUILD_DIR/plugins/claude-code" ]] && run_cmd rsync -a --delete "$BUILD_DIR/plugins/claude-code/" "$DEPLOY_DIR/plugins/claude-code/"
```

Replace with:

```bash
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
```

Three callouts:

1. **Gone:** the `cd "$DEPLOY_DIR"; PREV_SHA=$(git rev-parse --short HEAD)` at the top — instance dirs no longer carry git state. `PREV_VERSION` comes from `.hive/package.json` instead.
2. **Gone:** the entire skill auto-commit block (lines 111-158) — it only existed because `skills/` lived inside the instance's git clone. After Phase 2, `skills/` is at instance root and the instance dir is not a git clone.
3. **Gone:** the `cd "$DEPLOY_DIR"; git pull --ff-only; npm install --omit=dev; rsync dist/; rsync plugins/claude-code/` block (lines 187-195) — replaced by per-instance `fetch_engine` in Phase 2 below.
4. **Added:** `npm run bundle` step — the fallback path in `fetch_engine` needs `$BUILD_DIR/pkg/server.min.js` to exist. Even when the primary path (npm pack) is used, running bundle here guarantees the fallback is always ready.

- [ ] **Step 3:** Replace the Phase 2 per-instance deploy block.

Find the entire block from:

```bash
# =============================================================================
# Phase 2: Deploy each instance
# =============================================================================

FAILED_INSTANCES=()

for inst in "${INSTANCES[@]}"; do
  IFS='|' read -r id config label logs_dir ports engine_tag <<< "$inst"
```

…through the closing `done` of the for-loop (line 229).

Replace with:

```bash
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

  echo ""
  echo "--- Phase 2: Deploy instance '$id' @ $tag ---"
  echo "  config=$config label=$label logs=$logs_dir ports=$ports"

  mkdir -p "$DEPLOY_DIR/$logs_dir"

  echo "  Stopping $label..."
  run_cmd launchctl kickstart -kp "gui/$(id -u)/$label" 2>/dev/null || true
  kill_ports "$ports"

  echo "  Fetching engine..."
  if ! fetch_engine "$DEPLOY_DIR" "$tag"; then
    notify "Deploy FAILED for \`$id\`: fetch_engine errored at tag \`$tag\`."
    FAILED_INSTANCES+=("$id")
    run_cmd launchctl kickstart -k "gui/$(id -u)/$label" || true  # bring old engine back up
    continue
  fi

  echo "  Swapping engine..."
  swap_engine "$DEPLOY_DIR"

  echo "  Restarting $label..."
  run_cmd launchctl kickstart -k "gui/$(id -u)/$label"

  echo "  Checking health..."
  if ! health_check "$DEPLOY_DIR/$logs_dir/hive.log"; then
    echo "  Health check FAILED for $id — rolling back"
    if rollback_engine "$DEPLOY_DIR"; then
      run_cmd launchctl kickstart -k "gui/$(id -u)/$label"
      notify "Deploy rolled back for \`$id\`: \`$tag\` failed health check, restored previous version."
    else
      notify "Deploy FAILED for \`$id\` and auto-rollback unavailable (.hive.prev missing). Manual intervention required."
    fi
    FAILED_INSTANCES+=("$id")
    continue
  fi

  new_version=$(jq -r .version < "$DEPLOY_DIR/.hive/package.json" 2>/dev/null || echo "unknown")
  echo "  Instance '$id' is healthy at version $new_version."
done
```

- [ ] **Step 4:** Update the Phase 3 report block — the notify messages still reference `$DEPLOY_SHA` which is the build-dir SHA (still valid) but should also mention the target tag(s) for clarity.

Find:

```bash
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
```

Replace with:

```bash
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
```

- [ ] **Step 5:** Verify

Run:
```bash
bash -n service/deploy.sh
```
Expected: syntax OK.

Run:
```bash
shellcheck service/deploy.sh 2>&1 | head -30
```
Expected: no errors (warnings about quoting style are OK — keep the patch minimal; don't chase shellcheck suggestions that aren't blocking).

- [ ] **Step 6:** Commit all of Tasks 2-5 as one coherent change.

```bash
git add service/deploy.sh
git commit -m "feat(deploy): tarball-based engine swap, per-instance pinning, auto-rollback (KPR-53)"
```

---

## Task 6: Rewrite `deploy-check.sh` as per-instance version compare

**Files:**
- Modify: `service/deploy-check.sh`

The current script polls `origin/deploy` in `$BUILD_DIR` and compares SHAs. After Phase 3, "is there a new version" is a per-instance question — each instance has its own pinned tag.

- [ ] **Step 1:** Replace the entire contents of `service/deploy-check.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Deploy check — per-instance version compare against npm
# =============================================================================
#
# Reads each instance's pinned tag from instances.conf. For each instance whose
# installed version (from .hive/package.json) differs from the tag it's pinned to,
# invokes deploy.sh --instance=<id> --tag=<tag>.
#
# Pinned "latest" compares against the npm `latest` dist-tag — so unpinned
# instances autoupgrade whenever a new @keepur/hive is published.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
INSTANCES_CONF="$SCRIPT_DIR/instances.conf"

cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }

echo "Checking for updates on deploy branch..."
git fetch origin deploy --quiet

# --- Load instances ---
declare -a INSTANCES=()
while IFS='|' read -r id config _agents _label logs_dir ports engine_tag; do
  [[ "$id" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$id" ]] && continue
  id=$(echo "$id" | xargs)
  engine_tag=$(echo "${engine_tag:-}" | xargs)
  INSTANCES+=("$id|${engine_tag:-latest}")
done < "$INSTANCES_CONF"

UPDATES_NEEDED=()
for inst in "${INSTANCES[@]}"; do
  IFS='|' read -r id tag <<< "$inst"
  version="${tag#v}"
  installed=$(jq -r .version < "$DEPLOY_DIR/.hive/package.json" 2>/dev/null || echo "unknown")
  if [[ "$version" == "latest" ]]; then
    target=$(npm view @keepur/hive version 2>/dev/null || echo "unknown")
  else
    target=$(npm view "@keepur/hive@$version" version 2>/dev/null || echo "unknown")
  fi
  if [[ "$target" == "unknown" ]]; then
    echo "  [$id] could not resolve target version (pinned: $tag). Skipping."
    continue
  fi
  if [[ "$installed" == "$target" ]]; then
    echo "  [$id] up to date ($installed)."
  else
    echo "  [$id] $installed → $target (pinned: $tag)"
    UPDATES_NEEDED+=("$id|$target")
  fi
done

if [[ ${#UPDATES_NEEDED[@]} -eq 0 ]]; then
  echo "All instances up to date. Nothing to deploy."
  exit 0
fi

echo ""
echo "Updates needed:"
for u in "${UPDATES_NEEDED[@]}"; do
  IFS='|' read -r id target <<< "$u"
  echo "  - $id → $target"
done

# Deploy each one. deploy.sh handles build once per invocation, so we loop.
# Rationale for one-at-a-time: build-phase is shared, but the build is cheap
# to re-run and keeping it inside deploy.sh keeps one script responsible for
# the full flow. If this becomes a performance issue, split build into a
# separate phase invoked once up front.
for u in "${UPDATES_NEEDED[@]}"; do
  IFS='|' read -r id target <<< "$u"
  echo ""
  echo "=== Deploying $id → $target ==="
  "$SCRIPT_DIR/deploy.sh" --instance="$id" --tag="$target"
done
```

Three points:

1. **`SCRIPT_DIR` idiom** is preserved from the original — the script finds its sibling `deploy.sh` without hardcoded absolute paths.
2. **"latest" resolution**: `npm view @keepur/hive version` (no `@tag`) returns the current `latest` dist-tag. For pinned versions, `npm view @keepur/hive@0.2.0 version` returns the exact version — redundant but confirms the pin is available on the registry.
3. **`INSTANCE_ROOT` simplification**: the spec's example uses `$DEPLOY_DIR/$id` for secondary instances, but in the current hive-ops reality dodi and personal *share* `$DEPLOY_DIR`. We compare against a single `$DEPLOY_DIR/.hive/package.json` for all instances because the engine is shared. If that changes (e.g., per-instance `.hive/` dirs land later), re-visit this line.

- [ ] **Step 2:** Verify

Run:
```bash
bash -n service/deploy-check.sh
```
Expected: syntax OK.

- [ ] **Step 3:** Commit

```bash
git add service/deploy-check.sh
git commit -m "feat(deploy-check): per-instance version compare via npm (KPR-53)"
```

---

## Task 7: Rewrite `src/cli/update.ts` to shell out to `deploy.sh`

**Files:**
- Modify: `src/cli/update.ts`

The current implementation runs `npm update -g @keepur/hive`, which updates the *global CLI shim* but doesn't touch any instance's `.hive/`. After Phase 3, `hive update` means "replace `.hive/` on the target instance via `deploy.sh`."

- [ ] **Step 1:** Replace the entire contents of `src/cli/update.ts`.

```typescript
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";

function readInstalledVersion(engineDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(engineDir, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface UpdateOptions {
  tag?: string;
  instance?: string;
}

/**
 * Shell out to deploy.sh for the actual fetch/swap/restart/health-check.
 * Keeps deploy.sh as the single implementation; this function is the typed
 * CLI surface for operators running `hive update`.
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<void> {
  const hiveHome = resolveHiveHome();
  const engineDir = resolve(hiveHome, ".hive");
  const deployScript = resolve(engineDir, "service", "deploy.sh");

  if (!existsSync(deployScript)) {
    console.error(`deploy.sh not found at ${deployScript}.`);
    console.error("Either the engine isn't populated (.hive/ missing) or this is a dev install.");
    process.exit(1);
  }

  const fromVersion = readInstalledVersion(engineDir);
  const tag = opts.tag ?? "latest";

  console.log(`Updating @keepur/hive (current: ${fromVersion}, target: ${tag})...`);

  const args = ["--tag=" + tag];
  if (opts.instance) args.push("--instance=" + opts.instance);

  try {
    execFileSync(deployScript, args, { stdio: "inherit" });
  } catch {
    console.error("Update failed. See deploy.sh output above.");
    process.exit(1);
  }

  const toVersion = readInstalledVersion(engineDir);
  if (fromVersion === toVersion) {
    console.log(`Already at latest matching tag: ${toVersion}.`);
  } else {
    console.log(`Updated: ${fromVersion} → ${toVersion}.`);
  }
}
```

Two callouts:

1. **Gone:** the `stopDaemon` / `startDaemon` calls — `deploy.sh` handles the service lifecycle via `launchctl kickstart`. Calling them here would double-stop.
2. **Gone:** the `npm update -g @keepur/hive` — that was the global-install-as-engine model we're leaving behind.

- [ ] **Step 2:** Verify

Run:
```bash
npx tsc --noEmit -p .
```
Expected: exits 0.

- [ ] **Step 3:** Don't commit yet — Task 8 adds the `rollback` command in `cli.ts` and the imports line up in the same commit as a coherent "CLI surface for the new deploy flow" change.

---

## Task 8: Add `src/cli/rollback.ts` and wire `rollback` into `cli.ts`

**Files:**
- Create: `src/cli/rollback.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1:** Create `src/cli/rollback.ts`.

```typescript
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";

function readEngineVersion(engineDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(engineDir, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface RollbackOptions {
  instance?: string;
}

/**
 * Shell out to deploy.sh --rollback to swap .hive ↔ .hive.prev.
 * --instance=<id> is required at the shell layer; we surface the instance
 * defaulting to HIVE_HOME's basename when not specified.
 */
export async function runRollback(opts: RollbackOptions = {}): Promise<void> {
  const hiveHome = resolveHiveHome();
  const engineDir = resolve(hiveHome, ".hive");
  const prevDir = resolve(hiveHome, ".hive.prev");
  const deployScript = resolve(engineDir, "service", "deploy.sh");

  if (!existsSync(deployScript)) {
    console.error(`deploy.sh not found at ${deployScript}.`);
    process.exit(1);
  }
  if (!existsSync(prevDir)) {
    console.error(`No previous engine at ${prevDir}. Rollback unavailable.`);
    process.exit(1);
  }

  const fromVersion = readEngineVersion(engineDir);
  const toVersion = readEngineVersion(prevDir);
  const instance = opts.instance ?? hiveHome.split("/").filter(Boolean).pop() ?? "default";

  console.log(`Rolling back ${instance}: ${fromVersion} → ${toVersion}`);

  try {
    execFileSync(deployScript, ["--rollback", `--instance=${instance}`], { stdio: "inherit" });
  } catch {
    console.error("Rollback failed. See deploy.sh output above.");
    process.exit(1);
  }

  const actualVersion = readEngineVersion(engineDir);
  console.log(`Rollback complete: ${actualVersion}.`);
}
```

- [ ] **Step 2:** Register the `rollback` command in `src/cli.ts`.

Find the help block's Commands list (line 72-89 in current file):

```
  update            Stop → update package → restart
  doctor            Check prereqs, services, agent health
```

Replace with:

```
  update            Update engine to latest (or --tag=<tag>) and restart
  rollback          Restore the previous engine (.hive.prev) and restart
  doctor            Check prereqs, services, agent health
```

Find the `case "update":` block (lines 146-150):

```typescript
  case "update": {
    const { runUpdate } = await import("./cli/update.js");
    await runUpdate();
    break;
  }
```

Replace with:

```typescript
  case "update": {
    const { runUpdate } = await import("./cli/update.js");
    await runUpdate({
      tag: values.tag,
      instance: values.instance,
    });
    break;
  }
  case "rollback": {
    const { runRollback } = await import("./cli/rollback.js");
    await runRollback({ instance: values.instance });
    break;
  }
```

- [ ] **Step 2a:** Register `tag` and `instance` in the `parseArgs` options object so `hive update --tag=0.2.1` and `hive rollback --instance=dodi` don't error out before reaching the switch.

Find (lines 46-55):

```typescript
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    daemon: { type: "boolean", default: false },
    config: { type: "string" },
    version: { type: "boolean", short: "v", default: false },
    verbose: { type: "boolean", default: false },
  },
});
```

Replace with:

```typescript
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    daemon: { type: "boolean", default: false },
    config: { type: "string" },
    version: { type: "boolean", short: "v", default: false },
    verbose: { type: "boolean", default: false },
    tag: { type: "string" },
    instance: { type: "string" },
  },
});
```

Rationale: `parseArgs` with default `strict: true` throws on unknown options before the switch arm can run. Adding these as typed string options keeps the existing positional/flag parsing intact and hands the values through `values.tag` / `values.instance`.

- [ ] **Step 3:** Verify

Run:
```bash
npx tsc --noEmit -p .
```
Expected: exits 0.

Run (smoke test):
```bash
node --experimental-strip-types dist/cli.js --help 2>/dev/null || npx tsx src/cli.ts --help
```
Expected: help output includes the new `rollback` line.

- [ ] **Step 4:** Commit

```bash
git add src/cli/update.ts src/cli/rollback.ts src/cli.ts
git commit -m "feat(cli): rewrite update + add rollback as thin wrappers over deploy.sh (KPR-53)"
```

---

## Task 9: Update `src/cli/update.test.ts` (extend or create)

**Files:**
- Modify (or create): `src/cli/update.test.ts`

The existing test file (if present) covered the old `npm update -g` path. After Task 7 it's stale. Replace tests with coverage for the new shell-out behavior.

- [ ] **Step 1:** Check for an existing test file.

Run:
```bash
ls src/cli/update.test.ts 2>/dev/null
```

If present, the file tests the old implementation — replace its contents. If absent, create it fresh.

- [ ] **Step 2:** Write the test file.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

// Hoisted mocks — must be declared with vi.hoisted so they're available
// at vi.mock factory evaluation time.
const { mockExecFileSync, mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("../paths.js", () => ({
  resolveHiveHome: () => "/tmp/test-hive",
}));

describe("runUpdate", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.0" });
      return "";
    });
  });

  it("shells out to deploy.sh with --tag=latest by default", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate();
    expect(mockExecFileSync).toHaveBeenCalledOnce();
    const [script, args] = mockExecFileSync.mock.calls[0];
    expect(String(script)).toBe(resolve("/tmp/test-hive/.hive/service/deploy.sh"));
    expect(args).toContain("--tag=latest");
  });

  it("passes --tag=<tag> when specified", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate({ tag: "0.2.1" });
    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toContain("--tag=0.2.1");
  });

  it("passes --instance=<id> when specified", async () => {
    const { runUpdate } = await import("./update.js");
    await runUpdate({ tag: "0.2.1", instance: "dodi" });
    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toContain("--tag=0.2.1");
    expect(args).toContain("--instance=dodi");
  });

  it("exits 1 when deploy.sh is missing", async () => {
    mockExistsSync.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits 1 when deploy.sh fails", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("deploy failed");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { runUpdate } = await import("./update.js");
    await expect(runUpdate()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("runRollback", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes(".hive/package.json")) return JSON.stringify({ version: "0.2.1" });
      if (path.includes(".hive.prev/package.json")) return JSON.stringify({ version: "0.2.0" });
      return "";
    });
  });

  it("shells out to deploy.sh --rollback --instance=<derived>", async () => {
    const { runRollback } = await import("./rollback.js");
    await runRollback();
    const [script, args] = mockExecFileSync.mock.calls[0];
    expect(String(script)).toBe(resolve("/tmp/test-hive/.hive/service/deploy.sh"));
    expect(args).toContain("--rollback");
    // default instance derived from HIVE_HOME basename
    expect(args).toContain("--instance=test-hive");
  });

  it("uses explicit --instance when specified", async () => {
    const { runRollback } = await import("./rollback.js");
    await runRollback({ instance: "keepur" });
    const [, args] = mockExecFileSync.mock.calls[0];
    expect(args).toContain("--instance=keepur");
  });

  it("exits 1 when .hive.prev does not exist", async () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith(".hive.prev"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { runRollback } = await import("./rollback.js");
    await expect(runRollback()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 3:** Verify

Run:
```bash
npx vitest run src/cli/update.test.ts
```
Expected: all tests pass.

- [ ] **Step 4:** Commit

```bash
git add src/cli/update.test.ts
git commit -m "test(cli): cover update/rollback shell-out behavior (KPR-53)"
```

---

## Task 10: Shell smoke test for `fetch_engine` / `swap_engine` / `rollback_engine`

**Files:**
- Create: `service/deploy.test.sh`

Unit-style shell testing of the three helpers against a scratch temp dir. Exercises them without network (mock `npm pack` via `PATH` shim).

- [ ] **Step 1:** Create `service/deploy.test.sh`.

```bash
#!/usr/bin/env bash
# Shell smoke test for deploy.sh helpers. Not unit tests in the TS sense —
# this is a scratch-dir exercise of fetch_engine / swap_engine / rollback_engine.
# Run manually: ./service/deploy.test.sh
# Exit 0 on success, non-zero on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTROOT=$(mktemp -d -t hive-deploy-test.XXXXXX)
trap 'rm -rf "$TESTROOT"' EXIT

# Shim npm pack: emit a valid tarball with package.json + pkg/server.min.js + seeds/
# structured to match the real @keepur/hive layout.
SHIM_DIR="$TESTROOT/bin-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/npm" <<'NPMEOF'
#!/usr/bin/env bash
# Minimal shim — handles `npm pack @keepur/hive@<version>` and `npm view`.
# Builds the pretend tarball via a `package/` staging dir so the layout works
# on both GNU tar and macOS bsdtar (no --transform dependency).
case "$1" in
  pack)
    # $PWD at shim entry is the caller's chosen packdir (fetch_engine does `cd "$packdir"`).
    outdir="$PWD"
    stage=$(mktemp -d)
    mkdir -p "$stage/package/pkg" "$stage/package/seeds" "$stage/package/templates" "$stage/package/scripts"
    echo "// fake server bundle" > "$stage/package/pkg/server.min.js"
    echo "// fake cli bundle" > "$stage/package/pkg/cli.min.js"
    echo "#!/usr/bin/env bash" > "$stage/package/scripts/honeypot"
    chmod +x "$stage/package/scripts/honeypot"
    # Version comes from @keepur/hive@<version> arg. `npm pack latest` should yield a real version.
    version="${2#*@keepur/hive@}"
    [[ "$version" == "@keepur/hive" || -z "$version" || "$version" == "latest" ]] && version="0.2.0"
    echo '{"name":"@keepur/hive","version":"'"$version"'"}' > "$stage/package/package.json"
    tarball="keepur-hive-${version}.tgz"
    (cd "$stage" && tar -czf "$outdir/$tarball" package)
    rm -rf "$stage"
    echo "$tarball"
    ;;
  view)
    echo "0.2.0"
    ;;
  *)
    exec /usr/bin/env npm "$@"
    ;;
esac
NPMEOF
chmod +x "$SHIM_DIR/npm"

export PATH="$SHIM_DIR:$PATH"
export BUILD_DIR="$TESTROOT/build"  # fallback path
export DEPLOY_DIR="$TESTROOT/deploy"

mkdir -p "$BUILD_DIR/pkg" "$BUILD_DIR/seeds" "$BUILD_DIR/templates" "$BUILD_DIR/scripts"
echo "// fallback server" > "$BUILD_DIR/pkg/server.min.js"
echo '{"name":"@keepur/hive","version":"0.2.0-dev"}' > "$BUILD_DIR/package.json"

# Source the helpers from deploy.sh (extract the fetch/swap/rollback block).
# Rather than run the whole script (which does its own init), we extract the
# function bodies via sed and source them in isolation. The inner `/!p` drops
# the closing delimiter line so we don't capture the `if $ROLLBACK; then` line
# (which would trip set -u on undefined ROLLBACK when sourced).
sed -n '/^# --- Engine fetch\/swap\/rollback/,/^# --- Short-circuit:/{/^# --- Short-circuit:/!p;}' \
  "$SCRIPT_DIR/deploy.sh" > "$TESTROOT/helpers.sh"
# shellcheck source=/dev/null
source "$TESTROOT/helpers.sh"

# --- Test 1: fetch_engine via npm pack ---
echo "test 1: fetch_engine @latest via npm pack"
mkdir -p "$DEPLOY_DIR"
fetch_engine "$DEPLOY_DIR" "latest"
[[ -f "$DEPLOY_DIR/.hive.next/pkg/server.min.js" ]] || { echo "FAIL: pkg/server.min.js missing"; exit 1; }
[[ -f "$DEPLOY_DIR/.hive.next/package.json" ]] || { echo "FAIL: package.json missing"; exit 1; }

# --- Test 2: swap_engine rotates correctly ---
echo "test 2: swap_engine rotates .hive/.hive.prev"
swap_engine "$DEPLOY_DIR"
[[ -d "$DEPLOY_DIR/.hive" ]] || { echo "FAIL: .hive missing after swap"; exit 1; }
[[ ! -d "$DEPLOY_DIR/.hive.next" ]] || { echo "FAIL: .hive.next still present"; exit 1; }
# First deploy: no .hive.prev because there was no prior .hive
[[ ! -d "$DEPLOY_DIR/.hive.prev" ]] || { echo "FAIL: .hive.prev should not exist on first deploy"; exit 1; }

# --- Test 3: second deploy creates .hive.prev ---
echo "test 3: second deploy creates .hive.prev"
fetch_engine "$DEPLOY_DIR" "latest"
swap_engine "$DEPLOY_DIR"
[[ -d "$DEPLOY_DIR/.hive" ]] || { echo "FAIL: .hive missing"; exit 1; }
[[ -d "$DEPLOY_DIR/.hive.prev" ]] || { echo "FAIL: .hive.prev should now exist"; exit 1; }

# --- Test 4: rollback_engine swaps .hive ↔ .hive.prev ---
echo "test 4: rollback_engine"
echo "marker-new" > "$DEPLOY_DIR/.hive/marker"
echo "marker-prev" > "$DEPLOY_DIR/.hive.prev/marker"
rollback_engine "$DEPLOY_DIR"
[[ "$(cat "$DEPLOY_DIR/.hive/marker")" == "marker-prev" ]] || { echo "FAIL: rollback did not restore prev"; exit 1; }
[[ "$(cat "$DEPLOY_DIR/.hive.broken/marker")" == "marker-new" ]] || { echo "FAIL: failed engine not preserved as .hive.broken"; exit 1; }
[[ ! -d "$DEPLOY_DIR/.hive.prev" ]] || { echo "FAIL: .hive.prev should be consumed by rollback"; exit 1; }

# --- Test 5: rollback fails cleanly when .hive.prev missing ---
echo "test 5: rollback without .hive.prev errors"
rm -rf "$DEPLOY_DIR/.hive.prev"
if rollback_engine "$DEPLOY_DIR" 2>/dev/null; then
  echo "FAIL: rollback_engine should have errored"
  exit 1
fi

# --- Test 6: next successful deploy clears .hive.broken ---
echo "test 6: swap clears .hive.broken"
fetch_engine "$DEPLOY_DIR" "latest"
swap_engine "$DEPLOY_DIR"
[[ ! -d "$DEPLOY_DIR/.hive.broken" ]] || { echo "FAIL: .hive.broken should be rotated out by successful swap"; exit 1; }

# --- Test 7: fallback rsync path (when npm view returns empty for a tag) ---
echo "test 7: fallback rsync path"
# Replace the shim so `npm view @keepur/hive@<tag>` returns nothing (tag unknown),
# forcing fetch_engine's fallback branch. Note: the "latest" branch of fetch_engine
# is hardwired to always take the npm-pack path, so we pass a concrete fake tag
# the shim will reject on `view`.
cat > "$SHIM_DIR/npm" <<'NPMEOF'
#!/usr/bin/env bash
case "$1" in
  view) exit 0 ;;   # empty stdout → fetch_engine falls through
  pack) echo "ERROR: shim rejects pack"; exit 1 ;;
  *) exit 0 ;;
esac
NPMEOF
chmod +x "$SHIM_DIR/npm"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
# Now fetch_engine should skip npm pack and use $BUILD_DIR
if ! fetch_engine "$DEPLOY_DIR" "0.9.9-nonexistent" 2>&1 | grep -q "falling back"; then
  echo "FAIL: fallback path not taken when npm view returns empty"
  exit 1
fi
[[ -f "$DEPLOY_DIR/.hive.next/pkg/server.min.js" ]] || { echo "FAIL: fallback did not populate pkg/server.min.js"; exit 1; }

echo "all tests passed."
```

- [ ] **Step 2:** Make executable + run.

```bash
chmod +x service/deploy.test.sh
./service/deploy.test.sh
```
Expected: final line `all tests passed.` and exit 0.

If any test fails, inspect the helper code in `service/deploy.sh` and fix. Do **not** weaken the test — the scratch-dir harness is the only automated coverage the bash helpers get.

- [ ] **Step 3:** Commit

```bash
git add service/deploy.test.sh
git commit -m "test(deploy): shell smoke harness for fetch/swap/rollback helpers (KPR-53)"
```

---

## Task 11: Write operator-facing `docs/deployment.md`

**Files:**
- Create: `docs/deployment.md`

A single page that answers: how does a deploy work? how do I pin a version? how do I roll back?

- [ ] **Step 1:** Create `docs/deployment.md`.

```markdown
# Deployment

**Target audience:** operators managing a Hive instance. Customers running a single instance via `hive update` only need the last section.

## Deploy flow

Hive deploys are **wipe-and-replace of `.hive/`**. No git pulls happen against the instance dir; the instance dir is not a git clone.

One deploy run (`deploy.sh`) does:

1. Pull latest in `$BUILD_DIR` (the actual git clone), run `npm install`, `npm run check`, `npm run build`, `npm run bundle`.
2. For each instance in `instances.conf`:
   - Stop the LaunchAgent.
   - Fetch the target tag's engine into `<instance>/.hive.next/` (primary: `npm pack @keepur/hive@<tag>`; fallback: rsync from `$BUILD_DIR/pkg/`).
   - Swap: old `.hive.prev/` dropped, live `.hive/` → `.hive.prev/`, new `.hive.next/` → `.hive/`.
   - Restart the LaunchAgent.
   - Health check (30s for `"Hive is running"` in the log).
   - On health failure: auto-rollback (swap `.hive ↔ .hive.prev`), restart, notify Slack.

Exactly one `.hive/` (live) and at most one `.hive.prev/` (one step back) are retained. Deeper history is npm's job.

## Per-instance version pinning

`instances.conf` has an `ENGINE_TAG` column (7th pipe-separated field). Examples:

```
dodi|hive.yaml|-|com.hive.agent|logs|3100 3200|v0.2.0
keepur|hive-keepur.yaml|-|com.hive.keepur.agent|logs-keepur|3300 3303|v0.1.10
```

Each instance upgrades independently. `deploy-check.sh` polls `npm view` and triggers deploys only for instances whose installed version differs from their pinned tag.

- Omit the column to default to `latest` (autoupgrade on every publish).
- Accepts `v0.2.0` or `0.2.0` — leading `v` is stripped before npm calls.

## Operator commands

```bash
# Deploy whatever's pinned (runs from deploy.sh directly, for full orchestration).
./service/deploy.sh

# Deploy a specific instance to a specific tag.
./service/deploy.sh --instance=dodi --tag=v0.2.1

# Dry-run — shows what would happen, no side effects.
./service/deploy.sh --dry-run

# Roll back a specific instance to the previous engine.
./service/deploy.sh --rollback --instance=dodi
```

## Customer commands

From a customer's shell, inside any Hive install:

```bash
# Update to latest published @keepur/hive.
hive update

# Update to a specific version.
hive update --tag=0.2.1

# Roll back to the previous engine version.
hive rollback
```

Both commands shell out to `deploy.sh` inside the instance's own `.hive/service/`. No separate update paths; `hive update` is `deploy.sh --tag=latest --instance=<current>` with a typed CLI wrapper.

## Rollback details

- `rollback` requires `.hive.prev/` to exist — it's the previous engine preserved from the last successful deploy.
- The failed engine is moved to `.hive.broken/` for operator inspection; the next successful deploy rotates it out.
- `.hive.prev/` is consumed by the rollback — a second consecutive rollback requires another deploy first (to re-establish a `.hive.prev/`).

## What's in `<instance>/` after a deploy

```
<instance>/
  .hive/                   # live engine — wipe-and-replace each deploy
    pkg/server.min.js      # entry point
    seeds/ templates/      # engine assets
    scripts/honeypot
    service/deploy.sh      # this script — shipped inside the engine
    package.json           # version stamp
  .hive.prev/              # previous engine (rollback target); may be absent on fresh installs
  .hive.broken/            # failed engine from last rollback (if any)
  .env                     # secrets, survives upgrades
  hive.yaml                # instance config, survives upgrades
  logs/                    # observability, survives upgrades
  agents/, workflow/, data/, skills/, plugins/   # instance-authored, survives upgrades
```

`.hive/` is the **upgrade boundary**. Everything else is yours.
```

- [ ] **Step 2:** Verify

Run:
```bash
test -f docs/deployment.md && wc -l docs/deployment.md
```
Expected: file exists, ~80 lines.

- [ ] **Step 3:** Commit

```bash
git add docs/deployment.md
git commit -m "docs: add deployment.md describing the Phase 3 deploy flow (KPR-53)"
```

---

## Task 12: Full check + acceptance

- [ ] **Step 1:** Run the full quality gate.

```bash
npm run check
```
Expected: typecheck + lint + format + test all pass.

If Prettier objects to anything, run `npm run format` and commit the formatting-only diff as `style: prettier (KPR-53)`.

- [ ] **Step 2:** Run the shell smoke test once more against the final state.

```bash
./service/deploy.test.sh
```
Expected: `all tests passed.`

- [ ] **Step 3:** Manual acceptance against a scratch dir (strongly recommended; does NOT require a real instance).

```bash
# Set up a scratch "instance"
TESTINSTANCE=$(mktemp -d -t hive-kpr53-manual.XXXXXX)
mkdir -p "$TESTINSTANCE/.hive/service"
cp service/deploy.sh service/deploy-check.sh service/instances.conf "$TESTINSTANCE/.hive/service/"
# Populate a dummy .hive/ so the version read has something to find
echo '{"name":"@keepur/hive","version":"0.1.10"}' > "$TESTINSTANCE/.hive/package.json"

# Exercise --dry-run — should print plan without side effects
DEPLOY_DIR="$TESTINSTANCE" bash "$TESTINSTANCE/.hive/service/deploy.sh" --dry-run --instance=dodi --tag=latest

# Should succeed and leave TESTINSTANCE untouched (no .hive.next/, no new files)
ls "$TESTINSTANCE"
```
Expected: dry-run output enumerates the steps it would take. `$TESTINSTANCE` is unchanged afterward.

- [ ] **Step 4:** Acceptance checklist against spec §Acceptance.

Tick each before pushing:

- [ ] `grep -n "git pull" service/deploy.sh` shows exactly one match targeting `$BUILD_DIR` (not `$DEPLOY_DIR`).
- [ ] Skill auto-commit block gone — `grep -n "deploy-auto-skills\|git stash push" service/deploy.sh` returns nothing.
- [ ] `hive rollback` surface works: `npx tsx src/cli.ts --help | grep rollback` shows the command.
- [ ] Per-instance pinning surface works: `instances.conf` has the `ENGINE_TAG` column and the parser reads 7 fields.
- [ ] Shell smoke test covers: normal fetch/swap, repeat deploy (creates `.hive.prev`), rollback, rollback failure without `.hive.prev`, swap clears `.hive.broken`, fallback rsync path.
- [ ] Auto-rollback on health-check failure wired (`grep -n "rollback_engine" service/deploy.sh` shows two call sites: manual rollback short-circuit + Phase 2 health-check failure branch).
- [ ] Repeat-upgrade invariant covered by smoke Tests 3 + 6: after two deploys `.hive` + `.hive.prev` only; `.hive.broken` is rotated out by the next successful swap.
- [ ] `deploy.test.sh` green.

- [ ] **Step 5:** Push + open PR.

```bash
git push -u origin kpr-53
gh pr create --base deploy --title "feat: deploy flow rewrite — engine swap, per-instance pinning, rollback (KPR-53)" --body "$(cat <<'EOF'
## Summary
- Replace git-clone-as-deploy-dir with tarball-based engine swap into `.hive/`.
- Delete the skill auto-commit hack — `skills/` is instance-authored, survives upgrades, not committed by Hive.
- Per-instance version pinning via new `ENGINE_TAG` column in `instances.conf`; `deploy-check.sh` rewritten as per-instance npm version compare.
- One-command rollback: `hive rollback` (or `deploy.sh --rollback --instance=<id>`) swaps `.hive ↔ .hive.prev`.
- Auto-rollback on health-check failure, with `.hive.broken/` preserved for inspection.

Phase 3 of [KPR-50](https://linear.app/keepur/issue/KPR-50) (v0.2.0 instance dir restructure). Depends on Phase 2 (KPR-52) being merged first.

## Test plan
- [ ] `npm run check` green
- [ ] `service/deploy.test.sh` — shell smoke green
- [ ] `shellcheck service/deploy.sh` — no errors
- [ ] `hive --help` lists `rollback` command
- [ ] `instances.conf` parser reads `ENGINE_TAG` column; missing column still parses (defaults to `latest`)
- [ ] Dry-run deploy on a scratch instance doesn't touch filesystem
- [ ] End-to-end deploy against a staging instance (manual, post-merge): `deploy.sh --instance=staging --tag=0.2.0`, assert version in `.hive/package.json`; then `--rollback`, assert prior version restored.
EOF
)"
```

---

## Out-of-scope reminders

If any of these come up during execution, stop and note them — they are explicitly deferred:

- **Fresh-install flow (`install.sh`, `bootstrap.sh`)** — Phase 4 / KPR-54 rewrites the customer install path.
- **Migrating existing 0.1.x instances** (their `dist/`, `node_modules/`, loose agent files at root) — Phase 5 / KPR-55.
- **Deleting `.git/` in existing instance dirs** — Phase 5 does this as part of the cutover. Phase 3 just stops writing to the git state; stale `.git/` is inert.
- **Parallel per-instance deploys** — explicitly rejected in spec §Multi-instance sequencing (shared Mac Mini, failures are the concern).
- **CI-driven rollback detection** (auto-rollback on runtime errors past the 30s health window) — listed in spec §Runtime failure modes as a separate observability feature.
- **Changing `package.json` `files` field** — already correct per Phase 2. Don't touch.
- **Changing `publish.yml`** — publish pipeline is layout-independent; Phase 3 consumes the same tarball the existing workflow ships.
