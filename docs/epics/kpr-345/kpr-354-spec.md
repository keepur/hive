# KPR-354 — Subagent parity: nested adapter turns for delegate subagents on Lane B

**Child 9 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D4 (`claude-subagent` class — "a delegate turn = nested adapter turn against the same agent definition's delegate config, budget-accounted through the spawn coordinator"), §D8 (spawn coordinator provider-generic).
**Shape:** late child, bounded — binds the merged KPR-348 bridge and KPR-347 assembly seam; one net-new manager surface (the nested-turn runner), zero bridge-core or dispatch-loop redesign.
**Depends on:** KPR-348 (merged — `ToolBridge`/`BridgedTool[]`, guardrail gate, builtin executor), KPR-347 (merged — `ProviderTurnAssembly` seam), KPR-353 (merged — codex executes tools; its optional `historyStore` wiring is what lets nested codex turns stay stateless). All present at this baseline (@ 918889f).
**Informs:** KPR-352 (gemini inherits the Task synthesis for free when it binds `BridgedTool[]`), KPR-355 (matrix subagents row facts collected here), KPR-351 (live validation may exercise a delegate turn on the codex surface).
**Decision-register canon honored:** bridge bound, not redesigned — the Task tool is one more `BridgedTool` through the existing `wrap()` (gate → execute → contain → meter; execute never throws); Claude-lane tool names preserved (`Task`, Claude-identical input schema) so archetype rules transfer unmodified; codex ≡ openai at the classify site — one code path flips all three Lane B columns (gemini classification-honesty precedent, KPR-348); `TOOL_EXECUTING_PROVIDERS` untouched (already `{openai, codex}`); `SESSION_SEMANTICS` values and `LaneBProviderId` untouched; assembly stays provider-blind (the nested-turn callback is manager-built and provider-resolved at the manager seam); tool faults breaker-invisible; early-abort closure stays manager-owned.

## TL;DR

Give reassigned `openai/…` and `codex/…` agents their delegate subagents: the bridge synthesizes one Claude-lane-identical `Task` function tool from the agent's `claude-subagent` inventory entries, and executing it runs a **nested adapter turn** — a fresh same-provider adapter instance built against the same agent definition's delegate config (delegate prompt as instructions, that one MCP server + the six executor builtins as the tool surface, maxTurns 7/10 parity) — through a manager-owned runner that consumes a real spawn-coordinator budget slot and chains abort from the parent turn. Delegate entries flip from `claude-only` to `requires-hive-bridge` on all three Lane B columns, removing the per-delegate matrix delta; general-purpose Task subagents (arbitrary `subagent_type`) remain claude-only and stay a documented delta.

## Key Points

- **The parity target is delegate subagents, not the SDK's general Task surface.** On the Claude lane, `delegateServers` entries become per-MCP tool-specialist sub-agents (`buildServerSubAgents`, `agent-runner.ts:1574` — delegate prompt, one MCP server, `model: "inherit"`, `maxTurns` 7/10, `disallowedTools: ["Agent"]`) invoked via the SDK's `Task` tool. This child reproduces exactly that surface on Lane B; general-purpose subagents (`subagent_type` outside the delegate set) are out of scope and stay a matrix delta.
- **One synthesized `Task` tool, not per-delegate tools.** Claude-identical name + input schema (`description`, `prompt`, `subagent_type` — enum-restricted to active delegates), routed through the bridge's existing `wrap()` so the archetype gate, containment, and metering apply unchanged; archetype rules written against `Task` transfer verbatim (KPR-348 name-preservation canon).
- **Nested turn = fresh adapter of the same class, session-less by construction.** Manager-built callback (`DelegateTurnRunner`, carried on the assembly) constructs a nested `ProviderTurnAssembly` (delegate prompt as instructions; inventory = the delegate's external MCP entry + the six builtin static entries; same guardrail gate; empty memory/skills/in-process) and a nested adapter on the parent's route (provider, model, effort). No sessionId in, nested sessionId discarded, codex nested adapter gets **no historyStore** — `provider_turn_history` untouched by nested turns.
- **Budget-accounted, lock-exempt.** The nested runner takes a real slot on the agent's `activeSpawnCount` against `spawnBudgetFor` (saturation → structured model-visible denial + `recordSaturation`, released in `finally`) but deliberately does NOT acquire the per-thread lock — the parent holds `agentId:threadId` for the whole outer turn and a nested wait would deadlock permanently. Consequence: delegates on Lane B need `spawnBudget ≥ 2` (default 5 is fine).
- **Depth-1 recursion is structural, not counted:** the nested assembly contains no `claude-subagent` entries and no `delegateTurnRunner`, so the nested bridge never synthesizes Task — the parity twin of `disallowedTools: ["Agent"]`.
- **Abort chains through the existing signal path:** parent `ticket.abort()` → adapter abort → bridge signal → listener aborts the nested adapter; stopAgent and manager-owned early-abort need no new plumbing.
- **Providers now vs later:** live on openai + codex (the `TOOL_EXECUTING_PROVIDERS` set — untouched). The classify-site flip covers gemini too (one code path, classification honesty), but gemini stays dark until KPR-352 binds `BridgedTool[]`; the runner callback passes uniformly and is inert there.
- ⚠ **Nested turns are breaker-invisible** (no acquire/record — provider faults inside a nested turn surface as `Task` tool-result text, classifying non-provider at the parent). Accepted: parent turns hit the same endpoint every round, so a real outage still trips the breaker via parents; a nested-only signal cannot exist. Documented residual, not a gap to engineer around.
- ⚠ Delegated choices (§Open assumptions): six executor builtins included in the nested surface (Claude subagents inherit builtins); nested output not streamed; nested token usage logged, not folded into the parent `RunResult`; `Task` joins the never-cap-dropped pinned set (toolkit claims it — same structural-load-bearing rationale as KPR-349 §D7).

## Problem

Post-346–353, a reassigned `openai/…` or `codex/…` agent executes every bridgeable tool class — except delegation. Its `delegateServers` produce inventory entries classified `claude-only` (`tool-transport.ts:100` — `claude-subagent` branch), so the partition omits them; the epic's §D4 interim ruling ("Task-shaped tools are omitted from non-Claude inventories, matrix delta") is still the live state. An agent whose working pattern routes external-comms or code work through delegates (the fleet's common shape: `resend`, `quo`, `code-task`, `linear` as delegates) silently loses that whole modality on Lane B — R3 ("nothing silently dropped") is only satisfied by the omission log. The bridge, gate, builtin executor, and both tool-executing adapters are merged and stable; delegation is the last non-Claude inventory hole with a designed closing (epic §D4: nested adapter turn, spawn-coordinator budget accounting).

## Goals

- G1: On openai and codex, an agent with active delegates gets a `Task` tool (Claude-identical name/schema, enum-restricted `subagent_type`) whose execution runs a nested adapter turn against the delegate's config: delegate prompt (custom `delegatePrompts[server]` or the generic specialist prompt, verbatim from `buildServerSubAgents`), that server's tools + the six executor builtins, maxTurns 7 (custom) / 10 (generic).
- G2: Nested turns consume and release a spawn-coordinator budget slot (`activeSpawnCount`/`spawnBudgetFor`); saturation and stopped-agent states yield structured model-visible denials and record saturation; slots can never leak (release in `finally`).
- G3: Abort propagation: aborting the parent turn (ticket abort, stopAgent, manager early-abort) aborts an in-flight nested turn; nested aborts produce contained tool-result text, never throws.
- G4: Nested turns are session-less and history-less: no session persistence, no `provider_turn_history` reads or writes, nested sessionId discarded.
- G5: Classification honesty: `claude-subagent` entries classify `requires-hive-bridge` on all three Lane B columns (one code path); the per-delegate omission records disappear; the `Task` claude-builtin entry stays `claude-only` (general-purpose subagents — honest remaining delta).
- G6: Prompt honesty: the Lane B toolkit renders a delegates section from the now-bridgeable `claude-subagent` entries (via-Task framing), Claude-lane toolkit byte-identical (golden gate).
- G7: Containment inherited end-to-end: unknown `subagent_type`, bad arguments, nested adapter error/throw, budget denial — all become model-visible text through the existing `wrap()`; nothing escapes `runTurn`; nothing gains breaker weight.

## Non-goals

- General-purpose Task subagents (arbitrary `subagent_type`, SDK-native agent types) — claude-only, matrix-listed.
- Nested-turn streaming to the user, nested session resume, nested reflection, delegate-turn history persistence.
- Gemini activation — KPR-352 (classification flips here per canon; its adapter still advertises zero tools).
- Lane A (kimi/deepseek) — subagents already run natively in the Claude runtime (KPR-346 pins `CLAUDE_CODE_SUBAGENT_MODEL`); untouched.
- Recursion depth > 1 (Claude parity is depth 1: `disallowedTools: ["Agent"]`); parallel-nested-turn tuning beyond the budget bound; per-agent delegate-budget knobs (the spawn budget is the knob — simplicity canon).
- Breaker acquire/record for nested turns (⚠ Key Points; "exactly one breaker record per spawnTurn" stays literally true).
- Bridge dispatch internals, adapter loops, `SESSION_SEMANTICS`, `TOOL_EXECUTING_PROVIDERS`, `LaneBProviderId`, voice pinning — all untouched.
- Parity matrix document — child 10 (§D8 lists this child's row facts).

## Design

### D1 — Classification flip (`tool-transport.ts`)

The `claude-subagent` arm of `classifyToolTransport` (`:92-114`) currently folds into the builtin branch where only executor-backed builtins escape `claude-only`. Split the ruling: `claude-subagent` → non-Claude compatibility `requires-hive-bridge`, emitted identically for openai/gemini/codex (one code path — codex ≡ openai canon; gemini upgraded for classification honesty exactly as KPR-348 did for builtins: only its omission record changes until KPR-352). `claude-builtin` behavior unchanged — `Task` (the builtin entry) remains non-executor-backed ⇒ `claude-only`, which is now the honest carrier for "general-purpose subagents are Claude-lane-only."

`ToolSchemaAvailability`'s `unavailable` doc comment (`:160-162`, "claude-subagent until child 9 … never reach a bridge") is corrected: post-354, `claude-subagent` entries reach the bridge as **Task-synthesis inputs**, not as schema-bearing tools — `unavailable` remains their truthful schema state (the Task schema is hive-authored, not discovered).

### D2 — Inventory carriage (`agent-runner.ts`)

`buildToolTransportInventory`'s delegate loop (`:1291-1300`) gains two carriage fields per entry, both already type-supported or additive:

- `serverConfig` — the delegate's underlying external MCP config from `allServerConfigs`. Safe by construction: KPR-184 bars the 10 in-process servers from `delegateServers` (registry-sanitized + admin-rejected), and `activeDelegateNames` already drops delegate-unsafe/context-dependent and config-less names — every surviving delegate is a real stdio/http/sse config. The field's secrecy rule (bridge-facing, never model-facing, never logged) applies unchanged; its doc comment extends to name the claude-subagent case.
- `description?: string` — new optional field on `HiveToolInventoryEntry` (additive), from `getServerCatalogEntry(name).description` — feeds the synthesized Task tool's delegate listing (the Claude lane feeds the same catalog text into `AgentDefinition.description`).

The underlying transport kind is NOT separately carried — it re-derives from `serverConfig.type` at nested-assembly time via the same rule the runner uses (`transportKindForServerConfig`).

### D3 — Task synthesis in the bridge (`tool-bridge.ts`)

`ToolBridgeOptions` gains `delegateRunner?: DelegateTurnRunner`. `connectInner()` gains a fourth partition: `claude-subagent` entries (currently silently ignored by the three transport filters). When that set is non-empty AND `delegateRunner` is present, synthesize exactly one tool through the existing `wrap()`:

- **Name:** `Task`. **Schema (Claude-lane-identical fields):** `{description: string (3-5 word task summary), prompt: string (the task for the delegate), subagent_type: string enum [active delegate names]}`, all required, `additionalProperties: false`.
- **Description:** short header + one line per delegate: `- <name> — <catalog description>` (from D2's carried descriptions) — the model-facing analog of the Claude Task tool's agent-type listing.
- **Underlying execute:** validate `subagent_type` against the entry map (miss → `Task failed: unknown subagent_type '<x>'. Valid: <names>`); validate `prompt` is a non-empty string; then `return await this.opts.delegateRunner({ delegate, prompt, entry, signal: this.opts.signal, workItemContext: this.opts.workItemContext })`. The runner never throws (D5 contract); `wrap()`'s catch is belt-and-suspenders. Gate-deny on `Task` (archetype matchers transfer by name) and the pre-execute abort check come free from `wrap()`.
- **Cap pinning:** `Task` joins the never-cap-dropped pinned set in `applyNameAndCapEdges` (`pinnedNames`) — the toolkit and Task description claim it, so cap-dropping it would make the prompt lie (identical rationale to the KPR-349 §D7 pin ruling; the pinned ceiling becomes ≤8 of 128).
- Delegate entries contribute NO other tools — they are consumed by synthesis only (no MCP connection is opened for them at the parent level).

Adapters change by one line each: openai (`openai-agents-adapter.ts:54-63`) and codex (`codex-subscription-adapter.ts` bridge construction) pass `delegateRunner: this.options.assembly.delegateTurnRunner` into the bridge options. Loops, binding, telemetry untouched — Task is just another `BridgedTool` (its wall time lands in `bridge.stats.toolMs`, so the parent's `llmMs = durationMs − toolMs` correctly excludes nested turn time from the breaker's p95 window with zero new code).

### D4 — Contract carriage (`types.ts`, `turn-assembly.ts`)

New type in `turn-assembly.ts` beside `ProviderSkillIndexEntry` (NOT `types.ts`: the call shape references `HiveToolInventoryEntry`, and `tool-transport.ts` already imports from `types.ts` — placing it in `turn-assembly.ts`, which the bridge already imports types from, avoids even a type-only cycle):

```ts
export interface DelegateTurnCall {
  delegate: string;                       // validated subagent_type
  prompt: string;                         // task prompt for the delegate
  entry: HiveToolInventoryEntry;          // the claude-subagent entry (carries serverConfig, description)
  signal: AbortSignal;                    // parent bridge signal — abort chain
  workItemContext?: WorkItemContext;
}
/** Manager-owned nested-turn executor. NEVER throws; resolves model-visible text. */
export type DelegateTurnRunner = (call: DelegateTurnCall) => Promise<string>;
```

`ProviderTurnAssembly` gains optional `delegateTurnRunner?: DelegateTurnRunner`; `assembleProviderTurn`'s input gains the same optional field, passed through verbatim (inside the try, but the callback itself does no work at assembly time — construction cannot add assembly-throw surface). Provider-blindness canon holds: the assembly seam carries an opaque callback; provider resolution, adapter classes, and budget machinery all live at the manager where the callback is built. Absent callback (tests, gemini pre-352 if the manager ever gated it) ⇒ no Task tool — fail-dark, not fail-broken.

### D5 — The nested-turn runner (`agent-manager.ts`)

`createProviderAdapter`'s Lane B branch builds the callback before calling `assembleProviderTurn` and passes it in. Closure captures: `agentId`, `config` (registry snapshot), `route` (provider/model/effort — the same resolution the breaker permit used), and `this`. Behavior, in order:

1. **Stop check:** `stoppedAgents.has(agentId)` → return `Task denied: agent is stopped.`
2. **Budget acquire:** read `activeSpawnCount` vs `spawnBudgetFor(agentId)`; at/over budget → `recordSaturation(...)` + return `Task denied: spawn budget exhausted (<active>/<budget>). Retry later or proceed without the delegate.` Under budget → increment. **Released in `finally`** (same decrement idiom as `withSpawnTicket`, incl. the delete-at-zero). The per-thread lock is deliberately NOT touched: the parent holds `agentId:threadId` for the entire outer turn — a nested wait on it deadlocks forever; same-thread serialization is a message-level concern the parent already provides. Nested turns are visible in the snapshot via `activeSpawns` (shared counter) and `saturationCount`.
3. **Nested assembly** (pure helper, new `buildNestedDelegateAssembly()` in `turn-assembly.ts` — unit-testable without a manager):
   - `instructions` = `config.delegatePrompts?.[delegate]` ?? the generic specialist prompt, **verbatim** from `buildServerSubAgents` (`agent-runner.ts:1629-1630`) — extract the string to a shared exported constant so the lanes cannot drift. No datetime trailer, no memory, no constitution (Claude parity: `AgentDefinition.prompt` is the subagent's whole system prompt).
   - `toolInventory` = [the delegate re-expressed at its real transport (`classifyToolTransport({name, transport: derived from serverConfig.type, source: "core"})` + `{schemas: {kind:"connect-time"}, serverConfig}`), plus the six builtin static entries (same construction as the parent inventory's builtin loop)]. No `claude-subagent` entries, no in-process, no skills ⇒ structural depth-1 and no nested `load_skill`.
   - `guardrailGate` = `buildDefaultGuardrailGate(config, workItemContext)` (same archetype rules govern nested tool calls — PreToolUse parity: SDK hooks apply to subagent tools too); `memory: {}`; `skillIndex: []`; `inProcessServers: {}`; `sessionCwd` = parent's; **no `delegateTurnRunner`**.
4. **Nested adapter:** same class as the route — `openai` → `OpenAIAgentsAdapter({name: \`${config.name}:${delegate}\`, model: route.model || configured default, assembly})`; `codex` → `CodexSubscriptionAdapter({..., reasoningEffort: route.reasoningEffort, assembly})` with **`historyStore`/`agentId` omitted** — the KPR-353 wiring then skips replay and persist by construction (`codex-subscription-adapter.ts:140-142`). Model/effort inherit the parent route (`model: "inherit"` parity).
5. **Abort chain:** if `signal.aborted` pre-flight → return aborted text; else `signal.addEventListener("abort", () => nested.abort(), { once: true })`, removed in `finally`.
6. **Run:** `nested.runTurn({prompt, workItemContext, resourceLimits: {maxTurns: customPrompt ? 7 : 10}})` — the 7/10 constants verbatim from `buildServerSubAgents` (`:1637`), shared via the same extraction. No `sessionId`, no `onStream`, no `effort` field (effort rides the adapter constructor as on the parent path).
7. **Result shaping (never throws):** success → `result.text` (empty → `Delegate '<name>' returned no output.`); `result.error` → `Delegate turn failed (<name>): <error>`; `result.aborted` → `Delegate turn aborted (<name>).`; thrown (belt-and-suspenders) → caught, same failed shape. Nested `result.sessionId` discarded; nothing touches `sessionStore`.
8. **Telemetry:** one info log keyed on the **route** provider (resolved-provider attribution canon): `{agentId, provider, delegate, durationMs, toolCalls, inputTokens, outputTokens, error?}`. Nested usage is logged, not folded into the parent `RunResult` (⚠ Key Points; `costUsd` is 0 on both Lane B surfaces anyway).

No breaker acquire/record (⚠ ruling, Key Points); no session-identity guard interplay (nested turns never read or write session state); reflection scheduling untouched (nested turns complete inside the parent spawn).

### D6 — Toolkit rendering (`toolkit-section.ts`, `prefix-builder.ts`)

`buildProviderToolkitSection` gains a fourth subsection rendered from `claude-subagent` entries now present in the partitioned inventory (the input doc comment's "never reach this function" flips): `### Delegated capability MCPs (via the Task tool)` + `formatToolkitLine(entry.name, resolveCatalogEntry(...))` per delegate — mirroring the Claude section (`:184-191`) with Task-specific framing. Rendered only when entries exist; gemini never sees it pre-352 (`toolsExecutable` false ⇒ no toolkit at all). Claude-lane `buildToolkitSection` and `buildPrefix` untouched (golden gate stays green).

### D7 — What deliberately does not change

- **Claude lane:** `buildServerSubAgents`, SDK `agents:` wiring, KPR-184 constraint, autonomy gates — all untouched. The autonomy/unsafe filtering already happened upstream of the inventory (`activeDelegateNames`), so Lane B inherits the same gate decisions with zero new checks.
- **Sessions/history:** `SESSION_SEMANTICS`, `persistsResumableHandle`, write/read scrubbing, KPR-313 guard, `TurnHistoryStore` — untouched; nested turns are outside all of it by construction (G4).
- **Breaker/outage:** acquire/record sites, classification tables, outage queue — untouched. `error_max_turns` from a nested loop arrives as tool text, never as a parent `RunResult.error`.
- **Bridge core:** `wrap()`, connect/close lifecycle, name/cap edges beyond the one pin addition, MCP mechanics — untouched.

### D8 — Documentation riders

- CLAUDE.md provider-adapters paragraph: openai/codex now carry delegate subagents via nested adapter turns (budget-accounted, session-less); Task-shaped omission language updated.
- **Matrix row facts (child 10):** subagents on openai/codex = `caveat(delegate subagents full — nested single-shot adapter turns, budget-gated (spawnBudget ≥ 2), no nested streaming/skills/memory, nested faults breaker-invisible; general-purpose Task claude-only)`; gemini = pending KPR-352; Lane A = full (native runtime).
- `tool-transport.ts` comment corrections per D1.

## Integration points

| Seam | This ticket | Must NOT touch |
|---|---|---|
| `tool-transport.ts` | D1 classify flip (one path, three columns); `description?` field; comment corrections | `BRIDGEABLE_COMPATIBILITIES`, partition logic, builtin branch behavior |
| `agent-runner.ts` | delegate-loop carriage (serverConfig + description, D2); shared prompt/maxTurns constants extraction (D5.3/D5.6) | `buildServerSubAgents` behavior, Claude toolkit/prefix output (golden-gated), send() wiring |
| `types.ts` | **none** | `SESSION_SEMANTICS`, unions, adapter contract |
| `turn-assembly.ts` | `DelegateTurnCall` / `DelegateTurnRunner` types (D4); `delegateTurnRunner?` on assembly + input; `buildNestedDelegateAssembly()` (D5.3) | `TOOL_EXECUTING_PROVIDERS`, gate builder, assembly-throw classification |
| `tool-bridge.ts` | claude-subagent partition + Task synthesis (D3); `delegateRunner?` option; `Task` cap pin | `wrap()` order/text shapes, MCP connect/close, existing partitions |
| `openai-agents-adapter.ts` / `codex-subscription-adapter.ts` | one line each: pass `delegateRunner` into bridge options | loops, auth, telemetry, history wiring |
| `agent-manager.ts` | nested-turn runner callback in the Lane B branch of `createProviderAdapter` (D5) | `withSpawnTicket`, per-thread lock, breaker acquire/record, KPR-313 guard, `finalizeSpawnResult` |
| `toolkit-section.ts` | Lane B delegates subsection (D6) | Claude `buildToolkitSection` |
| `gemini-adk-adapter.ts`, `claude-agent-adapter.ts`, `passthrough-providers.ts`, `session-store.ts`, `turn-history-store.ts`, `builtin-executor.ts`, `archetype-gate.ts` | **none** | everything |

## Edge cases

- **No delegates / all autonomy-blocked:** no `claude-subagent` entries ⇒ no Task tool, no toolkit section — today's behavior exactly.
- **Unknown `subagent_type` / empty prompt / bad args JSON:** structured error text listing valid names; parent loop continues.
- **Budget exhausted / agent stopped:** structured denial text; saturation recorded; no slot leak (denials never increment).
- **Budget = 1 (operator-set):** parent occupies the sole slot ⇒ every Task call denied. Documented (`spawnBudget ≥ 2` guidance in matrix caveat); saturation counter makes it visible in `hive doctor`.
- **Parallel Task calls (openai SDK parallel function calls):** each takes a slot; budget bounds fan-out; codex is sequential per KPR-353 canon (≤1 nested turn at a time).
- **Abort mid-nested-turn:** parent signal fires → nested `abort()` → aborted tool text; parent turn is aborting anyway; listener removed in `finally`; no unhandled rejections.
- **Abort between gate-allow and runner start:** `wrap()`'s pre-execute signal check plus the runner's own pre-flight check both return aborted text.
- **Nested delegate server fails to connect:** nested bridge fail-soft ⇒ nested turn runs builtin-only; the delegate replies degraded (Claude-lane parity: a subagent with a broken MCP behaves the same).
- **Nested maxTurns exhausted:** nested `error_max_turns` → `Delegate turn failed (...)` text; non-provider by construction (tool result, not parent error).
- **Provider 5xx/auth fault inside nested turn:** tool text, breaker-invisible (⚠ ruling); a genuine outage trips via parent rounds.
- **Codex parent with thread history:** nested adapter has no `historyStore` ⇒ no replay of parent thread history into the delegate, no persist of delegate items — `provider_turn_history` provably untouched (T5 pins).
- **Delegate entry unexpectedly missing `serverConfig`** (foreign/test inventory): nested assembly builds builtin-only inventory + warn — degraded, contained, never a throw.
- **Gemini pre-352:** entries classify bridgeable (omission record changes), adapter advertises zero tools, callback inert — no behavior change.
- **Task name collision with the omitted builtin:** none — the `Task` claude-builtin entry never renders on Lane B (claude-only partition) and the synthesized tool is the only `Task` in the bridged surface.

## Testing contract sketch

Vitest beside source; `npm run check` green; negative-verify discipline on flips.

- **T1 — classify flip:** `claude-subagent` ⇒ `requires-hive-bridge` on openai/gemini/codex, `direct` on claude (negative-verify: fails pre-flip); `Task`/`WebFetch` builtins still `claude-only`; partition now routes delegate entries to `bridgeable` and drops the per-delegate omission records.
- **T2 — inventory carriage:** delegate entries carry `serverConfig` + catalog `description`; in-process servers still never appear as delegates (KPR-184 path untouched).
- **T3 — Task synthesis:** present iff (entries ∧ runner); Claude-identical schema with enum; description lists delegates; gate-deny on `Task` yields denial text; unknown type/bad args → structured errors; runner receives validated `{delegate, prompt, entry, signal}`; `Task` pinned under the 128 cap; absent runner ⇒ no tool.
- **T4 — nested assembly builder:** custom vs generic prompt (verbatim constants); inventory = delegate-at-real-transport + six builtins only; no subagent entries, no runner, no skills/in-process/memory; maxTurns 7/10 mapping.
- **T5 — nested runner (manager):** slot acquired and released on success/error/throw (finally); saturation denial + `recordSaturation`; stopped-agent denial; abort chaining (parent signal → nested `abort()`, listener removed); codex nested constructed WITHOUT `historyStore` (spy: store never called); session store never touched; result shaping for success/error/aborted/empty; callback never rejects.
- **T6 — parent integration:** openai adapter advertises `Task` via SDK tool binding when assembly carries entries + runner (mocked); codex request body carries the Task function tool; nested wall time lands in `toolMs` ⇒ parent `llmMs` excludes it.
- **T7 — toolkit:** Lane B delegates subsection renders iff entries present; Claude-lane golden/byte-identity tests stay green untouched.
- **T8 — breaker neutrality:** a nested turn resolving with a provider-fault-shaped error produces a successful parent turn (`classifyTurnResult` success) with the fault visible only in tool text.

## Open assumptions

**Blocking:** none — every provider-facing mechanic (one more function tool in the advertised set) is already live-proven on both surfaces by the KPR-348/353 spikes; all new machinery is hive-side.

**Non-blocking (⚠ delegated/documented):**
- ⚠ Enum-restricted `subagent_type` in a function schema is well-supported on both Responses and Agents-SDK surfaces; if a live turn shows the codex backend rejecting `enum`, the fallback is a plain string + runner-side validation (already implemented as the error path). Cheap to confirm during KPR-351's live validation; not gating.
- ⚠ Nested turns breaker-invisible and usage-unfolded (Key Points rulings) — accepted residuals, matrix-listed.
- ⚠ Builtins-in-nested-surface mirrors Claude subagent tool inheritance; if operators report delegate scope creep, narrowing to server-tools-only is a one-line inventory change in `buildNestedDelegateAssembly`.
- ⚠ Denial-not-wait on budget saturation: waiting risks deadlock chains (parents holding slots while blocked on nested waits); the model can retry or proceed. If live use shows chronic denials, the lever is `spawnBudget`, not a queue.
- ⚠ No per-nested-turn wall-clock timeout beyond maxTurns rounds + per-tool timeouts + parent abort; if a hung provider stream inside a nested turn surfaces in practice, a bounded overall timeout can be added at the runner seam without contract changes.
