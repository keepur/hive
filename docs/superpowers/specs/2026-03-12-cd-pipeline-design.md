# Continuous Deployment Pipeline for Hive

## Overview

> **Superseded:** The push-based GitHub Actions approach was replaced by a pull-based deploy checker. See `docs/superpowers/specs/2026-03-13-deploy-checker-design.md`.

Automated deployment pipeline for Hive using GitHub Actions and SSH. Merging a PR from `main` into a `deploy` branch triggers a remote deploy to the Mac Mini, with pre-deploy checks, automatic rollback on failure, and notifications via Mokie.

## Branch Strategy

- `main` — development integration branch (unchanged)
- `deploy` — production branch, always reflects what's running on the Mac Mini
- Normal workflow: feature branches → PR to `main`
- Deployment workflow: PR from `main` → `deploy` (PR approval is the human gate)
- GitHub Actions triggers on `push` to `deploy` (fires when the PR merges)

## Pipeline Architecture

```
GitHub (push to deploy branch)
  → GitHub Actions workflow
  → SSH into Mac Mini (mokie@ssh-hive.dodihome.com)
  → Enhanced deploy script
  → Notification to #devops → Mokie DMs user
```

### GitHub Actions Workflow

File: `.github/workflows/deploy.yml`

- **Trigger:** `on: push` to `deploy` branch
- **Concurrency:** `concurrency: { group: deploy, cancel-in-progress: false }` — prevents parallel deploys; a second push queues behind the first
- **Single job** using `appleboy/ssh-action`
- SSHs into Mac Mini and executes the deploy script

### GitHub Secrets

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | Dedicated deploy keypair (not a personal key) |
| `SSH_USER` | `mokie` |
| `SSH_HOST` | `ssh-hive.dodihome.com` |

## Deploy Script

Location: `service/deploy.sh` (enhanced version)

### Directories

| Directory | Purpose |
|---|---|
| `~/build/hive` | Dedicated build clone, never used for development |
| `~/services/hive` | Production deploy directory, kept clean — receives only built artifacts |

### Instance Config

The build directory (`~/build/hive`) needs access to instance-specific config for agent generation. During one-time setup, symlink from the deploy dir:
- `ln -s ~/services/hive/hive.yaml ~/build/hive/hive.yaml`
- `ln -s ~/services/hive/.env ~/build/hive/.env`

This ensures `npm run setup:agents` and other config-dependent operations use the production instance config.

### Execution Flow

```
1. Record current deployed SHA from ~/services/hive (for rollback)
2. cd ~/build/hive && git pull --ff-only
3. npm install (full deps for checks + build)
4. npm run check (typecheck + lint + format + test)
   → Fail: post failure to #devops, abort
5. npm run build
   → Fail: post failure to #devops, abort
6. npm run setup:agents (in build dir, uses symlinked hive.yaml)
7. In ~/services/hive:
   a. git pull --ff-only (deploy dir tracks deploy branch)
   b. npm install --omit=dev
   c. Backup dist/ → dist.bak/
   d. Backup agents/ → agents.bak/
8. Rsync dist/ from build dir to deploy dir
9. Rsync agents/ from build dir to deploy dir
10. Restart launchd service (com.hive.agent)
11. Health check (retry every 1s for up to 10s, check logs for "Hive is running")
    → Fail: trigger rollback
12. Post success to #devops (commit SHA, message)
13. Remove dist.bak/ and agents.bak/
```

### Slack Notification Details

The deploy script sources the deploy dir's `.env` to get `SLACK_BOT_TOKEN`, then uses `curl` to call the Slack `chat.postMessage` API to post to `#devops`. Example:

```bash
source ~/services/hive/.env
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$DEVOPS_CHANNEL_ID\", \"text\": \"$MESSAGE\"}"
```

`DEVOPS_CHANNEL_ID` is the Slack channel ID for `#devops` (e.g., `C01234ABCDE`). Store in `.env` alongside other config.

### Rollback Procedure

Triggered automatically when the health check fails after deploy:

1. Restore `dist.bak/` → `dist/`
2. Restore `agents.bak/` → `agents/`
3. Restart launchd service
4. Health check the rollback (same retry loop)
5. Post rollback status to `#devops`

Single-level rollback (previous version only). Backup directories are created before each deploy and cleaned up on success.

## Notification Flow

```
Deploy script
  → Posts structured message to #devops channel (via curl + SLACK_BOT_TOKEN)
  → Mokie monitors #devops
  → Mokie DMs the user with deploy outcome
```

### Message Format

**Success:**
> Deploy succeeded. Commit `<sha>`: `<message>`. Hive is running.

**Check failure:**
> Deploy aborted. `npm run check` failed. No changes applied.

**Deploy failure + rollback:**
> Deploy failed (health check). Rolled back to `<previous-sha>`. Hive is running on previous version.

**Rollback failure:**
> Deploy failed AND rollback failed. Manual intervention required. Previous SHA: `<sha>`.

## One-Time Setup

1. Create `~/build/hive` — `git clone https://github.com/bot-dodi/hive.git ~/build/hive && cd ~/build/hive && git checkout deploy`
2. Symlink instance config into build dir:
   - `ln -s ~/services/hive/hive.yaml ~/build/hive/hive.yaml`
   - `ln -s ~/services/hive/.env ~/build/hive/.env`
3. Create `deploy` branch — `git checkout -b deploy && git push -u origin deploy`
4. Generate dedicated SSH keypair — `ssh-keygen -t ed25519 -f ~/.ssh/hive-deploy -N ""`
5. Add public key to `~mokie/.ssh/authorized_keys` on the Mac Mini
6. Configure GitHub secrets (`SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`)
7. Ensure Mokie's agent config includes `#devops` channel
8. Set `deploy` branch as protected in GitHub (require PR, require approval)

## Security Considerations

- Deploy key is dedicated and scoped — not a personal SSH key
- SSH key stored in GitHub Actions encrypted secrets
- Mac Mini SSH access limited to key-based auth
- `deploy` branch protected — requires PR approval
- Deploy script uses `set -euo pipefail` — fails fast on errors
- No shell injection risk — deploy script uses fixed paths, no user input
- Slack bot token sourced from `.env` on the Mac Mini (not in GitHub secrets)
- Concurrency group prevents parallel deploys
