# KPR-233 OpenAI Agents SDK Pilot Adapter Implementation Plan

> **For agentic workers:** After this plan is approved, invoke `/spec-and-implement` for KPR-233 per this repo's workflow. The implementation worker should execute this plan through the dodi-dev implementation flow.

**Goal:** Add a tool-free OpenAI Agents SDK provider adapter pilot that satisfies Hive's provider boundary without changing production runtime selection.

**Architecture:** `AgentManager` remains Claude-only. `OpenAIAgentsAdapter` lives beside the Claude adapter, implements `AgentProviderAdapter`, uses the OpenAI Agents SDK directly, maps results into Hive `RunResult`, and refuses tool inventory that would require a bridge.

**Tech Stack:** TypeScript, Vitest, `@openai/agents`, existing Hive provider-adapter types, existing KPR-232 tool transport descriptors.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/agents/provider-adapters/openai-agents-adapter.ts`
  - Reason: The new provider adapter must prove SDK invocation, result mapping, streaming, abort, and tool-free guardrails without real OpenAI API calls.
  - Minimum assertions: constructor/config mapping; `run(...)` options; `previousResponseId`; `maxTurns`; streaming chunks; abort result; unsupported inventory rejection.

- Integration: `required`
  - Scope: `src/agents/agent-manager.test.ts`, `src/agents/provider-adapters/claude-agent-adapter.test.ts`, `src/agents/agent-runner.test.ts`
  - Reason: Production selection must remain Claude-only and Claude runtime wiring must not change.
  - Harness: `existing`
  - Minimum assertions: Existing manager, Claude adapter, and runner tests remain green.

- E2E: `not-required`
  - Scope: Real OpenAI API call through Slack/SMS/WS/voice.
  - Reason: B2 does not expose provider selection or production routing. Real channel E2E belongs after Phase C selection.
  - Harness: `not-applicable`
  - Minimum assertions: Not applicable.

### Critical Flows

- Direct pilot instantiation runs one tool-free OpenAI turn and maps to `RunResult`.
- Direct pilot instantiation streams text into Hive's `onStream` callback.
- `abort()` cancels the active OpenAI run via `AbortSignal`.
- Existing `AgentManager.spawnTurn` still builds the Claude adapter only.
- OpenAI credentials remain optional at process boot and tests never call the network.

### Regression Surface

- `src/agents/provider-adapters/types.ts`
- `src/agents/provider-adapters/claude-agent-adapter.ts`
- `src/agents/provider-adapters/tool-transport.ts`
- `src/agents/agent-manager.ts`
- `src/agents/agent-manager.test.ts`
- `src/agents/agent-runner.ts`
- `src/config.ts`
- `package.json` / `package-lock.json`

### Commands

- Unit: `npx vitest run src/agents/provider-adapters/openai-agents-adapter.test.ts`
- Integration: `npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts`
- E2E: Not required for B2.
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- Mock `@openai/agents`; no real API calls.
- Use fake `RunResult`-like SDK result objects for non-streaming and streaming cases.
- Use a controlled promise or rejected abort error to test abort behavior.
- No real OpenAI, Slack, MongoDB, Qdrant, or Keychain access required.

### Non-Required Rationale

- Production channel E2E is not required because no channel can select OpenAI in B2.
- Tool-call E2E is not required because B2 is explicitly tool-free. KPR-232 only provides the inventory/bridge plan.
- Session-store E2E is not required because B2's `sessionId`/`previousResponseId` mapping is a pilot continuation mechanism, not the final Phase D memory boundary.

### Verification Rules

- Missing harness is not a skip reason; mock the SDK or report a concrete blocker.
- If a test failure exposes production selection changing from Claude, fix the implementation.
- If the OpenAI SDK surface differs from the spec, use the installed package types and update the spec/plan before implementation proceeds.

---

## File Structure

- Modify `package.json` and `package-lock.json`
  - Add `@openai/agents` runtime dependency.
- Modify `src/config.ts`
  - Add optional `config.openai.agentModel` only.
- Modify `src/agents/provider-adapters/types.ts`
  - Add `"openai"` to `AgentProviderId`.
- Create `src/agents/provider-adapters/openai-agents-adapter.ts`
  - OpenAI pilot adapter implementation.
- Create `src/agents/provider-adapters/openai-agents-adapter.test.ts`
  - Unit tests with SDK mock.
- Modify `docs/architecture.md`
  - Document OpenAI as pilot adapter only; no provider selection.
- Do not modify `AgentManager.createProviderAdapter(...)` except for comments/tests that prove it remains Claude-only.

## Task 1: Add Dependency and Optional Model Config

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`

- [ ] **Step 1:** Add `@openai/agents` using npm so the lockfile stays consistent.

Command:

```bash
npm install @openai/agents
```

- [ ] **Step 2:** Add optional model config.

```typescript
openai: {
  agentModel: optional("OPENAI_AGENT_MODEL", ""),
},
```

Do not add `config.openai.apiKey` in B2. The adapter uses the SDK's standard environment/configuration path for real direct pilot calls. Boot must not fail without OpenAI credentials.

- [ ] **Step 3:** Run typecheck after adapter code exists.

## Task 2: Extend Provider Id

**Files:**
- Modify: `src/agents/provider-adapters/types.ts`

- [ ] **Step 1:** Change:

```typescript
export type AgentProviderId = "claude" | "openai";
```

- [ ] **Step 2:** Confirm existing Claude adapter still compiles.

Run:

```bash
npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts
```

## Task 3: Implement OpenAI Adapter

**Files:**
- Create: `src/agents/provider-adapters/openai-agents-adapter.ts`

- [ ] **Step 1:** Import the OpenAI SDK.

Use installed package types. Expected public imports are:

```typescript
import { Agent, run } from "@openai/agents";
```

If the installed package exposes different names, adapt to package types and record the difference in the ticket comment.

- [ ] **Step 2:** Define options.

```typescript
export interface OpenAIAgentsAdapterOptions {
  name: string;
  instructions: string;
  model?: string;
  toolInventory?: HiveToolTransportDescriptor[];
}
```

- [ ] **Step 3:** Implement `AgentProviderAdapter`.

Required behavior:

- `provider` is `"openai"`.
- `abort()` aborts the current `AbortController`.
- `wasAborted` reflects abort state.
- `runTurn(request)` creates a fresh `AbortController` per turn.
- `request.resourceLimits?.maxTurns` maps to SDK `maxTurns`.
- `request.sessionId` maps to SDK `previousResponseId`.
- `request.systemPromptOverride` overrides constructor instructions.
- `request.modelOverride` is ignored in B2; use only `options.model`.
- `request.onStream` selects streaming mode and forwards text chunks.
- non-streaming maps `result.finalOutput`.
- `result.lastResponseId` becomes `RunResult.sessionId` when present.
- Abort rejection returns an aborted `RunResult`, not an uncaught error.
- Non-abort SDK rejection returns a complete `RunResult` with `error`, `aborted: false`, and `sessionId` preserved from the request or `""`.
- `finalOutput` coercion: string as-is, `undefined`/`null` to `""`, non-string via safe JSON serialization with `String(...)` fallback.

- [ ] **Step 4:** Implement tool-free guardrail.

If `toolInventory` contains any descriptor where `compatibility.openai !== "claude-only"`, throw an error before calling the SDK:

```text
OpenAI tool bridge is not implemented in KPR-233
```

This rejects `mcp-bridge-candidate`, `requires-hive-bridge`, and `unsupported`. Claude-only built-ins/sub-agents in inventory do not require the OpenAI adapter to attach tools; they should be ignored for B2.

- [ ] **Step 5:** Create a helper for `RunResult` mapping.

Set unmapped metrics to conservative zero values:

- cost/tokens/context/compactions: `0`
- tool calls/ms: `0`
- toolSummary: `"none"`
- streamed from request
- duration wall clock measured around SDK run

## Task 4: Add Adapter Tests

**Files:**
- Create: `src/agents/provider-adapters/openai-agents-adapter.test.ts`

- [ ] **Step 1:** Mock `@openai/agents`.

Pattern:

```typescript
vi.mock("@openai/agents", () => ({
  Agent: vi.fn(function Agent(options) { return { options }; }),
  run: vi.fn(),
}));
```

Adjust for actual ESM mocking needs.

- [ ] **Step 2:** Add required cases.

Minimum tests:

- provider id is `"openai"`.
- non-streaming run constructs `Agent` with expected name/instructions/model.
- run receives prompt, `maxTurns`, `signal`, and `previousResponseId`.
- non-streaming maps `finalOutput` and `lastResponseId` into `RunResult`.
- streaming consumes `toTextStream()` or equivalent helper, calls `onStream` with chunks, and returns accumulated text.
- `abort()` aborts the signal and maps SDK abort rejection to `aborted: true`.
- normal SDK rejection maps to a complete error `RunResult` with `aborted: false`.
- `request.modelOverride` is ignored, including a Claude-looking model id.
- final output coercion covers string, `undefined`, and non-string output.
- tool inventory with any non-`claude-only` OpenAI compatibility is rejected before SDK call, including `unsupported`.
- Claude-only inventory entries do not block a tool-free run.

Run:

```bash
npx vitest run src/agents/provider-adapters/openai-agents-adapter.test.ts
```

## Task 5: Preserve Production Claude Selection

**Files:**
- Prefer tests only. Modify production `AgentManager` only if needed for imports/comments.

- [ ] **Step 1:** Confirm `AgentManager.createProviderAdapter(...)` still returns `ClaudeAgentAdapter`.

- [ ] **Step 2:** Add a narrow test only if existing tests do not already catch it.

Suggested assertion in `agent-manager.test.ts`: a normal `spawnTurn` still records `provider` as Claude only indirectly by verifying the existing mocked `ClaudeAgentAdapter`/`AgentRunner` path is used. Avoid brittle private-method testing.

Run:

```bash
npx vitest run src/agents/agent-manager.test.ts
```

## Task 6: Documentation

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** Update provider adapter section:

- Claude remains the only production-selected provider.
- OpenAI exists as a tool-free pilot adapter.
- OpenAI does not consume Claude `mcpServers`.
- OpenAI direct pilot calls rely on the SDK's standard `OPENAI_API_KEY` environment/configuration path.
- OpenAI tool bridge, provider selection, and memory/session policy are deferred.

- [ ] **Step 2:** Ensure docs do not imply OpenAI is live for Slack/SMS/WS/voice.

## Task 7: Verification and Quality Gate

**Files:**
- No new files unless fixes are needed.

- [ ] **Step 1:** Run unit tests.

```bash
npx vitest run src/agents/provider-adapters/openai-agents-adapter.test.ts
```

- [ ] **Step 2:** Run integration tests.

```bash
npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts
```

- [ ] **Step 3:** Run broader regression.

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

- [ ] **Step 4:** Run whitespace check.

```bash
git diff --check
```

Expected: All required commands pass. Existing lint warnings are acceptable only if the command exits 0.

## Handoff

When implementation is complete, add evidence to KPR-233 and advance to `ready-for-child-pr` only after:

- implementation commit exists on the child branch,
- fresh implementation review is clean,
- focused tests pass,
- full quality gate passes,
- child branch is current with `epic/kpr-230-phase-b-provider-adapters`.
