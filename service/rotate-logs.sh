#!/usr/bin/env bash
set -euo pipefail

KEEP_DAYS=3
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)

# --- MongoDB ---
MONGO_LOG_DIR="/opt/homebrew/var/log/mongodb"
/opt/homebrew/bin/mongosh --quiet --eval 'db.adminCommand({logRotate: 1})' >/dev/null 2>&1
find "$MONGO_LOG_DIR" -name "mongo.log.*" -mtime +${KEEP_DAYS} -delete

# --- Hive ---
HIVE_LOG_DIR="$HOME/services/hive/logs"
for logfile in hive.log hive.err; do
  src="$HIVE_LOG_DIR/$logfile"
  if [ -s "$src" ]; then
    cp "$src" "$HIVE_LOG_DIR/${logfile}.${TIMESTAMP}"
    : > "$src"
  fi
done
find "$HIVE_LOG_DIR" -name "hive.*.2*" -mtime +${KEEP_DAYS} -delete
