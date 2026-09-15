#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_ROOT="$(mktemp -d -t hive-install-test.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/package/service" "$TEST_ROOT/package/pkg" "$TEST_ROOT/instance & selected"
cp "$SCRIPT_DIR/install.sh" "$TEST_ROOT/package/service/install.sh"
: > "$TEST_ROOT/package/pkg/cli.min.js"
NODE_SHIM="$TEST_ROOT/node-shim"
cat > "$NODE_SHIM" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$HIVE_HOME" "$HIVE_CONFIG" "$@" > "$INSTALL_TEST_OUTPUT"
SHIM
chmod +x "$NODE_SHIM" "$TEST_ROOT/package/service/install.sh"

export INSTALL_TEST_OUTPUT="$TEST_ROOT/output"
HIVE_HOME="$TEST_ROOT/instance & selected" \
HIVE_CONFIG="hive-personal.yaml" \
HIVE_NODE_PATH="$NODE_SHIM" \
  "$TEST_ROOT/package/service/install.sh"

mapfile_compat=()
while IFS= read -r line; do mapfile_compat+=("$line"); done < "$INSTALL_TEST_OUTPUT"
[[ "${mapfile_compat[0]}" == "$TEST_ROOT/instance & selected" ]]
[[ "${mapfile_compat[1]}" == "$TEST_ROOT/instance & selected/hive-personal.yaml" ]]
[[ "${mapfile_compat[2]}" == "$TEST_ROOT/package/pkg/cli.min.js" ]]
[[ "${mapfile_compat[3]}" == "start" ]]
[[ "${mapfile_compat[4]}" == "--daemon" ]]
[[ "${mapfile_compat[5]}" == "--config" ]]
[[ "${mapfile_compat[6]}" == "$TEST_ROOT/instance & selected/hive-personal.yaml" ]]

rm "$TEST_ROOT/package/pkg/cli.min.js"
if "$TEST_ROOT/package/service/install.sh" >"$TEST_ROOT/stdout" 2>"$TEST_ROOT/stderr"; then
  echo "FAIL: install succeeded without packaged CLI" >&2
  exit 1
fi
grep -q "packaged Hive CLI missing" "$TEST_ROOT/stderr"
echo "install wrapper tests passed"
