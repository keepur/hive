# Continuous Deployment Pipeline for Hive

## Overview

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
| `~/services/hive` | Production deploy directory, kept clean |

### Execution Flow

```
1. Record current deployed SHA (for rollback)
2. Pull latest in ~/build/hive
3. npm install (full deps for checks + build)
4. npm run check (typecheck + lint + format + test)
   → Fail: post failure to #devops, abort
5. npm run build
   → Fail: post failure to #devops, abort
6. Pull latest in ~/services/hive
7. npm install --omit=dev
8. Backup dist/ → dist.bak/ in deploy dir
9. Rsync dist/ from build dir to deploy dir
10. npm run setup:agents in build dir
11. Rsync agents/ from build dir to deploy dir
12. Restart launchd service (com.hive.agent)
13. Health check (wait 3s, check logs for "Hive is running")
    → Fail: trigger rollback
14. Post success to #devops (commit SHA, message)
15. Remove dist.bak/
```

### Rollback Procedure

Triggered automatically when the health check fails after deploy:

1. Restore `dist.bak/` → `dist/`
2. `git checkout <previous-sha>` in deploy dir
3. Restart launchd service
4. Health check the rollback
5. Post rollback status to `#devops`

Single-level rollback (previous version only). The `dist.bak/` directory is created before each deploy and cleaned up on success.

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
> Deploy aborted. `npm run check` failed in `<step>`. No changes applied.

**Deploy failure + rollback:**
> Deploy failed (health check). Rolled back to `<previous-sha>`. Hive is running on previous version.

**Rollback failure:**
> Deploy failed AND rollback failed. Manual intervention required. Previous SHA: `<sha>`.

## One-Time Setup

1. Create `~/build/hive` — `git clone https://github.com/bot-dodi/hive.git ~/build/hive`
2. Create `deploy` branch — `git checkout -b deploy && git push -u origin deploy`
3. Generate dedicated SSH keypair — `ssh-keygen -t ed25519 -f ~/.ssh/hive-deploy -N ""`
4. Add public key to `~mokie/.ssh/authorized_keys` on the Mac Mini
5. Configure GitHub secrets (`SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`)
6. Ensure Mokie's agent config includes `#devops` channel
7. Set `deploy` branch as protected in GitHub (require PR, require approval)

## Security Considerations

- Deploy key is dedicated and scoped — not a personal SSH key
- SSH key stored in GitHub Actions encrypted secrets
- Mac Mini SSH access limited to key-based auth
- `deploy` branch protected — requires PR approval
- Deploy script uses `set -euo pipefail` — fails fast on errors
- No shell injection risk — deploy script uses fixed paths, no user input
- Slack bot token sourced from `.env` on the Mac Mini (not in GitHub secrets)
