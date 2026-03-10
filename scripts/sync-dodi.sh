#!/bin/bash
# Sync dodi_v2 production data from Atlas → local MongoDB → Qdrant
#
# Runs as cron every 2 hours:
#   0 */2 * * *  ~/services/hive/scripts/sync-dodi.sh >> ~/logs/sync-dodi.log 2>&1

set -euo pipefail

ATLAS_URI="mongodb+srv://blues:keepur2019@production.mjswk.mongodb.net/production"
LOCAL_URI="mongodb://localhost:27017"
DUMP_DIR="/tmp/dodi-dump"
HIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== sync-dodi: $(date) ==="

# 1. Dump from Atlas
echo "Dumping from Atlas..."
rm -rf "$DUMP_DIR"
mongodump --uri="$ATLAS_URI" --out="$DUMP_DIR" --quiet

# 2. Restore to local MongoDB as 'dodi' database
echo "Restoring to local dodi database..."
mongorestore --uri="$LOCAL_URI" --nsFrom="production.*" --nsTo="dodi.*" --drop "$DUMP_DIR" --quiet

# 3. Clean up dump
rm -rf "$DUMP_DIR"

# 4. Run incremental embed
echo "Running embed pipeline..."
cd "$HIVE_DIR"
npx tsx scripts/dodi-embed.ts

echo "=== sync-dodi: done at $(date) ==="
