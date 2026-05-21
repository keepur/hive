#!/bin/bash
# Retired: hosted MongoDB is no longer a source for local dodi data.
#
# This file remains only because an older crontab may still call it. Keeping a
# harmless no-op here prevents that stale schedule from dumping hosted MongoDB
# back into local MongoDB while the crontab entry is being removed.

set -euo pipefail

echo "=== sync-dodi: retired at $(date) ==="
echo "Hosted MongoDB sync is disabled; local MongoDB is canonical."

