# KPR-349 Implementation Plan — Memory + skills parity: shared prompt assembly extraction (Claude-lane byte-parity gate)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-349-spec.md](./kpr-349-spec.md) (final-round approved @ b5419b8) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D5/§D3/§D4. Baseline: KPR-347 merged @ e774260, KPR-348 merged @ b18b366 (all anchors below verified against this worktree's HEAD b5419b8).

**Goal:** Give Lane B the real system prompt. Refactor `buildPrefix` (KPR-213) into shared exported section helpers with **byte-identical Claude-lane output** (golden-gated, snapshot-first), add `buildProviderInstructions` composing the same sections for Lane B — inventory-rendered toolkit, skills section over a newly populated `assembly.skillIndex` (lighting up KPR-348's dark `load_skill`), hot-tier/legacy memory with tool-claim gating for non-executing providers, datetime last. Land the two canon-delegated rulings: §D7 cap-priority (two-tier pin) and §D8 builtin Edit/Write empty-string parity.

**Architecture:** `src/agents/prefix-builder.ts` becomes a library of section helpers; `buildPrefix` recomposes them (pure refactor, golden-proven); `buildProviderInstructions` lives beside it. `AgentRunner` gains one public method (`buildProviderPrompt`, the 348 `buildInProcessServers`/`resolveTurnCwd` precedent) that derives the skill index (`deriveProviderSkillIndex`, new file) and delegates to the builder. `assembleProviderTurn` swaps step 1, computes `toolsExecutable` from `TOOL_EXECUTING_PROVIDERS` (lives in `turn-assembly.ts`), and populates `memory`/`skillIndex`; `buildPilotInstructions` is deleted. `buildProviderToolkitSection` (in `toolkit-section.ts`) renders the partitioned inventory. The only bridge edit is §D7's cap ordering in `applyNameAndCapEdges`; the §D8 rider is its own commit in `builtin-executor.ts`.

**Tech stack:** TypeScript strict, vitest (file snapshots for goldens), existing test scaffolding only — no new dependencies.

**Decision-register canon honored (per task):**
- *Bridge-owned dispatch extended, not redesigned* — this child populates the skill index the bridge already consumes; zero edits to `wrap`/`connect*`/`close`/`buildLoadSkillTool` (Tasks 3, 4 boundaries).
- *KPR-348 cap-priority delegation* ("cap-priority ruling delegated to KPR-349") — ruled §D7, implemented in Task 4 only.
- *KPR-348 follow-up nit (builtin Edit/Write empty-string)* — ruled "carried here" (§D8), implemented in Task 5 as an isolated rider commit; KPR-355 gets no matrix row.
- *`SESSION_SEMANTICS` untouched* — no task touches it; Task 6 verifies by diff.
- *KPR-347 parity payload additive-only* — `ProviderTurnAssembly` fields keep their shapes; this plan only populates `memory`/`skillIndex` and refreshes doc comments (Task 3).
- *KPR-347→348 assembly throws stay non-provider by type* — all new assembly work runs inside the existing `TurnAssemblyError` try (Task 3, T7).
- *KPR-352/353 flip their own providers* — `TOOL_EXECUTING_PROVIDERS = {openai}` here; gemini/codex adapters, `types.ts`, `tool-transport.ts` untouched (Task 6 verifies).

**Final-review notes reflected (spec final gate):**
1. **Commit order is load-bearing:** Task 0 lands the golden-prefix fixtures green in a refactor-free commit BEFORE any helper extraction (Task 1+); the §D8 rider is its own commit (Task 5); §D7 is the only bridge edit (Task 4).
2. **Exact gated hot-tier trailer text** is specified (Step 2.1): the gated variant is the reworded sentence `---\nYou have ${n} additional memories.` — not a line-drop of the fused sentence. **§D5 naming-mismatch: option (a) is taken** — the tool-executing Lane B render names the tool `mcp__structured-memory__memory_recall`; the Claude lane keeps bare `memory_recall` verbatim (golden-pinned). T2 asserts the choice (Step 2.6).
3. **`memorySections` returns the raw hot-tier string alongside rendered blocks** (single Mongo read → `assembly.memory.hotTierPrompt`); single-injection rule documented on the field (Steps 2.2, 3.1).
4. **`TOOL_EXECUTING_PROVIDERS` lives in `turn-assembly.ts`;** the gate feeds the builder as a plain boolean — no per-provider branches inside `prefix-builder.ts` (`buildProviderPrompt` takes `toolsExecutable: boolean`, not a provider id — Steps 3.1, 3.2).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `prefix-builder.ts` (golden byte-parity T0, provider composition T2), `memory-manager.ts` (`getHotTierPrompt` trailer variants), `toolkit-section.ts` (`buildProviderToolkitSection` T3), `provider-adapters/skill-index.ts` (derivation T4), `tool-bridge.ts` (cap priority T8), `builtin-executor.ts` (empty-string parity T9), `agent-runner.ts` (datetime composition pin).
  - Reason: the headline invariant (Claude-lane byte-identity) and both canon rulings are unit-testable contracts; the honesty gate (G4) is a pure-function property of the builder.
  - Minimum assertions: the T0–T4, T8, T9 blocks in "Critical Flows" below, each mapped to a step.

- Integration: **required**
  - Scope: (a) seam swap — `assembleProviderTurn` populates `instructions`/`memory`/`skillIndex` via the runner's `buildProviderPrompt`, pilot pins inverted (T0 inversion half); (b) `PrefixCache` neutrality — Lane B assembly performs zero cache calls, Claude lane still routes `getOrBuild` (T1); (c) memory-tools pin — Lane B bridge round-trips `mcp__memory__view` + a structured-memory tool over real `createSdkMcpServer` instances, single-injection on `hotTierPrompt` (T5); (d) `load_skill` end-to-end from a real fixture skill tree through derivation → assembly → bridge (T6); (e) fault classification — hot-tier rejection during assembly → `TurnAssemblyError` → breaker stays closed ×3 (T7).
  - Reason: parity only means something across the runner/assembly/bridge boundary; the light-up (G3) and the 347-contract half (G7) are cross-module by definition.
  - Harness: **existing** — vitest beside source; `turn-assembly.test.ts` has the mock-runner pattern (`makeRunner`, `turn-assembly.test.ts:42-53`); `tool-bridge.test.ts` has real-`McpServer`-over-`InMemoryTransport` fixtures; `agent-runner.test.ts` has full `AgentRunner` construction with `makeFakeInProcessDb()` (`agent-runner.test.ts:243,297`); breaker harness exists (`provider-circuit-breaker` tests).
  - Minimum assertions: T1, T5 (incl. exactly-one-occurrence single-injection), T6 (incl. deny-gate + dark-pin negative), T7 (incl. breaker-closed after ×3).

- E2E: **required** (manual, evidence-recorded — not in `npm run check`)
  - Scope: the §D2 post-merge real-instance byte-diff spot-check — one assembled Claude prefix captured before and after the refactor on a live dev instance, byte-compared; result recorded in the PR description.
  - Reason: golden fixtures use deterministic mocks (spec ⚠ delegated assumption 1) — mock fidelity is the residual risk; one live byte-diff is the belt-and-suspenders the spec commits to.
  - Harness: **setup-required** — dev Mac with a running hive instance (dodi or keepur). Capture path: a scratch tsx driver that constructs the production `AgentRunner` wiring for one real agent and prints `buildPrefix` output (the KPR-213 cache-stats path is an acceptable alternative capture point). If no dev instance is reachable, that is a **concrete blocker to report**, not a skip.
  - Minimum assertions: byte-identical before/after for at least one real agent with non-trivial memory (hot-tier records present).

### Critical Flows

- T0 — golden byte-parity (snapshot-first): the §D2 fixture matrix through `buildPrefix`, snapshots committed pre-refactor (Task 0), unchanged through every later commit. Datetime-composition pin on `buildSystemPrompt` full-output shape. Inversion half (Task 3): the KPR-347 pilot-instruction pins no longer hold — `assembly.instructions` contains constitution/datetime markers, `buildPilotInstructions` is gone.
- T1 — cache invariants: existing `prefix-cache.test.ts` / `prefix-invalidation.test.ts` pass unmodified; Lane B `buildProviderPrompt` on a `PrefixCache`-carrying runner never calls `getOrBuild`/`invalidateAgent`/`invalidateAll`; Claude-lane `buildSystemPrompt` still routes through `getOrBuild`.
- T2 — Lane B composition (unit on `buildProviderInstructions`): section order (soul first … datetime-last regex); †sections (toolkit, file-tier guidance, skills) present iff `toolsExecutable`; file-tier guidance iff a `memory` entry is in the inventory; hot-tier vs legacy fallback; skills section iff index non-empty; no `WebFetch`/`Task`/delegate strings in a Lane B toolkit; datetime format identical to the Claude trailer. **Memory tool-claim gate:** `toolsExecutable: false` with warm/cold records ⇒ zero occurrences of `memory_recall` and zero of `memory MCP server` in the output, while record content, the warm/cold count, and file-listing paths still render; the gated trailer is exactly `---\nYou have N additional memories.`. Mirror case `toolsExecutable: true` ⇒ trailer present naming `mcp__structured-memory__memory_recall` (option (a) asserted) and the legacy file-listing's `via the memory MCP server (\`view\`)` sentence present.
- T3 — provider toolkit rendering: fixture inventory (stdio + http + sdk-in-process + six static builtins, engine/core/plugin sources) → correct grouping, per-tool builtin lines, no delegated section, no deferred hint, partition-omitted entries absent.
- T4 — skill derivation: fixture projection tree (plain, multi-skill, one corrupt SKILL.md, one empty description, duplicate name) → dir-name `name`, frontmatter `description` (+name fallback), absolute realpath, corrupt skipped with warn (no throw), duplicate first-wins + warn.
- T5 — memory tools pin (integration): Lane B bridge over the runner's real in-process `memory`/`structured-memory` servers → `mcp__memory__view` and a structured-memory tool round-trip; `assembly.memory.hotTierPrompt` equals the block folded into instructions, occurring **exactly once**.
- T6 — `load_skill` end-to-end: real derivation → populated index → bridge renders `load_skill` → returns fixture SKILL.md content; unknown-name error text; deny-all gate fixture denies it; negative-verify: empty index ⇒ no tool (348's dark-pin still holds).
- T7 — fault classification: `getHotTierPrompt` rejection during `assembleProviderTurn` → `TurnAssemblyError`; ×3 through `classifyTurnResult` + a real `ProviderCircuitBreaker` → openai breaker **closed**; forced skill-derivation throw also contained by the wrapper try.
- T8 — cap priority (§D7): synthetic >128 inventory with skills → six builtins + `load_skill` all retained, Tier-1 tail dropped + logged + recorded (`reason: "provider-tool-cap"`). Negative-verify against reverted ordering (pre-ruling code drops `load_skill`).
- T9 — Edit/Write parity rider (§D8): empty `new_string` deletes; empty `content` truncates; empty `old_string`/`file_path` still rejected; negative-verify on pre-fix `requireString`.

### Regression Surface

- **Claude lane byte-identical:** `buildPrefix` signature and output unchanged (golden-gated); `buildSystemPrompt` output unchanged (datetime pin); `buildToolkitSection` output untouched; `getHotTierPrompt` default-call output untouched (existing `memory-manager.test.ts:95+` assertions pass unmodified). Existing `prefix-builder.test.ts`, `agent-runner.test.ts`, `toolkit-section.test.ts` suites pass with **zero edits to existing assertions** (new describes are additive).
- **KPR-213 cache untouched:** `prefix-cache.ts` / `prefix-invalidation.ts` unmodified; their suites pass unmodified; Lane B is uncached by ruling (T1 spy).
- **KPR-348 bridge:** `tool-bridge.ts` modified in `applyNameAndCapEdges` only; all existing `tool-bridge.test.ts` cases pass except the one 348 cap-order case this ruling supersedes (see Step 4.2 — that assertion is *updated to the ruled behavior*, not deleted).
- **Sessions/adapters:** `SESSION_SEMANTICS`, `types.ts`, all four adapter files, `tool-transport.ts`, `archetype-gate.ts` untouched (Task 6 empty-diff checks). `agent-manager.ts` gets exactly one **comment-only** edit in Task 3 (the stale `buildPilotInstructions` reference at `:503` is reworded to name the replacement — `buildProviderInstructions`/`assembleProviderTurn`); this is not a functional/seam change and is authorized explicitly (see File Structure and Step 3.2b) — Task 6 checks its diff is comment-only, not empty.
- **`turn-assembly.test.ts`:** the two KPR-347 pilot-byte-identity pins are **inverted by design** (spec T0) — replaced with assertions that `instructions` carries the real assembly; every other existing assertion (partition, omitted, gate, inProcessServers, sessionCwd) passes unmodified.

### Commands

- Fast loop: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/prefix-builder.golden.test.ts src/agents/prefix-builder.test.ts src/agents/prefix-builder.provider.test.ts src/agents/toolkit-section.test.ts src/agents/agent-runner.test.ts src/agents/provider-adapters src/memory/memory-manager.test.ts`
- Full gate (every chunk commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.
- E2E spot-check: scratch driver on dev Mac (Task 6), evidence in the PR description.

### Harness Requirements

- `npm ci` in this worktree if `node_modules` absent.
- Unit/integration tests run with **no** live credentials, no network, no Mongo (mocked managers; `makeFakeInProcessDb()`; fixture `McpServer` instances over `InMemoryTransport`).
- Node 22/24 (dev-mode Node 26 broken per KPR-344).
- Golden snapshots are deterministic across machines: all builder inputs are fixed strings/mocks; no dates enter `buildPrefix` (datetime is runner-side).

### Non-Required Rationale

- (none — all three groups required.)

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test. **Golden churn in any commit after Task 0 is a parity break by definition — fix the refactor, never `--update` the snapshots** (the only legitimate snapshot update in this ticket's life is Task 0's initial generation).
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Negative-verify discipline (operator standard), three mandatory legs, each run against weakened code with the failure recorded before restoring:
  1. **Byte-parity gate (Task 1):** temporarily perturb one extracted helper (drop the legacy file-listing's trailer sentence in `memorySections`) → golden suite fails → revert → green. Proves the goldens actually bite on the refactored composition path.
  2. **Cap priority (Task 4):** revert `applyNameAndCapEdges` to the 348 tail-splice → T8 fails (load_skill dropped) → restore.
  3. **Empty-string rider (Task 5):** revert `requireString` → T9 deletion/truncation cases fail → restore.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/agents/prefix-builder.golden.test.ts` | create (Task 0) | T0 golden fixture matrix over `buildPrefix` (file snapshots) |
| `src/agents/__snapshots__/prefix-builder.golden.test.ts.snap` | create (Task 0) | Committed golden bytes — never regenerated after Task 0 |
| `src/agents/agent-runner.test.ts` | modify (Task 0 additive, Task 3 additive) | Datetime-composition pin on `buildSystemPrompt`; T1 Claude-lane `getOrBuild` + Lane B cache-spy tests |
| `src/agents/prefix-builder.ts` | modify (Task 1, Task 2) | Section-helper extraction (Task 1, byte-identical); `memorySections` gate + `buildProviderInstructions` (Task 2) |
| `src/agents/agent-runner.ts` | modify (Task 1, Task 3) | `buildSystemPrompt` uses shared trailer (Task 1); new `buildProviderPrompt` method (Task 3) |
| `src/memory/memory-manager.ts` | modify (Task 2) | `getHotTierPrompt` optional `recallToolName` — default preserves Claude bytes |
| `src/memory/memory-manager.test.ts` | modify (Task 2, additive) | Trailer variant assertions (default/qualified/gated) |
| `src/agents/toolkit-section.ts` | modify (Task 2) | New `buildProviderToolkitSection` (§D4) reusing private helpers; `buildToolkitSection` untouched |
| `src/agents/toolkit-section.test.ts` | modify (Task 2, additive) | T3 |
| `src/agents/provider-adapters/skill-index.ts` | create (Task 2) | `deriveProviderSkillIndex` (§D6) |
| `src/agents/provider-adapters/skill-index.test.ts` | create (Task 2) | T4 |
| `src/agents/prefix-builder.provider.test.ts` | create (Task 2) | T2 — `buildProviderInstructions` composition + memory tool-claim gate |
| `src/agents/provider-adapters/turn-assembly.ts` | modify (Task 3) | `TOOL_EXECUTING_PROVIDERS`, step-1 swap, delete `buildPilotInstructions`, populate `memory`/`skillIndex`, doc-comment refresh |
| `src/agents/provider-adapters/turn-assembly.test.ts` | modify (Task 3) | Pilot pins inverted; T7 assembly-fault + breaker-closed |
| `src/agents/agent-manager.ts` | modify (Task 3, comment-only) | Reword the stale `buildPilotInstructions` comment at `:503` to name the replacement (`buildProviderInstructions`/`assembleProviderTurn`) — no functional/seam change |
| `src/agents/provider-adapters/openai-agents-adapter.test.ts` | modify (Task 3) | KPR-347 byte-identity pin inverted: inline literal fixture (`"soul\n\nsystem"`) replaces the `buildPilotInstructions` import/call |
| `src/agents/provider-adapters/gemini-adk-adapter.test.ts` | modify (Task 3) | Same inversion as above |
| `src/agents/provider-adapters/codex-subscription-adapter.test.ts` | modify (Task 3) | Same inversion as above |
| `src/agents/provider-adapters/tool-bridge.test.ts` | modify (Task 3 additive, Task 4) | T5 memory pin + T6 `load_skill` e2e (Task 3); T8 + updated cap-order case (Task 4) |
| `src/agents/provider-adapters/tool-bridge.ts` | modify (Task 4 ONLY) | §D7 two-tier cap priority in `applyNameAndCapEdges` — the only bridge edit |
| `src/agents/provider-adapters/builtin-executor.ts` | modify (Task 5 ONLY — rider commit) | §D8 `allowEmpty` on `Write.content`/`Edit.new_string` |
| `src/agents/provider-adapters/builtin-executor.test.ts` | modify (Task 5) | T9 |

**NOT touched (spec Integration table):** `prefix-cache.ts`, `prefix-invalidation.ts`, `tool-transport.ts`, `archetype-gate.ts`, `types.ts` (incl. `SESSION_SEMANTICS`), `openai-agents-adapter.ts`, `gemini-adk-adapter.ts`, `codex-subscription-adapter.ts`, `claude-agent-adapter.ts`, `tool-bridge.ts` outside `applyNameAndCapEdges` (`wrap`/`connect*`/`close`/`buildLoadSkillTool`/containment/stats), `buildToolkitSection` body, `buildHooks`, `buildToolTransportInventory`, `buildInProcessServers`, `send()`. **`agent-manager.ts` is the one deliberate exception:** it gets a single comment-only edit in Task 3 (see file table above) — its call-site logic (`createProviderAdapter`, the `assembleProviderTurn` call, per-provider adapter construction) is untouched; only the stale in-line comment naming the deleted `buildPilotInstructions` is reworded.

---

## Task 0 (Chunk 0): Golden-prefix fixtures — refactor-free commit (⚠ gate for Tasks 1–3)

**Files:**
- Create: `src/agents/prefix-builder.golden.test.ts` (+ its generated snapshot file)
- Modify (additive): `src/agents/agent-runner.test.ts`

This commit contains **zero production-code changes**. The goldens are born against today's `buildPrefix` bytes; every later commit must keep them green untouched. Verified anchors this task pins: `prefix-builder.ts:62-168` (current `buildPrefix` body), `agent-runner.ts:352-379` (`buildSystemPrompt` + datetime trailer), `prefix-builder.ts:75` (the `archetypeDef && agentConfig.archetypeConfig` conjunction), `prefix-builder.ts:135` (KPR-327 guidance gate), `prefix-builder.ts:146-165` (hot-tier/legacy memory), `prefix-builder.ts:167` (joiner).

- [ ] **Step 0.1: Write `src/agents/prefix-builder.golden.test.ts`**

Mock scaffolding mirrors `prefix-builder.test.ts:1-77` (logger mock, partial config mock, `makeAgentConfig`/`makeMemoryManager`/`makeCtx` helpers — copy them; the golden file stays standalone so Task 2's edits to `prefix-builder.test.ts`-adjacent files never touch it). Archetype fixtures use the real registry (`registerArchetype`/`__resetRegistryForTests`, `src/archetypes/registry.ts:77,95`).

```typescript
/**
 * KPR-349 (spec §D2): golden byte-parity gate for the Claude-lane prefix.
 *
 * COMMITTED REFACTOR-FREE: these snapshots were generated against the
 * pre-extraction buildPrefix (KPR-213 shape). Any snapshot churn in a later
 * commit is a Claude-lane parity break BY DEFINITION — fix the refactor,
 * never update the snapshots. The fixture matrix covers every branch in
 * buildPrefix; inputs are deterministic mocks so bytes are machine-stable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentConfig } from "../types/agent-config.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      memory: { hotBudgetTokens: 3000 },
      workflow: { enabled: false },
      toolSearch: { mode: "auto", source: "default" },
    },
  };
});

import { buildPrefix, type PrefixBuildContext } from "./prefix-builder.js";
import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";
import type { ArchetypeDefinition } from "../archetypes/registry.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "golden-agent",
    name: "GoldenAgent",
    model: "claude-haiku-4-5",
    channels: ["agent-golden"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    icon: "",
    coreServers: [],
    delegateServers: [],
    soul: "",
    systemPrompt: "GOLDEN-SYSTEM-PROMPT: you are the golden fixture agent.",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function makeMemoryManager(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    read: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    getHotTierPrompt: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PrefixBuildContext> = {}): PrefixBuildContext {
  return {
    coreServerNames: [],
    activeDelegateNames: [],
    memoryManager: makeMemoryManager() as never,
    teamRoster: undefined,
    plugins: [],
    skillIndex: new Map(),
    prefetcher: undefined,
    eventSubscribersJson: "{}",
    autoInjectedServers: new Set<string>(),
    ...overrides,
  };
}

/** Deterministic hot-tier block — the EXACT shape getHotTierPrompt renders
 *  (memory-manager.ts:107-127) including the fused memory_recall trailer. */
const HOT_TIER_FIXTURE = [
  "## Your Memory",
  "### Key Facts\n- [2026-07-01] Golden fact one (high)\n- [2026-07-02] Golden fact two (medium)",
  "### Pinned\n- Golden pinned entry (high, pinned)",
  "---\nYou have 7 additional memories available via `memory_recall`. Use it to search for context before starting tasks.",
].join("\n\n");

const GOLDEN_ARCHETYPE: ArchetypeDefinition = {
  id: "golden-archetype",
  validateConfig: (c) => c,
  systemPromptCard: () => "GOLDEN-ARCHETYPE-CARD: fixture discipline card.",
  preToolUseHooks: () => [],
  memoryScopes: () => [],
  sessionOptions: () => ({}),
};

const THROWING_ARCHETYPE: ArchetypeDefinition = {
  ...GOLDEN_ARCHETYPE,
  id: "throwing-archetype",
  systemPromptCard: () => {
    throw new Error("card exploded");
  },
};

beforeEach(() => {
  __resetRegistryForTests();
  registerArchetype(GOLDEN_ARCHETYPE);
  registerArchetype(THROWING_ARCHETYPE);
});
afterEach(() => __resetRegistryForTests());

describe("buildPrefix golden byte-parity (KPR-349 §D2 — snapshot-first)", () => {
  it("G1: bare-bones agent (no soul/archetype/roster/memory)", async () => {
    expect(await buildPrefix(makeAgentConfig(), makeCtx())).toMatchSnapshot();
  });

  it("G2: soul + constitution present", async () => {
    const ctx = makeCtx({
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "shared/constitution.md" ? "GOLDEN-CONSTITUTION: rule one." : null),
        ),
      }) as never,
    });
    expect(await buildPrefix(makeAgentConfig({ soul: "GOLDEN-SOUL: warm, precise." }), ctx)).toMatchSnapshot();
  });

  it("G3: archetype card rendered (archetypeConfig present)", async () => {
    const cfg = makeAgentConfig({ archetype: "golden-archetype", archetypeConfig: { k: "v" } });
    expect(await buildPrefix(cfg, makeCtx())).toMatchSnapshot();
  });

  it("G4: archetype card throws → omitted, rest of prefix intact", async () => {
    const cfg = makeAgentConfig({ archetype: "throwing-archetype", archetypeConfig: { k: "v" } });
    const out = await buildPrefix(cfg, makeCtx());
    expect(out).not.toContain("GOLDEN-ARCHETYPE-CARD");
    expect(out).toMatchSnapshot();
  });

  it("G5: archetype id resolves but archetypeConfig absent → card skipped (prefix-builder.ts:75 conjunction)", async () => {
    const cfg = makeAgentConfig({ archetype: "golden-archetype" }); // no archetypeConfig
    const out = await buildPrefix(cfg, makeCtx());
    expect(out).not.toContain("GOLDEN-ARCHETYPE-CARD");
    expect(out).toMatchSnapshot();
  });

  it("G6: team summary present", async () => {
    const ctx = makeCtx({
      teamRoster: { teamSummary: vi.fn().mockResolvedValue("GOLDEN-TEAM: roster of two.") } as never,
    });
    expect(await buildPrefix(makeAgentConfig(), ctx)).toMatchSnapshot();
  });

  it("G7: team summary throws → omitted", async () => {
    const ctx = makeCtx({
      teamRoster: { teamSummary: vi.fn().mockRejectedValue(new Error("roster down")) } as never,
    });
    const out = await buildPrefix(makeAgentConfig(), ctx);
    expect(out).not.toContain("GOLDEN-TEAM");
    expect(out).toMatchSnapshot();
  });

  it("G8: memory in coreServers → file-tier guidance + hot-tier block", async () => {
    const ctx = makeCtx({
      coreServerNames: ["memory", "structured-memory"],
      memoryManager: makeMemoryManager({
        getHotTierPrompt: vi.fn().mockResolvedValue(HOT_TIER_FIXTURE),
      }) as never,
    });
    const out = await buildPrefix(makeAgentConfig({ coreServers: ["memory"] }), ctx);
    expect(out).toContain("## File-Tier Memory");
    expect(out).toContain("memory_recall");
    expect(out).toMatchSnapshot();
  });

  it("G9: legacy memory.md + extra files fallback (hot tier null)", async () => {
    const ctx = makeCtx({
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "agents/golden-agent/memory.md" ? "GOLDEN-LEGACY-MEMORY body." : null),
        ),
        list: vi.fn().mockResolvedValue(["memory.md", "projects.md", "contacts.md", "notes.txt"]),
      }) as never,
    });
    const out = await buildPrefix(makeAgentConfig(), ctx);
    expect(out).toContain("## Available Memory Files");
    expect(out).toContain("Read relevant files via the memory MCP server (`view`)");
    expect(out).toMatchSnapshot();
  });

  it("G10: toolkit subsections — core + plugins + delegates + auto-injected", async () => {
    const ctx = makeCtx({
      coreServerNames: ["schedule", "team", "contacts", "golden-plugin-server"],
      activeDelegateNames: ["crm-search"],
      autoInjectedServers: new Set(["schedule", "team", "team-roster"]),
      plugins: [
        {
          manifest: {
            mcpServers: { "golden-plugin-server": { description: "golden plugin capability" } },
          },
        } as never,
      ],
    });
    const out = await buildPrefix(makeAgentConfig({ coreServers: ["contacts"] }), ctx);
    expect(out).toContain("### Delegated capability MCPs");
    expect(out).toMatchSnapshot();
  });

  it("G11: toolSearch off vs auto — byte-identical today (hint dark), pinned", async () => {
    const ctx = makeCtx();
    const offOut = await buildPrefix(makeAgentConfig({ toolSearch: "off" }), ctx);
    const autoOut = await buildPrefix(makeAgentConfig({ toolSearch: "auto" }), ctx);
    expect(offOut).toBe(autoOut); // TOOLKIT_DEFERRED_HINT stays dark (toolkit-section.ts:120)
    expect(offOut).toMatchSnapshot();
  });

  it("G12: kitchen sink — every layer at once", async () => {
    const ctx = makeCtx({
      coreServerNames: ["memory", "schedule", "team", "contacts"],
      activeDelegateNames: ["crm-search"],
      autoInjectedServers: new Set(["schedule", "team", "team-roster"]),
      teamRoster: { teamSummary: vi.fn().mockResolvedValue("GOLDEN-TEAM: roster of two.") } as never,
      memoryManager: makeMemoryManager({
        read: vi.fn().mockImplementation((p: string) =>
          Promise.resolve(p === "shared/constitution.md" ? "GOLDEN-CONSTITUTION: rule one." : null),
        ),
        getHotTierPrompt: vi.fn().mockResolvedValue(HOT_TIER_FIXTURE),
      }) as never,
    });
    const cfg = makeAgentConfig({
      soul: "GOLDEN-SOUL: warm, precise.",
      archetype: "golden-archetype",
      archetypeConfig: { k: "v" },
      coreServers: ["memory", "contacts"],
    });
    expect(await buildPrefix(cfg, ctx)).toMatchSnapshot();
  });
});
```

- [ ] **Step 0.2: Datetime-composition pin — new describe in `agent-runner.test.ts` (additive only)**

Uses the file's existing mock scaffolding + `AgentRunner` construction pattern (`agent-runner.test.ts:229,297`). Append:

```typescript
describe("buildSystemPrompt datetime composition (KPR-349 §D2 pin)", () => {
  it("output is <prefix> + joiner + Pacific datetime trailer, datetime last", async () => {
    const memoryManager = makeMockMemoryManager();
    const runner = new AgentRunner(
      makeAgentConfig({ systemPrompt: "PIN-SYSTEM-PROMPT" }),
      memoryManager as never,
    );
    const out = await (
      runner as unknown as { buildSystemPrompt(c: string[], d?: string[]): Promise<string> }
    ).buildSystemPrompt([]);
    // Full-output shape: prefix, then the exact joiner, then the trailer — nothing after.
    expect(out).toMatch(/^[\s\S]+\n\n---\n\n\*\*Current date\/time\*\*: .+ \(Pacific Time\)$/);
    expect(out).toContain("PIN-SYSTEM-PROMPT");
    // Trailer text renders an en-US Pacific timestamp (weekday, month day, year, h:mm AM/PM).
    const trailer = out.slice(out.lastIndexOf("**Current date/time**"));
    expect(trailer).toMatch(
      /^\*\*Current date\/time\*\*: (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2} (AM|PM) \(Pacific Time\)$/,
    );
  });
});
```

(If the runner's constructor signature in the test file needs extra defaulted args, mirror the nearest existing construction — do not modify existing tests.)

- [ ] **Step 0.3: Generate snapshots + verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/prefix-builder.golden.test.ts src/agents/agent-runner.test.ts`
Expected: all green; `src/agents/__snapshots__/prefix-builder.golden.test.ts.snap` created with 12 snapshots. Inspect the snap file — every fixture marker (GOLDEN-SOUL, GOLDEN-CONSTITUTION, `\n\n---\n\n` joiners, memory_recall trailer) visibly present.

Then: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0.

```bash
git add src/agents/prefix-builder.golden.test.ts src/agents/__snapshots__/prefix-builder.golden.test.ts.snap src/agents/agent-runner.test.ts
git commit -m "KPR-349: golden-prefix byte-parity fixtures (refactor-free, pre-extraction bytes)"
```

---

## Task 1 (Chunk 1): Helper extraction — `buildPrefix` recomposition under the golden gate

**Files:**
- Modify: `src/agents/prefix-builder.ts` (extraction only — `buildProviderInstructions` arrives in Task 2)
- Modify: `src/agents/agent-runner.ts` (one edit: `buildSystemPrompt` composes the shared trailer)

Pure motion: `buildPrefix`'s body becomes a composition of exported helpers; output byte-identical (Task 0 goldens prove it). `memorySections` lands here with its `toolsExecutable` parameter already in the signature but **only ever called with `true` from `buildPrefix`** — the gating branch is exercised (and the memory-manager half added) in Task 2.

- [ ] **Step 1.1: Rewrite `src/agents/prefix-builder.ts` — helpers + recomposed `buildPrefix`**

Replace the body between the existing imports/`PrefixBuildContext` (unchanged) and end-of-file with:

```typescript
/** Shared section joiner — the exact prefix-builder.ts:167 string, single definition (§D1). */
export const SECTION_JOINER = "\n\n---\n\n";

// ── Section helpers (KPR-349 §D1) ──────────────────────────────────
// Each returns the rendered section or null-to-omit. Extracted verbatim from
// buildPrefix (KPR-213 shape); the golden suite (prefix-builder.golden.test.ts)
// pins byte-identity of the recomposition. Both lanes compose these — Claude
// via buildPrefix (below), Lane B via buildProviderInstructions (§D1/§D3).

export function soulSection(agentConfig: AgentConfig): string | null {
  return agentConfig.soul ? agentConfig.soul : null;
}

/** Archetype card. Catch-and-omit posture unchanged (prefix-builder.ts:71-89).
 *  The `archetypeDef && archetypeConfig` conjunction short-circuits before the
 *  card is attempted — golden G5 pins that branch. */
export function archetypeCardSection(agentConfig: AgentConfig): string | null {
  const archetypeDef = agentConfig.archetype ? getArchetype(agentConfig.archetype) ?? null : null;
  if (!archetypeDef || !agentConfig.archetypeConfig) return null;
  try {
    const card = archetypeDef.systemPromptCard({
      agentConfig,
      archetypeConfig: agentConfig.archetypeConfig,
    });
    return card ? card : null;
  } catch (err) {
    log.error("Archetype systemPromptCard threw — omitting card", {
      agent: agentConfig.id,
      archetype: agentConfig.archetype,
      error: String(err),
    });
    return null;
  }
}

export function systemPromptSection(agentConfig: AgentConfig): string {
  return agentConfig.systemPrompt;
}

/** Constitution — read-miss falls through (memoryManager.read returns null). */
export async function constitutionSection(memoryManager: MemoryManager): Promise<string | null> {
  return await memoryManager.read("shared/constitution.md");
}

/** KPR-139 team summary — warn-and-omit posture unchanged. */
export async function teamSummarySection(agentId: string, teamRoster?: TeamRoster): Promise<string | null> {
  if (!teamRoster) return null;
  try {
    const teamSummary = await teamRoster.teamSummary();
    return teamSummary ? teamSummary : null;
  } catch (err) {
    log.warn("teamSummary failed; omitting from prompt", { agent: agentId, error: String(err) });
    return null;
  }
}

/** KPR-327 static file-tier guidance text, verbatim (prefix-builder.ts:137-141). */
export function fileTierMemoryGuidance(): string {
  return (
    "## File-Tier Memory\n" +
    "You have a file-tier memory at `/memories` (tools: view, create, str_replace, insert, delete, rename). " +
    "Your hot-tier memory is already injected in this prompt — do **not** re-`view` files to rediscover what's already here. " +
    "`view` file-tier paths when a task needs detail beyond the hot tier, and record durable file-worthy material there."
  );
}

export interface MemorySectionsOptions {
  /**
   * §D3/§D5 tool-claim gate. False strips the two tool-instruction lines
   * embedded in the memory block (the hot-tier `memory_recall` trailer's
   * imperative sentence and the legacy file-listing's "via the memory MCP
   * server (`view`)" sentence) — memory CONTENT is never gated. The Claude
   * lane always passes true, so buildPrefix output is unchanged.
   */
  toolsExecutable: boolean;
  /**
   * §D5 naming-mismatch, option (a): a tool-executing Lane B render passes
   * the bridged name "mcp__structured-memory__memory_recall" so the trailer
   * names the tool the model can actually call. Omitted (Claude lane) ⇒
   * bare "memory_recall", byte-identical to pre-349 (golden-pinned).
   * Ignored when toolsExecutable is false.
   */
  recallToolName?: string;
}

export interface MemorySectionsResult {
  /** Rendered block(s) in prompt order: [hotTier] OR [legacy memory.md?, file listing?]. */
  blocks: string[];
  /**
   * Raw hot-tier block (present iff the hot tier rendered) — returned
   * alongside blocks so assembly can populate ProviderMemoryBundle without
   * a second Mongo read. SINGLE-INJECTION: this exact string is already in
   * `blocks` (and therefore in the composed instructions) — consumers must
   * never fold it in again.
   */
  hotTierPrompt?: string;
}

/**
 * Hot-tier injection with legacy memory.md + file-listing fallback —
 * extracted from prefix-builder.ts:146-165, logic and budget identical on
 * both lanes (§D5).
 */
export async function memorySections(
  memoryManager: MemoryManager,
  agentId: string,
  opts: MemorySectionsOptions,
): Promise<MemorySectionsResult> {
  const hotTierPrompt = await memoryManager.getHotTierPrompt(
    agentId,
    config.memory.hotBudgetTokens,
    opts.toolsExecutable
      ? opts.recallToolName !== undefined
        ? { recallToolName: opts.recallToolName }
        : undefined // Claude lane: two-arg call shape, bytes untouched
      : { recallToolName: null }, // gated: reworded count-only trailer (§D5)
  );
  if (hotTierPrompt) {
    return { blocks: [hotTierPrompt], hotTierPrompt };
  }
  const blocks: string[] = [];
  const memoryDir = `agents/${agentId}`;
  const memory = await memoryManager.read(`${memoryDir}/memory.md`);
  if (memory) {
    blocks.push(`## Your Memory\n${memory}`);
  }
  const memoryFiles = await memoryManager.list(memoryDir);
  const mdFiles = memoryFiles.filter((f) => f.endsWith(".md") && f !== "memory.md");
  if (mdFiles.length > 0) {
    const listing =
      `## Available Memory Files\nYou have ${mdFiles.length} reference file(s) in your memory directory:\n` +
      mdFiles.map((f) => `- /memories/${memoryDir}/${f}`).join("\n");
    blocks.push(
      opts.toolsExecutable
        ? listing +
            `\n\nRead relevant files via the memory MCP server (\`view\`) before starting tasks that may relate to them.`
        : listing, // §D3/§D5: paths stay, the tool-instruction sentence goes
    );
  }
  return { blocks };
}

/**
 * Datetime trailer — the ONE definition both lanes append last
 * (agent-runner.ts:376-378 format string, verbatim). Kept out of buildPrefix
 * so the KPR-213 cache never holds a timestamp.
 */
export function formatDateTimeTrailer(now: Date = new Date()): string {
  const pacific = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `**Current date/time**: ${pacific} (Pacific Time)`;
}

/**
 * Build the cacheable prefix for an agent. Signature and output UNCHANGED
 * (KPR-349 golden gate) — now a composition of the exported helpers.
 * Layer order: soul → archetype card → systemPrompt → constitution →
 * team summary → toolkit → file-tier guidance → hot-tier/legacy memory.
 */
export async function buildPrefix(agentConfig: AgentConfig, ctx: PrefixBuildContext): Promise<string> {
  const parts: string[] = [];

  const soul = soulSection(agentConfig);
  if (soul) parts.push(soul);

  const card = archetypeCardSection(agentConfig);
  if (card) parts.push(card);

  parts.push(systemPromptSection(agentConfig));

  const constitution = await constitutionSection(ctx.memoryManager);
  if (constitution) parts.push(constitution);

  const teamSummary = await teamSummarySection(agentConfig.id, ctx.teamRoster);
  if (teamSummary) parts.push(teamSummary);

  // KPR-87 Claude toolkit — buildToolkitSection call unchanged (golden-gated).
  parts.push(
    buildToolkitSection({
      coreServerNames: ctx.coreServerNames,
      delegateServerNames: ctx.activeDelegateNames,
      plugins: ctx.plugins,
      autoInjectedServers: ctx.autoInjectedServers,
      deferredLoadingActive: resolveToolSearchMode(agentConfig.toolSearch, config.toolSearch.mode).mode !== "off",
    }),
  );

  // KPR-327 guidance gate — keyed on coreServerNames, unchanged.
  if (ctx.coreServerNames.includes("memory")) {
    parts.push(fileTierMemoryGuidance());
  }

  // Claude lane always has tools: toolsExecutable true, bare recall name.
  const memory = await memorySections(ctx.memoryManager, agentConfig.id, { toolsExecutable: true });
  parts.push(...memory.blocks);

  return parts.join(SECTION_JOINER);
}
```

Preserve the file's header doc comment and every existing import (all still used). Note the KPR-329 comment block that annotated the inline toolkit call (`prefix-builder.ts:122-125`) is retained at the call site inside `buildPrefix`, and the KPR-327 comment block (`:129-134`) moves onto `fileTierMemoryGuidance`.

**Forward-compat note for Task 2:** `memorySections` already passes an options argument to `getHotTierPrompt`. Until Task 2 lands the memory-manager change, the extra argument is ignored at runtime by the current two-param signature — but TypeScript will reject the call. Therefore **Steps 1.1 and 1.2 of Task 2's memory-manager edit may NOT be reordered after this commit's `npm run check`**… instead, keep this chunk self-contained: include the small `getHotTierPrompt` signature extension in THIS commit (Step 1.2 below) with the default behavior byte-identical. The trailer *variants* (qualified/gated text) are still Task 2's; here only the parameter plumbing lands.

- [ ] **Step 1.2: `src/memory/memory-manager.ts` — `getHotTierPrompt` gains the optional trailer knob (default = today's bytes)**

At `memory-manager.ts:73`, extend the signature and the trailer push (`:118-123`):

```typescript
  async getHotTierPrompt(
    agentId: string,
    budgetTokens: number,
    opts?: {
      /**
       * KPR-349 (§D5): the tool name the warm/cold trailer teaches, or null
       * to render the reworded count-only trailer (tool-claim gate for
       * non-executing Lane B providers). Undefined ⇒ "memory_recall" —
       * byte-identical to pre-349 output (Claude lane, golden-pinned).
       */
      recallToolName?: string | null;
    },
  ): Promise<string | null> {
```

and replace the trailer push:

```typescript
    const warmColdCount = await this._memoryStore.countNonHot(agentId);
    if (warmColdCount > 0) {
      const recallToolName = opts?.recallToolName === undefined ? "memory_recall" : opts.recallToolName;
      parts.push(
        recallToolName === null
          ? // §D5 gated variant (KPR-349 final-gate ruling): reworded, count
            // stays, imperative tool sentence gone — NOT a naive line-drop
            // of the fused sentence.
            `---\nYou have ${warmColdCount} additional memories.`
          : `---\nYou have ${warmColdCount} additional memories available via \`${recallToolName}\`. Use it to search for context before starting tasks.`,
      );
    }
```

Everything else in the method untouched. Existing callers (`prefix-builder.ts` via `memorySections` with undefined opts, reflection paths if any) hit the `undefined ⇒ "memory_recall"` default — output byte-identical; existing `memory-manager.test.ts` assertions pass unmodified.

- [ ] **Step 1.3: `src/agents/agent-runner.ts` — `buildSystemPrompt` composes the shared trailer**

Replace `agent-runner.ts:374-378` (the inline datetime block) with:

```typescript
    // Date/time last — changes every minute, so placing it at the end
    // preserves the static prefix for prompt caching. Single definition
    // shared with Lane B (KPR-349 §D1: the two lanes cannot drift).
    return `${prefix}${SECTION_JOINER}${formatDateTimeTrailer()}`;
```

Add `SECTION_JOINER, formatDateTimeTrailer` to the existing `prefix-builder.js` import in `agent-runner.ts`. Cache read-through (`:370-372`) untouched.

- [ ] **Step 1.4: Negative-verify the golden gate (mandatory, recorded)**

Temporarily weaken `memorySections`: delete the `\n\nRead relevant files via the memory MCP server…` concatenation (make the `toolsExecutable: true` branch return bare `listing`). Run:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/prefix-builder.golden.test.ts
```

Expected: **only the G9 snapshot FAILS** (trailer sentence missing). G12 stays green: its `memoryManager.getHotTierPrompt` mock resolves `HOT_TIER_FIXTURE` (non-null), so `memorySections` returns on the hot-tier branch and never reaches the legacy-file-listing code this perturbation touches — G12 exercises the hot-tier trailer (`memory_recall`), not the legacy-fallback sentence, so it is unaffected by this specific weakening. Record the failing output (G9 only) in the PR description under "negative-verify: byte-parity gate". Restore the line; re-run; green.

- [ ] **Step 1.5: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0. **Zero snapshot churn** (`git status` shows no change to `__snapshots__/`); `prefix-builder.test.ts`, `prefix-cache.test.ts`, `prefix-invalidation.test.ts`, `memory-manager.test.ts` all green unmodified.

```bash
git add src/agents/prefix-builder.ts src/agents/agent-runner.ts src/memory/memory-manager.ts
git commit -m "KPR-349: extract shared prompt section helpers — buildPrefix recomposed byte-identical under golden gate"
```

---

## Task 2 (Chunk 2): Lane B builder — `buildProviderInstructions`, provider toolkit, skill derivation

**Files:**
- Modify: `src/agents/prefix-builder.ts` (add `buildProviderInstructions` + skills section)
- Modify: `src/agents/toolkit-section.ts` (add `buildProviderToolkitSection`)
- Create: `src/agents/provider-adapters/skill-index.ts`
- Create: `src/agents/provider-adapters/skill-index.test.ts` (T4)
- Create: `src/agents/prefix-builder.provider.test.ts` (T2)
- Modify (additive): `src/agents/toolkit-section.test.ts` (T3), `src/memory/memory-manager.test.ts` (trailer variants)

Everything in this chunk is exported-but-unwired (the seam swap is Task 3), so the chunk is check-green by construction and the goldens cannot move (no Claude-path file is touched).

- [ ] **Step 2.1: `src/agents/prefix-builder.ts` — add the Lane B composition**

Add these imports (type-only where marked — no runtime cycle: `turn-assembly.ts` never imports `prefix-builder.ts`; the runner mediates):

```typescript
import type { HiveToolInventoryEntry } from "./provider-adapters/tool-transport.js";
import type { ProviderSkillIndexEntry } from "./provider-adapters/turn-assembly.js";
import { buildProviderToolkitSection } from "./toolkit-section.js";
```

Append at end of file:

```typescript
// ── Lane B composition (KPR-349 §D1/§D3) ───────────────────────────

export interface ProviderInstructionsInput {
  /** Partitioned bridgeable inventory (assembly.toolInventory). */
  toolInventory: HiveToolInventoryEntry[];
  /** Derived skill index (§D6) — skills section renders iff non-empty AND toolsExecutable. */
  skillIndex: ProviderSkillIndexEntry[];
  /**
   * §D3 honesty gate, delivered as a PLAIN BOOLEAN — the provider set
   * (TOOL_EXECUTING_PROVIDERS) lives at the assembly seam, never here.
   * Gates: toolkit, file-tier guidance, skills section, and the two
   * tool-instruction lines inside the memory block (memorySections).
   */
  toolsExecutable: boolean;
  memoryManager: MemoryManager;
  teamRoster?: TeamRoster;
  plugins: LoadedPlugin[];
}

export interface ProviderInstructionsResult {
  /** Full Lane B instruction text, datetime last (provider prompt caching is prefix-based too). */
  instructions: string;
  /** Raw hot-tier block → assembly.memory.hotTierPrompt. Single-injection: already folded into instructions. */
  hotTierPrompt?: string;
}

/** §D6 skills section — mirrors the SDK's function (index in context, content on demand), not its bytes. */
export function skillsSection(skillIndex: ProviderSkillIndexEntry[]): string {
  return (
    "## Your skills\n" +
    "Named procedures for specific jobs. When a task matches one, call load_skill with its name FIRST and follow the returned instructions.\n" +
    skillIndex.map((s) => `- ${s.name} — ${s.description}`).join("\n")
  );
}

/**
 * Lane B instructions: the SAME section helpers as buildPrefix, minus
 * Claude-specific fragments, plus the inventory-rendered toolkit and the
 * skills section. Layer order (spec G2, † = gated by toolsExecutable):
 * soul → archetype card → systemPrompt → constitution → team summary →
 * †toolkit → †file-tier guidance (iff memory entry in inventory) →
 * †skills (iff index non-empty) → hot-tier/legacy memory (interior
 * tool-claim lines separately gated) → datetime trailer.
 */
export async function buildProviderInstructions(
  agentConfig: AgentConfig,
  input: ProviderInstructionsInput,
): Promise<ProviderInstructionsResult> {
  const parts: string[] = [];

  const soul = soulSection(agentConfig);
  if (soul) parts.push(soul);

  const card = archetypeCardSection(agentConfig);
  if (card) parts.push(card);

  parts.push(systemPromptSection(agentConfig));

  const constitution = await constitutionSection(input.memoryManager);
  if (constitution) parts.push(constitution);

  const teamSummary = await teamSummarySection(agentConfig.id, input.teamRoster);
  if (teamSummary) parts.push(teamSummary);

  if (input.toolsExecutable) {
    parts.push(buildProviderToolkitSection({ toolInventory: input.toolInventory, plugins: input.plugins }));
    // §D1: guidance keyed on the INVENTORY (same predicate spirit as the
    // Claude lane's coreServerNames check — prefix-builder.ts:135 — but the
    // inventory is Lane B's source of truth for what is actually bridged).
    if (input.toolInventory.some((e) => e.name === "memory")) {
      parts.push(fileTierMemoryGuidance());
    }
    if (input.skillIndex.length > 0) {
      parts.push(skillsSection(input.skillIndex));
    }
  }

  const memory = await memorySections(input.memoryManager, agentConfig.id, {
    toolsExecutable: input.toolsExecutable,
    // §D5 option (a): the bridged tool name — the model-visible name of the
    // structured-memory server's memory_recall tool on every Lane B bridge.
    recallToolName: input.toolsExecutable ? "mcp__structured-memory__memory_recall" : undefined,
  });
  parts.push(...memory.blocks);

  parts.push(formatDateTimeTrailer());

  return { instructions: parts.join(SECTION_JOINER), hotTierPrompt: memory.hotTierPrompt };
}
```

- [ ] **Step 2.2: `src/agents/toolkit-section.ts` — add `buildProviderToolkitSection` (§D4)**

Add imports at top: `import type { HiveToolInventoryEntry } from "./provider-adapters/tool-transport.js";` (type-only, erased — no runtime cycle: `tool-transport.ts` does not import `toolkit-section.ts`). Append at end of file (reuses the module-private `resolveCatalogEntry`/`formatToolkitLine` directly — no export changes; `buildToolkitSection` body untouched):

```typescript
// ── Lane B toolkit (KPR-349 §D4) ───────────────────────────────────

/** Per-tool blurbs for the six executor-backed builtins (spec §D4 — the
 *  Claude compound lines split per tool; wording per SDK_BUILTINS above). */
const PROVIDER_BUILTIN_BLURBS: Record<string, string> = {
  Bash: "run shell commands",
  Read: "read files",
  Write: "write files",
  Edit: "edit files (exact string replacement)",
  Glob: "find files by pattern",
  Grep: "search file contents",
};

export interface ProviderToolkitInput {
  /** PARTITIONED inventory (assembly.toolInventory) — claude-only and
   *  claude-subagent entries never reach this function by construction. */
  toolInventory: HiveToolInventoryEntry[];
  plugins: LoadedPlugin[];
}

/**
 * Render the Lane B toolkit from the bridged inventory so the model's
 * tool-selection surface stays honest (epic §D5):
 *  - Built-in: only static-schema claude-builtin survivors (the six executor
 *    tools) — per-tool lines; WebFetch/WebSearch/NotebookEdit/TodoWrite/Task
 *    are partition-omitted and can never appear.
 *  - Engine-provided / Capability: MCP entries grouped by `source`
 *    (engine → engine-provided; core/plugin → capability), one line per
 *    SERVER (the bridge exposes tools as mcp__<server>__<tool>, so
 *    server-level listing stays truthful).
 *  - Omitted: delegated-MCPs section, deferred-loading hint (Claude-CLI
 *    mechanisms). Header/"try them" framing reused verbatim.
 * Known honesty limit (§D4, matrix note): renders at assembly time, before
 * connect() — a connect-time fail-soft omission is still listed;
 * runtimeOmissions is the honest record.
 */
export function buildProviderToolkitSection(input: ProviderToolkitInput): string {
  const builtinLines: string[] = [];
  const engineLines: string[] = [];
  const capabilityLines: string[] = [];

  for (const entry of input.toolInventory) {
    if (entry.transport === "claude-builtin") {
      if (entry.schemas.kind !== "static") continue; // partition guarantees; belt-and-suspenders
      for (const def of entry.schemas.tools) {
        builtinLines.push(`- ${def.name} — ${PROVIDER_BUILTIN_BLURBS[def.name] ?? def.description}`);
      }
      continue;
    }
    if (
      entry.transport === "stdio" ||
      entry.transport === "http" ||
      entry.transport === "sse" ||
      entry.transport === "sdk-in-process"
    ) {
      const line = formatToolkitLine(entry.name, resolveCatalogEntry(entry.name, input.plugins));
      if (entry.source === "engine") {
        engineLines.push(line);
      } else {
        capabilityLines.push(line);
      }
    }
    // claude-subagent: unreachable post-partition — deliberately no rendering.
  }

  const sections: string[] = [];
  sections.push(
    "## Your toolkit\n\n" +
      "You have access to the following tools this session. Try them; don't guess at availability.",
  );
  if (builtinLines.length > 0) {
    sections.push(`### Built-in (always available)\n${builtinLines.join("\n")}`);
  }
  if (engineLines.length > 0) {
    sections.push("### Engine-provided (always available to every agent)\n" + engineLines.join("\n"));
  }
  if (capabilityLines.length > 0) {
    sections.push("### Capability MCPs (provisioned for your role)\n" + capabilityLines.join("\n"));
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 2.3: Create `src/agents/provider-adapters/skill-index.ts` (§D6)**

```typescript
/**
 * KPR-349 (spec §D6): derive the Lane B skill index from the agent's
 * already-scoped SDK plugin list (getSkillsForAgent output — agent-scoped,
 * universal-merged, dedup'd, customer-shadowed upstream). Per-skill
 * fail-soft: one bad SKILL.md must never TurnAssemblyError the turn.
 *
 * name = skill DIRECTORY name (the loader's scoping unit and the bridge's
 * lookup key — frontmatter `name` may drift and is ignored).
 * description = frontmatter description, falling back to the name.
 * path = absolute realpath of SKILL.md (projection symlinks pre-resolved).
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import { readSkillMd } from "../../skills/frontmatter.js";
import type { ProviderSkillIndexEntry } from "./turn-assembly.js";

const log = createLogger("provider-skill-index");

export function deriveProviderSkillIndex(sdkPlugins: SdkPluginConfig[]): ProviderSkillIndexEntry[] {
  const entries: ProviderSkillIndexEntry[] = [];
  const seen = new Set<string>();
  for (const plugin of sdkPlugins) {
    const skillsDir = join(plugin.path, "skills");
    let dirNames: string[];
    try {
      dirNames = readdirSync(skillsDir);
    } catch {
      // Plugin without a skills/ dir (or torn down concurrently) — skip
      // silently; projection layout guarantees the shape for real skills.
      continue;
    }
    for (const name of dirNames) {
      try {
        const skillMdPath = join(skillsDir, name, "SKILL.md");
        if (!existsSync(skillMdPath)) continue; // stray file/non-skill dir
        if (seen.has(name)) {
          // First-wins, matching the bridge's Map construction (tool-bridge.ts).
          log.warn("Duplicate skill name in provider index — first entry wins", { skill: name });
          continue;
        }
        const { frontmatter } = readSkillMd(skillMdPath);
        seen.add(name);
        entries.push({
          name,
          description: frontmatter.description || name,
          path: realpathSync(skillMdPath),
        });
      } catch (err) {
        // Per-skill fail-soft (mirrors skill-loader's per-agent posture).
        log.warn("Skill unreadable/unparseable — omitted from provider index", {
          skill: name,
          error: String(err),
        });
      }
    }
  }
  return entries;
}
```

- [ ] **Step 2.4: Create `src/agents/provider-adapters/skill-index.test.ts` (T4)**

Fixture tree built in a per-test tmpdir (`fs.mkdtempSync(join(tmpdir(), "kpr349-skills-"))`; use the scratchpad-safe OS tmpdir — vitest cleans via `afterEach` rm). Cases (each a named `it`):

  - [ ] plain plugin (`<dir>/skills/greet/SKILL.md` with frontmatter `name: greet-skill-drifted`, `description: Say hello`) → one entry `{name: "greet", description: "Say hello", path: <realpath>}` — dir name wins over drifted frontmatter name
  - [ ] multi-skill plugin (two skill dirs) → both entries (loop tolerates many per plugin)
  - [ ] empty `description:` frontmatter → description falls back to the skill name
  - [ ] corrupt SKILL.md (no frontmatter delimiters at all) → entry skipped, `deriveProviderSkillIndex` does NOT throw, other entries intact
  - [ ] plugin path with no `skills/` dir → skipped silently, no throw
  - [ ] duplicate skill name across two plugins → first wins (assert first plugin's description), one entry total
  - [ ] symlinked skill dir (symlink `skills/linked` → a real dir elsewhere in the tmpdir) → `path` is the realpath (assert `path` does not contain the symlink segment)
  - [ ] empty plugin list → `[]`

- [ ] **Step 2.5: `src/memory/memory-manager.test.ts` — trailer variant assertions (additive)**

In the existing `MemoryManager.getHotTierPrompt` describe (`memory-manager.test.ts:95`), using its existing store fixtures with `countNonHot` > 0, add:

  - [ ] default (no opts): trailer is exactly `` `---\nYou have ${n} additional memories available via \`memory_recall\`. Use it to search for context before starting tasks.` `` — pins pre-349 bytes explicitly (belt-and-suspenders under the goldens)
  - [ ] `{recallToolName: "mcp__structured-memory__memory_recall"}`: trailer names the qualified tool, zero occurrences of `` `memory_recall` `` as a bare backticked token (assert `not.toContain("` + "`memory_recall`" + `")` — the qualified name contains the substring, so assert on the backticked form)
  - [ ] `{recallToolName: null}`: trailer is exactly `` `---\nYou have ${n} additional memories.` ``; output contains zero occurrences of `memory_recall` and zero of `Use it to search`
  - [ ] `countNonHot === 0`: no trailer under any opts variant

- [ ] **Step 2.6: Create `src/agents/prefix-builder.provider.test.ts` (T2)**

Same mock scaffolding as the golden file (logger + config partial mock, `makeAgentConfig`, `makeMemoryManager`; archetype registry fixtures where needed). Inventory fixture helpers build minimal `HiveToolInventoryEntry` objects (mirror `makeEntry` in `turn-assembly.test.ts`). Required cases:

**Composition / order:**
  - [ ] full-fixture assembly (`toolsExecutable: true`, memory + skills + toolkit inputs): section order asserted by index — soul < archetype card < systemPrompt < constitution < team summary < `## Your toolkit` < `## File-Tier Memory` < `## Your skills` < `## Your Memory` < `**Current date/time**`; output matches `/\*\*Current date\/time\*\*: .+ \(Pacific Time\)$/` (datetime last, format identical to the Claude trailer — same helper)
  - [ ] joiner: sections separated by `\n\n---\n\n` (count of joiners = sections − 1 on a fixed fixture)
  - [ ] bare-bones agent (`soul: ""`, no constitution/roster/memory, `toolsExecutable: false`): instructions = systemPrompt + datetime only; never contains `You are ` fallback (that died with `buildPilotInstructions`)

**† gate (G4):**
  - [ ] `toolsExecutable: false` (same rich inputs): NO `## Your toolkit`, NO `## File-Tier Memory`, NO `## Your skills`; constitution/roster/memory content still present
  - [ ] `toolsExecutable: true` but empty skill index: no skills section
  - [ ] `toolsExecutable: true`, no `memory` entry in inventory: no file-tier guidance (hot-tier block still renders — injection is memoryManager-side)

**Memory tool-claim gate (blocking round-1 finding, §D3/§D5):**
  - [ ] `toolsExecutable: false`, `getHotTierPrompt` mock returns the gated fixture (mock honors the opts contract: when called with `{recallToolName: null}` returns a block ending `---\nYou have 7 additional memories.`): rendered instructions contain **zero** occurrences of `memory_recall`, **zero** of `memory MCP server`, while record lines (`Golden fact`), the count line `You have 7 additional memories.`, and — in the legacy-fallback variant — the `/memories/agents/<id>/…` file paths all still render. **Implementation note:** to make the mock honest, assert the opts value the builder passed: `expect(mm.getHotTierPrompt).toHaveBeenCalledWith("golden-agent", 3000, { recallToolName: null })`.
  - [ ] `toolsExecutable: true` mirror: `expect(mm.getHotTierPrompt).toHaveBeenCalledWith("golden-agent", 3000, { recallToolName: "mcp__structured-memory__memory_recall" })` — **this is the option-(a) assertion the spec's final gate requires**; and the legacy-fallback variant contains `Read relevant files via the memory MCP server (\`view\`)`
  - [ ] legacy fallback gated: `toolsExecutable: false`, hot tier null, memory.md + files → file listing paths present, trailer sentence absent

**Toolkit honesty:**
  - [ ] Lane B toolkit output contains none of: `WebFetch`, `WebSearch`, `NotebookEdit`, `TodoWrite`, `Task`, `Delegated capability`
  - [ ] `skillsSection` unit: exact header + teaching sentence + `- name — description` lines

**Fault posture:**
  - [ ] `getHotTierPrompt` mock rejects → `buildProviderInstructions` rejects (throw escapes the builder — assembly's try classifies it; parity with the Claude lane where the same rejection fails `buildSystemPrompt`)
  - [ ] constitution read returning null and teamSummary throwing → omit-and-continue, no throw

- [ ] **Step 2.7: `src/agents/toolkit-section.test.ts` — T3 (additive describe)**

Fixture inventory: entries for `contacts` (sdk-in-process, source core), `keychain` (stdio, source core), `slack` (http, source engine — planted in autoInjected-equivalent source), `golden-plugin-server` (stdio, source plugin, plugin manifest carries description), six static claude-builtin entries (schemas `{kind:"static", tools:[{name, description, inputSchema}]}` — reuse `BUILTIN_TOOL_DEFINITIONS` from `builtin-executor.js` for realism), plus one claude-builtin `{kind:"unavailable"}` entry (WebFetch — simulating a partition leak) and one `claude-subagent` entry. Assert:

  - [ ] header + "Try them; don't guess" present
  - [ ] `### Built-in (always available)` lists exactly `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` as per-tool lines (`- Bash — run shell commands` exact)
  - [ ] `WebFetch` absent (unavailable-schema builtin skipped); claude-subagent entry renders nothing
  - [ ] `### Engine-provided` contains `slack` line; `### Capability MCPs` contains `contacts`, `keychain`, and `golden-plugin-server` with the plugin-manifest description (catalog fallthrough works)
  - [ ] no `### Delegated capability MCPs`, no deferred-loading hint string anywhere
  - [ ] empty inventory → header + no subsections
  - [ ] existing `buildToolkitSection` tests in the file: **zero edits**

- [ ] **Step 2.8: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0; goldens untouched (no snapshot churn).

```bash
git add src/agents/prefix-builder.ts src/agents/prefix-builder.provider.test.ts src/agents/toolkit-section.ts src/agents/toolkit-section.test.ts src/agents/provider-adapters/skill-index.ts src/agents/provider-adapters/skill-index.test.ts src/memory/memory-manager.test.ts
git commit -m "KPR-349: Lane B instruction builder — provider toolkit, skill-index derivation, memory tool-claim gate"
```

---

## Task 3 (Chunk 3): Seam swap — `TOOL_EXECUTING_PROVIDERS`, populate memory/skillIndex, delete the pilot stub

**Files:**
- Modify: `src/agents/agent-runner.ts` (new `buildProviderPrompt` method)
- Modify: `src/agents/provider-adapters/turn-assembly.ts`
- Modify: `src/agents/provider-adapters/turn-assembly.test.ts` (pins inverted + T7 + T1 spy)
- Modify (additive): `src/agents/provider-adapters/tool-bridge.test.ts` (T5 + T6)
- Modify (additive): `src/agents/agent-runner.test.ts` (T1 Claude-lane + Lane B cache spies)
- Modify (comment-only): `src/agents/agent-manager.ts` — reword the stale `buildPilotInstructions` comment at `:503`; no functional change (see Step 3.2b)
- Modify: `src/agents/provider-adapters/openai-agents-adapter.test.ts` — invert the KPR-347 byte-identity pin (Step 3.4)
- Modify: `src/agents/provider-adapters/gemini-adk-adapter.test.ts` — same inversion (Step 3.4)
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.test.ts` — same inversion (Step 3.4)

- [ ] **Step 3.1: `src/agents/agent-runner.ts` — public `buildProviderPrompt` (the 348 pattern)**

Add imports: `buildProviderInstructions` from `./prefix-builder.js` (extend the existing import), `deriveProviderSkillIndex` from `./provider-adapters/skill-index.js`, and type `ProviderSkillIndexEntry` from `./provider-adapters/turn-assembly.js`. Insert the method beside `buildInProcessServers`/`resolveTurnCwd`:

```typescript
  /**
   * KPR-349 (spec §D1): assemble the Lane B instruction prompt — public
   * method following the KPR-348 precedent (buildInProcessServers /
   * resolveTurnCwd) so the runner's private memoryManager / teamRoster /
   * plugins / skillIndex stay private. Thin: derives the skill entries
   * (§D6) from the SAME agent-scoped SDK plugin list the Claude lane passes
   * to query() (buildNativeSkills), then delegates to the shared builder.
   *
   * toolsExecutable arrives as a plain boolean — the provider set
   * (TOOL_EXECUTING_PROVIDERS) lives at the assembly seam (§D3), and
   * prefix-builder carries no per-provider branches by design.
   *
   * UNCACHED by ruling (spec §D2): never touches PrefixCache — Lane B
   * rebuilds per spawn (per-spawn adapters, construction-time ≡ turn-time).
   */
  async buildProviderPrompt(opts: {
    toolInventory: HiveToolInventoryEntry[];
    toolsExecutable: boolean;
  }): Promise<{ instructions: string; hotTierPrompt?: string; skillEntries: ProviderSkillIndexEntry[] }> {
    const skillEntries = deriveProviderSkillIndex(this.buildNativeSkills());
    const result = await buildProviderInstructions(this.agentConfig, {
      toolInventory: opts.toolInventory,
      skillIndex: skillEntries,
      toolsExecutable: opts.toolsExecutable,
      memoryManager: this.memoryManager,
      teamRoster: this.teamRoster,
      plugins: this.plugins,
    });
    return { instructions: result.instructions, hotTierPrompt: result.hotTierPrompt, skillEntries };
  }
```

(`buildNativeSkills` is the existing private at `agent-runner.ts:1664-1666` — unchanged.)

- [ ] **Step 3.2: `src/agents/provider-adapters/turn-assembly.ts` — the swap**

1. Delete `buildPilotInstructions` (`:83-86`) and its doc comment — last caller gone.
2. Add beside `SESSION_SEMANTICS`-style constants (top-level, after imports):

```typescript
/**
 * KPR-349 (§D3): tool-honesty gate. Only providers whose adapters actually
 * execute bridged tools get tool-dependent prompt sections (toolkit,
 * file-tier guidance, skills) and the memory block's tool-instruction
 * lines. KPR-352/353 each add their provider IN THE SAME COMMIT that flips
 * their adapter's zero-tools stub — the set and the flip are one review
 * surface (same one-line-per-provider growth pattern as SESSION_SEMANTICS).
 * Delete-candidate once all three Lane B providers execute tools.
 */
export const TOOL_EXECUTING_PROVIDERS: ReadonlySet<LaneBProviderId> = new Set(["openai"]);
```

3. Replace the try body's step 1 (`:130`) and the return (`:147-156`):

```typescript
  try {
    const inventory = input.runner.buildToolTransportInventory(input.workItemContext);
    const { bridgeable, omitted } = partitionInventoryForProvider(inventory, input.provider);
    // R3 honesty surface: once per spawn, names + compatibility reasons ONLY
    // (never configs). The operator's day-1 answer to "why doesn't my
    // reassigned agent have X" until the parity matrix ships (child 10).
    log.info("Lane B inventory partition", {
      agentId: input.config.id,
      provider: input.provider,
      bridgeable: bridgeable.length,
      omitted: omitted.map((o) => `${o.name}:${o.compatibility}`),
    });
    // KPR-349 (§D1/§D3): the real system prompt — shared section helpers via
    // the runner; skill derivation + memory fold-in run INSIDE this try, so
    // a Mongo blip classifies non-provider (§D9, T7).
    const toolsExecutable = TOOL_EXECUTING_PROVIDERS.has(input.provider);
    const { instructions, hotTierPrompt, skillEntries } = await input.runner.buildProviderPrompt({
      toolInventory: bridgeable,
      toolsExecutable,
    });
    const guardrailGate = buildDefaultGuardrailGate(input.config, input.workItemContext);
    // KPR-348 (§D4): *ContextRef.current is set here with the turn's context —
    // per-spawn adapters make construction-time ≡ turn-time (canon 4).
    const inProcessServers = input.runner.buildInProcessServers(input.workItemContext);
    const sessionCwd = input.runner.resolveTurnCwd(input.workItemContext);
    return {
      instructions,
      toolInventory: bridgeable,
      omittedTools: omitted,
      guardrailGate,
      memory: hotTierPrompt === undefined ? {} : { hotTierPrompt },
      skillIndex: skillEntries,
      inProcessServers,
      sessionCwd,
    };
  } catch (err) {
    // (unchanged TurnAssemblyError wrap)
```

4. Doc-comment refresh (additive refinement only — no field shape changes, per 347 canon):
   - `ProviderTurnAssembly.instructions` (`:52-58`): now reads "Assembled system instructions — KPR-349: full Lane B prompt from the shared section helpers (soul → … → datetime), tool-dependent sections gated by TOOL_EXECUTING_PROVIDERS."
   - `ProviderMemoryBundle.hotTierPrompt` (`:30-33`): append the single-injection rule — "SINGLE-INJECTION: this block is already folded into `instructions`; adapters and future consumers (KPR-350 replay bookkeeping reads it, never re-injects) must not fold it in again."
   - `skillIndex` comment `// [] until KPR-349` → `// derived per spawn (skill-index.ts §D6); non-empty index lights up the bridge's load_skill`.
   - `memory` comment `// {} until KPR-349` → `// {hotTierPrompt} when the agent's hot tier rendered`.
   - The file-header comment (`:1-8`): update the "KPR-349 swaps…" sentence to past tense.

- [ ] **Step 3.2b: `src/agents/agent-manager.ts` — reword the stale comment (comment-only, no functional change)**

`createProviderAdapter`'s existing comment at `agent-manager.ts:501-504` names the just-deleted `buildPilotInstructions`:

```typescript
    // KPR-347 (§D5): Lane B per-spawn assembly — real inventory through the
    // compatibility partition; instructions byte-identical to the pre-347
    // buildPilotInstructions output. Assembly throws are TurnAssemblyError
    // (classifies non-provider inside the caller's recorded try).
```

Reword the middle two lines to describe what actually renders post-349 — no other line in this method changes, no call-site/argument/control-flow edit:

```typescript
    // KPR-347 (§D5): Lane B per-spawn assembly — real inventory through the
    // compatibility partition; KPR-349: instructions are the real prompt from
    // buildProviderInstructions (via the runner's buildProviderPrompt),
    // assembled inside assembleProviderTurn. Assembly throws are
    // TurnAssemblyError (classifies non-provider inside the caller's
    // recorded try).
```

This is the one authorized edit to `agent-manager.ts` in this ticket — a comment reword, not a functional/seam change. It resolves the otherwise-unsatisfiable pair of Task 6 checks (§6.2): the grep for `buildPilotInstructions` returning zero hits, and the `agent-manager.ts` diff check (downgraded from "empty" to "comment-only" — see Step 6.2).

- [ ] **Step 3.3: `turn-assembly.test.ts` — invert the pilot pins, add T7 + spy**

The existing first assertion block (`:57-79`) changes: remove the `buildPilotInstructions` import and the two byte-identity expects (`assembly.instructions` toBe pilot output / `"pilot soul\n\npilot system"`), and remove `expect(assembly.memory).toEqual({})` / `expect(assembly.skillIndex).toEqual([])`. `makeRunner` (`:42-53`) gains a `buildProviderPrompt` mock:

```typescript
    buildProviderPrompt: extra.buildProviderPrompt ??
      vi.fn(async () => ({
        instructions: "ASSEMBLED-INSTRUCTIONS\n\n---\n\n**Current date/time**: fixture (Pacific Time)",
        hotTierPrompt: "HOT-TIER-BLOCK",
        skillEntries: [{ name: "fixture-skill", description: "d", path: "/tmp/fixture/SKILL.md" }],
      })),
```

New/updated cases:

  - [ ] **inversion pin:** `assembly.instructions` equals the runner-returned instructions (contains `ASSEMBLED-INSTRUCTIONS` and the datetime marker — i.e. NOT `soul\n\nsystemPrompt`); `assembly.memory` equals `{hotTierPrompt: "HOT-TIER-BLOCK"}`; `assembly.skillIndex` is the returned entries
  - [ ] `buildProviderPrompt` receives the **partitioned** inventory (the bridgeable subset, not the raw inventory) and `toolsExecutable: true` for `provider: "openai"`
  - [ ] `toolsExecutable: false` for `provider: "gemini"` and `"codex"` (pre-352/353); `TOOL_EXECUTING_PROVIDERS` export equals `new Set(["openai"])`
  - [ ] runner returning `hotTierPrompt: undefined` → `assembly.memory` equals `{}` (347 optional-field shape preserved)
  - [ ] **T7 (this child's 347-contract half):** `buildProviderPrompt` mock rejecting with `new Error("MongoNetworkError: connect ECONNREFUSED 127.0.0.1:27017")` → `assembleProviderTurn` rejects with `TurnAssemblyError`; then feed that error ×3 through `classifyThrown`/`classifyTurnResult` + a real `ProviderCircuitBreaker` instance (harness pattern from the existing breaker tests) → classification `non-provider`, openai breaker state stays **closed**
  - [ ] T7b: skill-derivation throw forced past fail-soft — `buildProviderPrompt` mock throwing synchronously → still `TurnAssemblyError` (the wrapper try contains sync throws too)
  - [ ] every other existing assertion in the file: unmodified and green

- [ ] **Step 3.4: Invert the KPR-347 byte-identity pins in the three pilot adapter test files**

Each of `openai-agents-adapter.test.ts`, `gemini-adk-adapter.test.ts`, `codex-subscription-adapter.test.ts` has one test ("KPR-347 T1: instructions are byte-identical to `buildPilotInstructions` output") that imports the now-deleted function and calls `buildPilotInstructions("Pilot", "soul", "system")` to build its `makeAssembly({instructions: ...})` fixture. For those literal arguments this call is exactly the string `"soul\n\nsystem"` (`buildPilotInstructions` trims each arg and joins non-empty sections with `"\n\n"` — `"soul".trim()` and `"system".trim()` are unchanged, so `["soul", "system"].join("\n\n")`). None of the three tests need the real function; they only need that fixed fixture string.

In each file:
1. Remove `import { buildPilotInstructions } from "./turn-assembly.js";`.
2. Replace the call `buildPilotInstructions("Pilot", "soul", "system")` with the inline literal `"soul\n\nsystem"`.
3. Leave every other line of the test untouched — including the assertions that the adapter forwards `assembly.instructions` verbatim to the provider SDK (`instructions: "soul\n\nsystem"` / `instruction: "soul\n\nsystem"` / `body.instructions` equal to `"soul\n\nsystem"`). The test still pins pass-through byte-identity; it just no longer round-trips through the deleted builder to construct its own fixture.

Exact call sites (this worktree's HEAD):
- `openai-agents-adapter.test.ts:14` (import), `:402` (call, inside the test declared at `:398`)
- `gemini-adk-adapter.test.ts:8` (import), `:315` (call, inside the test declared at `:310`)
- `codex-subscription-adapter.test.ts:11` (import), `:301` (call, inside the test declared at `:296`)

Test names/descriptions may stay as-is (they still document the pass-through-verbatim contract) or be reworded to drop the now-inaccurate "byte-identical to `buildPilotInstructions` output" phrasing (e.g. "instructions are forwarded to the provider SDK verbatim") — implementer's judgment, not load-bearing.

- [ ] **Step 3.5: `agent-runner.test.ts` — T1 cache-neutrality spies (additive describe)**

Construct a real `AgentRunner` with a spy `PrefixCache` (object with `getOrBuild: vi.fn((id, b) => b())`, `invalidateAgent: vi.fn()`, `invalidateAll: vi.fn()` cast as never — 9th constructor arg):

  - [ ] Lane B: `await runner.buildProviderPrompt({toolInventory: [], toolsExecutable: false})` → `getOrBuild`, `invalidateAgent`, `invalidateAll` all **never called** (Lane B is uncached by ruling)
  - [ ] Claude lane: `await (runner as … ).buildSystemPrompt([])` → `getOrBuild` called exactly once (read-through unchanged, `agent-runner.ts:370-372`)
  - [ ] `buildProviderPrompt` result: instructions end with the datetime trailer regex; with a memoryManager mock returning a hot-tier block, `hotTierPrompt` equals the block and appears **exactly once** in `instructions` (unit half of the single-injection rule)

- [ ] **Step 3.6: `tool-bridge.test.ts` — T5 memory pin + T6 `load_skill` e2e (additive describes)**

**T5 — memory tools pin (integration):** construct a real `AgentRunner` with `makeFakeInProcessDb()` and `coreServers: ["memory"]` (pattern: `agent-runner.test.ts:297`; import the helpers or replicate the minimal fake locally in tool-bridge.test.ts — replicate, don't export test helpers across files). Then:

```
inventory = runner.buildToolTransportInventory()          // real, includes memory + structured-memory sdk-in-process entries
inProcessServers = runner.buildInProcessServers()          // real McpServer instances
bridge = new ToolBridge({ inventory: <sdk-in-process entries only>, inProcessServers, gate: allowAll, signal, agentId, sessionCwd, skillIndex: [] })
tools = await bridge.connect()
```

  - [ ] `tools` contains `mcp__memory__view` and at least one `mcp__structured-memory__*` tool
  - [ ] `await viewTool.execute({path: "/memories"})` resolves to a string that is NOT prefixed `Tool execution failed` (round-trip through the real handler over `InMemoryTransport`; if the fake-db surface lacks a method a handler needs, extend the fake db in the test file — do not downgrade to synthetic tool fixtures)
  - [ ] a structured-memory tool call (e.g. `mcp__structured-memory__memory_recall` with `{query: "x"}`) resolves to a string (containment intact either way; assert non-throw, not content)
  - [ ] `await bridge.close()` resolves
  - [ ] file-tier-guidance pin: `buildProviderInstructions` with this real inventory (memory entry present, `toolsExecutable: true`) renders `## File-Tier Memory`; with the memory entry filtered out it does not — the "guidance iff memory bridged" half of T5

**T6 — `load_skill` end-to-end (the light-up):** tmpdir fixture plugin tree (`<dir>/skills/golden-e2e/SKILL.md`, frontmatter + body `E2E-SKILL-BODY: follow these steps.`):

  - [ ] `deriveProviderSkillIndex([{type: "local", path: dir}])` → one entry; feed it as `skillIndex` to a `ToolBridge` (in-process/external entries not required — empty inventory is fine) → `connect()` output **contains** `load_skill`
  - [ ] `await loadSkill.execute({name: "golden-e2e"})` resolves to the full SKILL.md content (contains `E2E-SKILL-BODY`)
  - [ ] unknown name → `load_skill failed: unknown skill 'nope'`
  - [ ] deny-all gate fixture (`async () => ({behavior: "deny", reason: "e2e-denied"})`) → `Tool call denied by policy: e2e-denied` (goes through the gated wrapper)
  - [ ] **dark-pin negative-verify (348 invariant still holds):** `skillIndex: []` → no `load_skill` in the bridged list

- [ ] **Step 3.7: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0; goldens untouched; `grep -rn "buildPilotInstructions" src/` returns nothing — including inside the three adapter test files edited in Step 3.4 and the reworded comment in `agent-manager.ts` (Step 3.2b): the symbol name must not survive anywhere, in code or in comments.

```bash
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts src/agents/agent-manager.ts src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/gemini-adk-adapter.test.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts
git commit -m "KPR-349: seam swap — real Lane B instructions, memory/skillIndex populated, load_skill lit, pilot stub deleted"
```

---

## Task 4 (Chunk 4): §D7 cap-priority ruling — the one bridge edit

**Files:**
- Modify: `src/agents/provider-adapters/tool-bridge.ts` (`applyNameAndCapEdges` ONLY)
- Modify: `src/agents/provider-adapters/tool-bridge.test.ts` (T8 + one updated 348 case)

- [ ] **Step 4.1: Implement the two-tier pin in `applyNameAndCapEdges` (`tool-bridge.ts:366-397`)**

Add `EXECUTOR_BACKED_BUILTIN_NAMES` to the existing `builtin-executor.js` import. Replace only the over-cap block (the sanitize/dedupe loop above it is untouched):

```typescript
    if (out.length > MAX_PROVIDER_TOOLS) {
      // KPR-349 (§D7 ruling, canon delegation from KPR-348): two tiers.
      // Tier 0 — the six executor builtins + load_skill (≤7 tools) are
      // structurally load-bearing (the prompt's toolkit and skills sections
      // claim them) and are NEVER cap-dropped. Tier 1 — everything else
      // (MCP-discovered) keeps inventory order and takes the entire
      // tail-drop. The 348-shipped order (load_skill first, builtins next)
      // was precisely inverted. Original relative order is preserved for
      // every survivor.
      const pinnedNames = new Set<string>([...EXECUTOR_BACKED_BUILTIN_NAMES, "load_skill"]);
      const pinned = out.filter((t) => pinnedNames.has(t.name));
      const tier1 = out.filter((t) => !pinnedNames.has(t.name));
      const tier1Budget = MAX_PROVIDER_TOOLS - pinned.length;
      const dropped = tier1.slice(tier1Budget);
      for (const d of dropped) this.runtimeOmissions.push({ server: d.name, reason: "provider-tool-cap" });
      log.warn("Bridged tool surface exceeds provider cap — Tier-1 tail dropped (builtins + load_skill pinned)", {
        agent: this.opts.agentId,
        cap: MAX_PROVIDER_TOOLS,
        pinned: pinned.map((t) => t.name),
        dropped: dropped.map((d) => d.name),
      });
      const surviving = new Set([...pinned, ...tier1.slice(0, tier1Budget)]);
      return out.filter((t) => surviving.has(t));
    }
    return out;
```

Omission shape unchanged (`reason: "provider-tool-cap"`); no other bridge function touched.

- [ ] **Step 4.2: T8 tests**

In `tool-bridge.test.ts` — the existing 348 cap case ("130 tools → 128 survive, 2 recorded") stays structurally but its fixture must now be checked against the ruling: if its 130 tools include no builtins/load_skill it passes unchanged (pure Tier-1 → tail drop identical); update only if needed. Add:

  - [ ] synthetic fixture: 125 MCP-discovered tools + the six static builtins + non-empty `skillIndex` (⇒ `load_skill`) = 132 total → result has exactly 128; **all six builtin names + `load_skill` present**; the dropped 4 are the LAST four Tier-1 tools (assert names); `runtimeOmissions` has 4 entries with `reason: "provider-tool-cap"`
  - [ ] order preservation: survivors keep original relative order (builtins/load_skill NOT moved to front — assert a Tier-1 tool that precedes Bash in inventory order still precedes it in output)
  - [ ] under-cap fixture with builtins + load_skill: untouched output (no pinning side-effects)
  - [ ] **negative-verify (mandatory, recorded):** `git stash` the Step 4.1 edit → run the new pinned-tier test → it FAILS with `load_skill` absent (pre-ruling code drops it first — it is pushed last in `connectInner`, `tool-bridge.ts:123-181`, and the old splice cuts the tail) → `git stash pop` → green. Record the failing output for the PR.

- [ ] **Step 4.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0.
Boundary check: `git diff HEAD~1 -- src/agents/provider-adapters/tool-bridge.ts` shows changes **inside `applyNameAndCapEdges` only** (plus the one import line).

```bash
git add src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/tool-bridge.test.ts
git commit -m "KPR-349: §D7 cap-priority ruling — builtins + load_skill pinned, Tier-1 tail-drop"
```

---

## Task 5 (Chunk 5): §D8 rider — builtin Edit/Write empty-string parity (own commit)

**Files:**
- Modify: `src/agents/provider-adapters/builtin-executor.ts`
- Modify: `src/agents/provider-adapters/builtin-executor.test.ts` (T9)

- [ ] **Step 5.1: `requireString` gains `allowEmpty`; Write/Edit call sites flip**

At `builtin-executor.ts:388-394`:

```typescript
function requireString(
  args: Record<string, unknown>,
  key: string,
  opts?: { allowEmpty?: boolean },
): string {
  const v = args[key];
  if (typeof v !== "string" || (v.length === 0 && !opts?.allowEmpty)) {
    throw new Error(`missing required string parameter '${key}'`); // bridge wrapper contains this
  }
  return v;
}
```

Call-site changes (§D8: presence-checked, not length-checked — Claude-lane parity):
- `write()` (`:280`): `const content = requireString(args, "content", { allowEmpty: true });` — truncate-to-empty works.
- `edit()` (`:290`): `const newString = requireString(args, "new_string", { allowEmpty: true });` — deletion works. `old_string` and `file_path` stay strict (Claude-lane Edit also rejects empty `old_string`); the `oldString === newString` identity guard (`:292`) stays.

- [ ] **Step 5.2: T9 tests (additive)**

  - [ ] `Edit {old_string: "goodbye ", new_string: ""}` on a fixture file → deletion applied, file content verified
  - [ ] `Write {content: ""}` over an existing non-empty file → file truncated to zero bytes, result `Wrote 0 bytes to …`
  - [ ] `Edit {old_string: ""}` → still the contained error (`missing required string parameter 'old_string'` via the wrapper)
  - [ ] `Edit`/`Write` with empty `file_path` → still rejected
  - [ ] `Edit {old_string: "x", new_string: "x"}` → identity guard still fires
  - [ ] **negative-verify (mandatory, recorded):** `git stash` Step 5.1 → deletion + truncation tests FAIL on pre-fix `requireString` → `git stash pop` → green. Record for the PR.

- [ ] **Step 5.3: Verify + commit (rider isolation)**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0.
`git diff HEAD~1 --stat` shows exactly the two builtin-executor files (review-visible rider boundary, spec §D8).

```bash
git add src/agents/provider-adapters/builtin-executor.ts src/agents/provider-adapters/builtin-executor.test.ts
git commit -m "KPR-349: §D8 rider — builtin Edit/Write accept empty new_string/content (Claude-lane parity)"
```

---

## Task 6 (Chunk 6): Final verification + neutrality checks + e2e spot-check

- [ ] **Step 6.1: Full gate**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck + lint + format + full vitest suite green; **snapshot file byte-identical to its Task 0 commit** (`git log --oneline -- src/agents/__snapshots__/` shows exactly one commit).

- [ ] **Step 6.2: Neutrality by diff** (use `$(git merge-base kpr-345 HEAD)` so checks survive a rebase)

  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/provider-adapters/types.ts src/agents/provider-adapters/tool-transport.ts src/agents/provider-adapters/archetype-gate.ts src/agents/provider-adapters/openai-agents-adapter.ts src/agents/provider-adapters/gemini-adk-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/claude-agent-adapter.ts src/agents/prefix-cache.ts src/agents/prefix-invalidation.ts` → **empty** (`SESSION_SEMANTICS`, adapters — the four production `.ts` files, not their `.test.ts` files — cache internals untouched)
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/agent-manager.ts` → **not** empty, but comment-only: exactly the two reworded comment lines from Step 3.2b (`agent-manager.ts:502-503`), zero lines of executable code touched — eyeball-confirm every changed line starts with `//`
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/gemini-adk-adapter.test.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts` → **not** empty (Step 3.4's inversion), but confined per file to the removed import line + the one `buildPilotInstructions(...)` call site replaced with the `"soul\n\nsystem"` literal — no other test in these files touched
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/provider-adapters/tool-bridge.ts` → hunks confined to `applyNameAndCapEdges` + one import (eyeball: `wrap`/`connect*`/`close`/`buildLoadSkillTool` zero lines touched)
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/agent-runner.ts` → targeted eyeball: only the datetime-trailer lines in `buildSystemPrompt` + the new `buildProviderPrompt` method; cache read-through (`:370-372`), `buildToolkitSection` call, `buildToolTransportInventory`, `buildInProcessServers`, `buildHooks`, `send()` zero lines touched
  - [ ] `grep -rn "buildPilotInstructions" src/ docs/epics/kpr-345/kpr-349-plan.md --include="*.ts"` → **zero hits, anywhere** — not merely "no source hits": this now also covers the three inverted adapter test files (Step 3.4) and the reworded `agent-manager.ts` comment (Step 3.2b), both of which would otherwise have kept the deleted symbol alive as a dangling reference

- [ ] **Step 6.3: E2E real-instance byte-diff spot-check (dev Mac, evidence in PR)**

Scratch tsx driver (session scratchpad, not committed): construct the production wiring for one real agent with hot-tier records (e.g. mokie on the dodi instance — read-only: MongoClient + MemoryManager + AgentRunner + `buildPrefix` via the same context `buildSystemPrompt` builds) and print the prefix to a file. Run once on the pre-refactor commit (`git stash` / checkout `$(git merge-base kpr-345 HEAD)` in a throwaway worktree) and once on HEAD; `diff` the two outputs.
Expected: **zero bytes differ.** Paste the `diff` invocation + empty output (and the agent id + capture timestamp) into the PR description. If no dev instance is reachable, report the concrete blocker — do not skip silently.

- [ ] **Step 6.4: Push evidence into the PR description** — the three negative-verify records (Steps 1.4, 4.2, 5.2), the byte-diff spot-check, and the §D7 seam note: cite spec §D7's supersession statement (the cap edit is canon-delegated and in-scope), not `kpr-348-spec.md:181`.

---

## Notes for the reviewer (plan-level decisions and their rationale)

1. **Trailer gating lives in `getHotTierPrompt` (a `memory-manager.ts` edit), not string surgery in the builder.** The spec's `memorySections` sketch strips lines; regex-stripping a fused sentence out of an opaque rendered block is fragile against future trailer edits. The optional `recallToolName` knob is default-preserving (undefined ⇒ today's exact bytes, existing tests unmodified) and makes the §D5 option-(a) qualified name a parameter rather than a second surgery site. `memory-manager.ts` is not on the spec's must-not-touch list; the change is additive-optional.
2. **§D5 naming mismatch: option (a) taken.** Tool-executing Lane B renders name `mcp__structured-memory__memory_recall` (the model-visible bridged name); the Claude lane keeps bare `memory_recall` verbatim (golden-pinned — fixing Claude too would churn the goldens and is explicitly out of scope per the spec). T2 asserts the choice via the opts value passed (Step 2.6); the residual Claude-lane imprecision stays matrix-noted (child 10).
3. **Exact gated trailer text** = `---\nYou have ${n} additional memories.` — the spec final gate's example adopted as the contract string, asserted in Step 2.5.
4. **`buildProviderPrompt` takes `toolsExecutable: boolean`, not `provider`.** The spec's §D1 sketch said `{toolInventory, provider}`; the final-gate note 4 ("the gate feeds the builder as a plain boolean — no per-provider branches inside prefix-builder") wins: provider knowledge stays entirely in `turn-assembly.ts` where `TOOL_EXECUTING_PROVIDERS` lives, and the runner/builder are provider-blind.
5. **The `getHotTierPrompt` signature extension lands in Task 1 (with the extraction), not Task 2** — `memorySections` passes the opts argument, so the parameter must exist for the chunk to typecheck; the default path is byte-identical, keeping Task 1 a pure-motion commit in behavior terms. The trailer *variants* and their tests are Task 2.
6. **T2 mocks assert the opts contract rather than re-rendering real trailers** (`toHaveBeenCalledWith(..., {recallToolName: null})`): the real trailer rendering is unit-tested where it lives (memory-manager, Step 2.5); the builder test pins that the builder *requests* the right variant — together they cover the seam without a Mongo fixture in the builder suite.
7. **T5 uses the runner's real in-process servers over `makeFakeInProcessDb`** (spec: "real `createSdkMcpServer` memory/structured-memory fixture"). If a handler needs a fake-db surface the fixture lacks, the fake is extended in the test file — synthetic stand-in servers would not pin the actual factories' bridge-compatibility.
8. **Golden fixture matrix is 12 cases, one per `buildPrefix` branch** (soul, card render/throw/config-absent, constitution, roster present/throw, guidance gate, hot vs legacy vs none, toolkit subsections, toolSearch modes, kitchen sink) — matching the spec §D2 enumeration exactly; snapshots are file-level (committed `.snap`) so review can read the frozen bytes.
9. **The existing 348 cap test may pass unchanged** (its fixture is pure Tier-1); if its fixture happens to include pinned names, updating it to the ruled behavior is the §Regression-sanctioned exception ("updated to the ruled behavior, not deleted").
