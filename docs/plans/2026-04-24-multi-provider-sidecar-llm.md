# Multi-Provider Sidecar LLM Implementation Plan

**Date:** 2026-04-24
**Spec:** `docs/specs/2026-04-24-multi-provider-sidecar-llm-design.md`

## Phase 1 Work Items

1. Add `src/llm/` primitives.
   - Define request/result/provider types.
   - Add JSON extraction helper.
   - Add Anthropic, OpenAI, Gemini, and OpenAI-compatible adapters.
   - Add registry resolution by model alias and task alias.

2. Add config support.
   - Preserve existing `anthropic`, `gemini`, and `modelRouter` config.
   - Add `openai` and `llm` sections.
   - Merge code defaults with `hive.yaml` overrides.

3. Migrate sidecar call sites.
   - `src/agents/model-router.ts`
   - `src/agents/meeting-classifier.ts`
   - `src/memory/memory-lifecycle.ts`
   - `src/files/file-processor.ts`

4. Keep out of Phase 1.
   - `src/channels/voice/voice-adapter.ts`
   - `src/code-task/*`
   - `src/agents/agent-runner.ts`

5. Verify.
   - Add focused tests for registry behavior and migrated parser/caller behavior.
   - Run targeted tests and typecheck.
