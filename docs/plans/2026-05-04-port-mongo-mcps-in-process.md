# Port Mongo MCP Servers In-Process Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Port the 10 tier-1 Mongo-backed MCP servers from stdio subprocesses to in-process `createSdkMcpServer` instances so each agent turn no longer churns ~20-30 Mongo TIME_WAITs (KPR-122 acceptance: drop steady-state Mongo TIME_WAIT count by ≥80%, target <300).

**Architecture:** Each ported server becomes a builder function (`buildXxxTools(deps)` returning `tool()` array) plus a thin factory (`createXxxMcpServer(deps)` calling `createSdkMcpServer({ name, version, tools })`), following the `team-roster` template (`src/team-roster/team-roster-mcp-server.ts`). Tool handlers close over a shared `MongoClient`/`Db` (the engine's existing single pool from `src/index.ts:96-105`) and accept per-turn context (AGENT_ID, CHANNEL_ID, work-item metadata) as constructor args resolved at `send()` time, replacing spawn-time env vars. The standalone stdio entry-point file is kept as a thin shim importing `buildXxxTools` for any external invocations and so the bundle still emits a runnable JS file.

**Tech Stack:** TypeScript strict, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`, `tool`), `mongodb` (shared `Db` from `src/index.ts`), `zod` for tool schemas.

## Testing Contract

### Required Test Groups

- **Unit:** required.
  - **Scope/Reason:** Each ported server's `buildXxxTools(deps)` must round-trip its main read/write paths against the existing test patterns (admin, schedule, event-bus, workflow, memory-store and friends already have unit tests; preserve coverage). New unit tests should drive `buildXxxTools(...)` directly so handlers are exercised without an stdio transport — same approach as the team-roster template's exported `buildTeamRosterTools`.
  - **Min assertions:** for each of the 10 servers, at least one happy-path round-trip (write/read or list/lookup) and one error-path (invalid args or missing context) assertion.

- **Integration:** required.
  - **Scope/Reason:** `agent-runner.test.ts` must verify the in-process server is wired into `mcpServers` in `send()` and reused across turns (no re-construction per turn — same caching shape as `teamRosterMcpServer`).
  - **Harness:** the existing `mongodb-memory-server`/in-memory or local Mongo harness already used by `memory-store.test.ts`, `admin-mcp-server.test.ts`, `schedule-mcp-server.test.ts`. Reuse, do not rebuild.
  - **Min assertions:** 10 — one assertion per ported server that `mcpServers["<name>"]` is an SDK MCP server instance (not an stdio config) after `send()` setup, and that the cached field is set on the runner.

- **E2E:** not-required for the port itself; **measurement is required** as a separate verification step (see Final Task: Measurement). Smoke verification per server (acceptance criterion #3) is operator-driven against the running `keepur` instance after deploy.

### Critical Flows / Regression Surface

- `AgentRunner.send()` lifecycle (`src/agents/agent-runner.ts:1218-1558`) — must continue to assemble `mcpServers` correctly with the in-process entries replacing stdio entries. `filterCoreServers` (around `src/agents/agent-runner.ts:879-905`) must not drop the new in-process servers — they ride in the same `mcpServers` map and are filtered by name as before.
- Tool name stability — agents have memorized tool names like `mcp__memory__memory_write`. Ported tools MUST register under the SAME server name AND tool name. Any drift breaks every agent's prompt cache and many workflow references.
- Per-call context — `structured-memory`, `callback`, `event-bus`, `team`, `admin`, `code-search`, `workflow` need values that today come from spawn env (`AGENT_ID`, `CHANNEL_ID`, `THREAD_ID`, etc.). After port, these come from the `WorkItemContext` passed to `send()` and threaded into tool builder closures **per turn** (the SDK MCP server is cached, but the per-turn context must still be visible — design pattern: have the cached server hold a mutable `currentContext` ref that `send()` updates before invoking `query()`, OR rebuild the SDK server per turn for context-sensitive servers. See template note below).
- `coreServers`/`delegateServers` filtering — unchanged. Names match.
- `eventSubscribersJson` plumbing for `event-bus` and `workflow` — unchanged source of truth (already lives on the runner).
- `AgentRunner.registryRef` for `team`'s `AGENT_IDS` env — replaced by direct `registryRef.getAll()` call inside the tool handler (no JSON serialization round-trip needed).

### Commands

```bash
npm run typecheck
npm run lint
# Existing tests today (verified present in repo at plan time):
npm run test -- src/memory/memory-store.test.ts
npm run test -- src/memory/memory-lifecycle.test.ts
npm run test -- src/memory/memory-manager.test.ts
npm run test -- src/events/event-bus-mcp-server.test.ts
npm run test -- src/schedule/schedule-mcp-server.test.ts
npm run test -- src/admin/admin-mcp-server.test.ts
npm run test -- src/admin/admin-api.test.ts
npm run test -- src/workflow/workflow-mcp-server.test.ts
npm run test -- src/team/command-registry.test.ts
npm run test -- src/agents/agent-runner.test.ts

# New test files this PR creates (one per server lacking MCP-surface coverage):
npm run test -- src/memory/structured-memory-mcp-server.test.ts
npm run test -- src/callback/callback-mcp-server.test.ts
npm run test -- src/contacts/contacts-mcp-server.test.ts
npm run test -- src/team/team-mcp-server.test.ts
npm run test -- src/code-index/code-search-mcp-server.test.ts

# Full gate:
npm run check
```

### Harness Requirements

- Local MongoDB or `mongodb-memory-server` (whichever the existing tests already use — do not introduce a new harness).
- Qdrant + Ollama for the `structured-memory` and `code-search` Vitest paths if/when their tests touch vector code paths; otherwise the existing tests stub those.

### Non-Required Rationale

- E2E gate skipped: the SDK's tool dispatch is deterministic and well-covered; the operational truth is the TIME_WAIT measurement (see Final Task: Measurement) and the per-server smoke list in AC #3, both of which are part of acceptance.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## The Port Template

Every tier-1 server follows this recipe. Reference: `src/team-roster/team-roster-mcp-server.ts` (the precedent), `src/agents/agent-runner.ts:1232-1241` (cache + wire-in pattern).

### Step 0 — Plumb shared dependencies (one-time, before Task 1)

`AgentRunner` already receives `MemoryManager`, `eventSubscribersJson`, `teamRoster`, etc. The Mongo-backed in-process servers all need a `Db` handle. Two flavors of dependency:

- **`Db`** (shared MongoDB handle from `src/index.ts:105`).
- **Per-turn context** (`AGENT_ID` is constructor-time stable; `CHANNEL_ID`/`THREAD_ID`/`SLACK_TS`/`ADAPTER_ID` are per-turn from `WorkItemContext`).

Plumbing change (one task — Task 0):

1. Extend `AgentManager` constructor (`src/agents/agent-manager.ts:74`) to accept `db: Db`. Store it on the instance.
2. Pass `db` to `new AgentRunner(...)` in `AgentManager` (`src/agents/agent-manager.ts:98`).
3. Extend `AgentRunner` constructor (`src/agents/agent-runner.ts:205`) with a final `db: Db` arg (or insert before `teamRoster` if positional ordering is awkward — current convention favors append).
4. Update the call site in `src/index.ts:256` to pass `db`.

After Task 0 finishes, every per-server task plugs into `this.db` directly.

### Per-server template steps

For each tier-1 server `<name>` (file: `src/<dir>/<name>-mcp-server.ts`):

#### Step 1 — Refactor the server file

Convert from "self-running stdio entry-point" to "exported builder + thin shim":

```typescript
// src/<dir>/<name>-mcp-server.ts (new shape)

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";

/**
 * Per-turn context the in-process tools may consult.
 * Stable fields (agentId) live on deps; mutable fields live on a context ref
 * the runner updates each turn before query() runs.
 */
export interface XxxTurnContext {
  channelId?: string;
  threadId?: string;
  adapterId?: string;
  // ...whatever this server's stdio version pulled from process.env
}

export interface XxxToolDeps {
  db: Db;
  agentId: string;
  /**
   * Mutable ref — runner mutates `.current` in send() before each query()
   * so context-sensitive tool handlers see the active turn's metadata.
   */
  context: { current: XxxTurnContext };
  // server-specific deps (eventSubscribersJson, registryRef, etc.)
}

export function buildXxxTools(deps: XxxToolDeps) {
  const collection = deps.db.collection("xxx");
  // any one-time setup that the stdio version did at top level

  return [
    tool(
      "xxx_action_one",
      "<exact description string copied from the stdio server>",
      { /* zod schema — copy verbatim from registerTool() */ },
      async (args) => {
        try {
          // Body copied from the stdio handler. Replace `process.env.X` reads
          // with `deps.context.current.X` (per-turn) or `deps.agentId` (stable).
          // Replace top-level `await collection.findOne(...)` etc. directly.
          const result = await collection.findOne({ /* ... */ });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          // AC #4: every handler wrapped in try/catch with structured error
          // response so an unhandled exception never crashes the hive.
          return {
            isError: true,
            content: [{ type: "text", text: `xxx_action_one error: ${String(err)}` }],
          };
        }
      },
    ),
    // ...one tool() per registerTool() in the original file
  ];
}

export function createXxxMcpServer(deps: XxxToolDeps) {
  return createSdkMcpServer({
    name: "<name>",                // EXACT same key used in agent-runner.ts servers map
    version: "0.1.0",
    tools: buildXxxTools(deps),
  });
}

// ── stdio shim (kept for backward-compat / external invocation) ──
// If executed as a Node script (still happens in tests / external tooling),
// fall back to the original stdio behavior. Pure module imports skip this.
if (import.meta.url === `file://${process.argv[1]}`) {
  // ...original stdio bootstrap kept verbatim, OR replaced with a minimal
  // "this server is now in-process; use createXxxMcpServer()" stderr + exit(0).
  // Recommendation: keep the stdio bootstrap for the first port (memory) so
  // the test file that spawns it as a subprocess still works; for later
  // servers whose tests don't spawn the subprocess, drop the shim entirely.
}
```

#### Step 2 — Wire into `AgentRunner`

In `src/agents/agent-runner.ts`:

1. **Import** `createXxxMcpServer` and `XxxTurnContext` from the refactored module.
2. **Add a private cached field** on `AgentRunner` — `private xxxMcpServer?: ReturnType<typeof createXxxMcpServer>;` and (if needed) `private xxxContextRef = { current: {} as XxxTurnContext };`.
3. **Remove the stdio block** for `<name>` from `buildAllServerConfigs` (the relevant lines from `src/agents/agent-runner.ts:330-872`).
4. **Add the wire-in** in `send()` right after the existing `team-roster` block (`src/agents/agent-runner.ts:1237-1242`):

```typescript
// <name> — in-process per KPR-122. Cached on the runner; per-turn context
// updated via xxxContextRef.current before query() runs.
this.xxxContextRef.current = {
  channelId: context?.channelId,
  threadId: context?.threadId,
  adapterId: context?.adapterId,
  // ...whatever this server's stdio block read from context
};
if (!this.xxxMcpServer) {
  this.xxxMcpServer = createXxxMcpServer({
    db: this.db,
    agentId: this.agentConfig.id,
    context: this.xxxContextRef,
    // ...server-specific extras (eventSubscribersJson, registryRef, etc.)
  });
}
mcpServers["<name>"] = this.xxxMcpServer;
```

5. **`filterCoreServers` audit** — confirm `<name>` is still spelled the same in `coreServers`/`delegateServers` filtering (it is, because the map key is unchanged).

#### Step 3 — Update / preserve tests

- The existing test file (e.g. `src/memory/memory-store.test.ts`, `src/admin/admin-mcp-server.test.ts`) keeps testing the underlying store/manager — no change required where it tests pure logic.
- Where the test exercises the MCP surface, switch from spawning the subprocess to calling `buildXxxTools({ ... })` and invoking the returned tool handlers directly (mirror `team-roster-mcp-server.ts:11-71` — `buildTeamRosterTools` is exported precisely for this).
- Add at least one happy-path + one error-path assertion per tool group exercised today, per the Testing Contract.

#### Step 4 — `npm run check` + commit

```bash
npm run check
git add -A
git commit -m "refactor(<name>): port to in-process MCP per KPR-122"
```

One task = one commit. No squashing across servers.

---

## Task 0: Plumb shared `Db` through AgentManager → AgentRunner

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/agents/agent-runner.ts`
- Modify: `src/index.ts`

- [ ] **Step 1:** Extend `AgentManager` constructor signature at `src/agents/agent-manager.ts:74` to accept `db: Db`, store on `this.db`, and pass `this.db` into `new AgentRunner(...)` at `src/agents/agent-manager.ts:98`. Add `import type { Db } from "mongodb";`.
- [ ] **Step 2:** Extend `AgentRunner` constructor at `src/agents/agent-runner.ts:205` to accept and store `db: Db`. Add `import type { Db } from "mongodb";`. No usages yet — just plumbing.
- [ ] **Step 3:** Update the `new AgentManager(...)` call site at `src/index.ts:256` to pass the existing `db` (line 105).
- [ ] **Step 4:** `npm run typecheck && npm run lint`.
- [ ] **Step 5:** Commit `chore(agent-runner): plumb shared Db through AgentManager per KPR-122`.

---

## Task 1: Port `memory`

**Files:**
- Modify: `src/memory/memory-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~389-399; add wire-in in `send()`)
- Test: keep `src/memory/memory-store.test.ts` and friends passing; if a memory MCP test currently spawns the subprocess, switch it to call `buildMemoryTools(...)` directly.

Stdio env vars currently passed at spawn (`agent-runner.ts:393-398`): `AGENT_ID`, `MONGODB_URI`, `MONGODB_DB`, `MEMORY_SCOPES_JSON`. After port: `agentId` is constructor-time, `db` is the shared handle, `memoryScopes` (the array, not its JSON) is passed as a constructor dep. **No per-turn context needed** (memory tools don't read CHANNEL/THREAD).

Tools to preserve (registered in `src/memory/memory-mcp-server.ts`): `memory_read`, `memory_write`, `memory_list`, `memory_history`, `memory_rollback` (verify against the file — name MUST match exactly).

- [ ] **Step 1:** Refactor `src/memory/memory-mcp-server.ts` per template. Export `buildMemoryTools({ db, agentId, memoryScopes })` and `createMemoryMcpServer(deps)`. Keep the stdio shim (the subprocess form is exercised elsewhere — drop the shim only if `npm run check` confirms no consumer).
- [ ] **Step 2:** In `src/agents/agent-runner.ts`: import `createMemoryMcpServer`; add `private memoryMcpServer?: ReturnType<typeof createMemoryMcpServer>;`; delete the `servers["memory"] = { type: "stdio", ... }` block; wire `mcpServers["memory"]` in `send()` (the `memoryScopes` array is already computed at lines 369-388 — pass it through to the in-process factory).
- [ ] **Step 3:** Verify: `npm run test -- src/memory/memory-store.test.ts && npm run test -- src/agents/agent-runner.test.ts && npm run check`.
- [ ] **Step 4:** Commit `refactor(memory): port to in-process MCP per KPR-122`.

---

## Task 2: Port `structured-memory`

**Files:**
- Modify: `src/memory/structured-memory-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~402-415)
- Test: existing `src/memory/memory-lifecycle.test.ts`, `src/memory/memory-store.test.ts`. Add a `buildStructuredMemoryTools(...)` round-trip test if the current MCP-surface coverage is thin.

Stdio env vars at spawn (`agent-runner.ts:406-414`): `AGENT_ID`, `MONGODB_URI`, `MONGODB_DB`, `CHANNEL_ID`, `THREAD_ID`, `QDRANT_URL`, `OLLAMA_URL`. After port: `agentId` stable; `db` shared; `channelId`/`threadId` per-turn (use `xxxContextRef.current` pattern); `QDRANT_URL`/`OLLAMA_URL` come from `process.env` directly inside the module (same as today, just no env-pass-through round-trip).

**Auto-pairing** — `structured-memory` is auto-injected when `memory` is in `coreServers` (see `agent-runner.ts:885-888`). Preserve that wire-in unchanged.

- [ ] **Step 1:** Refactor `src/memory/structured-memory-mcp-server.ts` per template. Export `buildStructuredMemoryTools({ db, agentId, context })` and `createStructuredMemoryMcpServer(deps)`.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private structuredMemoryMcpServer` cache and a `private structuredMemoryContextRef = { current: { channelId: "", threadId: "" } }` updated each turn from `context?.channelId`/`context?.threadId`. Delete the stdio block.
- [ ] **Step 3:** Verify: `npm run test -- src/memory/structured-memory-mcp-server.test.ts || true; npm run test -- src/memory/memory-lifecycle.test.ts && npm run check`.
- [ ] **Step 4:** Commit `refactor(structured-memory): port to in-process MCP per KPR-122`.

---

## Task 3: Port `event-bus`

**Files:**
- Modify: `src/events/event-bus-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~803-813)
- Test: `src/events/event-bus-mcp-server.test.ts`

Stdio env vars at spawn (`agent-runner.ts:807-812`): `AGENT_ID`, `MONGODB_URI`, `MONGODB_DB`, `EVENT_SUBSCRIBERS`. After port: `agentId` stable; `db` shared; `eventSubscribersJson` already lives on the runner (`this.eventSubscribersJson`, line 196) — pass directly into the deps.

- [ ] **Step 1:** Refactor `src/events/event-bus-mcp-server.ts` per template. Export `buildEventBusTools({ db, agentId, eventSubscribersJson })` and `createEventBusMcpServer(deps)`.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private eventBusMcpServer` cache. Delete the stdio block. Note: `eventSubscribersJson` is constructor-time stable on the runner (set in the constructor and never mutated), so the cached SDK server is safe to reuse across turns.
- [ ] **Step 3:** Verify: `npm run test -- src/events/event-bus-mcp-server.test.ts && npm run check`.
- [ ] **Step 4:** Commit `refactor(event-bus): port to in-process MCP per KPR-122`.

---

## Task 4: Port `callback`

**Files:**
- Modify: `src/callback/callback-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~654-670)
- Test: add a `buildCallbackTools(...)` smoke test if none exists today.

Stdio env vars at spawn (`agent-runner.ts:658-669`): `CB_AGENT_ID`, `CB_ADAPTER_ID`, `CB_CHANNEL_ID`, `CB_CHANNEL_KIND`, `CB_CHANNEL_LABEL`, `CB_THREAD_ID`, `CB_SLACK_TS`, `CB_SLACK_THREAD_TS`, `MONGODB_URI`, `MONGODB_DB`. After port: `agentId` stable (`CB_AGENT_ID`); `db` shared; everything else is per-turn `WorkItemContext` — passes via the `context` ref.

- [ ] **Step 1:** Refactor `src/callback/callback-mcp-server.ts` per template. The `XxxTurnContext` type for callback should mirror the full set of `CB_*` env vars (adapterId, channelId, channelKind, channelLabel, threadId, slackTs, slackThreadTs).
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private callbackMcpServer` cache and `private callbackContextRef`. Update `.current` from `context` each turn before reading the cached server. Delete the stdio block.
- [ ] **Step 3:** Verify: `npm run test -- src/callback && npm run check`.
- [ ] **Step 4:** Commit `refactor(callback): port to in-process MCP per KPR-122`.

---

## Task 5: Port `contacts`

**Files:**
- Modify: `src/contacts/contacts-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~480-488)
- Test: `src/contacts/` has no MCP test today — add a minimal `buildContactsTools(...)` round-trip test (one happy-path lookup, one not-found path).

Stdio env vars at spawn (`agent-runner.ts:484-487`): `MONGODB_URI`, `MONGODB_DB`. After port: only `db` is needed — the simplest port of the 10. **No per-turn context.**

- [ ] **Step 1:** Refactor `src/contacts/contacts-mcp-server.ts` per template. Export `buildContactsTools({ db })` and `createContactsMcpServer(deps)`.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private contactsMcpServer` cache. Delete the stdio block.
- [ ] **Step 3:** Verify: `npm run test -- src/contacts && npm run check`.
- [ ] **Step 4:** Commit `refactor(contacts): port to in-process MCP per KPR-122`.

---

## Task 6: Port `schedule`

**Files:**
- Modify: `src/schedule/schedule-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~849-858)
- Test: `src/schedule/schedule-mcp-server.test.ts`

Stdio env vars at spawn (`agent-runner.ts:853-857`): `AGENT_ID`, `MONGODB_URI`, `MONGODB_DB`. After port: `agentId` stable; `db` shared. **No per-turn context.**

- [ ] **Step 1:** Refactor `src/schedule/schedule-mcp-server.ts` per template. Export `buildScheduleTools({ db, agentId })` and `createScheduleMcpServer(deps)`.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private scheduleMcpServer` cache. Delete the stdio block. `schedule` is auto-injected (`agent-runner.ts:893`) — preserve the `coreSet.add("schedule")` line; only the server entry source changes.
- [ ] **Step 3:** Verify: `npm run test -- src/schedule/schedule-mcp-server.test.ts && npm run check`.
- [ ] **Step 4:** Commit `refactor(schedule): port to in-process MCP per KPR-122`.

---

## Task 7: Port `team`

**Files:**
- Modify: `src/team/team-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~819-831)
- Test: add `buildTeamTools(...)` smoke if none exists; verify `command-registry.test.ts` still passes.

Stdio env vars at spawn (`agent-runner.ts:823-830`): `AGENT_ID`, `MONGODB_URI`, `MONGODB_DB`, `AGENT_IDS` (JSON-serialized list of ids from the registry). After port: `agentId` stable; `db` shared; `AGENT_IDS` becomes a function call into `AgentRunner.registryRef?.getAll()` directly inside the handler (so it stays live across hot reloads — better than today's spawn-time snapshot).

- [ ] **Step 1:** Refactor `src/team/team-mcp-server.ts` per template. Export `buildTeamTools({ db, agentId, getAgentIds: () => string[] })` and `createTeamMcpServer(deps)`.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private teamMcpServer` cache. `getAgentIds` closure: `() => AgentRunner.registryRef?.getAll().map((a) => a.id) ?? []`. Delete the stdio block. `team` is auto-injected (`agent-runner.ts:895`) — preserve.
- [ ] **Step 3:** Verify: `npm run test -- src/team && npm run check`.
- [ ] **Step 4:** Commit `refactor(team): port to in-process MCP per KPR-122`.

---

## Task 8: Port `admin`

**Files:**
- Modify: `src/admin/admin-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~861-871)
- Test: `src/admin/admin-mcp-server.test.ts`, `src/admin/admin-api.test.ts`

Stdio env vars at spawn (`agent-runner.ts:865-870`): `MONGODB_URI`, `MONGODB_DB`, `AGENT_ID`, `INSTANCE_CAPABILITIES`. After port: `agentId` stable; `db` shared; `instanceCapabilities` (the JSON-derived value) passed as a constructor dep — `buildCapabilitiesJson(this.plugins)` already happens on the runner, just inline it.

- [ ] **Step 1:** Refactor `src/admin/admin-mcp-server.ts` per template. Export `buildAdminTools({ db, agentId, instanceCapabilities })` and `createAdminMcpServer(deps)`. Watch for any subprocess-only state in this file (admin is the largest at 29KB) — flag it during port if discovered.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private adminMcpServer` cache. Delete the stdio block.
- [ ] **Step 3:** Verify: `npm run test -- src/admin && npm run check`.
- [ ] **Step 4:** Commit `refactor(admin): port to in-process MCP per KPR-122`.

---

## Task 9: Port `code-search`

**Files:**
- Modify: `src/code-index/code-search-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~712-722)
- Test: add `buildCodeSearchTools(...)` smoke if none exists.

Stdio env vars at spawn (`agent-runner.ts:716-721`): `MONGODB_URI`, `MONGODB_DB`, `QDRANT_URL`, `OLLAMA_URL`. After port: `db` shared; Qdrant/Ollama URLs read from `process.env` inside the module same as today. **No per-turn context.** `code-search` also benefits from the `CodeIndexPrefetcher` already on the runner (`this.prefetcher`) — pass through if the handlers need it.

- [ ] **Step 1:** Refactor `src/code-index/code-search-mcp-server.ts` per template. Export `buildCodeSearchTools({ db, prefetcher? })` and `createCodeSearchMcpServer(deps)`.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private codeSearchMcpServer` cache. Delete the stdio block.
- [ ] **Step 3:** Verify: `npm run test -- src/code-index && npm run check`.
- [ ] **Step 4:** Commit `refactor(code-search): port to in-process MCP per KPR-122`.

---

## Task 10: Port `workflow`

**Files:**
- Modify: `src/workflow/workflow-mcp-server.ts`
- Modify: `src/agents/agent-runner.ts` (remove stdio block at lines ~835-845)
- Test: `src/workflow/workflow-mcp-server.test.ts`

Stdio env vars at spawn (`agent-runner.ts:840-844`): `AGENT_ID`, `MONGODB_URI`, `MONGODB_DB`, `EVENT_SUBSCRIBERS`. After port: same shape as `event-bus` — `agentId` stable, `db` shared, `eventSubscribersJson` from `this.eventSubscribersJson`. Preserve the `if (config.workflow.enabled)` gate — only build/wire the in-process server when workflow is enabled.

- [ ] **Step 1:** Refactor `src/workflow/workflow-mcp-server.ts` per template. Export `buildWorkflowTools({ db, agentId, eventSubscribersJson })` and `createWorkflowMcpServer(deps)`. Spec note: "usage TBD (audit during port)" — if anything in this file looks dead/orphaned, flag in the commit message; do not delete in this PR.
- [ ] **Step 2:** Wire into `AgentRunner.send()` with a `private workflowMcpServer` cache, gated by `config.workflow.enabled`. Delete the stdio block.
- [ ] **Step 3:** Verify: `npm run test -- src/workflow/workflow-mcp-server.test.ts && npm run check`.
- [ ] **Step 4:** Commit `refactor(workflow): port to in-process MCP per KPR-122`.

---

## Final Task A0: Per-server smoke verification (KPR-122 AC #3)

**Files:** none — operational verification against the deployed `keepur` instance.

After tier-1 ports merge and the engine is deployed (`hive update`), drive one round-trip per ported server through an agent so each in-process MCP exercises its primary tool path live. The 10 smoke checks below correspond 1:1 to the ports.

- [ ] **Step 1:** From a CoS thread on the `keepur` instance, invoke each tool once and confirm a non-error response. Recommended canonical exercises (drawn from AC #3):
   - `memory` → `memory_write` then `memory_read` round-trip on a scratch key.
   - `structured-memory` → semantic recall on a tier-2 entry (`structured_memory_search`).
   - `event-bus` → publish a no-op event and confirm no subscriber error.
   - `callback` → schedule a 60s callback, confirm fire.
   - `contacts` → `contacts_lookup` for a known contact.
   - `schedule` → `schedule_list` returning the live cron set.
   - `team` → `team_list` returning the live agent ids.
   - `admin` → `agent_list` returning current agent definitions.
   - `code-search` → `code_search` query against the indexed corpus.
   - `workflow` → `workflow_list` (gated by `config.workflow.enabled`; if disabled, mark N/A and note).
- [ ] **Step 2:** Capture the per-tool response previews (truncated; no sensitive data) as a comment on KPR-122.
- [ ] **Step 3:** If any smoke check errors out, that single server reverts to stdio (revert its Task N commit) and a follow-up ticket is filed to investigate. The other ports stay merged.

---

## Final Task A: Measurement (KPR-122 AC #2)

**Files:** none — operational verification.

- [ ] **Step 1:** Deploy the merged tier-1 ports to the `keepur` instance via `hive update`. Confirm `launchctl kickstart -k gui/$(id -u)/com.hive.keepur.agent` and that the service is healthy (`hive status`).
- [ ] **Step 2:** Wait ≥30 minutes after deploy under normal traffic for steady state.
- [ ] **Step 3:** Sample TIME_WAIT count 5 times, 60 seconds apart, while normal traffic is hitting the instance:
   ```bash
   for i in 1 2 3 4 5; do
     date
     netstat -an | grep 27017 | grep TIME_WAIT | wc -l
     sleep 60
   done
   ```
- [ ] **Step 4:** Compute the average across the 5 samples. **Pass condition:** average ≤ 274 (≥80% drop from the KPR-121 baseline of 1,374; target <300).
- [ ] **Step 5:** Record the 5 raw samples, the average, the deploy commit SHA, and the sampling timestamps as a comment on KPR-122. If the pass condition is not met, file a follow-up ticket investigating residual churn (Anthropic API HTTPS, tier-2 candidates, missed handler) — do not reopen KPR-122 without evidence.

---

## Final Task B: `CLAUDE.md` update (KPR-122 AC #5)

**Files:** Modify `/Users/mokie/github/hive/CLAUDE.md`

Per the spec: lines 77 and 161 (current) describe MCP servers as "stdio subprocesses per agent session". After tier-1 ports the bulk of engine MCPs are in-process. Update to reflect:

- In-process is the default for engine-internal Mongo-backed MCPs.
- Stdio remains for tier-3 (subprocess-required) servers: `code-task`, `background`, `keychain`. Plus the non-Mongo HTTPS-pool tier-2 servers that remain stdio for now (`slack` local, `quo`, `resend`, `linear`, `github-issues`, `clickup`, `recall`, `google`, `voice`, `tasks`, `brave-search`, `browser`).
- Per-call context (`AGENT_ID`, `CHANNEL_ID`, `THREAD_ID`, `WorkItemContext` metadata) is passed at handler invocation for in-process MCPs via the `XxxContextRef` pattern, not via spawn-time env. Spawn-time env still applies to remaining stdio servers.
- Crash-isolation trade-off (AC #4): note that in-process tool handlers are wrapped in try/catch returning structured error responses; the SDK loop survives handler exceptions. If instability is observed, individual MCPs can selectively revert to stdio.

- [ ] **Step 1:** Edit the two specific lines (CLAUDE.md:77 and CLAUDE.md:161) plus the "MCP Servers" subsection above the inventory list to call out the in-process default.
- [ ] **Step 2:** `npm run check` (CLAUDE.md isn't linted but the typecheck/test gate ensures no accidental code drift slipped in).
- [ ] **Step 3:** Commit `docs(CLAUDE.md): in-process is the default for engine Mongo MCPs per KPR-122`.

---

## Spec Ambiguities

None. The spec is explicit on the 10 tier-1 servers, the acceptance metric, the team-roster pattern as the template, and the CLAUDE.md update. Two minor implementation choices (stdio shim retained vs. dropped per server; whether `code-search` needs `prefetcher` plumbed in) are flagged inline as judgment calls during execution rather than spec ambiguities.
