# KPR-355 — Parity matrix + supported-provider ruling (closing doc)

**Child 10 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D9 (this child's charter — the "Done means" artifact).
**Shape:** doc only — one new public engine doc plus two scoped staleness corrections in existing docs. Zero runtime code changes (verified against the merged baseline, see §Non-goals; one candidate parity wrinkle found and explicitly ⚠-flagged out to a follow-up, §Open assumptions A1).
**Depends on:** KPR-346–354, KPR-356 — **all merged.** Baseline for every file:line citation below: epic branch `kpr-345` @ `4d2a9de` (KPR-351 merge).
**Decision-register canon honored:** every canon line that ends in a "KPR-355 matrix" obligation is transcribed into a cell in §D3 — the qualified-recall-name edge and Claude bare-name imprecision (KPR-349), toolkit assembly-time vs connect-time fail-soft (KPR-349), codex stateless-replay facts + effort-gated encrypted reasoning + `maxTurns:0` + §D7 heal (KPR-353), openai §D7 row facts (KPR-350), gemini retention/coercion/auth facts + paid-tier gate (KPR-352), subagent rows + Task-builtin delta (KPR-354), kimi/deepseek live-unvalidated caveat (KPR-346 entry 2), per-agent account-provisioning gate (KPR-351 C6), R2 chain-orphan "unit-pinned, no live exercise" wording (KPR-351).

## TL;DR

Write the public supported-provider parity matrix at **`docs/providers.md`**: providers × capabilities with every cell `full | caveat(note) | claude-only | n/a`, grounded cell-by-cell in the merged code (all evidence pre-cited in this spec — the doc writer transcribes, they do not re-research). The doc also records the ruled non-goals (translation proxies, cross-provider history carry, catalog effort tuning for foreign models), the epic's out-of-scope rulings (voice pinned to Claude, sidecar providers, Gemini Managed Agents, cost normalization), the recorded revisit triggers, and each provider's live-validation status. Same pass: fix the two stale doc surfaces this exploration found — `docs/architecture.md`'s pre-KPR-348 "tool-free pilots" sections and CLAUDE.md's `:effort`-suffix sentence.

## Key Points

- **Doc home ruled: `docs/providers.md`** (public engine docs, beside `architecture.md`) — title "Supported providers & parity matrix". `docs/epics/` is workflow history; the commercialization answer belongs in the evergreen docs set. `architecture.md` gains a one-line cross-link.
- **Matrix shape ruled: capability rows × five provider columns** — `claude`, `kimi / deepseek (Lane A)` (one column: identical by construction — same `ClaudeAgentAdapter` path, same env-pin table, per-provider differences are only endpoint/key/default-model), `openai`, `gemini`, `codex`. ~16 capability rows (§D2), every cell value + note pinned in §D3 with file:line evidence.
- **The matrix documents merged reality, not the epic's aspirations** — where canon and code agree (everywhere checked), cells cite both. Notable truths the doc must carry: general-purpose `Task` subagents stay claude-only while delegate-config subagents run everywhere; WebFetch/WebSearch/NotebookEdit/TodoWrite stay claude-only on Lane B *and* are absent on Lane A (server-side tools don't exist on vendor compat endpoints); Lane B prompt assembly is per-spawn and uncached by ruling.
- **Ruled non-goals + out-of-scope transcribed verbatim** (§D4/§D5) with their recorded revisit triggers (Conversations/>30d continuity, Vertex Interactions, Responses-under-subscription-auth, voice post-matrix revisit).
- **Validation-status row is canon-bound, not optional**: codex = live-validated in production (KPR-351 flagship arc); gemini = live tool-turn/resume/sentinel evidence at dev-key level, production gated on a paid-tier key; openai = verified to the 401 boundary, live legs key-conditioned and open; kimi/deepseek = live-unvalidated (V1 credential-precedence GREEN only), production reassignment gated on funded keys.
- **In-scope-but-minor staleness fixes (§D6):** `docs/architecture.md` still describes tool-free pilots and a `GeminiAdkAdapter` (lines 18-20, 27, 43, 87-99 — three merges stale); CLAUDE.md line 243's ":effort applies to codex/openai" is wrong on both halves (gemini consumes it since KPR-352; openai parses-and-drops it). Both corrected in this child's delivery. Deliberately NOT in scope: rewriting CLAUDE.md's (current, accurate) provider-adapters paragraph.
- ⚠ **A1 (non-blocking, flagged not fixed): `openai/<model>:effort` is parsed but never delivered** — the route carries `reasoningEffort` (`agent-manager.ts:178`) but neither `createProviderAdapter` branch passes it (`agent-manager.ts:642-647,755-761`) and `OpenAIAgentsAdapterOptions` has no effort field at all (`openai-agents-adapter.ts:9-14`). The matrix cell documents the truth (`caveat(parsed, not delivered)`); whether to wire it (`modelSettings.reasoning`) is a one-line follow-up ticket, not this doc child's scope.
- ⚠ **A2 (non-blocking): openai token telemetry reports zeros** — `buildResult` hardcodes `inputTokens: 0, outputTokens: 0, …` (`openai-agents-adapter.ts:278-283`) while codex/gemini accumulate real usage. Matrix telemetry cell documents it; candidate follow-up, not scoped here.

## Problem / context

The epic's Done-means clause: *"An agent definition can be pointed at a supported non-Claude provider and retain its documented runtime capability set (tools, memory, skills, guardrails, resume) per the parity matrix ruled in child 6 — with the remaining claude-only capabilities explicitly documented, not silently dropped."* Nine code children delivered the capability set; the R3 honesty surface at runtime is the partition/omission log (`turn-assembly.ts:174-183`), which even names this doc as its hand-off: *"The operator's day-1 answer … until the parity matrix ships (child 10)."* What's missing is the operator- and prospect-facing document. Meanwhile `docs/architecture.md` still tells readers the non-Claude adapters are tool-free — the public docs actively contradict the shipped engine.

## Goals

- G1: `docs/providers.md` exists, carries the full matrix per §D2/§D3, the ruled non-goals (§D4), out-of-scope rulings (§D5), revisit triggers, and per-provider validation status.
- G2: Every cell is transcribed from §D3 (this spec is the research artifact; delivery re-verifies citations only if the epic branch moves).
- G3: `docs/architecture.md` provider-related sections updated to merged reality; cross-link added (§D6).
- G4: CLAUDE.md `:effort` sentence corrected (§D6).
- G5: No runtime code changes; `npm run check` green (docs-only diff — the gate still runs).

## Non-goals

- **Any runtime code change.** Verified during exploration: the matrix can be written truthfully from the merged code with zero fixes. The two wrinkles found (A1 effort-drop, A2 zero token telemetry on openai) are documented as caveats and flagged for follow-up tickets — fixing them here would violate the doc-only shape and re-open review surfaces KPR-351 just validated.
- Re-litigating any canon ruling (Conversations, ADK deletion, Vertex, codex-oauth deletion, proxy exclusion, Task-builtin delta). The matrix records; it does not re-decide.
- Rewriting CLAUDE.md's provider-adapters paragraph beyond the one stale sentence (the paragraph was refreshed by KPR-351/352/353 and matches code).
- A cost/pricing comparison across providers (epic out-of-scope: cost normalization).
- Onboarding/how-to content (key seeding walkthroughs beyond the auth row's one-liners; `managing-your-hive.md` is the how-to home and is untouched).
- Translating the matrix into hive.yaml validation or runtime enforcement.

## Design

### D1 — Doc home, name, audience, and cell legend

- **Path:** `docs/providers.md`. **Title:** "Supported providers & parity matrix".
- **Audience:** operators deciding an agent's `model` field, and commercialization prospects asking "are we locked into Anthropic?" (epic R1). Tone matches `architecture.md`: factual, present-tense, no ticket-number archaeology in the main matrix (ticket refs allowed in a trailing "History" line naming the KPR-345 epic).
- **Cell legend (verbatim from epic §D9):** `full` | `caveat(note)` | `claude-only` | `n/a`. The doc defines the legend once above the matrix. `caveat` cells keep notes short in-table with a footnote section for anything over ~1 line.
- **Structure of the doc:** (1) intro + the two-lane model in ~6 lines (route grammar `<provider>/<model>[:<effort>]`, unknown prefix → Claude, Lane A vs Lane B one-paragraph definitions); (2) the matrix; (3) footnotes; (4) "Ruled non-goals"; (5) "Out of scope (epic rulings)"; (6) "Revisit triggers"; (7) "Validation status" (may merge into the matrix as its final row — writer's polish call); (8) History line.

### D2 — Matrix rows (capability dimensions) and columns

**Columns (5):** `claude` · `kimi / deepseek (Lane A)` · `openai` · `gemini` · `codex`.
Lane A merged into one column: both providers route through the identical `ClaudeAgentAdapter` + `buildPassthroughEnv` path (`agent-manager.ts:586-588`, `passthrough-providers.ts:131-149`); the only per-provider differences (endpoint, key name, default model — `passthrough-providers.ts:41-56`) are listed in the auth row's note, not separate columns.

**Rows (16), in doc order:**

1. Execution path / runtime lane
2. Tools — external MCP servers (stdio / http / sse)
3. Tools — in-process engine MCPs (`sdk-in-process`)
4. Tools — builtins (Bash, Read, Write, Edit, Glob, Grep)
5. Tools — server-side (WebFetch, WebSearch) and remaining builtins (NotebookEdit, TodoWrite)
6. Tool surface limits & honesty (tool cap, omission logging, tool-search deferral)
7. Skills
8. Memory (hot-tier injection, structured recall, FS-tier memory)
9. Guardrails (archetype PreToolUse; PreCompact)
10. Session resume & continuity (semantics, TTL, self-heal, compaction analog)
11. Subagents (delegate Task; general-purpose Task)
12. Reasoning-effort tuning (per-turn classifier; static `:effort`)
13. Prompt assembly & prompt caching
14. Streaming
15. Ops integration (circuit breaker, outage queue, telemetry attribution, usage/cost reporting)
16. Auth & credentials
17. *(final row or standalone section)* Validation status

### D3 — Cell content (transcription source — the doc writer copies from here)

Evidence baseline `kpr-345` @ `4d2a9de`; all paths under `src/` unless noted.

**Row 1 — Execution path.**
- claude: `full` — `ClaudeAgentAdapter` → `AgentRunner` → Claude Agent SDK `query()` (`agents/provider-adapters/claude-agent-adapter.ts`; `agents/agent-manager.ts:578-580`).
- kimi/deepseek: `full` — same full Claude runtime; per-spawn env substitution only (`ANTHROPIC_BASE_URL` + Bearer `ANTHROPIC_AUTH_TOKEN`, model pins incl. subagent pin, `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_ENTRYPOINT` scrub — `passthrough-providers.ts:131-149`; `agent-manager.ts:569-588`).
- openai: `full` — native Agents SDK loop with the hive `ToolBridge` (`openai-agents-adapter.ts:46-85`).
- gemini: `full` — hive-owned bounded Interactions dispatch loop on `@google/genai` (`gemini-interactions-adapter.ts:131+`).
- codex: `full` — hive-owned bounded Responses dispatch loop against `chatgpt.com/backend-api/codex/responses` (`codex-subscription-adapter.ts:10,105+`).

**Row 2 — External MCP (stdio/http/sse).**
- claude: `full` — direct SDK `mcpServers` wiring.
- kimi/deepseek: `full` — same wiring, unchanged.
- openai/gemini/codex: `caveat(fail-soft per server)` — bridged as MCP *clients* via `MCPServerStdio`/`MCPServerStreamableHttp`/`MCPServerSSE` (`tool-bridge.ts:212-261`), tools presented as hive-wrapped function tools with Claude-identical `mcp__<server>__<tool>` names (`tool-bridge.ts:284-303`); a failed connect/listTools drops that server for the turn (warn + runtime-omission record, `tool-bridge.ts:107-127,508-516`); non-text MCP content is flattened to a placeholder (`tool-bridge.ts:541-551`). Classification: `mcp-bridge-candidate` unless the tool needs hive runtime/turn context, then `requires-hive-bridge` (`tool-transport.ts:123-141`).

**Row 3 — In-process engine MCPs** (memory, structured-memory, contacts, event-bus, callback, schedule, team, admin, code-search, workflow).
- claude: `full` — in-process SDK servers (KPR-122).
- kimi/deepseek: `full` — unchanged.
- openai/gemini/codex: `full` — the *same* `McpServer` instances/handlers/`*ContextRef` closures over `InMemoryTransport` (`turn-assembly.ts:110-117,201`; `tool-bridge.ts:263-280`). Classified `requires-hive-bridge` (`tool-transport.ts:123-126`).

**Row 4 — Builtins (Bash/Read/Write/Edit/Glob/Grep).**
- claude, kimi/deepseek: `full` — SDK builtins.
- openai/gemini/codex: `caveat(hive builtin executor)` — hive-native implementations matching the agent-facing contract (`builtin-executor.ts:28-30` names; timeouts/truncation constants at `:16-22`). Documented deltas: Read supports text only — no images/PDFs/notebooks (`builtin-executor.ts:24-26,52-56`); Grep is a JS-regex subset with explicit supported options (`:114-119`); Bash cwd/env do not persist between calls (parity with SDK contract); Edit/Write accept empty `new_string`/`content` (deletion/truncation parity — KPR-349 §D8, so **no** matrix delta there). Same `bypassPermissions`-equivalent posture: no sandbox beyond the guardrail gate (`builtin-executor.ts:1-8`).

**Row 5 — Server-side tools + remaining builtins.**
- claude: `full` — WebFetch/WebSearch/NotebookEdit/TodoWrite/Task via SDK.
- kimi/deepseek: `caveat(no Anthropic server-side tools)` — WebFetch/WebSearch don't exist on vendor compat endpoints; client-side substitutes (brave-search MCP, browser/CDP) remain available (epic §D2 caveat list).
- openai/gemini/codex: `claude-only` — WebFetch, WebSearch, NotebookEdit, TodoWrite classify `claude-only` and are partition-omitted with logged reasons (`tool-transport.ts:92-121`; `turn-assembly.ts:174-183`).

**Row 6 — Tool surface limits & honesty.**
- claude, kimi/deepseek: `full` — no hive-imposed cap; tool-search deferral (KPR-329) available on claude, **forced off** on Lane A (`ENABLE_TOOL_SEARCH="false"`, `passthrough-providers.ts:142`) → note as `caveat(tool-search off; eager schemas only)` for Lane A.
- openai/gemini/codex: `caveat(128-tool cap, two-tier)` — provider cap 128 (`tool-bridge.ts:34`); Tier-0 pins (six builtins + `load_skill` + `Task`) never cap-dropped, Tier-1 (MCP-discovered) tail-drops in inventory order, every drop omission-logged (`tool-bridge.ts:459-478`). Name sanitization/dedup for provider constraints (`:438-457`). Tool-search deferral `n/a` (Lane B builds its own inventory). Honesty note (KPR-349 canon): the toolkit prompt section renders from the assembly-time inventory while bridge connects are runtime fail-soft — a server listed in the toolkit can be absent for one turn if its connect fails (omission-logged).

**Row 7 — Skills.**
- claude, kimi/deepseek: `full` — SDK plugin/skill loading, per-skill `agents:` scoping via projections.
- openai/gemini/codex: `caveat(index + load_skill)` — skill index derived from the agent's already-scoped SDK plugin list (dir-name-keyed, first-wins, per-skill fail-soft — `skill-index.ts:21-60`), rendered in the prompt (`prefix-builder.ts:296-302`), full SKILL.md fetched on demand via the `load_skill` bridged tool (`tool-bridge.ts:353-375`). Mirrors the SDK's function, not its bytes. Legacy-layout skills load via projection (KPR-351 live-validated on codex).

**Row 8 — Memory.**
- All five columns `full`, with Lane B notes: hot-tier injection uses the same `memorySections`/`getHotTierPrompt` on both lanes (`prefix-builder.ts:159-196,346-352`; `memory/memory-manager.ts:73-144`); structured recall rides the bridge — but the model-visible tool name differs: Lane B teaches `mcp__structured-memory__memory_recall`, the Claude lane keeps the bare `memory_recall` trailer (KPR-349 option (a); `prefix-builder.ts:350`, `memory-manager.ts:130-141`). Two canon-required notes: the Claude-lane bare name is a documented imprecision (the callable tool is the qualified name), and the Lane B qualified name is a staleness edge if the server/tool is ever renamed. FS-tier memory (`/memories` six-command surface) bridges as an in-process MCP (row 3). Reflection scheduling is provider-agnostic (post-quiescence debounce).

**Row 9 — Guardrails.**
- claude, kimi/deepseek: `full` — SDK hooks (archetype PreToolUse + PreCompact) unchanged.
- openai/gemini/codex: `caveat(no PreCompact)` — archetype PreToolUse ported as the fail-closed guardrail gate wrapping every bridged execution (first-deny-wins, throw-is-deny, assembly-throw ⇒ deny-all — `turn-assembly.ts:144-155`, `archetype-gate.ts`, `tool-bridge.ts:320-338`); no tool path bypasses the gate (hive executes all tools client-side). PreCompact is `n/a` (no Claude-style compaction on Lane B — see row 10's per-provider overflow analogs).

**Row 10 — Session resume & continuity** (descriptor: `types.ts:69-83`; persistence keying `agent-manager.ts:1829-1850`; store TTL 7d idle `session-store.ts:55-56`).
- claude: `full` — `client-transcript`; SDK resume with stable ids; compaction native.
- kimi/deepseek: `caveat(cold vendor cache)` — `client-transcript`; resume replays the local transcript against the vendor endpoint (re-billed tokens, no warm cache).
- openai: `caveat(7d horizon; ZDR unsupported)` — `server-resumable` via `previous_response_id` chaining, handle rewritten every turn (`openai-agents-adapter.ts:83-91,230-232`); `store:true` + `truncation:"auto"` pinned (truncation is the compaction analog); 7d sessions TTL < 30d server retention makes a live handle never-expired by arithmetic; stale handles self-heal via one manager-level adopt-or-fresh retry, breaker-invisible, one exchange of context lost (`agent-manager.ts:299-314,1013-1069`); Conversations API deliberately unused; ZDR orgs can't chain (documented caveat). Chain-orphan closure is unit-pinned, no live exercise (KPR-351 R2 wording — canon-bound).
- gemini: `caveat(1d free-tier retention)` — `server-resumable` via `previous_interaction_id` chaining; `store:true` pinned; 7d store TTL < 55d paid retention but **1d on the free tier** (self-heal degrades idle free-tier threads to daily fresh context); stale-handle detection is a hive-owned deterministic sentinel (round-1 + persisted handle + status 400 + message discriminator — `gemini-interactions-adapter.ts:30-45`), healed by the same manager arm; no truncation analog — context overflow lands in a chain restart via self-heal.
- codex: `caveat(hive-persisted replay)` — `stateless-replay`; the surface hard-enforces `store:false`, no server handle exists; hive persists turn history (`provider_turn_history`, ~200k-char whole-turn trim window, 7d TTL — `turn-history-store.ts:13,17,110`) and replays client-side incl. encrypted reasoning items; poisoned-replay self-heal: first-round 4xx on non-empty replay ⇒ one history-cleared fresh retry (`codex-subscription-adapter.ts:202,264-279`).
- All columns: cross-provider reassignment starts a **fresh session** with the KPR-313 memory-handoff annotation (no history carry — `agent-manager.ts:940-975`, notices `:265-268`); codex handoff additionally clears replay history (`:970-972`).

**Row 11 — Subagents.**
- claude, kimi/deepseek: `full` — SDK Task tool: delegate subagents *and* general-purpose subagents (arbitrary `subagent_type`), foreign-model-pinned on Lane A (`CLAUDE_CODE_SUBAGENT_MODEL`).
- openai/gemini/codex: `caveat(delegates only)` — one Claude-identical synthesized `Task` tool from the agent's `delegateServers` (enum-restricted `subagent_type` — `tool-bridge.ts:389-435`); execution is a nested same-provider adapter turn (delegate prompt, that server + the six builtins, maxTurns 7/10 parity — `turn-assembly.ts:243-297`) through a manager-owned runner (`agent-manager.ts:607-731`): budget-accounted (denial-not-wait; **`spawnBudget ≥ 2` required** for delegates), lock-exempt, abort-chained, depth-1 structural, session-less/history-less, breaker-invisible (faults = Task tool text). **General-purpose subagents are `claude-only`** (the Task BUILTIN entry classifies claude-only — `tool-transport.ts:92-121`). Observability note: nested turns are invisible in `getSnapshot().activeSpawns`; surface = `saturationCount` + completion log. Provisioning note (KPR-351 C6, lane-symmetric): a delegate whose underlying MCP needs per-agent account provisioning (e.g. google/gog) won't synthesize until provisioned — correct behavior, all lanes.

**Row 12 — Reasoning-effort tuning.**
- claude: `full` — per-turn effort classifier, catalog-driven (`llm/catalog.ts`; router gate `agent-manager.ts:1690-1715`).
- kimi/deepseek: `caveat({low,medium,high} only)` — classifier skipped (off-catalog by design); static `:effort` delivers through the Claude adapter's effort channel, clamped to `{low,medium,high}` — other values warn-once and drop (`agent-manager.ts:1563-1580,1671-1683`). `kimi/:high` (missing model) is a vendor-4xx config fault, documented non-goal.
- openai: `caveat(parsed, not delivered)` — the `:effort` suffix parses into the route (`agent-manager.ts:178,198-200`) but no delivery channel exists in the adapter (⚠ A1); effectively no effort control today.
- gemini: `caveat(thinking_level coercion)` — `:effort` → `generation_config.thinking_level`; `none→minimal`, `xhigh→high` coerced warn-once (`gemini-interactions-adapter.ts:52-66,413-425`).
- codex: `caveat(effort-gated reasoning replay)` — `:effort` passes through as `reasoning:{effort}` (`codex-subscription-adapter.ts:242`); **without** an `:effort` suffix the backend emits no reasoning items, so effort-less codex agents replay without encrypted reasoning (functional continuity, reduced multi-round replay quality).
- All non-claude: catalog-driven per-turn tuning is a ruled non-goal (§D4).

**Row 13 — Prompt assembly & caching.**
- claude: `full` — `buildPrefix` composition, KPR-213 write-through prefix cache, datetime appended post-cache (`prefix-builder.ts:223-264`).
- kimi/deepseek: `caveat(vendor cache economics)` — identical assembly + prefix cache hive-side; vendor-side prompt-cache behavior/pricing differs per endpoint.
- openai/gemini/codex: `caveat(uncached, per-spawn)` — same shared section helpers via `buildProviderInstructions` (soul → archetype card → systemPrompt → constitution → team summary → toolkit → file-tier guidance → skills → memory → datetime last — `prefix-builder.ts:313-357`); rebuilt every spawn, PrefixCache is Claude-only by ruling. Provider-side caching is whatever the vendor does with a stable prefix.

**Row 14 — Streaming.**
- All five: `full` — Claude SDK streaming; Lane A unchanged; openai `toTextStream` (`openai-agents-adapter.ts:218-228`); gemini streaming Interactions; codex SSE (`codex-subscription-adapter.ts`).

**Row 15 — Ops integration.**
- All five: `full` for breaker/outage/attribution — per-provider circuit breaker + honest-outage queue key on the **route** provider (a kimi outage trips the `kimi` breaker only); tool/assembly faults classify `non-provider` and never trip (`error-classification.ts:128-149`); telemetry (`agent_turn_telemetry`, `circuit_breaker_stats`) route-keyed; `llmMs` excludes tool time on every tool-executing lane.
- Usage/cost caveats: kimi/deepseek `caveat(costUsd nominal — Claude pricing math)`; openai `caveat(token counts report 0 — ⚠ A2)`; gemini/codex `caveat(costUsd 0 — subscription/API accounting out of scope)` with real token counts.

**Row 16 — Auth & credentials.**
- claude: `full` — subscription OAuth (fleet posture: no `ANTHROPIC_API_KEY`).
- kimi/deepseek: `full` — `KIMI_API_KEY` / `DEEPSEEK_API_KEY`, per-spawn env→Keychain (Honeypot) resolution; `hive credentials add` takes effect next spawn; missing key = breaker-invisible config fault (`passthrough-providers.ts:90-116`). Endpoints/defaults: `api.moonshot.ai/anthropic` / `kimi-k3`; `api.deepseek.com/anthropic` / `deepseek-v4-pro` (`:41-56`).
- openai: `caveat(.env only)` — API-key single path (`OPENAI_API_KEY`); no Keychain/registry leg yet — seed in instance `.env` + restart (`openai-agents-adapter.ts:199-216`); missing key fast-fails `auth`-classified into honest outage.
- gemini: `caveat(paid-tier key for production)` — API-key single path (`GEMINI_API_KEY` et al. — `gemini-interactions-adapter.ts:92-94,189-199`), Honeypot-supported; **free-tier keys train on data** — production assignment requires a paid-tier key; no Vertex.
- codex: `full` — subscription OAuth (`~/.codex/auth.json`, `oauth-credentials.ts`).

**Row 17 — Validation status** (canon-bound wording, §Key Points bullet 5): codex `production-validated`; gemini `live-validated (dev key); production gated on paid tier`; openai `unit + 401-boundary; live legs key-conditioned, open`; kimi/deepseek `live-unvalidated; production reassignment gated on funded-key validation`; claude `production (baseline)`.

### D4 — Ruled non-goals section (transcribe into the doc)

Per epic §D9 + canon, each with its recorded rationale in one line:

1. **Translation proxies (LiteLLM, claude-code-router) in production Lane A** — unowned middlebox in the credential/fidelity path; only vendor-operated Anthropic-compat endpoints qualify.
2. **Cross-provider history carry** — reassignment starts a fresh session; the KPR-313 memory-handoff annotation is the continuity bridge; codex replay history is cleared on handoff.
3. **Catalog-driven per-turn effort tuning for foreign models** — foreign models use the static `:effort` suffix; the effort classifier stays Claude-lane (KPR-322 rule).

### D5 — Out-of-scope section (transcribe, verbatim rulings from epic §Out of scope + canon)

- **Voice is pinned to the Claude lane** — code-enforced at the voice spawn path; a voice-enabled agent with a non-Claude `model` runs voice turns on the engine's default Claude model. Matrix-listed caveat on voice-enabled agents; post-matrix revisit.
- **OpenAI/OpenAI-compatible sidecar providers** for `src/llm/` (non-agentic one-shot calls) — separate concern (recorded in KPR-356).
- **Gemini Managed Agents** (preview) as a design target.
- **Cost/pricing normalization** across providers beyond existing telemetry.

**Revisit triggers subsection** (recorded, so the doc is the durable home): sessions TTL >30d or >30d continuity requirement ⇒ Conversations re-evaluation as a new ticket (KPR-350); Interactions ships on Vertex ⇒ Vertex auth re-evaluation (KPR-352); OpenAI serves Responses under subscription auth ⇒ new ticket, not a re-add (KPR-351 R1); a future tool-less Lane B provider must re-gate `toolsExecutable` explicitly (KPR-352).

### D6 — Staleness corrections (same delivery pass, scoped)

1. **`docs/architecture.md`** — update only the provider-related passages (flow-diagram lines 18-20, overview line 27, key-source line 43, and the §"Provider tool transport compatibility" block at 87-99) from "tool-free pilots / GeminiAdkAdapter / future bridge" to the merged two-lane reality (bridge live on all three Lane B providers, Gemini = Interactions adapter, Lane A passthrough exists), plus a pointer to the new `docs/providers.md`. Keep it summary-depth — the matrix doc owns the detail.
2. **`CLAUDE.md` line 243** — replace "The optional `:effort` suffix (…) applies to codex/openai." with an accurate sentence: consumed by codex (`reasoning.effort`) and gemini (`thinking_level`, coerced), clamped-delivered on Lane A, currently parsed-but-not-delivered on openai. One sentence; nothing else in the paragraph changes.
3. **Explicitly NOT corrected here:** the Lane B session-handoff notice still using the tool-free pilot variant (KPR-352 carried observation — a code change, already a recorded candidate follow-up, out of a doc child's scope).

## Edge cases / risks

- **Doc drifts from code post-merge:** the History line pins the evidence baseline (`kpr-345` @ `4d2a9de`); the KPR-358 convergence child and future provider children inherit the update duty (each Lane B child already carries a "matrix row" obligation pattern).
- **Citing file:line in a public doc:** don't — the public doc states behavior; file:line stays in this spec. Prevents instant staleness of the public artifact.
- **`npm run check` on a docs-only diff:** still run (lint/format cover markdown-adjacent tooling; the gate is cheap and the workflow requires it).

## Open assumptions

- ⚠ **A1 (non-blocking):** openai `:effort` parse-and-drop is documented as a caveat, not fixed. If the epic driver rules it a bug, it's a separate one-line follow-up ticket (wire `route.reasoningEffort` → Agents SDK `modelSettings.reasoning`); the matrix cell is truthful either way and the doc needs a one-word edit ("not delivered" → "delivered") when that lands.
- ⚠ **A2 (non-blocking):** openai adapter's zeroed token telemetry documented as-is; candidate follow-up ticket.
- ⚠ **A3 (non-blocking):** doc filename `docs/providers.md` and the merged Lane A column are drafter rulings within Gate-1 delegation; trivially reversible at plan review.
- ⚠ **A4 (non-blocking):** validation-status wording is transcribed from canon as of 2026-07-24; if openai/gemini keys are seeded before delivery, the delivery pass updates those two cells from the then-current register.

## Verification

- Every §D3 cell spot-checkable against the cited file:line at the delivery baseline (re-cite if the epic branch advances).
- `docs/providers.md` contains: legend, 5 columns × 16 rows + validation status, footnotes, ruled non-goals (3), out-of-scope (4), revisit triggers (4).
- `docs/architecture.md` no longer contains "tool-free", "GeminiAdkAdapter", or "until the provider tool bridge lands" in provider contexts; cross-link present.
- CLAUDE.md `:effort` sentence matches row 12 truth.
- `npm run check` green.
