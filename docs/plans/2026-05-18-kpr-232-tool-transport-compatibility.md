# KPR-232 Tool Transport Compatibility Implementation Plan

> **For agentic workers:** After this plan is approved, invoke `/spec-and-implement` for KPR-232 per this repo's workflow. The implementation worker should execute this plan through the dodi-dev implementation flow.

**Goal:** Add a provider-neutral inventory and compatibility classification for Hive tools so non-Claude provider pilots can reason about tools without consuming Claude SDK `mcpServers` directly.

**Architecture:** `AgentRunner` remains the Claude execution owner. B1 adds a read-only inventory surface and pure compatibility helpers under `provider-adapters/`, then documents the bridge strategy. No current runtime path changes.

**Tech Stack:** TypeScript, Vitest, existing Claude Agent SDK runtime, existing MCP server catalog/plugin metadata.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/agents/provider-adapters/tool-transport.ts`
  - Reason: Compatibility classification is the new behavior and future provider tickets will depend on it.
  - Minimum assertions: Claude direct support; OpenAI/Gemini bridge candidates for stdio/http/sse; Hive bridge required for context-dependent and in-process servers; `requiresTurnContext` remains separate from `requiresHiveRuntime`; Claude-only for SDK built-ins and delegate sub-agents; broken/missing tools are excluded from available inventory.

- Integration: `required`
  - Scope: `src/agents/agent-runner.test.ts`, plus existing registry/admin validation tests if shared server traits are deduplicated.
  - Reason: The inventory must match the existing server filtering, auto-injection, autonomy gates, plugin skipping, and delegate handling.
  - Harness: `existing`
- Minimum assertions: Inventory includes the same available core/delegate names that `send()` would expose; broken plugin servers are excluded; no Claude query option behavior changes.
- Special coverage: Include `team-roster` when a `TeamRoster` fixture is present because `send()` injects it after `filterCoreServers`, and include representative Claude SDK built-ins so future providers do not mistake them for portable MCP tools.

- E2E: `not-required`
  - Scope: Real provider tool calls.
  - Reason: B1 is a compatibility inventory/prototype phase. B2/B3 own provider runtime pilots.
  - Harness: `not-applicable`
  - Minimum assertions: Not applicable.

### Critical Flows

- Existing Claude turn still builds `mcpServers` and `agents` exactly as before.
- A future OpenAI/Gemini adapter can ask for a tool inventory and see which tools are bridge candidates versus Claude-only.
- Turn-context-dependent tools and Hive-runtime-backed tools remain separately identifiable before provider adapters attempt to expose them.
- Delegate sub-agents remain Claude-only and are not misclassified as portable MCP tools.
- Claude SDK plugins/native skills and hooks remain out-of-inventory Claude runtime behavior, not portable tool transports.

### Regression Surface

- `AgentRunner.send`
- `AgentRunner.buildAllServerConfigs`
- `AgentRunner.filterCoreServers`
- `AgentRunner.buildServerSubAgents`
- `AgentRegistry` delegate validation
- `admin-mcp-server` delegate validation
- `toolkit-section.ts`
- plugin MCP server loading/skipping

### Commands

- Unit: `npx vitest run src/agents/provider-adapters/tool-transport.test.ts`
- Integration: `npx vitest run src/agents/agent-runner.test.ts src/agents/agent-registry.test.ts src/admin/admin-mcp-server.test.ts`
- E2E: Not required for B1.
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- Existing Vitest mocks for `@anthropic-ai/claude-agent-sdk`.
- Existing `AgentRunner` test helpers for captured `query()` options.
- Plugin manifest fixtures in `agent-runner.test.ts`.
- No real Slack, Claude, MongoDB, Qdrant, or Keychain access required for focused tests.

### Non-Required Rationale

- E2E provider tool calls are not required because B1 does not attach tools to OpenAI/Gemini runtimes.
- A production MCP bridge process is not required because the decision/prototype artifact is the compatibility inventory.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes a current behavior change, fix the implementation.
- If testing exposes an unclear provider-compatibility decision, demote the ticket to the spec lane.

---

## File Structure

- Create `src/agents/provider-adapters/tool-transport.ts`
  - Provider-neutral descriptors, compatibility enums, pure classifier helpers.
- Create `src/agents/provider-adapters/tool-transport.test.ts`
  - Unit coverage for compatibility rules.
- Modify `src/agents/agent-runner.ts`
  - Add `buildToolTransportInventory(context?: WorkItemContext)`.
  - Reuse existing server config/filter/delegate logic.
- Modify `src/agents/agent-runner.test.ts`
  - Add inventory tests near existing server config/sub-agent tests.
- Optionally create or modify `src/agents/server-traits.ts`
  - Shared turn-context-dependent and delegate-unsafe server sets if this reduces drift without broad churn.
- Optionally modify `src/agents/agent-registry.ts` and `src/admin/admin-mcp-server.ts`
  - Consume the shared delegate-unsafe set only if low-risk and behavior-preserving.
- Modify `docs/architecture.md`
  - Document B1 compatibility inventory and future bridge strategy.

## Task 1: Add Tool Transport Types and Classifier

**Files:**
- Create: `src/agents/provider-adapters/tool-transport.ts`
- Create: `src/agents/provider-adapters/tool-transport.test.ts`

- [ ] **Step 1:** Define the provider-neutral descriptor and compatibility types.

Use the spec names unless implementation pressure suggests a clearer local naming:

```typescript
export type HiveToolTransportKind = "stdio" | "http" | "sse" | "sdk-in-process" | "claude-builtin" | "claude-subagent";

export type ProviderToolCompatibility =
  | "direct"
  | "mcp-bridge-candidate"
  | "requires-hive-bridge"
  | "claude-only"
  | "unsupported";

export interface HiveToolTransportDescriptor {
  name: string;
  transport: HiveToolTransportKind;
  source: "engine" | "core" | "plugin" | "delegate" | "sdk-builtin";
  requiresTurnContext: boolean;
  requiresHiveRuntime: boolean;
  inProcess: boolean;
  compatibility: {
    claude: ProviderToolCompatibility;
    openai: ProviderToolCompatibility;
    gemini: ProviderToolCompatibility;
  };
}
```

- [ ] **Step 2:** Add pure classifier helpers.

Minimum helper shape:

```typescript
export function classifyToolTransport(input: {
  name: string;
  transport: HiveToolTransportKind;
  source: HiveToolTransportDescriptor["source"];
  requiresTurnContext?: boolean;
  requiresHiveRuntime?: boolean;
  inProcess?: boolean;
  broken?: boolean;
}): HiveToolTransportDescriptor;
```

Rules:

- `broken` is supported by the pure classifier for diagnostic tests, but `AgentRunner.buildToolTransportInventory` must exclude broken plugin servers from available inventory.
- `claude-builtin` and `claude-subagent` are Claude `direct`, OpenAI/Gemini `claude-only`.
- `stdio`, `http`, and `sse` are Claude `direct`; OpenAI/Gemini `mcp-bridge-candidate`.
- `requiresTurnContext` makes OpenAI/Gemini `requires-hive-bridge` and sets only the per-turn metadata flag.
- `requiresHiveRuntime` makes OpenAI/Gemini `requires-hive-bridge` without implying per-turn metadata.
- `sdk-in-process` is Claude `direct`; OpenAI/Gemini `requires-hive-bridge`; set `requiresHiveRuntime: true`.

- [ ] **Step 3:** Add unit tests for each rule.

Run: `npx vitest run src/agents/provider-adapters/tool-transport.test.ts`

Expected: New unit tests pass.

## Task 2: Expose Shared Server Traits

**Files:**
- Option A create: `src/agents/server-traits.ts`
- Option B export from existing location if cleaner.
- Optional modify: `src/agents/agent-runner.ts`, `src/agents/agent-registry.ts`, `src/admin/admin-mcp-server.ts`

- [ ] **Step 1:** Add separate shared sets:

```typescript
export const TURN_CONTEXT_DEPENDENT_SERVERS = new Set<string>([
  "callback",
  "background",
  "code-task",
  "recall",
  "structured-memory",
]);

export const DELEGATE_UNSAFE_SERVERS = new Set<string>([
  ...TURN_CONTEXT_DEPENDENT_SERVERS,
  "memory",
]);
```

- [ ] **Step 2:** Use `TURN_CONTEXT_DEPENDENT_SERVERS` for `requiresTurnContext`.

Do not use `DELEGATE_UNSAFE_SERVERS` to set `requiresTurnContext`; it intentionally includes `memory` for delegate safety, but runtime memory does not consume per-turn channel/thread metadata.

- [ ] **Step 3:** If changing existing validation callers is low-risk, replace local duplicate sets with imports. If it creates broad churn, leave existing callers alone and add an inventory test that fails if the new set misses the known validation cases.

Run if callers change: `npx vitest run src/agents/agent-registry.test.ts src/admin/admin-mcp-server.test.ts`

Expected: Existing delegate validation remains unchanged.

## Task 3: Add AgentRunner Inventory Method

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1:** Import classifier helpers and shared traits.

- [ ] **Step 2:** Add `buildToolTransportInventory(context?: WorkItemContext): HiveToolTransportDescriptor[]`.

Implementation guidance:

- Build `allServerConfigs` with `buildAllServerConfigs(context)`.
- Build `mcpServers` with `filterCoreServers(allServerConfigs)`.
- For each post-filter core server:
  - Determine `transport` from `serverConfig.type`.
  - Override to `sdk-in-process` if the server is in `IN_PROCESS_PORTED_SERVERS`, `this.db` exists, and `shouldEnableInProcessServer(name)` is true.
  - Set `source` to `engine` when auto-injected, `plugin` when owned by a plugin, otherwise `core`.
  - Set `requiresTurnContext` from `TURN_CONTEXT_DEPENDENT_SERVERS`.
  - Set `requiresHiveRuntime` for `sdk-in-process` servers and any future Hive-local bridge-only descriptor.
  - Pass through the classifier.
- Add `team-roster` explicitly when `this.teamRoster` is present:
  - `transport: "sdk-in-process"`
  - `source: "engine"`
  - `requiresTurnContext: false`
  - `requiresHiveRuntime: true`
  - Claude `direct`
  - OpenAI/Gemini `requires-hive-bridge`
  - This mirrors `send()`, which injects `team-roster` after `filterCoreServers` and therefore cannot be discovered from `buildAllServerConfigs(...)`.
- For active delegate servers:
  - Reuse the same filtering conditions as `buildServerSubAgents`.
  - Add them as `transport: "claude-subagent"`, `source: "delegate"`.
  - Do not expose context-dependent delegates as bridge candidates.
- Include Claude SDK built-ins as inventory descriptors. Prefer exporting the existing toolkit-section built-in list from `src/agents/toolkit-section.ts` or moving it to a tiny shared module if that keeps duplication low.
  - Use `transport: "claude-builtin"`.
  - Use `source: "sdk-builtin"`.
  - Mark Claude as `direct`.
  - Mark OpenAI/Gemini as `claude-only`.
  - At minimum, tests must cover `Bash` and `Task`.
- Do not include Claude SDK plugins/native skills, hooks, prompt assembly, settings sources, or SDK `extraArgs` in the inventory. Document these as out-of-inventory Claude runtime behavior and future provider-specific work if needed.
- Keep result ordering deterministic: core/injected order first, then delegates.

- [ ] **Step 3:** Add tests in `agent-runner.test.ts`.

Minimum cases:

- stdio core server appears as Claude direct and OpenAI/Gemini bridge candidate.
- HTTP Slack MCP appears as bridge candidate when configured.
- in-process `memory` or `schedule` appears as `sdk-in-process` when `db` is present and requires Hive bridge for OpenAI/Gemini.
- `memory` has `requiresTurnContext: false`, `requiresHiveRuntime: true`, and OpenAI/Gemini compatibility `requires-hive-bridge`.
- in-process non-context server such as `schedule` has `requiresTurnContext: false`, `requiresHiveRuntime: true`, and OpenAI/Gemini compatibility `requires-hive-bridge`.
- `team-roster` appears as `sdk-in-process` when a `TeamRoster` fixture is present and matches the server exposed by captured `send()` options.
- `background` or `code-task` appears as `requiresTurnContext: true` and OpenAI/Gemini `requires-hive-bridge`.
- plugin stdio server appears as bridge candidate and includes `source: "plugin"`.
- broken plugin server is excluded from available inventory.
- delegate server appears as Claude sub-agent / Claude-only for non-Claude.
- representative built-ins such as `Bash` and `Task` appear as `claude-builtin` / `sdk-builtin`, Claude direct, and OpenAI/Gemini Claude-only.
- golden inventory-vs-`send()` test captures actual `mcpServers`/`agents` names for the same runner and asserts every runtime-exposed server/sub-agent has an inventory descriptor.
- autonomy gates remove `code-task` and `code-search` from inventory when disabled.

Run: `npx vitest run src/agents/agent-runner.test.ts`

Expected: Existing tests and new inventory tests pass.

## Task 4: Document the Bridge Strategy

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** Add a short subsection under the provider adapter or MCP sections:

```markdown
### Provider Tool Compatibility

Claude uses the current direct Agent SDK MCP wiring. Non-Claude adapters consume a provider-neutral tool transport inventory and may attach only tools explicitly classified as bridge candidates. Context-dependent tools require a Hive bridge that preserves WorkItemContext; in-process tools require a Hive bridge that preserves local runtime state such as Db, registry, roster, and cache objects. Claude SDK built-ins and delegated sub-agents are Claude-only until a provider-specific equivalent is designed. Claude SDK plugins/native skills and hooks are out of this inventory and remain Claude-only runtime behavior in B1.
```

- [ ] **Step 2:** Ensure docs do not imply OpenAI/Gemini runtime support exists yet.

## Task 5: Verification and Quality Gate

**Files:**
- No new files unless fixes are needed.

- [ ] **Step 1:** Run focused unit tests.

Command:

```bash
npx vitest run src/agents/provider-adapters/tool-transport.test.ts
```

- [ ] **Step 2:** Run integration tests.

Command:

```bash
npx vitest run src/agents/agent-runner.test.ts src/agents/agent-registry.test.ts src/admin/admin-mcp-server.test.ts
```

- [ ] **Step 3:** Run broader regression.

Command:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

- [ ] **Step 4:** Run whitespace check.

Command:

```bash
git diff --check
```

Expected: All required commands pass. Existing lint warnings are acceptable only if the command exits 0.

## Handoff

When implementation is complete, add evidence to KPR-232 and advance to `ready-for-child-pr` only after:

- implementation commit exists on the child branch,
- fresh implementation review is clean,
- focused tests pass,
- full quality gate passes,
- child branch is current with `epic/kpr-230-phase-b-provider-adapters`.
