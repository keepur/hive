# KPR-327 — W6.1: Memory legacy cutover — Spec

_Epic: KPR-326 (W6 — Memory & harness modernization). Binding input: [KPR-328 spike verdict](kpr-328-verdict.md) (hybrid — native shape for the file tier, keep structured/tiered memory). Finishes the "Phase 3: Cut over" left open by the 2026-03-21 memory-lifecycle design (`keepur/hive-docs/internal/specs/2026-03-21-memory-lifecycle-design.md`), reshaped by the KPR-328 verdict._

_Note: KPR-326 is pre-register — the epic carries no `## Decision Register — Canon` section yet. Decisions below cite the KPR-328 verdict directly._

## TL;DR

Retire the hand-rolled FS-style `memory` MCP server (`memory_read/write/list/history/rollback`) and replace it with a Mongo-backed implementation of Anthropic's native memory-tool contract — the six commands `view/create/str_replace/insert/delete/rename` over a virtual `/memories` mount — served **as an in-process MCP server**, because the Claude Agent SDK's `query()` path (hive's only execution path post-KPR-220) has **no surface for registering `memory_20250818` as a first-class API tool** (verified against the installed SDK, v0.2.104). The same Mongo collections (`memory`, `memory_versions`), traversal guard, per-agent/`shared` scoping, history/rollback, and KPR-213 prefix-cache invalidation are all preserved; the API's free "view memory first" system instruction is replicated manually in the prefix builder.

## Key Points

- **SDK finding (gating unknown, now resolved):** `query()` options accept only `mcpServers`, `agents`, `plugins`, `hooks`, and `betas` (where `SdkBeta = 'context-1m-2025-08-07'` only — no memory beta). `sdk-tools.d.ts` enumerates a closed built-in tool set with no memory tool; the only `memory_20250818` strings in the bundled CLI are embedded documentation text. There is **no client-tool-handler registration path**. The cutover therefore takes the verdict's pre-authorized fallback (a): reimplement the six-command contract as a normal in-process MCP server and manually re-inject the "check memory first" guidance.
- **In scope:** replace `src/memory/memory-mcp-server.ts`'s five tools with the six native commands + two hive-extension tools (`memory_history`, `memory_rollback`); reuse `isAllowed`, `ALLOWED_PREFIXES`, `memory_versions` snapshots, and the KPR-213 `onWrite` hook verbatim; keep the server key `"memory"` so **no agent-definition migration is needed**.
- **No data migration.** Same collections, same `agents/<id>/…` / `shared/…` path space under a stripped `/memories` prefix. Old Phase 3's "archive `memory`/`memory_versions`" step is **superseded** by the verdict — those collections are now the permanent file-tier backing store.
- **Out of scope (verdict-mandated, do not touch):** `structured-memory-mcp-server.ts`, `memory-store.ts`, `memory-lifecycle.ts`, `memory-lifecycle-heartbeat.ts`, hot-tier prefix injection (`prefix-builder.ts:127`), `memory-manager.ts` read/list paths used by the prefix builder, and the memory↔structured-memory auto-pairing in `agent-runner.ts`.
- **Prompt collision resolved by construction:** since the tool is MCP-shaped, the API injects nothing — hive authors one short "memory-first" block in the prefix builder that explicitly defers to the already-injected hot tier ("your hot-tier memory is above; `view` file-tier paths only when the task needs deeper detail"), avoiding double-prompting and redundant `view` round-trips. KPR-213 invalidation keeps firing because writes still route through the same `onWrite` hook.
- **Non-Claude pilot adapters (Codex/OpenAI/Gemini):** unchanged — they run with an **empty tool inventory today** and never had file-tier memory, so the cutover regresses nothing. The MCP form is the *bridgeable* surface (`tool-transport.ts` class `mcp-bridge-candidate`); the native tool type would have been `claude-only`. Fallback plan: when pilot tool-bridging lands, they receive the same six-command MCP server.
- ⚠ **Deviation from the native contract, deliberate:** `str_replace`/`insert` operate via Mongo read-modify-write (no file locks needed — per-thread lock already serializes same-thread turns; cross-thread same-file writes are last-write-wins today and remain so).
- ⚠ **ScopeRouter filesystem scopes** (archetype layer) are carried over as `/memories/scopes/<id>/…` mounts restricted to the **parity subset** of commands the current server actually supports on fs scopes (`FsMemoryStore` has only read/list/write): `view`, `create`, `str_replace`, `insert`. `delete` and `rename` on a scope path return the same "not supported on this scope" error pattern used for history/rollback on fs scopes — extending `FsMemoryStore` with delete/rename (recursive FS delete on archetype dirs) is a genuine capability expansion needing its own guard design, and is explicitly out of scope here. New addressing, same capability as today. If any archetype depends on the old `scope:` parameter shape, its prompt text needs a sweep (only Jasper-class archetypes use fs scopes).
- **Risk:** losing the API-trained "always view memory first" behavior quality — the model was RL-trained against the native *tool type*, and an MCP tool named `view` may not trigger identical behavior. Mitigated by naming/description fidelity to the native contract and the explicit prefix instruction; accepted as the cost of the SDK constraint.

---

## 1. Problem

Two memory servers are still wired per agent: the FS-style `memory` server (KPR-122 in-process; `memory_read/write/list/history/rollback` over Mongo `memory`/`memory_versions`) and `structured-memory` (typed records, semantic recall, tiering). The 2026-03-21 memory-lifecycle design shipped its Phases 1–2 (structured system deployed alongside legacy; hot-tier injection cut over in `buildSystemPrompt`) but never finished Phase 3 — legacy file tools were never removed. The KPR-328 spike (resolving KPR-209 open question #1) ruled the file tier should not be *removed* but *reshaped*: adopt the native `memory_20250818` six-command contract as a Mongo-backed handler replacing the bespoke server, keeping everything structured/tiered as-is.

The one gating unknown the verdict flagged — whether the Agent SDK `query()` path can register the native tool — is resolved by this spec: **it cannot** (see Key Points). The cutover proceeds via the verdict's fallback (a).

## 2. Goals

1. Replace `memory_read/write/list/history/rollback` with the native contract's `view/create/str_replace/insert/delete/rename` (exact command semantics, error strings, and line-numbered `view` rendering per the verdict §1), served in-process under the existing `"memory"` server key.
2. Preserve, bit-for-bit in behavior: traversal guard, per-agent + `shared/` scoping, `memory_versions` snapshot-on-write, history/rollback (as extension tools), KPR-213 `onWrite` prefix-cache invalidation on every mutating command.
3. Zero data migration; zero agent-definition changes; `structured-memory` pairing untouched.
4. Manual re-injection of memory-first guidance that coexists with (not duplicates) hot-tier injection.

## 3. Non-goals (loud)

Per the KPR-328 verdict, the following are **explicitly out of scope and must not be modified**:

- `src/memory/structured-memory-mcp-server.ts` (semantic recall, pin/purge/review, write-guards)
- `src/memory/memory-store.ts`, `memory-lifecycle.ts`, `memory-lifecycle-heartbeat.ts` (tiering, autoDream, telemetry)
- Hot-tier prefix injection (`src/agents/prefix-builder.ts:127` → `getHotTierPrompt`) and its legacy `memory.md` fallback
- Any change to `agent_memory` / `agent_memory_autodream_state` collections
- Registering `memory_20250818` as a literal API tool (impossible via `query()`; revisit only if the Agent SDK grows the surface)
- Pilot-adapter tool bridging itself (KPR-231–234 lineage) — this spec only defines what memory surface they get *when* bridging lands

## 4. Design

### 4.1 Server shape

Rewrite `buildMemoryTools()` in `src/memory/memory-mcp-server.ts` (same file, same `createMemoryMcpServer` export, same `MemoryToolDeps` — `db`, `agentId`, `memoryScopes`, `onWrite`). Eight tools:

| Tool | Native? | Semantics |
|---|---|---|
| `view` | yes | `{path, view_range?}`. Directory → listing with sizes (2 levels, tab-separated); file → content with 6-wide right-aligned 1-indexed line numbers; `view_range: [start, end]` / `[start, -1]`; empty root is not an error; truncate >16,000 chars. |
| `create` | yes | `{path, file_text}` — create **or overwrite** (verdict §1 notes overwrite is a valid choice; matches today's `memory_write` upsert). Snapshot prior content to `memory_versions` first. |
| `str_replace` | yes | `{path, old_str, new_str?}` — omitted `new_str` deletes `old_str`; error on zero or multiple matches. Snapshot prior. |
| `insert` | yes | `{path, insert_line, insert_text}` — insert after line N, 0 = beginning. Snapshot prior. |
| `delete` | yes | `{path}` — file or recursive directory (prefix delete); **reject deleting the `/memories` root** and the `agents/<id>` / `shared` mount roots. Snapshot each deleted file. Mongo mounts only — errors on fs-scope paths (§4.2). |
| `rename` | yes | `{old_path, new_path}` — re-key doc(s); reject root ops; reject overwrite of existing destination; both paths guard-checked. Mongo mounts only — errors on fs-scope paths (§4.2). |
| `memory_history` | hive ext | Unchanged from today (list `memory_versions` for a path). |
| `memory_rollback` | hive ext | Unchanged (restore by version index; snapshots current first; fires `onWrite`). |

Tool descriptions mirror the native tool's published descriptions as closely as possible (see Risk in Key Points).

### 4.2 Path mapping and guard

All tool paths are `/memories/…`. The handler strips the `/memories` prefix and maps into the existing Mongo path space **unchanged**:

- `/memories/agents/<agentId>/…` → Mongo `path = agents/<agentId>/…`
- `/memories/shared/…` → `shared/…`
- `/memories/scopes/<scopeId>/…` → ScopeRouter filesystem scope `<scopeId>` (**parity subset only**: `view`/`create`/`str_replace`/`insert` via `FsMemoryStore`'s existing `read`/`list`/`write`; `delete`/`rename` — like `memory_history`/`memory_rollback` — return a "not supported on this scope" error; no new `FsMemoryStore` methods)
- `view /memories` (root) → synthesized listing of the mounts the agent can see: `agents/<agentId>/`, `shared/`, plus any fs scopes.

Guard: canonicalize, then the existing `isAllowed` logic — reject any path not starting `/memories`, reject `..`, `..\`, and URL-encoded traversal (`%2e%2e`), then require the stripped path to start with an `ALLOWED_PREFIXES` entry. Multi-tenancy is enforced in the handler (agentId is constructor-bound), never trusted to the model — same as today.

Existing docs stay addressable at their current identities: an agent that previously wrote `agents/milo/notes.md` sees it at `/memories/agents/milo/notes.md`. No rewrite of stored paths.

### 4.3 Versioning and invalidation

Every mutating command (`create`, `str_replace`, `insert`, `delete`, `rename`, `memory_rollback`) snapshots prior content into `memory_versions` (same doc shape: `{path, content, savedAt, savedBy}`) and fires `deps.onWrite(path, reason)` with a per-command reason string (`memory-mcp-create`, `memory-mcp-str_replace`, …). `invalidatePrefixCacheByMemoryPath` in `agent-runner.ts` is untouched — it already routes `agents/<id>/…` → single-agent invalidation, `shared/*` → all-agents. `rename` fires for both old and new paths.

### 4.4 Wiring

Unchanged by design: `agent-runner.ts` continues to build the server via `createMemoryMcpServer({db, agentId, memoryScopes, onWrite})` under `mcpServers["memory"]`; `IN_PROCESS_PORTED_SERVERS` keeps `"memory"`; the structured-memory auto-pairing (`if memory then structured-memory`) is untouched; agent definitions keep `"memory"` in `coreServers`. Cleanup: drop the vestigial stdio placeholder for `memory` in `buildAllServerConfigs` (agent-runner.ts ~line 470, KPR-183 leftover). The toolkit section (KPR-87) lists tools from the runtime inventory, so the new names surface automatically.

### 4.5 Prompt: manual "memory-first" injection + collision resolution

Because the MCP form gets no API-injected instruction, add one short block in `prefix-builder.ts`, adjacent to the existing memory injection point (after toolkit, with the memory section — same cache-invalidation domain), roughly:

> You have a file-tier memory at `/memories` (tools: view, create, str_replace, insert, delete, rename). Your hot-tier memory is already injected above — do **not** re-`view` files to rediscover what's already in this prompt. `view` file-tier paths when a task needs detail beyond the hot tier, and record durable file-worthy material there.

This is the collision resolution: hive keeps push (hot tier in prefix) as primary, positions file-tier `view` as pull-on-demand secondary, and the instruction explicitly suppresses the redundant view-everything-first pattern the native prompt would have encouraged. The block lives in the cached prefix; KPR-213 invalidation semantics are unchanged (the block itself is static text — only the neighboring memory content varies).

The legacy fallback branch in `prefix-builder.ts` ("Read relevant files via `memory_read`") updates its tool reference to `view`.

### 4.6 Non-Claude pilot adapters

Codex/OpenAI/Gemini pilot adapters (`src/agents/provider-adapters/`) run `buildPilotInstructions` with an empty tool inventory — they have never had file-tier (or any) memory tools, so this cutover changes nothing for them. Stated fallback for when bridging ships: the six-command in-process MCP server **is** the pilot-facing surface — `tool-transport.ts` should classify it `mcp-bridge-candidate` (a literal `memory_20250818` registration would have been `claude-only`, making the SDK constraint a silver lining for provider portability). No work in this ticket beyond that classification note.

### 4.7 Retirement of the old surface

- Delete the five legacy tool builders; rewrite `memory-mcp-server.test.ts` for the new contract (guard cases: traversal, cross-agent, root delete/rename, str_replace uniqueness, view_range, snapshot-on-write, onWrite firing, fs-scope mounts, delete/rename-on-fs-scope error).
- Repo sweep for `memory_read|memory_write|memory_list|memory_rollback` found only `memory-mcp-server.{ts,test.ts}` and `prefix-builder.ts` — no seed prompts, constitution templates, or scripts reference the legacy names in-repo. ⚠ Live instances (dodi/keepur) may reference `memory_read` in DB-stored agent systemPrompts or constitution Section 2 — an operator sweep at rollout (tune-instance pass) is the remediation, not engine code. Concrete check: grep for `memory_read` (and the other legacy tool names) across `agent_definitions.systemPrompt` and the constitution document, updating any hits to the new command names.
- `memory-manager.ts` `read/list/write` stay (prefix builder and engine internals use them).

## 5. Edge cases

- **Empty `/memories` root on first `view`** — return the mount listing, never an error (native contract).
- **`view` of a directory with >2 levels** — list 2 levels deep, per contract; sizes from `content.length`.
- **`str_replace` on multi-occurrence** — error with the contract's "must be unique" phrasing; no partial write, no snapshot.
- **`delete` on `agents/<id>` or `shared` mount root** — reject (protects against wipe-by-tool-call; consistent with the KPR-295 anti-wipe posture).
- **`rename` across mounts** (e.g. `agents/<id>/x` → `shared/x`) — allowed if both sides pass the guard (matches today's write rights); rename into `scopes/` or across mongo↔fs boundaries — reject.
- **Oversize `view`** — truncate at 16,000 chars with the contract's truncation notice, using the exact wording from Anthropic's memory-tool documentation as captured in the KPR-328 verdict §1.
- **Concurrent same-file str_replace from two threads** — last-write-wins, as today; `memory_versions` preserves both prior states for rollback.
- **fs-scope commands** — `str_replace`/`insert` implemented as read-modify-write through `FsMemoryStore`'s existing `read`/`write`; `delete`/`rename` and `memory_history`/`memory_rollback` on a scope path all return the same "not supported on this scope" error pattern (today's "use git or equivalent" wording for history/rollback; delete/rename get an analogous "not supported on filesystem scopes" message). No `FsMemoryStore` API additions.

## 6. Migration / rollout

None of substance: same collections, same path identities, same server key, same agent definitions. Rollout = normal engine upgrade (`hive update`) + the operator prompt-sweep noted in §4.7. Rollback = redeploy prior engine version (old tools return; data untouched throughout).

## 7. Open assumptions

- ⚠ **Fallback (a) chosen without a human gate.** The KPR-328 verdict pre-authorized exactly this fork: "if `query()` does not natively support it, (a) wrap it as a normal in-process MCP server mimicking the six commands (losing the API-injected system prompt, which would then be added manually) or (b) wait on SDK support." (b) parks the epic's memory slice indefinitely on an unannounced SDK feature; (a) preserves all current capability, improves provider portability, and loses only the trained-behavior bonus — clearly correct, flagged here rather than escalated.
- ⚠ Behavior fidelity of native-shaped MCP tools vs. the true native tool type is unverified (no way to A/B without the API surface). Acceptance should include a qualitative check that agents actually use `view`/`str_replace` sensibly on a live instance.
- ⚠ Installed SDK verified at v0.2.104 (dev machine); `package.json` pins `^0.2.63`. If a future SDK release adds native-tool registration to `query()`, a follow-up ticket can swap the MCP form for the real tool type with no data changes.
- Old Phase 3's "archive `memory`/`memory_versions` collections" and Phase 4 "drop after bake" are declared **superseded** by the KPR-328 hybrid verdict; this spec is the new terminal state for the file tier.
