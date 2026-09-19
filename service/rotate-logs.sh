#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Hive log rotation — copy-and-truncate, gzip, expire
# =============================================================================
#
# Copy+truncate works while the daemon runs: launchd opens StandardOutPath with
# O_APPEND, so the service keeps appending to the same (now empty) file. Lines
# written between the copy and the truncate are lost — acceptable for these logs.
#
# Which logs get rotated:
#   - Single-instance (customer install): <home>/logs. The shipped
#     instances.conf is empty by design, so the registry loop alone rotates
#     nothing there. The instance home is discovered the way deploy.sh /
#     `hive update` discover it — HIVE_HOME, else HIVE_SINGLE_INSTANCE=1 +
#     HIVE_SINGLE_ROOT — and, for LaunchAgents whose plist predates HIVE_HOME,
#     from this script's own location (<home>/.hive/service/rotate-logs.sh).
#   - Multi-instance dev host: every row of instances.conf (HIVE_INSTANCES_CONF
#     points at a workspace-level conf, as in deploy.sh / deploy-check.sh).
#
# Tunables (env):
#   KEEP_DAYS               days to keep rotated copies. Default 28, so a weekly
#                           schedule still keeps ~4 copies (gzip keeps them small).
#   HIVE_ROTATE_EXTRA_LOGS  extra file names under logs/ to rotate, space-separated
#                           (e.g. cron-fed job logs: "code-index.log embed.log").
#   MONGO_LOG_DIR           where mongod writes mongo.log.
# =============================================================================

KEEP_DAYS="${KEEP_DAYS:-28}"
if [[ ! "$KEEP_DAYS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: KEEP_DAYS must be a non-negative integer (got '$KEEP_DAYS')" >&2
  exit 2
fi
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HIVE_ROOT="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
INSTANCES_CONF="${HIVE_INSTANCES_CONF:-$SCRIPT_DIR/instances.conf}"
MONGO_LOG_DIR="${MONGO_LOG_DIR:-/opt/homebrew/var/log/mongodb}"

LOG_NAMES=(hive.log hive.err voice-worker.log voice-worker.err deploy-check.log)
for extra in ${HIVE_ROTATE_EXTRA_LOGS:-}; do
  # Names only — they are interpolated into a find -name pattern below.
  if [[ ! "$extra" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: HIVE_ROTATE_EXTRA_LOGS entry '$extra' is not a plain file name" >&2
    exit 2
  fi
  LOG_NAMES+=("$extra")
done

FAILED=0
ROTATED_DIRS=""

echo "[$TIMESTAMP] rotate-logs: start (keep ${KEEP_DAYS}d)"

# rotate_dir <log_dir>
# Rotates every LOG_NAMES file in <log_dir>, then expires rotated copies older
# than KEEP_DAYS. Rotated copies are named <log>.<YYYY-MM-DDTHH-MM-SS>[.gz];
# the expiry pattern is anchored on those names, so live logs and unrelated
# files never match.
rotate_dir() {
  local log_dir="$1"
  local name src dest before
  if [[ ! -d "$log_dir" ]]; then
    echo "  WARN: $log_dir does not exist — skipped"
    return 0
  fi
  # Registry rows can share a logs dir — rotate each dir once per run.
  case ":$ROTATED_DIRS:" in
    *":$log_dir:"*) return 0 ;;
  esac
  ROTATED_DIRS="$ROTATED_DIRS:$log_dir"
  echo "  $log_dir"
  for name in "${LOG_NAMES[@]}"; do
    src="$log_dir/$name"
    dest="$src.$TIMESTAMP"
    [[ -s "$src" ]] || continue
    # Never overwrite a rotated copy (two registry rows can share a logs dir,
    # and a racing write would otherwise replace the real copy with a stub).
    if [[ -e "$dest" || -e "$dest.gz" ]]; then
      continue
    fi
    before=$(wc -c < "$src" | tr -d '[:space:]')
    # Truncate only once the copy landed — on a full disk a failed copy must
    # not cost us the log.
    if ! cp "$src" "$dest"; then
      echo "    ERROR: could not copy $name — left untouched" >&2
      rm -f "$dest"
      FAILED=1
      continue
    fi
    : > "$src"
    if gzip "$dest"; then
      dest="$dest.gz"
    else
      echo "    WARN: gzip failed for $(basename "$dest") — kept uncompressed" >&2
    fi
    echo "    $name: $before bytes -> $(basename "$dest") ($(wc -c < "$dest" | tr -d '[:space:]') bytes)"
  done
  for name in "${LOG_NAMES[@]}"; do
    find "$log_dir" -maxdepth 1 -type f -name "$name.20[0-9][0-9]-*" -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null |
      sed 's/^/    expired: /' || true
  done
}

# _instance_root <id> — same resolution as deploy.sh: $DEPLOY_DIR/<id> when that
# dir exists (per-instance layout), else $DEPLOY_DIR (shared-dir layout).
_instance_root() {
  local id="$1"
  if [[ -d "$DEPLOY_DIR/$id" ]]; then
    echo "$DEPLOY_DIR/$id"
  else
    echo "$DEPLOY_DIR"
  fi
}

# --- MongoDB ---
if command -v mongosh &>/dev/null; then
  mongosh --quiet --eval 'db.adminCommand({logRotate: 1})' >/dev/null 2>&1 || true
  # mongod has closed the files it rotated out, so they are safe to compress.
  find "$MONGO_LOG_DIR" -maxdepth 1 -type f -name "mongo.log.*" ! -name "*.gz" -exec gzip {} + 2>/dev/null || true
  find "$MONGO_LOG_DIR" -maxdepth 1 -type f -name "mongo.log.*" -mtime +"$KEEP_DAYS" -delete 2>/dev/null || true
fi

# --- Instance logs ---
SINGLE_HOME=""
if [[ -n "${HIVE_HOME:-}" ]]; then
  SINGLE_HOME="$HIVE_HOME"
elif [[ "${HIVE_SINGLE_INSTANCE:-}" == "1" ]]; then
  : "${HIVE_SINGLE_ROOT:?HIVE_SINGLE_ROOT required in single-instance mode}"
  SINGLE_HOME="$HIVE_SINGLE_ROOT"
fi

if [[ -n "$SINGLE_HOME" ]]; then
  rotate_dir "$SINGLE_HOME/${HIVE_SINGLE_LOGS:-logs}"
else
  ROWS=0
  if [[ -f "$INSTANCES_CONF" ]]; then
    while IFS='|' read -r id _config _agents_path _label logs_dir _rest || [[ -n "$id" ]]; do
      [[ "$id" =~ ^[[:space:]]*# ]] && continue
      id=$(echo "$id" | xargs)
      [[ -z "$id" ]] && continue
      logs_dir=$(echo "$logs_dir" | xargs)
      ROWS=$((ROWS + 1))

      LOG_DIR="$(_instance_root "$id")/$logs_dir"
      # Legacy shared-dir deploys resolved logs against the checkout this
      # script lives in; keep honouring that when DEPLOY_DIR has no such dir.
      [[ -d "$LOG_DIR" ]] || LOG_DIR="$HIVE_ROOT/$logs_dir"
      rotate_dir "$LOG_DIR"
    done < "$INSTANCES_CONF"
  fi

  if [[ $ROWS -eq 0 && "$(basename "$HIVE_ROOT")" == ".hive" && -d "$(dirname "$HIVE_ROOT")/logs" ]]; then
    # Empty registry + engine-bundle layout: this is a customer install whose
    # plist doesn't pass HIVE_HOME. The instance home is the parent of .hive/.
    rotate_dir "$(dirname "$HIVE_ROOT")/logs"
  elif [[ -d "$HIVE_ROOT/logs" ]]; then
    # Legacy shared-dir checkout: logs/ sits next to service/ and holds
    # deploy-check.log (rotate_dir skips it if a registry row covered it).
    rotate_dir "$HIVE_ROOT/logs"
  elif [[ $ROWS -eq 0 ]]; then
    echo "ERROR: nothing to rotate — HIVE_HOME is unset and $INSTANCES_CONF has no instance rows." >&2
    echo "       Set HIVE_HOME in the rotate-logs LaunchAgent, or point HIVE_INSTANCES_CONF at a workspace-level conf." >&2
    FAILED=1
  fi
fi

echo "[$TIMESTAMP] rotate-logs: done"
exit "$FAILED"
