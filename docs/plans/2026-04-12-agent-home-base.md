# Agent `homeBase` Field Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add explicit `homeBase` channel field to agent definitions so scheduler and event bus have a reliable per-agent primary channel, replacing the brittle `agent-<id>` heuristic.

**Architecture:** New optional `homeBase` on `AgentDefinition`/`AgentConfig`, required at `agent_create` boundary. Scheduler reads it at dispatch time (skip-on-missing). New `src/migrations/` directory with idempotent boot-time runner and a `001-backfill-home-base` migration that fills `homeBase` on existing DB records using the legacy heuristic.

**Tech Stack:** TypeScript, MongoDB, vitest.

**Spec:** `docs/specs/2026-04-12-agent-home-base-design.md`

**Notes on scope deviation from spec:**
- Spec lists editing `agents-personal/*/agent.yaml` — no such files exist in this repo. Personal is DB-native and the boot migration handles backfill at runtime. Skipping personal YAML edits.
- Dodi seed YAMLs are still in `plugins/dodi/agent-seeds/` and do get `homeBase` added.

---

## File Structure

| File | Type | Responsibility |
|---|---|---|
| `src/types/agent-definition.ts` | modify | Add `homeBase?: string`, pass through in `toAgentConfig` |
| `src/types/agent-config.ts` | modify | Add `homeBase?: string` |
| `src/scheduler/scheduler.ts` | modify | Use `homeBase` at :229 and :385, skip-on-missing guard |
| `src/admin/admin-mcp-server.ts` | modify | Validate + accept `homeBase` in `agent_create` |
| `src/migrations/run-migrations.ts` | **new** | Idempotent runner + registry, `migrations` collection marker |
| `src/migrations/001-backfill-home-base.ts` | **new** | Backfill `homeBase` on existing agent_definitions |
| `src/migrations/run-migrations.test.ts` | **new** | Runner tests |
| `src/migrations/001-backfill-home-base.test.ts` | **new** | Backfill migration tests |
| `src/index.ts` | modify | Call `runMigrations(db)` before `registry.load()` |
| `src/scheduler/scheduler.test.ts` | **new** | Scheduler dispatch channel selection tests |
| `src/admin/admin-mcp-server.test.ts` | **new** | `agent_create` validation + `agent_update` passthrough |
| `plugins/dodi/agent-seeds/*.yaml` (9) | modify | Add `homeBase: agent-<id>` |

---

## Task 1: Add `homeBase` to types

**Files:**
- Modify: `src/types/agent-definition.ts`
- Modify: `src/types/agent-config.ts`

- [ ] **Step 1:** Add `homeBase?: string` to `AgentDefinition` in `src/types/agent-definition.ts`, just below `channels: string[]` in the Routing block.

```ts
  // Routing
  channels: string[];
  homeBase?: string; // Primary channel for scheduler delivery; required at agent_create boundary
  passiveChannels: string[];
```

- [ ] **Step 2:** Pass through in `toAgentConfig` (same file) — add after the `channels` line:

```ts
    channels: doc.channels ?? [],
    homeBase: doc.homeBase,
```

- [ ] **Step 3:** Add `homeBase?: string` to `AgentConfig` in `src/types/agent-config.ts`, just below `channels: string[]`:

```ts
  channels: string[];
  homeBase?: string;
```

- [ ] **Step 4:** Verify typecheck.

Run: `npm run typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 5:** Commit.

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts
git commit -m "feat(types): add optional homeBase channel to agent definition"
```

---

## Task 2: Migration infrastructure

**Files:**
- Create: `src/migrations/run-migrations.ts`
- Create: `src/migrations/001-backfill-home-base.ts`

- [ ] **Step 1:** Create `src/migrations/001-backfill-home-base.ts`.

```ts
import type { Db } from "mongodb";
import type { Logger } from "../logging/logger.js";
import type { AgentDefinition } from "../types/agent-definition.js";

export const migration001BackfillHomeBase = {
  id: "001-backfill-home-base",
  async run(db: Db, log: Logger): Promise<void> {
    const agentDefs = db.collection<AgentDefinition>("agent_definitions");
    const cursor = agentDefs.find({ homeBase: { $exists: false } });
    let updated = 0;
    let skipped = 0;
    for await (const doc of cursor) {
      const homeBase =
        doc.channels?.find((ch) => ch.startsWith("agent-")) ?? doc.channels?.[0];
      if (!homeBase) {
        log.warn("Cannot backfill homeBase — no channels", { agentId: doc._id });
        skipped++;
        continue;
      }
      await agentDefs.updateOne({ _id: doc._id }, { $set: { homeBase } });
      updated++;
    }
    log.info("Backfill complete", { migration: "001-backfill-home-base", updated, skipped });
  },
};
```

- [ ] **Step 2:** Create `src/migrations/run-migrations.ts`.

```ts
import type { Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { migration001BackfillHomeBase } from "./001-backfill-home-base.js";

const log = createLogger("migrations");

export interface Migration {
  id: string;
  run(db: Db, log: ReturnType<typeof createLogger>): Promise<void>;
}

interface MigrationRecord {
  _id: string;
  ranAt: Date;
  notes?: string;
}

export const MIGRATIONS: Migration[] = [migration001BackfillHomeBase];

export async function runMigrations(db: Db, registry: Migration[] = MIGRATIONS): Promise<void> {
  const coll = db.collection<MigrationRecord>("migrations");
  for (const migration of registry) {
    const existing = await coll.findOne({ _id: migration.id });
    if (existing) {
      log.debug("Migration already applied, skipping", { id: migration.id });
      continue;
    }
    log.info("Running migration", { id: migration.id });
    await migration.run(db, log);
    await coll.insertOne({ _id: migration.id, ranAt: new Date() });
    log.info("Migration applied", { id: migration.id });
  }
}
```

Migration semantics:
- Marker only inserted on successful `run()` — a throw leaves the migration un-marked so the next boot retries.
- Migrations must be idempotent (matches existing pattern of `$exists: false` filter in 001).
- Runner throws on error — `src/index.ts` treats it as fatal.

- [ ] **Step 3:** Verify typecheck.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4:** Commit.

```bash
git add src/migrations/run-migrations.ts src/migrations/001-backfill-home-base.ts
git commit -m "feat(migrations): add idempotent boot-time runner + backfill homeBase"
```

---

## Task 3: Wire migration runner into boot

**Files:**
- Modify: `src/index.ts` (around line 48, after `agentDefsCollection` indexes, before `registry.load()` at line 95)

- [ ] **Step 1:** Add import at the top of `src/index.ts` (alongside existing imports):

```ts
import { runMigrations } from "./migrations/run-migrations.js";
```

- [ ] **Step 2:** After the `agent_definitions` collection indexes are created (around line 50) and before the `registry = new AgentRegistry(...)` block (line 91), add:

```ts
  // Run DB migrations (fatal on failure — downstream code depends on migrated shape)
  await runMigrations(db);
```

- [ ] **Step 3:** Verify boot still typechecks.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4:** Commit.

```bash
git add src/index.ts
git commit -m "feat(boot): run DB migrations before agent registry load"
```

---

## Task 4: Scheduler uses `homeBase`

**Files:**
- Modify: `src/scheduler/scheduler.ts:229` and `:385`

- [ ] **Step 1:** Replace the `homeChannel` selection at line 229 with:

```ts
        const homeChannel = agent?.homeBase ?? agent?.channels?.[0];
        if (!homeChannel) {
          log.error("Cannot dispatch scheduled task — agent has no homeBase or channels", {
            agentId: job.agentId,
            task: job.task,
          });
          continue;
        }
```

Remove the old comment `// Use agent-{id} channel (dedicated), not channels[0] which may be SMS/shared`.

- [ ] **Step 2:** Replace the event bus `source` block at lines ~383-387 with:

```ts
        const targetHomeBase = agent.homeBase ?? `agent-${delivery.agentId}`;
        const workItem: WorkItem = {
          id: `event:${eventId}:${delivery.agentId}`,
          text: `[Event: ${event.type} from ${sourceName}]\n\n${JSON.stringify(event.payload)}`,
          source: {
            kind: "internal" as ChannelKind,
            id: targetHomeBase,
            label: targetHomeBase,
          },
```

(Note: `agent` is already in scope at that point via `this.registry.get(delivery.agentId)` at line ~353.)

- [ ] **Step 3:** Verify typecheck.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4:** Commit.

```bash
git add src/scheduler/scheduler.ts
git commit -m "fix(scheduler): use agent.homeBase for delivery, skip when missing"
```

---

## Task 5: Admin MCP validates `homeBase` on create

**Files:**
- Modify: `src/admin/admin-mcp-server.ts:153-196`

- [ ] **Step 1:** Immediately after the `existing` check in `agent_create` (line ~160), add the validation:

```ts
    const f = fields ?? {};
    if (typeof f.homeBase !== "string" || (f.homeBase as string).trim() === "") {
      return {
        content: [
          {
            type: "text",
            text: `Missing required field: homeBase (primary channel for scheduled delivery, e.g. 'agent-${_id}').`,
          },
        ],
        isError: true,
      };
    }
```

Remove the now-duplicate `const f = fields ?? {};` below.

- [ ] **Step 2:** Add `homeBase` into the `doc` object (alongside `channels`):

```ts
      channels: (f.channels as string[]) ?? [],
      homeBase: (f.homeBase as string).trim(),
      passiveChannels: ...
```

- [ ] **Step 3:** Verify typecheck.

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4:** Commit.

```bash
git add src/admin/admin-mcp-server.ts
git commit -m "feat(admin): require homeBase on agent_create"
```

---

## Task 6: Dodi seed YAMLs

**Files:** `plugins/dodi/agent-seeds/*.yaml` (9 files)

- [ ] **Step 1:** For each seed, insert `homeBase: agent-<id>` on the line immediately after `channels:` block closes (i.e., as a sibling top-level key, placed right before `passiveChannels:` for consistency).

| File | Add line |
|---|---|
| `vp-engineering.yaml` | `homeBase: agent-vp-engineering` |
| `devops.yaml` | `homeBase: agent-devops` |
| `product-manager.yaml` | `homeBase: agent-product-manager` |
| `marketing-manager.yaml` | `homeBase: agent-marketing-manager` |
| `customer-success.yaml` | `homeBase: agent-customer-success` |
| `executive-assistant.yaml` | `homeBase: agent-executive-assistant` |
| `product-specialist.yaml` | `homeBase: agent-product-specialist` |
| `production-support.yaml` | `homeBase: agent-production-support` |
| `sdr.yaml` | `homeBase: agent-sdr` |

- [ ] **Step 2:** Verify `npm run setup:seeds` is still a no-op (agents already exist in DB, seeds skip).

Run: `git diff --stat plugins/dodi/agent-seeds/`
Expected: 9 files, 9 insertions.

- [ ] **Step 3:** Commit.

```bash
git add plugins/dodi/agent-seeds/
git commit -m "feat(seeds): set homeBase on dodi agent seeds"
```

---

## Task 7: Migration tests

**Files:**
- Create: `src/migrations/001-backfill-home-base.test.ts`
- Create: `src/migrations/run-migrations.test.ts`

- [ ] **Step 1:** Create `src/migrations/001-backfill-home-base.test.ts`. Use an in-memory Mongo (`mongodb-memory-server` if already a devDep — check `package.json`; otherwise mock via a minimal stub that supports `find`, `updateOne`, `insertOne`, `findOne`). Prefer the real pattern used by `src/schedule/schedule-mcp-server.test.ts` — read it first to match conventions.

Test cases:
- Doc with `channels: ["agent-jasper", "general"]` → `homeBase` set to `"agent-jasper"`.
- Doc with `channels: ["alex-chen", "product"]` → `homeBase` set to `"alex-chen"`.
- Doc with `homeBase: "mokie-huang"` already set → untouched.
- Doc with `channels: []` → no update, warn logged (no throw).
- Running migration twice → second run is a no-op (second pass finds 0 matching `homeBase: { $exists: false }`).

- [ ] **Step 2:** Create `src/migrations/run-migrations.test.ts`.

Test cases:
- Runs migrations in order of the provided registry.
- Skips a migration whose `_id` is already present in the `migrations` collection.
- Inserts marker `{ _id, ranAt }` after successful `run()`.
- Does **not** insert marker if `run()` throws; error propagates.

- [ ] **Step 3:** Run the new tests.

Run: `npx vitest run src/migrations`
Expected: all tests pass.

- [ ] **Step 4:** Commit.

```bash
git add src/migrations/
git commit -m "test(migrations): cover runner + backfill-home-base"
```

---

## Task 8: Scheduler + admin tests

**Files:**
- Create: `src/scheduler/scheduler.test.ts`
- Create: `src/admin/admin-mcp-server.test.ts`

- [ ] **Step 1:** Read `src/admin/admin-api.test.ts` and `src/schedule/schedule-mcp-server.test.ts` to mirror setup/teardown conventions (mock registry, mock MongoDB, etc.).

- [ ] **Step 2:** Create `src/scheduler/scheduler.test.ts` covering `checkCronJobs()` channel selection. Because `checkCronJobs` is private, test via the public `onDispatch` callback: construct a `Scheduler` with a stub `AgentRegistry` and stub `AgentManager`, inject a fake `cronJobs` via the schedule-reload path, fire `checkCronJobs` indirectly, assert the captured `WorkItem.source.id`.

Test cases:
- Agent with `homeBase: "mokie-huang"` → dispatched `WorkItem.source.id === "mokie-huang"`.
- Agent with `homeBase` unset but `channels: ["general", "ops"]` → `source.id === "general"`.
- Agent with no `homeBase` and `channels: []` → no dispatch, error logged, no throw.

- [ ] **Step 3:** Create `src/admin/admin-mcp-server.test.ts` covering `agent_create` + `agent_update`:

- `agent_create` without `homeBase` → `isError: true`, text mentions `homeBase`.
- `agent_create` with empty-string `homeBase` → `isError: true`.
- `agent_create` with `homeBase: "  agent-foo  "` → inserts doc with `homeBase: "agent-foo"` (trimmed).
- `agent_update` with `fields: { homeBase: "new-channel" }` → `$set` passthrough updates the record.

- [ ] **Step 4:** Run the new tests.

Run: `npx vitest run src/scheduler src/admin`
Expected: all tests pass.

- [ ] **Step 5:** Commit.

```bash
git add src/scheduler/scheduler.test.ts src/admin/admin-mcp-server.test.ts
git commit -m "test: scheduler homeBase dispatch + admin agent_create validation"
```

---

## Task 9: Full quality gate

- [ ] **Step 1:** Run the full check suite.

Run: `npm run check`
Expected: typecheck, lint, format, and all tests pass.

- [ ] **Step 2:** If any failures, fix and re-run before proceeding to review/submit.

---

## Rollout Notes

- No manual DB surgery required on any instance. First boot after deploy runs migration 001, which backfills `homeBase` per the legacy heuristic (matches current behavior on dodi, incorrect on personal).
- **Personal instance will still be wrong after migration** for agents whose `agent-<id>` channel doesn't actually exist. Operator follow-up: after deploy, run a one-shot update via admin MCP or direct Mongo to set correct personal `homeBase` values per the spec table (e.g., `chief-of-staff → mokie-huang`, `vp-engineering → remy`, etc.). This is intentional — the migration is conservative and non-breaking; explicit correction is a human decision.
- **Dodi instance verification:** the backfill runs the legacy heuristic against whatever is in the live DB, which may not match the seed `homeBase` values added in Task 6 (seeds have drifted before). After deploy, verify each dodi agent's post-migration `homeBase` against the seed table and correct via `agent_update` if any diverge. Most at risk: any dodi agent whose live DB `channels` array doesn't contain an `agent-<id>` entry.
- **Known gap — empty-string `homeBase` via `agent_update`:** `agent_update` is a generic `$set` passthrough and will happily write `homeBase: ""`, which the scheduler treats as missing (skip + error log). Acceptable per spec ("no change needed" for `agent_update`). Follow-up PR that tightens `homeBase` to required in the type can also add an `agent_update` guard.
- Follow-up PR (out of scope here): tighten `homeBase` to required in the type once all instances have run the migration.
