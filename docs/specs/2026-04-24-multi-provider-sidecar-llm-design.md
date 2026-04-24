# Multi-Provider Sidecar LLM Design

**Date:** 2026-04-24
**Status:** Approved for Phase 1 implementation

## Goal

Phase 1 makes non-runtime LLM work configurable across Anthropic, OpenAI, Gemini, and OpenAI-compatible endpoints while leaving the main Hive agent runtime on the Claude Agent SDK.

This phase does not attempt to make `AgentRunner` vendor-neutral. Full agent sessions still depend on Claude SDK behavior for MCP wiring, resumable sessions, subagents, hooks, and compaction events.

## Scope

Included:

- Model routing classification
- Meeting response classification
- Memory lifecycle summarization and autoDream consolidation
- Image/file description currently handled by Gemini vision
- Provider registry and task aliases in config
- Hosted Anthropic, OpenAI, Gemini providers
- OpenAI-compatible provider shape for local/open-weight backends

Excluded:

- Voice adapter migration
- Code-task and Claude Code migration
- Beekeeper runtime migration
- Agent runtime abstraction
- Embedding migration

## Architecture

Add `src/llm/` with:

- `LLMProvider` interface for one-shot text and vision generation
- Provider adapters for Anthropic, OpenAI, Gemini, and OpenAI-compatible chat APIs
- `LLMRegistry` that resolves logical aliases to provider/model pairs
- Task aliases such as `modelRouter`, `meetingClassifier`, `memory`, and `vision`

The registry is configured from `hive.yaml` and environment variables. Existing behavior stays Claude/Gemini by default so installed instances do not need immediate config changes.

## Config Direction

`hive.yaml` may define:

```yaml
llm:
  tasks:
    modelRouter: anthropic-haiku
    meetingClassifier: anthropic-haiku
    memory: anthropic-haiku
    vision: gemini-vision
  providers:
    anthropic:
      type: anthropic
      apiKeyEnv: ANTHROPIC_API_KEY
    openai:
      type: openai
      apiKeyEnv: OPENAI_API_KEY
    gemini:
      type: gemini
      apiKeyEnv: GEMINI_API_KEY
    local:
      type: openai-compatible
      baseUrl: http://127.0.0.1:11434/v1
      apiKeyEnv: OPENAI_COMPATIBLE_API_KEY
  models:
    anthropic-haiku:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    gemini-vision:
      provider: gemini
      model: gemini-2.5-flash
```

Environment overrides remain available for current operators:

- `MODEL_ROUTER_MODEL`
- `MODEL_ROUTER_TIMEOUT_MS`
- `GEMINI_VISION_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_COMPATIBLE_BASE_URL`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_MODEL`

## Secret Storage

Provider credentials follow the Honeypot + Keychain model (see `CLAUDE.md` DOD-212). Every provider API key is loaded via `optional()`, which checks `process.env` first and falls back to `security find-generic-password -s hive/<instanceId>/<KEY>`. No `.env`-only path. This applies uniformly to:

- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `OPENAI_COMPATIBLE_API_KEY`

Non-secret config (model names, base URLs without credentials) stays env-only (`envOptional()`), matching the `plugin.yaml` `env:` vs `secret-env:` split.

## Compatibility

Default task aliases preserve existing behavior:

- Router and meeting classification use Anthropic Haiku by default.
- Memory lifecycle uses Anthropic Haiku by default.
- Image description uses Gemini vision by default.
- Agent definitions keep their current `model` string. The Claude SDK runtime still receives Claude model IDs directly.

If a task alias points at a provider without usable credentials or endpoint config, the call fails and the existing caller fallback behavior applies where present.

Hosted providers (Anthropic, OpenAI, Gemini) require an API key; they are omitted from the registry when no key is resolvable. No second auth path via the Claude Agent SDK subprocess — all Anthropic sidecar calls go through the Messages API so credential provenance stays visible and centralized in Honeypot.

## Future Work

Phase 2 should isolate Claude runtime types behind an `AgentRuntime` interface. That is deliberately separate from this provider layer because runtime semantics are much richer than one-shot generation.
