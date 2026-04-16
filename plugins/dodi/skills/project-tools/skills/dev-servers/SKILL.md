---
name: dev-servers
description: "Boot dodi_v2 dev servers (ops, sysadmin). Supports profiles: dev (ports 3001-3002) and test (ports 3101-3102, QA database). Pass 'test' as argument for test profile."
agents:
  - vp-engineering
---

# Start Dev Servers

Boot sysadmin and ops servers. Supports two profiles:

| Profile | Ports | Default MongoDB |
|---------|-------|-----------------|
| **Dev** (default) | 3001, 3002 | `mongodb://localhost:27017/master` |
| **Test** | 3101, 3102 | `mongodb://localhost:27017/qa` |

## Workflow

### 1. Determine Profile

Check if the user passed an argument (e.g., `/dev-servers test`).

- If the argument is `test` or `qa`, use the **Test** profile.
- Otherwise (no argument, or `dev`), use the **Dev** profile.

Set variables based on profile:

**Dev profile:**
- `PORT_SYSADMIN=3001`, `PORT_OPS=3002`
- `DEFAULT_MONGO=mongodb://localhost:27017/master`

**Test profile:**
- `PORT_SYSADMIN=3101`, `PORT_OPS=3102`
- `DEFAULT_MONGO=mongodb://localhost:27017/qa`

### 2. Determine the Working Directory

List all git worktrees to find available checkouts:

```bash
git worktree list
```

This returns lines like:
```
/Users/mayhuang/dev/master/dodi_v2                  abc1234 [master]
/Users/mayhuang/dev/master/dodi_v2-performance2     def5678 [performance2]
/Users/mayhuang/dev/master/dodi_v2-feat-something   ghi9012 [feat/something]
```

**If there is only one worktree**, use it as `REPO_ROOT`.

**If there are multiple worktrees**, use **AskUserQuestion** to ask which one. Build the options dynamically from the worktree list — show the directory basename and branch name for each. Example options:
- `dodi_v2 [master]`
- `dodi_v2-performance2 [performance2]`

Use the selected worktree's full path as `REPO_ROOT`.

### 3. Ask for MONGO_URL

Use **AskUserQuestion** to ask (can be combined with the worktree question above into a single AskUserQuestion call with multiple questions):

> Which MongoDB should both servers connect to?

Options (adjust default based on profile):
- **Local (profile default)** — `${DEFAULT_MONGO}` (show the actual URL)
- **Production** — `mongodb+srv://blues:keepur2019@production.mjswk.mongodb.net/production`

The user may also type a custom connection string.

Store the answer as `MONGO_URL`.

### 4. Find Free Ports

Before starting servers, check if the profile's default ports are available. Run this check for both ports:

```bash
lsof -i :${PORT_SYSADMIN} -t 2>/dev/null && echo "TAKEN" || echo "FREE"
lsof -i :${PORT_OPS} -t 2>/dev/null && echo "TAKEN" || echo "FREE"
```

Run both checks in parallel (single message, two Bash calls).

**If either port is taken**, increment **both** ports by 10 (to keep them as a pair) and check again. Repeat until both ports are free.

Example progression for dev profile:
- Try 3001/3002 → 3001 taken → try 3011/3012 → both free → use 3011/3012

Example progression for test profile:
- Try 3101/3102 → 3102 taken → try 3111/3112 → both free → use 3111/3112

Update `PORT_SYSADMIN` and `PORT_OPS` to the free ports found.

If ports were changed from the defaults, inform the user:
```
Ports 3001/3002 are in use. Using 3011/3012 instead.
```

### 5. Start Both Servers

Launch both as **background** Bash commands (using `run_in_background: true`). Each command must:
- `cd` into the correct app directory
- Run `npm install` first (copies shared `@dodihome/*` and `@dodi/*` packages into `node_modules/` via the postinstall script — required for worktrees and after any shared package changes)
- Set `MONGO_URL` from step 3
- Set `USE_ATLAS_SEARCH=true` (required for ops and sysadmin when pointing at Atlas)
- For **test profile only**: Set `SUPPRESS_EMAILS=true` to prevent real emails from being sent during integration tests
- Run `meteor` with the app's settings file and the profile's port

**Sysadmin** (port `${PORT_SYSADMIN}`):
```bash
cd ${REPO_ROOT}/src/apps/sysadmin && npm install && MONGO_URL="${MONGO_URL}" USE_ATLAS_SEARCH=true ${SUPPRESS_EMAILS_ENV} meteor --settings private/dev.json --port ${PORT_SYSADMIN}
```

**Ops** (port `${PORT_OPS}`):
```bash
cd ${REPO_ROOT}/src/apps/ops && npm install && MONGO_URL="${MONGO_URL}" USE_ATLAS_SEARCH=true ${SUPPRESS_EMAILS_ENV} meteor --settings private/dev.json --port ${PORT_OPS}
```

Where `SUPPRESS_EMAILS_ENV` is:
- Test profile: `SUPPRESS_EMAILS=true`
- Dev profile: empty (no suppression)

Launch both in a single message (2 parallel background Bash calls).

### 6. Report Status

After launching, tell the user:

```
[Profile] servers starting against: <MONGO_URL>

  Sysadmin: http://localhost:<PORT_SYSADMIN> (building...)
  Ops:      http://localhost:<PORT_OPS>      (building...)

First build takes ~60-90 seconds. Use TaskOutput to check progress.
```

## Troubleshooting

If an app crashes with module resolution errors (e.g., `Cannot find module '../lightningcss.darwin-arm64.node'` or similar native binary issues), the `.meteor/local` cache is likely corrupted. Fix with:

```bash
cd ${REPO_ROOT}/src/apps/<app> && npm run clean
```

This deletes `.meteor/local` and `node_modules`, then reinstalls. Restart the app after.

## Notes

- Meteor caches builds per app. First run in a worktree is slow; subsequent runs are fast.
- If `USE_ATLAS_SEARCH=true` is set with a local MongoDB, Atlas search features gracefully degrade — no harm done.
- Ops serves both internal (ops) users and external (customer) users since the portal consolidation.
- Both apps share the same MongoDB and authentication system.
- Use `/dev-servers test` to boot test servers on ports 3101-3102 against the QA database.
