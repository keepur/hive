# KPR-453 — Runtime WorkItem Identity Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan through the child delivery lane.

**Goal:** Carry the exact existing `WorkItem.id` as optional `workItemId` through manager-owned turns, hooks, every enabled in-process MCP builder, and Lane B ToolBridge without adding persistence or changing routing.

**Architecture:** The manager populates the existing `WorkItemContext` before provider assembly. Existing provider, hook, and delegate APIs forward that object unchanged. Cached MCP factories receive runner-owned mutable references; three existing context projections gain the optional identity and the remaining nine factories receive one shared reference per runner.

**Tech Stack:** TypeScript 6, Node 24, Vitest 4, Claude Agent SDK in-process MCP servers, MCP SDK in-memory transport, existing fake Mongo and provider harnesses.

**Authority and baseline:** Approved spec: `docs/epics/kpr-451/kpr-453-design.md`, clean at `622c7ba31f9bd822137481ecf1f1d6ff71dff42c`. KPR-453 has no child dependencies; no Decision Register — Canon exists. Gate 1 delegates routine engineering decisions. This is a draft for independent plan review, not an implementation-readiness ruling.

**Execution boundary:** The repository requires `/spec-and-implement` after plan approval. Its entrypoint remains unresolved with the dispatcher. Drafting/review may continue; the delivery lane must resolve that requirement before beginning implementation. No production deployment belongs to this ticket.

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: context type compatibility, MCP dependency/reference wiring, alternate callback/structured-memory builders, callback and memory persistence projections, hook construction, worker/role boundaries.
  - Reason: an optional public field can compile while an explicit projection drops it; cached references can retain stale identity or leak identity between runners.
  - Minimum assertions: old and enriched public context shapes compile; the identity is string-or-undefined and optional; all twelve enabled factories see it; A → B → old context → no context clears it through the same cached references; a second runner stays isolated; callbacks, memory saves, claims, and detached roles do not persist/inherit originating identity.

- Integration: **required**
  - Scope: real manager-to-adapter assembly/request seams, Claude adapter-to-runner seam, Lane B scaffold-to-ToolBridge-to-guardrail, real in-process MCP transport, inline delegates.
  - Reason: isolated context types do not prove the manager supplies identity before eager Lane B construction or that the bridge receives it at tool execution.
  - Harness: **existing**, extended in the existing Vitest files; real in-memory MCP round trips, mocked provider calls and fake collections.
  - Minimum assertions: Slack and SMS work items with IDs distinct from timestamps/thread/session preserve exact bytes; distinct items sharing a thread carry distinct IDs; retry/self-heal retains the original ID; assembly and runTurn receive the same context; guardrail and delegate see that object; schemas and normal results remain unchanged.

- E2E: **not-required**
  - Scope: live Slack/provider/database service deployment.
  - Reason: this change adds only internal context; live services add nondeterminism without exercising a different identity mapping or cache boundary.
  - Harness: **not-applicable**.
  - Minimum assertions: none; required integration tests cover both provider lanes and an actual MCP transport.

### Critical Flows

- `WorkItem.id → runOneSpawnAttempt → createProviderAdapter/assembly → runTurn → Claude send or Lane B bridge`.
- Cached MCP factory/reference reuse across A, B, an older caller, and no context; separate runner isolation.
- Hook creation and inline delegate execution retain the originating work-item identity.
- Boss identity is available to the worker-pool handler but is excluded from the durable claim and detached worker execution; the later `worker:<claimId>` WorkItem retains its own existing ID.
- Runtime context growth leaves callback source documents, memory writes, tool schemas/results, prompts, and external MCP configuration unchanged.

### Regression Surface

- Provider ABI version 1 and existing seven-required-field callers.
- In-process server ordering, caching, enablement, workflow gating, and worker/scribe `suppressAutoInjectedServers` containment.
- `TURN_CONTEXT_DEPENDENT_SERVERS`, delegate restrictions, external transport configuration, and provider/tool argument schemas.
- Existing outage replay ID preservation, deadline continuation ID derivation, retry/session replacement, and scheduled/worker re-entry producers.
- Explicit callback/claim source projections and structured-memory save arguments.

### Commands

Run all commands from the eventual KPR-453 child implementation worktree, with Node 24. Paths below are repository-relative.

- Unit: `npx vitest run src/agents/agent-runner.test.ts src/callback/callback-mcp-server.test.ts src/memory/structured-memory-mcp-server.test.ts src/workers/meeting-worker-pool.test.ts src/workers/meeting-scribe.test.ts scripts/provider-work-item-context.test.ts`
- Integration: `npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/turn-scaffold.test.ts src/agents/provider-adapters/tool-bridge.test.ts`
- E2E: not applicable.
- Focused producer/containment regression: `npx vitest run src/outage/outage-replay-processor.test.ts src/channels/deadline-continuation.test.ts src/channels/dispatcher.test.ts src/workers/worker-pool-mcp-server.test.ts`
- Broader regression and submission gate: `npm run check`.
- Direct compiled ABI fixture: `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module Node16 --moduleResolution Node16 --esModuleInterop --skipLibCheck test-fixtures/provider-abi/work-item-context.ts`.

Expected for each Vitest command: exit 0, all selected tests pass, no skipped KPR-453 cases. Expected for the direct compiler: exit 0 with no diagnostics. Expected for `npm run check`: typecheck, lint, format check, and full tests all exit 0; pre-existing lint warnings are not a new pass/fail policy.

### Harness Requirements

- Install locked dependencies with `npm ci` if this child worktree lacks them. Use Node 24; no provider credentials, Slack access, real Mongo/Qdrant/Ollama, or running Hive service is needed.
- Reuse `makeFakeInProcessDb`, `makeFakeDb`, `makeFixture`, `makeRunner`, `makeBridge`, and `TestScaffoldAdapter` in their owning test files. Restore spies/config overrides in `finally`/existing cleanup.
- Add one compiler fixture and a Vitest wrapper below. Root `tsconfig.json` excludes `*.test.ts`; passing Vitest transpilation alone does not verify the published type.
- Preserve existing manager test isolation of `HIVE_HOME` and real MCP bridge closure in `finally`. Use temporary/mock files already provided by the suites.

### Non-Required Rationale

- E2E: live provider/Slack/deployment tests are unnecessary for the internal data-flow contract; fake-provider integration plus real MCP transport covers the changed seams deterministically.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Run targeted checks as each seam changes, then one full `npm run check` before submission. Do not claim these checks ran during drafting.
- Preserve exact supplied IDs, including unusual strings and empty strings; no fallback to timestamps/session/thread, normalization, validation, or new generator.

## File map and invariants

| File | Responsibility/change |
| --- | --- |
| `src/agents/agent-runner.ts` | Optional public identity type; internal mutable-reference type and field; per-invocation refresh; twelve MCP wiring paths. |
| `src/agents/agent-manager.ts` | Attach `ctx.workItem.id` before provider assembly. |
| `src/memory/memory-mcp-server.ts` | Optional runtime-reference dependency on `MemoryToolDeps`. |
| `src/events/event-bus-mcp-server.ts` | Optional runtime-reference dependency on `EventBusToolDeps`; update stale context comment. |
| `src/contacts/contacts-mcp-server.ts` | Optional runtime-reference dependency on `ContactsToolDeps`. |
| `src/schedule/schedule-mcp-server.ts` | Optional runtime-reference dependency on `ScheduleToolDeps`. |
| `src/team/team-mcp-server.ts` | Optional runtime-reference dependency on `TeamToolDeps`. |
| `src/admin/admin-mcp-server.ts` | Optional runtime-reference dependency on `AdminToolDeps`. |
| `src/code-index/code-search-mcp-server.ts` | Optional runtime-reference dependency on `CodeSearchToolDeps`. |
| `src/workflow/workflow-mcp-server.ts` | Optional runtime-reference dependency on `WorkflowToolDeps`. |
| `src/team-roster/team-roster-mcp-server.ts` | Optional second factory/builder reference argument. |
| `src/callback/callback-mcp-server.ts` | Optional identity in context and alternate turn deps; explicit alternate projection. |
| `src/memory/structured-memory-mcp-server.ts` | Optional identity in context and alternate turn deps; explicit alternate projection. |
| `src/workers/meeting-worker-pool.ts` | Optional runtime context field and role input field; accurate comments; retain claim projection. |
| `test-fixtures/provider-abi/work-item-context.ts` (new) | Compile old/enriched caller objects against the existing ABI re-export. |
| `scripts/provider-work-item-context.test.ts` (new) | Run that fixture through the real compiler as part of `npm run check`. |
| Existing tests named in the tasks below | Exercise boundaries and negative persistence/absence cases. |

No changes are planned to `WorkItem`, event schemas, persistence types/collections, provider ABI exports/version, `tool-bridge.ts`, `turn-assembly.ts`, `turn-scaffold.ts`, or `claude-agent-adapter.ts`: their existing full-context forwarding is verified through tests. Keep the work one child implementation: it is one propagation contract, not independent features.

## Task 1: Add the compatible identity type and compiled ABI contract

**Files:** Modify `src/agents/agent-runner.ts:148`; create `test-fixtures/provider-abi/work-item-context.ts` and `scripts/provider-work-item-context.test.ts`. Read `src/agents/provider-adapters/provider-abi.ts:127`; leave its ABI version unchanged.

- [ ] **Step 1:** Replace the context declaration and add the internal reference type beside it:

```typescript
export interface WorkItemContext {
  /**
   * Exact ID of the represented WorkItem. Engine-managed turns supply it;
   * compatible callers and invocations without a WorkItem may omit it.
   */
  workItemId?: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

/** Runner-owned runtime context for cached in-process MCP builders. */
export interface WorkItemContextRef {
  current: WorkItemContext | undefined;
}
```

The new reference type is an internal type-only dependency, not an addition to `provider-abi.ts`'s public exports.

- [ ] **Step 2:** Create the complete compile fixture:

```typescript
import type { WorkItemContext, LANE_B_PROVIDER_ABI_VERSION } from "../../src/agents/provider-adapters/provider-abi.js";

export const currentAbi: typeof LANE_B_PROVIDER_ABI_VERSION = 1;

export const legacy: WorkItemContext = {
  adapterId: "slack-main",
  channelId: "C-identity",
  channelKind: "slack",
  channelLabel: "general",
  threadId: "thread-shared",
  slackTs: "100.2",
  slackThreadTs: "100.1",
};

export const enriched: WorkItemContext = {
  ...legacy,
  workItemId: " work:opaque/Ω#dl1 ",
};

export const unavailable: string | undefined = legacy.workItemId;
export const supplied: string | undefined = enriched.workItemId;

// @ts-expect-error Identity is an optional string, never a number.
export const invalid: WorkItemContext = { ...legacy, workItemId: 42 };
```

- [ ] **Step 3:** Create the complete test wrapper. The 60-second test limit is local to this compiler test; do not increase the suite-wide timeout.

```typescript
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("KPR-453: published WorkItemContext accepts old and enriched callers", () => {
  const require = createRequire(import.meta.url);
  const fixture = fileURLToPath(
    new URL("../test-fixtures/provider-abi/work-item-context.ts", import.meta.url),
  );
  const result = spawnSync(process.execPath, [
    require.resolve("typescript/bin/tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--target", "ES2022",
    "--module", "Node16",
    "--moduleResolution", "Node16",
    "--esModuleInterop",
    "--skipLibCheck",
    fixture,
  ], { encoding: "utf8", timeout: 45_000 });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 60_000);
```

- [ ] **Step 4:** Run `npx prettier --write src/agents/agent-runner.ts test-fixtures/provider-abi/work-item-context.ts scripts/provider-work-item-context.test.ts`, then `npx vitest run scripts/provider-work-item-context.test.ts` and `npm run typecheck`. Expect exit 0. The fixture fails if identity is removed, made required, or widened away from string.
- [ ] **Step 5:** After verification, commit only these three files: `git commit -m "feat: add optional work item identity to provider context"`.

## Task 2: Supply live context to the nine factories without existing projections

**Files:** Modify `src/agents/agent-runner.ts:380,1459` and the nine MCP modules in the file map.

- [ ] **Step 1:** Add this type-only import to each of the eight dependency-object modules:

```typescript
import type { WorkItemContextRef } from "../agents/agent-runner.js";
```

Add the following exact member to `MemoryToolDeps`, `EventBusToolDeps`, `ContactsToolDeps`, `ScheduleToolDeps`, `TeamToolDeps`, `AdminToolDeps`, `CodeSearchToolDeps`, and `WorkflowToolDeps`:

```typescript
  /** Optional live runtime context; never copy it into a stored document. */
  workItemContext?: WorkItemContextRef;
```

Each existing `create…McpServer(deps)` already invokes `build…Tools(deps)` with the complete object. Keep that forwarding and existing handler bodies. The future consumer reads `deps.workItemContext?.current?.workItemId` when executing; do not snapshot a scalar at factory construction or add a no-op read/log/tool result now.

- [ ] **Step 2:** In `src/team-roster/team-roster-mcp-server.ts`, add the same type-only import, change the builder signature to the following, and replace the factory with the code below. The underscore documents that this ticket supplies the reference for subsequent consumers without introducing a synthetic read.

```typescript
export function buildTeamRosterTools(roster: TeamRoster, _workItemContext?: WorkItemContextRef) {
```

Keep the existing builder body unchanged.

```typescript
export function createTeamRosterMcpServer(roster: TeamRoster, workItemContext?: WorkItemContextRef) {
  return createSdkMcpServer({
    name: "team-roster",
    version: "0.1.0",
    tools: buildTeamRosterTools(roster, workItemContext),
  });
}
```

- [ ] **Step 3:** Add a runner instance field beside the existing context references:

```typescript
  private readonly workItemContextRef: WorkItemContextRef = { current: undefined };
```

Make this the first statement in `buildInProcessServers(context)`, before the server map and every enablement/cache branch:

```typescript
    this.workItemContextRef.current = context;
```

Update the nine factory calls exactly as follows. In the five multi-line dependency objects, insert `workItemContext: this.workItemContextRef,` without replacing/removing their existing dependencies:

| Call | Exact change |
| --- | --- |
| `createMemoryMcpServer({ … })` | Add `workItemContext: this.workItemContextRef,`; preserve scopes and the complete `onWrite` closure. |
| `createEventBusMcpServer({ … })` | Add the member; retain subscriber JSON. |
| `createTeamMcpServer({ … })` | Add the member; retain live `getAgentIds`. |
| `createAdminMcpServer({ … })` | Add the member; retain capabilities, lifecycle, provider IDs. |
| `createWorkflowMcpServer({ … })` | Add the member; retain subscriber JSON and workflow gate. |
| `createContactsMcpServer({ db: this.db })` | Replace with `createContactsMcpServer({ db: this.db, workItemContext: this.workItemContextRef })`. |
| `createScheduleMcpServer({ db: this.db, agentId: this.agentConfig.id })` | Replace with `createScheduleMcpServer({ db: this.db, agentId: this.agentConfig.id, workItemContext: this.workItemContextRef })`. |
| `createCodeSearchMcpServer({ db: this.db })` | Replace with `createCodeSearchMcpServer({ db: this.db, workItemContext: this.workItemContextRef })`. |
| `createTeamRosterMcpServer(this.teamRoster)` | Replace with `createTeamRosterMcpServer(this.teamRoster, this.workItemContextRef)`. |

Do not add these servers to `TURN_CONTEXT_DEPENDENT_SERVERS`. Diagnostic availability does not introduce a routing dependency or change worker/delegate permissions.

- [ ] **Step 4:** Replace the stale contacts wiring comment with `// KPR-122: contacts MCP — cached server with optional live runtime context.` In the event-bus module's header replace “no per-turn context is needed” with “subscriber and agent configuration are constructor-stable; optional runtime identity arrives through the runner-owned context reference.” Update the adjacent runner cache comments to distinguish stable configuration from refreshed runtime context. No unrelated comment cleanup.
- [ ] **Step 5:** Run `npm run typecheck` and `npx vitest run src/agents/agent-runner.test.ts src/team-roster/team-roster-mcp-server.test.ts src/events/event-bus-mcp-server.test.ts`. Expect existing callers without the optional dependency to pass. Complete Task 3's unified lifecycle test before committing Tasks 2–3 together.

## Task 3: Extend the three projections and verify all cached factories

**Files:** Modify `src/callback/callback-mcp-server.ts:15,194,207`, `src/memory/structured-memory-mcp-server.ts:17,542,553`, `src/workers/meeting-worker-pool.ts:71,579`, `src/agents/agent-runner.ts:1587,1614,1637`, and `src/agents/agent-runner.test.ts`.

- [ ] **Step 1:** Add this exact member to `CallbackTurnContext`, `CallbackTurnDeps`, `StructuredMemoryTurnContext`, `StructuredMemoryTurnDeps`, `WorkerPoolTurnContext`, and `runRoleTurn`'s existing structural `workItemContext` type:

```typescript
  /** Identity of this runtime invocation, when it represents a WorkItem. */
  workItemId?: string;
```

Keep the role type's seven existing fields required. Replace “The WorkItemContext seven” and the role “seven-required shape” comments with descriptions of transport/thread metadata plus optional runtime identity. The real fetch-worker/scribe producers continue omitting the field.

- [ ] **Step 2:** Add `workItemId: context?.workItemId,` to each replacement `.current` object for `callbackContextRef`, `workerPoolContextRef`, and `structuredMemoryContextRef` in the runner. Keep every existing projected field.

Add `workItemId: deps.workItemId,` to the callback alternate builder's `current` object. Replace the structured-memory alternate builder's projection with:

```typescript
    current: {
      workItemId: deps.workItemId,
      channelId: deps.channelId,
      threadId: deps.threadId,
    },
```

Preserve `schedule_callback`'s explicit `source` object, `MeetingWorkerPool.dispatch`'s explicit `WorkerClaimDoc.source` object, and `MemoryStore.save`'s existing arguments. Never spread the enriched turn into any stored object.

- [ ] **Step 3:** In `agent-runner.test.ts`, import `WorkItemContext` as a type and add this complete helper alongside `makeFakeInProcessDb`:

```typescript
function identityContext(workItemId?: string): WorkItemContext {
  return {
    ...(workItemId === undefined ? {} : { workItemId }),
    adapterId: "slack-main",
    channelId: "C-identity",
    channelKind: "slack",
    channelLabel: "conf-identity",
    threadId: "shared-thread",
    slackTs: "100.2",
    slackThreadTs: "100.1",
  };
}
```

Add this complete lifecycle test as a new top-level test. It spies on real factory exports called by the runner, so it tests the dependency boundary without production-only observer hooks or diagnostic tools. Existing memory/structured-memory wrapping mocks remain valid; all spies call through and are restored.

```typescript
it("KPR-453: every enabled cached MCP gets live identity without cross-runner leakage", async () => {
  const modules = await Promise.all([
    import("../team-roster/team-roster-mcp-server.js"),
    import("../memory/memory-mcp-server.js"),
    import("../events/event-bus-mcp-server.js"),
    import("../contacts/contacts-mcp-server.js"),
    import("../schedule/schedule-mcp-server.js"),
    import("../team/team-mcp-server.js"),
    import("../admin/admin-mcp-server.js"),
    import("../code-index/code-search-mcp-server.js"),
    import("../workflow/workflow-mcp-server.js"),
    import("../callback/callback-mcp-server.js"),
    import("../workers/worker-pool-mcp-server.js"),
    import("../memory/structured-memory-mcp-server.js"),
  ]);
  const names = [
    "team-roster", "memory", "event-bus", "contacts", "schedule", "team",
    "admin", "code-search", "workflow", "callback", "worker-pool", "structured-memory",
  ];
  const exports = [
    "createTeamRosterMcpServer", "createMemoryMcpServer", "createEventBusMcpServer",
    "createContactsMcpServer", "createScheduleMcpServer", "createTeamMcpServer",
    "createAdminMcpServer", "createCodeSearchMcpServer", "createWorkflowMcpServer",
    "createCallbackMcpServer", "createWorkerPoolMcpServer", "createStructuredMemoryMcpServer",
  ];
  const spies = modules.map((module, i) => vi.spyOn(module as any, exports[i]));
  const { config } = await import("../config.js");
  const oldWorkflow = config.workflow.enabled;
  const makeIdentityRunner = () => new AgentRunner(
    makeAgentConfig({
      coreServers: ["memory", "event-bus", "contacts", "admin", "code-search", "callback", "worker-pool"],
      autonomy: { externalComms: true, codeTask: false, codeAccess: true },
    }),
    makeMockMemoryManager() as any,
    [], new Map(), "{}", undefined,
    { getTeam: vi.fn(), lookupHuman: vi.fn(), lookupAgent: vi.fn() } as any,
    makeFakeInProcessDb(), undefined, undefined,
    { workerPool: { dispatch: vi.fn(), status: vi.fn(), cancel: vi.fn() } as any },
  );
  const refAt = (index: number, call: number): any => {
    const args = spies[index].mock.calls[call] as any[];
    return index === 0 ? args[1] : index >= 9 ? args[0].context : args[0].workItemContext;
  };
  try {
    config.workflow.enabled = true;
    spies.forEach((spy) => spy.mockClear());
    const first = makeIdentityRunner();
    const second = makeIdentityRunner();
    const a = identityContext(" work:A/Ω ");
    const servers = first.buildInProcessServers(a);
    expect(Object.keys(servers)).toEqual(names);
    const refs = names.map((_, i) => refAt(i, 0));
    for (const ref of refs) expect(ref.current.workItemId).toBe(a.workItemId);
    for (const ref of refs.slice(0, 9)) expect(ref).toBe(refs[0]);
    expect(refs[0].current).toBe(a);

    second.buildInProcessServers(identityContext("other-runner"));
    const otherRefs = names.map((_, i) => refAt(i, 1));
    otherRefs.forEach((ref, i) => expect(ref).not.toBe(refs[i]));

    for (const next of [identityContext("B"), identityContext(), undefined]) {
      const nextServers = first.buildInProcessServers(next);
      expect(Object.keys(nextServers)).toEqual(names);
      for (const name of names) expect(nextServers[name]).toBe(servers[name]);
      refs.forEach((ref) => expect(ref.current?.workItemId).toBe(next?.workItemId));
      otherRefs.forEach((ref) => expect(ref.current.workItemId).toBe("other-runner"));
      spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(2));
    }
    expect(refs[0].current).toBeUndefined();
    const empty = new AgentRunner(makeAgentConfig({ coreServers: [] }),
      makeMockMemoryManager() as any, [], new Map(), "{}", undefined, undefined,
      undefined, undefined, undefined, { suppressAutoInjectedServers: true });
    expect(empty.buildInProcessServers(a)).toEqual({});
    expect(empty.buildInProcessServers()).toEqual({});
  } finally {
    config.workflow.enabled = oldWorkflow;
    spies.forEach((spy) => spy.mockRestore());
  }
});
```

If an enabled-server expectation differs, inspect the existing constructor/gates; do not add servers or relax containment to satisfy this test. The expected ordering above matches `buildInProcessServers`.

- [ ] **Step 4:** Update the existing worker-pool wiring test around line 4134: rename its “seven” description to “transport metadata and identity”; supply `workItemId: "boss-A"` in the first context and its exact expected projection. After the older partial-context second invocation, assert `ref.current.workItemId` is undefined. This also updates the existing exact-object assertion for the newly projected optional property.
- [ ] **Step 5:** Run `npx prettier --write` on every source/test changed by Tasks 2–3, then `npm run typecheck` and `npx vitest run src/agents/agent-runner.test.ts src/callback/callback-mcp-server.test.ts src/memory/structured-memory-mcp-server.test.ts src/workers/worker-pool-mcp-server.test.ts src/team-roster/team-roster-mcp-server.test.ts`. Expect exit 0 and the new twelve-factory lifecycle test to pass.
- [ ] **Step 6:** Stage the exact Tasks 2–3 source/test files and commit: `git commit -m "feat: carry live work item context into cached MCP builders"`.

## Task 4: Populate identity at the manager boundary and pin provider/retry semantics

**Files:** Modify `src/agents/agent-manager.ts:1941`, `src/agents/agent-manager.test.ts`, `src/agents/provider-adapters/claude-agent-adapter.test.ts`, and `src/agents/provider-adapters/turn-assembly.test.ts`.

- [ ] **Step 1:** Add the source field as the first property of `bgContext`:

```typescript
      workItemId: ctx.workItem.id,
```

Keep this object before `createProviderAdapter` and pass it to `adapter.runTurn` as today. Do not alter any producer, retry branch, or provider implementation.

- [ ] **Step 2:** Inside `spawnTurn shaping (KPR-224)`, use the existing `makeCtx` helper to add the complete Claude mapping test:

```typescript
it.each(["slack", "sms"] as const)("KPR-453: exact %s work identity reaches Claude send", async (kind) => {
  const item = makeWorkItem({
    id: " work:source/Ω#dl1 ",
    threadId: "shared-thread",
    source: { kind, id: "channel-identity", label: "Identity" },
    meta: { slackTs: "100.2", slackThreadTs: "100.1" },
  });
  await manager.spawnTurn(makeCtx(item, kind, "provider-session"));
  const context = mockRunnerSend.mock.calls.at(-1)![3];
  expect(context).toMatchObject({
    workItemId: item.id,
    threadId: "shared-thread",
    slackTs: "100.2",
    slackThreadTs: "100.1",
    channelKind: kind,
  });
  expect([context.threadId, context.slackTs, "provider-session"]).not.toContain(context.workItemId);
});
```

Add a distinct-item same-thread case in the same describe block:

```typescript
it("KPR-453: two items sharing a thread retain independent identity", async () => {
  for (const id of ["first-item", "second-item"]) {
    const item = makeWorkItem({ id, threadId: "same-thread" });
    await manager.spawnTurn(makeCtx(item, "slack", "session-1"));
  }
  expect(mockRunnerSend.mock.calls.map((call) => call[3].workItemId))
    .toEqual(["first-item", "second-item"]);
});
```

- [ ] **Step 3:** Extend the existing KPR-347 non-empty-inventory Lane B test around line 4816. Give its SMS item `id: "sms-work-opaque"`; after the existing assembly assertions, add:

```typescript
const assembledContext = mockRunnerToolInventory.mock.calls.at(-1)![0];
const turnContext = mockCodexRunTurn.mock.calls.at(-1)![0].workItemContext;
expect(assembledContext.workItemId).toBe(item.id);
expect(turnContext).toBe(assembledContext);
expect(turnContext.threadId).toBe(item.threadId);
```

This uses real manager assembly and the existing provider stub. In `turn-assembly.test.ts`, add a separate exact-object seam test using its existing `makeRunner` and `makeAgentConfig` helpers:

```typescript
it("KPR-453: assembly passes complete context into in-process construction", async () => {
  const context = {
    workItemId: "assembly-item",
    adapterId: "sms", channelId: "line-1", channelKind: "sms",
    channelLabel: "Identity", threadId: "same-thread", slackTs: "", slackThreadTs: "",
  };
  const runner = makeRunner([]);
  await assembleProviderTurn({ runner, config: makeAgentConfig(), provider: "codex", workItemContext: context });
  expect(runner.buildToolTransportInventory).toHaveBeenCalledWith(context);
  expect(runner.buildInProcessServers).toHaveBeenCalledWith(context);
  expect(runner.resolveTurnCwd).toHaveBeenCalledWith(context);
});
```

- [ ] **Step 4:** Extend both existing `KPR-399 fresh retry drops handle AND mark` and `auth-rebuild retry drops handle AND mark` cases around lines 6684–6708, after their current assertions, with:

```typescript
expect(mockRunnerSend.mock.calls.map((call) => call[3].workItemId))
  .toEqual([ctx.workItem.id, ctx.workItem.id]);
```

These already exercise a changed/cleared provider session, so this adds a meaningful independence assertion without duplicating retry setup.

- [ ] **Step 5:** In the existing Claude adapter “current Hive turn shape” test, add `workItemId: "claude-item"` to the supplied context and assert `runner.send.mock.calls[0][3]` is the same context object. Keep the existing absent-context test and all positional arguments.
- [ ] **Step 6:** Format the four modified files. Run `npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/provider-adapters/turn-assembly.test.ts` and `npm run typecheck`; expect exit 0. Commit those exact files with `git commit -m "feat: attach originating work item identity before provider assembly"`.

## Task 5: Verify hooks, bridge execution, and inline delegates

**Files:** Modify `src/agents/agent-runner.test.ts`, `src/agents/provider-adapters/tool-bridge.test.ts`, `src/agents/provider-adapters/turn-scaffold.test.ts`, and `src/agents/agent-manager.test.ts`. Production forwarding already exists.

- [ ] **Step 1:** In the existing hook-rebuild test around `agent-runner.test.ts:3209`, replace its partial A/B fixtures with `identityContext("hook-A")` and `identityContext("hook-B")`. Invoke `buildHooks` once more with `identityContext()` and once without context. Assert the captured array equals those exact four inputs and IDs are `["hook-A", "hook-B", undefined, undefined]`. Keep the existing archetype setup, PreCompact coverage, and deny-all tests.
- [ ] **Step 2:** In `tool-bridge.test.ts`, import `GuardrailToolCall` from `./types.js` as a type and replace the existing T6 “reads a mutable ContextRef” test with this complete test using its existing helpers. This is a test-only echo tool; production tools retain their schemas and results.

```typescript
it("KPR-453: real MCP round trip and gate retain exact work identity", async () => {
  const context = {
    workItemId: "bridge-item/Ω",
    adapterId: "slack", channelId: "C1", channelKind: "slack",
    channelLabel: "general", threadId: "shared-thread", slackTs: "100.2", slackThreadTs: "100.1",
  };
  const contextRef: { current: typeof context | undefined } = { current: context };
  const gate = vi.fn(async (_call: GuardrailToolCall) => ({ behavior: "allow" as const }));
  const inProcess = makeInProcessServer((server) =>
    server.registerTool("echo_context", { description: "", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: contextRef.current?.workItemId ?? "unavailable" }],
    })),
  );
  const bridge = makeBridge({
    inventory: [makeEntry({ name: "ctx", transport: "sdk-in-process", serverConfig: undefined })],
    inProcessServers: { ctx: inProcess }, workItemContext: context, gate,
  });
  try {
    const tools = await bridge.connect();
    expect(tools[0].inputSchema.properties).not.toHaveProperty("workItemId");
    expect(await tools[0].execute({})).toBe("bridge-item/Ω");
    expect(gate.mock.calls[0][0].workItemContext).toBe(context);
    contextRef.current = { ...context, workItemId: "next-item" };
    expect(await tools[0].execute({})).toBe("next-item");
    contextRef.current = undefined;
    expect(await tools[0].execute({})).toBe("unavailable");
  } finally {
    await bridge.close();
  }
});
```

The direct bridge's gate remains bound to its own turn context; only the fixture handler reference changes here. The runner lifecycle test establishes that the real cached factory references refresh correctly; the next test establishes each real scaffold turn creates a bridge with its own request context.

- [ ] **Step 3:** Add a scaffold integration case using the real bridge and a minimal Task delegate. Import `HiveToolInventoryEntry` from `./tool-transport.js`, `GuardrailToolCall` from `./types.js`, and `DelegateTurnCall` from `./turn-assembly.js` as types. Reuse the following code inside `turn-scaffold.test.ts`:

```typescript
it("KPR-453: each scaffold turn supplies its context to gate and inline delegate", async () => {
  const delegateRunner = vi.fn(async (_call: DelegateTurnCall) => "delegate result");
  const gate = vi.fn(async (_call: GuardrailToolCall) => ({ behavior: "allow" as const }));
  const entry: HiveToolInventoryEntry = {
    name: "fixture", transport: "claude-subagent", source: "delegate",
    requiresTurnContext: false, requiresHiveRuntime: false, inProcess: false,
    compatibility: {
      claude: "direct", openai: "requires-hive-bridge", gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge", grok: "requires-hive-bridge",
    },
    schemas: { kind: "unavailable" }, description: "Fixture delegate",
  };
  const adapter = new TestScaffoldAdapter(async (harness) => {
    const tools = await harness.bridge.connect();
    const task = tools.find((tool) => tool.name === "Task")!;
    expect(await task.execute({ description: "fixture", prompt: "do it", subagent_type: "fixture" }))
      .toBe("delegate result");
    return { kind: "success", text: "done", sessionId: "same-session" };
  }, makeAssembly({ toolInventory: [entry], guardrailGate: gate, delegateTurnRunner: delegateRunner }));
  const base = {
    adapterId: "sms", channelId: "line-1", channelKind: "sms", channelLabel: "Identity",
    threadId: "same-thread", slackTs: "", slackThreadTs: "",
  };
  const contexts = [{ ...base, workItemId: "scaffold-A" }, { ...base, workItemId: "scaffold-B" }, base, undefined];
  for (const context of contexts) {
    await adapter.runTurn(req({ workItemContext: context, sessionId: "same-session" }));
    expect(gate.mock.calls.at(-1)![0].workItemContext).toBe(context);
    expect(delegateRunner.mock.calls.at(-1)![0].workItemContext).toBe(context);
  }
  expect(closeSpy).toHaveBeenCalledTimes(4);
});
```

- [ ] **Step 4:** In `tool-bridge.test.ts`'s existing KPR-354 shared `workItemContext` fixture around line 840, add `workItemId: "inline-origin"`; the existing full `DelegateTurnCall` assertion then pins the additional field. Add an identity reference assertion on the captured `runner.mock.calls[0][0].workItemContext`.

In `agent-manager.test.ts`'s existing KPR-354 happy-path nested delegate test, replace `await call(runner)` with the following invocation and retain all existing assertions:

```typescript
const parentContext = {
  workItemId: "nested-origin", adapterId: "sms", channelId: "line-1", channelKind: "sms",
  channelLabel: "Identity", threadId: "same-thread", slackTs: "", slackThreadTs: "",
};
expect(await runner({
  delegate: "google", prompt: "p", entry: makeSubagentEntry(),
  signal: new AbortController().signal, workItemContext: parentContext,
})).toBe("delegate output");
expect(mockOpenAIRunTurn.mock.calls.at(-1)![0].workItemContext).toBe(parentContext);
```

- [ ] **Step 5:** Format the four changed files. Run `npx vitest run src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/turn-scaffold.test.ts`. Expect exit 0, all bridges closed, no live provider calls. Commit those exact tests with `git commit -m "test: pin work item identity through hooks and provider tools"`.

## Task 6: Pin runtime-only persistence and detached-role boundaries, then verify

**Files:** Modify `src/callback/callback-mcp-server.test.ts`, `src/memory/structured-memory-mcp-server.test.ts`, `src/workers/meeting-worker-pool.test.ts`, and `src/workers/meeting-scribe.test.ts`.

- [ ] **Step 1:** Extend the existing callback source-projection test's first context with `workItemId: "callback-origin"`. Keep its mutable context typed as `{ current: CallbackTurnContext }` so the subsequent ID-less assignment is valid. After the first handler result, add:

```typescript
expect(inserted[0]).not.toHaveProperty("workItemId");
expect(inserted[0].source).not.toHaveProperty("workItemId");
expect(JSON.stringify(inserted[0])).not.toContain("callback-origin");
expect(JSON.stringify(res)).not.toContain("callback-origin");
expect(Object.keys(inserted[0].source).sort()).toEqual([
  "adapterId", "channelId", "channelKind", "channelLabel", "slackThreadTs", "slackTs", "threadId",
]);
```

Import `buildCallbackMcpForTurn` and the context type. Add the alternate-builder projection regression:

```typescript
it("KPR-453: alternate callback builder reads supplied runtime identity", () => {
  const identity = vi.fn(() => "alternate-callback");
  buildCallbackMcpForTurn({
    db: makeFakeDb({ inserted: [] }), agentId: "alice",
    get workItemId() { return identity(); },
  });
  expect(identity).toHaveBeenCalledTimes(1);
  expect(() => buildCallbackMcpForTurn({
    db: makeFakeDb({ inserted: [] }), agentId: "alice",
  })).not.toThrow();
});
```

The accessor is a narrow regression pin for the alternate builder's explicit copy; it must fail if that field is dropped from its projection. It is not evidence of persistence or handler consumption. Review the literal `current.workItemId: deps.workItemId` assignment alongside the runner's captured-reference tests; do not introduce a production observer API.

- [ ] **Step 2:** Extend the existing structured-memory channel/thread test's first context with `workItemId: "memory-origin"`, typed as `{ current: StructuredMemoryTurnContext }`. Keep the complete existing five-argument `mockSave` assertion and add:

```typescript
expect(mockSave.mock.calls[0]).toHaveLength(5);
expect(JSON.stringify(mockSave.mock.calls[0])).not.toContain("memory-origin");
expect(JSON.stringify(res)).not.toContain("memory-origin");
```

Import `buildStructuredMemoryMcpForTurn` and add the complete alternate-builder regression:

```typescript
it("KPR-453: alternate structured-memory builder reads supplied runtime identity", () => {
  const identity = vi.fn(() => "alternate-memory");
  buildStructuredMemoryMcpForTurn({
    db: { collection: () => ({}) } as any, agentId: "alice",
    get workItemId() { return identity(); },
  });
  expect(identity).toHaveBeenCalledTimes(1);
  expect(() => buildStructuredMemoryMcpForTurn({
    db: { collection: () => ({}) } as any, agentId: "alice",
  })).not.toThrow();
});
```

The same accessor limitation applies. No new memory arguments, metadata keys, or schema fields are permitted.

- [ ] **Step 3:** In the worker-pool T4 completion/re-entry test, dispatch with `dispatchReq("fetch Q2 numbers", "boss", { ...meetingCtx, workItemId: "boss-origin" })` instead of its current request. Keep the existing `worker:<claimId>` assertion and add:

```typescript
expect(doc).not.toHaveProperty("workItemId");
expect(doc.source).not.toHaveProperty("workItemId");
expect(JSON.stringify(doc)).not.toContain("boss-origin");
expect(f.runTurn.mock.calls[0][0].workItemContext).not.toHaveProperty("workItemId");
expect(JSON.stringify(item)).not.toContain("boss-origin");
```

This proves the originating boss ID reaches an enriched pool context but is excluded from stored claims and detached execution. Keep `workItemContextFromClaim` unchanged.

In the existing `MeetingWorkerPool — runRoleTurn` describe block, add:

```typescript
it("KPR-453: role callers can supply identity without changing detached defaults", async () => {
  const f = makeFixture();
  const args = roleArgs();
  expect(args.workItemContext).not.toHaveProperty("workItemId");
  const context = { ...args.workItemContext, workItemId: "explicit-role-item" };
  await f.pool.runRoleTurn({ ...args, workItemContext: context });
  expect(f.runTurn.mock.calls[0][0].workItemContext).toBe(context);
  expect(f.claims.docs).toHaveLength(0);
  expect(f.onDispatch).not.toHaveBeenCalled();
});
```

- [ ] **Step 4:** In the scribe “D2a: pins role params, containment, workItemContext” test, keep its exact old-shape expectation and additionally assert `expect(call.workItemContext).not.toHaveProperty("workItemId")`. Replace the nearby “All seven workItemContext fields” comment with “Detached role transport metadata; no represented WorkItem.” Do not change `meeting-scribe.ts`.
- [ ] **Step 5:** Format the four changed tests; run the Unit, Integration, and focused producer/containment commands from the Testing Contract. Expect all selected tests to pass. The unchanged outage replay/deadline tests establish producer semantics remain intact; no new ID producers are needed.
- [ ] **Step 6:** Inspect the complete diff with `git diff --check` and `git diff`. Verify only the file map/test additions changed; no event/logging code, persistence schema, tool input/output schema, external MCP environment, prompt text, routing policy, or ABI version changed. Verify all type imports from MCP modules are `import type` and `WorkItemContextRef` is instance-owned.
- [ ] **Step 7:** Run `npm run check` and record exact exit status/results in the child delivery handoff. Do not broaden tests again unless a change/failure warrants it. Commit the verified tests with `git commit -m "test: preserve runtime-only identity and detached worker boundaries"`.

## Handoff and assumptions

- Plan implementation order is Tasks 1 → 2–3 → 4 → 5–6. Tests can be developed alongside their owning code; avoid concurrent edits to `agent-runner.ts` or its shared test file.
- The optional public identity contract, runtime-only projection, and unavailable detached identity are approved spec decisions, not new product questions.
- Existing mutable-runner reuse is sequential. This ticket does not add overlapping `send()` support on one runner; parallel spawns remain separate runners.
- All in-process factories in approved spec D3 are covered. The shared reference is deliberately an internal type; downstream consumers must read `.current` at execution time.
- Review the complete plan independently, then let the dispatcher apply readiness after dependency checks. Do not self-approve, label tickets, deploy, or open/merge PRs from the planning leaf.
