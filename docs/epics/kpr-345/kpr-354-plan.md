# KPR-354 Implementation Plan — Subagent parity: nested adapter turns for delegate subagents on Lane B

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-354-spec.md](./kpr-354-spec.md) (spec-review clean at fable final round; reviewed @ epic-branch SHA 453d0d9) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D4/§D8. Baseline: KPR-346/347/348/349/353 all merged; **all line anchors below verified against this worktree's epic-branch HEAD.**

**Goal:** Reassigned `openai/…` and `codex/…` agents get their delegate subagents: the bridge synthesizes ONE Claude-lane-identical `Task` function tool from the agent's `claude-subagent` inventory entries, and executing it runs a nested adapter turn — a fresh same-provider adapter built against the delegate's config (delegate prompt as instructions, that one MCP server + the six executor builtins, maxTurns 7/10 parity) — through a manager-owned runner that consumes a real spawn-coordinator budget slot and chains abort from the parent turn. `claude-subagent` entries flip `claude-only` → `requires-hive-bridge` on all three Lane B columns.

**Architecture:** six seams, each a bounded edit: (1) `tool-transport.ts` classify flip + `description?` carriage field (§D1); (2) `agent-runner.ts` delegate-loop carriage (`serverConfig` + catalog description, §D2) + shared prompt/maxTurns constants consumption (§D5.3); (3) `turn-assembly.ts` gains `DelegateTurnCall`/`DelegateTurnRunner`, the optional `delegateTurnRunner` assembly field, the shared constants, and the pure `buildNestedDelegateAssembly()` helper (§D4/§D5.3); (4) `tool-bridge.ts` gains a fourth `connectInner` partition synthesizing `Task` through the existing `wrap()` + the `Task` cap pin (§D3); (5) one-line bridge-option pass-through in the openai and codex adapters; (6) `agent-manager.ts` builds the nested-turn runner callback in `createProviderAdapter`'s Lane B branch (§D5). Toolkit gains a Lane B delegates subsection (§D6). Zero bridge-core, dispatch-loop, session, or breaker redesign.

**Tech stack:** TypeScript strict, vitest beside source, existing test scaffolding (fake inventories, mocked adapter modules in `agent-manager.test.ts`, real `McpServer` over `InMemoryTransport` in bridge tests) — no new dependencies.

**Decision-register canon honored (per task):**
- *Bridge bound, not redesigned* — `Task` is one more `BridgedTool` through the existing `wrap()` (gate → execute → contain → meter); `wrap()` order/text shapes untouched; its wall time lands in `bridge.stats.toolMs`, so parent `llmMs = durationMs − toolMs` excludes nested turn time with zero new code.
- *Claude-lane tool names preserved* — the synthesized tool is named `Task` with Claude-identical input fields, so archetype rules written against `Task` transfer verbatim.
- *codex ≡ openai at every classify site* — the §D1 flip is ONE code path emitting openai/gemini/codex identically (gemini upgraded for classification honesty, dark until KPR-352 — its adapter still advertises zero tools; the callback passes uniformly and is inert there).
- *Parity payload = ProviderTurnAssembly at adapter construction* — the runner callback rides the assembly as an opaque field; provider resolution + budget machinery live at the manager seam (assembly stays provider-blind). Assembly throws stay `TurnAssemblyError` (non-provider, breaker-invisible) — the callback does no work at assembly time, so carrying it adds zero assembly-throw surface.
- *Early-abort closure is manager-owned; runTurn-interior = bridge signal* — the nested runner listens on the parent bridge signal (`ToolBridgeOptions.signal`); `ticket.abort()` → adapter abort → bridge signal → nested `abort()`. No new plumbing.
- *Six executor builtins + load_skill pinned never cap-dropped* — `Task` joins that pinned set (≤8 of 128); Tier-1 tail-drop order untouched.
- *KPR-353 canon* — nested codex adapters get NO `historyStore`/`agentId` (replay + persist skip by construction); `provider_turn_history` provably untouched by nested turns.
- *KPR-184* — delegate entries are external-by-construction (in-process servers barred from `delegateServers`), so `serverConfig` carriage is safe; the missing-config case degrades, never throws.
- *`TOOL_EXECUTING_PROVIDERS` = {openai, codex}* — untouched; `SESSION_SEMANTICS`, `LaneBProviderId` untouched.

**Binding plan directives (spec-review/1/fable — each mapped to a step):**
1. **[D5.5]** The abort-listener body (`() => nested.abort()`) is wrapped in try/catch — an `abort()` throw in EventTarget dispatch escapes all async containment; never-throws is structural. (Task 4 Step 4.1; pinned Task 4 Step 4.2 case 8; negative-verify leg 4.)
2. **[D5]** Nested assembly's `omittedTools` is `[]`; the nested runner does NOT touch `lastSpawnAt`/`updateStatus`. (Task 2 Step 2.1 + pin in Step 2.2; Task 4 Step 4.1 + pins in Step 4.2 cases 9–10.)
3. **[D5.2]** Stop-check + budget check-and-increment are synchronous — no `await` between them — for atomicity under parallel openai Task calls. (Task 4 Step 4.1; pinned Step 4.2 case 4.)

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `tool-transport.ts` (T1 classify flip + partition), `turn-assembly.ts` (T4 nested-assembly builder, passthrough pins), `tool-bridge.ts` (T3 Task synthesis, schema, validation, cap pin), `toolkit-section.ts` (T7 delegates subsection), `agent-runner.ts` (T2 inventory carriage — existing fake-config harness).
  - Reason: the flip, the builder, and the synthesis are pure/deterministic contracts fully drivable by fixtures.
  - Minimum assertions: the T1–T4, T7 blocks in "Critical Flows" below, each mapped to a step.

- Integration: **required**
  - Scope: (a) **T5 nested runner** at the manager level — real `AgentManager` + real `assembleProviderTurn` over the mocked runner/adapter modules (`agent-manager.test.ts:97-170` harness): capture the `delegateTurnRunner` off the adapter-constructor `options.assembly`, invoke it directly, and pin slot accounting, saturation, stop-denial, abort chaining (incl. the D5.5 throw containment), no-historyStore nested codex construction, session-store silence, result shaping, never-rejects; (b) **T6 parent integration** — openai adapter binds `Task` via SDK tool binding (mocked run loop); codex request body carries the `Task` function tool (mocked fetch + `sse()` harness); (c) **T8 breaker neutrality** — a nested provider-fault resolves as parent tool text, `classifyTurnResult` sees success.
  - Reason: budget/stop/abort semantics only mean something against the real manager state maps; Task advertisement only means something through the real bridge inside the real adapters.
  - Harness: **existing** — `agent-manager.test.ts` module mocks (`mockOpenAIConstructor`/`mockCodexConstructor` capture constructor options incl. the assembly; `mockRunnerToolInventory` feeds `buildToolTransportInventory`); `tool-bridge.test.ts` fixture builders; `codex-subscription-adapter.test.ts` `makeAdapter`/`makeAssembly`/`sse()`; `openai-agents-adapter.test.ts` fixture patterns. No new harness needed.
  - Minimum assertions: (a)–(c) above, incl. the three binding-directive pins.

- E2E: **not required**
  - Reason (spec ruling, not a skip): spec §Open assumptions declares **blocking: none** — every provider-facing mechanic (one more function tool in the advertised set) is already live-proven on both surfaces by the KPR-348/353 spikes; all new machinery is hive-side and fully covered by unit + integration. The one ⚠ non-blocking assumption (enum-restricted `subagent_type` accepted by the codex backend) is explicitly delegated to **KPR-351's live validation**, and its fallback (plain string + runner-side validation) is *already the implemented error path* — no code change needed if it fires. If KPR-351's live leg later shows enum rejection, the one-line fallback (drop `enum` from the schema) lands there.

### Critical Flows

- **T1 — classify flip:** `claude-subagent` ⇒ `requires-hive-bridge` on openai/gemini/codex and `direct` on claude (ONE emission path — assert all three columns from one call); `Task`/`WebFetch`/`TodoWrite` claude-builtin entries still `claude-only`; the six executor builtins unchanged; `partitionInventoryForProvider` now routes `claude-subagent` entries to `bridgeable` on all three providers and the per-delegate omission records disappear. **Negative-verify leg 1** (mandatory, recorded): temporarily revert the flip → inverted pins fail pre-flip → restore.
- **T2 — inventory carriage:** delegate entries carry `serverConfig` (the exact object from `allServerConfigs`) + catalog `description`; in-process servers still never appear as delegates (KPR-184 path untouched — existing pins pass); claude-builtin entries still carry NO `serverConfig`.
- **T3 — Task synthesis:** present iff (entries non-empty ∧ `delegateRunner` present) — absent runner ⇒ no tool (fail-dark); Claude-identical schema (`description`/`prompt`/`subagent_type`, all required, `additionalProperties: false`, `enum` = active delegate names); tool description lists each delegate with its carried description; gate-deny on `Task` yields `Tool call denied by policy: …` (wrap() untouched); unknown `subagent_type` → `Task failed: unknown subagent_type '<x>'. Valid: <names>`; empty/non-string prompt → structured error; runner receives validated `{delegate, prompt, entry, signal, workItemContext}`; **`Task` pinned under the 128 cap** (negative-verify leg 2: remove the pin → cap test fails); delegate entries contribute no other tools and open no MCP connection.
- **T4 — nested assembly builder:** custom `delegatePrompts[server]` vs generic specialist prompt (verbatim via the shared exported constants); maxTurns 7 (custom) / 10 (generic); inventory = the delegate re-expressed at its real transport (stdio/http/sse from `serverConfig.type`, `schemas: {kind:"connect-time"}`, `serverConfig` carried) + exactly the six builtin static entries; **no** `claude-subagent` entries, **no** `delegateTurnRunner` (structural depth-1), no skills/in-process/memory; **`omittedTools` is `[]` (directive 2 pin)**; `sessionCwd` = input's; missing `serverConfig` → builtin-only inventory + warn, no throw; gate built from config (archetyped config ⇒ non-allow-all gate).
- **T5 — nested runner (manager):** slot acquired and released on success / error-result / rejection (finally idiom incl. delete-at-zero); saturation → denial text + `recordSaturation` + **no increment leak**; stopped-agent → denial text; parallel-call atomicity (directive 3 pin): 3 synchronous invocations under budget 2 ⇒ exactly 2 nested constructions + 1 denial; abort chaining (parent signal fires → nested `abort()` called; pre-flight aborted signal → aborted text without construction); **abort-throw containment (directive 1 pin)**: nested `abort()` mock throws → no unhandled error, runner still resolves; codex nested constructed **without** `historyStore`/`agentId`; openai nested constructed with parent route model + `name: "<agent>:<delegate>"`; `sessionStore` never touched by a nested run; result shaping success/error/aborted/empty-text; callback **never rejects** (nested `runTurn` rejection → failed text); **`lastSpawnAt` unchanged + status stays `idle` across a nested run (directive 2 pins, via `getSnapshot()` + `getState()`)**; `activeSpawns` visibly reflects an in-flight nested turn in the snapshot.
- **T6 — parent integration:** openai — assembly carrying a subagent entry + runner ⇒ the Agents-SDK `Agent` receives a tool named `Task` (mocked run captures agent config), and invoking its execute reaches the runner; codex — mocked-fetch request body `tools` array contains `{type:"function", name:"Task", …, strict:false}`; both — assembly WITHOUT `delegateTurnRunner` ⇒ no `Task` advertised (existing suites already run runner-less assemblies — they pass unmodified, which IS this pin).
- **T7 — toolkit:** `buildProviderToolkitSection` renders `### Delegated capability MCPs (via the Task tool)` iff `claude-subagent` entries present, one `formatToolkitLine` per delegate; the existing "skips claude-subagent" pin (`toolkit-section.test.ts:409`) is inverted; Claude-lane `buildToolkitSection` output byte-identical (existing suites + KPR-349 golden pass untouched).
- **T8 — breaker neutrality:** a runner resolving `Delegate turn failed (x): 500 Internal Server Error` surfaces as Task tool-result text; the parent `RunResult` carries no `error` and `classifyTurnResult` classifies success; the runner never calls `circuitBreakers` (structural — no acquire/record in the callback; pinned via breaker-spy silence during a nested run).

### Regression Surface

- **Claude lane:** `buildServerSubAgents` behavior identical after the constants extraction (all existing delegate pins at `agent-runner.test.ts:1624-1690` pass unmodified); Claude toolkit/prefix golden suites pass untouched; SDK `agents:` wiring untouched.
- **Bridge core:** `wrap()` order/text, connect/close lifecycle, external/in-process/builtin partitions, name-edge logic — untouched; existing `tool-bridge.test.ts` suites pass unmodified except the deliberate cap-pin addition.
- **Adapters:** loops, auth, telemetry, history wiring untouched — the only diff in each is the one bridge-option line; every existing adapter assertion passes unmodified.
- **Manager:** `withSpawnTicket`, per-thread lock, breaker acquire/record sites, KPR-313 guard, `finalizeSpawnResult`, reflection scheduling — untouched (the runner is additive closure code inside `createProviderAdapter`); all existing `agent-manager.test.ts` pins pass unmodified.
- **Sessions/history:** `SESSION_SEMANTICS` values, `persistsResumableHandle`, `session-store.ts`, `turn-history-store.ts` — zero edits.
- **Zero-edit files (empty-diff check in Task 6):** `types.ts`, `error-classification.ts`, `builtin-executor.ts`, `archetype-gate.ts`, `skill-index.ts`, `gemini-adk-adapter.ts`, `claude-agent-adapter.ts`, `passthrough-providers.ts`, `session-store.ts`, `turn-history-store.ts`, `prefix-builder.ts` (its `buildProviderToolkitSection` call already passes the inventory — no edit needed).

### Commands

- Fast loop (per task, named below): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run <touched test files>`
- Full gate (every task commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.
- Broader regression (Task 6): full `npm run check` + the zero-edit-files `git diff --stat` check.

### Harness Requirements

- `npm ci` in the worktree if `node_modules` absent. Node 22/24 (dev-mode Node 26 broken per KPR-344).
- All tests run with no live credentials, no network, no Mongo. **Guardrail (KPR-353 standing rule): never construct `CodexSubscriptionAdapter` in a test without BOTH a `fetch` mock and a tmp `codexAuthPath`** — the existing `makeAdapter` helper already does both.
- Manager tests keep the existing module-level adapter mocks — the nested adapter construction hits the same mocked constructors (distinguish parent vs nested calls by `options.name`: nested is `"<agent>:<delegate>"`).
- Bridge Task-synthesis tests need no MCP server at all (the entries are consumed by synthesis only); reuse the existing fixture-entry builders.

### Non-Required Rationale

- E2E: see the Required Test Groups entry — spec §Open assumptions rules blocking-none; live validation of the enum assumption is KPR-351's assigned scope, with the fallback already implemented as the runner-side validation error path.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec mismatch, demote to the spec lane — do not improvise.
- Negative-verify discipline (operator standard) — four mandatory legs, each run against weakened code with the failing output recorded before restoring:
  1. **Classify flip (Task 1):** temporarily restore the old `claude-subagent` → `claude-only` emission → T1 inverted pins fail → restore → green.
  2. **Task cap pin (Task 3):** temporarily remove `"Task"` from `pinnedNames` → the cap test (129-tool surface keeps `Task`) fails → restore.
  3. **Slot release (Task 4):** temporarily remove the `finally` decrement in the nested runner → the slot-release-on-error test fails (activeSpawns leaks) → restore.
  4. **Abort-listener containment (Task 4, directive 1):** temporarily remove the try/catch inside the abort-listener body → the abort-throw containment test fails (unhandled error surfaces in the worker) → restore.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/agents/provider-adapters/tool-transport.ts` | modify (Task 1) | §D1 classify flip (one path, three columns); `description?` field on `HiveToolInventoryEntry`; `ToolSchemaAvailability` + `serverConfig` doc-comment corrections |
| `src/agents/provider-adapters/tool-transport.test.ts` | modify (Task 1) | T1 pin inversions (`:78`, `:123`, partition case `:154`) + new partition-routing pins |
| `src/agents/agent-runner.ts` | modify (Tasks 1, 2) | delegate-loop carriage (§D2, Task 1); `buildServerSubAgents` consumes shared prompt/maxTurns constants (§D5.3, Task 2 — output-identical) |
| `src/agents/agent-runner.test.ts` | modify (Task 1) | T2 carriage pins (invert `:1343` compatibility half, update `:1523` serverConfig half) |
| `src/agents/provider-adapters/turn-assembly.ts` | modify (Task 2) | `DelegateTurnCall`/`DelegateTurnRunner` types; `delegateTurnRunner?` on assembly + input; shared constants; `buildNestedDelegateAssembly()` (§D4/§D5.3) |
| `src/agents/provider-adapters/turn-assembly.test.ts` | modify (Task 2) | T4 builder pins (incl. `omittedTools: []` directive pin) + passthrough pins |
| `src/agents/provider-adapters/tool-bridge.ts` | modify (Task 3) | `delegateRunner?` option; fourth partition + `buildTaskTool()` (§D3); `Task` cap pin |
| `src/agents/provider-adapters/tool-bridge.test.ts` | modify (Task 3) | T3 synthesis/validation/cap pins |
| `src/agents/provider-adapters/openai-agents-adapter.ts` | modify (Task 3) | one line: `delegateRunner` into bridge options |
| `src/agents/provider-adapters/openai-agents-adapter.test.ts` | modify (Task 3) | T6a — `Task` bound into the SDK Agent |
| `src/agents/provider-adapters/codex-subscription-adapter.ts` | modify (Task 3) | one line: `delegateRunner` into bridge options |
| `src/agents/provider-adapters/codex-subscription-adapter.test.ts` | modify (Task 3) | T6b — request body carries the `Task` function tool |
| `src/agents/agent-manager.ts` | modify (Task 4) | nested-turn runner callback in `createProviderAdapter`'s Lane B branch (§D5) |
| `src/agents/agent-manager.test.ts` | modify (Task 4, additive) | T5 + T8 |
| `src/agents/toolkit-section.ts` | modify (Task 5) | Lane B delegates subsection (§D6) + doc-comment corrections |
| `src/agents/toolkit-section.test.ts` | modify (Task 5) | T7 (invert `:409` skip pin) |
| `CLAUDE.md` | modify (Task 6) | §D8 riders — provider-adapters paragraph |

**NOT touched (spec Integration table):** `types.ts`, `gemini-adk-adapter.ts`, `claude-agent-adapter.ts`, `passthrough-providers.ts`, `session-store.ts`, `turn-history-store.ts`, `builtin-executor.ts`, `archetype-gate.ts`, `skill-index.ts`, `error-classification.ts`, `prefix-builder.ts`, `withSpawnTicket`/per-thread lock/breaker sites/KPR-313 guard/`finalizeSpawnResult` in `agent-manager.ts`, `buildServerSubAgents` *behavior*, Claude toolkit/prefix output, `wrap()`/MCP mechanics/existing partitions in `tool-bridge.ts`, `BRIDGEABLE_COMPATIBILITIES`, `TOOL_EXECUTING_PROVIDERS`, `SESSION_SEMANTICS`.

**Interim states (deliberate, epic-branch-internal):** after Task 1, delegate entries flow into the bridgeable partition but the bridge silently ignores `claude-subagent` transports and the toolkit skips them — safe-dark, R3 omission record replaced by nothing until the Task 4 light-up. After Task 3, the Task tool exists in the bridge but no assembly carries a runner — still dark. Task 4 is the light-up; Task 5 makes the prompt honest about it. All within one child PR.

---

## Task 1 (Chunk 1): §D1 classify flip + §D2 inventory carriage

**Files:**
- Modify: `src/agents/provider-adapters/tool-transport.ts`
- Modify: `src/agents/provider-adapters/tool-transport.test.ts`
- Modify: `src/agents/agent-runner.ts` (delegate loop only)
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1.1: Flip the `claude-subagent` ruling in `classifyToolTransport` (`tool-transport.ts:92-115`)**

Replace the branch body:

```typescript
  if (input.transport === "claude-builtin" || input.transport === "claude-subagent") {
    // KPR-348 (spec §D5, canon 2): the six executor-backed builtins are
    // bridgeable on every Lane B provider — ONE code path emits openai,
    // gemini, and codex identically (codex ≡ openai at the classify site;
    // gemini upgraded for classification honesty — its adapter still
    // advertises zero tools until KPR-352, only its omission record changes).
    // KPR-354 (spec §D1): claude-subagent entries are Task-synthesis inputs —
    // requires-hive-bridge on all three Lane B columns, same one-code-path
    // rule. claude-builtin behavior unchanged: only executor-backed builtins
    // escape claude-only; the Task BUILTIN entry stays claude-only — the
    // honest carrier for "general-purpose subagents are Claude-lane-only".
    const executorBacked =
      input.transport === "claude-builtin" && EXECUTOR_BACKED_BUILTIN_NAMES.has(input.name);
    const nonClaude: ProviderToolCompatibility =
      input.transport === "claude-subagent" || executorBacked ? "requires-hive-bridge" : "claude-only";
```

(The rest of the branch — the returned descriptor — is unchanged.)

- [ ] **Step 1.2: `description?` field + doc-comment corrections (`tool-transport.ts`)**

In `HiveToolInventoryEntry` (`:169-182`), add after `schemas`:

```typescript
  /**
   * KPR-354 (§D2): catalog/manifest description carried for claude-subagent
   * entries — feeds the synthesized Task tool's delegate listing (the Claude
   * lane feeds the same catalog text into AgentDefinition.description).
   * Optional/additive; absent on every other transport.
   */
  description?: string;
```

Extend the `serverConfig` doc comment (`:171-180`) — replace its first sentence with:

```
   * Present on external MCP transports (stdio | http | sse) AND, post-KPR-354,
   * on claude-subagent entries (the delegate's underlying external MCP config —
   * external by construction, KPR-184): the exact server config the Claude
   * lane would pass to the SDK, resolved env (incl. secret-env) and all.
```

Correct the `ToolSchemaAvailability` `unavailable` bullet (`:160-162`) to:

```
 *  - "unavailable": no schema surface exists (claude-builtin without an
 *    authored executor; claude-subagent — post-KPR-354 these reach the
 *    bridge as Task-SYNTHESIS inputs, not as schema-bearing tools, so
 *    "unavailable" remains their truthful schema state: the Task schema is
 *    hive-authored, not discovered).
```

- [ ] **Step 1.3: Delegate-loop carriage in `buildToolTransportInventory` (`agent-runner.ts:1291-1300`)**

```typescript
    for (const name of this.activeDelegateNames(allServerConfigs)) {
      inventory.push({
        ...classifyToolTransport({
          name,
          transport: "claude-subagent",
          source: "delegate",
        }),
        schemas: { kind: "unavailable" },
        // KPR-354 (§D2): Task-synthesis carriage. serverConfig is safe by
        // construction — KPR-184 bars in-process servers from delegateServers
        // and activeDelegateNames drops config-less names, so every surviving
        // delegate is a real stdio/http/sse config. Secrecy rule unchanged:
        // bridge-facing, never model-facing, never logged. description is the
        // same catalog text the Claude lane feeds AgentDefinition.description.
        serverConfig: allServerConfigs[name],
        description: this.getServerCatalogEntry(name).description,
      });
    }
```

- [ ] **Step 1.4: Tests**

`tool-transport.test.ts`:
  - [ ] Invert the `:78` parameterized case: split `claude-builtin` / `claude-subagent` — subagent now expects `{claude: "direct", openai: "requires-hive-bridge", gemini: "requires-hive-bridge", codex: "requires-hive-bridge"}` asserted from ONE `classifyToolTransport` call (one-code-path pin).
  - [ ] Invert `:123` ("keeps claude-subagent claude-only even for an executor-shared name") → a `claude-subagent` entry named `Bash` is `requires-hive-bridge` on all three (the ruling keys on transport, not name).
  - [ ] Non-executor claude-builtin (`Task`, `WebFetch`, `TodoWrite`) still `claude-only` on all three (unchanged pins stay green).
  - [ ] Partition: an inventory with one `claude-subagent` entry now routes it to `bridgeable` for openai, gemini, AND codex; the omitted list carries no delegate record (update the `:154` case).
  - [ ] **Negative-verify leg 1 (record output):** temporarily restore the old emission (`const nonClaude = executorBacked ? … : "claude-only"`) → inverted pins fail → restore → green.

`agent-runner.test.ts`:
  - [ ] Invert the compatibility half of `:1343` ("classifies delegate servers as Claude sub-agents and Claude-only for non-Claude providers") → delegate entries are `requires-hive-bridge` for openai/gemini/codex; ADD: the entry carries `serverConfig` (toBe the object in the fake config map) and `description` (catalog text — for a catalog-known name like `google`, the catalog description; for an unknown name, the name itself).
  - [ ] Update `:1523`: claude-builtin entries still have NO `serverConfig` (unchanged half); the claude-subagent half now HAS `serverConfig` + `description`.
  - [ ] Existing autonomy-gate and KPR-184 pins pass unmodified.

- [ ] **Step 1.5: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/tool-transport.test.ts src/agents/agent-runner.test.ts` → green.
Then `npm run check` (env stubs) → exit 0. (Safe-dark interim: entries now partition bridgeable; the bridge's three transport filters ignore `claude-subagent` and `buildProviderToolkitSection` explicitly skips it — no behavior change downstream yet.)

```bash
git add src/agents/provider-adapters/tool-transport.ts src/agents/provider-adapters/tool-transport.test.ts src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "KPR-354: classify flip — claude-subagent bridgeable on all Lane B columns + serverConfig/description carriage (D1/D2)"
```

---

## Task 2 (Chunk 2): §D4 contract carriage + shared constants + `buildNestedDelegateAssembly()`

**Files:**
- Modify: `src/agents/provider-adapters/turn-assembly.ts`
- Modify: `src/agents/provider-adapters/turn-assembly.test.ts`
- Modify: `src/agents/agent-runner.ts` (`buildServerSubAgents` constant consumption — output-identical)

- [ ] **Step 2.1: Types, constants, assembly field, and builder in `turn-assembly.ts`**

New imports (extend the existing `tool-transport.js` import; add builtin-executor):

```typescript
import {
  classifyToolTransport,
  partitionInventoryForProvider,
  type HiveToolInventoryEntry,
  type OmittedToolRecord,
} from "./tool-transport.js";
import { BUILTIN_TOOL_DEFINITIONS, EXECUTOR_BACKED_BUILTIN_NAMES } from "./builtin-executor.js";
```

(Import-direction note: `builtin-executor` imports only types from `tool-transport` — erased; no runtime cycle. `agent-runner`'s existing import of this module is type-only; Step 2.3 makes it a runtime import in the agent-runner → turn-assembly direction, and this module's agent-runner import stays type-only — no cycle either way.)

Add beside `ProviderSkillIndexEntry` (NOT `types.ts` — the call shape references `HiveToolInventoryEntry`, and `tool-transport.ts` already imports from `types.ts`; placing these here avoids even a type-only cycle, spec §D4):

```typescript
/** KPR-354 (§D4): one nested delegate-turn invocation, bridge → manager. */
export interface DelegateTurnCall {
  /** Validated subagent_type — an active delegate name. */
  delegate: string;
  /** Task prompt for the delegate. */
  prompt: string;
  /** The claude-subagent inventory entry (carries serverConfig, description). */
  entry: HiveToolInventoryEntry;
  /** Parent bridge signal — the abort chain rides it. */
  signal: AbortSignal;
  workItemContext?: WorkItemContext;
}

/**
 * KPR-354 (§D5): manager-owned nested-turn executor. NEVER throws — every
 * path resolves model-visible text (denials, aborts, failures included).
 * Built at the manager seam (provider resolution + budget machinery live
 * there); carried here as an opaque callback so the assembly stays
 * provider-blind.
 */
export type DelegateTurnRunner = (call: DelegateTurnCall) => Promise<string>;

/**
 * KPR-354 (§D5.3): delegate-subagent constants shared VERBATIM between the
 * Claude lane (AgentRunner.buildServerSubAgents) and the Lane B nested
 * assembly — single-source extraction so the two lanes cannot drift.
 */
export function buildGenericDelegatePrompt(serverName: string): string {
  return `You are a tool specialist for ${serverName}. Execute the requested task using your available tools. Return results concisely. Do not add commentary or explanation beyond what was asked.`;
}
/** Intent-aware (custom-prompt) delegates need fewer turns. */
export const DELEGATE_MAX_TURNS_CUSTOM = 7;
export const DELEGATE_MAX_TURNS_GENERIC = 10;
```

`ProviderTurnAssembly` gains (after `sessionCwd`):

```typescript
  /**
   * KPR-354 (§D3/§D5): present ⇒ the bridge synthesizes the Task tool from
   * claude-subagent entries and routes execution through this callback.
   * Absent (tests, nested assemblies, gemini pre-352 if ever gated) ⇒ no
   * Task tool — fail-dark, not fail-broken.
   */
  delegateTurnRunner?: DelegateTurnRunner;
```

`assembleProviderTurn`'s input gains `delegateTurnRunner?: DelegateTurnRunner;`, and the returned object gains `delegateTurnRunner: input.delegateTurnRunner,` (inside the existing try — the callback does no work at assembly time, so construction cannot add assembly-throw surface).

Append the builder:

```typescript
export interface NestedDelegateAssemblyInput {
  config: AgentConfig;
  delegate: string;
  /** The claude-subagent entry (serverConfig + description carriage, §D2). */
  entry: HiveToolInventoryEntry;
  workItemContext?: WorkItemContext;
  /** Parent assembly's resolved sessionCwd — nested builtins share it (§D5.3). */
  sessionCwd: string;
}

/**
 * KPR-354 (§D5.3): pure nested-assembly builder — unit-testable without a
 * manager. Claude parity: the delegate prompt is the subagent's WHOLE system
 * prompt (no datetime trailer, no memory, no constitution — exactly
 * AgentDefinition.prompt on the Claude lane); the tool surface is the
 * delegate's one MCP server + the six executor builtins (Claude subagents
 * inherit builtins). Structural depth-1: the inventory contains no
 * claude-subagent entries and no delegateTurnRunner is set, so a nested
 * bridge can never synthesize Task — the parity twin of
 * disallowedTools: ["Agent"].
 */
export function buildNestedDelegateAssembly(input: NestedDelegateAssemblyInput): {
  assembly: ProviderTurnAssembly;
  maxTurns: number;
} {
  const customPrompt = input.config.delegatePrompts?.[input.delegate];
  const instructions = customPrompt ?? buildGenericDelegatePrompt(input.delegate);
  const maxTurns = customPrompt ? DELEGATE_MAX_TURNS_CUSTOM : DELEGATE_MAX_TURNS_GENERIC;

  const toolInventory: HiveToolInventoryEntry[] = [];
  const serverConfig = input.entry.serverConfig;
  if (serverConfig) {
    // Re-express the delegate at its REAL transport — same derivation rule
    // as AgentRunner.transportKindForServerConfig (http/sse by type, else
    // stdio). Kept inline: importing agent-runner at runtime here would
    // invert the module direction Step 2.3 establishes.
    const transport =
      serverConfig.type === "http" || serverConfig.type === "sse" ? serverConfig.type : "stdio";
    toolInventory.push({
      ...classifyToolTransport({ name: input.entry.name, transport, source: "core" }),
      schemas: { kind: "connect-time" },
      serverConfig,
    });
  } else {
    // Foreign/test inventory without carriage (spec §Edge cases): degraded
    // builtin-only nested surface — contained, never a throw. NAME only.
    log.warn("Delegate entry missing serverConfig — nested turn runs builtin-only", {
      agentId: input.config.id,
      delegate: input.delegate,
    });
  }
  for (const def of BUILTIN_TOOL_DEFINITIONS) {
    if (!EXECUTOR_BACKED_BUILTIN_NAMES.has(def.name)) continue; // all six are — belt-and-suspenders
    toolInventory.push({
      ...classifyToolTransport({ name: def.name, transport: "claude-builtin", source: "sdk-builtin" }),
      schemas: { kind: "static", tools: [def] },
    });
  }

  return {
    assembly: {
      instructions,
      toolInventory,
      // Directive 2 ([D5] spec-review): nothing was partitioned away — the
      // nested inventory is all-bridgeable by construction. Pinned (T4).
      omittedTools: [],
      guardrailGate: buildDefaultGuardrailGate(input.config, input.workItemContext),
      memory: {},
      skillIndex: [],
      inProcessServers: {},
      sessionCwd: input.sessionCwd,
      // NO delegateTurnRunner — structural depth-1 (see doc comment).
    },
    maxTurns,
  };
}
```

- [ ] **Step 2.2: T4 tests (`turn-assembly.test.ts`, additive describe)**

Fixture: a fake `AgentConfig` (reuse the file's existing config factory) with/without `delegatePrompts: { google: "Custom google prompt" }`; a claude-subagent entry fixture with `serverConfig: { type: "stdio", command: "gog-mcp" } as never` and `description: "Gmail + Calendar"`.

  - [ ] custom prompt → `instructions === "Custom google prompt"`, `maxTurns === 7`
  - [ ] no custom prompt → `instructions === buildGenericDelegatePrompt("google")` (and the literal string matches the pre-extraction text verbatim), `maxTurns === 10`
  - [ ] inventory = exactly 7 entries: one `stdio` entry named `google` with `schemas.kind === "connect-time"` and the same `serverConfig` object, + the six builtin static entries (names = Bash/Read/Write/Edit/Glob/Grep, each `schemas.kind === "static"`)
  - [ ] http-typed serverConfig → transport `"http"`; sse → `"sse"`
  - [ ] **directive 2 pin:** `assembly.omittedTools` strictly equals `[]`
  - [ ] no `claude-subagent` entries, `assembly.delegateTurnRunner === undefined`, `skillIndex` `[]`, `inProcessServers` `{}`, `memory` `{}` (structural depth-1 block)
  - [ ] missing `serverConfig` → inventory is builtin-only (6 entries), no throw
  - [ ] `sessionCwd` passed through verbatim
  - [ ] archetyped config (reuse the file's archetype fixture from the `buildDefaultGuardrailGate` describe) → gate is not the allow-all stub (denies per the archetype fixture's rule)
  - [ ] **passthrough pins:** `assembleProviderTurn({... delegateTurnRunner: fn})` → `assembly.delegateTurnRunner === fn`; omitted → `undefined`. Existing `TOOL_EXECUTING_PROVIDERS` pin (`:107`) untouched and green.

- [ ] **Step 2.3: `buildServerSubAgents` consumes the shared constants (`agent-runner.ts:1628-1638`)**

Add to agent-runner's imports (converting the existing type-only turn-assembly import into a value import alongside it):

```typescript
import {
  buildGenericDelegatePrompt,
  DELEGATE_MAX_TURNS_CUSTOM,
  DELEGATE_MAX_TURNS_GENERIC,
  type ProviderSkillIndexEntry,
} from "./provider-adapters/turn-assembly.js";
```

Replace the prompt/maxTurns lines:

```typescript
      // Use custom delegate prompt if available, otherwise generic.
      // KPR-354 (§D5.3): prompt + maxTurns constants shared with the Lane B
      // nested assembly (turn-assembly.ts) — extraction, output-identical.
      const customPrompt = this.agentConfig.delegatePrompts?.[serverName];
      const prompt = customPrompt || buildGenericDelegatePrompt(serverName);

      agents[serverName] = {
        description,
        prompt,
        mcpServers: [{ [serverName]: serverConfig }], // Record form — NOT string reference
        model: "inherit",
        maxTurns: customPrompt ? DELEGATE_MAX_TURNS_CUSTOM : DELEGATE_MAX_TURNS_GENERIC,
        disallowedTools: ["Agent"], // subagents cannot spawn sub-subagents
      };
```

Regression: all existing `buildServerSubAgents` pins (`agent-runner.test.ts:1624-1690`) pass **unmodified** — this is the extraction-is-verbatim proof; no new tests needed here.

- [ ] **Step 2.4: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/turn-assembly.test.ts src/agents/agent-runner.test.ts` → green. Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/provider-adapters/turn-assembly.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/agent-runner.ts
git commit -m "KPR-354: DelegateTurnRunner contract + shared delegate constants + buildNestedDelegateAssembly (D4/D5.3)"
```

---

## Task 3 (Chunk 3): §D3 Task synthesis in the bridge + adapter pass-through

**Files:**
- Modify: `src/agents/provider-adapters/tool-bridge.ts`
- Modify: `src/agents/provider-adapters/tool-bridge.test.ts`
- Modify: `src/agents/provider-adapters/openai-agents-adapter.ts` (+test)
- Modify: `src/agents/provider-adapters/codex-subscription-adapter.ts` (+test)

- [ ] **Step 3.1: Bridge option + fourth partition + `buildTaskTool()` (`tool-bridge.ts`)**

Extend the turn-assembly type import (`:25`): `import type { ProviderSkillIndexEntry, DelegateTurnRunner } from "./turn-assembly.js";`

`ToolBridgeOptions` gains:

```typescript
  /**
   * KPR-354 (§D3): manager-owned nested-turn executor. Present ⇒
   * claude-subagent inventory entries synthesize the Task tool; absent ⇒
   * fail-dark (no Task tool, entries inert).
   */
  delegateRunner?: DelegateTurnRunner;
```

In `connectInner()` (`:123-181`), add the fourth partition after the `builtins` filter:

```typescript
    // KPR-354 (§D3): claude-subagent entries — consumed by Task synthesis
    // ONLY. No MCP connection is opened for them at the parent level.
    const delegates = this.opts.inventory.filter((e) => e.transport === "claude-subagent");
```

and, after the `loadSkill` block, before `applyNameAndCapEdges`:

```typescript
    const taskTool = this.buildTaskTool(delegates);
    if (taskTool) tools.push(taskTool);
```

Add the method (beside `buildLoadSkillTool`):

```typescript
  /**
   * KPR-354 (§D3): ONE Claude-lane-identical Task function tool synthesized
   * from the claude-subagent entries. Name + input schema match the SDK's
   * Task tool (description/prompt/subagent_type) so archetype rules written
   * against `Task` transfer verbatim (KPR-348 name-preservation canon);
   * subagent_type is enum-restricted to the active delegate names. Routed
   * through wrap(): gate-deny, pre-execute abort check, containment, and
   * metering all come free — Task wall time lands in stats.toolMs, so the
   * parent's llmMs correctly excludes nested-turn time. No name collision
   * with the Task BUILTIN entry: that one is claude-only, partition-omitted
   * on Lane B, so this is the only Task in the bridged surface.
   */
  private buildTaskTool(entries: HiveToolInventoryEntry[]): BridgedTool | null {
    const runner = this.opts.delegateRunner;
    if (!runner || entries.length === 0) return null;
    const byName = new Map(entries.map((e) => [e.name, e]));
    const names = [...byName.keys()];
    const listing = entries.map((e) => `- ${e.name} — ${e.description ?? e.name}`).join("\n");
    return this.wrap(
      "Task",
      "Launch a delegate subagent to handle a task using one of your delegated capability MCPs. " +
        "The delegate runs a bounded turn with that server's tools and returns its result.\n" +
        "Available delegates (subagent_type):\n" +
        listing,
      {
        type: "object",
        properties: {
          description: { type: "string", description: "A short (3-5 word) summary of the task" },
          prompt: { type: "string", description: "The task for the delegate to perform" },
          subagent_type: {
            type: "string",
            enum: names,
            description: "The delegate to use (see the list in the tool description)",
          },
        },
        required: ["description", "prompt", "subagent_type"],
        additionalProperties: false,
      },
      async (input) => {
        const args = asRecord(input) as { prompt?: unknown; subagent_type?: unknown };
        const subagentType = args.subagent_type;
        if (typeof subagentType !== "string" || !byName.has(subagentType)) {
          return `Task failed: unknown subagent_type '${String(subagentType)}'. Valid: ${names.join(", ")}`;
        }
        if (typeof args.prompt !== "string" || args.prompt.length === 0) {
          return "Task failed: 'prompt' must be a non-empty string";
        }
        // Runner contract: NEVER throws (D5.7) — wrap()'s catch is
        // belt-and-suspenders on top.
        return await runner({
          delegate: subagentType,
          prompt: args.prompt,
          entry: byName.get(subagentType)!,
          signal: this.opts.signal,
          workItemContext: this.opts.workItemContext,
        });
      },
    );
  }
```

In `applyNameAndCapEdges` (`:396`), extend the pin set + comment:

```typescript
      // KPR-349 §D7 ruling + KPR-354: Tier 0 — the six executor builtins,
      // load_skill, AND Task (≤8 tools) are structurally load-bearing (the
      // toolkit and the Task description claim them) and are NEVER
      // cap-dropped. Tier 1 — everything else (MCP-discovered) keeps
      // inventory order and takes the entire tail-drop.
      const pinnedNames = new Set<string>([...EXECUTOR_BACKED_BUILTIN_NAMES, "load_skill", "Task"]);
```

- [ ] **Step 3.2: One line in each tool-executing adapter**

`openai-agents-adapter.ts` (`:54-63`) and `codex-subscription-adapter.ts` (`:126-135`) — add to the `ToolBridge` construction:

```typescript
      delegateRunner: this.options.assembly.delegateTurnRunner, // KPR-354 (§D3)
```

(`gemini-adk-adapter.ts` untouched — it constructs no bridge; the assembly field is inert there.)

- [ ] **Step 3.3: T3 bridge tests (`tool-bridge.test.ts`, additive describe)**

Fixture helper: `makeSubagentEntry(name, description?)` → a `claude-subagent`-transport `HiveToolInventoryEntry` (use `classifyToolTransport` + `{schemas: {kind: "unavailable"}, serverConfig: {type: "stdio", command: "x"} as never, description}`). Runner spy: `vi.fn(async () => "delegate says hi")`.

  - [ ] entries + runner → `connect()` yields exactly one tool named `Task`; schema deep-equals the Step 3.1 shape with `enum: ["google", "resend"]` (insertion order)
  - [ ] tool description contains one `- <name> — <description>` line per delegate (and falls back to the name when `description` absent)
  - [ ] entries WITHOUT runner → no `Task` tool (fail-dark pin)
  - [ ] runner WITHOUT entries → no `Task` tool
  - [ ] no MCP connection attempted for delegate entries (no `serverConfig`-driven connect: assert connect resolves with zero runtime omissions and only the Task tool when inventory is subagent-only)
  - [ ] execute with valid args → runner called once with `{delegate: "google", prompt: "do it", entry: <the entry>, signal: <bridge signal>, workItemContext: <passed ctx>}`; resolves the runner's text
  - [ ] unknown `subagent_type` → `Task failed: unknown subagent_type 'nope'. Valid: google, resend`; runner NOT called
  - [ ] empty / non-string `prompt` → `Task failed: 'prompt' must be a non-empty string`
  - [ ] gate denying `Task` → `Tool call denied by policy: …`; runner NOT called (wrap() order pin)
  - [ ] pre-aborted signal → `Tool execution aborted (Task).`; runner NOT called
  - [ ] runner rejecting (contract violation) → `Tool execution failed (Task): …` (wrap containment, belt-and-suspenders)
  - [ ] **cap pin:** 130 fixture MCP tools + six builtins + load_skill + Task → survivors include `Task` (and the 7 other pinned); Tier-1 tail dropped. **Negative-verify leg 2 (record output):** remove `"Task"` from `pinnedNames` → this test fails → restore.

- [ ] **Step 3.4: T6 adapter tests**

`openai-agents-adapter.test.ts` (follow the file's existing mocked-run patterns): assembly with one subagent entry + `delegateTurnRunner` spy → the constructed `Agent` receives a tool named `Task` (capture via the mocked `@openai/agents` `Agent`/`tool` seam the suite already uses); invoking the captured tool's execute with valid args reaches the runner spy.

`codex-subscription-adapter.test.ts` (use `makeAdapter`/`makeAssembly`/`sse()`): assembly with one subagent entry + runner → first POST body's `tools` array contains `{type: "function", name: "Task", strict: false, …}` with the enum schema; a scripted `function_call` SSE round naming `Task` with valid JSON args dispatches to the runner and the round-2 POST carries its text as `function_call_output`. Existing runner-less suites pass unmodified (this IS the absent-runner pin on the codex surface).

- [ ] **Step 3.5: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts` → green. Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/openai-agents-adapter.ts src/agents/provider-adapters/openai-agents-adapter.test.ts src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.test.ts
git commit -m "KPR-354: Task synthesis in the bridge (one Claude-identical tool, cap-pinned) + adapter delegateRunner pass-through (D3)"
```

---

## Task 4 (Chunk 4): §D5 the nested-turn runner — THE LIGHT-UP

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/agents/agent-manager.test.ts` (additive)

- [ ] **Step 4.1: Build the callback in `createProviderAdapter`'s Lane B branch (`agent-manager.ts:551-562`)**

Extend the turn-assembly import (`:37`):

```typescript
import {
  assembleProviderTurn,
  buildNestedDelegateAssembly,
  type DelegateTurnRunner,
  type ProviderTurnAssembly,
} from "./provider-adapters/turn-assembly.js";
```

Replace the `const assembly = await assembleProviderTurn({...})` block with:

```typescript
    // KPR-354 (§D5): manager-owned nested-turn runner for delegate
    // subagents. Built BEFORE assembly and carried on it as an opaque
    // callback (provider-blindness canon — provider resolution and budget
    // machinery stay here). The body runs only inside the parent adapter's
    // runTurn, after `parentAssembly` is assigned below. NEVER throws —
    // every path resolves model-visible text (D5.7); tool faults stay
    // breaker-invisible (no breaker acquire/record anywhere in the body).
    let parentAssembly: ProviderTurnAssembly | undefined;
    const delegateTurnRunner: DelegateTurnRunner = async (call) => {
      const startedAt = Date.now();
      // D5.1 + D5.2 (spec-review directive 3): stop check and budget
      // check-and-increment are SYNCHRONOUS with no await between them —
      // atomic under parallel openai Task calls (no interleaving without an
      // await point). Denials never increment.
      if (this.stoppedAgents.has(agentId)) {
        return "Task denied: agent is stopped.";
      }
      const active = this.activeSpawnCount.get(agentId) ?? 0;
      const budget = this.spawnBudgetFor(agentId);
      if (active >= budget) {
        this.recordSaturation(agentId, active, budget);
        return `Task denied: spawn budget exhausted (${active}/${budget}). Retry later or proceed without the delegate.`;
      }
      this.activeSpawnCount.set(agentId, active + 1);
      // Slot held from here; released in the finally (withSpawnTicket's
      // delete-at-zero idiom). Deliberately NOT touched (D5.2 + directive 2):
      // the per-thread lock (the parent holds agentId:threadId for the whole
      // outer turn — a nested wait would deadlock permanently; same-thread
      // serialization is a message-level concern the parent already
      // provides), lastSpawnAt, updateStatus, breaker acquire/record,
      // sessionStore, reflection scheduling.
      let removeAbortListener: (() => void) | undefined;
      try {
        const { assembly: nestedAssembly, maxTurns } = buildNestedDelegateAssembly({
          config,
          delegate: call.delegate,
          entry: call.entry,
          workItemContext: call.workItemContext,
          sessionCwd: parentAssembly?.sessionCwd ?? "",
        });
        let nested: AgentProviderAdapter;
        if (route.provider === "openai") {
          nested = new OpenAIAgentsAdapter({
            name: `${config.name}:${call.delegate}`,
            model: route.model || appConfig.openai.agentModel || "gpt-5.4-mini",
            assembly: nestedAssembly,
          });
        } else if (route.provider === "codex") {
          nested = new CodexSubscriptionAdapter({
            name: `${config.name}:${call.delegate}`,
            model: route.model || appConfig.codex.agentModel,
            reasoningEffort: route.reasoningEffort,
            assembly: nestedAssembly,
            // NO historyStore / agentId (G4): the KPR-353 wiring then skips
            // replay and persist by construction — provider_turn_history is
            // provably untouched by nested turns.
          });
        } else {
          // gemini pre-KPR-352: its adapter advertises zero tools, so the
          // bridge never synthesizes Task — unreachable; contained anyway.
          return `Delegate turn failed (${call.delegate}): provider ${route.provider} does not execute tools`;
        }
        if (call.signal.aborted) return `Delegate turn aborted (${call.delegate}).`;
        // D5.5 (spec-review directive 1): the listener body is try/caught —
        // an abort() throw inside EventTarget dispatch would NOT surface
        // through this async frame and would escape all containment; the
        // never-throws contract is structural, not assumed.
        const onAbort = () => {
          try {
            nested.abort();
          } catch (err) {
            log.warn("Nested delegate abort threw — contained (KPR-354 D5.5)", {
              agentId,
              delegate: call.delegate,
              error: String(err),
            });
          }
        };
        call.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => call.signal.removeEventListener("abort", onAbort);
        const result = await nested.runTurn({
          prompt: call.prompt,
          workItemContext: call.workItemContext,
          // Only maxTurns is consumed on Lane B (openai run options + codex
          // round budget); timeoutMs/budgetUsd are Claude-lane concepts —
          // neutral values.
          resourceLimits: { maxTurns, timeoutMs: 600_000, budgetUsd: 0 },
        });
        // D5.8: one info log keyed on the ROUTE provider (resolved-provider
        // attribution canon). Nested usage is logged, not folded into the
        // parent RunResult (⚠ spec Key Points; costUsd is 0 on both Lane B
        // surfaces anyway).
        log.info("Nested delegate turn complete", {
          agentId,
          provider: route.provider,
          delegate: call.delegate,
          durationMs: Date.now() - startedAt,
          toolCalls: result.toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          ...(result.error ? { error: result.error } : {}),
        });
        // D5.7 result shaping (never throws). Nested sessionId DISCARDED;
        // sessionStore untouched (G4).
        if (result.aborted) return `Delegate turn aborted (${call.delegate}).`;
        if (result.error) return `Delegate turn failed (${call.delegate}): ${result.error}`;
        return result.text || `Delegate '${call.delegate}' returned no output.`;
      } catch (err) {
        // Belt-and-suspenders (D5.7): the runner contract is never-throws.
        return `Delegate turn failed (${call.delegate}): ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        removeAbortListener?.();
        const next = (this.activeSpawnCount.get(agentId) ?? 1) - 1;
        if (next <= 0) this.activeSpawnCount.delete(agentId);
        else this.activeSpawnCount.set(agentId, next);
      }
    };

    const assembly = await assembleProviderTurn({
      runner,
      config,
      provider: route.provider,
      workItemContext,
      delegateTurnRunner,
    });
    parentAssembly = assembly;
```

(`AgentProviderAdapter` type is already imported in this file — verify; add to the existing `./provider-adapters/types.js` type import if not.)

- [ ] **Step 4.2: T5 + T8 tests (`agent-manager.test.ts`, additive describe `"KPR-354 nested delegate turns"`)**

Harness recipe: `makeAgentConfig({ model: "openai/gpt-5.4-mini", delegateServers: ["google"] })` (and codex variant); `mockRunnerToolInventory` returns an inventory containing one claude-subagent entry (with `serverConfig` + `description`) so the REAL `assembleProviderTurn` partitions it bridgeable; run one `spawnTurn` (parent — `mockOpenAIRunTurn` resolves immediately) and capture `runner = mockOpenAIConstructor.mock.calls[0][0].assembly.delegateTurnRunner`. Invoke `runner({delegate: "google", prompt: "p", entry, signal: new AbortController().signal})` directly. Nested constructions are the 2nd+ constructor calls (`options.name === "TestAgent:google"`).

  1. [ ] happy path: nested `mockOpenAIRunTurn` resolves `makeRunResult({text: "delegate output"})` → runner resolves `"delegate output"`; nested constructor got `name: "<agent>:google"`, the parent route's model, and an assembly whose `instructions` match the delegate prompt and whose `delegateTurnRunner` is `undefined`
  2. [ ] empty text → `Delegate 'google' returned no output.`; error result → `Delegate turn failed (google): <err>`; aborted result → `Delegate turn aborted (google).`
  3. [ ] nested `runTurn` REJECTS → runner resolves `Delegate turn failed (google): …` (never-rejects pin) AND the slot is released (snapshot `activeSpawns` back to baseline). **Negative-verify leg 3 (record output):** remove the finally decrement → this fails → restore.
  4. [ ] **directive 3 pin (atomicity):** config `spawnBudget: 2`, nested runTurn returns a hanging deferred → call the runner 3 times synchronously (no awaits between) → exactly 2 nested constructions, third call resolves the denial text; `recordSaturation` observable via snapshot `saturationCount`; resolve the deferreds → all settle, `activeSpawns` returns to 0
  5. [ ] saturation denial does NOT leak: after a denial, snapshot `activeSpawns` unchanged
  6. [ ] stopped agent (`manager.stopAgent(id)` then invoke) → `Task denied: agent is stopped.`; no nested construction
  7. [ ] abort chain: hanging nested turn; fire the passed AbortController → `mockOpenAIAbort` called; resolve nested with `aborted: true` → runner resolves aborted text. Pre-aborted signal → aborted text with NO nested construction.
  8. [ ] **directive 1 pin (abort-throw containment):** `mockOpenAIAbort` throws; fire abort during a hanging nested turn → no unhandled error (test completes), runner still resolves after the nested deferred settles. **Negative-verify leg 4 (record output):** remove the listener try/catch → worker-level uncaught error fails the test → restore.
  9. [ ] **directive 2 pin:** `getSnapshot().perAgent[id].lastSpawnAt` identical before/after a full nested run (parent completed first, so the parent's stamp is the baseline); `getState(id)!.status` stays `"idle"` while a nested turn is in flight (no parent in flight)
  10. [ ] snapshot visibility: during a hanging nested turn, `activeSpawns` is 1
  11. [ ] codex parent (manager constructed WITH a fake `turnHistoryStore`): nested `mockCodexConstructor` options have `historyStore: undefined`, `agentId: undefined`, `reasoningEffort` = route's; store spies (`load`/`append`/`clear`) never called by the nested invocation; `sessionStore.set` spy never called by the nested invocation
  12. [ ] **T8 breaker neutrality:** runner resolving `Delegate turn failed (google): 500 Internal Server Error` — assert the breaker record spy (existing `circuitBreakers` seam in the suite) receives nothing from the runner invocation itself, and `classifyTurnResult(makeRunResult({text: "…failed…500…"}))` classifies success (fault lives in tool text only)

- [ ] **Step 4.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts` → all existing + new green. Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-354: manager-owned nested-turn runner — budget-slotted, lock-exempt, abort-chained, never-throws (D5) — delegate subagents live on openai/codex"
```

---

## Task 5 (Chunk 5): §D6 Lane B toolkit delegates subsection

**Files:**
- Modify: `src/agents/toolkit-section.ts`
- Modify: `src/agents/toolkit-section.test.ts`

- [ ] **Step 5.1: Render the fourth subsection in `buildProviderToolkitSection` (`toolkit-section.ts:239-283`)**

Correct the `ProviderToolkitInput.toolInventory` doc comment (`:217-219`) to:

```
  /** PARTITIONED inventory (assembly.toolInventory) — claude-only entries
   *  never reach this function; claude-subagent entries DO post-KPR-354
   *  (bridgeable — rendered as the delegates subsection). */
```

In the function body, add `const delegateLines: string[] = [];` beside the other accumulators; replace the trailing `// claude-subagent: unreachable…` comment with a real branch (place it FIRST in the loop, mirroring the claude-builtin early-continue style):

```typescript
    if (entry.transport === "claude-subagent") {
      // KPR-354 (§D6): now-bridgeable delegates — via-Task framing.
      delegateLines.push(formatToolkitLine(entry.name, resolveCatalogEntry(entry.name, input.plugins)));
      continue;
    }
```

and after the capability section push:

```typescript
  if (delegateLines.length > 0) {
    sections.push(
      "### Delegated capability MCPs (via the Task tool)\n" + delegateLines.join("\n"),
    );
  }
```

Update the function's doc-comment "Omitted" bullet: the delegated-MCPs section is no longer omitted (KPR-354); the deferred-loading hint remains Claude-CLI-only.

- [ ] **Step 5.2: T7 tests (`toolkit-section.test.ts`)**

  - [ ] Invert `:409` ("skips unavailable-schema builtins and claude-subagent entries"): unavailable-schema builtins still skipped (unchanged half); a claude-subagent entry now renders `### Delegated capability MCPs (via the Task tool)` with its `formatToolkitLine` line (catalog-known name → catalog blurb; unknown name → name-as-description fallback)
  - [ ] no claude-subagent entries → no delegates section (today's output byte-identical — pin the full-string case the suite already uses)
  - [ ] Claude-lane `buildToolkitSection` suites pass unmodified (zero edits to that function)

- [ ] **Step 5.3: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/toolkit-section.test.ts src/agents/prefix-builder.test.ts src/agents/agent-runner.test.ts` → green (prefix/golden untouched). Then `npm run check` (env stubs) → exit 0.

```bash
git add src/agents/toolkit-section.ts src/agents/toolkit-section.test.ts
git commit -m "KPR-354: Lane B toolkit — delegates subsection (via the Task tool) from claude-subagent entries (D6)"
```

---

## Task 6 (Chunk 6): §D8 documentation riders + closing verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 6.1: CLAUDE.md riders**

In the **Provider adapters** section's pilot-adapters paragraph, after the KPR-353 codex sentence, insert:

```
Delegate subagents run on both tool-executing surfaces (KPR-354): the bridge synthesizes one Claude-identical `Task` tool from the agent's `delegateServers`, and executing it runs a nested same-provider adapter turn (delegate prompt, that server + the six executor builtins, maxTurns 7/10 parity) through a manager-owned runner — budget-accounted against `spawnBudget` (delegates on Lane B need `spawnBudget ≥ 2`; default 5 is fine), lock-exempt, abort-chained, session-less/history-less (nested codex gets no historyStore), breaker-invisible (nested provider faults surface as Task tool text). General-purpose Task subagents (arbitrary `subagent_type`) remain claude-only.
```

Update any remaining "Task-shaped tools are omitted from non-Claude inventories" language in that section to reflect the flip (delegate entries now classify `requires-hive-bridge`; the honest remaining delta is general-purpose subagents). Matrix row facts land in child 10 — no matrix edits here.

- [ ] **Step 6.2: Zero-edit-files check + full gate**

```bash
git diff main...HEAD --stat -- src/agents/provider-adapters/types.ts src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/builtin-executor.ts src/agents/provider-adapters/archetype-gate.ts src/agents/provider-adapters/skill-index.ts src/agents/provider-adapters/gemini-adk-adapter.ts src/agents/provider-adapters/claude-agent-adapter.ts src/agents/provider-adapters/passthrough-providers.ts src/agents/session-store.ts src/agents/turn-history-store.ts src/agents/prefix-builder.ts
```

Expected: empty output (adjust the base ref to the epic branch if `main` differs in the worktree). Then the full gate:

`SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.

Confirm all four negative-verify legs were run and their failing outputs recorded in the task log (legs 1–4 live in Tasks 1, 3, 4, 4).

- [ ] **Step 6.3: Commit**

```bash
git add CLAUDE.md
git commit -m "KPR-354: docs — delegate subagents on openai/codex via nested adapter turns (D8 riders)"
```
