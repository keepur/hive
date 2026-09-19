#!/usr/bin/env bash
# Shell smoke test for rotate-logs.sh — a scratch-dir exercise of instance
# discovery, copy-and-truncate, gzip and expiry.
# Run manually: ./service/rotate-logs.test.sh (vitest also runs it, via
# setup/rotate-logs.test.ts, so CI covers it).
# Exit 0 on success, non-zero on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTROOT=$(mktemp -d -t hive-rotate-test.XXXXXX)
trap 'rm -rf "$TESTROOT"' EXIT

fail() {
  echo "FAIL: $*"
  exit 1
}

# Shim mongosh so a host that has MongoDB doesn't get a real logRotate per test
# run; MONGO_LOG_DIR (below) keeps the expiry pass inside the scratch dir too.
SHIM_DIR="$TESTROOT/bin-shim"
mkdir -p "$SHIM_DIR" "$TESTROOT/mongo"
cat > "$SHIM_DIR/mongosh" <<SHIMEOF
#!/usr/bin/env bash
echo "\$*" >> "$TESTROOT/mongosh.calls"
SHIMEOF
chmod +x "$SHIM_DIR/mongosh"

# install_script <service_dir>
# rotate-logs.sh is never run from its real location: with no env it discovers
# the instance from its own path, and from a deployed .hive/service/ that would
# rotate the live instance's logs. The shipped (empty) registry rides along.
install_script() {
  mkdir -p "$1"
  cp "$SCRIPT_DIR/rotate-logs.sh" "$SCRIPT_DIR/instances.conf" "$1/"
}

# run_rotate <script> [VAR=value...] — runs with a scrubbed environment so the
# caller's HIVE_HOME etc. can't leak in. Later assignments win over the defaults.
run_rotate() {
  local script="$1"
  shift
  env -u HIVE_HOME -u HIVE_SINGLE_INSTANCE -u HIVE_SINGLE_ROOT -u HIVE_SINGLE_LOGS \
    -u HIVE_INSTANCES_CONF -u HIVE_ROTATE_EXTRA_LOGS -u KEEP_DAYS \
    PATH="$SHIM_DIR:$PATH" MONGO_LOG_DIR="$TESTROOT/mongo" DEPLOY_DIR="$TESTROOT/no-deploy-dir" \
    "$@" bash "$script"
}

# rotated <log_dir> <name> — rotated copies of <name>, one per line.
rotated() {
  find "$1" -maxdepth 1 -type f -name "$2.20*" | sort
}

count_rotated() {
  rotated "$1" "$2" | wc -l | tr -d '[:space:]'
}

# assert_rotated <log_dir> <name> <expected content>
assert_rotated() {
  local copy
  [[ "$(count_rotated "$1" "$2")" == "1" ]] || fail "$2: expected exactly one rotated copy in $1 (got $(count_rotated "$1" "$2"))"
  copy=$(rotated "$1" "$2")
  [[ "$copy" == *.gz ]] || fail "$2: rotated copy is not gzipped ($copy)"
  [[ "$(gzip -dc "$copy")" == "$3" ]] || fail "$2: rotated copy content mismatch"
  [[ ! -s "$1/$2" ]] || fail "$2: live log was not truncated"
  [[ -e "$1/$2" ]] || fail "$2: live log must survive rotation (the daemon holds it open)"
}

# Generic scratch service dir — NOT under a .hive/, so path discovery stays off.
install_script "$TESTROOT/plain/service"
PLAIN="$TESTROOT/plain/service/rotate-logs.sh"

# --- Test 1: HIVE_HOME + the shipped empty instances.conf (the regression) ---
echo "test 1: HIVE_HOME rotates the instance logs despite the empty registry"
INST="$TESTROOT/t1"
mkdir -p "$INST/logs"
echo "main log" > "$INST/logs/hive.log"
echo "main err" > "$INST/logs/hive.err"
echo "voice log" > "$INST/logs/voice-worker.log"
: > "$INST/logs/voice-worker.err" # empty — must not produce a rotated copy
echo "deploy check" > "$INST/logs/deploy-check.log"
run_rotate "$PLAIN" HIVE_HOME="$INST" > "$TESTROOT/t1.out"
assert_rotated "$INST/logs" hive.log "main log"
assert_rotated "$INST/logs" hive.err "main err"
assert_rotated "$INST/logs" voice-worker.log "voice log"
assert_rotated "$INST/logs" deploy-check.log "deploy check"
[[ "$(count_rotated "$INST/logs" voice-worker.err)" == "0" ]] || fail "empty voice-worker.err should not be rotated"
grep -q "hive.log: 9 bytes -> hive.log.20" "$TESTROOT/t1.out" || fail "run output should report what was rotated"

# --- Test 2: deploy.sh's single-instance env contract ---
echo "test 2: HIVE_SINGLE_INSTANCE=1 + HIVE_SINGLE_ROOT rotates the instance logs"
INST="$TESTROOT/t2"
mkdir -p "$INST/logs"
echo "single" > "$INST/logs/hive.log"
run_rotate "$PLAIN" HIVE_SINGLE_INSTANCE=1 HIVE_SINGLE_ROOT="$INST" HIVE_SINGLE_LOGS=logs > /dev/null
assert_rotated "$INST/logs" hive.log "single"
if run_rotate "$PLAIN" HIVE_SINGLE_INSTANCE=1 > /dev/null 2>&1; then
  fail "HIVE_SINGLE_INSTANCE=1 without HIVE_SINGLE_ROOT should error"
fi

# --- Test 3: no env at all — instance home discovered from the bundle layout ---
echo "test 3: <home>/.hive/service/ layout rotates <home>/logs without HIVE_HOME"
INST="$TESTROOT/t3"
install_script "$INST/.hive/service"
mkdir -p "$INST/logs"
echo "layout" > "$INST/logs/hive.log"
run_rotate "$INST/.hive/service/rotate-logs.sh" > /dev/null
assert_rotated "$INST/logs" hive.log "layout"

# --- Test 4: nothing resolvable is an error, not a silent no-op ---
echo "test 4: empty registry + no HIVE_HOME + no bundle layout exits non-zero"
if run_rotate "$PLAIN" > "$TESTROOT/t4.out" 2>&1; then
  fail "expected a non-zero exit when there is nothing to rotate"
fi
grep -q "nothing to rotate" "$TESTROOT/t4.out" || fail "expected a 'nothing to rotate' error message"
# ...but a legacy checkout with logs/ next to service/ still rotates, as before.
install_script "$TESTROOT/t4-legacy/service"
mkdir -p "$TESTROOT/t4-legacy/logs"
echo "legacy deploy check" > "$TESTROOT/t4-legacy/logs/deploy-check.log"
run_rotate "$TESTROOT/t4-legacy/service/rotate-logs.sh" > /dev/null
assert_rotated "$TESTROOT/t4-legacy/logs" deploy-check.log "legacy deploy check"

# --- Test 5: expiry honours KEEP_DAYS and only touches rotated copies ---
echo "test 5: rotated copies older than KEEP_DAYS expire; everything else survives"
INST="$TESTROOT/t5"
mkdir -p "$INST/logs"
echo "fresh" > "$INST/logs/hive.log"
: > "$INST/logs/hive.err"
echo "old plain" > "$INST/logs/hive.log.2020-01-01T04-00-00" # pre-gzip naming
echo "old gz" > "$INST/logs/hive.log.2020-01-02T04-00-00.gz"
echo "recent" > "$INST/logs/hive.err.2020-01-03T04-00-00.gz"
echo "keep me" > "$INST/logs/hive.log.bak"
echo "keep me" > "$INST/logs/notes.2020-01-01T00-00-00.txt"
touch -t 202001010400 "$INST/logs/hive.log.2020-01-01T04-00-00" "$INST/logs/hive.log.2020-01-02T04-00-00.gz" \
  "$INST/logs/hive.err" "$INST/logs/hive.log.bak" "$INST/logs/notes.2020-01-01T00-00-00.txt"
run_rotate "$PLAIN" HIVE_HOME="$INST" KEEP_DAYS=7 > "$TESTROOT/t5.out"
[[ ! -e "$INST/logs/hive.log.2020-01-01T04-00-00" ]] || fail "old uncompressed copy should have expired"
[[ ! -e "$INST/logs/hive.log.2020-01-02T04-00-00.gz" ]] || fail "old gzipped copy should have expired"
[[ -e "$INST/logs/hive.err.2020-01-03T04-00-00.gz" ]] || fail "copy younger than KEEP_DAYS must be kept"
[[ -e "$INST/logs/hive.err" ]] || fail "quiet live log must never expire"
[[ -e "$INST/logs/hive.log.bak" ]] || fail "unrelated file hive.log.bak must be kept"
[[ -e "$INST/logs/notes.2020-01-01T00-00-00.txt" ]] || fail "unrelated timestamped file must be kept"
assert_rotated "$INST/logs" hive.log "fresh"
grep -q "expired: .*hive.log.2020-01-01T04-00-00" "$TESTROOT/t5.out" || fail "run output should list expired copies"
if run_rotate "$PLAIN" HIVE_HOME="$INST" KEEP_DAYS=soon > /dev/null 2>&1; then
  fail "non-numeric KEEP_DAYS should be rejected"
fi

# --- Test 6: HIVE_ROTATE_EXTRA_LOGS ---
echo "test 6: extra log names rotate; path-like names are rejected"
INST="$TESTROOT/t6"
mkdir -p "$INST/logs"
echo "embed" > "$INST/logs/code-index.log"
echo "untouched" > "$INST/logs/other.log"
run_rotate "$PLAIN" HIVE_HOME="$INST" HIVE_ROTATE_EXTRA_LOGS="code-index.log missing.log" > /dev/null
assert_rotated "$INST/logs" code-index.log "embed"
[[ "$(cat "$INST/logs/other.log")" == "untouched" ]] || fail "logs outside the rotate list must be left alone"
if run_rotate "$PLAIN" HIVE_HOME="$INST" HIVE_ROTATE_EXTRA_LOGS="../other.log" > /dev/null 2>&1; then
  fail "a path-like HIVE_ROTATE_EXTRA_LOGS entry should be rejected"
fi
[[ "$(cat "$INST/logs/other.log")" == "untouched" ]] || fail "rejected run must not rotate anything"

# --- Test 7: multi-instance registry via HIVE_INSTANCES_CONF ---
echo "test 7: registry rows rotate per-instance and shared-dir layouts"
DEPLOY="$TESTROOT/t7/deploy"
mkdir -p "$DEPLOY/alpha/logs" "$DEPLOY/beta/logs" "$DEPLOY/logs-shared"
echo "alpha" > "$DEPLOY/alpha/logs/hive.log"
echo "beta" > "$DEPLOY/beta/logs/hive.log"
echo "shared" > "$DEPLOY/logs-shared/hive.log"
cat > "$TESTROOT/t7/instances.conf" <<'CONFEOF'
# comment line
alpha | hive.yaml | - | com.hive.alpha.agent | logs | 3100 3200 | latest

beta|hive.yaml|-|com.hive.beta.agent|logs|3101 3201|latest
gamma|hive.yaml|-|com.hive.gamma.agent|logs-shared|3102|latest
delta|hive-delta.yaml|-|com.hive.delta.agent|logs-shared|3103|latest
CONFEOF
run_rotate "$PLAIN" HIVE_INSTANCES_CONF="$TESTROOT/t7/instances.conf" DEPLOY_DIR="$DEPLOY" > "$TESTROOT/t7.out"
assert_rotated "$DEPLOY/alpha/logs" hive.log "alpha"
assert_rotated "$DEPLOY/beta/logs" hive.log "beta"
# gamma + delta share a logs dir: rotated once, and the copy is the real one.
assert_rotated "$DEPLOY/logs-shared" hive.log "shared"
[[ "$(grep -c "logs-shared$" "$TESTROOT/t7.out")" == "1" ]] || fail "shared logs dir should be rotated once per run"

# --- Test 8: HIVE_HOME wins over the registry ---
echo "test 8: HIVE_HOME skips the registry loop"
INST="$TESTROOT/t8"
mkdir -p "$INST/logs"
echo "home" > "$INST/logs/hive.log"
echo "alpha again" > "$DEPLOY/alpha/logs/hive.err"
run_rotate "$PLAIN" HIVE_HOME="$INST" HIVE_INSTANCES_CONF="$TESTROOT/t7/instances.conf" DEPLOY_DIR="$DEPLOY" > /dev/null
assert_rotated "$INST/logs" hive.log "home"
[[ "$(cat "$DEPLOY/alpha/logs/hive.err")" == "alpha again" ]] || fail "registry instances must not rotate in single-instance mode"

# --- Test 9: a failed copy must not truncate the live log ---
echo "test 9: copy failure leaves the log intact and exits non-zero"
INST="$TESTROOT/t9"
FAILCP_DIR="$TESTROOT/bin-failcp"
mkdir -p "$INST/logs" "$FAILCP_DIR"
printf '#!/usr/bin/env bash\nexit 1\n' > "$FAILCP_DIR/cp"
chmod +x "$FAILCP_DIR/cp"
echo "precious" > "$INST/logs/hive.log"
if run_rotate "$PLAIN" HIVE_HOME="$INST" PATH="$FAILCP_DIR:$SHIM_DIR:$PATH" > /dev/null 2>&1; then
  fail "a failed copy should make the run exit non-zero"
fi
[[ "$(cat "$INST/logs/hive.log")" == "precious" ]] || fail "live log was truncated even though the copy failed"
[[ "$(count_rotated "$INST/logs" hive.log)" == "0" ]] || fail "failed copy left a partial rotated file behind"

# --- Test 10: a same-second rerun never overwrites a rotated copy ---
echo "test 10: existing rotated copy for this timestamp is not overwritten"
INST="$TESTROOT/t10"
FIXDATE_DIR="$TESTROOT/bin-fixdate"
mkdir -p "$INST/logs" "$FIXDATE_DIR"
printf '#!/usr/bin/env bash\necho 2026-01-02T03-04-05\n' > "$FIXDATE_DIR/date"
chmod +x "$FIXDATE_DIR/date"
echo "first run" > "$INST/logs/hive.log"
run_rotate "$PLAIN" HIVE_HOME="$INST" PATH="$FIXDATE_DIR:$SHIM_DIR:$PATH" > /dev/null
echo "second run" > "$INST/logs/hive.log"
run_rotate "$PLAIN" HIVE_HOME="$INST" PATH="$FIXDATE_DIR:$SHIM_DIR:$PATH" > /dev/null
[[ "$(gzip -dc "$INST/logs/hive.log.2026-01-02T03-04-05.gz")" == "first run" ]] || fail "rotated copy was overwritten by a same-second rerun"
[[ "$(cat "$INST/logs/hive.log")" == "second run" ]] || fail "unrotated log should be left for the next run, not truncated"

# --- Test 11: MongoDB pass stays inside MONGO_LOG_DIR ---
echo "test 11: mongo logRotate is requested; rotated mongo logs are gzipped and expired"
[[ -s "$TESTROOT/mongosh.calls" ]] || fail "mongosh shim was never invoked"
grep -q "logRotate" "$TESTROOT/mongosh.calls" || fail "mongosh was not asked to logRotate"
INST="$TESTROOT/t11"
mkdir -p "$INST/logs"
echo "live mongo" > "$TESTROOT/mongo/mongo.log"
echo "rotated mongo" > "$TESTROOT/mongo/mongo.log.2026-09-18T11-00-06"
echo "ancient mongo" > "$TESTROOT/mongo/mongo.log.2020-01-01T11-00-00"
touch -t 202001011100 "$TESTROOT/mongo/mongo.log.2020-01-01T11-00-00"
echo "x" > "$INST/logs/hive.log"
run_rotate "$PLAIN" HIVE_HOME="$INST" > /dev/null
[[ "$(cat "$TESTROOT/mongo/mongo.log")" == "live mongo" ]] || fail "live mongo.log must be left to mongod"
[[ "$(gzip -dc "$TESTROOT/mongo/mongo.log.2026-09-18T11-00-06.gz")" == "rotated mongo" ]] || fail "rotated mongo log should be gzipped"
[[ -z "$(find "$TESTROOT/mongo" -name 'mongo.log.2020-*')" ]] || fail "ancient mongo log should have expired"

echo "all tests passed."
