#!/usr/bin/env bash
# =============================================================================
# migrate-0.2.test.sh — shell test harness for migrate-0.2.sh
# =============================================================================
# Constructs a fake 0.1.x instance in a temp dir, runs migrate-0.2.sh in
# dry-run mode (real mode would require a real @keepur/hive install), and
# asserts the classification + skeleton logic work.
#
# Run: ./install/migrate-0.2.test.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$SCRIPT_DIR/migrate-0.2.fixtures/loose-files.txt"
TESTROOT=$(mktemp -d -t migrate-test.XXXXXX)
trap 'rm -rf "$TESTROOT"' EXIT

INSTANCE="$TESTROOT/fakeinstance"
mkdir -p "$INSTANCE"

# --- Build a 0.1.x-looking instance ---
# Engine files we expect Step 5 to delete
mkdir -p "$INSTANCE/dist" "$INSTANCE/node_modules" "$INSTANCE/src" "$INSTANCE/seeds"
echo "// dist" > "$INSTANCE/dist/index.js"
echo "{}" > "$INSTANCE/package.json"
echo "{}" > "$INSTANCE/package-lock.json"
echo "{}" > "$INSTANCE/tsconfig.json"
mkdir -p "$INSTANCE/plugins/claude-code"

# Preserved files
cat > "$INSTANCE/hive.yaml" <<YAML
instance:
  id: fakeinstance
codeTask:
  pluginDirs:
    - ~/services/hive/plugins/claude-code
YAML
echo "SLACK_BOT_TOKEN=fake" > "$INSTANCE/.env"
mkdir -p "$INSTANCE/logs"
echo "{}" > "$INSTANCE/.hive-generated.json"

# Service dir (simulate a live primary plist symlink by just creating the file;
# Step 5's LIVE_PLISTS discovery uses ~/Library/LaunchAgents, which we don't
# want to touch in a test — so LIVE_PLISTS will be empty, and Step 5 will
# clear service/ entirely. That's correct for this test.)
mkdir -p "$INSTANCE/service"
echo "<xml/>" > "$INSTANCE/service/com.hive.agent.plist"

# Instance-git state (simulates 0.1.x internal state)
mkdir -p "$INSTANCE/.hive/git"
echo "state" > "$INSTANCE/.hive/git/HEAD"
echo '{"version":"0.1.10"}' > "$INSTANCE/.hive/installed-snapshot.json"

# Loose files from fixtures
while read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$f" == .playwright-mcp/* ]] && continue  # handled below
  dir=$(dirname "$f")
  [[ "$dir" == "." ]] || mkdir -p "$INSTANCE/$dir"
  echo "content of $f" > "$INSTANCE/$f"
done < "$FIXTURES"

# .playwright-mcp with a couple of log files
mkdir -p "$INSTANCE/.playwright-mcp"
echo "console log 0" > "$INSTANCE/.playwright-mcp/console-0.log"
echo "console log 1" > "$INSTANCE/.playwright-mcp/console-1.log"

# --- Run the migrate script in dry-run ---
# Preflight needs: hive.yaml (present), dist/index.js OR .hive/git (both present),
# yq, jq, rsync, realpath, readlink, launchctl (all assumed present on macOS).
# No actual service running, so LaunchAgents preflight check is a no-op.
echo ""
echo "=== Dry-run ==="
bash "$SCRIPT_DIR/migrate-0.2.sh" --dry-run "$INSTANCE" | tee "$TESTROOT/dry-run.log"

# --- Assertions for dry-run ---
grep -q "preflight" "$TESTROOT/dry-run.log" || { echo "FAIL: no preflight line in dry-run output"; exit 1; }
grep -q "Dry-run complete" "$TESTROOT/dry-run.log" || { echo "FAIL: dry-run didn't exit via the dry-run branch"; exit 1; }

# Classification table lines we expect to see
expect_classification() {
  local file="$1"
  local dest="$2"
  if ! grep -Eq "^\\s*$file\\s+→\\s+$dest" "$TESTROOT/dry-run.log"; then
    echo "FAIL: expected '$file → $dest' in classification table"
    grep -E "(milo|river|permit|standup|hubspot|stale|lead|query|README|fb-|linkedin|x-|analyze|check|extract)" "$TESTROOT/dry-run.log" || true
    exit 1
  fi
}

expect_classification "milo-standup-2026-03-15.md"    "agents/milo/reports/archive-pre-0.2"
expect_classification "river-permits-weekly-2026-03-08.md" "agents/river/reports/archive-pre-0.2"
# Ordering-decisive: hits river-* (arm 2) not *-permits.csv (arm 9). Destinations agree;
# this guards against a reordering regression where a later arm stole the match.
expect_classification "river-high-tier-permits-extraction.csv" "agents/river/reports/archive-pre-0.2"
expect_classification "PERMIT-EXTRACTION-SUMMARY.md"  "agents/river/reports/archive-pre-0.2"
expect_classification "fb-marketplace-scrape-2026-03-20.md" "data/archive-pre-0.2/social-scrapes"
expect_classification "linkedin-sales-prospects.md"   "data/archive-pre-0.2/social-scrapes"
expect_classification "stale-deals.csv"               "agents/milo/reports/archive-pre-0.2"
expect_classification "HUBSPOT-contacts-dump.csv"     "agents/milo/reports/archive-pre-0.2"
# Ordering-decisive: HUBSPOT-river-pulls.csv must hit HUBSPOT-* (→ Milo), not any
# River pattern. Different destinations here, so a wrong match is silently wrong.
expect_classification "HUBSPOT-river-pulls.csv"       "agents/milo/reports/archive-pre-0.2"
expect_classification "LEAD-SEGMENTATION-tier1.csv"   "data/archive-pre-0.2/unsorted"
expect_classification "QUERY-RESULTS-high-value.csv"  "data/archive-pre-0.2/unsorted"
expect_classification "analyze-pipeline.ts"           "data/archive-pre-0.2/scripts"
expect_classification "README-stale-deals.md"        "data/archive-pre-0.2"

# .playwright-mcp should be flagged for deletion
grep -q ".playwright-mcp" "$TESTROOT/dry-run.log" || { echo "FAIL: .playwright-mcp not mentioned"; exit 1; }

# --- Verify dry-run did NOT mutate ---
[[ -d "$INSTANCE/dist" ]] || { echo "FAIL: dry-run deleted dist/"; exit 1; }
[[ -d "$INSTANCE/node_modules" ]] || { echo "FAIL: dry-run deleted node_modules/"; exit 1; }
[[ -f "$INSTANCE/milo-standup-2026-03-15.md" ]] || { echo "FAIL: dry-run moved a loose file"; exit 1; }
[[ ! -d "$INSTANCE/agents" ]] || { echo "FAIL: dry-run created namespace dirs"; exit 1; }
[[ ! -e "$INSTANCE.pre-0.2-bak" ]] || { echo "FAIL: dry-run created snapshot"; exit 1; }

echo ""
echo "=== Classifier-only smoke (real mode skipped — would need @keepur/hive installed) ==="
echo "all dry-run assertions passed."
