#!/usr/bin/env bash
# Create standard labels on the hive GitHub repo.
# Usage: GITHUB_REPO=owner/repo bash setup/create-github-labels.sh

set -euo pipefail

REPO="${GITHUB_REPO:?Set GITHUB_REPO=owner/repo}"

create_label() {
  local name="$1" desc="$2" color="$3"
  if gh label create "$name" --repo "$REPO" --description "$desc" --color "$color" 2>/dev/null; then
    echo "  Created: $name"
  else
    echo "  Exists:  $name"
  fi
}

echo "Creating labels on $REPO..."
create_label "team:engineering" "Engineering work" "1d76db"
create_label "team:marketing"   "Marketing work"   "5319e7"
create_label "type:bug"         "Bug report"        "d73a4a"
create_label "type:feature"     "New feature"       "0e8a16"
create_label "type:task"        "General task"       "ededed"
create_label "priority:high"    "High priority"     "e99695"
create_label "priority:low"     "Low priority"      "fbca04"
echo "Done."
