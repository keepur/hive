# KPR-329 — W6.3: Tool search / deferred loading adoption — Spec

_Epic: KPR-326 (W6 — Memory & harness modernization, opportunistic wave). Ticket: "Adopt for delegate-heavy agents; tool-selection accuracy degrades past 30–50 tools; deferred loading cuts definition overhead ~85% without breaking prompt cache. Complements the coreServers whitelist."_

_Note: KPR-326 is pre-register — the epic carries no `## Decision Register — Canon` section yet. Decisions below are made under Gate 1 delegation and ⚠-flagged where assumed._

## TL;DR

The installed Claude Agent SDK (v0.2.104 per `package-lock.json`; `package.json` pins `^0.2.63`) ships ToolSearch/deferred tool loading **turnkey inside the bundled CLI** — controlled solely by the `ENABLE_TOOL_SEARCH` env var, not by any typed `query()` option. Hive adopts it by pinning that env var explicitly in the per-spawn `env` block `AgentRunner` already passes to `query()`: a global `toolSearch.mode` in hive.yaml (default `auto` — the CLI's own token-threshold mode) plus an optional per-agent override field. No hive-built deferral machinery, no MCP wiring changes, no prompt-cache impact — both hive's KPR-213 string-prefix cache and the API-level prompt cache are preserved by construction.

## Key Points

- **SDK finding: native, turnkey, env-gated.** The CLI bundled in `@anthropic-ai/claude-agent-sdk@0.2.104` implements deferred MCP-tool loading via a `ToolSearch` tool + `tool_reference` blocks. Modes (from the bundle, `getToolSearchMode`): `ENABLE_TOOL_SEARCH` truthy → always-on (`tst`); `auto` / `auto:N` → threshold mode (`tst-auto`, default threshold ≈ 10 % of context in deferred-tool tokens; `auto:N` sets N %; `auto:0` ≡ always-on, `auto:100` ≡ off); explicit falsy → off (`standard`). There is **no typed `Options` field** — the SDK surfaces only the read side (`get_context_usage` reports `mcpTools[].isLoaded` and deferred categories).
- **⚠ Hive may already be riding an implicit default.** At 0.2.104, an *unset* `ENABLE_TOOL_SEARCH` resolves to always-on (`tst`) for first-party Anthropic endpoints — and `AgentRunner` spreads `...process.env` into the spawn env without setting it. Pinning the value explicitly is therefore partly a **hardening** move (stop riding a drifting experimental-beta default), not purely an enablement. Runtime verification of current live behavior is a P0 implementation task (CLI debug logs print `[ToolSearch:optimistic] mode=…`; `get_context_usage` shows per-tool `isLoaded`).
- **The real weight is the parent session, not the delegates.** `delegateServers` are already lazy at the parent level: `buildServerSubAgents()` turns each into a Task-dispatched subagent whose tool schemas load only in the subagent's own context. What loads eagerly every parent turn is `coreServers` + auto-injected servers (`schedule`, `team`, `team-roster`, `skill-author`, `structured-memory` pairing, `workflow` when enabled) + plugin servers + hosted Slack MCP. The Universal-9 baseline alone lands ≈ 45–60 MCP tools before plugins (counted from source: memory 5, structured-memory 8, contacts 5, callback 3, schedule 4, team 2, team-roster 4, workflow 8, admin 13 where granted, plus slack/keychain/event-bus/conversation-search/skill-author) — squarely past the ticket's 30–50 accuracy cliff. "Delegate-heavy" agents (CoS-class) are the worst cases but every agent benefits.
- **Adoption policy: SDK `auto` mode globally, per-agent override as escape hatch.** We do **not** build a hive-side tool-count threshold — the CLI's `tst-auto` mode *is* the threshold policy (token-measured, model-aware, maintained upstream). hive.yaml `toolSearch.mode: auto | on | off` (default `auto`), optional agent-definition field `toolSearch: "auto" | "on" | "off"` for exceptions — blacklist-the-exceptions posture per the simplicity principle.
- **Prompt cache: claim confirmed, with the right distinction.** KPR-213's prefix cache caches the assembled system-prompt *string* engine-side — tool definitions are not part of it; unaffected. The API prompt cache prefixes tools → system → messages; deferral makes the tools block *smaller and stable* (names via reference, not full schemas), and discovered schemas ride in the message stream as `tool_reference` expansions — append-only, cache-safe. Discovered-tool state survives session resume and compaction (the CLI carries `preCompactDiscoveredTools` across compact boundaries).
- **Built-in guardrails we inherit for free:** models containing "haiku" are excluded (tool search requires `tool_reference` support — Sonnet 4+/Opus 4+), so Milo/Rae silently stay eager-loaded; non-first-party `ANTHROPIC_BASE_URL` proxies auto-disable; `disallowedTools: ["ToolSearch"]` disables per-session.
- **Out of scope:** building a hive-owned deferral layer (moot — SDK provides it); pilot provider adapters (Codex/OpenAI/Gemini run with empty tool inventories today; `tool-transport.ts` unchanged); any change to `coreServers`/`delegateServers` semantics or the KPR-184 in-process constraint; toolkit-section redesign (it becomes *more* valuable as the name-level discovery layer — kept as-is, plus one optional line).
- **Risks:** (1) selection-accuracy regression — an agent may fail to discover a deferred tool it needs; mitigated by the KPR-87 toolkit section (names + blurbs stay in the prompt) and the CLI's own deferred-tool announcements; (2) ⚠ whether in-process SDK-transport servers (`createSdkMcpServer`) are classified deferrable by the CLI's eligibility filter is unverified — if they aren't, deferral covers only stdio/http servers, which still captures slack + all tier-2/3 servers; verify at runtime.
- **Rollback:** `toolSearch.mode: off` in hive.yaml + restart ⇒ `ENABLE_TOOL_SEARCH=false` ⇒ CLI `standard` mode, all schemas eager, exactly today's (intended) behavior. Per-agent: `admin_agent_update` + SIGUSR1. Resumed sessions with `tool_reference` blocks in history remain valid under `standard` mode (all tools loaded ⊇ referenced tools). No data, no migration, no session invalidation.

---

## 1. Problem

Every hive agent turn spawns a CLI session whose parent context eagerly carries the full JSON schema of every MCP tool on every mounted server. The Universal-9 coreServers baseline plus engine auto-injected servers alone is ~45–60 MCP tools (≈ 15–25 k tokens of definitions, model-dependent); CoS-class agents with plugins (google ≈ 15+ tools), admin, and extra coreServers exceed 70–80. Published guidance and the ticket both put the tool-selection accuracy cliff at 30–50 tools. Hive pays this cost:

1. **In tokens** — the tools block is re-sent (cache-read at best) on every request of every turn of every agent.
2. **In accuracy** — more simultaneous full schemas means worse tool selection, the exact failure mode the coreServers whitelist was designed to bound. The whitelist bounds *which* servers mount; it cannot bound the schema weight of the servers an agent legitimately needs.

Meanwhile the SDK hive already ships has the fix built in, and — at the installed version — may be applying an experimental default hive has never consciously chosen (see Key Points). Hive should adopt the mechanism *explicitly*: pin the mode, choose the policy, verify the behavior, own the rollback.

### What deferred loading does (mechanics, from the 0.2.104 bundle)

When enabled, eligible MCP tool schemas are **not** placed in the request's tools block. A lightweight `ToolSearch` tool is exposed instead; deferred tools are known by name. When the model queries ToolSearch (or the auto layer matches), full schemas are surfaced via `tool_reference` blocks in the message stream, after which the tool is callable. Discovered-tool names are extracted from message history on resume and carried across compaction — a session that discovered `mcp__linear__create_issue` keeps it through compaction. This session's own harness (Claude Code with deferred tools + ToolSearch) is the existence proof of the UX; the SDK CLI is the same binary.

## 2. Goals

1. Explicit, engine-owned control of ToolSearch mode for every Claude-provider spawn — never ride the CLI's implicit default again.
2. Default posture `auto`: the CLI defers MCP tool schemas only when their weight crosses its token threshold (~10 % of context), so small agents see zero change and heavy agents get relief automatically.
3. Per-agent override for exceptions (an agent whose workflow demonstrably suffers from deferral, or one we want always-on for measurement).
4. Verified runtime evidence: before/after context-usage measurements for at least one heavy agent (Mokie or Hermi class) and one light agent, captured in the PR.
5. Zero change to: MCP server wiring, coreServers/delegateServers semantics, delegate subagent construction, toolkit section structure, prefix cache, session resume.

## 3. Non-goals (loud)

- **No hive-built deferral layer.** The contingency design (synthetic `tool_search` MCP tool + stub registrations) is moot — the SDK provides the mechanism turnkey. Do not build any part of it.
- **No per-tool or per-server deferral policy.** The CLI decides eligibility; hive sets only the mode. If finer control is ever needed, that's a new ticket against SDK capabilities.
- **No pilot-adapter work.** `CodexSubscriptionAdapter` / `OpenAIAgentsAdapter` / `GeminiAdkAdapter` carry empty tool inventories (KPR-231–234); deferral is meaningless there until tool bridging lands. `tool-transport.ts` classifications unchanged.
- **No hive-side tool counting/threshold logic.** Do not implement "count tools, compare to 30–50, flip flag" — that duplicates `tst-auto` worse (chars vs. tokens, no model awareness) and violates code-enforce-don't-duplicate.
- **No toolkit-section restructuring.** One optional additive line only (§5.4).
- **No change for Haiku agents.** The SDK excludes them; we do not paper over that.

## 4. Design

### 4.1 Mechanism — pin `ENABLE_TOOL_SEARCH` in the spawn env

`AgentRunner` already passes an `env` object to `query()` (agent-runner.ts ~line 1771, currently `{ ...process.env, ANTHROPIC_API_KEY?, CLAUDE_AGENT_SDK_CLIENT_APP, CLAUDECODE: undefined }`). Add one deterministic entry:

```
ENABLE_TOOL_SEARCH: resolveToolSearchEnv(agentConfig, config)
```

Mapping (single pure function, unit-tested):

| resolved mode | env value | CLI behavior |
|---|---|---|
| `auto` (default) | `"auto"` | `tst-auto` — defer only past ~10 % context threshold |
| `on` | `"true"` | `tst` — always defer eligible MCP tools |
| `off` | `"false"` | `standard` — eager, today's intended behavior |

Resolution order: agent-definition `toolSearch` field → hive.yaml `toolSearch.mode` → engine default `"auto"`. The value is **always set** (never left to ambient `process.env` / CLI default). If the operator's ambient environment contains `ENABLE_TOOL_SEARCH` or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, the engine value wins for the former; for the latter, log a warn at spawn if set (it force-disables tool search inside the CLI and would silently defeat `on`/`auto`).

⚠ Delegated choice: we do **not** expose `auto:N` threshold tuning in hive.yaml v1. `auto` ≡ the CLI default threshold. If measurement shows the 10 % default is wrong for hive workloads, add `toolSearch.autoThresholdPercent` then (liberal-loader pattern makes this additive).

### 4.2 Config surface

**hive.yaml** (all keys optional; absent section ≡ `{ mode: "auto" }`):

```yaml
toolSearch:
  mode: auto   # auto | on | off
```

Loaded in `src/config.ts` following the KPR-225 F3 liberal-loader pattern (unknown keys ignored, invalid values → warn + default).

**Agent definition** (MongoDB `agent_definitions`): optional string field `toolSearch: "auto" | "on" | "off"`. Absent ⇒ inherit global. Validated in `agent-registry.ts` load-time sanitization (invalid value → log error, treat as absent — same pattern as KPR-184 delegateServers sanitization) and in `admin_agent_create`/`admin_agent_update` (reject invalid values at write time). Hot-reloadable via SIGUSR1 like any definition field; takes effect next spawn (per-turn spawn model means no long-lived session to invalidate).

### 4.3 What is (and is not) affected per spawn

- **Parent session MCP tools** (post-`filterCoreServers`: coreServers + auto-injected + plugins + slack): deferral applies here — this is the payload.
- **Delegate subagents** (`agents:` option, one per delegateServer): unchanged wiring. Each subagent session has few tools (one server), so deferral rarely triggers inside them under `auto`; harmless either way. ⚠ Assumed: the CLI applies the same mode process-wide to subagent contexts; no per-subagent knob exists and none is needed.
- **SDK builtins** (Bash/Read/…): the CLI manages builtin deferral separately (`deferredBuiltinTools`); not hive's concern, no knob, no change.
- **Model routing:** the model router may pick Haiku for simple turns even on a Sonnet-ceiling agent — those turns silently run `standard` (SDK model gate). No hive handling needed; mode is best-effort per request, and mixed modes across turns of one session are safe (see rollback/edge cases).

### 4.4 Toolkit section (KPR-87) — one optional line

The toolkit section already lists every server + blurb in the system prompt; under deferral it is the agent's name-level map of what exists — exactly the discovery aid that keeps deferred tools findable. Keep it verbatim. Optionally (implementer's judgment, ≤ 1 line, only when resolved mode ≠ `off`): append a sentence such as "Some tool schemas load on demand — if a listed tool isn't directly callable, search for it by name first." ⚠ Verify first whether the CLI already injects equivalent guidance when tool search is active (it does in Claude Code interactive; presence in SDK-spawned sessions unverified) — if it does, skip the line entirely to avoid double-prompting.

Note: this line lives in the cached prefix and differs by resolved mode — the prefix cache key already varies per agent, and mode changes are operator-rare, so no KPR-213 invalidation plumbing is needed beyond the existing agent-def-update hook (the `toolSearch` field change already invalidates via the definition-update path).

### 4.5 Observability

- **Spawn log line** (debug level): resolved mode + source (`agent | hive.yaml | default`) — mirrors the spawnBudget `source=` pattern.
- **Turn telemetry:** no new fields in v1. The CLI's `get_context_usage` control request is the measurement surface for the verification task; wiring it into `agent_turn_telemetry` permanently is a follow-up if we want trend data (⚠ delegated: deferred, not included — keep the change small per clean-wrap-over-debt this is a wrap, not debt: nothing depends on it).
- **`hive doctor`:** no new section in v1. Mode is static config, not health.

## 5. Integration points (files touched)

| File | Change |
|---|---|
| `src/config.ts` | `toolSearch` section (liberal loader, default `{ mode: "auto" }`) |
| `src/agents/agent-runner.ts` | `resolveToolSearchEnv()` + set `ENABLE_TOOL_SEARCH` in the `query()` env block; warn on ambient `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` |
| `src/agents/agent-registry.ts` | load-time sanitization of the optional `toolSearch` field |
| `src/admin/admin-mcp-server.ts` | accept/validate `toolSearch` on create/update |
| `src/agents/toolkit-section.ts` | optional one-line addendum (§4.4, conditional) |
| CLAUDE.md | one gotcha bullet (mode semantics + rollback) |
| Tests | unit: env mapping matrix (agent override × yaml × default × invalid values); registry sanitization; admin validation. Runtime verification per §6. |

No changes to: `buildServerSubAgents`, `filterCoreServers`, `in-process-servers.ts`, `prefix-builder.ts` core, `prefix-cache.ts`, provider adapters, dispatcher.

## 6. Verification contract

1. **Baseline capture (pre-change):** on the dev instance, one heavy agent + one light agent — issue `get_context_usage` (or read CLI debug logs `[ToolSearch:optimistic] mode=…`) to record current mode and per-tool `isLoaded`. This also settles the ⚠ "already implicitly on?" question — if live behavior is already `tst`, the ticket's win is partly *already banked* and this change converts it from accident to policy; the PR must say which.
2. **Post-change, mode matrix:** `off` → all MCP tools `isLoaded: true`; `on` → eligible MCP tools deferred, ToolSearch present; `auto` on heavy agent → deferred; `auto` on light agent → eager (below threshold).
3. **Functional:** heavy agent completes a turn that requires a deferred tool (e.g. a Linear or google call) — the CLI discovers and executes it without operator intervention.
4. **Cache sanity:** compare `cache_read_input_tokens` across two consecutive same-thread turns under `on` — cache reads persist (no prefix bust from discovery in turn 1).
5. **In-process eligibility (⚠ open):** record whether SDK-transport (in-process) server tools show as deferrable. Outcome documented in the PR either way; no code branches on it.
6. **Negative-verify** (per feedback_negative_verify_regression_tests): with `off` pinned, confirm the env value is literally `"false"` in the spawned process (test asserts the env map), not merely absent.

## 7. Edge cases

- **Haiku-ceiling agents (Milo, Rae) and Haiku-routed turns:** SDK model gate silently yields `standard`. No error, no log spam (CLI logs once per process).
- **Mixed modes across a resumed session** (mode flipped between turns, or model routing alternates): safe by construction — `standard` turns load all tools (superset of any referenced set); `tst` turns re-derive discovered tools from history.
- **Operator proxy (`ANTHROPIC_BASE_URL` non-first-party):** CLI auto-disables unless `ENABLE_TOOL_SEARCH` is explicitly set; since hive now always sets it, `on`/`auto` will attempt tool search through a proxy — if the proxy strips `tool_reference` blocks, turns degrade. Doc note in CLAUDE.md gotcha: proxy operators should set `toolSearch.mode: off`. ⚠ Delegated: no proxy detection logic in hive (only known deployments are first-party subscription auth).
- **Older deployed SDK versions:** `^0.2.63` range means an instance could resolve a version where `ENABLE_TOOL_SEARCH` semantics differ or are absent — the env var is then inert or falls back gracefully (unknown values map to defined modes; worst case `standard`). No version sniffing; lockfile-driven deploys make this theoretical.
- **`disallowedTools` interactions:** hive doesn't set `disallowedTools`; archetype `sessionOptions` are allowlist-merged and can't inject it. No path to accidental ToolSearch removal.
- **Agent confusion on deferred tools:** the failure mode is an agent claiming "I don't have tool X" when X is deferred. Mitigations: toolkit section names (always present), CLI's deferred-tool announcements, and `auto` default (small agents never defer). If a specific agent regresses, per-agent `off` is the targeted fix — scope correction, not rollback.

## 8. Open assumptions (all ⚠, none blocking)

1. **Current live default** — 0.2.104 appears to default tool search *on* for first-party endpoints; verified from the minified bundle, not yet from a live hive session. Settled by verification task §6.1 before merge.
2. **In-process SDK-server eligibility** — unknown; §6.5 documents, nothing branches on it.
3. **CLI-injected discovery guidance in SDK sessions** — determines whether the toolkit one-liner ships (§4.4).
4. **No `auto:N` tuning surface in v1** — add later if measurement demands.
5. **Telemetry deferral** — no permanent context-usage telemetry in v1.
6. **Subagent contexts inherit the process-wide mode** — no per-subagent knob exists; assumed uniform.
