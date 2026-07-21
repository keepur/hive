# KPR-349 — Memory + skills parity: shared prompt assembly extraction (Claude-lane byte-parity gate)

**Child 4 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D5 (this child's design section), §D3 (contract fields this child populates), §D4 (the bridge this child's skill index lights up).
**Shape:** extraction + regression gate. **Depends on:** KPR-347 (merged @ e774260 — contract + seam). KPR-348 (merged, in this baseline @ b18b366) is a *seam neighbor*, not a dependency: the bridge executes tools, but assembly does not need execution — every anchor below is verified against this worktree's post-348 HEAD.
**Informs:** KPR-350 (session replay may later consume `assembly.memory`), KPR-352/353 (flip their providers into the tool-honesty set, §D3), KPR-355 (matrix rows this spec resolves or lists).
**Decision-register canon honored:** the KPR-348 cap-priority delegation is ruled here (§D7); the builtin Edit/Write empty-string nit is ruled here (§D8); `SESSION_SEMANTICS` untouched (canon); bridge-owned dispatch extended, not redesigned — this child populates the skill index the bridge already consumes (canon).

## TL;DR

Give Lane B the real system prompt. Today `assembly.instructions` is `buildPilotInstructions` = soul + systemPrompt (`turn-assembly.ts:83-86,130`) — no constitution, no roster, no toolkit, no memory. KPR-213 already extracted the Claude prefix into a pure builder (`prefix-builder.ts:buildPrefix`), so this child's "extraction" is a **sibling composition, not a rewrite**: `buildPrefix` is refactored into shared section helpers (byte-identical output, golden-gated), and a new `buildProviderInstructions` composes the same sections for Lane B — minus Claude-specific fragments, plus a toolkit rendered from the partitioned inventory, plus a skills section backed by the now-populated `assembly.skillIndex` (lighting up the `load_skill` tool KPR-348 shipped dark), plus hot-tier memory, datetime last. The Claude lane keeps the KPR-213 prefix cache and **byte-identical output** — proven by golden-prefix fixtures committed before the refactor. Structured-memory *tools* already ride the bridge (sdk-in-process entries, KPR-348); this child pins that with an integration test rather than building anything. Two delegated rulings land: tool-cap priority (pinned tier for builtins + `load_skill`, §D7) and the builtin Edit/Write empty-string parity nit (carried here, §D8). Assembly throws stay `TurnAssemblyError` → `non-provider`.

## Key Points

- **The extraction already half-exists — exploit it, don't re-do it.** KPR-213 left `buildPrefix` (`src/agents/prefix-builder.ts:62-168`) as a pure async function covering soul → archetype card → systemPrompt → constitution → team summary → toolkit → file-tier-memory guidance → hot-tier/legacy memory. The runner's `buildSystemPrompt` (`agent-runner.ts:352-379`) only adds cache read-through and the datetime trailer. This child splits `buildPrefix`'s body into exported section helpers and adds `buildProviderInstructions` beside it; `buildPrefix` becomes a composition of the same helpers with **byte-identical output**.
- **Byte-parity gate is the headline invariant:** golden-prefix fixture tests over representative agent configs are committed in a first, refactor-free commit (they pass against today's code), then the refactor lands under them — snapshot-first is this child's negative-verify discipline. The datetime trailer is extracted to one shared helper so the two lanes cannot drift (`agent-runner.ts:374-378` format preserved verbatim).
- **Lane B is uncached, and the KPR-213 cache is untouched.** `PrefixCache` remains Claude-only: Lane B assembly calls the builder directly per spawn (per-spawn adapters, canon: construction-time ≡ turn-time). No cache-key surgery, no shared-entry poisoning risk, no invalidation-path changes — the parity gate covers content; a spy test pins that Lane B never touches `PrefixCache`. If Lane B volume ever warrants caching, that's a follow-up lever we deliberately don't pre-build (simplicity ruling).
- **Tool-honesty gate for the un-flipped pilots:** tool-dependent prompt sections (toolkit, skills, file-tier-memory guidance) render **only for providers whose adapter actually executes bridged tools** — a `TOOL_EXECUTING_PROVIDERS = {openai}` set beside the assembly; KPR-352/353 each add their provider when they flip. Gemini/codex meanwhile get persona + constitution + roster + hot-tier memory and *no* tool claims — a strict upgrade from pilot instructions that never advertises tools their adapters (still zero-tools by canon) can't deliver.
- **Toolkit renders from the child-2 inventory contract, not from `coreServers`:** a new `buildProviderToolkitSection` consumes the *partitioned* `assembly.toolInventory` — six executor builtins (never WebFetch/WebSearch/NotebookEdit/TodoWrite/Task), MCP servers grouped engine/capability by the entry's `source`, no "Delegated capability MCPs" section (claude-subagent entries are partition-omitted), no tool-search hint. The model's tool-selection surface stays honest per epic §D5.
- **Memory parity = injection + tools, and the tools half is already done:** hot-tier injection (or the legacy `memory.md` fallback) arrives with the shared builder; `assembly.memory.hotTierPrompt` is populated with the same rendered block (single-injection rule: adapters never fold it in again). Structured-memory + memory MCP servers already classify sdk-in-process → `requires-hive-bridge` → bridgeable (`agent-runner.ts:1222,1252-1264`; `tool-transport.ts:118-121`) and execute via the KPR-348 bridge — this child adds the *pin*, not the plumbing.
- **Skills: index population lights up the dark tool.** `assembly.skillIndex` is derived per spawn from the existing loader (`getSkillsForAgent`, `skill-loader.ts:676`) by reading each projected plugin's `skills/<name>/SKILL.md` frontmatter (name = directory name, description from frontmatter) — per-skill fail-soft. Non-empty index ⇒ the bridge renders `load_skill` (`tool-bridge.ts:341-363`, shipped in 348, dark until now) and the prompt carries a skills section teaching its use. Per-skill `agents:` scoping applies unchanged because derivation starts from the already-scoped index.
- **Cap-priority ruling (canon delegation, §D7):** structurally load-bearing tools — the six executor builtins + `load_skill` — are **pinned, never cap-dropped**; the >128 drop applies tail-first to the remaining (MCP-discovered) tools only. The 348-shipped order (drop `load_skill` first, builtins next) inverted the sane priority; ruled and implemented here (~10 lines in `applyNameAndCapEdges`, `tool-bridge.ts:365-397`).
- **Edit/Write empty-string nit (canon delegation, §D8):** ruled **carried here** — `requireString` (`builtin-executor.ts:388-394`) rejects `new_string: ""` (deletion) and `content: ""` (truncation), a real Claude-lane divergence. Two-line fix + tests; clean-wrap-over-debt beats deferring to the 352/353 window, and KPR-355 then has nothing to matrix-list.
- **Fault posture unchanged:** every new assembly step (builder, skill derivation, memory fold-in) runs inside `assembleProviderTurn`'s existing `TurnAssemblyError` try (`turn-assembly.ts:129-162`) — a Mongo blip during hot-tier fold-in classifies `non-provider` and never trips a foreign breaker (contract-tested here, this child's half of the 347 contract).
- ⚠ Delegated assumptions (§Open assumptions): golden fixtures rely on deterministic mocked context (real-instance byte-diff is a spot-check, not CI); frontmatter `description` quality varies across fleet skills (empty description falls back to skill name); toolkit-at-assembly cannot reflect connect-time fail-soft omissions (pre-existing Claude-lane gap, matrix note).

## Problem

Post-347/348 the seam can express parity and the bridge can execute tools, but the model still flies blind and the skill surface is dark:

1. **Instructions are the pilot stub.** `assembleProviderTurn` step 1 is `buildPilotInstructions(config.name, config.soul, config.systemPrompt)` (`turn-assembly.ts:130`) — a reassigned agent loses the constitution (non-negotiable team rules), team roster, toolkit awareness, and *all* memory. It doesn't know its own team exists.
2. **`memory: {}`, `skillIndex: []`** (`turn-assembly.ts:152-153`) — the 347 placeholders. The bridge's `load_skill` tool exists but never renders (`tool-bridge.ts:342` returns null on empty index); hot-tier memory reaches no non-Claude turn.
3. **The toolkit contract is unrendered.** Epic §D5 requires the Lane B toolkit to come from the bridged inventory "so the model's tool-selection surface stays honest" — today Lane B has no toolkit at all, and naively reusing the Claude section would advertise WebFetch/Task/delegates that don't exist there.
4. **Two canon delegations are unresolved:** cap-drop priority for structurally load-bearing tools, and the Edit/Write empty-string divergence.

## Goals

- G1: Shared prompt assembly — one set of section helpers feeds both lanes; Claude output **byte-identical**, gated by golden-prefix fixtures committed before the refactor; KPR-213 cache behavior untouched.
- G2: Lane B instructions for tool-executing providers carry: soul → archetype card → systemPrompt → constitution → team summary → inventory-rendered toolkit → file-tier-memory guidance (when memory is bridged) → skills section (when index non-empty) → hot-tier/legacy memory → datetime last.
- G3: `assembly.memory.hotTierPrompt` and `assembly.skillIndex` populated; `load_skill` live end-to-end (index → bridge tool → SKILL.md content).
- G4: Non-tool-executing Lane B providers (gemini/codex, pre-352/353) get the same assembly **minus tool-dependent sections** — no false tool claims.
- G5: Cap-priority ruling implemented: builtins + `load_skill` never dropped at the 128 cap.
- G6: Edit/Write empty-string parity fix in the builtin executor.
- G7: All new assembly work inside the `TurnAssemblyError` boundary; contract test that an assembly-time memory fault leaves every provider breaker closed.

## Non-goals

- Tool execution mechanics, dispatch wrapper, gate, containment — KPR-348 (done; consumed as-is). No bridge edits beyond §D7's cap ordering and none to `wrap`/`connect`/`close`.
- Flipping gemini/codex adapters' zero-tools stubs — KPR-352/353 (they also flip their `TOOL_EXECUTING_PROVIDERS` membership, §D3).
- Session semantics, resume, replay — KPR-350. `SESSION_SEMANTICS` untouched (canon).
- Subagent parity (Task) — child 9. Delegate-server prompt content stays Claude-only.
- Reflection scheduling — already provider-agnostic (post-quiescence debounce), unchanged.
- Lane A anything; parity matrix (child 10 — §D3/§D4 caveats feed it).
- Prefix caching for Lane B; per-turn effort; toolkit deferred-hint (`TOOLKIT_DEFERRED_HINT` stays dark — KPR-329 concern, Claude-lane only).

## Design

### D1 — Shared section helpers (the extraction)

`src/agents/prefix-builder.ts` is restructured; `buildPrefix`'s signature and output are unchanged. The body becomes a composition of exported helpers, one per prompt layer:

| Helper | Extracted from | Notes |
|---|---|---|
| `soulSection`, `archetypeCardSection`, `systemPromptSection` | `prefix-builder.ts:67-91` | archetype card keeps its catch-and-omit posture |
| `constitutionSection(memoryManager)` | `:95-98` | read-miss falls through, unchanged |
| `teamSummarySection(teamRoster)` | `:101-111` | warn-and-omit posture unchanged |
| `fileTierMemoryGuidance()` | `:135-142` | the KPR-327 static text, verbatim |
| `memorySections(memoryManager, agentId)` | `:146-165` | hot-tier first, legacy `memory.md` + file-listing fallback; **returns the rendered block(s) plus the raw hot-tier string** so assembly can populate `ProviderMemoryBundle` without a second Mongo read |
| `formatDateTimeTrailer()` | `agent-runner.ts:376-378` | verbatim format string, single definition; `buildSystemPrompt` calls it — the one `agent-runner.ts` edit on the Claude path |
| joiner `"\n\n---\n\n"` | `prefix-builder.ts:167` | shared constant |

`buildPrefix(agentConfig, ctx)` = the same helpers in the same order with the Claude toolkit (`buildToolkitSection`, unchanged) in its slot. Pure refactor; the golden gate (§D2) is the proof.

New in the same file:

```ts
export interface ProviderInstructionsInput {
  toolInventory: HiveToolInventoryEntry[];   // partitioned (assembly.toolInventory)
  skillIndex: ProviderSkillIndexEntry[];     // derived (§D6)
  toolsExecutable: boolean;                  // §D3 honesty gate
  memoryManager: MemoryManager;
  teamRoster?: TeamRoster;
  plugins: LoadedPlugin[];
}
export interface ProviderInstructionsResult {
  instructions: string;                      // full text, datetime last
  hotTierPrompt?: string;                    // → assembly.memory
}
export async function buildProviderInstructions(
  agentConfig: AgentConfig, input: ProviderInstructionsInput,
): Promise<ProviderInstructionsResult>;
```

Layer order (G2), tool-dependent layers marked †(gated by `toolsExecutable`): soul → archetype card → systemPrompt → constitution → team summary → †toolkit (§D4) → †file-tier-memory guidance (iff a `memory` entry is in the inventory — same predicate spirit as `prefix-builder.ts:135`, keyed on the inventory rather than `coreServerNames`) → †skills section (§D6, iff index non-empty) → hot-tier/legacy memory → datetime trailer. Datetime goes last for the same prompt-cache reason as the Claude lane — provider-side prompt caching is prefix-based too.

Call path: `AgentRunner` gains one public method (the 348 pattern — `buildInProcessServers`/`resolveTurnCwd` precedent) so the runner's private `memoryManager`/`teamRoster`/`plugins`/`skillIndex` stay private:

```ts
// agent-runner.ts — thin: derives skill entries (§D6), delegates to prefix-builder
buildProviderPrompt(opts: {toolInventory, provider}): Promise<{instructions, hotTierPrompt?, skillEntries}>
```

`assembleProviderTurn` replaces step 1: derive `skillEntries` + call the builder (both inside the existing try), set `instructions`, `memory: {hotTierPrompt}`, `skillIndex: skillEntries`. `buildPilotInstructions` is **deleted** (last caller gone; the 347 byte-identity pins on it are inverted — §Testing T0/T6). The `ProviderTurnAssembly` doc comments at `turn-assembly.ts:51-77` are updated to describe the live shapes (additive refinement only, per the 347 contract: no existing field changes shape).

### D2 — Claude-lane byte-parity regression gate (headline)

Two commits, deliberately ordered:

1. **Golden-fixture commit (refactor-free):** `prefix-builder.golden.test.ts` builds prefixes via the *current* `buildPrefix` across representative fixture configs and snapshots them (Vitest inline/file snapshots). Fixtures span the branchy inputs: bare-bones agent (no soul/archetype/roster); archetyped agent with `archetypeConfig` (card rendered) and archetype-throw (card omitted); constitution present/absent; team summary present/throwing; `memory` in/out of coreServers (KPR-327 guidance gate); hot-tier present vs legacy `memory.md` + extra files vs no memory; plugins + delegate names (toolkit subsections); `toolSearch` off vs auto (deferredLoadingActive input — output currently identical since the hint is dark, pinned anyway). Context objects are deterministic mocks (fixed strings) — golden bytes are stable across machines. A datetime-composition test pins `buildSystemPrompt`'s full-output shape (`^<prefix>\n\n---\n\n\*\*Current date/time\*\*: .+ \(Pacific Time\)$`).
2. **Refactor commit(s) under the gate:** helper extraction + `buildProviderInstructions` + seam swap. The goldens must not change — any snapshot churn in commit 2+ is a parity break by definition. This *is* the negative-verify: the gate demonstrably fails on drift because it was born against pre-refactor bytes.

Cache invariants: `prefix-cache.test.ts` / `prefix-invalidation.test.ts` untouched and green; new spy test — a Lane B `assembleProviderTurn` with a `PrefixCache`-carrying runner never calls `getOrBuild`/`invalidate*` (Lane B is uncached by ruling); a Claude-lane `buildSystemPrompt` still routes through `getOrBuild` (`agent-runner.ts:370-372` unchanged).

Post-merge spot-check (not CI): one real-instance before/after byte-diff of an assembled prefix (e.g. via the KPR-213 cache-stats path) recorded in the PR — belt-and-suspenders over the mocked goldens.

### D3 — Tool-honesty gate: `TOOL_EXECUTING_PROVIDERS`

The assembly is provider-shared, but post-348 only the openai adapter executes bridged tools — gemini/codex still advertise zero tools (canon: their stubs flip in 352/353). Rendering a toolkit/skills section for them would tell the model about tools that do not exist on its turn — worse than the pilot stub.

**Ruling:** `const TOOL_EXECUTING_PROVIDERS: ReadonlySet<LaneBProviderId> = new Set(["openai"])` lives in `turn-assembly.ts` beside the assembly (the same one-line-per-provider growth pattern as `SESSION_SEMANTICS`); `toolsExecutable = TOOL_EXECUTING_PROVIDERS.has(provider)` feeds the builder. KPR-352/353 each add their provider in the same commit that flips their adapter — the set and the stub-flip are one review surface. Gated sections: toolkit, file-tier-memory guidance, skills section. **Not** gated: constitution, roster, hot-tier memory — provider-independent context that upgrades gemini/codex turns immediately. `assembly.skillIndex`/`memory` are populated uniformly (contract fields describe *hive's* surface; the bridge only runs where an adapter constructs it, so a populated index is inert for zero-tools adapters — and 352/353 inherit working skills for free).

### D4 — Toolkit from the inventory (`buildProviderToolkitSection`)

New pure function in `src/agents/toolkit-section.ts` (beside `buildToolkitSection`, sharing `resolveCatalogEntry`/`formatToolkitLine`/blurbs). Input: `{toolInventory, plugins}` — the *partitioned* entries. Rendering:

- **Built-in:** only entries with `transport === "claude-builtin"` that survived the partition — i.e. the six executor-backed tools with `{kind:"static"}` schemas (`agent-runner.ts:1291-1307`, `tool-transport.ts:93-116`). Per-tool lines with the existing blurbs (`Bash — run shell commands`, …). WebFetch/WebSearch/NotebookEdit/TodoWrite/Task never appear (claude-only ⇒ partition-omitted).
- **Engine-provided / Capability MCPs:** entries with transport ∈ {stdio, http, sse, sdk-in-process}, grouped by the entry's `source` field (`engine` → engine-provided; `core`/`plugin` → capability), catalog blurbs as today. One line per *server* — same granularity as the Claude toolkit; the bridge exposes their tools as `mcp__<server>__<tool>`, so server-level listing stays truthful.
- **Omitted:** no delegated-MCPs section (claude-subagent entries never reach the partition output); no deferred-loading hint (tool search is a Claude-CLI mechanism); header/"try them; don't guess" framing reused.

Known honesty limit (matrix note, pre-existing on the Claude lane too): the toolkit renders at assembly time, before `connect()` — a server that fail-softs at connect (`tool-bridge.ts` §D7 of 348) is still listed. `runtimeOmissions` is the honest record; the toolkit already hedges with "try them".

### D5 — Memory parity

- **Hot-tier injection:** `memorySections` in the shared builder (D1) — identical logic and budget (`config.memory.hotBudgetTokens`, `prefix-builder.ts:146`) on both lanes, including the legacy `memory.md` + file-listing fallback.
- **Bundle population:** `assembly.memory = {hotTierPrompt}` from the builder's returned raw block (undefined when the agent has none — the 347 optional-field shape, no additive change needed). **Single-injection rule:** the block is already folded into `instructions`; adapters and future consumers must not inject it again (doc'd on the field; KPR-350 may *read* it for replay bookkeeping).
- **Structured-memory + memory tools:** nothing to build — `memory` (explicit in-process surface, `agent-runner.ts:1252-1264`) and `structured-memory` (via `IN_PROCESS_PORTED_SERVERS`, `:1222`) classify sdk-in-process → `requires-hive-bridge` → partition-bridgeable, and KPR-348's `connectInProcess` (`tool-bridge.ts:251+`) executes them over `InMemoryTransport` with the same handlers and prefix-cache write-through invalidation closures (`agent-runner.ts:1354-1356` — note: those closures keep the *Claude* lane's cache correct when a Lane B turn writes memory; Lane B itself is uncached). This child adds the integration pin (T5): a Lane B turn calls `mcp__structured-memory__*` / `mcp__memory__view` through the bridge and the file-tier-memory guidance renders iff the memory entry is bridged.
- **Reflection:** provider-agnostic already (post-quiescence debounce in `AgentManager`); untouched, noted for the matrix.

### D6 — Skills: index derivation + the section + `load_skill` lights up

**Derivation** — new `src/agents/provider-adapters/skill-index.ts`:

```ts
export function deriveProviderSkillIndex(sdkPlugins: SdkPluginConfig[]): ProviderSkillIndexEntry[]
```

Input = `getSkillsForAgent(this.skillIndex, agentId)` (the runner's existing `buildNativeSkills`, `agent-runner.ts:1664-1666` — already agent-scoped, universal-merged, dedup'd, customer-shadowed). For each plugin config, enumerate `<path>/skills/*/SKILL.md` (projection layout guarantees exactly one skill per projected plugin, `skill-loader.ts:246-288`, but the loop tolerates many); per entry: `name` = skill directory name (the loader's scoping unit and the stable lookup key — frontmatter `name` may drift and is ignored), `description` = frontmatter `description` via `readSkillMd` (`src/skills/frontmatter.ts`), falling back to the skill name when empty, `path` = absolute SKILL.md path (realpath-resolved — symlink chains in projections are pre-resolved by the loader). **Per-skill fail-soft:** unreadable/unparseable SKILL.md → warn + skip that entry (mirrors the loader's per-agent posture, `skill-loader.ts:179-186`) — one bad skill must not `TurnAssemblyError` the turn. Name collisions across sources are already resolved upstream; a residual duplicate name keeps the first entry (matching the bridge's first-wins `Map` at `tool-bridge.ts:343`) and warns.

**Prompt section** (†gated, rendered when index non-empty):

```
## Your skills
Named procedures for specific jobs. When a task matches one, call load_skill
with its name FIRST and follow the returned instructions.
- <name> — <description>
```

This mirrors the SDK's skill-surfacing behavior in function (index in context, content on demand) without imitating its exact wording — the SDK's injected text is CLI-internal and not a contract.

**`load_skill`:** zero bridge changes — `buildLoadSkillTool` (`tool-bridge.ts:341-363`) already renders on non-empty index, validates names against the index, reads the SKILL.md, and routes through the gated dispatch wrapper. This child makes it live and owns the end-to-end test (T6). Skill *support files* referenced by a SKILL.md (helpers/templates beside it) are reachable via the bridged `Read`/`Bash` builtins at their real paths — parity with how a Claude-lane skill's own instructions reference siblings; noted in the section text? No — SKILL.mds already use paths relative to themselves; the model has `Read`. Matrix note only.

### D7 — Ruling: cap priority for structurally load-bearing tools (canon delegation)

**Ruling: two tiers.** Tier 0 — the six executor builtins + `load_skill` (≤7 tools) are **pinned: never dropped by the 128 cap**. Tier 1 — everything else (MCP-discovered tools) keeps inventory order and takes the entire tail-drop. Rationale: the 348-shipped order drops `load_skill` first and builtins next (`connectInner` pushes externals → in-process → builtins → load_skill, `tool-bridge.ts:123-181`; `applyNameAndCapEdges` splices the tail, `:387-395`) — precisely inverted: a plugin-heavy agent would lose Bash and the skill loader before losing its 90th vector-search tool, and the prompt's skills section (§D6) would reference a tool the cap silently removed. Pinning ≤7 tools against a 128 cap costs nothing and keeps every prompt claim this child adds structurally true.

Implementation (the one bridge edit this child makes, confined to `applyNameAndCapEdges`): compute the pinned-name set (executor-backed builtin names present + `load_skill` if rendered); when over cap, drop from the Tier-1 tail only; omission logging/`runtimeOmissions` unchanged in shape (`reason: "provider-tool-cap"`). Prompt honesty at the cap: cap-dropped Tier-1 tools belong to servers the toolkit lists at server granularity — covered by the §D4 honesty limit + `runtimeOmissions`; no additional prompt surgery (the cap is unreachable for every fleet agent today; loud logs remain the operator surface).

### D8 — Ruling: builtin Edit/Write empty-string parity (canon delegation)

**Ruling: carried here.** `requireString` (`builtin-executor.ts:388-394`) throws on `""`, so `Edit {new_string: ""}` (deletion — a routine agent operation) and `Write {content: ""}` (truncate-to-empty) fail where the Claude lane succeeds. Fix: `Write.content` and `Edit.new_string` accept empty strings (presence-checked, not length-checked — `requireString` gains an `allowEmpty` option or a sibling helper); `old_string` stays non-empty (Claude-lane Edit also rejects empty `old_string`); the `old_string !== new_string` guard (`:292`) stays. Tests: deletion via empty `new_string`, truncation via empty `content`, negative-verify on pre-fix code (revert → tests fail). Why here and not the 352/353 window canon suggested: it's a two-line, test-covered divergence fix in a file this epic owns, with no seam contact — clean-wrap-over-debt; carrying it means KPR-355 has no row to list and 352/353 inherit a correct baseline. Scope-marked as a rider (own commit) so review can see the boundary.

### D9 — Fault classification (this child's half of the 347 contract)

All new assembly work — skill derivation, `buildProviderInstructions` (constitution read, team summary, hot-tier fold-in) — executes inside `assembleProviderTurn`'s existing try (`turn-assembly.ts:129-162`); any throw becomes `TurnAssemblyError` → `classifyThrown` → `non-provider`. The epic §D5 hazard test lands here (T7): a `getHotTierPrompt` Mongo-shaped rejection during Lane B assembly fails the spawn with `TurnAssemblyError` and leaves the openai breaker **closed** after 3 repeats (existing breaker harness). Interior fail-softs (archetype card, team summary, per-skill parse) keep their warn-and-omit posture — identical to the Claude lane, pinned by the goldens.

## Integration points

| Seam | This ticket | Must NOT touch |
|---|---|---|
| `prefix-builder.ts` | section-helper extraction, `buildProviderInstructions`, shared joiner + datetime trailer (§D1) | `buildPrefix` signature/output (golden-gated); `PrefixBuildContext` shape |
| `agent-runner.ts` | `buildSystemPrompt` calls the shared datetime trailer (byte-identical); new `buildProviderPrompt` method (§D1) | cache read-through (`:370-372`), `buildToolkitSection` call, `buildToolTransportInventory`, `buildInProcessServers`, hooks, send() |
| `turn-assembly.ts` | step-1 swap (delete `buildPilotInstructions`), populate `memory`/`skillIndex`, `TOOL_EXECUTING_PROVIDERS` (§D3), doc-comment refresh | `buildDefaultGuardrailGate` (348's), `inProcessServers`/`sessionCwd` steps, `TurnAssemblyError` wrapper shape |
| `toolkit-section.ts` | new `buildProviderToolkitSection` + shared helper reuse (§D4) | `buildToolkitSection` output (Claude toolkit — golden-gated), `SDK_BUILTINS`, `TOOLKIT_DEFERRED_HINT` |
| new `provider-adapters/skill-index.ts` | `deriveProviderSkillIndex` (§D6) | — |
| `tool-bridge.ts` | `applyNameAndCapEdges` pinned-tier ordering only (§D7) | `wrap`/dispatch, `connect*`, `close`, `buildLoadSkillTool`, containment, stats |
| `builtin-executor.ts` | empty-string acceptance for `Write.content`/`Edit.new_string` (§D8, rider commit) | schemas otherwise, Bash/Read/Glob/Grep, kill/abort paths |
| `agent-manager.ts` | none (seam call unchanged — assembly is already awaited, `agent-manager.ts:505-510`) | everything |
| adapters (openai/gemini/codex), `types.ts`, `tool-transport.ts`, `archetype-gate.ts`, `prefix-cache.ts` | none | `SESSION_SEMANTICS`, provider unions, partition semantics, cache internals |

## Edge cases

- **Agent with no soul/archetype/roster and empty memory:** Lane B instructions still non-empty (systemPrompt + constitution if present + datetime); never the `You are ${name}` fallback (that died with `buildPilotInstructions` — systemPrompt is a required config field).
- **Constitution read miss / roster throw during Lane B assembly:** omit-and-continue (same as Claude lane) — not a `TurnAssemblyError`; only *throws escaping the builder* classify (hot-tier read rejection does throw today → turn fails `non-provider`; parity with the Claude lane, where the same rejection fails `buildSystemPrompt`).
- **`memory` server not in agent's coreServers:** no memory inventory entry ⇒ no file-tier guidance section; hot-tier injection still runs (injection is memoryManager-side, not tool-side) — mirrors Claude-lane behavior where guidance is gated on the server but injection is not (`prefix-builder.ts:135,146`).
- **Empty skill index for the agent:** no skills section, bridge renders no `load_skill` (348 behavior) — zero prompt residue.
- **Skill deleted on disk between load and spawn:** derivation fail-softs (skip + warn); if it vanishes between derivation and a `load_skill` call, the wrapper's containment returns structured error text (348's readFile throw path) — turn survives.
- **Gemini/codex turn (pre-352/353):** instructions carry constitution/roster/memory but no toolkit/skills/guidance; `assembly.skillIndex` populated but inert (no bridge constructed).
- **>128 bridged tools:** builtins + `load_skill` survive; Tier-1 tail dropped, loud (§D7).
- **Lane B memory write during a turn:** in-process handlers' write-through invalidation still fires (`agent-runner.ts:1354-1356`) — keeps the *Claude* lane's cached prefix fresh for the same agent; Lane B's next spawn rebuilds fresh by construction.
- **Datetime minute boundary:** trailer computed once per spawn (assembly time) — identical semantics to the Claude lane's once-per-`buildSystemPrompt`.

## Testing contract sketch

Vitest beside source; `npm run check` green. T0 ordering is load-bearing: goldens land green *before* any refactor commit.

- **T0 — golden byte-parity (unit, snapshot-first):** the §D2 fixture matrix through `buildPrefix` — snapshots committed pre-refactor, unchanged post-refactor. Datetime-composition pin on `buildSystemPrompt`. The 347 pilot-instruction pins (`turn-assembly.test.ts:57-74`) are **inverted**: `assembly.instructions` no longer equals `soul\n\nsystemPrompt` and now contains constitution/datetime markers.
- **T1 — cache invariants:** existing prefix-cache/invalidation suites untouched; spy test — Lane B assembly performs zero `PrefixCache` calls; Claude lane still `getOrBuild`s.
- **T2 — Lane B composition (unit on `buildProviderInstructions`):** section order (soul…datetime-last regex); †sections present iff `toolsExecutable`; file-tier guidance iff memory entry in inventory; hot-tier vs legacy fallback; skills section iff index non-empty; no `WebFetch`/`Task`/delegate strings anywhere in a Lane B toolkit; datetime format identical to Claude trailer.
- **T3 — provider toolkit rendering:** fixture inventory (stdio + http + sdk-in-process + six builtins, engine/core/plugin sources) → correct grouping, per-tool builtin lines, no delegated section, no deferred hint; partition-omitted entries absent.
- **T4 — skill derivation:** fixture projection tree (flat, scoped, universal, one corrupt SKILL.md) → entries with dir-name `name`, frontmatter `description` (+fallback), absolute paths; corrupt skill skipped with warn, no throw; duplicate name → first wins + warn.
- **T5 — memory tools pin (integration):** Lane B assembly + bridge over a real `createSdkMcpServer` memory/structured-memory fixture → `mcp__memory__view` and a structured-memory tool round-trip; `assembly.memory.hotTierPrompt` equals the block folded into instructions (single-injection: exactly one occurrence).
- **T6 — `load_skill` end-to-end (the light-up):** real derivation → populated index → bridge renders `load_skill` → returns fixture SKILL.md content; unknown-name error text; goes through the gate (deny-all gate fixture denies it). Negative-verify: 348's dark-pin (empty index ⇒ no tool) still holds.
- **T7 — fault classification (this child's 347-contract half):** `getHotTierPrompt` rejection during `assembleProviderTurn` → `TurnAssemblyError`; ×3 via the seam harness → openai breaker closed; skill-derivation throw (forced past fail-soft) also contained by the wrapper try.
- **T8 — cap priority (§D7):** synthetic >128 inventory with skills → builtins + `load_skill` retained, Tier-1 tail dropped + logged + recorded. Negative-verify against reverted ordering: pre-ruling code drops `load_skill` first.
- **T9 — Edit/Write parity rider (§D8):** empty `new_string` deletes; empty `content` truncates; empty `old_string`/`file_path` still rejected; negative-verify on pre-fix `requireString`.

## Open assumptions

**Blocking:** none — every consumed surface (347 contract, 348 bridge/executor, KPR-213 builder) is merged and verified in this worktree.

**Non-blocking (⚠ delegated/documented):**
- ⚠ Golden fixtures use deterministic mocks; absolute byte-parity on a live instance is a PR-time spot-check, not CI (mock fidelity is the residual risk; the fixture matrix covers every branch in `buildPrefix`).
- ⚠ Fleet SKILL.md frontmatter `description` quality varies; name-fallback keeps the section honest but terse — skill authoring hygiene, not engine scope.
- ⚠ Toolkit-at-assembly vs connect-time fail-soft omissions (§D4) — pre-existing gap on both lanes; `runtimeOmissions` is the record; matrix-listed by child 10.
- ⚠ `TOOL_EXECUTING_PROVIDERS` is a temporary honesty gate — 352/353 each flip their provider and the set dissolves into "all Lane B" (delete-candidate once all three execute tools); if either child re-sequences, the gate keeps prompts honest indefinitely at zero cost.
- ⚠ Skills-section wording mirrors SDK *function*, not SDK bytes — if live use shows models under-calling `load_skill`, wording iterates freely (prompt text, not contract).
