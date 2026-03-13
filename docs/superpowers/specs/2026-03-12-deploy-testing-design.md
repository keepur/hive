# Deploy Script Testing — Dry-Run Mode + Bats Tests

## Overview

Add a `--dry-run` flag to `service/deploy.sh` and bats unit tests to verify deploy script logic without touching real infrastructure.

## Dry-Run Mechanism

### Flag Parsing

Parse `--dry-run` as the first argument. Default is `false`.

```bash
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
```

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

### Commands Wrapped with `run_cmd`

- `git pull --ff-only`
- `npm install`
- `npm run check`
- `npm run build`
- `npm run setup:agents`
- `npm install --omit=dev`
- `cp -a` (backups)
- `rm -rf` (backup cleanup)
- `rsync`
- `launchctl kickstart`
- `mv` (rollback restores)

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

Tests override `BUILD_DIR` and `DEPLOY_DIR` via environment variables, and set `DRY_RUN=true`.

The fake git repos are initialized with `git init && git checkout -b deploy && git commit --allow-empty -m "init"` so that `git rev-parse`, `git branch --show-current`, and `git log` work.

### Test Cases (5 total)

1. **Happy path (dry-run)** — `DRY_RUN=true`, both dirs on `deploy` branch, valid `.env`. Verify: exits 0, output contains `[DRY RUN]` lines for each destructive step in order.

2. **`--dry-run` flag parsing** — Run script with `--dry-run` argument. Verify: output contains `[DRY RUN]` (flag was recognized).

3. **Branch guard: build dir on wrong branch** — Set build dir to `main` branch. Verify: exits non-zero, output contains "Build dir not on deploy branch".

4. **Branch guard: deploy dir on wrong branch** — Set deploy dir to `main` branch, build dir on `deploy`. Need to skip the `git pull` (use `DRY_RUN=true`). Verify: exits non-zero, output contains "Deploy dir not on deploy branch".

5. **Missing env vars** — `.env` file missing `SLACK_BOT_TOKEN`. Verify: exits non-zero, output contains "SLACK_BOT_TOKEN not set".

### Running Tests

```bash
bats tests/deploy/deploy.bats
```

Or integrated into `npm run test` if desired (though bats tests are separate from Vitest).
