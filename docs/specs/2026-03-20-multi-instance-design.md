# Multi-Instance Hive — Design Spec

**Date**: 2026-03-20
**Status**: Draft

## Problem

Hive has multiple customers who each need their own instance on the same machine. Currently, several resources are hardcoded with single-instance assumptions:

- Temp directories (`/tmp/hive-code-tasks`, `/tmp/hive-bg-tasks`) would collide
- LaunchAgent labels (`com.hive.agent`) can only register once
- Ports are spread across two groups (31xx, 32xx) with no per-instance scheme
- Database name (`hive`) is shared
- Deploy and install scripts assume one instance

The goal: a clean setup experience where each Hive instance gets an ID, and everything derives from that ID — ports, paths, database, service labels.

## Design

### Instance Identity

Each Hive instance has an **instance ID** — a short lowercase string (e.g., `dodi`, `personal`, `acme`). This ID is the single source of truth. Everything else derives from it.

The ID is stored in `hive.yaml`:

```yaml
instance:
  id: dodi
  portBase: 3100   # this instance owns ports 3100-3199
```

### Port Scheme

Each instance gets a 100-port block. The first instance uses 31xx, the second 32xx, and so on.

| Offset | Service | Current Default | Instance "dodi" (31xx) | Instance "personal" (32xx) |
|--------|---------|-----------------|------------------------|----------------------------|
| +0 | Background tasks | 3100 | 3100 | 3200 |
| +1 | Recall monitor | 3101 | 3101 | 3201 |
| +2 | Code task manager | 3102 | 3102 | 3202 |
| +3 | WebSocket (mobile) | 3200 → moves to +3 | 3103 | 3203 |

Ports 4-99 are reserved for future use.

**Breaking change**: WS port moves from 3200 to `portBase + 3`. For the existing DodiHome instance, this means 3103. The Cloudflare tunnel for `shop.dodihome.com` must be updated to point to `localhost:3103` instead of `localhost:3200`.

### Derived Values

Everything derives from `instance.id` and `instance.portBase` in `hive.yaml`:

| Resource | Pattern | Example (id=dodi, portBase=3100) |
|----------|---------|----------------------------------|
| MongoDB database | `hive_<id>` | `hive_dodi` |
| Background task port | `portBase + 0` | 3100 |
| Recall monitor port | `portBase + 1` | 3101 |
| Code task manager port | `portBase + 2` | 3102 |
| WebSocket port | `portBase + 3` | 3103 |
| Tmp dir (code tasks) | `/tmp/<id>-code-tasks` | `/tmp/dodi-code-tasks` |
| Tmp dir (bg tasks) | `/tmp/<id>-bg-tasks` | `/tmp/dodi-bg-tasks` |
| LaunchAgent label | `com.hive.<id>.agent` | `com.hive.dodi.agent` |
| LaunchAgent (logs) | `com.hive.<id>.rotate-logs` | `com.hive.dodi.rotate-logs` |
| LaunchAgent (deploy) | `com.hive.<id>.deploy-check` | `com.hive.dodi.deploy-check` |
| Deploy dir | `~/services/<id>` | `~/services/dodi` |
| Log dir | `~/services/<id>/logs` | `~/services/dodi/logs` |

### Setup Flow

A new `npm run setup` interactive script handles first-time instance configuration:

```
$ npm run setup

Welcome to Hive Setup.

Instance ID (lowercase, no spaces — e.g., "dodi", "personal"): dodi
Port base (100-port block — e.g., 3100, 3200, 3300): 3100

Instance configuration:
  ID:          dodi
  Database:    hive_dodi
  Ports:       3100-3103 (bg, recall, code-task, ws)
  Tmp dirs:    /tmp/dodi-code-tasks, /tmp/dodi-bg-tasks
  Deploy dir:  ~/services/dodi
  LaunchAgent: com.hive.dodi.agent

Write to hive.yaml? [Y/n]: y
✓ Instance configured. Next steps:
  1. Edit .env with your Slack tokens and API keys
  2. npm run setup:agents    — generate agent configs
  3. npm run setup:plist     — generate LaunchAgent plists
  4. service/install.sh      — install and start service

Note: Each Hive instance needs its own Slack app.
Create one at https://api.slack.com/apps and add the tokens to .env:
  SLACK_APP_TOKEN=xapp-...
  SLACK_BOT_TOKEN=xoxb-...
```

If `hive.yaml` already has an `instance` section, the script shows current values and asks to confirm or change.

### Build Directory

All instances share a single build directory (`~/build/hive`). The build process is instance-agnostic — it compiles source and runs checks. Only the deploy step (rsync to `~/services/<id>`) is instance-specific.

`deploy-check.sh` needs the instance's deploy dir. It already reads `DEPLOY_DIR` from env — the generated plist sets this per instance.

### Deploy Script

`deploy.sh` is instance-aware via two mechanisms:

1. `DEPLOY_DIR` env var (already exists, default changes to `~/services/<id>`)
2. Port cleanup derives ports from the deploy dir's `hive.yaml` portBase

```bash
# deploy.sh changes:
# 1. DEPLOY_DIR default reads instance.id from hive.yaml
# 2. kill_stale_ports() reads portBase, kills portBase+0 through portBase+3
# 3. launchctl uses com.hive.<id>.agent label
# 4. rollback() uses the same derived label
```

### Config Loading

`config.ts` reads the instance section from `hive.yaml` and derives all values:

```typescript
// New: instance identity — read early, used to derive defaults below
const instanceId = (hive.instance?.id as string) ?? "hive";
const portBase = (hive.instance?.portBase as number) ?? 3100;

export const config = {
  instance: { id: instanceId, portBase },

  // Changed: ports derive from portBase (env vars still override)
  background: {
    port: parseInt(optional("BG_TASK_PORT", String(portBase + 0)), 10),
    authToken: optional("BG_TASK_AUTH_TOKEN", "") || randomUUID(),
  },
  recall: {
    // ...
    monitorPort: parseInt(optional("MEETING_MONITOR_PORT", String(portBase + 1)), 10),
  },
  codeTask: {
    port: parseInt(optional("CODE_TASK_PORT", String(portBase + 2)), 10),
    // ... rest unchanged
  },
  ws: {
    // ...
    port: parseInt(optional("WS_PORT", String(portBase + 3)), 10),
  },

  // Changed: database name uses underscore separator (dots not allowed in MongoDB db names)
  mongo: {
    uri: optional("MONGODB_URI", "mongodb://localhost:27017"),
    dbName: optional("MONGODB_DB", `hive_${instanceId}`),
  },

  // New: task directories derive from instance ID
  tasksDir: {
    code: optional("CODE_TASKS_DIR", `/tmp/${instanceId}-code-tasks`),
    background: optional("BG_TASKS_DIR", `/tmp/${instanceId}-bg-tasks`),
  },

  // ... everything else unchanged
};
```

**Safety**: When `instance.id` is not set, it defaults to `"hive"`, making `dbName` = `hive_hive` and ports = 31xx. This is intentionally different from the current `hive` database name — it forces the instance config to be set explicitly during migration rather than silently connecting to the old database with new code. See Migration section.

Env vars still override any individual value. The instance config provides smart defaults so `.env` stays minimal.

### Task Managers

Both task managers accept their tmp dir as a constructor parameter instead of hardcoding.

**CodeTaskManager** — add `tasksDir` parameter:
```typescript
// Before: const TASKS_DIR = "/tmp/hive-code-tasks";
// After:
constructor(
  port: number,
  authToken: string,
  pluginDir: string,
  maxConcurrent: number,
  tasksDir: string,            // new — replaces hardcoded constant
  onComplete: (item: WorkItem) => void,
  options?: CodeTaskManagerOptions,
)
```

**BackgroundTaskManager** — add `tasksDir` parameter:
```typescript
// Before: const TASKS_DIR = "/tmp/hive-bg-tasks";
// After:
constructor(
  port: number,
  authToken: string,
  tasksDir: string,            // new — replaces hardcoded constant
  onComplete: (item: WorkItem) => void,
)
```

**index.ts** call sites updated to pass `config.tasksDir.code` and `config.tasksDir.background`.

### Plist Generation

`generate-plist.ts` reads instance ID from `hive.yaml` (same loader as config.ts):

```typescript
// Before:
const LABEL = "com.hive.agent";

// After:
const instanceId = hiveConfig.instance?.id ?? "hive";
const LABEL = `com.hive.${instanceId}.agent`;
const LABEL_LOGS = `com.hive.${instanceId}.rotate-logs`;
const LABEL_DEPLOY = `com.hive.${instanceId}.deploy-check`;
```

Both the label constants AND the output filenames change together (e.g., `service/com.hive.dodi.agent.plist`). `install.sh` must read the same instance ID from `hive.yaml` so its label variables match the generated filenames.

## Files Changed

### Modified

| File | Change |
|------|--------|
| `src/config.ts` | Add `instance` section, derive ports from portBase, derive dbName (`hive_<id>`) and tasksDirs from ID |
| `src/code-task/code-task-manager.ts` | Accept `tasksDir` as constructor param (after `maxConcurrent`, before `onComplete`) |
| `src/background/background-task-manager.ts` | Accept `tasksDir` as constructor param (after `authToken`, before `onComplete`) |
| `src/index.ts` | Pass `config.tasksDir.code` and `config.tasksDir.background` to task manager constructors |
| `src/contacts/import-hubspot.ts` | Use `config.mongo.dbName` instead of hardcoded `"hive"` fallback |
| `setup/generate-plist.ts` | Read instance ID from `hive.yaml`, use for labels and output filenames |
| `service/install.sh` | Read instance ID from `hive.yaml`, derive labels, deploy dir defaults to `~/services/<id>` |
| `service/deploy.sh` | Deploy dir defaults to `~/services/<id>`, `kill_stale_ports()` kills portBase+0 through portBase+3, launchctl uses `com.hive.<id>.agent` label |
| `service/deploy-check.sh` | Deploy dir defaults to `~/services/<id>` (plist env already injects correct `DEPLOY_DIR`) |

### New

| File | Purpose |
|------|---------|
| `setup/setup-instance.ts` | Interactive first-time setup — prompts for ID and port base, writes to hive.yaml |

### Unchanged

| File | Why |
|------|-----|
| `setup/generate-agents.ts` | Already reads hive.yaml, no instance-specific logic needed |
| `src/plugins/plugin-loader.ts` | Instance-agnostic |
| Agent templates | Instance-agnostic |

### Low-priority cleanup (not blocking)

| File | Issue |
|------|-------|
| `src/background/background-task-mcp-server.ts` | Hardcoded `http://127.0.0.1:3100` fallback — harmless since agent-runner always injects the correct `BG_TASK_API` env var, but should match portBase for consistency |
| `src/code-task/code-task-mcp-server.ts` | Same — hardcoded `http://127.0.0.1:3102` fallback |

## Migration

### Existing DodiHome instance

**Order matters.** Steps 1-3 happen while Hive is stopped. Step 4 updates the tunnel. Step 5 restarts with new config.

1. **Stop Hive:**
   ```bash
   launchctl bootout "gui/$(id -u)/com.hive.agent"
   ```

2. **Add instance config** to `hive.yaml` (both dev and deploy):
   ```yaml
   instance:
     id: dodi
     portBase: 3100
   ```

3. **Rename MongoDB database** (`hive` → `hive_dodi`):
   ```javascript
   // mongosh
   const cols = ["memory", "memory_versions", "agent_sessions", "model_overrides",
     "agent_config_overrides", "devices", "agent_callbacks", "contacts",
     "prompt_overrides", "schedule_overrides"];
   for (const c of cols) {
     db.adminCommand({ renameCollection: `hive.${c}`, to: `hive_dodi.${c}` });
   }
   // Verify:
   use hive_dodi; show collections;
   // Then drop the empty old database:
   use hive; db.dropDatabase();
   ```

4. **Update Cloudflare tunnel** before restarting Hive (avoids iOS app downtime window):
   - `shop.dodihome.com` → `localhost:3103` (WS moves from 3200 to portBase+3)

5. **Deploy new code and restart:**
   ```bash
   # Build and deploy as normal, then:
   npm run setup:plist        # generates com.hive.dodi.agent.plist etc.
   service/install.sh         # installs new-label plists, starts service
   ```

6. **Clean up old plists** (install.sh won't remove these automatically):
   ```bash
   launchctl bootout "gui/$(id -u)/com.hive.rotate-logs" 2>/dev/null || true
   launchctl bootout "gui/$(id -u)/com.hive.deploy-check" 2>/dev/null || true
   rm -f ~/Library/LaunchAgents/com.hive.agent.plist
   rm -f ~/Library/LaunchAgents/com.hive.rotate-logs.plist
   rm -f ~/Library/LaunchAgents/com.hive.deploy-check.plist
   ```

### New customer instance

1. Clone repo
2. `npm run setup` — enter instance ID and port base
3. Edit `.env` with Slack tokens and API keys
4. `npm run setup:agents`
5. `npm run setup:plist`
6. `service/install.sh`

## Verification

1. **Two instances running**: Start "dodi" (portBase 3100) and "personal" (portBase 3200) on the same machine. Both register LaunchAgents, both respond to their Slack apps, no port or tmp dir collisions.
2. **Deploy**: `deploy.sh` deploys to correct `~/services/<id>` dir, restarts correct LaunchAgent, kills ports portBase+0 through portBase+3.
3. **Database isolation**: Each instance writes to its own MongoDB database (`hive_dodi`, `hive_personal`).
4. **Database rename**: After migration, `hive` database no longer exists, `hive_dodi` has all collections with correct data.
5. **No-config safety**: If someone runs new code without setting `instance.id`, the database defaults to `hive_hive` (not the old `hive`) — fails visibly rather than silently connecting to the wrong database.
