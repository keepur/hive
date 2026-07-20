# KPR-345 — Epic design: Provider-agnostic runtime — two-lane parity architecture

**Epic:** KPR-345 (umbrella for closing the pilot-adapter gaps: tools, memory, skills, guardrails, resume on non-Claude providers).
**Consumers of this spec:** Gate 1 maturation (child decomposition + sequencing), and every child's spec/plan worker. Child specs land beside this file (`docs/epics/kpr-345/kpr-<child>-spec.md`).
**Operator rulings (May, 2026-07-19 brainstorm session):**
- **R1 — Driver:** real production reassignment + hive commercialization ("not locked into Anthropic") + KPR-209 strategic completion. Outage resilience is *not* the bar.
- **R2 — Flagship:** OpenAI (Agents SDK) is the first-class native-lane target; Gemini and Codex replicate the proven pattern.
- **R3 — Parity bar:** full feature parity — tools, memory, skills, guardrails, resume, subagents — sans documented per-provider caveats. Nothing silently dropped.
- **R4 — Both lanes approved:** Anthropic-compat passthrough (Lane A) and provider-native adapters (Lane B) are both in scope. Implementation sequence is a Gate 1 decision, not fixed here.
**Repo baseline:** main @ 60ad454 (audit evidence re-verified 2026-07-19; epic description audit was @ 736c298 — no adapter-subsystem drift between them).

## TL;DR

Reassigning a hive agent to `openai/…`, `gemini/…`, or `codex/…` today yields a bare persona: real credentialed API calls, zero tools, no memory, no skills, no resume. This spec closes the gap with a two-lane architecture: **Lane A** routes new `kimi/…`/`deepseek/…` prefixes through the *existing* `ClaudeAgentAdapter` with per-spawn env substitution (`ANTHROPIC_BASE_URL` + Honeypot-resolved key), inheriting the full hive runtime by construction; **Lane B** expands the `AgentProviderAdapter` contract and builds a real tool/memory/skills/guardrail/resume bridge for provider-native SDKs, OpenAI first. The closing artifact is a supported-provider parity matrix documenting every per-provider caveat.

## Key Points

- **Two lanes, one seam.** Both lanes fork at the existing single fork point, `resolveProviderModel` → `createProviderAdapter` (`src/agents/agent-manager.ts`). Lane A adds prefix families that route to `ClaudeAgentAdapter` + injected env; Lane B expands the native adapters. Neither lane modifies the other's path.
- **Lane A is parity-by-construction — with one required engine change.** The Claude Code runtime (tools, MCP, skills, hooks, subagents) runs unchanged; only completions go to the foreign Anthropic-compat endpoint. Session resume needs a real fix, not just config: the write-side `RESUMABLE_SESSION_PROVIDERS` keying would scrub Lane A session ids today — child 1 extends the resumability keying. Per-provider caveats: no Anthropic server-side tools (WebFetch/WebSearch), tool search forced off (`tool_reference` unsupported on translation endpoints — same failure mode as the KPR-329 proxy note), vendor-specific prompt-cache economics, API-key auth only.
- **Lane B is where the engineering lives.** Contract expansion (tool inventory, instructions, memory bundle, skill index, guardrail gate, session-semantics descriptor) → OpenAI tool bridge (client-side MCP + function tools + hive builtin executor) → memory/skills via a shared prompt-assembly extraction from `AgentRunner` → resume via OpenAI Conversations / Gemini Interactions — then Gemini and Codex replicate.
- **The bridge's front half already exists and is dead in production:** `tool-transport.ts` classifier + `AgentRunner.buildToolTransportInventory` (`agent-runner.ts:1209-1277`) are built and tested but never wired to `createProviderAdapter`, which hardcodes `const toolInventory: [] = []` (`agent-manager.ts:499`). The first Lane B child (child 2) wires them together.
- **Guardrail posture is preserved:** in Lane B hive executes every tool client-side, so a PreToolUse-equivalent fail-closed gate wraps the bridge's dispatch loop (port of the archetype hook semantics in `buildHooks`, `agent-runner.ts:1439-1477`). In Lane A the existing SDK hooks run unchanged.
- **Ops attribution must key on the resolved provider, not the adapter class** — otherwise a Kimi outage trips the Claude circuit breaker and queues Claude turns. Small change at the seam; it is the one place the lanes genuinely interfere if ignored.
- **Ruled out:** translation proxies (LiteLLM / claude-code-router) in production Lane A — unowned middlebox in the credential/fidelity path; OpenAI/Gemini/Codex are served by Lane B instead. Also ruled: cross-provider mid-thread reassignment starts a fresh session (no history carry); foreign models use static `:effort` (catalog-driven per-turn effort tuning stays Claude-lane).
- **Codex asymmetry is documented, not hidden:** subscription OAuth hard-enforces `store: false` — no server-side resume exists on that surface; its resume story is client-side history replay, labeled as such in the matrix.
- ⚠ **Assumptions to validate early:** Agents-SDK `MCPServerStdio` fidelity against hive's stdio servers (docs-verified only); Kimi/DeepSeek endpoint fidelity for hooks/subagent traffic (vendor docs claim subagents work; validate in the Lane A child); Conversations API × Agents SDK session-mode interplay (SDK sessions can't be combined with `previous_response_id`/`conversation_id` in the same run — pick one mechanism in the resume child).
- **PR #194 is closed as superseded** (hygiene child, no code): main's `src/llm/` absorbed it under KPR-314/KPR-309 and is a superset. An OpenAI *sidecar* provider (non-agentic one-shot calls) is explicitly out of scope for this epic; file separately if wanted.

## Problem / Context

KPR-209 set the frame: hive is the orchestration/governance layer above provider-native agent SDKs, and agents should be freely reassignable across providers. KPR-231–234 landed the adapter boundary and three pilot adapters; KPR-306/307/309 made the reliability plumbing provider-generic. The pilots never advanced past tool-free.

### Verified current state (main @ 60ad454, all paths repo-relative)

**The contract cannot express parity.** `AgentProviderTurnRequest` = `{prompt, sessionId?, onStream?, workItemContext?, resourceLimits?, systemPromptOverride?, effort?}`; `AgentProviderAdapter` = `{provider, runTurn(), abort(), wasAborted}` (`src/agents/provider-adapters/types.ts:31-53`). No fields for tools, memory, skills, hooks, or MCP servers. `RESUMABLE_SESSION_PROVIDERS = {claude, openai}` (`types.ts:22`).

**Where each pilot drops capabilities:**
- OpenAI (`openai-agents-adapter.ts:54-58,63`): `new Agent({name, instructions, model})` — no tools param at all; resume = `previousResponseId: request.sessionId`, chained via `extractSessionId` → `lastResponseId` (214-216).
- Gemini (`gemini-adk-adapter.ts:129-134,140-149`): `LlmAgent({…, tools: []})`; `runner.runEphemeral(...)` — sessionId is a fresh `gemini-pilot-${randomUUID()}` per call, never fed back.
- Codex (`codex-subscription-adapter.ts:86-94`): raw fetch with `store: false` and `tools: []`; no `previous_response_id` sent.
- All three carry `assertToolFreePilot()` guards (openai:130-135, gemini:91-96, codex:169-174) that throw if the inventory contains anything not `claude-only` — currently unreachable because the inventory is always empty.

**The dormant bridge front-end.** `classifyToolTransport` (`tool-transport.ts:62-118`) classifies transport (`stdio|http|sse|sdk-in-process|claude-builtin|claude-subagent`) × compatibility (`direct|mcp-bridge-candidate|requires-hive-bridge|claude-only|unsupported`). Its only production-shaped caller, `AgentRunner.buildToolTransportInventory` (`agent-runner.ts:1209-1277`), has zero production call sites. `createProviderAdapter` (`agent-manager.ts:489-526`) passes a type-level empty tuple (`agent-manager.ts:499`) into all three pilot constructors.

**Claude-only capability seams in `AgentRunner`** (the reuse candidates):
- Prompt assembly: `buildSystemPrompt` → `buildPrefix` (`agent-runner.ts:347-374`), prefix-cached per agent (KPR-213); folds in memory, team roster, plugins, skill index, toolkit.
- MCP config: in-process + stdio server map assembled ~`agent-runner.ts:1538-1714`, passed to SDK `query()` at 1819.
- Hooks: `buildHooks` (1439-1477) — PreCompact + archetype PreToolUse, fail-closed.
- Resume: `query({resume: sessionId})` (1818); session id captured from the init message and persisted by `AgentManager` (id-chain tolerant).
- Pilot instructions bypass all of this: `buildPilotInstructions` = `[soul, systemPrompt].join("\n\n")` (`agent-manager.ts:231-234`).

### Provider surface facts (researched 2026-07-19, links per claim)

- **OpenAI Agents SDK (JS/TS):** client-side MCP via `MCPServerStdio` (local subprocess) and `MCPServerStreamableHttp`, plus JSON-schema function tools; hosted MCP exists but requires a public HTTPS endpoint (not usable for hive's local servers). Resume: `previous_response_id` (30-day retention) or the Conversations API as the durable layer; SDK Sessions cannot be combined with `conversation_id`/`previous_response_id` in the same run. No hosted agent runtime (Assistants API gone). [MCP guide](https://openai.github.io/openai-agents-js/guides/mcp/) · [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/) · [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- **Gemini:** Interactions API GA since June 2026 — `previous_interaction_id` server-side continuity supersedes the ephemeral pattern; `generateContent` legacy. ADK-TS shipped `DatabaseSessionService` (v0.4.0, Feb 2026). Native remote-HTTP MCP at the API level (`mcp_server` tool type, ~March 2026); no stdio MCP at API level (ADK's job). Managed Agents runtime is preview-only — not designed against. [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview) · [ADK sessions](https://github.com/google/adk-js/discussions/27)
- **Codex subscription:** OAuth traffic hits `chatgpt.com/backend-api/codex/responses` (Responses schema); **`store: false` is hard-enforced** → no server-side resume on this surface; continuity = client-replayed history + encrypted reasoning items. Standard Responses tool-calling works; `:effort` values map 1:1 to hive's existing suffix grammar. [Auth](https://learn.chatgpt.com/docs/auth) · [Responses storage/ZDR](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- **Anthropic-compat passthrough precedent:** Kimi ships `https://api.moonshot.ai/anthropic` (env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_*_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL` pins, `ENABLE_TOOL_SEARCH=false`; WebFetch unsupported). DeepSeek documents the identical pattern at `https://api.deepseek.com/anthropic`. [Kimi guide](https://platform.kimi.ai/docs/guide/claude-code-kimi) · [DeepSeek guide](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)

## Design

### D1 — Two-lane architecture at the provider seam

`resolveProviderModel` grows two prefix classes, both keeping the settled grammar `<provider>/<model>[:<effort>]` and the unknown-prefix → Claude fallback (KPR-231):

| Prefix | Lane | Adapter | Mechanism |
|---|---|---|---|
| *(bare)*, `claude/…` | — | `ClaudeAgentAdapter` | unchanged |
| `kimi/…`, `deepseek/…` | **A** | `ClaudeAgentAdapter` + passthrough env | per-spawn `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` substitution |
| `openai/…` | **B** | `OpenAIAgentsAdapter` (expanded) | native Agents SDK + hive bridge |
| `gemini/…` | **B** | `GeminiAdkAdapter` (expanded) | ADK + Interactions API + hive bridge |
| `codex/…` | **B** | `CodexSubscriptionAdapter` (expanded) | Responses schema + hive bridge, stateless |

Lane A providers are registered in a small passthrough-provider table (endpoint URL template, Honeypot key name, forced env pins, documented caveats) rather than hardcoded per provider — adding the next compat vendor is a table row, not a code path. Only **officially vendor-operated** Anthropic-compat endpoints qualify; translation proxies are ruled out for production (unowned middlebox in the credential/fidelity path; the KPR-329 degraded-proxy case).

### D2 — Lane A: passthrough mechanics

Per-spawn env injection on the CLI subprocess only (the mechanism KPR-329 already uses to pin `ENABLE_TOOL_SEARCH`; no process-global mutation):

- `ANTHROPIC_BASE_URL` = provider endpoint; `ANTHROPIC_AUTH_TOKEN` = Honeypot-resolved (`hive/<instanceId>/<KEY>`, `process.env` fallback — standard `secret-env` semantics). This does not touch the fleet's no-Anthropic-API-key posture: these are third-party vendor keys, same class as any other Honeypot credential.
- Model pins: `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_*_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL` all set to the resolved foreign model id, so neither the main loop nor Task subagents ever request a Claude model id from a foreign endpoint.
- `ENABLE_TOOL_SEARCH=false` forced for passthrough spawns regardless of the agent's `toolSearch` field / hive.yaml mode (tool selection is unaffected — eager schema loading only; deferral is the KPR-329 optimization that `tool_reference`-less endpoints can't serve).
- Sessions: transcripts are client-side; resume within a passthrough provider replays history against the endpoint (cold cache, re-billed tokens; documented). **Required change (child 1 scope):** session persistence currently keys resumability on the static `RESUMABLE_SESSION_PROVIDERS = {claude, openai}` set (write-side never-persist rule in `finalizeSpawnResult`, `agent-manager.ts:1403,1421`; read-side belt-and-braces guard in `SessionStore.get`, `session-store.ts:106`) — a `kimi`/`deepseek` route provider is not in it, so session ids would be scrubbed and every Lane A turn would start fresh. Child 1 adds Lane A providers to the resumability keying (interim extension of the set; superseded by the Lane B session-semantics descriptor from child 2, which Lane A providers then declare as `client-transcript` — see D3).
- Credential failure mode: a missing Honeypot key (`hive/<id>/<KEY>` absent, no env fallback) is a **config error, not a provider fault** — the spawn fails with an operator-visible error, classifies `non-provider`, and never trips the foreign breaker or engages the outage queue. Passthrough spawns also neutralize the runner's conditional `ANTHROPIC_API_KEY` injection (spread when `config.anthropic.apiKey` is set) so the passthrough table never silently depends on the fleet's no-key posture.
- Effort: `splitProviderModel` parses `:effort` for every prefixed model, but the value only *survives into the route* for codex/openai today. Child 1 makes it survive for Lane A prefixes and routes it into the Claude adapter's existing `effort` channel.
- Everything else (MCP servers, skills, hooks, memory, guardrails, prefix cache) runs the existing Claude-lane code paths untouched.

**Lane A caveats (parity-matrix content):** no Anthropic server-side tools — WebFetch/WebSearch absent (client-side substitutes: brave-search MCP, browser/CDP); tool-search deferral off; vendor cache economics differ; extended-thinking defaults vary per model (per-provider note, maps to static effort).

### D3 — Lane B: contract expansion

`AgentProviderAdapter` construction and `AgentProviderTurnRequest` grow to express (designed tri-provider, implemented flagship-first):

- **Tool inventory** — replaces the empty tuple at `agent-manager.ts:499`. Today's `HiveToolTransportDescriptor` (`tool-transport.ts:23-35`) carries **no schemas** and lists MCP entries at *server* granularity — child 2 extends the inventory contract to per-tool entries with JSON schemas, sourced per transport class: stdio → Agents-SDK MCP discovery at connect time; `sdk-in-process` → the tool definitions hive already holds from `createSdkMcpServer`; builtins → authored net-new with the executor (child 3). The classifier's transport × compatibility classification is reused as-is. Child 2 also rules whether `codex` gets its own compatibility dimension or formally aliases `openai` (today's descriptor has `{claude, openai, gemini}` and the Codex adapter reads `.openai`, `codex-subscription-adapter.ts:170`).
- **Assembled instructions** — from the shared prompt builder (D5), replacing `buildPilotInstructions`.
- **Guardrail gate** — a callback the adapter must invoke before executing any tool call (D4); fail-closed.
- **Session semantics descriptor** — per-provider declaration (`server-resumable` | `conversation-store` | `client-transcript` | `stateless-replay`) driving `AgentManager` persistence behavior; supersedes the static `RESUMABLE_SESSION_PROVIDERS` set. `client-transcript` = the session id is persisted and resume works via a client-side transcript replay (Claude lane and Lane A passthrough); `stateless-replay` = no resumable handle exists and hive itself persists+replays history (Codex).
- The `assertToolFreePilot()` guards are deleted with the same change that makes the inventory real — the compatibility filter (only bridge what classifies bridgeable for that provider) replaces the throw.

### D4 — Lane B: tool bridge (OpenAI first)

Per transport class from the classifier:

- `stdio` MCP servers → Agents SDK `MCPServerStdio` (near-native pass-through of command/args/env, including `secret-env` resolution at spawn — credentials stay in the MCP server process, never in model-facing context; posture unchanged).
- `http`/`sse` MCP servers → Agents SDK `MCPServerStreamableHttp` (direct client→server connection, headers/auth passed through). This is load-bearing, not exotic: the default Slack MCP is hosted HTTP (`agent-runner.ts:476-477`) and Slack is in the fleet's universal-9 coreServers baseline — without this class nearly every Lane B agent would silently lose Slack, violating R3. Legacy `sse` entries bridge the same way or are matrix-listed per the classifier's verdict.
- `sdk-in-process` servers → function tools wrapping the handlers directly. They are in-process JS with structured-error wrappers already (KPR-122); the bridge calls the same handler the SDK loop would, threading the same `*ContextRef` per-turn context.
- `claude-builtin` (Bash, Read, Write, Edit, Glob, Grep, …) → a **hive builtin executor** exposing equivalent function tools. Semantics match the agent-facing contract (cwd, output truncation, timeouts), not the CLI's internals. This is the largest net-new component in the epic.
- `claude-subagent` (Task) → **subagent parity child** (late): a delegate turn = nested adapter turn against the same agent definition's delegate config, budget-accounted through the spawn coordinator. Until that child lands, Task-shaped tools are omitted from non-Claude inventories and listed as a matrix delta.
- compatibility `unsupported` → omitted and matrix-listed.

Tool-call loop: the adapter surfaces provider tool-call events; the bridge executes via the gate; results return in provider-native shape. Tool errors classify `non-provider` for the circuit breaker (existing KPR-306 rule, unchanged).

**Exception containment invariant:** the bridge's dispatch loop wraps both the guardrail gate and tool execution in its own catch — a throw from the gate, a bridged in-process handler, or the builtin executor becomes a structured error result to the model (mirroring the KPR-122 in-process invariant) and classifies `non-provider`. No hive-internal exception may escape `runTurn` through the bridge path: an uncontained throw would reach the breaker's record path and misread as a hard provider fault — three of those open a healthy provider's circuit and engage the outage queue. Child 3 carries contract tests for this invariant (throwing gate, throwing handler, throwing builtin). `abort()` semantics mid-bridge (in-flight tool call, stdio MCP subprocess lifecycle on abort) are child 3 spec territory — flagged here so they are designed, not discovered.

### D5 — Lane B: memory + skills (shared prompt assembly)

Extract `AgentRunner`'s prefix assembly (soul → systemPrompt → constitution → team roster → toolkit → agent memory → date/time) into a shared builder both lanes consume. Claude lane keeps its KPR-213 prefix cache and byte-identical output (regression-gated); Lane B gets the same assembly minus Claude-specific fragments (e.g. tool-search hints), with the toolkit section rendered from the *bridged* inventory so the model's tool-selection surface stays honest. Two seam notes for child 2: `createProviderAdapter` is synchronous today while prompt assembly is async — the expanded contract needs an async construction/assembly point; and a prompt-assembly throw on the Lane B path (e.g. a Mongo blip during memory fold-in) classifies `non-provider` — it must never count toward a foreign provider's breaker (contract-tested in both child 2's seam and child 4's extraction). Structured-memory tools ride the tool bridge as in-process function tools; hot-tier injection comes with the shared builder. Reflection scheduling is provider-agnostic already (post-quiescence debounce).

Skills: the existing loader/index is reused; the prompt carries the skill index (as today), and a `load_skill` function tool returns a skill's SKILL.md content on demand — mirroring SDK behavior. Per-skill `agents:` scoping applies unchanged.

### D6 — Lane B: resume parity

- **OpenAI:** Conversations API as the durable layer (or `previous_response_id` chaining if the Conversations×Agents-SDK interplay disqualifies it — decided in the child spec; the two mechanisms are mutually exclusive per run). Session ref persisted in `sessions` as today.
- **Gemini:** Interactions API `previous_interaction_id`; `runEphemeral` deleted.
- **Codex:** honest statelessness — hive persists turn history and replays client-side (encrypted reasoning items included); matrix labels it `stateless-replay`.
- **Existing behavior, extended not re-derived:** sessions already carry a `provider` tag (`session-store.ts:12`, written at `agent-manager.ts:1421`), and the KPR-313 session-identity guard (`agent-manager.ts:694-712`) already implements fresh-session-on-provider-transition **with a memory-handoff annotation** (`sessionHandoff` → prepareSpawn prepends the KPR-313 §3.4 annotation). Children 1/5/7/8 extend this guard to the new provider ids — they do not re-implement transition behavior. The rule it enforces stands: cross-provider reassignment starts a fresh session; no cross-provider history migration; the handoff annotation is the continuity bridge.

### D7 — Guardrail parity

Lane A: existing SDK hooks (PreCompact, archetype PreToolUse) run unchanged. Lane B: the bridge's dispatch loop calls the guardrail gate before every tool execution — same archetype rules, same fail-closed-on-error behavior as `buildHooks`. Because Lane B executes all tools client-side (hive's own loop), there is no tool path that bypasses the gate.

### D8 — Ops integration

- **Provider-identity invariant:** Lane A splits "provider" into two concepts — the **route/resolved provider** (`kimi`) and the **adapter class** (`ClaudeAgentAdapter`, whose `readonly provider` field answers `claude`). Every operational surface keys on the *route* provider: circuit-breaker acquire + record, outage-queue episodes, honest-outage notices, `circuit_breaker_stats`/`agent_turn_telemetry`, the session `provider` tag, and the KPR-313 transition guard. The adapter's `provider` field is an implementation detail of the execution path only. The `AgentProviderId` closed union grows to include Lane A providers (child 1). Lane A failures (connect/timeout/auth/5xx from the foreign endpoint) trip the foreign provider's breaker, never Claude's. Open-Circuit Contract fields stay frozen (KPR-306/307 unchanged).
- **Effort:** foreign models use the static `:effort` suffix; the per-turn effort classifier consults `src/llm/catalog.ts` (Claude-only by design — the KPR-322 rule stands) and passes foreign models through untuned. Note: `resolveProviderModel` currently *discards* a parsed `:effort` on `gemini/…` routes — child 7 decides whether it maps to a thinking budget or is documented-unsupported. Documented in the matrix.
- Spawn coordinator, per-thread locks, budgets, retry queue: provider-generic already; no changes.

### D9 — Parity matrix (closing artifact)

A doc (`docs/` public engine docs) with providers × capabilities (tools by transport class, memory tiers, skills, guardrails, resume semantics, subagents, server-side tools, effort tuning), every cell `full | caveat(note) | claude-only | n/a`. This is the "Done means" artifact and the commercialization answer. It also records the ruled non-goals (proxies, cross-provider history carry, catalog effort tuning for foreign models).

## Out of scope

- OpenAI/OpenAI-compatible **sidecar** providers for `src/llm/` (non-agentic one-shot calls) — separate concern; file independently if wanted.
- Translation-proxy passthrough (LiteLLM, claude-code-router) in production.
- Gemini Managed Agents (preview-only) as a design target.
- Voice-pipeline provider reassignment — **enforced, not assumed**: voice routes through the same `spawnTurn` → `createProviderAdapter` path as every channel (`voice-adapter.ts:202-205`), so reassigning a voice-enabled agent would otherwise send voice turns into Lane B with undefined parity. Ruling: the voice spawn path pins the Claude lane (explicit route override at the voice call site — code-enforced, matrix-listed as a caveat on voice-enabled agents) until a post-matrix revisit. When the agent's `model` is non-Claude-routed, voice turns resolve to the engine's default Claude model.
- Cost/pricing normalization across providers beyond what telemetry already records.

## Candidate child decomposition (sequencing at Gate 1)

| # | Child | Depends on | Shape |
|---|---|---|---|
| 1 | Lane A passthrough (Kimi + DeepSeek) **+ resolved-provider ops attribution** | — | provider table, env injection, breaker/telemetry keying, `AgentProviderId` union + session-resumability keying + `:effort` parsing for Lane A prefixes; validation vs live endpoint |
| 2 | Lane B contract expansion | — (informs 3-9) | types + seam wiring; deletes empty-tuple + tool-free asserts; session-semantics descriptor |
| 3 | OpenAI tool bridge | 2 | MCP stdio + http/sse + in-process function tools + builtin executor + guardrail gate + exception-containment contract tests |
| 4 | Memory + skills parity (shared prompt assembly) | 2 | extraction w/ Claude-lane byte-parity regression gate (toolkit renders from the child-2 inventory contract; execution needs child 3, assembly does not) |
| 5 | OpenAI resume (Conversations) | 2 | session descriptor wiring + persistence; extends KPR-313 guard |
| 6 | Production validation — reassign a real agent end-to-end | 3,4,5 | flagship proof (candidate: Milo); includes the inverse transition — reassign back to `claude/…` and verify the KPR-313 handoff |
| 7 | Gemini replication (Interactions + ADK sessions, delete runEphemeral) | 3,4,5 | pattern replication |
| 8 | Codex replication (stateless-replay, documented) | 3,4,5 | pattern replication |
| 9 | Subagent parity (nested adapter turns) | 3 | late; Task omitted from non-Claude inventories until then |
| 10 | Parity matrix + supported-provider ruling | all | closing doc |
| 11 | Hygiene: close PR #194 as superseded | — | no code |

Note child 1 is independently landable at any point (additive at the seam; touches no Lane B surface beyond the shared ops-attribution fix, which Lane B also needs).

## Risks & delegated assumptions

- ⚠ `MCPServerStdio` fidelity vs hive's stdio servers (env passing, lifecycle, concurrent servers) is docs-verified only — child 3 spikes this first.
- ⚠ Kimi/DeepSeek endpoint fidelity for the full runtime (hooks round-trips, subagent traffic, interleaved thinking) is vendor-doc-claimed — child 1 validates against a live endpoint before any production reassignment. That validation explicitly includes CLI credential precedence on a subscription-logged-in machine (active subscription OAuth vs injected `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`).
- ⚠ Conversations API × Agents SDK session-mode mutual exclusivity — child 5 picks the mechanism; both paths are acceptable, the descriptor abstracts the choice.
- ⚠ Builtin-executor semantic drift vs SDK builtins (truncation, timeouts, permission posture under `bypassPermissions`) — child 3 defines the contract tests.
- Prompt-assembly extraction risks Claude-lane prefix regressions — child 4 carries a byte-identity regression gate against KPR-213 cache behavior.
- Provider docs move fast (three of the facts above changed between May and July 2026); each child re-verifies its provider surface at spec time rather than trusting this document.
