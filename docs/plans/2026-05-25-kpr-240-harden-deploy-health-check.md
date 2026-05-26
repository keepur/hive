# KPR-240 Harden deploy.sh Health Check Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Replace the `tail -5 | grep '"Hive is running"'` health check in `service/deploy.sh` with a boot-anchored byte-offset scan so a healthy boot that emits many log lines within 1s of the marker is no longer falsely judged failed (and no longer auto-rolled-back).

**Architecture:** Capture `wc -c < hive.log` immediately before every `launchctl bootstrap` that feeds a health check. Pass that byte offset to `health_check`, which scans only bytes written after the offset (via `tail -c +N`) and requires `"Hive is running"` to appear after `"Hive starting up"` in that window. Same retry/window/wait knobs (3×30s+10s) — only the scan strategy changes.

**Tech Stack:** Bash 3.2+ (must run on macOS default shell), `wc`, `tail -c +N`, `awk`. No new dependencies. Test surface is `service/deploy.test.sh` (existing shell smoke test runner).

## Testing Contract

### Required Test Groups

- Unit: `not-required`
  - Scope: N/A — `deploy.sh` is a shell script without a TS unit layer.
  - Reason: All meaningful logic lives in shell functions covered by the existing `deploy.test.sh` smoke runner.

- Integration: `required`
  - Scope: `service/deploy.test.sh` — shell-level exercise of `log_size_before`, `health_check`, `_scan_new_boot` against constructed log fixtures.
  - Reason: This ticket's acceptance criteria are behavioral on real log files; the deploy.test.sh harness is the only place these helpers run end-to-end.
  - Harness: `existing` (deploy.test.sh runs in a `mktemp -d` scratch dir, sources helpers via sed from `deploy.sh`).
  - Minimum assertions:
    - Busy boot: log emits `"Hive starting up"` + `"Hive is running"` then 50+ extra lines — `health_check` returns 0 (pre-fix `tail -5` would miss the marker; sanity-assert that).
    - Genuine failure: log emits `"Hive starting up"` and an error, never reaches `"Hive is running"` — `health_check` returns non-zero.
    - Stale marker: log already contains `"Hive starting up"` + `"Hive is running"` from a prior run; offset captured AFTER those lines; new boot emits `"Hive starting up"` then crash — `health_check` returns non-zero (the stale marker physically present in the file must NOT satisfy the check).
    - Missing log: `log_size_before` returns `0` when the file does not exist; subsequent boot that writes both markers from byte 0 passes.

- E2E: `not-required`
  - Scope: Real `launchctl bootstrap` + actual Hive boot.
  - Reason: We cannot reliably simulate the busy-boot race in CI without booting a real instance; the offset-based scan removes the timing dependency entirely, so the shell integration test on real log shapes is sufficient evidence.
  - Harness: `not-applicable`
  - Minimum assertions: N/A.

### Critical Flows

- `hive update` (single-instance path) — health-checks the new engine; must not auto-rollback a healthy boot.
- `deploy.sh --rollback --instance=<id>` — health-checks the restored engine after manual rollback.
- Multi-instance `deploy.sh` (dev) — Phase 2 loop health-checks each instance after restart.

### Regression Surface

- `health_check()` is called from three places in `deploy.sh` (rollback short-circuit + Phase 2 deploy loop + the deploy loop's auto-rollback retry). Offset must be captured for the two that precede a health check; the third (auto-rollback bootstrap) does not call health_check and stays as-is.
- `install/migrate-0.2.sh` has its own `tail -20 | grep` health check. **Out of scope** for KPR-240 (one-time 0.1.x → 0.2.0 migration, ticket explicitly scopes to `service/deploy.sh`). Leave untouched.
- `src/cli/update.ts` shells out to `deploy.sh` and doesn't touch health-check logic itself — should keep passing once `npm run check` is green.

### Commands

- Integration: `bash service/deploy.test.sh`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- `deploy.test.sh` already supplies `mktemp -d`, `PATH` shim for `npm pack`, and DRY_RUN gating. The new tests reuse this scratch dir model. No external service needed.
- `npm run check` needs `node_modules` (run `npm install --no-audit --no-fund --no-progress` first if missing).

### Non-Required Rationale

- Unit: There is no TS layer for `deploy.sh`. Splitting helpers into a TS module would be over-engineering for one bash function.
- E2E: A real-launchctl smoke would require booting a hive on the test host, which isn't part of CI. The shell integration test reproduces the failure mode (many lines after the marker) on real log shapes, which is the actual evidence the ticket asks for.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

- Modify: `service/deploy.sh`
  - Replace `health_check()` with offset-aware version.
  - Add `log_size_before()` helper (sibling to existing `notify`, `run_cmd`).
  - Add `_scan_new_boot()` private helper called by `health_check`.
  - At the two `launchctl bootstrap → health_check` call sites, capture offset before bootstrap.

- Modify: `service/deploy.test.sh`
  - Widen the helper-sourcing sed range so the new functions get sourced too.
  - Set `HEALTH_CHECK_*` knobs to small values for fast test runs.
  - Add 4 new test cases (busy boot, genuine failure, stale marker, missing log).

---

## Task 1: Harden health_check with boot-anchored offset

**Files:**
- Modify: `service/deploy.sh` (around lines 130–150 for `health_check`, lines 376 and 533 for call sites)
- Modify: `service/deploy.test.sh` (extend sed range at line 68; add test cases at end)

- [ ] **Step 1:** Add `log_size_before` and rewrite `health_check` in `service/deploy.sh`.

Locate the existing `health_check()` function (immediately after `notify()`, before `kill_ports()`). Replace it with:

```bash
# log_size_before <log_file>
# Byte size of the log right now, or 0 if it doesn't exist. Captured
# immediately before `launchctl bootstrap` so health_check can scan only
# bytes written by the new boot and ignore any stale "Hive is running"
# from a prior run.
log_size_before() {
  local log_file="$1"
  if [[ -f "$log_file" ]]; then
    wc -c < "$log_file" | awk '{print $1}'
  else
    echo 0
  fi
}

# health_check <log_file> [start_offset]
# KPR-240: anchor the marker scan to the boot we just kicked off.
# Reads bytes after $start_offset and succeeds iff "Hive is running"
# appears after "Hive starting up" in that window. Avoids the tail -5
# race on busy boots (12 agents + scheduler + memory lifecycle can push
# the marker out of the last 5 lines within 1s) and refuses to match a
# stale marker from a previous run.
health_check() {
  local log_file="$1"
  local start_offset="${2:-0}"
  if $DRY_RUN; then
    echo "[DRY RUN] health_check: would check $log_file (offset $start_offset)"
    return 0
  fi
  for attempt in $(seq 1 "$HEALTH_CHECK_RETRIES"); do
    if [[ "$attempt" -gt 1 ]]; then
      echo "  Health check attempt $attempt/$HEALTH_CHECK_RETRIES (waiting ${HEALTH_CHECK_WAIT_BETWEEN}s before retry)..."
      sleep "$HEALTH_CHECK_WAIT_BETWEEN"
    fi
    for _ in $(seq 1 "$HEALTH_CHECK_WINDOW"); do
      sleep 1
      if _scan_new_boot "$log_file" "$start_offset"; then
        return 0
      fi
    done
    echo "  Health check attempt $attempt/$HEALTH_CHECK_RETRIES failed (no 'Hive is running' in last ${HEALTH_CHECK_WINDOW}s)."
  done
  return 1
}

# _scan_new_boot <log_file> <start_offset>
# True iff the bytes after $start_offset contain "Hive is running"
# preceded by "Hive starting up". tail -c +N is 1-indexed: start at byte N.
_scan_new_boot() {
  local log_file="$1"
  local start_offset="$2"
  [[ -f "$log_file" ]] || return 1
  tail -c "+$((start_offset + 1))" "$log_file" 2>/dev/null | awk '
    /"Hive starting up"/ { started = 1; next }
    started && /"Hive is running"/ { found = 1; exit }
    END { if (found) exit 0; else exit 1 }
  '
}
```

- [ ] **Step 2:** Thread offset through the rollback short-circuit call site in `service/deploy.sh`.

Locate the block (around line 372–377):

```bash
  if ! rollback_engine "$instance_root"; then
    notify "Rollback FAILED for \`$id\`: no previous engine (.hive.prev missing)."
    exit 1
  fi
  run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"
  if health_check "$instance_root/$logs_dir/hive.log"; then
```

Replace with:

```bash
  if ! rollback_engine "$instance_root"; then
    notify "Rollback FAILED for \`$id\`: no previous engine (.hive.prev missing)."
    exit 1
  fi
  health_log="$instance_root/$logs_dir/hive.log"
  health_offset=$(log_size_before "$health_log")
  run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"
  if health_check "$health_log" "$health_offset"; then
```

- [ ] **Step 3:** Thread offset through the Phase 2 deploy call site in `service/deploy.sh`.

Locate the block (around line 529–536):

```bash
  echo "  Swapping engine..."
  swap_engine "$instance_root"

  echo "  Restarting $label..."
  run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"

  echo "  Checking health..."
  if ! health_check "$instance_root/$logs_dir/hive.log"; then
```

Replace with:

```bash
  echo "  Swapping engine..."
  swap_engine "$instance_root"

  health_log="$instance_root/$logs_dir/hive.log"
  health_offset=$(log_size_before "$health_log")
  echo "  Restarting $label..."
  run_cmd launchctl bootstrap "gui/$(id -u)" "$plist_path"

  echo "  Checking health..."
  if ! health_check "$health_log" "$health_offset"; then
```

Leave the auto-rollback bootstrap (~line 550) untouched — it doesn't call health_check.

- [ ] **Step 4:** Widen the helper-sourcing sed range in `service/deploy.test.sh` and pin small health-check knobs.

Locate (around line 63–74):

```bash
sed -n '/^# --- Engine fetch\/swap\/rollback/,/^# --- Short-circuit:/{/^# --- Short-circuit:/!p;}' \
  "$SCRIPT_DIR/deploy.sh" > "$TESTROOT/helpers.sh"
# Helper bodies reference $DRY_RUN (added so --dry-run skips the destructive
# ops); set it false here so the helpers actually execute under set -u.
DRY_RUN=false
# shellcheck source=/dev/null
source "$TESTROOT/helpers.sh"
```

Replace with:

```bash
sed -n '/^# --- Helpers ---/,/^# --- Short-circuit:/{/^# --- Short-circuit:/!p;}' \
  "$SCRIPT_DIR/deploy.sh" > "$TESTROOT/helpers.sh"
# Helper bodies reference $DRY_RUN (added so --dry-run skips the destructive
# ops); set it false here so the helpers actually execute under set -u.
DRY_RUN=false
# Keep health_check's retry/window/wait small so the new tests don't burn 90s.
HEALTH_CHECK_RETRIES=1
HEALTH_CHECK_WINDOW=2
HEALTH_CHECK_WAIT_BETWEEN=0
# shellcheck source=/dev/null
source "$TESTROOT/helpers.sh"
```

The wider sed range pulls in `run_cmd`, `notify`, `log_size_before`, `health_check`, `_scan_new_boot`, and `kill_ports` in addition to the existing fetch/swap/rollback functions. All of those reference `$DRY_RUN` (set false), `${SLACK_BOT_TOKEN:-}` / `${DEVOPS_CHANNEL_ID:-}` (set -u-safe), and the three `HEALTH_CHECK_*` knobs (pinned above).

- [ ] **Step 5:** Append the four health-check regression tests at the end of `service/deploy.test.sh`, immediately before the final `echo "all tests passed."` line.

```bash
# --- Health-check tests (KPR-240) ---
# Anchor the marker scan to a captured byte offset so a busy boot logging
# many lines after "Hive is running" can't be falsely flagged failed, and
# so a stale marker from a previous run can't be falsely flagged healthy.
LOG_DIR=$(mktemp -d -t hive-health-test.XXXXXX)
trap 'rm -rf "$TESTROOT" "$LOG_DIR"' EXIT

# --- Test 11: busy boot logs many lines after marker, still passes ---
echo "test 11: busy boot passes despite marker scrolling out of tail -5"
LOG_FILE="$LOG_DIR/hive-busy.log"
: > "$LOG_FILE"
OFFSET=$(log_size_before "$LOG_FILE")
# Simulate the new boot: starting marker, running marker, then a flood of
# log lines (12 agents + scheduler + memory lifecycle) that pushes the
# marker far out of `tail -5`.
{
  echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"hive","msg":"Hive starting up","instance":"test"}'
  echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"hive","msg":"Hive is running"}'
  for i in $(seq 1 50); do
    echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"agent","msg":"agent-'"$i"' ready"}'
  done
} >> "$LOG_FILE"
if ! health_check "$LOG_FILE" "$OFFSET" >/dev/null; then
  echo "FAIL: healthy boot with flood after marker should pass"
  exit 1
fi
# Sanity: with the legacy tail -5 strategy this would have failed.
if tail -5 "$LOG_FILE" | grep -q '"Hive is running"'; then
  echo "FAIL: tail -5 unexpectedly still contains the marker — test setup wrong"
  exit 1
fi

# --- Test 12: genuine boot failure (never reaches marker) fails ---
echo "test 12: genuine boot failure fails health_check"
LOG_FILE="$LOG_DIR/hive-fail.log"
: > "$LOG_FILE"
OFFSET=$(log_size_before "$LOG_FILE")
{
  echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"hive","msg":"Hive starting up","instance":"test"}'
  echo '{"ts":"2026-05-25T00:00:00Z","level":"error","component":"hive","msg":"Mongo unreachable, exiting"}'
} >> "$LOG_FILE"
if health_check "$LOG_FILE" "$OFFSET" >/dev/null 2>&1; then
  echo "FAIL: boot that never reached 'Hive is running' should fail"
  exit 1
fi

# --- Test 13: stale "Hive is running" before offset is ignored ---
echo "test 13: stale marker from previous boot is not matched"
LOG_FILE="$LOG_DIR/hive-stale.log"
: > "$LOG_FILE"
# Previous boot: full happy-path markers land in the file.
{
  echo '{"ts":"2026-05-24T00:00:00Z","level":"info","component":"hive","msg":"Hive starting up","instance":"test"}'
  echo '{"ts":"2026-05-24T00:00:00Z","level":"info","component":"hive","msg":"Hive is running"}'
} >> "$LOG_FILE"
# Capture offset AFTER the prior boot's markers — mimics the deploy.sh
# call site that snapshots wc -c right before launchctl bootstrap.
OFFSET=$(log_size_before "$LOG_FILE")
# New boot crashes before "Hive is running". The stale marker is still
# physically in the log, but past start_offset there is no marker.
{
  echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"hive","msg":"Hive starting up","instance":"test"}'
  echo '{"ts":"2026-05-25T00:00:00Z","level":"error","component":"hive","msg":"crashed"}'
} >> "$LOG_FILE"
if health_check "$LOG_FILE" "$OFFSET" >/dev/null 2>&1; then
  echo "FAIL: stale marker from previous boot should not satisfy health_check"
  exit 1
fi

# --- Test 14: log file absent at start (fresh install), then created ---
echo "test 14: missing log at offset capture, populated by boot, passes"
LOG_FILE="$LOG_DIR/hive-fresh.log"
# No file yet — offset is 0 by contract.
OFFSET=$(log_size_before "$LOG_FILE")
[[ "$OFFSET" == "0" ]] || { echo "FAIL: log_size_before should return 0 for missing file (got '$OFFSET')"; exit 1; }
{
  echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"hive","msg":"Hive starting up","instance":"test"}'
  echo '{"ts":"2026-05-25T00:00:00Z","level":"info","component":"hive","msg":"Hive is running"}'
} > "$LOG_FILE"
if ! health_check "$LOG_FILE" "$OFFSET" >/dev/null; then
  echo "FAIL: fresh-install boot should pass health_check"
  exit 1
fi
```

- [ ] **Step 6:** Verify syntax + smoke tests.

Run:

```bash
bash -n service/deploy.sh
bash -n service/deploy.test.sh
bash service/deploy.test.sh
```

Expected: both `bash -n` exit 0 with no output; `deploy.test.sh` prints `test 1` through `test 14` and ends with `all tests passed.`

- [ ] **Step 7:** Verify broader regression.

Run:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck, lint, format:check, and the full vitest suite all pass. No `deploy.sh`-adjacent TS regressions (none expected — TS code doesn't touch this script).

- [ ] **Step 8:** Commit.

```bash
git add service/deploy.sh service/deploy.test.sh
git commit -m "fix(deploy): anchor health_check to boot offset (KPR-240)

Replace tail -5 | grep with a byte-offset scan captured immediately
before launchctl bootstrap. On busy boots (12 agents + scheduler +
memory lifecycle), the marker can scroll past tail -5 within 1s,
spuriously failing a healthy boot and auto-rolling-back. The offset
gates the scan to the new boot's bytes only, and the awk pass requires
'Hive is running' to follow 'Hive starting up' as belt-and-suspenders
against stale markers.

Suspected contributor to the catalyst 0.8.2 → 0.8.1 rollback on
2026-05-25 (engine booted, reached marker, was rolled back anyway;
failed engine landed in .hive.broken).

Adds 4 regression tests covering busy-boot flood, genuine failure,
stale marker, and fresh-install."
```

---

**Plan saved to `docs/plans/2026-05-25-kpr-240-harden-deploy-health-check.md`. Ready to execute?**
