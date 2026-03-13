#!/usr/bin/env bats

SCRIPT_DIR="$(cd "$(dirname "${BATS_TEST_FILENAME}")" && pwd)"
DEPLOY_SCRIPT="$(cd "$SCRIPT_DIR/../.." && pwd)/service/deploy.sh"

setup() {
  TEST_DIR="$(mktemp -d)"

  # Create fake build dir with git repo on 'deploy' branch
  mkdir -p "$TEST_DIR/build/hive"
  git -C "$TEST_DIR/build/hive" init -b deploy --quiet
  git -C "$TEST_DIR/build/hive" commit --allow-empty -m "init" --quiet

  # Create fake deploy dir with git repo on 'deploy' branch
  mkdir -p "$TEST_DIR/services/hive/dist"
  mkdir -p "$TEST_DIR/services/hive/agents"
  mkdir -p "$TEST_DIR/services/hive/logs"
  touch "$TEST_DIR/services/hive/logs/hive.log"
  git -C "$TEST_DIR/services/hive" init -b deploy --quiet
  git -C "$TEST_DIR/services/hive" commit --allow-empty -m "init" --quiet

  # Create valid .env
  cat > "$TEST_DIR/services/hive/.env" <<'ENVEOF'
SLACK_BOT_TOKEN=xoxb-fake-token
DEVOPS_CHANNEL_ID=C0123456789
ENVEOF

  export BUILD_DIR="$TEST_DIR/build/hive"
  export DEPLOY_DIR="$TEST_DIR/services/hive"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "happy path: dry-run completes successfully" {
  run bash "$DEPLOY_SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"[DRY RUN]"* ]]
  [[ "$output" == *"Deploy complete. Hive is running."* ]]
}

@test "--dry-run flag is recognized" {
  run bash "$DEPLOY_SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"[DRY RUN] npm install"* ]]
  [[ "$output" == *"[DRY RUN] npm run check"* ]]
  [[ "$output" == *"[DRY RUN] npm run build"* ]]
  [[ "$output" == *"[DRY RUN] rsync"* ]]
  [[ "$output" == *"[DRY RUN] launchctl"* ]]
}

@test "branch guard: build dir on wrong branch aborts" {
  git -C "$BUILD_DIR" checkout -b main --quiet
  run bash "$DEPLOY_SCRIPT" --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"Build dir not on deploy branch"* ]]
}

@test "branch guard: deploy dir on wrong branch aborts" {
  git -C "$DEPLOY_DIR" checkout -b main --quiet
  run bash "$DEPLOY_SCRIPT" --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"Deploy dir not on deploy branch"* ]]
}

@test "missing SLACK_BOT_TOKEN aborts" {
  cat > "$DEPLOY_DIR/.env" <<'ENVEOF'
DEVOPS_CHANNEL_ID=C0123456789
ENVEOF
  run bash "$DEPLOY_SCRIPT" --dry-run
  [ "$status" -ne 0 ]
  [[ "$output" == *"SLACK_BOT_TOKEN"* ]]
}
