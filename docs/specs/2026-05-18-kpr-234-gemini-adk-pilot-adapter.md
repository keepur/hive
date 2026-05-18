# KPR-234 Gemini ADK Spike/Pilot Adapter Design

## Summary

KPR-234 is Phase B3 of the KPR-230 provider adapter epic. It evaluates Google Agent Development Kit (ADK) for TypeScript against Hive's Phase B provider boundary by adding a narrow, tool-free Gemini pilot adapter while keeping production channel traffic on Claude.

The outcome should answer whether Gemini ADK can fit the same one-turn adapter contract that now hosts Claude and the OpenAI pilot, and document where Gemini ADK differs for future Phase C/D work around provider selection, tools, sessions, and memory.

## Current SDK Grounding

The official ADK documentation now includes a TypeScript package and quickstart. The current public TypeScript path is:

- install `@google/adk`,
- define an `LlmAgent`,
- run it through an ADK runner such as `InMemoryRunner`,
- consume an async generator of ADK events,
- optionally identify final responses with `isFinalResponse(...)` and convert events with `toStructuredEvents(...)`.

ADK's Gemini docs describe Gemini model support for TypeScript and recommend passing model identifiers such as `gemini-flash-latest` to `LlmAgent`. They also describe Google AI Studio API-key auth and Google Cloud Agent Platform auth through ADK/Google GenAI environment configuration.

References:

- ADK TypeScript quickstart: https://adk.dev/get-started/typescript/
- ADK Gemini models: https://adk.dev/agents/models/google-gemini/
- ADK TypeScript API reference: https://adk.dev/api-reference/typescript/
- ADK `Runner`: https://adk.dev/api-reference/typescript/classes/Runner.html
- ADK `InMemoryRunner`: https://adk.dev/api-reference/typescript/classes/InMemoryRunner.html
- ADK `LlmAgent`: https://adk.dev/api-reference/typescript/classes/LlmAgent.html

## Context

KPR-231 introduced `AgentProviderAdapter`, KPR-232 added a provider-neutral Hive tool transport inventory, and KPR-233 added a tool-free OpenAI Agents SDK pilot. B3 should follow the same safety boundary:

- no provider field in agent definitions,
- no operator-facing provider selection,
- no production channel traffic on Gemini,
- no Hive MCP/tool bridge attached,
- no ADK multi-agent topology,
- no final memory/session policy.

Gemini ADK differs from the OpenAI pilot in an important way: ADK is runner/session oriented. B3 should use ADK's in-memory runner only as a direct pilot mechanism and must not treat ADK session state as Hive's production memory model.

## Goals

- Add `@google/adk` as a runtime dependency and adapter implementation.
- Extend `AgentProviderId` to include `"gemini"` without changing production selection.
- Implement a tool-free `GeminiAdkAdapter` that satisfies `AgentProviderAdapter`.
- Map one Gemini ADK run into Hive's existing `RunResult` shape.
- Support streaming/event text into Hive's existing `onStream` callback when ADK yields final/text events.
- Support abort best-effort through an adapter abort flag and stop consuming ADK events after abort.
- Use B1 tool transport inventory as a guardrail: do not attach Hive tools yet; reject any non-Claude-only Gemini compatibility.
- Add unit tests with `@google/adk` mocked, and no real Gemini or Google network calls.
- Document Gemini ADK as a pilot adapter only and record the fit decisions for Phase C/D.

## Non-Goals

- No `agent_definitions.provider` field.
- No operator-facing provider selection.
- No production channel traffic on Gemini.
- No Gemini ADK tool bridge implementation.
- No MCP stdio/http/sse conversion into ADK tools.
- No ADK multi-agent/sub-agent routing.
- No ADK memory service, database session service, artifact service, credential service, or Agent Platform deployment wiring.
- No final Hive memory/session policy.
- No change to Claude or OpenAI adapter behavior.
- No change to model router behavior or sidecar LLM calls.

## Design

### Dependency and Configuration

Add `@google/adk` to runtime dependencies.

Add optional Gemini agent model config in `src/config.ts`:

- `config.gemini.agentModel`: `GEMINI_AGENT_MODEL`, optional.

Hive already has optional `config.gemini.apiKey` and `config.gemini.visionModel` for existing Gemini vision usage. B3 should not make Gemini credentials required at boot. Direct pilot calls should rely on ADK/Google GenAI's standard environment configuration for real runs; tests mock ADK and never require credentials.

### Provider Id and Adapter Files

Update `src/agents/provider-adapters/types.ts`:

```typescript
export type AgentProviderId = "claude" | "openai" | "gemini";
```

Create:

- `src/agents/provider-adapters/gemini-adk-adapter.ts`
- `src/agents/provider-adapters/gemini-adk-adapter.test.ts`

The adapter should implement `AgentProviderAdapter`.

Suggested constructor shape:

```typescript
interface GeminiAdkAdapterOptions {
  name: string;
  instructions: string;
  model?: string;
  toolInventory?: HiveToolTransportDescriptor[];
  appName?: string;
  userId?: string;
}
```

### Tool-Free Pilot Guardrail

If a caller passes an inventory containing any descriptor whose Gemini compatibility is not `claude-only`, the adapter should fail fast with a clear unsupported-tools error. This includes `mcp-bridge-candidate`, `requires-hive-bridge`, and `unsupported`. Claude-only built-ins/sub-agents may be present and are ignored.

This keeps B3 intentionally tool-free and prevents accidental use of Claude MCP config in ADK.

### Run Mapping

For `runTurn(request)`:

1. Create an ADK `LlmAgent` with:
   - `name` from adapter options, sanitized to a JavaScript identifier,
   - `instruction` from `request.systemPromptOverride ?? options.instructions`,
   - `model` from `options.model` only,
   - no tools.
2. Create an `InMemoryRunner({ agent, appName })`.
3. Convert the Hive prompt into ADK content:
   - role `user`,
   - one text part containing `request.prompt`.
4. Run the agent through `runner.runEphemeral(...)` for B3.
5. Use `request.sessionId` only as a returned/fallback pilot id; do not route it into a persistent ADK/Hive session service in B3.
6. Iterate yielded events and extract text from final responses first, with conservative fallbacks for structured content/text fields used by the installed ADK package.
7. If `request.onStream` exists, forward newly extracted text chunks as events arrive and return accumulated text.

Ignore `request.modelOverride` in B3. Hive's model router currently emits Claude model ids for production turns, and cross-provider model routing belongs to Phase C.

Map the result into Hive `RunResult`:

- `text`: accumulated/extracted final text, or `""`.
- `sessionId`: preserve `request.sessionId` when present; otherwise use a generated/direct-pilot id if ADK does not expose one.
- `costUsd`: `0`.
- `durationMs`: wall clock time for the adapter run.
- `llmMs`: same as `durationMs`.
- `toolMs`: `0`.
- `toolCalls`: `0`.
- `toolSummary`: `"none"`.
- `streamed`: true when `onStream` is used.
- token fields/context/compactions: `0` unless stable SDK usage fields are deliberately mapped.
- `aborted`: true when adapter abort is requested.
- `error`: useful message when ADK throws for a non-abort reason.

If ADK throws for a non-abort reason, return a complete zero-metric `RunResult` with `error`, `aborted: false`, and the incoming/fallback session id.

### Abort Behavior

ADK TypeScript's documented `Runner.runEphemeral(...)` surface returns an async generator and does not document an `AbortSignal` parameter. B3 should implement best-effort abort by:

- setting `wasAborted`,
- stopping event consumption once the flag is set,
- returning an aborted `RunResult` with empty text.

If the installed package exposes a stable abort/cancellation surface, the adapter may use it and the spec/plan should be updated before implementation proceeds.

### Production Selection

Do not wire Gemini into `AgentManager.createProviderAdapter(...)` for normal turns. That method must continue to return `ClaudeAgentAdapter`.

Gemini ADK remains directly instantiable by tests/future pilot harnesses only.

## Acceptance Criteria

- `@google/adk` is added as a runtime dependency.
- `AgentProviderId` includes `"gemini"`.
- `GeminiAdkAdapter` implements `AgentProviderAdapter`.
- The adapter can run a mocked, tool-free ADK turn and return a complete Hive `RunResult`.
- Event/final-response text is extracted and forwarded through `onStream` when present.
- Abort is best-effort and maps to `RunResult.aborted`.
- `request.modelOverride` is ignored in B3; the adapter uses only the adapter option/configured Gemini model.
- Gemini pilot session behavior is explicitly ephemeral; `sessionId` is not written into production Hive session continuity.
- Any inventory entry where `compatibility.gemini !== "claude-only"` is rejected with a clear unsupported-tools error.
- `AgentManager` still creates only the Claude adapter for production turns.
- No Gemini/Google credential is required for tests or process boot.
- Non-abort ADK errors map to a complete `RunResult` with `error` and `aborted: false`.
- Documentation says Gemini support is a pilot adapter, not production provider selection.

## Test Requirements

- Unit tests for `GeminiAdkAdapter` with `@google/adk` mocked:
  - provider id is `"gemini"`,
  - constructs `LlmAgent` and `InMemoryRunner` with expected options,
  - calls `runEphemeral(...)` with prompt content and a pilot `userId`,
  - maps final text/event output into `RunResult`,
  - streams extracted chunks to `onStream`,
  - abort maps to an aborted `RunResult`,
  - normal ADK errors map to a complete error `RunResult`,
  - ignores `request.modelOverride`,
  - rejects unsupported non-Claude tool inventory, including `unsupported`,
  - Claude-only inventory entries do not block a tool-free run.
- Existing `ClaudeAgentAdapter`, `OpenAIAgentsAdapter`, `AgentManager`, and `AgentRunner` tests remain green.
- Broader regression must run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.

## Dependency Notes

- Phase C owns provider selection and provider-scoped credential policy.
- Phase D owns long-term memory versus provider session memory.
- Gemini ADK tool, MCP, memory, artifact, and multi-agent features are explicitly deferred from B3 even if the SDK supports them.
