#!/usr/bin/env bash
# Sync the three public docs + install/bootstrap.sh from this repo into
# the public keepur/hive-docs checkout, then commit and push.
#
# Expects: $HIVE_DOCS_REPO (default ~/github/hive-docs) to be a clone of
# https://github.com/keepur/hive-docs on the main branch with a clean worktree.

set -euo pipefail

SRC_REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_REPO="${HIVE_DOCS_REPO:-$HOME/github/hive-docs}"

[[ -d "$DOCS_REPO/.git" ]] || { echo "hive-docs repo not found at $DOCS_REPO" >&2; exit 1; }

git -C "$DOCS_REPO" diff --quiet && git -C "$DOCS_REPO" diff --cached --quiet \
  || { echo "hive-docs worktree is dirty; commit or stash first" >&2; exit 1; }

git -C "$DOCS_REPO" checkout -q main
git -C "$DOCS_REPO" pull -q --ff-only

mkdir -p "$DOCS_REPO/docs" "$DOCS_REPO/install"
cp "$SRC_REPO/docs/getting-started.md"    "$DOCS_REPO/docs/"
cp "$SRC_REPO/docs/managing-your-hive.md" "$DOCS_REPO/docs/"
cp "$SRC_REPO/docs/troubleshooting.md"    "$DOCS_REPO/docs/"
cp "$SRC_REPO/install/bootstrap.sh"       "$DOCS_REPO/install/"
cp "$SRC_REPO/LICENSE"                    "$DOCS_REPO/LICENSE"
chmod +x "$DOCS_REPO/install/bootstrap.sh"

if git -C "$DOCS_REPO" diff --quiet; then
  echo "hive-docs already up to date."
  exit 0
fi

git -C "$DOCS_REPO" add docs install LICENSE
git -C "$DOCS_REPO" commit -q -m "Sync docs + bootstrap from hive@$(git -C "$SRC_REPO" rev-parse --short HEAD)"
git -C "$DOCS_REPO" push -q origin main
echo "Pushed to keepur/hive-docs."
