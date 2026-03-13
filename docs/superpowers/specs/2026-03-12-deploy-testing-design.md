# Deploy Script Testing — Dry-Run Mode + Bats Tests

## Overview

Add a `--dry-run` flag to `service/deploy.sh` and bats unit tests to verify deploy script logic without touching real infrastructure.

## Script Modifications Required

### Make directories overridable

Change the hardcoded directory assignments to allow environment variable overrides (needed for tests):

```bash
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
```

### `rollback()` function

The `rollback()` function contains destructive commands (`rm -rf`, `mv`, `launchctl kickstart`) that must also be wrapped with `run_cmd`.

## Dry-Run Mechanism

### Flag Parsing

Parse `--dry-run` as the first argument, **before** sourcing `.env`. Default is `false`.

```bash
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
```

This must appear before `source "$DEPLOY_DIR/.env"` so that tests can control the flag before env loading.

### `run_cmd` Helper

Wraps destructive commands. In dry-run mode, echoes the command. In normal mode, executes it.

```bash
run_cmd() {
  if $DRY_RUN; then
    echo "[DRY RUN] $*"
  else
    "$@"
  fi
}
```

### Interaction with `if !` Error Handling

The script uses `if ! cmd; then notify; exit 1; fi` for several steps. When wrapping with `run_cmd`, the pattern becomes:

```bash
if ! run_cmd npm run check; then
  notify "..."
  exit 1
fi
```

In dry-run mode, `run_cmd` echoes and returns 0, so the `if !` block is skipped (correct — no failure to handle). In normal mode, `run_cmd` executes the command and returns its exit code, preserving the error handling.

### Commands Wrapped with `run_cmd`

- `git pull --ff-only` (both build dir and deploy dir)
- `npm install` (build dir)
- `npm run check`
- `npm run build`
- `npm run setup:agents`
- `npm install --omit=dev` (deploy dir)
- `cp -a` (backups)
- `rm -rf` (backup cleanup and rollback)
- `mv` (rollback restores)
- `rsync`
- `launchctl kickstart`

### Commands That Run for Real in Dry-Run

- `cd`
- `echo`
- `source .env`
- `git rev-parse`
- `git branch --show-current`
- `git log`
- Branch guard checks (`[[ ... ]]`)

### `notify()` in Dry-Run

Echoes the message instead of calling curl:

```bash
notify() {
  local message="$1"
  if $DRY_RUN; then
    echo "[DRY RUN] notify: $message"
    return
  fi
  # ... existing curl logic
}
```

### `health_check()` in Dry-Run

Returns success immediately:

```bash
health_check() {
  if $DRY_RUN; then
    echo "[DRY RUN] health_check: would check $DEPLOY_DIR/logs/hive.log"
    return 0
  fi
  # ... existing retry logic
}
```

## Bats Tests

### File

`tests/deploy/deploy.bats`

### Dependencies

`bats-core` — installed via `brew install bats-core`.

### Test Setup

Each test creates a temporary directory structure:

```
$TMPDIR/
  build/hive/          # fake build dir (git repo on 'deploy' branch)
    .git/
  services/hive/       # fake deploy dir (git repo on 'deploy' branch)
    .git/
    .env               # SLACK_BOT_TOKEN=fake DEVOPS_CHANNEL_ID=C123
    dist/
    agents/
    logs/hive.log
```

Tests export `BUILD_DIR` and `DEPLOY_DIR` pointing to the temp dirs (script uses `${BUILD_DIR:-...}` defaults), and run with `DRY_RUN=true` (or pass `--dry-run`).

The fake git repos are initialized with `git init && git checkout -b deploy && git commit --allow-empty -m "init"` so that `git rev-parse`, `git branch --show-current`, and `git log` work.

### Test Cases (5 total)

1. **Happy path (dry-run)** — Pass `--dry-run`, both dirs on `deploy` branch, valid `.env`. Verify: exits 0, output contains `[DRY RUN]` lines for each destructive step in order.

2. **`--dry-run` flag parsing** — Run script with `--dry-run` argument. Verify: output contains `[DRY RUN]` (flag was recognized and dry-run mode activated).

3. **Branch guard: build dir on wrong branch** — Set build dir to `main` branch, pass `--dry-run`. Verify: exits non-zero, output contains "Build dir not on deploy branch".

4. **Branch guard: deploy dir on wrong branch** — Build dir on `deploy`, deploy dir on `main`, pass `--dry-run`. The script runs through all build-dir dry-run steps first, then hits the deploy-dir branch guard. Verify: exits non-zero, output contains "Deploy dir not on deploy branch".

5. **Missing env vars** — `.env` file missing `SLACK_BOT_TOKEN`. Verify: exits non-zero, output contains "SLACK_BOT_TOKEN not set".

### Running Tests

```bash
bats tests/deploy/deploy.bats
```
