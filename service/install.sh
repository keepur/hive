#!/usr/bin/env bash
set -euo pipefail

# Production installation delegates to this package's CLI so start uses the
# same instance lock, paired transaction, service definitions and health gates
# as update/restart/rollback.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$PACKAGE_ROOT/pkg/cli.min.js"
if [[ ! -f "$CLI" ]]; then
  echo "ERROR: packaged Hive CLI missing at $CLI" >&2
  exit 1
fi
INSTANCE_HOME="${HIVE_HOME:-$(cd "$PACKAGE_ROOT/.." && pwd)}"
CONFIG_SELECTOR="${HIVE_CONFIG:-hive.yaml}"
if [[ "$CONFIG_SELECTOR" != /* ]]; then
  CONFIG_SELECTOR="$INSTANCE_HOME/$CONFIG_SELECTOR"
fi
export HIVE_HOME="$INSTANCE_HOME"
export HIVE_CONFIG="$CONFIG_SELECTOR"
exec "${HIVE_NODE_PATH:-node}" "$CLI" start --daemon --config "$CONFIG_SELECTOR"
