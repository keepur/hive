# Workflow Engine

- **Date**: 2026-04-07
- **Status**: Draft
- **Scope**: Extract shared workflow packages from dodi_v2, integrate into Hive

## Problem

Hive agents and humans collaborate in conversations — meetings, Slack threads, strategy sessions — and agree on plans of action. Today those plans evaporate. There's no way to:

- Turn a conversation into a structured set of tasks with owners and dependencies
- Track execution across agents and humans on equal footing
- Automatically unblock downstream work when predecessors complete
- Notify the right person (agent or human) through their channel when it's their turn

dodi_v2 already has a mature implementation of all of this — FSM engine, workflow rules, task dependencies, condition evaluation, even a react-flow visual editor. Rather than rewrite, we extract shared packages from dodi_v2 that both systems consume.

## What dodi_v2 Already Has

| Component | Status | Meteor Coupling | File |
|-----------|--------|----------------|------|
| SimpleFSM (flexible state machine) | Complete | None (lodash only) | `core/lib/states/simple-fsm.ts` |
| Strict FSM (explicit transitions) | Complete | None (lodash only) | `core/lib/states/fsm.ts` |
| FSMService (load FSM from DB) | Complete | Medium (collection access) | `core/lib/states/FSMService.ts` |
| FSM definitions model | Complete | Medium (Meteor Mongo.Collection) | `core/lib/models/fsm-definitions.ts` |
| FSMDefinitionCache | Complete | Low (collection read) | `system/api/fsm/FSMDefinitionCache.ts` |
| FSMCollectionRegistry | Complete | Medium (Meteor Mongo.Collection) | `system/api/fsm/FSMCollectionRegistry.ts` |
| WorkflowEngine | Complete | Medium (collection fetching) | `workflow/api/WorkflowEngine.ts` |
| ActionExecutor | Complete | Medium (withUserContext, tool registry) | `workflow/api/ActionExecutor.ts` |
| ConditionEvaluator | Complete | **None** | `workflow/api/ConditionEvaluator.ts` |
| WorkflowGraphBuilder | Complete | **None** | `workflow/api/WorkflowGraphBuilder.ts` |
| WorkflowRules model | Complete | Medium (Meteor Mongo.Collection) | `core/lib/models/workflow-rules.ts` |
| WorkflowExecutions model | Complete | Medium (Meteor Mongo.Collection) | `core/lib/models/workflow-executions.ts` |
| WorkflowSnapshots model | Complete | Medium (Meteor Mongo.Collection) | `core/lib/models/workflow-snapshots.ts` |
| EventDefinitions model | Complete | Medium (Meteor Mongo.Collection) | `core/lib/models/event-definitions.ts` |
| DodiEvents model | Complete | Medium (Meteor Mongo.Collection) | `core/lib/models/dodi-events.ts` |
| Task state machine + deps | Complete | High (TaskController + MongoDB) | `production/api/tasks/TaskController.ts` |
| Task dependency auto-unblock | Complete | High (embedded in TaskController) | `production/api/tasks/TaskController.ts` |
| react-flow FSM designer | Specced | Medium (useTracker for reactivity) | `ui-flow-editor/` module |
| Task board UI | Complete | High (useTracker, Meteor subscriptions) | `tasks/components/TaskBoard.tsx` |

### Key Interfaces (already framework-agnostic)

- `IFSMState`, `IFSMTransition`, `IFSMAction`, `IFSMDefinition` — FSM structure
- `IAction`, `IState`, `IStateTransition` — state machine primitives
- `IWorkflowRule`, `IWorkflowAction`, `IRuleConditions` — workflow automation
- `IWorkflowExecution` — audit trail
- `IDodiEvent`, `IStateChangePayload`, `ICreatedPayload` — event system
- `IEventDefinition` — event registry

## Design: Shared Package Extraction

### Package Structure

```
packages/
  @dodi/workflow-core/       # FSM + conditions + graph builder (pure logic, zero deps)
  @dodi/fsm-persistence/     # FSMService + cache + registry (DB-backed FSM management)
  @dodi/workflow-engine/     # WorkflowEngine + ActionExecutor (automation rules)
  @dodi/task-core/           # Task model, dependency resolution, states
```

### Package 1: `@dodi/workflow-core`

**Pure logic, zero framework dependencies.** This is the brain.

Contains:
- `SimpleFSM` — flexible state machine (from `core/lib/states/simple-fsm.ts`)
- `FSM` (strict) — explicit transition validation (from `core/lib/states/fsm.ts`)
- `ConditionEvaluator` — json-rules-engine wrapper (already clean)
- `WorkflowGraphBuilder` — dependency graph construction (already clean)
- All interfaces from `core/lib/interfaces/state.interfaces.ts` and `workflow.interfaces.ts`
- FSM definition types (`IFSMState`, `IFSMTransition`, `IFSMAction`, `IFSMDefinition`)

**Seams to cut:**
- Replace lodash usage in SimpleFSM with `Array.prototype.find/filter` (SimpleFSM uses `_.find` in three places — trivial replacement, avoids adding lodash as a dependency)
- **`IStatable` replacement**: dodi_v2's `IStatable` extends `Identifiable`, `IRequiresPermission`, and `ITrackable` — pulling in `_id`, `name`, `scope`, `permissionContext`, `createdBy`, etc. Replace with a minimal generic constraint: `interface IStateful { state: string }`. This propagates to `PermissionChecker`'s type signature — redefine it against the minimal type, not dodi_v2's `IStatable`.
- Extract `PermissionChecker` as an optional callback typed against `IStateful` (not `IStatable`)

**External dependencies:** `json-rules-engine`, optionally `lodash`

### Package 2: `@dodi/fsm-persistence`

**FSM infrastructure — load, cache, and manage FSM definitions from DB.**

Contains:
- `FSMService` — load FSM definitions, resolve conditions, construct FSM instances
- `FSMDefinitionCache` — in-memory write-through cache
- `FSMCollectionRegistry` — entity type → collection mapping
- Collection schemas for: `fsm_definitions`

Note: `FSMService` has a `conditionRegistry` for named guard functions. In dodi_v2, domain modules register conditions at startup. In Hive, the simple task FSM has no conditions. The extracted package exposes `registerCondition()` so dodi_v2 can continue its existing registration pattern post-migration.

**External dependencies:** `@dodi/workflow-core`

### Package 3: `@dodi/workflow-engine`

**Rule matching, execution orchestration, and audit.** This is the automation layer that fires workflow rules in response to events.

Contains:
- `WorkflowEngine` — rule matching and execution orchestration
- `ActionExecutor` — action invocation with pluggable execution context
- Collection schemas for: `workflow_rules`, `workflow_executions`, `workflow_snapshots`, `event_definitions`, `dodi_events`

**Note:** This package is NOT needed for Hive v1. The Hive MCP server only needs `@dodi/task-core` for task FSM and dependency resolution. `@dodi/workflow-engine` is a Phase 4 concern — wire it up when Hive needs automated workflow rules (e.g., "when deal is won, auto-create onboarding plan").

**Seams to cut (the big ones):**

1. **Collection access** — Replace `Meteor.Collection.findOneAsync()` calls with an injected `ICollectionAdapter` interface. This interface lives in `@dodi/fsm-persistence` (the lowest persistence-aware layer), re-exported by `@dodi/workflow-engine` and consumed by `@dodi/task-core`. It does NOT belong in `@dodi/workflow-core` — that package is pure logic with no DB concepts.

   ```typescript
   // In @dodi/fsm-persistence
   interface ICollectionAdapter<T> {
     findOne(filter: object): Promise<T | null>;
     find(filter: object, options?: FindOptions): Promise<T[]>;
     findOneAndUpdate(filter: object, update: object, options?: { returnDocument: 'before' | 'after' }): Promise<T | null>;
     insertOne(doc: T): Promise<string>;
     updateOne(filter: object, update: object): Promise<UpdateResult>;
     deleteOne(filter: object): Promise<DeleteResult>;
   }
   ```
   `FindOptions` must include `sort`, `limit`, `skip`, `projection` at minimum (WorkflowEngine uses `sort: { priority: 1 }` for rule ordering).

   Meteor adapter: wraps `Mongo.Collection` (note: Meteor's `find()` returns a cursor, adapter calls `.fetchAsync()` internally). Hive adapter: wraps native `mongodb` driver. Same interface, different drivers.

2. **withUserContext** — Replace with injected `IExecutionContext`:
   ```typescript
   interface IExecutionContext {
     userId: string;
     roles?: string[];
     runAs?: string;
   }
   ```
   Meteor implementation uses `DDPCommon.MethodInvocation`. Hive implementation passes `AGENT_ID` from env var.

3. **ControllerToolRegistry** — ActionExecutor currently calls dodi_v2's tool registry. Abstract to `IToolExecutor`:
   ```typescript
   interface IToolExecutor {
     execute(toolName: string, params: Record<string, unknown>, context: IExecutionContext): Promise<unknown>;
   }
   ```
   dodi_v2 adapter: wraps ControllerToolRegistry. Hive adapter: could map to MCP tool calls or direct function calls.

4. **Entity fetching** — WorkflowEngine.fetchEntity() uses dynamic imports to resolve entity collections. Replace with `IEntityResolver`:
   ```typescript
   interface IEntityResolver {
     resolve(entityType: string, entityId: string): Promise<Record<string, unknown> | null>;
   }
   ```

**External dependencies:** `json-rules-engine` (via workflow-core)

### Package 4: `@dodi/task-core`

**Task model, dependency resolution, state management.**

Contains:
- Task states enum (`blocked`, `todo`, `in_progress`, `done`, `cancelled`)
- Task interfaces (`ITask`, `ITaskDependency`)
- Dependency resolution algorithm — extracted from `TaskController.unblockDependents()`:
  ```typescript
  async function resolveDependencies(
    completedTaskId: string,
    planId: string,
    tasks: ICollectionAdapter<ITask>
  ): Promise<{ unblockedTaskIds: string[]; planCompleted: boolean }>
  ```
  The function needs `planId` to fetch all sibling tasks for the `planCompleted` check (all tasks terminal = plan done). Without it, the function can only evaluate direct dependents, not the full plan.
- Cycle detection (DFS on dependency graph — needed at plan creation time)
- Task type definitions and registry pattern (from `tasks/lib/interfaces.ts`, stripped of React/UI concerns)

**Seams to cut:**
- Extract `unblockDependents()` logic from TaskController into a pure function that takes a collection adapter
- **Critical modification**: dodi_v2's `unblockDependents` checks `every(t => t.state === 'DONE')` — only `done` counts. The extracted version must treat both `done` and `cancelled` as terminal for dependency purposes. This is an intentional behavior change, not a straight copy.
- **Atomic unblock**: Use `findOneAndUpdate` with `state: 'blocked'` filter (not the current read-then-write pattern in dodi_v2). Only the update that actually transitions `blocked → todo` returns a result; caller emits event only on successful transition. Prevents double-fire on concurrent predecessor completions.
- Strip React component types from task type definitions
- Strip `@dodihome/core` business object interfaces — use a simpler base type

**External dependencies:** `@dodi/workflow-core` (for FSM), `@dodi/fsm-persistence` (for `ICollectionAdapter`)

### Where Packages Live

**Option A: Separate repo** (`dodi-hq/dodi-workflow`) — clean boundary, versioned independently, npm-publishable.

**Option B: In dodi_v2 as a `packages/` directory** — easier extraction since the code is already there, but ties package releases to dodi_v2 deploys.

**Option C: In a shared `dodi-hq/dodi-packages` monorepo** — future-proof for other shared packages (not just workflow).

Recommendation: **Option A** for now — single repo with the three packages as workspaces. Simple, focused, independently versionable. If more shared packages emerge, consolidate into Option C later.

## Hive Integration

### Relationship to Existing `src/tasks/`

Hive already has a `src/tasks/` directory with three components:
- **`task-mcp-server.ts`** — MCP tools for agents to CRUD **dodi_v2 operations tasks** (jobs, fabrication, QA, etc.) via HTTP
- **`task-ledger.ts`** — auto-tracks invisible agent work (scheduled jobs, background tasks, meetings) in dodi_v2's task system. Fire-and-forget observability layer in the dispatcher pipeline.
- **`task-client.ts`** — shared HTTP client for dodi_v2's task API

These are all **thin HTTP wrappers around dodi_v2's task API** for operations work. They are intentionally separate from the workflow system. The new `src/workflow/` directory handles **internal agent/human coordination** — plans, dependencies, execution tracking — with data stored in Hive's own MongoDB.

### MCP Server: `workflow-mcp-server.ts`

New file: `src/workflow/workflow-mcp-server.ts`

Consumes `@dodi/workflow-core` (FSM) and `@dodi/task-core` (dependency resolution) with Hive-specific adapters:
- `ICollectionAdapter` → wraps native MongoDB driver (Hive already uses `mongodb` directly)
- `IStateful` → Hive's `IWorkflowTask` implements the minimal `{ state: string }` interface

`@dodi/workflow-engine` and `@dodi/fsm-persistence` are NOT needed for v1 — the task FSM is a hardcoded simple FSM with five states, and workflow automation rules are a future concern.

### MCP Tools

**`create_plan`** — create a plan with tasks and dependencies in one call.

```typescript
{
  name: string;
  goal?: string;
  sourceContext?: { channelId?, threadId?, summary? };
  tasks: Array<{
    tempId: string;          // temporary ID for dependency references
    title: string;
    description?: string;
    assignee: { type: 'agent' | 'human'; id: string; name: string };
    dependsOn?: string[];    // tempIds of predecessor tasks
  }>;
}
```

Validates dependency graph is acyclic (cycle detection from `@dodi/task-core`). Resolves tempIds to real task IDs, computes initial states, persists, emits `workflow:plan_created`.

**`get_plan`** — fetch a plan with all its tasks and current status.

**`list_plans`** — list plans, filterable by status and createdBy.

**`get_my_tasks`** — tasks assigned to the calling agent, filterable by state. Agent ID from `AGENT_ID` env var.

**`update_task_state`** — advance a task's state. Validates transition via FSM, runs dependency engine on terminal states, emits events. Uses atomic `findOneAndUpdate` with `state: 'blocked'` guard to prevent double-fire on concurrent completions.

**`cancel_task`** — cancel a task. Runs dependency engine (cancelled is terminal — unblocks dependents, downstream agent decides if work is still relevant).

**`add_task`** — add a task to an existing plan. Validates no cycles. Initial state computed: `todo` if no dependencies or ALL dependencies are terminal; `blocked` if ANY dependency is non-terminal.

**`add_comment`** — status update or note on a task. Separate `workflow_task_comments` collection (indexed on `taskId`).

### Agent Identity

MCP server receives `AGENT_ID` via env var. `get_my_tasks` scopes to calling agent. `update_task_state` checks caller is assignee (or allows any agent for human-assigned tasks). For human-assigned tasks completed by an agent, `completedBy` = the agent ID that called the tool; event payload includes full human assignee info.

### Data Model (Hive-side)

Uses the interfaces from `@dodi/workflow-core` and `@dodi/task-core`, stored in Hive's MongoDB instance:

**`workflow_plans` collection:**
```typescript
interface IWorkflowPlan {
  _id: string;
  name: string;
  goal?: string;
  sourceContext?: {
    channelId?: string;
    threadId?: string;
    summary?: string;
  };
  createdBy: string;         // agent ID
  createdAt: Date;
  updatedAt: Date;
}
```

**`workflow_tasks` collection:**
```typescript
interface IWorkflowTask {
  _id: string;
  planId: string;
  title: string;
  description?: string;
  assignee: {
    type: 'agent' | 'human';
    id: string;
    name: string;
  };
  state: 'blocked' | 'todo' | 'in_progress' | 'done' | 'cancelled';
  dependencies: string[];    // task IDs (end-to-start)
  order: number;
  completedAt?: Date;
  completedBy?: string;      // agent ID that moved task to done
  cancelledBy?: string;      // agent ID that cancelled the task
  createdAt: Date;
  updatedAt: Date;
}
```

Indexes: `planId`, `assignee.id`, `state`, compound `(planId, state)`

### Event Bus Integration

The workflow MCP server writes events directly to `agent_events` in MongoDB (same as how the event-bus MCP server works internally). It does NOT call `emit_event` as a tool — it's a separate stdio subprocess with its own MongoDB connection. This means `EVENT_SCHEMAS` and `EVENT_DOMAINS` in `event-types.ts` do not need updating for validation purposes. However, the `EVENT_SUBSCRIBERS` env var must include `workflow` domain mappings so the server knows which agents to create deliveries for.

Events emitted:

| Event | Payload | Emitted When |
|-------|---------|-------------|
| `workflow:plan_created` | planId, name, taskCount, createdBy | Plan created |
| `workflow:task_unblocked` | planId, taskId, title, assignee | Task moved blocked→todo |
| `workflow:task_completed` | planId, taskId, title, assignee, completedBy | Task moved to done |
| `workflow:task_cancelled` | planId, taskId, title, assignee, cancelledBy | Task cancelled |
| `workflow:plan_completed` | planId, name, taskCount, completedCount, cancelledCount | All tasks terminal |

Workflow MCP server needs `EVENT_SUBSCRIBERS` env var (same as event-bus MCP server) to construct delivery records in `agent_events`.

### Human Notification

The workflow MCP server is a stdio subprocess — no access to channel adapters. Human notifications use the event bus:

1. Task unblocked with human assignee → `workflow:task_unblocked` emitted with full assignee info
2. A subscribing agent (e.g., Rae) receives the event via normal event delivery
3. That agent uses its tools (Slack, SMS, email) to notify the human

No new notification infrastructure needed.

### Feature Flag

```yaml
workflow:
  enabled: true
```

When `workflow.enabled` is `false` (default), the workflow MCP server is not spawned even if listed in an agent's `servers` array. The `workflow` event domain is not registered, and no workflow events are emitted or delivered. Same pattern as `memory.structured`.

### Agent Runner Wiring

In `src/agents/agent-runner.ts`, add `workflow` to the MCP server map (gated by feature flag):

```typescript
workflow: {
  command: 'node',
  args: ['dist/workflow/workflow-mcp-server.js'],
  env: { AGENT_ID, MONGODB_URI, MONGODB_DB: config.mongo.dbName, EVENT_SUBSCRIBERS }
}
```

### Task Lifecycle

```
[created with unresolved dependencies] → blocked
[created with no deps, or all deps terminal] → todo
[assignee starts work] → in_progress
[work complete] → done → dependency engine runs
[no longer needed] → cancelled → dependency engine runs
```

**Cancellation policy:** `cancelled` counts as terminal for dependency purposes. Downstream tasks get unblocked — the downstream agent decides if the work is still relevant.

**Concurrency safety:** Dependency engine uses atomic `findOneAndUpdate` with `state: 'blocked'` filter. Only the update that actually transitions `blocked → todo` emits the event. Prevents double-notification when two predecessors complete near-simultaneously.

**Plan status:** Computed from task states (not stored). `active` = has non-terminal tasks. `completed` = all terminal, at least one `done`. `cancelled` = all `cancelled`.

## Transcript → Plan

Not a separate subsystem. Any agent with the `workflow` server can:

1. Receive a transcript (meeting, Slack thread, pasted doc)
2. Use LLM reasoning to extract tasks, assignees, and dependencies
3. Call `create_plan` with structured output

System prompt guidance for agents with workflow tools covers: identifying actionable items, resolving names to agent/contact IDs, identifying dependency relationships.

## dodi_v2 Migration

After extraction, dodi_v2 consumes the same shared packages:

1. Replace `Meteor.Collection` calls with the Meteor adapter implementing `ICollectionAdapter`
2. `withUserContext` becomes the Meteor implementation of `IExecutionContext`
3. `ControllerToolRegistry` becomes the dodi_v2 implementation of `IToolExecutor`
4. Entity fetching goes through `IEntityResolver` backed by FSMCollectionRegistry

This is a refactor, not a rewrite — same logic, same collections, just injected dependencies instead of hard imports. Can be done incrementally (adapter wraps existing code, then gradually migrate callers).

## Execution Sequence

### Phase 1: Extract packages
1. Create `dodi-hq/dodi-workflow` repo with workspace structure
2. Extract `@dodi/workflow-core` — SimpleFSM, strict FSM, ConditionEvaluator, WorkflowGraphBuilder, all interfaces. Replace `IStatable` with `IStateful`, clean up lodash usage.
3. Extract `@dodi/task-core` — task states, dependency resolution (with cancelled-as-terminal fix and atomic unblock), cycle detection. Depends on `@dodi/workflow-core` for FSM and `@dodi/fsm-persistence` for `ICollectionAdapter`.
4. Add tests — port relevant integration tests from dodi_v2, add unit tests for the cancelled-as-terminal behavior and atomic concurrency guard.

### Phase 2: Wire into Hive
5. Add `workflow.enabled` to `src/config.ts` (typed config, defaults to `false`)
6. Add Hive adapter: `ICollectionAdapter` wrapping native MongoDB driver
7. Build `workflow-mcp-server.ts` using `@dodi/workflow-core` + `@dodi/task-core` — writes events directly to `agent_events` (not via `emit_event` tool)
8. Register workflow server in `buildAllServerConfigs()` unconditionally (same as `team`). Add `if (config.workflow.enabled) { coreSet.add("workflow"); }` to `filterCoreServers()` — matching the exact `team` gating pattern.
9. Add `workflow` to the `subscribe` field in agent definitions for agents that should receive workflow events (e.g., Rae). The `EVENT_SUBSCRIBERS` JSON is auto-derived from agent definitions by `AgentRegistry.getSubscriberMap()` — no code change needed for subscriber wiring.
10. Integration tests

### Phase 3: Wire into dodi_v2
10. Extract `@dodi/fsm-persistence` — FSMService, FSMDefinitionCache, FSMCollectionRegistry
11. Extract `@dodi/workflow-engine` — WorkflowEngine, ActionExecutor
12. Add Meteor adapter: `ICollectionAdapter` wrapping Meteor's `Mongo.Collection` (note: `find()` returns cursor, adapter calls `.fetchAsync()`)
13. Replace dodi_v2 direct imports with package imports
14. Verify existing dodi_v2 tests still pass
15. Register conditions via `FSMService.registerCondition()` at dodi_v2 module startup (preserves existing pattern)

### Phase 4: Future
- react-flow FSM designer (extract UI package, replace useTracker with generic data hooks)
- WorkflowSnapshots for versioning
- Workflow rules UI
- Task board UI (extract, replace Meteor reactivity)
- Wire `@dodi/workflow-engine` into Hive for automated rules (e.g., "on deal won → create onboarding plan")

## Not In Scope (v1)

- **UI components** — react-flow designer, task board. Available in dodi_v2 for future extraction.
- **Recurring workflows / templates** — build once patterns emerge
- **Cross-plan dependencies** — tasks depend on tasks within the same plan only
- **Time estimates / deadlines** — add fields later without structural changes
- **Strict FSM for tasks** — simple FSM is sufficient; strict FSM is in the package if needed later
