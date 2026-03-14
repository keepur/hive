---
name: deploy
description: Push main to deploy branch with pre-flight checks. Does NOT run deploy.sh — that happens on the deploy machine.
---

# Deploy

Push new commits from `main` to `deploy` branch.

## Process

1. **Pre-flight:**
   - Ensure on `main` branch (switch if needed)
   - `git pull` to get latest
   - Verify `main` is ahead of `deploy` (if not, nothing to deploy)
   - Run `npm run check` and `npm run build`

2. **Summarize:**
   - Show commits going from `deploy` to `main`
   - Note current deploy HEAD (rollback point)

3. **Confirm:** Ask user before pushing.

4. **Push:**
   - `git checkout deploy && git merge --ff-only main && git push`
   - Switch back to `main`

5. **Remind:** Tell user to run `deploy.sh` on the deploy machine, or that it will pick up changes on next restart.
