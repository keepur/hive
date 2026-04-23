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
# Helper bodies reference $DRY_RUN (added so --dry-run skips the destructive
# ops); set it false here so the helpers actually execute under set -u.
DRY_RUN=false
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

# --- Test 8: --dry-run skips destructive ops in helpers ---
echo "test 8: dry-run helpers don't mutate disk"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
DRY_RUN=true
fetch_engine "$DEPLOY_DIR" "latest" >/dev/null
[[ ! -d "$DEPLOY_DIR/.hive.next" ]] || { echo "FAIL: dry-run fetch_engine created .hive.next"; exit 1; }
install_engine_deps "$DEPLOY_DIR" >/dev/null
swap_engine "$DEPLOY_DIR" >/dev/null
[[ ! -d "$DEPLOY_DIR/.hive" ]] || { echo "FAIL: dry-run swap_engine created .hive"; exit 1; }
# rollback in dry-run with no .hive.prev should report failure but not touch disk
if rollback_engine "$DEPLOY_DIR" >/dev/null 2>&1; then
  echo "FAIL: dry-run rollback_engine should have returned 1 (no .hive.prev)"
  exit 1
fi
[[ ! -d "$DEPLOY_DIR/.hive.broken" ]] || { echo "FAIL: dry-run rollback created .hive.broken"; exit 1; }
DRY_RUN=false

# --- Test 9: install_engine_deps runs npm install inside .hive.next ---
echo "test 9: install_engine_deps runs npm install in .hive.next/"
# Restore full shim so npm pack works
cat > "$SHIM_DIR/npm" <<'NPMEOF'
#!/usr/bin/env bash
outdir="$PWD"
case "$1" in
  pack)
    stage=$(mktemp -d)
    mkdir -p "$stage/package/pkg" "$stage/package/seeds" "$stage/package/templates" "$stage/package/scripts"
    echo "// fake server bundle" > "$stage/package/pkg/server.min.js"
    echo '{"name":"@keepur/hive","version":"0.2.0"}' > "$stage/package/package.json"
    tarball="keepur-hive-0.2.0.tgz"
    (cd "$stage" && tar -czf "$outdir/$tarball" package)
    rm -rf "$stage"
    echo "$tarball"
    ;;
  view) echo "0.2.0" ;;
  install)
    # Record that npm install ran in the scratch dir so the test can verify it
    touch "$PWD/.install-ran"
    ;;
  *) exit 0 ;;
esac
NPMEOF
chmod +x "$SHIM_DIR/npm"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
fetch_engine "$DEPLOY_DIR" "latest" >/dev/null
install_engine_deps "$DEPLOY_DIR" >/dev/null
[[ -f "$DEPLOY_DIR/.hive.next/.install-ran" ]] || { echo "FAIL: install_engine_deps didn't run npm install in .hive.next/"; exit 1; }

# --- Test 10: install_engine_deps errors when package.json missing ---
echo "test 10: install_engine_deps errors when .hive.next/package.json missing"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/.hive.next"  # empty dir, no package.json
if install_engine_deps "$DEPLOY_DIR" >/dev/null 2>&1; then
  echo "FAIL: install_engine_deps should have errored without package.json"
  exit 1
fi

echo "all tests passed."
