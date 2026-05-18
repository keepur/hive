# KPR-233 OpenAI Agents SDK Pilot Adapter Design

## Summary

KPR-233 is Phase B2 of the KPR-230 provider adapter epic. It adds the first non-Claude runtime adapter as a narrow, tool-free OpenAI Agents SDK pilot while keeping production channel traffic on Claude.

The goal is to prove that Hive's B0 one-turn provider adapter boundary can host a provider-native agent loop without reviving the old `AgentRuntime` abstraction or pulling Phase C provider selection forward. The pilot should be directly testable and safe to instantiate in code, but `AgentManager` must still choose Claude for all normal turns.

## Current SDK Grounding

The TypeScript OpenAI Agents SDK is documented around `@openai/agents`, `Agent`, and `run(...)`. The run options include streaming, context, `maxTurns`, and an `AbortSignal`; results expose final output and state/history surfaces. The SDK also supports multiple conversation-continuation strategies such as result history, sessions, `conversationId`, and `previousResponseId`.

B2 should use only the minimum stable surface needed for a tool-free pilot:

- `new Agent({ name, instructions, model })`
- `run(agent, prompt, { stream, maxTurns, signal, previousResponseId })`
- `result.finalOutput`
- `result.lastResponseId` when available

References:

- OpenAI Agents SDK overview: https://platform.openai.com/docs/guides/agents-sdk/
- Running agents: https://openai.github.io/openai-agents-js/guides/running-agents/
- Streaming: https://openai.github.io/openai-agents-js/guides/streaming/
- Results: https://openai.github.io/openai-agents-js/guides/results/
- Sessions and continuation choices: https://openai.github.io/openai-agents-js/guides/sessions/

## Context

KPR-231 introduced `AgentProviderAdapter`, currently with only `"claude"` as a provider id. KPR-232 added `AgentRunner.buildToolTransportInventory()` so future non-Claude adapters can reason about tool availability without consuming Claude SDK `mcpServers`.

OpenAI should now be added behind the same adapter contract, but not selected by production routing yet. This pilot is intentionally narrower than a full Hive turn:

- no provider field in agent definitions,
- no channel path uses OpenAI by default,
- no MCP/tool bridge attached,
- no long-term memory/provider-session boundary changes,
- no SDK handoffs or OpenAI multi-agent topology.

The adapter exists so B3 and future Phase C work can evaluate real provider integration code rather than a design-only sketch.

## Goals

- Add OpenAI Agents SDK as an optional dependency and adapter implementation.
- Extend `AgentProviderId` to include `"openai"` without changing production selection.
- Implement a tool-free `OpenAIAgentsAdapter` that satisfies `AgentProviderAdapter`.
- Map a one-turn OpenAI run into Hive's existing `RunResult` shape.
- Support streaming text into Hive's existing `onStream` callback.
- Support abort through `AbortController`/SDK `signal`.
- Carry Hive `resourceLimits.maxTurns` into OpenAI `run(...)` options.
- Use B1 tool transport inventory as a guardrail: do not attach Hive tools yet; verify the adapter rejects or reports non-empty tool bridge attempts.
- Add unit tests with the OpenAI SDK mocked, and no real OpenAI API calls.
- Document that this is a pilot adapter only and production routing remains Claude-only.

## Non-Goals

- No `agent_definitions.provider` field.
- No operator-facing provider selection.
- No production channel traffic on OpenAI.
- No OpenAI tool bridge implementation.
- No MCP stdio/http/sse conversion into OpenAI tools.
- No OpenAI handoffs, tool approvals, or multi-agent routing.
- No OpenAI session store, Conversations API resource management, or Phase D memory design.
- No change to Claude adapter behavior.
- No change to model router behavior or sidecar LLM calls.

## Design

### Dependency and Configuration

Add `@openai/agents` to runtime dependencies.

Add optional OpenAI model config in `src/config.ts`:

- `config.openai.agentModel`: `OPENAI_AGENT_MODEL`, optional. Do not bake provider freshness into code; a missing value should be handled by the adapter's constructor default or test fixture.

B2 deliberately does not add `config.openai.apiKey` or an `apiKey` adapter option. The SDK's top-level `run(...)` path uses the SDK's standard environment/configuration resolution. Direct pilot callers must provide `OPENAI_API_KEY` in the process environment when making real calls. Tests mock the SDK and never need credentials.

This avoids pretending Honeypot-resolved credentials are wired when the top-level SDK call would not consume them. Phase C can add provider-scoped credential wiring with an explicit SDK `Runner`/provider configuration when provider selection is designed.

### Provider Id and Adapter Files

Update `src/agents/provider-adapters/types.ts`:

```typescript
export type AgentProviderId = "claude" | "openai";
```

Create:

- `src/agents/provider-adapters/openai-agents-adapter.ts`
- `src/agents/provider-adapters/openai-agents-adapter.test.ts`

The adapter should implement `AgentProviderAdapter`.

Suggested constructor shape:

```typescript
interface OpenAIAgentsAdapterOptions {
  name: string;
  instructions: string;
  model?: string;
  toolInventory?: HiveToolTransportDescriptor[];
}
```

The adapter should be directly instantiable by tests and future pilot harnesses. It should not require `AgentRunner` and should not import Claude SDK types.

### Tool-Free Pilot Guardrail

KPR-232 classifies Hive tools, but B2 should not attach any tools to OpenAI. To keep this explicit, the OpenAI adapter should inspect the optional inventory and allow only a tool-free run.

If a caller passes an inventory containing any descriptor whose OpenAI compatibility is not `claude-only`, the adapter should fail fast with a clear unsupported-tools error. This includes `mcp-bridge-candidate`, `requires-hive-bridge`, and `unsupported`. Claude-only built-ins/sub-agents may be present and are ignored; they do not cause the adapter to attach tools. This forces B2 to remain tool-free and prevents accidental use of Claude MCP config in OpenAI.

This is conservative. B2 may still pass an empty inventory or omit inventory entirely.

### Run Mapping

For `runTurn(request)`:

1. Create an OpenAI `Agent` with:
   - `name` from adapter options,
   - `instructions` from `request.systemPromptOverride ?? options.instructions`,
   - `model` from `options.model` only.
2. Call `run(agent, request.prompt, options)`.
3. Pass `stream: true` when `request.onStream` is present; otherwise non-streaming is acceptable.
4. Pass `maxTurns: request.resourceLimits?.maxTurns`.
5. Pass `signal` from the adapter's `AbortController`.
6. For direct pilot continuation only, pass `previousResponseId: request.sessionId`. Treat `RunResult.sessionId` as the returned `lastResponseId` when present.

Ignore `request.modelOverride` in B2. Hive's model router currently produces Claude model ids for production turns, and cross-provider model routing belongs to Phase C.

If streaming is used, consume text through `toTextStream()` or the SDK's documented text stream helper and forward chunks to `request.onStream`. Wait for stream completion before returning the final `RunResult`.

Map the result into Hive `RunResult`:

- `text`: final output text, or the accumulated streamed text. Coerce output as follows: string as-is, `undefined`/`null` as `""`, non-string via safe JSON serialization with `String(...)` fallback.
- `sessionId`: OpenAI `lastResponseId` when available; otherwise preserve `request.sessionId` or `""`.
- `costUsd`: `0` for B2 unless the SDK exposes stable usage/cost data that is easy to map.
- `durationMs`: wall clock time for the adapter run.
- `llmMs`: same as `durationMs` for B2.
- `toolMs`: `0`.
- `toolCalls`: `0`.
- `toolSummary`: `"none"`.
- `streamed`: true when `onStream` is used.
- token fields: `0` unless stable SDK usage fields are mapped deliberately.
- `contextWindow`: `0` unless known from model metadata.
- `compactions`: `0`.
- `aborted`: true when aborted.
- `error`: set to a useful message when the SDK throws.

If the SDK throws for a non-abort reason, return a complete zero-metric `RunResult` with `error`, `aborted: false`, and `sessionId` preserved from `request.sessionId` or `""`. This includes max-turns and other SDK errors.

### Abort Behavior

`abort()` should call `AbortController.abort()` and set `wasAborted`.

If the SDK rejects because of abort, return a `RunResult` with `aborted: true`, empty text, and the existing or empty session id. Do not throw an abort as a normal error to `AgentManager`.

### Production Selection

Do not wire this adapter into `AgentManager.createProviderAdapter(...)` for normal turns. That method must continue to return `ClaudeAgentAdapter`.

B2 may add a private factory helper or exported class for tests/pilot code, but no channel, scheduler, or voice path should select OpenAI.

## Acceptance Criteria

- `@openai/agents` is added as a runtime dependency.
- `AgentProviderId` includes `"openai"`.
- `OpenAIAgentsAdapter` implements `AgentProviderAdapter`.
- The adapter can run a mocked tool-free OpenAI turn and return a complete Hive `RunResult`.
- Streaming forwards text chunks through `onStream` and returns the final text.
- Abort uses `AbortController`/`signal` and maps abort to `RunResult.aborted`.
- `resourceLimits.maxTurns` is forwarded to the SDK run options.
- `request.modelOverride` is ignored in B2; the adapter uses only the adapter option/configured OpenAI model.
- `sessionId` is treated as `previousResponseId` for direct pilot calls only, and `lastResponseId` is returned as the new `sessionId` when available.
- OpenAI `sessionId`/`previousResponseId` is provider-scoped pilot state and must not read from or write to production Hive session continuity through `AgentManager`.
- Any inventory entry where `compatibility.openai !== "claude-only"` is rejected with a clear unsupported-tools error.
- `AgentManager` still creates only the Claude adapter for production turns.
- No OpenAI API key is required for tests or process boot.
- Real direct pilot calls rely on the OpenAI SDK's standard `OPENAI_API_KEY` environment/configuration path; B2 does not add Honeypot/provider-scoped credential wiring.
- Non-abort SDK errors map to a complete `RunResult` with `error` and `aborted: false`.
- `finalOutput` coercion is covered: string, `undefined`, and non-string output.
- Documentation says OpenAI support is a pilot adapter, not production provider selection.

## Test Requirements

- Unit tests for `OpenAIAgentsAdapter` with `@openai/agents` mocked:
  - constructs an OpenAI agent with expected name/instructions/model,
  - calls `run(...)` with prompt, `maxTurns`, `signal`, and `previousResponseId`,
  - maps non-streaming final output into `RunResult`,
  - streams text chunks to `onStream`,
  - abort maps to an aborted `RunResult`,
  - normal SDK errors map to a complete error `RunResult`,
  - ignores `request.modelOverride`,
  - rejects unsupported non-Claude tool inventory, including `unsupported`.
- Existing `ClaudeAgentAdapter` tests remain green.
- Existing `AgentManager` tests remain green to prove production selection did not change.
- Existing `AgentRunner` tests remain green because Claude tool wiring is untouched.
- Broader regression must run `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.

## Dependency Notes

- KPR-234 should use the same adapter and inventory lessons when evaluating Gemini ADK.
- Phase C owns provider selection and per-agent credential scoping.
- Phase D owns long-term memory versus provider session memory. B2's `previousResponseId` mapping is a pilot continuation mechanism, not the final memory boundary.
