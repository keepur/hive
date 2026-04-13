# Agent `homeBase` Field — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Author:** Mokie (with Claude)

## Summary

Add an explicit `homeBase` channel field to agent definitions so the scheduler and any agent-to-agent delivery paths have a reliable, per-agent home channel — instead of inferring one from `channels.find(ch => ch.startsWith("agent-"))`, which only works in workspaces that follow the DodiHome `agent-<id>` naming convention.

## Motivation

`src/scheduler/scheduler.ts:229` currently picks an agent's delivery channel with:

```ts
const homeChannel = agent?.channels.find((ch) => ch.startsWith("agent-")) ?? `agent-${job.agentId}`;
```

This assumes every Hive instance names agent channels as `agent-<agent-id>` — specifically, that the channel suffix matches the agent ID. DodiHome satisfies this (agent id `jasper` → channel `agent-jasper`). The personal instance does not: agent IDs are role-based (`vp-engineering`, `client-experience`) while channel names are persona-based (`remy`, `jordan-pierce`). The first branch of the fallback (`channels.find(ch => ch.startsWith("agent-"))`) only matches when the agent definition happens to include an `agent-` prefixed channel at all; the second branch (`\`agent-${job.agentId}\``) then constructs a channel that has never existed. Both branches are wrong on personal. Errors observed in `/Users/mokie/services/hive/logs-personal/hive.err`:

```
Failed to post message  channel: "agent-vp-engineering"  error: channel_not_found
Failed to post message  channel: "agent-client-experience"  error: channel_not_found
Failed to post message  channel: "agent-marketing-copywriter"  error: channel_not_found
Failed to post message  channel: "agent-product-strategist"  error: channel_not_found
```

This bug will hit every future customer instance that doesn't adopt the DodiHome naming convention. We need an instance-agnostic way to declare "this is where this agent lives."

## Non-Goals

- **Generalizing to non-Slack delivery** (SMS, WS). The scheduler only delivers via Slack today, and no adapter has asked for scheduled delivery. Slack-only now, renamable later.
- **Tightening the type to `homeBase: string` (required)**. Deferred to a follow-up PR after all instances have booted with the migration. The rollout stays non-blocking.
- **Fixing per-agent identity posting** (Slack `chat:write.customize` scope, fallback at `slack-gateway.ts:380`). Unrelated concern — agents posting via Slack MCP still appear as the bot app, not as individual agents. Separate issue.

## Design

### Field

Add to `AgentDefinition` (`src/types/agent-definition.ts`) and mirror in `AgentConfig` (`src/types/agent-config.ts`):

```ts
homeBase?: string; // Primary Slack channel for scheduler delivery and default identity
```

- **Optional in the type** so existing code compiles and the boot migration can backfill.
- **Required at the creation boundary.** `admin-mcp-server.ts#agent_create` validates that `fields.homeBase` is a non-empty string; returns `isError` if missing.
- Passed through in `toAgentConfig()`.

### Scheduler changes (`src/scheduler/scheduler.ts`)

**Line 229** (scheduled task dispatch):

```ts
// Before
const homeChannel = agent?.channels.find((ch) => ch.startsWith("agent-")) ?? `agent-${job.agentId}`;

// After
const homeChannel = agent?.homeBase ?? agent?.channels?.[0];
if (!homeChannel) {
  log.error("Cannot dispatch scheduled task — agent has no homeBase or channels", {
    agentId: job.agentId,
    task: job.task,
  });
  continue;
}
```

Behavior change: if `homeBase` is unset AND `channels[]` is empty, the scheduler **skips the job and logs an error** instead of silently posting to a nonexistent channel. This is strictly safer than today's behavior.

**Line 385** (event bus delivery — cosmetic):

```ts
// Before
source: {
  kind: "internal" as ChannelKind,
  id: `agent-${delivery.agentId}`,
  label: `agent-${delivery.agentId}`,
},

// After
const targetAgent = this.registry.get(delivery.agentId);
const homeBase = targetAgent?.homeBase ?? `agent-${delivery.agentId}`;
source: {
  kind: "internal" as ChannelKind,
  id: homeBase,
  label: homeBase,
},
```

`kind` stays `"internal"` — this doesn't hit Slack, it's just what shows up in logs/traces. Consistency fix only.

### Admin MCP (`src/admin/admin-mcp-server.ts`)

`agent_create`: read `f.homeBase` into the new doc, validate non-empty before insert:

```ts
if (typeof f.homeBase !== "string" || f.homeBase.trim() === "") {
  return {
    content: [{ type: "text", text: `Missing required field: homeBase (primary Slack channel for the agent)` }],
    isError: true,
  };
}
// ...
const doc: AgentDefinition = {
  // ...
  homeBase: f.homeBase.trim(),
  // ...
};
```

`agent_update` is a generic `$set` passthrough — no change needed; `homeBase` flows through as part of `fields`.

### Seeds

**`plugins/dodi/agent-seeds/*.yaml`** (9 files) — add `homeBase: agent-<agent-id>` to each, matching current DodiHome convention:

| File | homeBase |
|---|---|
| `vp-engineering.yaml` | `agent-vp-engineering` |
| `devops.yaml` | `agent-devops` |
| `product-manager.yaml` | `agent-product-manager` |
| `marketing-manager.yaml` | `agent-marketing-manager` |
| `customer-success.yaml` | `agent-customer-success` |
| `executive-assistant.yaml` | `agent-executive-assistant` |
| `product-specialist.yaml` | `agent-product-specialist` |
| `production-support.yaml` | `agent-production-support` |
| `sdr.yaml` | `agent-sdr` |

**`agents-personal/*/agent.yaml`** (5 files) — add `homeBase: <actual-channel>` per agent. Verified against the live `hive_personal.agent_definitions` collection as of 2026-04-12:

| Agent ID | channels in DB | homeBase |
|---|---|---|
| chief-of-staff | `agent-mokie, mokie-huang, all-keepur` | `mokie-huang` |
| vp-engineering | `remy, dev` | `remy` |
| product-strategist | `alex-chen, product` | `alex-chen` |
| marketing-copywriter | `lizzy-sommers` | `lizzy-sommers` |
| client-experience | `jordan-pierce` | `jordan-pierce` |

**Note on chief-of-staff:** The DB has three channels; `#mokie-huang` is the real home (it's where Mokie actually replies to May in practice), and `#agent-mokie` is legacy/unused. Setting `homeBase` explicitly here changes behavior — today the scheduler picks `agent-mokie` (first match on `agent-*`), after this change scheduled tasks land in `#mokie-huang`. This is the intended correction. The two superseded channels stay in the `channels` array for inbound routing, but scheduled delivery moves.

**Implementation note:** Before committing seed edits, reconfirm each channel against the live DB (`mongosh hive_personal --eval 'db.agent_definitions.find({}, {_id:1, channels:1}).toArray()'`) — the YAML seeds and DB records may drift (personal is DB-native; YAMLs are seed-only and have drifted before).

### Migration infrastructure

**New directory:** `src/migrations/`

**`src/migrations/run-migrations.ts`** — idempotent boot-time runner. Establishes the pattern for all future one-off DB migrations.

- Reads from a new `migrations` collection in the active Hive DB (`hive_<instance-id>`). Each instance's DB gets its own `migrations` collection, so multi-instance deployments on a shared Mongo are isolated by default. Each run inserts a doc: `{ _id: <migration-id>, ranAt: Date, notes?: string }`. No indexes needed — Mongo auto-creates the collection on first insert, and the default `_id` index suffices for the "has this migration run?" lookup.
- Registry of migrations is a simple ordered array in this file. On boot, iterate: for each migration whose `_id` is not in the collection, run it, then insert the marker.
- Migrations must be idempotent by design — if a boot is interrupted partway through one, re-running it on next boot must not corrupt data.

**`src/migrations/001-backfill-home-base.ts`** — first migration:

```ts
export const migration001 = {
  id: "001-backfill-home-base",
  async run(db: Db, log: Logger) {
    const agentDefs = db.collection<AgentDefinition>("agent_definitions");
    const cursor = agentDefs.find({ homeBase: { $exists: false } });
    let updated = 0;
    let skipped = 0;
    for await (const doc of cursor) {
      // Preserve the legacy DodiHome heuristic for existing records.
      // Going forward, `homeBase` is required at agent_create and set explicitly.
      const homeBase =
        doc.channels?.find((ch) => ch.startsWith("agent-")) ??
        doc.channels?.[0];
      if (!homeBase) {
        log.warn("Cannot backfill homeBase — no channels", { agentId: doc._id });
        skipped++;
        continue;
      }
      await agentDefs.updateOne({ _id: doc._id }, { $set: { homeBase } });
      updated++;
    }
    log.info("Backfill complete", { updated, skipped });
  },
};
```

Heuristic priority:
1. First channel starting with `agent-` (preserves DodiHome convention)
2. Else `channels[0]` (fine for personal, where `channels` is typically a single entry like `alex-chen`)
3. Else log a warning and leave unset (shouldn't happen, but don't crash)

**`src/index.ts`** — call `await runMigrations(db)` after Mongo connection established, before `AgentRegistry` loads. Migration failure is fatal — log and exit — because downstream code may depend on the migrated shape.

### Tests

- **`src/scheduler/scheduler.test.ts`** (extend if exists, create if not)
  - Dispatches using `homeBase` when set
  - Falls back to `channels[0]` when `homeBase` unset
  - Skips + logs error when both are missing (and doesn't throw)

- **`src/admin/admin-mcp-server.test.ts`** (extend or new)
  - `agent_create` rejects missing/empty `homeBase` with `isError`
  - `agent_create` accepts and persists valid `homeBase`
  - `agent_update` `$set` passthrough updates `homeBase` on an existing record (cheap insurance for the "no change needed" claim)

- **`src/migrations/001-backfill-home-base.test.ts`** (new)
  - Backfills DodiHome-style (`agent-jasper`) correctly
  - Backfills personal-style (`alex-chen`) correctly
  - Skips docs that already have `homeBase` set
  - Handles docs with empty `channels` without throwing (logs warn)
  - Idempotent — running twice is a no-op

- **`src/migrations/run-migrations.test.ts`** (new)
  - Runs migrations in order
  - Skips migrations already recorded in the `migrations` collection
  - Records marker after successful run
  - Does not record marker if migration throws

## File Touches

| File | Type | Notes |
|---|---|---|
| `src/types/agent-definition.ts` | modify | Add `homeBase?: string` + `toAgentConfig` passthrough |
| `src/types/agent-config.ts` | modify | Add `homeBase?: string` |
| `src/scheduler/scheduler.ts` | modify | Use `homeBase` at :229 and :385, skip-on-missing guard |
| `src/admin/admin-mcp-server.ts` | modify | Validate + accept `homeBase` in `agent_create` |
| `src/migrations/run-migrations.ts` | **new** | Idempotent runner + registry |
| `src/migrations/001-backfill-home-base.ts` | **new** | Backfill logic |
| `src/index.ts` | modify | Call `runMigrations()` before registry init |
| `src/scheduler/scheduler.test.ts` | modify or new | Scheduler test cases |
| `src/admin/admin-mcp-server.test.ts` | modify or new | `agent_create` validation + `agent_update` passthrough |
| `src/migrations/001-backfill-home-base.test.ts` | **new** | Migration tests |
| `src/migrations/run-migrations.test.ts` | **new** | Runner tests |
| `plugins/dodi/agent-seeds/*.yaml` | modify × 9 | Add `homeBase` |
| `agents-personal/*/agent.yaml` | modify × 5 | Add `homeBase` |

**Total:** 14 files modified, 4 files new, 1 new directory (`src/migrations/`).

## Rollout

1. Merge PR. CI runs `npm run check` on the self-hosted runner.
2. Dev restarts pick up the migration automatically on next boot (both dodi and personal instances).
3. Deploy dirs (`~/services/hive`, `~/services/hive-personal`) run migration on next `deploy.sh` restart.
4. Customer instances run migration on their next deploy pull — zero manual intervention.
5. After one week of clean runs, follow-up PR can tighten `homeBase` to required in the type.

## Risks

- **Migration corrupts a record.** Mitigation: migration only writes `homeBase`, never touches other fields, and is a single-field `$set`. Rollback is trivial (`$unset` the field).
- **Boot migration failure blocks startup.** Mitigation: fatal-by-design is the right call — downstream code may assume migrations have run. If a migration is broken, hotfix + redeploy is the escape hatch.
- **Customer instance has an agent with an empty `channels` array.** Migration logs a warning and skips; `agent_create` going forward requires `homeBase`, so this can only happen to legacy records. Scheduler's new skip-on-missing guard means the worst case is "scheduled tasks don't fire for that agent," not a crash.
