# KPR-328 — Spike: Mongo-backed native memory tool — Verdict

_Epic: KPR-326 (W6 — Memory & harness modernization). Resolves KPR-209 open question #1. Throwaway spike; no production code modified._

## TL;DR

Adopt Anthropic's native memory tool (`memory_20250818`) shape as a thin, Mongo-backed handler that **replaces the hand-rolled FS-style `memory` MCP server** — which is already file-shaped and now redundant with the native contract — while **keeping** the `structured-memory` MCP server plus the lifecycle/autoDream/hot-tier-injection machinery, none of which the flat-file native tool can express. Verdict is **(c) hybrid**: native shape for the file-tier (buys trained "check memory first" behavior, SDK-standard tool, and context-editing/compaction pairing, memories stay in Mongo), custom store for semantic recall + tiering + consolidation.

## Key Points

- **Decision: (c) hybrid.** Native `memory_20250818` handler over the existing Mongo `memory`/`memory_versions` collections supersedes `src/memory/memory-mcp-server.ts`; `structured-memory` + `memory-lifecycle` + hot-tier prefix injection stay as-is.
- **Why not (a) adopt-native-wholesale:** the native tool has no query/search command (only `view` a known path), no tiering, and nothing auto-injects into context. Going all-native regresses two load-bearing hive capabilities: semantic recall (`memory_recall`) and the always-present hot-tier baked into the cached system-prompt prefix (`prefix-builder.ts:127` → `memoryManager.getHotTierPrompt`).
- **Why not (b) keep-custom-as-is:** leaves the bespoke FS-style server hand-maintained and forgoes three real wins — the API-injected "ALWAYS VIEW YOUR MEMORY DIRECTORY FIRST" trained behavior, the SDK-standard tool surface, and first-class pairing with server-side compaction / context editing.
- **The FS-style `memory` server is already ~90% the native shape.** It exposes read/write/list/history/rollback over Mongo with an `agents/<id>/` + `shared/` path prefix and a traversal guard (`isAllowed`). Mapping it onto `view/create/str_replace/insert/delete/rename` over a `/memories` namespace is a mechanical adapter, not a redesign — the low-risk, high-value slice.
- **Hard mismatches that force the hybrid:** semantic vector recall, hot/warm/cold tiering, autoDream consolidation (summarize/merge/contradiction/promotion), write-guards (oversize/raw-dump/burst-dedup), and importance/pin/purge lifecycle have **no representation** in a flat file-view model. These are hive's differentiated value and must not be folded into the native tool.
- **In scope for the resulting cutover:** retire `memory-mcp-server.ts`; stand up a native-tool handler over the same collections preserving the prefix guard + `memory_versions` history/rollback semantics.
- **Out of scope:** `structured-memory-mcp-server.ts`, `memory-store.ts`, `memory-lifecycle.ts`, `memory-lifecycle-heartbeat.ts`, and hot-tier prefix injection — all retained.
- **Risks:** (1) prompt collision — the API auto-injects a "view memory first" system instruction while hive already auto-injects the hot tier; naive adoption double-prompts and invites redundant `view` calls. (2) Multi-tenancy is fine (handler maps `agentId`→namespace) but must be enforced in the adapter, not trusted to the model.
- ⚠ **Assumption to verify in KPR-327:** hive runs on the **Claude Agent SDK `query()`** path, not the raw Messages API / `tool_runner` helper the docs demonstrate. Whether `memory_20250818` is selectable as a first-class tool through `query()` (and whether the SDK runs the client-side handler loop for it) is unconfirmed here and gates the cutover. Non-Claude pilot provider adapters would not receive it at all.

---

## 1. Native memory tool contract (`memory_20250818`)

Source: Anthropic docs, "Memory tool" — https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/memory-tool (301 from docs.anthropic.com/en/docs/agents-and-tools/tool-use/memory-tool). Related: Context editing — https://platform.claude.com/docs/en/build-with-claude/context-editing ; Compaction — https://platform.claude.com/docs/en/build-with-claude/compaction ; long-agent pattern — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents .

- **Type string / config:** `{"type": "memory_20250818", "name": "memory"}` is the entire tool entry — no input schema (Anthropic-provided tool). **Generally available on the Messages API; no beta header.** Available on all Claude 4+ models (docs example uses `claude-opus-4-8`).
- **Client-side:** the model only *requests* file operations; the application executes each against storage it controls and returns a `tool_result`. "Memory lives entirely in your application." A later conversation continues from the same memory by sending the same `tools` entry and serving the same store. Eligible for Zero Data Retention.
- **Six commands** (dispatch on `input.command`):
  - `view` — `{command, path, view_range?}`. Directory listing (sizes, 2 levels deep, excludes hidden/`node_modules`, tab-separated) or file contents with 6-wide right-aligned 1-indexed line numbers. `view_range: [start, end]` or `[start, -1]`. First `view` of empty `/memories` is not an error. Displays image files; truncates text views >16,000 chars.
  - `create` — `{command, path, file_text}`. "creates or overwrites" per the tool description; reference impl errors on existing but overwriting is a valid choice.
  - `str_replace` — `{command, path, old_str, new_str?}`. `new_str` omitted ⇒ delete `old_str`. Errors on no-match and on multiple occurrences (must be unique).
  - `insert` — `{command, path, insert_line, insert_text}`. Inserts *after* `insert_line`; `0` = beginning.
  - `delete` — `{command, path}`. Recursive for directories. Must reject deleting the `/memories` root.
  - `rename` — `{command, old_path, new_path}`. Must reject renaming the root; must not overwrite an existing destination.
- **Path semantics / sandboxing:** all paths are prefixed `/memories`; the prefix is a virtual mount your handler maps onto real storage ("a per-user directory or keys in a database"). **Path-traversal protection is the developer's responsibility** — validate every path starts with `/memories`, canonicalize and re-check containment, reject `../`, `..\`, and URL-encoded (`%2e%2e%2f`) traversal.
- **Trained "check memory first" behavior:** when the tool is present, the API automatically prepends a system instruction — `"IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE ..."` plus an "assume interruption" protocol. This is exactly the model-side behavior the ticket wants and is **free** with the tool (you don't send it yourself).
- **Retrieval model:** just-in-time / pull. The model `view`s files on demand into context; **nothing is auto-injected**. Keeps active context focused on the current task.
- **Compaction / context-editing pairing:** context editing clears specific tool results client-side; compaction summarizes the whole conversation server-side near the window limit. Memory preserves what must survive summarization. Docs recommend combining both for long agents.
- **Namespace scope:** whatever the handler maps — there is no built-in global-vs-per-conversation notion; you own per-user/per-agent isolation. A conversation resumes the "same memory" purely by handler mapping + identical `tools` entry.
- **Stated limitations:** file/text-oriented only (no semantic search primitive); no versioning/rollback, tiering, importance, or consolidation in the contract — those are backend concerns invisible to the model, which only ever sees files + line numbers. Size/expiration management is the developer's job (cap file growth, cap `view` output, expire stale files).
- **SDK helpers:** Python/TS/C#/Java ship memory helpers (`BetaAbstractMemoryTool`, `betaMemoryTool`, etc.) and a ready-made `BetaLocalFilesystemMemoryTool`; the helper surfaces live in each SDK's **beta** namespace even though the tool is GA. Go/Ruby/PHP run the loop manually. These are **Anthropic SDK** helpers on the Messages API tool-runner — not shown for the Claude *Agent* SDK `query()` path hive uses (see risk ⚠ above).

## 2. Current hive implementation — capability inventory

Two distinct MCP servers, both in-process (KPR-122), both Mongo-backed:

**A. `memory` (FS-style) — `src/memory/memory-mcp-server.ts`**
- Tools: `memory_read`, `memory_write`, `memory_list`, `memory_history`, `memory_rollback`.
- Store: Mongo `memory` collection (path → content), version snapshots in `memory_versions`.
- Path model: `agents/<agentId>/…` and `shared/…`, traversal-guarded by `isAllowed` (rejects `..`, enforces prefix). Optional filesystem-backed scopes via `ScopeRouter` (archetype layer).
- Versioning + rollback are first-class (`memory_history`, `memory_rollback`).
- Prefix-cache invalidation hook (`onWrite`) on every write/rollback (KPR-213).
- **This server is essentially a file-tree-over-Mongo already** — its command set is a near-superset-minus-search of the native tool.

**B. `structured-memory` — `src/memory/structured-memory-mcp-server.ts`**
- Tools: `memory_save`, `memory_recall`, `memory_update`, `memory_pin`, `memory_unpin`, `memory_forget`, `memory_purge`, `memory_review`.
- Store: Mongo `agent_memory` (typed `MemoryRecord`) + Qdrant/Ollama embeddings (`MemoryEmbedder`).
- Semantic recall over hot/warm/cold tiers; typed records (fact/task/interaction/preference/decision/summary), importance (critical/high/medium/low), freeform `topic`, `sourceRef` pointers.
- Write-guards (KPR-241): oversize (>6000 chars), raw-dump heuristic (JSON/table/monolith without `sourceRef`), burst dedup (cosine ≥0.92 within window).
- Pin (force hot), unpin, forget (hard delete), purge (filtered soft-delete with retention), review (hot-tier audit with staleness flags).

**C. Store + lifecycle — `memory-store.ts`, `memory-lifecycle.ts`, `memory-lifecycle-heartbeat.ts`**
- Tiered promotion/demotion, autoDream consolidation phases (`summarizeCold`, `mergeDuplicates`, `detectContradictions`, `promotePatterns`), spend budgets + `spendHistory`, `agent_memory_autodream_state`.
- Per-agent telemetry heartbeat to `db.telemetry` (`memory_lifecycle_stats`, 30s) for `hive doctor`.

**D. Hot-tier auto-injection (the decisive differentiator)**
- `src/agents/prefix-builder.ts:127` calls `memoryManager.getHotTierPrompt(agentId, hotBudgetTokens)` and bakes the hot-tier into the **cached system-prompt prefix** (assembly order: … toolkit → hot-tier memory → date/time). Legacy fallback injects a `memory.md` blob + lists available files.
- Cross-agent isolation is enforced by `agentId` scoping throughout (`agent_memory.agentId`, `ALLOWED_PREFIXES`).

**Overlap vs. native tool:** server A (read/write/list ≈ view/create+str_replace/insert/list; history/rollback are hive extras) overlaps heavily and is the redundant piece. Servers B/C/D provide semantic recall, tiering, consolidation, guards, and always-on context injection — **none** of which the native flat-file tool offers.

## 3. Feasibility — native handler over Mongo

**Easy, low-risk (the file tier):** a `memory_20250818` handler maps `/memories/<rel>` → Mongo `memory` doc `path = agents/<agentId>/<rel>` (and a `shared/` mount if desired). Command mapping:
- `view` (dir) → `memory` regex prefix scan + synthesized size/listing header; `view` (file) → doc content rendered with line numbers + `view_range` slice.
- `create` → upsert (snapshot prior into `memory_versions`).
- `str_replace` / `insert` → read-modify-write with the docs' uniqueness/line-range error strings; snapshot prior version.
- `delete` / `rename` → delete / re-key doc(s); reject root ops.
- Traversal guard + per-agent scoping already exist (`isAllowed`, `ALLOWED_PREFIXES`) — reuse verbatim. `memory_versions` gives history/rollback "for free" beyond the native contract.

**Hard mismatches (do NOT force onto the file model):**
- **Semantic recall** — the native contract has no search command; `memory_recall`'s vector query does not map to `view path`. Emulating it as pseudo-files is awkward and loses ranking/relevance. Keep `structured-memory`.
- **Hot-tier auto-injection** — native is pull-only; retiring `structured-memory`/lifecycle would drop the always-present hot tier from the prefix. Keep `getHotTierPrompt` injection.
- **Consolidation / tiering / guards / importance / pin lifecycle** — invisible to a file model. Keep lifecycle + store.
- **Multi-tenancy** — not a blocker: handler maps `agentId`→namespace, same as today's `ALLOWED_PREFIXES`. Must be enforced in the adapter.

## 4. Verdict + rationale

**(c) Hybrid.** Implement the native `memory_20250818` shape as a Mongo-backed compatibility handler that **replaces the bespoke FS-style `memory` MCP server**, and **retain** `structured-memory` + lifecycle + hot-tier injection for the capabilities the native tool cannot express.

Rationale: the file tier is already file-shaped and redundant with a GA, SDK-standard contract that ships trained "check memory first" behavior and first-class compaction/context-editing pairing — adopting it there is pure upside with memories staying in Mongo (in-house, ZDR-eligible). But the native tool is a flat file store with no search, no tiering, and no auto-injection; hive's differentiated value (semantic recall, always-on hot tier, autoDream consolidation, write-guards) lives precisely in the parts the native contract omits. Collapsing those into files would be a capability regression, so they stay. This is the decisive, evidence-backed split: adopt-native where hive is redundant, keep-custom where hive is differentiated.

## 5. Implications for KPR-327 (memory legacy cutover)

- **Target of the cutover:** retire `src/memory/memory-mcp-server.ts` and stand up a native-tool handler (`memory_20250818`) over the existing `memory` + `memory_versions` collections — preserving the traversal guard, per-agent/`shared` scoping, and history/rollback (as a hive extension beyond the native contract). Keep the KPR-213 prefix-cache `onWrite` invalidation on the write commands.
- **Explicitly out of cutover scope:** `structured-memory-mcp-server.ts`, `memory-store.ts`, `memory-lifecycle.ts`, `memory-lifecycle-heartbeat.ts`, and `prefix-builder` hot-tier injection all remain. The cutover spec should state this non-goal loudly so no one over-reaches into semantic/tiered memory.
- **Prompt-collision decision the spec must make:** reconcile the API-injected "view memory first" instruction with hive's existing hot-tier auto-injection — decide whether the file tier's `view`-first prompting and the structured hot-tier co-exist, and how to avoid redundant `view` round-trips / double guidance.
- ⚠ **Gating spike before implementation:** confirm the **Claude Agent SDK `query()`** path can register `memory_20250818` as a first-class tool and will run the client-side handler loop (docs demonstrate the Messages API + `tool_runner`, not `query()`). If `query()` does not natively support it, the cutover must either (a) wrap it as a normal in-process MCP server mimicking the six commands (losing the API-injected system prompt, which would then be added manually) or (b) wait on SDK support. Also note non-Claude pilot provider adapters get no native memory tool — the file tier there must fall back to the MCP form.
