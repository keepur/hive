# CD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automated deployment of Hive via GitHub Actions — PR merge to `deploy` branch triggers SSH deploy to Mac Mini with checks, rollback, and Slack notification via Mokie.

**Architecture:** GitHub Actions workflow SSHs into the Mac Mini and runs an enhanced `service/deploy.sh`. The script builds in `~/build/hive`, deploys to `~/services/hive`, posts status to `#devops` in Slack. Mokie monitors `#devops` and DMs the user.

**Tech Stack:** GitHub Actions, bash, SSH (appleboy/ssh-action), Slack Web API, launchd

**Spec:** `docs/superpowers/specs/2026-03-12-cd-pipeline-design.md`

---

## Chunk 1: Deploy Script and GitHub Actions Workflow

### File Structure

| File | Action | Responsibility |
|---|---|---|
| `service/deploy.sh` | Rewrite | Full deploy pipeline: pull, check, build, agents, backup, rsync, restart, health check, rollback, notify |
| `.github/workflows/deploy.yml` | Create | GitHub Actions workflow — triggers on push to `deploy`, SSHs into Mac Mini |
| `agents-templates/chief-of-staff/agent.yaml.tpl` | Modify | Add `devops` to Mokie's `passiveChannels` |

---

### Task 1: Rewrite `service/deploy.sh`

**Files:**
- Rewrite: `service/deploy.sh`

- [ ] **Step 1: Write the new deploy script**

Replace the contents of `service/deploy.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Configuration ---
BUILD_DIR="$HOME/build/hive"
DEPLOY_DIR="$HOME/services/hive"

# Source .env from deploy dir for SLACK_BOT_TOKEN and DEVOPS_CHANNEL_ID
# shellcheck source=/dev/null
source "$DEPLOY_DIR/.env"
: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN not set in .env}"
: "${DEVOPS_CHANNEL_ID:?DEVOPS_CHANNEL_ID not set in .env}"

# --- Helper: Slack notification ---
notify() {
  local message="$1"
  local payload
  payload=$(jq -n --arg channel "$DEVOPS_CHANNEL_ID" --arg text "$message" \
    '{channel: $channel, text: $text}')
  curl -s -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    > /dev/null
}

# --- Helper: Health check with retry ---
health_check() {
  local log_file="$DEPLOY_DIR/logs/hive.log"
  for i in $(seq 1 10); do
    sleep 1
    if tail -5 "$log_file" | grep -q '"Hive is running"'; then
      return 0
    fi
  done
  return 1
}

# --- Helper: Rollback ---
rollback() {
  local prev_sha="$1"
  echo "Rolling back..."

  if [[ -d "$DEPLOY_DIR/dist.bak" ]]; then
    rm -rf "$DEPLOY_DIR/dist"
    mv "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/dist"
  fi

  if [[ -d "$DEPLOY_DIR/agents.bak" ]]; then
    rm -rf "$DEPLOY_DIR/agents"
    mv "$DEPLOY_DIR/agents.bak" "$DEPLOY_DIR/agents"
  fi

  echo "Restarting service with previous version..."
  launchctl kickstart -k "gui/$(id -u)/com.hive.agent"

  if health_check; then
    notify "Deploy failed (health check). Rolled back to \`$prev_sha\`. Hive is running on previous version."
    echo "Rollback succeeded."
  else
    notify "Deploy failed AND rollback failed. Manual intervention required. Previous SHA: \`$prev_sha\`."
    echo "CRITICAL: Rollback failed. Manual intervention required."
  fi
  exit 1
}

# --- Main ---
echo "=== Hive Deploy ==="

# 1. Record current deployed SHA
cd "$DEPLOY_DIR"
PREV_SHA=$(git rev-parse --short HEAD)
echo "Current deployed SHA: $PREV_SHA"

# 2. Pull latest in build dir
echo "Pulling latest in build dir..."
cd "$BUILD_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Build dir not on deploy branch"; exit 1; }
git pull --ff-only

DEPLOY_SHA=$(git rev-parse --short HEAD)
DEPLOY_MSG=$(git log -1 --pretty=%s)

# 3. Install full deps (for checks + build)
echo "Installing dependencies..."
npm install

# 4. Run checks
echo "Running checks..."
if ! npm run check; then
  notify "Deploy aborted. \`npm run check\` failed. No changes applied. Commit: \`$DEPLOY_SHA\`."
  echo "Checks failed. Deploy aborted."
  exit 1
fi

# 5. Build
echo "Building..."
if ! npm run build; then
  notify "Deploy aborted. Build failed. No changes applied. Commit: \`$DEPLOY_SHA\`."
  echo "Build failed. Deploy aborted."
  exit 1
fi

# 6. Generate agents
echo "Generating agents..."
npm run setup:agents

# 7. Prepare deploy dir
echo "Preparing deploy dir..."
cd "$DEPLOY_DIR"
[[ "$(git branch --show-current)" == "deploy" ]] || { echo "ERROR: Deploy dir not on deploy branch"; exit 1; }
git pull --ff-only
npm install --omit=dev

# 8. Backup current dist and agents
rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak"
cp -a "$DEPLOY_DIR/dist" "$DEPLOY_DIR/dist.bak" 2>/dev/null || true
cp -a "$DEPLOY_DIR/agents" "$DEPLOY_DIR/agents.bak" 2>/dev/null || true

# 9. Rsync built artifacts
echo "Syncing build output..."
rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"
rsync -a --delete "$BUILD_DIR/agents/" "$DEPLOY_DIR/agents/"

# 10. Restart service
echo "Restarting service..."
launchctl kickstart -k "gui/$(id -u)/com.hive.agent"

# 11. Health check
echo "Checking health..."
if ! health_check; then
  echo "Health check failed. Triggering rollback..."
  rollback "$PREV_SHA"
fi

# 12. Success
notify "Deploy succeeded. Commit \`$DEPLOY_SHA\`: $DEPLOY_MSG. Hive is running."
echo "Deploy complete. Hive is running."

# 13. Cleanup backups
rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak"
```

- [ ] **Step 2: Verify script syntax**

Run: `bash -n service/deploy.sh`
Expected: No output (no syntax errors)

- [ ] **Step 3: Commit**

```bash
git add service/deploy.sh
git commit -m "feat: rewrite deploy.sh with checks, rollback, and Slack notification"
```

---

### Task 2: Create GitHub Actions workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Deploy Hive

on:
  push:
    branches:
      - deploy

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy to Mac Mini
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script_stop: true
          command_timeout: 10m
          script: |
            ~/services/hive/service/deploy.sh
```

Note: `script_stop: true` ensures the action fails if the deploy script exits non-zero. `command_timeout: 10m` prevents hangs (checks + build + deploy should complete well within this).

- [ ] **Step 2: Verify YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"`
Expected: No output (valid YAML)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: add GitHub Actions deploy workflow — SSH to Mac Mini on push to deploy"
```

---

### Task 3: Add `#devops` to Mokie's passive channels

**Files:**
- Modify: `agents-templates/chief-of-staff/agent.yaml.tpl:8-11`

- [ ] **Step 1: Add devops to passiveChannels**

In `agents-templates/chief-of-staff/agent.yaml.tpl`, add `devops` to the `passiveChannels` list:

```yaml
passiveChannels:
  - marketing
  - biz
  - devops
```

- [ ] **Step 2: Regenerate agents**

Run: `npm run setup:agents`
Expected: Agents regenerated without errors

- [ ] **Step 3: Verify the generated agent config includes devops**

Run: `grep -A 5 passiveChannels agents/chief-of-staff/agent.yaml`
Expected: `devops` appears in the passiveChannels list

- [ ] **Step 4: Commit**

```bash
git add agents-templates/chief-of-staff/agent.yaml.tpl
git commit -m "feat: add #devops to Mokie's passive channels for deploy notifications"
```

---

## Chunk 2: One-Time Setup (Manual Steps)

These are manual steps to be performed on the Mac Mini and in GitHub. They are documented here as a runbook, not automated tasks.

### Task 4: Create deploy branch

- [ ] **Step 1: Create and push the deploy branch**

```bash
git checkout main
git checkout -b deploy
git push -u origin deploy
git checkout main
```

- [ ] **Step 2: Protect the deploy branch in GitHub**

Go to GitHub → Settings → Branches → Add branch protection rule:
- Branch name pattern: `deploy`
- Require a pull request before merging: checked
- Require approvals: 1
- Do not allow bypassing the above settings

---

### Task 5: Set up build directory on Mac Mini

- [ ] **Step 1: SSH into the Mac Mini**

```bash
ssh mokie@ssh-hive.dodihome.com
```

- [ ] **Step 2: Clone the build directory**

```bash
git clone git@github.com:bot-dodi/hive.git ~/build/hive
cd ~/build/hive
git checkout deploy
```

- [ ] **Step 3: Symlink instance config**

```bash
ln -s ~/services/hive/hive.yaml ~/build/hive/hive.yaml
ln -s ~/services/hive/.env ~/build/hive/.env
```

- [ ] **Step 4: Verify symlinks work**

```bash
cat ~/build/hive/hive.yaml | head -3
cat ~/build/hive/.env | head -3
```

Expected: Shows the first few lines of each config file

---

### Task 6: Set up SSH deploy key

- [ ] **Step 1: Generate keypair on the Mac Mini**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/hive-deploy -N "" -C "hive-deploy-key"
```

- [ ] **Step 2: Add public key to authorized_keys**

```bash
cat ~/.ssh/hive-deploy.pub >> ~/.ssh/authorized_keys
```

- [ ] **Step 3: Copy the private key (for GitHub)**

```bash
cat ~/.ssh/hive-deploy
```

Copy this output — it goes into the GitHub secret.

- [ ] **Step 4: Configure GitHub secrets**

Go to GitHub → Settings → Secrets and variables → Actions → New repository secret:
- `SSH_PRIVATE_KEY`: paste the private key from step 3
- `SSH_USER`: `mokie`
- `SSH_HOST`: `ssh-hive.dodihome.com`

---

### Task 7: Add `DEVOPS_CHANNEL_ID` to `.env`

- [ ] **Step 1: Find the #devops channel ID in Slack**

In Slack, right-click `#devops` → "View channel details" → copy the Channel ID (starts with `C`).

- [ ] **Step 2: Add to `.env` on the Mac Mini**

```bash
echo 'DEVOPS_CHANNEL_ID=C_REPLACE_ME' >> ~/services/hive/.env
```

Replace `C_REPLACE_ME` with the actual channel ID.

---

### Task 8: End-to-end verification

- [ ] **Step 1: Test the deploy script manually on the Mac Mini**

```bash
ssh mokie@ssh-hive.dodihome.com
~/services/hive/service/deploy.sh
```

Expected: Script runs through all steps, posts success to `#devops`, Mokie DMs you.

- [ ] **Step 2: Test the full pipeline via GitHub**

Create a PR from `main` → `deploy`, approve and merge. Watch GitHub Actions for the deploy job. Verify:
- Job succeeds in GitHub Actions UI
- `#devops` gets a success message
- Mokie DMs you with the deploy outcome
- Hive is running on the new version

- [ ] **Step 3: Test rollback (optional but recommended)**

Temporarily break the build (e.g., syntax error), push to deploy, verify:
- Deploy script detects failure
- Rollback restores previous version
- `#devops` gets a rollback message
- Mokie DMs you about the failure
