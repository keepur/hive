#!/usr/bin/env bash
set -euo pipefail

KEEP_DAYS=3
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)

# Resolve the Hive root (this script lives in service/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HIVE_ROOT="$(dirname "$SCRIPT_DIR")"
HIVE_LOG_DIR="$HIVE_ROOT/logs"

# --- MongoDB ---
if command -v mongosh &>/dev/null; then
  MONGO_LOG_DIR="/opt/homebrew/var/log/mongodb"
  mongosh --quiet --eval 'db.adminCommand({logRotate: 1})' >/dev/null 2>&1 || true
  find "$MONGO_LOG_DIR" -name "mongo.log.*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
fi

# --- Hive ---
for logfile in hive.log hive.err; do
  src="$HIVE_LOG_DIR/$logfile"
  if [ -s "$src" ]; then
    cp "$src" "$HIVE_LOG_DIR/${logfile}.${TIMESTAMP}"
    : > "$src"
  fi
done
find "$HIVE_LOG_DIR" -name "hive.*.2*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true

# --- Deploy checker ---
for logfile in deploy-check.log; do
  src="$HIVE_LOG_DIR/$logfile"
  if [ -s "$src" ]; then
    cp "$src" "$HIVE_LOG_DIR/${logfile}.${TIMESTAMP}"
    : > "$src"
  fi
done
find "$HIVE_LOG_DIR" -name "deploy-check.*.2*" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
