#!/usr/bin/env bash
set -euo pipefail

KEEP_DAYS=3
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HIVE_ROOT="$(dirname "$SCRIPT_DIR")"
INSTANCES_CONF="$SCRIPT_DIR/instances.conf"

# --- MongoDB ---
if command -v mongosh &>/dev/null; then
  MONGO_LOG_DIR="/opt/homebrew/var/log/mongodb"
  mongosh --quiet --eval 'db.adminCommand({logRotate: 1})' >/dev/null 2>&1 || true
  find "$MONGO_LOG_DIR" -name "mongo.log.*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
fi

# --- Per-instance logs ---
while IFS='|' read -r id config agents_path label logs_dir ports; do
  [[ "$id" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$id" ]] && continue
  logs_dir=$(echo "$logs_dir" | xargs)

  LOG_DIR="$HIVE_ROOT/$logs_dir"
  [[ -d "$LOG_DIR" ]] || continue

  for logfile in hive.log hive.err; do
    src="$LOG_DIR/$logfile"
    if [ -s "$src" ]; then
      cp "$src" "$LOG_DIR/${logfile}.${TIMESTAMP}"
      : > "$src"
    fi
  done
  find "$LOG_DIR" -name "hive.*.2*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
done < "$INSTANCES_CONF"

# --- Deploy checker ---
DEPLOY_LOG="$HIVE_ROOT/logs/deploy-check.log"
if [ -s "$DEPLOY_LOG" ]; then
  cp "$DEPLOY_LOG" "$HIVE_ROOT/logs/deploy-check.log.${TIMESTAMP}"
  : > "$DEPLOY_LOG"
fi
find "$HIVE_ROOT/logs" -name "deploy-check.*.2*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
