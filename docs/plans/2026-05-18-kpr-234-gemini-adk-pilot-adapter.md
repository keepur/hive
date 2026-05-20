# KPR-234 Gemini ADK Spike/Pilot Adapter Implementation Plan

> **For agentic workers:** After this plan is approved, invoke `/spec-and-implement` for KPR-234 per this repo's workflow. The implementation worker should execute this plan through the dodi-dev implementation flow.

**Goal:** Add a tool-free Gemini ADK provider adapter pilot that satisfies Hive's provider boundary without changing production runtime selection.

**Architecture:** `AgentManager` remains Claude-only. `GeminiAdkAdapter` lives beside the Claude and OpenAI adapters, implements `AgentProviderAdapter`, uses Google ADK for TypeScript directly, maps ADK events into Hive `RunResult`, and refuses tool inventory that would require a Gemini bridge.

**Tech Stack:** TypeScript, Vitest, `@google/adk`, existing Hive provider-adapter types, existing KPR-232 tool transport descriptors.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/agents/provider-adapters/gemini-adk-adapter.ts`
  - Reason: The new provider adapter must prove ADK construction, event/result mapping, streaming, abort behavior, and tool-free guardrails without real Gemini API calls.
  - Minimum assertions: constructor/config mapping; `runEphemeral(...)` input; text extraction; streaming chunks; abort result; unsupported inventory rejection.

- Integration: `required`
  - Scope: `src/agents/provider-adapters/claude-agent-adapter.test.ts`, `src/agents/provider-adapters/openai-agents-adapter.test.ts`, `src/agents/agent-manager.test.ts`, `src/agents/agent-runner.test.ts`
  - Reason: Production selection must remain Claude-only and existing provider pilots must not regress.
  - Harness: `existing`
  - Minimum assertions: Existing manager, Claude adapter, OpenAI adapter, and runner tests remain green.

- E2E: `not-required`
  - Scope: Real Gemini call through Slack/SMS/WS/voice.
  - Reason: B3 does not expose provider selection or production routing. Real channel E2E belongs after Phase C selection.
  - Harness: `not-applicable`
  - Minimum assertions: Not applicable.

### Critical Flows

- Direct pilot instantiation runs one tool-free Gemini ADK turn and maps to `RunResult`.
- Direct pilot instantiation streams extracted event text into Hive's `onStream` callback.
- `abort()` makes the active run return an aborted `RunResult` and stops event consumption.
- Existing `AgentManager.spawnTurn` still builds the Claude adapter only.
- Gemini credentials remain optional at process boot and tests never call the network.

### Regression Surface

- `src/agents/provider-adapters/types.ts`
- `src/agents/provider-adapters/claude-agent-adapter.ts`
- `src/agents/provider-adapters/openai-agents-adapter.ts`
- `src/agents/provider-adapters/tool-transport.ts`
- `src/agents/agent-manager.ts`
- `src/agents/agent-manager.test.ts`
- `src/agents/agent-runner.ts`
- `src/config.ts`
- `package.json` / `package-lock.json`
- `docs/architecture.md`

### Commands

- Unit: `npx vitest run src/agents/provider-adapters/gemini-adk-adapter.test.ts`
- Integration: `npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts`
- E2E: Not required for B3.
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- Mock `@google/adk`; no real API calls.
- Use fake ADK events for final response, structured text, streaming chunks, and errors.
- Use a controlled async generator to test abort behavior.
- No real Gemini, Google Cloud, Slack, MongoDB, Qdrant, or Keychain access required.

### Non-Required Rationale

- Production channel E2E is not required because no channel can select Gemini in B3.
- Tool-call E2E is not required because B3 is explicitly tool-free. KPR-232 only provides the inventory/bridge plan.
- Session-store E2E is not required because B3 uses ADK's ephemeral runner path and does not define Phase D memory boundaries.

### Verification Rules

- Missing harness is not a skip reason; mock ADK or report a concrete blocker.
- If a test failure exposes production selection changing from Claude, fix the implementation.
- If the installed ADK surface differs from this plan, use the installed package types and update the spec/plan before implementation proceeds.

---

## File Structure

- Modify `package.json` and `package-lock.json`
  - Add `@google/adk` runtime dependency.
- Modify `src/config.ts`
  - Add optional `config.gemini.agentModel`.
- Modify `src/agents/provider-adapters/types.ts`
  - Add `"gemini"` to `AgentProviderId`.
- Create `src/agents/provider-adapters/gemini-adk-adapter.ts`
  - Gemini ADK pilot adapter implementation.
- Create `src/agents/provider-adapters/gemini-adk-adapter.test.ts`
  - Unit tests with ADK mock.
- Modify `docs/architecture.md`
  - Document Gemini as a pilot adapter only; no provider selection.
- Do not modify `AgentManager.createProviderAdapter(...)` except for comments/tests that prove it remains Claude-only.

## Task 1: Add Dependency and Optional Model Config

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`

- [ ] **Step 1:** Add `@google/adk` using npm so the lockfile stays consistent.

Command:

```bash
npm install @google/adk
```

- [ ] **Step 2:** Add optional model config under existing `gemini`.

```typescript
gemini: {
  apiKey: optional("GEMINI_API_KEY", ""),
  visionModel: optional("GEMINI_VISION_MODEL", "gemini-2.5-flash"),
  agentModel: optional("GEMINI_AGENT_MODEL", ""),
},
```

Do not make Gemini credentials required in B3. The adapter uses ADK/Google GenAI's standard environment configuration for real direct pilot calls. Boot must not fail without Gemini credentials.

## Task 2: Extend Provider Id

**Files:**
- Modify: `src/agents/provider-adapters/types.ts`

- [ ] **Step 1:** Change:

```typescript
export type AgentProviderId = "claude" | "openai" | "gemini";
```

- [ ] **Step 2:** Confirm existing Claude and OpenAI adapters still compile.

## Task 3: Implement Gemini ADK Adapter

**Files:**
- Create: `src/agents/provider-adapters/gemini-adk-adapter.ts`

- [ ] **Step 1:** Import the ADK SDK.

Use installed package types. Expected public imports are:

```typescript
import { InMemoryRunner, LlmAgent, isFinalResponse, toStructuredEvents } from "@google/adk";
```

If the installed package exposes different names, adapt to package types and record the difference in the ticket comment.

- [ ] **Step 2:** Define options.

```typescript
export interface GeminiAdkAdapterOptions {
  name: string;
  instructions: string;
  model?: string;
  toolInventory?: HiveToolTransportDescriptor[];
  appName?: string;
  userId?: string;
}
```

- [ ] **Step 3:** Implement `AgentProviderAdapter`.

Required behavior:

- `provider` is `"gemini"`.
- `abort()` sets the abort flag.
- `wasAborted` reflects abort state.
- `runTurn(request)` resets abort state per turn.
- `request.systemPromptOverride` overrides constructor instructions.
- `request.modelOverride` is ignored in B3; use only `options.model`.
- `request.onStream` receives extracted text chunks as ADK events arrive.
- non-streaming returns accumulated final/extracted text.
- `sessionId` is preserved from request or generated as a direct pilot id; it is not passed to persistent ADK session storage in B3.
- Non-abort ADK rejection returns a complete `RunResult` with `error`, `aborted: false`, and `sessionId` preserved from the request or fallback.

- [ ] **Step 4:** Implement tool-free guardrail.

If `toolInventory` contains any descriptor where `compatibility.gemini !== "claude-only"`, throw an error before creating ADK objects:

```text
Gemini ADK tool bridge is not implemented in KPR-234
```

This rejects `mcp-bridge-candidate`, `requires-hive-bridge`, and `unsupported`. Claude-only built-ins/sub-agents in inventory do not require the Gemini adapter to attach tools; they should be ignored for B3.

- [ ] **Step 5:** Implement text extraction helpers.

Prefer ADK final responses and structured events:

- if `isFinalResponse(event)` returns true, inspect content/parts/text fields,
- inspect `toStructuredEvents(event)` for content/text/delta-like fields,
- safely coerce string-like values,
- avoid emitting duplicate chunks when both raw and structured views contain the same text.

- [ ] **Step 6:** Create a helper for `RunResult` mapping.

Set unmapped metrics to conservative zero values:

- cost/tokens/context/compactions: `0`
- tool calls/ms: `0`
- toolSummary: `"none"`
- streamed from request
- duration wall clock measured around ADK run

## Task 4: Add Adapter Tests

**Files:**
- Create: `src/agents/provider-adapters/gemini-adk-adapter.test.ts`

- [ ] **Step 1:** Mock `@google/adk`.

Pattern:

```typescript
vi.mock("@google/adk", () => ({
  LlmAgent: vi.fn(function LlmAgent(options) { return { options }; }),
  InMemoryRunner: vi.fn(function InMemoryRunner(options) {
    return { runEphemeral: runEphemeralMock, options };
  }),
  isFinalResponse: vi.fn(),
  toStructuredEvents: vi.fn(),
}));
```

Adjust for actual ESM mocking needs.

- [ ] **Step 2:** Add required cases.

Minimum tests:

- provider id is `"gemini"`.
- non-streaming run constructs `LlmAgent` with expected name/instruction/model and no tools.
- runner receives prompt content, `appName`, and `userId`.
- non-streaming maps final text/event output into `RunResult`.
- streaming calls `onStream` with extracted chunks and returns accumulated text.
- `abort()` maps to `aborted: true`.
- normal ADK rejection maps to a complete error `RunResult` with `aborted: false`.
- `request.modelOverride` is ignored, including a Claude-looking model id.
- tool inventory with any non-`claude-only` Gemini compatibility is rejected before ADK construction, including `unsupported`.
- Claude-only inventory entries do not block a tool-free run.

Run:

```bash
npx vitest run src/agents/provider-adapters/gemini-adk-adapter.test.ts
```

## Task 5: Preserve Production Claude Selection

**Files:**
- Prefer tests only. Modify production `AgentManager` only if needed for imports/comments.

- [ ] **Step 1:** Confirm `AgentManager.createProviderAdapter(...)` still returns `ClaudeAgentAdapter`.

- [ ] **Step 2:** Run:

```bash
npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts
```

## Task 6: Documentation

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** Update provider adapter section:
  - Claude remains the only production-selected provider.
  - OpenAI and Gemini exist as tool-free pilot adapters.
  - Gemini ADK uses an ephemeral in-memory runner path in B3.
  - Gemini does not consume Claude `mcpServers`.
  - Gemini tool bridge, provider selection, and memory/session policy are deferred.

- [ ] **Step 2:** Ensure docs do not imply Gemini is live for Slack/SMS/WS/voice.

## Task 7: Verification

Run:

```bash
npx vitest run src/agents/provider-adapters/gemini-adk-adapter.test.ts
npx vitest run src/agents/provider-adapters/claude-agent-adapter.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/agent-manager.test.ts src/agents/agent-runner.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
git diff --check
```

Record results in KPR-234 and in the child PR.
