#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Deploy check — per-instance version compare against npm
# =============================================================================
#
# Reads each instance's pinned tag from instances.conf. For each instance whose
# installed version (from .hive/package.json) differs from the tag it's pinned to,
# invokes deploy.sh --instance=<id> --tag=<tag>.
#
# Pinned "latest" compares against the npm `latest` dist-tag — so unpinned
# instances autoupgrade whenever a new @keepur/hive is published.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$HOME/build/hive}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/services/hive}"
INSTANCES_CONF="$SCRIPT_DIR/instances.conf"

cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }

echo "Checking for updates on deploy branch..."
git fetch origin deploy --quiet

# --- Load instances ---
declare -a INSTANCES=()
while IFS='|' read -r id config _agents _label logs_dir ports engine_tag; do
  [[ "$id" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$id" ]] && continue
  id=$(echo "$id" | xargs)
  engine_tag=$(echo "${engine_tag:-}" | xargs)
  INSTANCES+=("$id|${engine_tag:-latest}")
done < "$INSTANCES_CONF"

UPDATES_NEEDED=()
for inst in "${INSTANCES[@]}"; do
  IFS='|' read -r id tag <<< "$inst"
  version="${tag#v}"
  # Per-instance root: $DEPLOY_DIR/<id> if it exists (post-Phase-5 layout),
  # else $DEPLOY_DIR (today's shared-dir primary layout).
  if [[ -d "$DEPLOY_DIR/$id" ]]; then
    instance_root="$DEPLOY_DIR/$id"
  else
    instance_root="$DEPLOY_DIR"
  fi
  installed=$(jq -r .version < "$instance_root/.hive/package.json" 2>/dev/null || echo "unknown")
  if [[ "$version" == "latest" ]]; then
    target=$(npm view @keepur/hive version 2>/dev/null || echo "unknown")
  else
    target=$(npm view "@keepur/hive@$version" version 2>/dev/null || echo "unknown")
  fi
  if [[ "$target" == "unknown" ]]; then
    echo "  [$id] could not resolve target version (pinned: $tag). Skipping."
    continue
  fi
  if [[ "$installed" == "$target" ]]; then
    echo "  [$id] up to date ($installed)."
  else
    echo "  [$id] $installed → $target (pinned: $tag)"
    UPDATES_NEEDED+=("$id|$target")
  fi
done

if [[ ${#UPDATES_NEEDED[@]} -eq 0 ]]; then
  echo "All instances up to date. Nothing to deploy."
  exit 0
fi

echo ""
echo "Updates needed:"
for u in "${UPDATES_NEEDED[@]}"; do
  IFS='|' read -r id target <<< "$u"
  echo "  - $id → $target"
done

# Deploy each one. deploy.sh handles build once per invocation, so we loop.
# Rationale for one-at-a-time: build-phase is shared, but the build is cheap
# to re-run and keeping it inside deploy.sh keeps one script responsible for
# the full flow. If this becomes a performance issue, split build into a
# separate phase invoked once up front.
for u in "${UPDATES_NEEDED[@]}"; do
  IFS='|' read -r id target <<< "$u"
  echo ""
  echo "=== Deploying $id → $target ==="
  "$SCRIPT_DIR/deploy.sh" --instance="$id" --tag="$target"
done
