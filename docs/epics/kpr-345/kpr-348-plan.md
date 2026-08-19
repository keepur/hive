# KPR-348 Implementation Plan — OpenAI tool bridge: MCP stdio/http, in-process function tools, builtin executor, guardrail gate

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-348-spec.md](./kpr-348-spec.md) (final-round approved @ 7355bc3) — the contract. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D4/§D7. Baseline: KPR-347 merged @ e774260 (all anchors below verified against this worktree).

**Goal:** Make `openai/…` turns execute real hive tools across four transport classes (stdio MCP, http/sse MCP, sdk-in-process, claude-builtin) through one gated, contained, metered dispatch wrapper, with the guardrail gate performing real archetype PreToolUse evaluation.

**Architecture:** A new per-spawn `ToolBridge` (`src/agents/provider-adapters/tool-bridge.ts`) consumes `assembly.toolInventory`, connects each transport as an MCP *client* (never `Agent.mcpServers`), and produces provider-neutral `BridgedTool[]` whose `execute` enforces gate → execute → containment → metrics. A new `BuiltinExecutor` supplies Bash/Read/Write/Edit/Glob/Grep with agent-facing-contract semantics. `assembleProviderTurn` gains in-process server carriage + session cwd; `buildDefaultGuardrailGate`'s deny-all body is replaced by a port of `buildHooks`' archetype evaluation. The OpenAI adapter binds `BridgedTool[]` → Agents SDK `tool()` → `Agent.tools` and reports honest tool telemetry.

**Tech Stack:** TypeScript strict, `@openai/agents` 0.11.x (MCP server client classes from `@openai/agents-core` re-exports), `@modelcontextprotocol/sdk` (`Client` + `InMemoryTransport`), `@anthropic-ai/claude-agent-sdk` types (`McpServerConfig`, `McpSdkServerConfigWithInstance`, `HookCallbackMatcher`), vitest, `tinyglobby` (new dep, declared in spec §D5).

**Decision-register canon (epic, 7 entries) honored:** (1) schemas connect-time / static-for-builtins — Task 2.5; (2) codex column ≡ openai at the classify site — Task 2.4; (3) `SESSION_SEMANTICS` untouched — no task touches it; (4) `ProviderTurnAssembly` payload + `TurnAssemblyError` containment — Step 2.8; (5) manager-owned early abort done, this ticket owns only mid-bridge abort — Steps 1.1/2.2/3.4; (6) gate predicate canon, deny-all body → real archetype evaluation — Task 3.1; (7) `prepareSpawn` gap out of scope — nowhere in this plan.

**Final-review advisories reflected:** (1) `close()` per-server catch-and-log never-throw + T5 asserts a faulting `close()` doesn't reject `runTurn` — Step 1.1 (code) and 3.4 (test); (2) `llmMs = Math.max(0, durationMs - toolMs)` clamp — Step 3.2 (code) with the pin in Step 3.4 (test).

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `tool-bridge.ts` (wrapper containment, result shaping, name/cap edges, fail-soft connect, close-never-throw), `builtin-executor.ts` (all six tool contracts), `archetype-gate.ts` (gate port parity), `tool-transport.ts` (classifier changes), `session-cwd.ts`, `turn-assembly.ts` (new fields + gate body).
  - Reason: this ticket's headline obligations (exception containment, gate parity, abort) are unit-testable contracts; the epic §D4 invariant must be pinned structurally.
  - Minimum assertions: the T1–T9 blocks in "Critical Flows" below, each mapped to a task.

- Integration: **required**
  - Scope: (a) bridge ↔ real `createSdkMcpServer` fixture over `InMemoryTransport` (T6); (b) `OpenAIAgentsAdapter.runTurn` with mocked model transport driving real bridge dispatch (T7); (c) breaker-neutrality seam: repeated tool-throw turns through `classifyTurnResult` + a real `ProviderCircuitBreaker` instance stay closed (T1 seam half); (d) `buildInProcessServers` extraction equivalence on a constructed `AgentRunner` (T8).
  - Reason: containment and telemetry only mean something across the adapter/bridge/classifier boundary; the extraction must be proven behavior-preserving on the Claude lane.
  - Harness: **existing** — vitest beside source; adapter tests already mock `@openai/agents` (`openai-agents-adapter.test.ts:11-31`); runner tests exist (`agent-runner.test.ts` exercises `buildToolTransportInventory`); breaker harness exists (`provider-circuit-breaker` tests).
  - Minimum assertions: T1 (all four throw sites + negative-verify + breaker-closed), T5 (abort mid-bridge, faulting close), T6, T7 (incl. streamed variant + llmMs pin), T8.

- E2E: **required** (manual, evidence-recorded — not in `npm run check`)
  - Scope: T0a spike legs (live `MCPServerStdio` vs real hive stdio servers; hosted Slack MCP auth handshake) and T0b (one live `openai/…` turn with a bridged MCP tool + a builtin + an abort mid-Bash).
  - Reason: Gate 1 delegated assumption (a) — the two blocking spec assumptions are docs/source-verified only; provider docs churn. No mock can prove the live handshake.
  - Harness: **setup-required** — dev Mac with `npm ci` in this worktree, `npm run build` for `dist/` server entry points, `SLACK_MCP_TOKEN` from Honeypot (`security find-generic-password -s "hive/dodi/SLACK_MCP_TOKEN" -w`), Codex OAuth at `~/.codex/auth.json` for the live model call. If any credential is unavailable, that is a **concrete blocker to report**, not a skip.
  - Minimum assertions: every leg in Task 0 with its listed expected evidence; T0b in Task 4.

### Critical Flows

- T1 exception containment: throwing gate / in-process handler / builtin / MCP `callTool` ⇒ structured error text, `runTurn` resolves, `RunResult.error` unset, `classifyTurnResult` → success, breaker stays closed; negative-verify that an unwrapped throw *does* reject.
- T2 gate port parity: software-engineer archetype — workspace Edit deny (reason steers to `code_task`), outside-workspace allow, Bash allow, NotebookEdit path extraction, assembly-time throw → deny-all, call-time throw → deny, matcher regex honored, archetype-less allow-all; negative-verify vs pre-348 deny-all body.
- T3 builtin executor agent-facing semantics (all six tools).
- T4 bridge materialization: names, normalized schemas, claude-only never materialized, fail-soft + `runtimeOmissions`, no env values in logs; `load_skill` present/absent by skill-index emptiness, valid-name content return, unknown-name and non-string-name contained errors.
- T5 abort mid-bridge: process-group kill, in-flight results discarded, `close()` on every server on every path, faulting `close()` never rejects, no unhandled rejections.
- T6 in-process InMemory round-trip incl. `*ContextRef` visibility.
- T7 adapter integration: gate consulted → executed → result to model; `stats` → `RunResult`; zero-tools pin inverted for openai only; `llmMs = durationMs - toolMs` pin; streamed variant.
- T8 inventory/classifier: per-tool builtins, six `{static, requires-hive-bridge}` with codex ≡ openai, extraction equivalence.
- T9 name sanitize/truncate + >128-tool cap.

### Regression Surface

- **Claude lane byte-identical:** `AgentRunner.send()` behavior unchanged (extraction is pure motion); `buildHooks` untouched; prompt/prefix assembly untouched. Existing `agent-runner.test.ts`, `prefix-builder.test.ts` must pass unmodified.
- **Gemini/codex stubs untouched:** their zero-tools pins (`gemini-adk-adapter.test.ts`, `codex-subscription-adapter.test.ts`) keep passing with zero edits.
- **Sessions:** `SESSION_SEMANTICS`, `previousResponseId`, `extractSessionId` untouched (canon 3) — existing adapter session tests pass unmodified.
- **Breaker:** `error-classification.test.ts`, `provider-circuit-breaker` tests pass unmodified.
- **`turn-assembly.test.ts`:** existing assertions keep passing; the two KPR-347 deny-all assertions are *moved*, not deleted (they become T2's "assembly-throw ⇒ deny-all" and archetype-less allow cases — see Task 3.1).

### Commands

- Unit + integration (fast loop): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters src/agents/session-cwd.test.ts src/agents/agent-runner.test.ts`
- E2E: manual spike scripts (Task 0 / Task 4), evidence recorded in `docs/epics/kpr-345/kpr-348-spike-notes.md`.
- Broader regression / gate (every chunk commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
  Expected: typecheck + lint + format + all vitest suites green, exit 0.

### Harness Requirements

- `npm ci` in this worktree (no `node_modules` present at branch point).
- `npm run build` before spike legs that spawn `dist/*.js` stdio servers.
- Dev-Mac-only for T0a/T0b: macOS Keychain (keychain server), Honeypot `SLACK_MCP_TOKEN`, Codex OAuth. Node 22/24 (dev-mode Node 26 is broken per KPR-344 — CLAUDE.md).
- Unit/integration tests must run with **no** live credentials and no network (mocked transports; fixture in-process servers).
- T5 tests arm a `process.on("unhandledRejection")` probe for the duration of the test and assert it never fires.

### Non-Required Rationale

- (none — all three groups required.)

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Negative-verify discipline (operator standard): for T1's unwrapped-throw case and T2's deny-all revert case, actually run the test against the weakened code and record that it fails, before restoring.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/epics/kpr-345/kpr-348-spike-notes.md` | create | Committed spike evidence (T0a in Task 0, T0b appended in Task 4) + recorded spike decisions |
| `src/agents/provider-adapters/tool-bridge.ts` | create | Provider-neutral bridge core: transports, dispatch wrapper, containment, stats, lifecycle, `load_skill`, name/cap edges |
| `src/agents/provider-adapters/tool-bridge.test.ts` | create | T1 (bridge half), T4, T5 (bridge half), T6, T9 |
| `src/agents/provider-adapters/builtin-executor.ts` | create | Six builtin function tools: static schemas (`BUILTIN_TOOL_DEFINITIONS`) + `BuiltinExecutor` (process-group lifecycle) |
| `src/agents/provider-adapters/builtin-executor.test.ts` | create | T3, T5 (Bash-kill half) |
| `src/agents/provider-adapters/archetype-gate.ts` | create | Port of `buildHooks` archetype evaluation → `GuardrailGate` |
| `src/agents/provider-adapters/archetype-gate.test.ts` | create | T2 |
| `src/agents/session-cwd.ts` | create | Shared cwd resolution (mkdir/stat semantics) — single drift point for both lanes |
| `src/agents/session-cwd.test.ts` | create | cwd helper contract |
| `src/agents/provider-adapters/tool-transport.ts` | modify | Per-tool builtin names; executor-backed classify branch (codex ≡ openai; gemini upgraded for classification honesty) |
| `src/agents/provider-adapters/tool-transport.test.ts` | modify | T8 classifier half |
| `src/agents/agent-runner.ts` | modify | Extract `buildInProcessServers` (behavior-preserving); builtin inventory `static` schemas; use shared cwd helper; new `resolveTurnCwd` |
| `src/agents/agent-runner.test.ts` | modify | T8 extraction-equivalence + inventory assertions |
| `src/agents/provider-adapters/turn-assembly.ts` | modify | `inProcessServers` + `sessionCwd` fields (inside `TurnAssemblyError` try); gate body delegates to archetype-gate |
| `src/agents/provider-adapters/turn-assembly.test.ts` | modify | New-field assertions; deny-all assertions relocated per Task 3.1 |
| `src/agents/provider-adapters/openai-agents-adapter.ts` | modify | Bridge lifecycle in `runTurn`, `tools` binding, stats → `RunResult`, `llmMs` exclusion, abort-to-bridge |
| `src/agents/provider-adapters/openai-agents-adapter.test.ts` | modify | T1 (seam half), T5 (adapter half), T7 |
| `package.json` / `package-lock.json` | modify | add `tinyglobby` |

**NOT touched (spec Integration table):** `gemini-adk-adapter.ts`, `codex-subscription-adapter.ts`, `types.ts`, `agent-manager.ts`, `buildHooks` / prompt assembly in `agent-runner.ts`, `SESSION_SEMANTICS`, `runWithAuthFallback`.

---

## Task 0: Step 0 — the spike (⚠ gate for Tasks 1–4)

**Files:**
- Create: `docs/epics/kpr-345/kpr-348-spike-notes.md`

Spike scripts are throwaway drivers written to the session scratchpad (not committed); the notes file records each script verbatim (fenced) plus its observed output. The two **blocking** assumptions (spec §Open assumptions) must pass or the fallback decision must be recorded before any dependent chunk starts.

- [ ] **Step 0.1: Install + build**

Run:
```bash
cd /path/to/worktree && npm ci && npm run build
```
Expected: clean install, `tsc` exits 0, `dist/keychain/keychain-mcp-server.js` and `dist/background/background-task-mcp-server.js` exist.

- [ ] **Step 0.2: S1 — `MCPServerStdio` fidelity vs real hive stdio servers**

Driver script (tsx, scratchpad). Import check is itself evidence: confirm `MCPServerStdio` / `MCPServerStreamableHttp` / `MCPServerSSE` are importable from `"@openai/agents"` (the core re-export). If not, record the exact working import path (`@openai/agents-core`) and note that Task 1 must add it as an explicit dependency (pin same minor as `@openai/agents`'s own).

```ts
// spike-s1.ts — run: npx tsx spike-s1.ts
import { MCPServerStdio } from "@openai/agents";

async function connectServer(name: string, command: string, args: string[], env: Record<string, string>) {
  const server = new MCPServerStdio({
    name,
    command,
    args,
    env,
    cacheToolsList: true,
    clientSessionTimeoutSeconds: 30, // record: does the option exist? unit?
  });
  await server.connect();
  return server;
}

const t0 = Date.now();
// Real hive configs, verbatim from buildAllServerConfigs (agent-runner.ts:509-516, :729-745):
const keychain = await connectServer("keychain", "node", ["dist/keychain/keychain-mcp-server.js"], {
  KEYCHAIN_SERVICE: "hive/dodi",
});
const background = await connectServer("background", "node", ["dist/background/background-task-mcp-server.js"], {
  BG_TASK_API: "http://127.0.0.1:9999", BG_AUTH_TOKEN: "spike", BG_AGENT_ID: "spike",
  BG_ADAPTER_ID: "", BG_CHANNEL_ID: "", BG_CHANNEL_KIND: "internal", BG_CHANNEL_LABEL: "",
  BG_THREAD_ID: "", BG_SLACK_TS: "", BG_SLACK_THREAD_TS: "",
});
// third concurrent server: keychain again under a different name (concurrency leg)
const keychain2 = await connectServer("keychain2", "node", ["dist/keychain/keychain-mcp-server.js"], {
  KEYCHAIN_SERVICE: "hive/dodi",
});
console.log("3-server concurrent connect ms:", Date.now() - t0);

for (const s of [keychain, background, keychain2]) {
  const tools = await s.listTools();
  console.log(s.name, "tools:", tools.map((t: { name: string }) => t.name));
  console.log(s.name, "first schema:", JSON.stringify(tools[0]?.inputSchema));
}
// callTool round-trip (read-only): keychain list tool (use the actual tool name from listTools output)
const result = await keychain.callTool("keychain_list", {});
console.log("callTool result shape:", JSON.stringify(result).slice(0, 500));

// env-inheritance leg: server sees merged default env (HOME/PATH) — keychain's `security`
// invocation succeeding IS the evidence (it needs PATH); record explicitly.
console.log("child pids before close:"); // then: ps -ef | grep mcp-server in another terminal
await Promise.all([keychain.close(), background.close(), keychain2.close()]);
// orphan check: after close, `pgrep -f keychain-mcp-server` must return nothing
```

Record in notes:
  - [ ] import path that works for the MCP server classes
  - [ ] connect + `listTools` + `callTool` round-trip transcript for both real servers
  - [ ] schema sample from each server's `tools/list` (for S4)
  - [ ] concurrency: 3 servers connected in parallel without interference
  - [ ] env: explicit vars won; inherited HOME/PATH present (keychain `security` call worked)
  - [ ] `close()` leaves no orphan (`pgrep -f mcp-server` empty; ps output pasted)
  - [ ] exact constructor option names/types accepted (from the installed `node_modules/@openai/agents-core/dist/mcp.d.ts`, paste the option interface)

- [ ] **Step 0.3: S2 — hosted Slack MCP via `MCPServerStreamableHttp` + `requestInit` auth**

```ts
// spike-s2.ts
import { MCPServerStreamableHttp } from "@openai/agents";
const token = process.env.SLACK_MCP_TOKEN; // sourced: security find-generic-password -s "hive/dodi/SLACK_MCP_TOKEN" -w
const server = new MCPServerStreamableHttp({
  name: "slack",
  url: "https://mcp.slack.com/mcp",
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
  cacheToolsList: true,
  clientSessionTimeoutSeconds: 30,
});
await server.connect();
const tools = await server.listTools();
console.log("slack tools:", tools.map((t: { name: string }) => t.name));
// one read-only call, e.g. a search/list tool from the listed surface
await server.close();
```
Record: connect succeeded with 200s (not 401), tool list, one read-only `callTool` transcript. **This is blocking assumption (b)** — if the handshake fails, record the failure mode and the fallback decision (raw `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` with the same `requestInit` — the exact lib the shim wraps).

- [ ] **Step 0.4: S3 — timeout UNITS confirmation**

Two halves, both recorded:
1. **Source:** paste from installed `node_modules/@openai/agents-core/dist/mcp.d.ts` the declaration + doc comment for `clientSessionTimeoutSeconds` (expected: seconds) and trace where the per-call timeout knob lives — construction option and/or `callTool` — down to `@modelcontextprotocol/sdk` `RequestOptions.timeout` (expected: milliseconds). Paste the shim lines that thread it.
2. **Live:** stdio fixture server (scratch script) whose only tool sleeps 3 s; connect with the smallest per-call timeout knob set to `1500`. If units are ms → call fails at ~1.5 s (correct); if seconds → call succeeds (wrong interpretation). Record which knob, which unit, observed latency.

Deliverable: a two-line canon in the notes, e.g. `clientSessionTimeoutSeconds: SECONDS (session RPCs)` / `<knob>: MILLISECONDS (per tool call)`, plus exactly how Task 1's constants must be passed.

- [ ] **Step 0.5: S4 — schema-normalization sampling + `tool()` acceptance**

Using S1/S2 schema dumps plus in-process samples (run a scratch script that instantiates `createSdkMcpServer`-based fixtures or dumps `buildToolTransportInventory` schemas via an in-memory client — the T6 fixture pattern from Task 1 works here):
  - [ ] tally which fleet schemas lack `required` and/or `additionalProperties`
  - [ ] feed one raw and one normalized (`required: []`, `additionalProperties: false` filled) schema to Agents SDK `tool({..., parameters: schema, strict: false})` and run a **live** minimal `openai/…` agent turn (Codex OAuth creds via existing `createCodexOpenAITokenProvider` path, or `OPENAI_API_KEY` if set for the spike only) that calls the tool once
  - [ ] record: does `tool()` accept plain JSON schema with `strict: false`? Are normalized defaults required or merely tolerated?

S4 is the plan's one **non-blocking** spike leg (unlike the S1/S2 blocking pair): if the Codex OAuth token at `~/.codex/auth.json` is stale at spike time, the live-turn half of S4 may be evidence-deferred to Task 4's T0b (Step 4.1) rather than gating Tasks 1-3 — record the deferral explicitly in the notes file if taken. S1/S2 have no such deferral; a failed blocking leg (with a failed fallback) is a STOP per Step 0.7.

- [ ] **Step 0.6: S5 — `getAllMcpTools` vs hand-rolled decision**

Default (this plan's chosen path): **hand-rolled** — the bridge calls `listTools`/`callTool` itself and builds `tool()` per discovered schema. Flip to `getAllMcpTools` + `FunctionTool.invoke` decoration **only if** S4 shows the SDK's non-strict `tool()` path rejects fleet schemas that its internal converter accepts. Record the decision + evidence in the notes. (`BridgedTool` hides the choice either way — spec §D2.)

- [ ] **Step 0.7: Record spike-outcome dependency table + commit**

The notes file must end with this table filled in (it is the contract later chunks read):

| Spike leg | Outcome consumed by | If green (default path) | If red (fallback) |
|---|---|---|---|
| S1 stdio fidelity | Task 1.1 transport layer | `MCPServerStdio` from `@openai/agents` | Bridge speaks raw MCP `Client` + `StdioClientTransport` (`@modelcontextprotocol/sdk`) — swap contained in `McpConnection` impls, `BridgedTool` unchanged |
| S1 import path | Task 1.1 imports | import from `@openai/agents` | add explicit `@openai/agents-core` dep, import from it |
| S2 hosted auth | Task 1.1 http transport | `MCPServerStreamableHttp` + `requestInit` | raw `StreamableHTTPClientTransport` + `requestInit`, same containment |
| S3 units | Task 1.1 constants | constants passed as recorded units at recorded knobs | n/a (units are facts; code follows the record) |
| S4 schema acceptance | Task 1.1 normalization + Task 3.2 binding | normalize-and-pass with `strict: false` | per-server fail-soft omission for rejects; wholesale reject → S5 flip |
| S5 conversion | Task 1.1 / 3.2 | hand-rolled `tool()` | `getAllMcpTools` + invoke decoration inside the bridge |
| Per-turn spawn cost | matrix note only | note observed connect ms | if materially worse than Claude-lane per-query spawn: follow-up ticket, not this one |

```bash
git add docs/epics/kpr-345/kpr-348-spike-notes.md
git commit -m "KPR-348: step 0 spike — MCP transport fidelity evidence + decisions"
```

**STOP condition:** if S1 or S2 fails AND its fallback also fails live, report BLOCKED with the transcript — do not proceed to Task 1.

---

## Task 1 (Chunk 1): Bridge core — transports, dispatch wrapper, containment, lifecycle

**Files:**
- Create: `src/agents/provider-adapters/tool-bridge.ts`
- Create: `src/agents/provider-adapters/tool-bridge.test.ts`

Nothing else changes in this chunk: the bridge is exported-but-unwired (adapter flips in Task 3), so the chunk is check-green by construction. `claude-builtin` entries cannot reach the bridge yet (they are still `claude-only`/`unavailable` until Task 2) — the bridge's builtin case is written now but dark.

**Spike dependencies:** S1 (transport classes + import path), S3 (timeout constants/knobs), S4/S5 (normalization posture). Where the spike recorded a fallback, substitute per the Task 0.7 table — every substitution point is marked `// SPIKE(S<n>)` below.

- [ ] **Step 1.1: Write `src/agents/provider-adapters/tool-bridge.ts`**

```typescript
/**
 * KPR-348 (spec §D1-§D3, §D7): the Lane B tool bridge. Consumes the
 * KPR-347 bridgeable inventory partition and materializes it per transport
 * class, presenting EVERY tool to the model as a hive-wrapped function tool.
 * The single dispatch wrapper is where the guardrail gate, exception
 * containment (epic §D4 invariant: execute() NEVER throws), abort
 * propagation, and tool metrics live. Agent.mcpServers is never used (§D2).
 *
 * Provider-neutral by design: KPR-352/353 bind the same BridgedTool[] to
 * their SDK shapes. The MCP server client classes from @openai/agents-core
 * are provider-neutral MCP plumbing (no OpenAI API coupling) — deliberate
 * shared-core reuse (spec §Integration).
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// SPIKE(S1): confirmed import path for the MCP server classes.
import { MCPServerStdio, MCPServerStreamableHttp, MCPServerSSE } from "@openai/agents";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServerConfig, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { WorkItemContext } from "../agent-runner.js";
import type { GuardrailDecision, GuardrailGate } from "./types.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import type { ProviderSkillIndexEntry } from "./turn-assembly.js";
import { BuiltinExecutor } from "./builtin-executor.js"; // Task 2 creates; Task 1 ships a stub (Step 1.2)

const log = createLogger("tool-bridge");

/** SPIKE(S3): units confirmed by the spike — adjust names/values to the recorded knobs. */
const CLIENT_SESSION_TIMEOUT_SECONDS = 30; // agents-core session RPCs — SECONDS
const TOOL_CALL_TIMEOUT_MS = 600_000; // MCP SDK RequestOptions.timeout — MILLISECONDS (aligned with Bash max)
/** OpenAI per-request tool limit (spec §D8). */
const MAX_PROVIDER_TOOLS = 128;
/** OpenAI function-name constraint (spec §D8). */
const TOOL_NAME_MAX = 64;
const TOOL_NAME_SAFE = /^[a-zA-Z0-9_-]+$/;

export interface BridgedTool {
  /** Provider-facing name — Claude-lane-identical (mcp__<server>__<tool>, or Bash/Read/…). */
  name: string;
  description: string;
  /** Normalized JSON schema (§D1.5): type/properties present, required + additionalProperties filled. */
  inputSchema: Record<string, unknown>;
  /** Gated + contained + metered. NEVER throws. Returns model-visible text. */
  execute(input: unknown): Promise<string>;
}

export interface ToolBridgeOptions {
  inventory: HiveToolInventoryEntry[];
  inProcessServers: Record<string, McpSdkServerConfigWithInstance>;
  gate: GuardrailGate;
  workItemContext?: WorkItemContext;
  signal: AbortSignal;
  /** Logging/telemetry label only (adapter passes its display name). */
  agentId: string;
  /** Resolved per-spawn session cwd (spec §D5-cwd) — builtin executor working dir. */
  sessionCwd: string;
  /** load_skill source (spec §D6) — [] until KPR-349 populates it. */
  skillIndex: ProviderSkillIndexEntry[];
}

/**
 * Uniform client view over the three MCP mechanisms. NOTE (S1 spike record):
 * the Agents-SDK `MCPServerStdio`/`MCPServerStreamableHttp`/`MCPServerSSE`
 * `.callTool()` may resolve with the bare `content` array rather than the
 * full `CallToolResult` (where `isError` lives) — unlike the raw
 * `@modelcontextprotocol/sdk` `Client.callTool()` path used for in-process
 * servers, which always returns the full result shape. `openAgentsSdkConnection`
 * (below) must normalize its `callTool` to always resolve a full
 * `CallToolResult`-shaped value (synthesizing `{content, isError: false}`
 * when the SDK gave back a bare content array) so `isErrorResult`/
 * `shapeCallToolResult` in `discover()` behave uniformly across all three
 * MCP mechanisms — do not special-case discover() per transport.
 */
interface McpConnection {
  serverName: string;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

type MutableStats = { toolCalls: number; toolMs: number; perTool: Map<string, number> };

export class ToolBridge {
  private readonly opts: ToolBridgeOptions;
  private readonly connections: McpConnection[] = [];
  private executor: BuiltinExecutor | null = null;
  private closed = false;
  private readonly _stats: MutableStats = { toolCalls: 0, toolMs: 0, perTool: new Map() };
  readonly runtimeOmissions: { server: string; reason: string }[] = [];

  constructor(opts: ToolBridgeOptions) {
    this.opts = opts;
  }

  get stats(): Readonly<MutableStats> {
    return this._stats;
  }

  /**
   * Connect all transports, discover schemas, build BridgedTool[].
   * Fail-soft per server (§D7): a failed connect/listTools drops that server
   * from this turn's surface (warn log: name + error class ONLY — never
   * configs/env), records a runtimeOmission, and the turn proceeds. The
   * whole method is additionally wrapped so it can NEVER throw out of
   * runTurn — connect errors are hive/tool-side, non-provider by nature.
   */
  async connect(): Promise<BridgedTool[]> {
    try {
      return await this.connectInner();
    } catch (err) {
      // Should be unreachable (per-server catches below) — belt-and-suspenders.
      log.warn("Tool bridge connect failed wholesale — running tool-less", {
        agent: this.opts.agentId,
        error: errorClass(err),
      });
      this.runtimeOmissions.push({ server: "*", reason: `bridge-connect: ${errorClass(err)}` });
      return [];
    }
  }

  private async connectInner(): Promise<BridgedTool[]> {
    const tools: BridgedTool[] = [];

    // Partition inventory entries by mechanism.
    const external = this.opts.inventory.filter(
      (e) => e.transport === "stdio" || e.transport === "http" || e.transport === "sse",
    );
    const inProcess = this.opts.inventory.filter((e) => e.transport === "sdk-in-process");
    const builtins = this.opts.inventory.filter(
      (e) => e.transport === "claude-builtin" && e.schemas.kind === "static",
    );

    // External MCP servers: connect + discover in parallel, fail-soft each.
    const externalResults = await Promise.allSettled(
      external.map((entry) => this.connectExternal(entry)),
    );
    externalResults.forEach((res, i) => {
      const entry = external[i];
      if (res.status === "fulfilled") {
        tools.push(...res.value);
      } else {
        this.omit(entry.name, res.reason);
      }
    });

    // In-process: same handlers the Claude lane runs (KPR-122), over InMemoryTransport.
    const inProcessResults = await Promise.allSettled(
      inProcess.map((entry) => this.connectInProcess(entry)),
    );
    inProcessResults.forEach((res, i) => {
      const entry = inProcess[i];
      if (res.status === "fulfilled") {
        tools.push(...res.value);
      } else {
        this.omit(entry.name, res.reason);
      }
    });

    // Builtin executor (Task 2): static schemas, direct dispatch, no MCP hop.
    if (builtins.length > 0) {
      this.executor = new BuiltinExecutor({ cwd: this.opts.sessionCwd, signal: this.opts.signal });
      for (const entry of builtins) {
        if (entry.schemas.kind !== "static") continue;
        for (const def of entry.schemas.tools) {
          tools.push(
            this.wrap(def.name, def.description, normalizeSchema(def.inputSchema), (input) =>
              this.executor!.execute(def.name, input),
            ),
          );
        }
      }
    }

    // load_skill (spec §D6): rendered whenever the index is non-empty — dark until KPR-349.
    const loadSkill = this.buildLoadSkillTool();
    if (loadSkill) tools.push(loadSkill);

    return this.applyNameAndCapEdges(tools);
  }

  private async connectExternal(entry: HiveToolInventoryEntry): Promise<BridgedTool[]> {
    const cfg = entry.serverConfig;
    if (!cfg) throw new Error("missing serverConfig");
    const conn = await this.openAgentsSdkConnection(entry.name, entry.transport, cfg);
    this.connections.push(conn);
    return this.discover(conn);
  }

  // SPIKE(S1/S3): constructor option names per the spike record. If S1 fell
  // back to the raw MCP SDK, this method builds Client + StdioClientTransport /
  // StreamableHTTPClientTransport instead — McpConnection shape unchanged.
  private async openAgentsSdkConnection(
    serverName: string,
    transport: "stdio" | "http" | "sse",
    cfg: McpServerConfig,
  ): Promise<McpConnection> {
    let server: { connect(): Promise<void>; listTools(): Promise<unknown>; callTool(n: string, a: Record<string, unknown> | null): Promise<unknown>; close(): Promise<void> };
    if (transport === "stdio") {
      const c = cfg as { command: string; args?: string[]; env?: Record<string, string> };
      server = new MCPServerStdio({
        name: serverName,
        command: c.command,
        args: c.args ?? [],
        env: c.env,
        cacheToolsList: true,
        clientSessionTimeoutSeconds: CLIENT_SESSION_TIMEOUT_SECONDS,
        timeout: TOOL_CALL_TIMEOUT_MS, // SPIKE(S3): knob + unit per record
      } as never);
    } else {
      const c = cfg as { url: string; headers?: Record<string, string> };
      const options = {
        name: serverName,
        url: c.url,
        requestInit: c.headers ? { headers: c.headers } : undefined,
        cacheToolsList: true,
        clientSessionTimeoutSeconds: CLIENT_SESSION_TIMEOUT_SECONDS,
        timeout: TOOL_CALL_TIMEOUT_MS, // SPIKE(S3)
      };
      server = transport === "http"
        ? new MCPServerStreamableHttp(options as never)
        : new MCPServerSSE(options as never);
    }
    await server.connect();
    return {
      serverName,
      listTools: async () => (await server.listTools()) as Array<{ name: string; description?: string; inputSchema?: unknown }>,
      callTool: async (toolName, args) => {
        const raw = await server.callTool(toolName, args);
        // NOTE (S1 spike): the agents-SDK server's callTool may resolve the
        // bare content array rather than a full CallToolResult (where isError
        // lives) — unlike the raw MCP Client path (connectInProcess) which
        // always returns the full shape. Normalize here so discover()'s
        // isErrorResult/shapeCallToolResult behave uniformly across all
        // three MCP mechanisms.
        return raw && typeof raw === "object" && "content" in (raw as Record<string, unknown>)
          ? raw
          : { content: raw, isError: false };
      },
      close: () => server.close(),
    };
  }

  private async connectInProcess(entry: HiveToolInventoryEntry): Promise<BridgedTool[]> {
    const sdkServer = this.opts.inProcessServers[entry.name];
    if (!sdkServer) throw new Error("no in-process instance in assembly");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Same McpServer instance, same handlers, same *ContextRef closures (KPR-122).
    await sdkServer.instance.connect(serverTransport);
    const client = new Client({ name: `hive-bridge-${entry.name}`, version: "1.0.0" });
    await client.connect(clientTransport);
    const conn: McpConnection = {
      serverName: entry.name,
      listTools: async () => (await client.listTools()).tools,
      callTool: async (toolName, args) =>
        client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_CALL_TIMEOUT_MS }),
      close: () => client.close(),
    };
    this.connections.push(conn);
    return this.discover(conn);
  }

  private async discover(conn: McpConnection): Promise<BridgedTool[]> {
    const listed = await conn.listTools();
    return listed.map((t) =>
      this.wrap(
        `mcp__${conn.serverName}__${t.name}`,
        t.description ?? "",
        normalizeSchema(t.inputSchema),
        async (input) => {
          const result = await conn.callTool(t.name, asRecord(input));
          // MCP SDK contract: a handler THROW makes callTool RESOLVE with
          // {isError: true, content: [...]} — it does not reject. Convert
          // that here into a throw so wrap()'s catch applies the single
          // containment prefix ("Tool execution failed (<name>): …") and
          // records the failure the same way every other failure path
          // does (gate throw, builtin throw, transport-level rejection) —
          // no separate isError-branch duplicating that logic.
          if (isErrorResult(result)) throw new Error(shapeCallToolResult(result));
          return shapeCallToolResult(result);
        },
      ),
    );
  }

  /**
   * THE dispatch wrapper (spec §D3): gate → execute → contain → meter.
   * Structurally cannot throw — the epic §D4 containment invariant's
   * structural half. Order and text shapes are contract-tested (T1).
   */
  private wrap(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    underlying: (input: unknown) => Promise<string>,
  ): BridgedTool {
    return {
      name,
      description,
      inputSchema,
      execute: async (input: unknown): Promise<string> => {
        let decision: GuardrailDecision;
        try {
          decision = await this.opts.gate({
            toolName: name,
            input,
            workItemContext: this.opts.workItemContext,
          });
        } catch (err) {
          // Gate THROW is a DENY (typed contract, types.ts:119-126).
          decision = { behavior: "deny", reason: `guardrail gate error: ${errorText(err)}` };
        }
        if (decision.behavior === "deny") {
          // PreToolUse parity: model-visible denial, turn continues.
          return `Tool call denied by policy: ${decision.reason}`;
        }
        if (this.opts.signal.aborted) {
          return `Tool execution aborted (${name}).`;
        }
        const t0 = Date.now();
        try {
          const result = await underlying(input);
          this.record(name, Date.now() - t0);
          return result;
        } catch (err) {
          this.record(name, Date.now() - t0);
          // Mirrors the KPR-122 in-process structured-error invariant.
          return `Tool execution failed (${name}): ${errorText(err)}`;
        }
      },
    };
  }

  private buildLoadSkillTool(): BridgedTool | null {
    if (this.opts.skillIndex.length === 0) return null;
    const byName = new Map(this.opts.skillIndex.map((s) => [s.name, s]));
    return this.wrap(
      "load_skill",
      "Load a skill's full instructions (its SKILL.md) by name. Only names from the skill list are valid.",
      {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the skill list" } },
        required: ["name"],
        additionalProperties: false,
      },
      async (input) => {
        const name = (asRecord(input) as { name?: unknown }).name;
        if (typeof name !== "string") return "load_skill failed: 'name' must be a string";
        // Path-validated by construction: paths come from the assembly's
        // index, never from the model (spec §D6 — minimal read-and-return).
        const entry = byName.get(name);
        if (!entry) return `load_skill failed: unknown skill '${name}'`;
        return await readFile(entry.path, "utf8");
      },
    );
  }

  /** Spec §D8 edges: sanitize/truncate-with-hash, collision dedupe, 128 cap. */
  private applyNameAndCapEdges(tools: BridgedTool[]): BridgedTool[] {
    const seen = new Set<string>();
    const out: BridgedTool[] = [];
    for (const t of tools) {
      let name = t.name;
      if (!TOOL_NAME_SAFE.test(name) || name.length > TOOL_NAME_MAX) {
        const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const hash = createHash("sha256").update(t.name).digest("hex").slice(0, 7);
        name = `${cleaned.slice(0, TOOL_NAME_MAX - 8)}_${hash}`;
        log.warn("Tool name sanitized for provider constraints", { agent: this.opts.agentId, original: t.name, mapped: name });
      }
      let candidate = name;
      let n = 2;
      while (seen.has(candidate)) {
        candidate = `${name.slice(0, TOOL_NAME_MAX - 2 - String(n).length)}_${n}`;
        n += 1;
        log.warn("Tool name collision — deterministic suffix applied", { agent: this.opts.agentId, name: candidate });
      }
      seen.add(candidate);
      out.push(candidate === t.name ? t : { ...t, name: candidate });
    }
    if (out.length > MAX_PROVIDER_TOOLS) {
      const dropped = out.splice(MAX_PROVIDER_TOOLS);
      for (const d of dropped) this.runtimeOmissions.push({ server: d.name, reason: "provider-tool-cap" });
      log.warn("Bridged tool surface exceeds provider cap — tail dropped", {
        agent: this.opts.agentId,
        cap: MAX_PROVIDER_TOOLS,
        dropped: dropped.map((d) => d.name),
      });
    }
    return out;
  }

  /**
   * Idempotent. Closes every MCP connection, kills builtin children.
   * NEVER throws and never rejects (final-review advisory 1): each server's
   * close is individually caught-and-logged so one faulting close cannot
   * skip the rest or reject runTurn's finally.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.executor?.killAll();
    await Promise.all(
      this.connections.map(async (conn) => {
        try {
          await conn.close();
        } catch (err) {
          log.warn("MCP connection close failed (ignored)", {
            agent: this.opts.agentId,
            server: conn.serverName,
            error: errorClass(err),
          });
        }
      }),
    );
  }

  private omit(server: string, err: unknown): void {
    // KPR-347 secrecy rule: names + error CLASS only — never configs/env.
    log.warn("Tool bridge server unavailable this turn — omitted (fail-soft)", {
      agent: this.opts.agentId,
      server,
      error: errorClass(err),
    });
    this.runtimeOmissions.push({ server, reason: errorClass(err) });
  }

  private record(name: string, ms: number): void {
    this._stats.toolCalls += 1;
    this._stats.toolMs += ms;
    this._stats.perTool.set(name, (this._stats.perTool.get(name) ?? 0) + 1);
  }
}

/** §D1.5/§D8: fill normalized defaults when absent; pass through otherwise. */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s = (schema && typeof schema === "object" ? { ...(schema as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (s.type === undefined) s.type = "object";
  if (s.properties === undefined) s.properties = {};
  if (s.required === undefined) s.required = [];
  if (s.additionalProperties === undefined) s.additionalProperties = false;
  return s;
}

/** True when a CallToolResult reports a handler-side error (resolves, does not reject — see discover()). */
function isErrorResult(result: unknown): boolean {
  return Boolean((result as { isError?: boolean } | undefined)?.isError);
}

/** §D3.1: MCP CallToolResult → model-visible text. */
export function shapeCallToolResult(result: unknown): string {
  const content = (result as { content?: Array<Record<string, unknown>> })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result ?? "");
  return content
    .map((item) =>
      item.type === "text"
        ? String(item.text ?? "")
        : `[non-text content: ${String(item.type)} — not supported on this provider lane]`,
    )
    .join("\n");
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorClass(err: unknown): string {
  // KPR-347 secrecy rule: error CLASS only — never the message (which can
  // carry configs/env/paths); trimmed to err.name per plan-review round-1.
  if (err instanceof Error) return err.name;
  return String(err);
}
```

- [ ] **Step 1.2: Temporary `BuiltinExecutor` stub** (replaced by Task 2 — keeps chunk 1 compiling with the builtin case written)

Create `src/agents/provider-adapters/builtin-executor.ts` with the minimal contract surface only:

```typescript
/**
 * KPR-348 (spec §D5): builtin executor — Task 2 authors the six tools.
 * This chunk-1 stub pins the construction/lifecycle contract the bridge
 * compiles against; execute() is unreachable until Task 2 flips the
 * inventory (claude-builtin entries are still {kind:"unavailable"}).
 */
import type { HiveToolSchemaEntry } from "./tool-transport.js";

export const EXECUTOR_BACKED_BUILTIN_NAMES: ReadonlySet<string> = new Set([]); // Task 2: the six names
export const BUILTIN_TOOL_DEFINITIONS: HiveToolSchemaEntry[] = []; // Task 2 authors

export class BuiltinExecutor {
  constructor(private readonly opts: { cwd: string; signal: AbortSignal }) {}
  async execute(name: string, _input: unknown): Promise<string> {
    return `Tool execution failed (${name}): builtin executor not yet implemented`;
  }
  killAll(): void {}
}
```

- [ ] **Step 1.3: Write `src/agents/provider-adapters/tool-bridge.test.ts`**

Test infrastructure: mock the `@openai/agents` MCP classes with `vi.mock` (pattern per `openai-agents-adapter.test.ts:15-26`) exposing controllable `connect`/`listTools`/`callTool`/`close` spies; build in-process fixtures with the real `@modelcontextprotocol/sdk` `McpServer` (`new McpServer({name, version})` + `registerTool`) wrapped as `{ type: "sdk", name, instance }` to satisfy `McpSdkServerConfigWithInstance`. Helper `makeEntry(overrides)` mirrors `makeInventoryEntry` in the adapter test.

Required cases (each a named `it`):

**T4 — materialization:**
  - [ ] fixture inventory (stdio + http + in-process + a `claude-builtin`/`unavailable` entry) → `BridgedTool` names are `mcp__<server>__<tool>` for MCP, claude-only entry never materialized
  - [ ] schema without `required`/`additionalProperties` → normalized defaults present on `inputSchema` (direct `normalizeSchema` unit cases too: undefined, `{}`, full schema pass-through)
  - [ ] stdio entry with `connect` rejecting → tool surface excludes it, `runtimeOmissions` contains `{server, reason}`, `connect()` resolves (no throw)
  - [ ] entry missing `serverConfig` → omitted, no throw
  - [ ] secrecy: spy on the logger (or capture warn calls); assert no log/omission projection contains any `env` value planted in the fixture config (plant a sentinel like `"SECRET_SENTINEL"` and assert absence)
  - [ ] `shapeCallToolResult`: text items joined with `\n`; image item → `[non-text content: image — not supported on this provider lane]`
  - [ ] `load_skill` (spec §D6, §D-open-assumptions contract test): non-empty fixture skill index (`skillIndex` with one entry pointing at a fixture SKILL.md on disk) → the `load_skill` tool is rendered/present in the returned `BridgedTool[]`, and `execute({name: <that entry's name>})` resolves with the fixture SKILL.md's file content
  - [ ] `load_skill`: unknown skill name (not in `skillIndex`) → `execute({name: "nonexistent"})` resolves to contained error text (`load_skill failed: unknown skill '...'`), no throw
  - [ ] `load_skill`: non-string `name` argument (e.g. `execute({name: 123})`) → resolves to contained error text (`load_skill failed: 'name' must be a string`), no throw
  - [ ] `load_skill`: empty skill index (`skillIndex: []`) → `load_skill` is absent from the bridged tool list entirely (`buildLoadSkillTool` returns `null`)

**T1 (bridge half) — containment:**
  - [ ] gate throws → `execute()` resolves to `Tool call denied by policy: guardrail gate error: …`
  - [ ] gate denies → `Tool call denied by policy: <reason>`; underlying NOT called (spy)
  - [ ] mocked MCP `callTool` rejects → `Tool execution failed (mcp__x__y): …`
  - [ ] in-process fixture handler throws → `execute()` resolves to exactly `Tool execution failed (mcp__<server>__<tool>): …` (real `McpServer` fixture whose handler throws; `Client.callTool` resolves with `{isError:true,...}` rather than rejecting — `discover()`'s `isErrorResult` check converts this to a throw so `wrap()`'s catch applies the prefix deterministically; single assertion on the exact prefix, no either/or hedge)
  - [ ] property: for every bridged tool in a mixed fixture, `await execute(badInput)` never rejects (wrap in `expect(...).resolves.toBeTypeOf("string")` across all tools)

**T6 — in-process round-trip:**
  - [ ] real `McpServer` fixture with an `echo_context` tool whose closure reads a mutable `contextRef.current` set before `connect()` → `execute()` returns the planted channel/thread values (pins the `*ContextRef` construction-time ≡ turn-time invariant)
  - [ ] `listTools` schema from the fixture flows into `inputSchema`

**T5 (bridge half) — lifecycle:**
  - [ ] `close()` calls `close` on every connection (spies), second `close()` is a no-op (idempotent)
  - [ ] a connection whose `close()` rejects → `bridge.close()` still resolves and the OTHER server's close was still called (advisory 1)
  - [ ] abort: `signal` already aborted → `execute()` returns `Tool execution aborted (…)` without calling underlying

**T9 — name/cap edges:**
  - [ ] synthetic 80-char tool name → mapped name ≤64, matches `[a-zA-Z0-9_-]+`, deterministic (same input twice ⇒ same mapping), dispatch still routes (execute works)
  - [ ] two tools sanitizing to the same name → second gets deterministic suffix
  - [ ] 130 tools → 128 survive, 2 recorded in `runtimeOmissions` with reason `provider-tool-cap`

- [ ] **Step 1.4: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0, all suites green (existing suites untouched).

```bash
git add src/agents/provider-adapters/tool-bridge.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/provider-adapters/builtin-executor.ts
git commit -m "KPR-348: tool bridge core — MCP transports, gated dispatch wrapper, containment"
```

---

## Task 2 (Chunk 2): Builtin executor, in-process carriage, inventory flip, cwd helper

**Spike dependencies:** none beyond Task 1's (this chunk is pure hive-side).

- [ ] **Step 2.1: Add `tinyglobby` dependency**

Run: `npm install tinyglobby` — expect `package.json` gains `"tinyglobby": "^0.2.x"` under `dependencies`, lockfile updated. (Spec §D5 pre-declared this possible addition; no glob dep exists in `package.json` today — verified.)

- [ ] **Step 2.2: Write `src/agents/provider-adapters/builtin-executor.ts` (replacing the Task-1 stub)**

Contract = the **agent-facing behavior** (spec §D5), not CLI internals. Schemas are authored as plain JSON-schema constants — the same non-strict JSON-schema pathway every MCP-discovered tool takes through the bridge, keeping ONE schema mechanism (spec's "authored as zod, emitted as JSON schema" is satisfied by authored static schemas; skipping the zod hop avoids depending on a zod→JSON-schema converter — record this choice in the PR description).

```typescript
/**
 * KPR-348 (spec §D5): the builtin executor — hive-native Bash/Read/Write/
 * Edit/Glob/Grep whose semantics match the agent-facing contract the tool
 * descriptions promise. Only {kind:"static"} schema producer in the fleet
 * (canon 1). Sandboxing posture: none beyond the guardrail gate — parity
 * with the Claude lane's bypassPermissions (DOD-212 lane-equivalence note
 * in the spec).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { glob } from "tinyglobby";
import type { HiveToolSchemaEntry } from "./tool-transport.js";

const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const OUTPUT_TRUNCATE_CHARS = 30_000;
const READ_DEFAULT_LIMIT = 2_000;
const READ_LINE_TRUNCATE = 2_000;
const GREP_MAX_FILE_BYTES = 5_000_000;
const KILL_GRACE_MS = 5_000;

const UNSUPPORTED_READ_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf", ".ipynb",
]);

export const EXECUTOR_BACKED_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
]);

export const BUILTIN_TOOL_DEFINITIONS: HiveToolSchemaEntry[] = [
  {
    name: "Bash",
    description:
      "Execute a bash command. Combined stdout+stderr is returned (truncated at 30000 chars); " +
      "a non-zero exit appends the exit code. Working directory and environment do NOT persist " +
      "between calls — use absolute paths. Default timeout 120000ms, max 600000ms. " +
      "For long-running detached work use the background task tools instead.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
        description: { type: "string", description: "Short description of what this command does" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "Read",
    description:
      "Read a text file. Returns cat -n style output (line numbers from 1). Reads up to 2000 " +
      "lines by default; use offset/limit for larger files. Long lines are truncated at 2000 chars. " +
      "Images, PDFs, and notebooks are not supported on this provider lane.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start reading from (1-based)" },
        limit: { type: "number", description: "Number of lines to read" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "Write",
    description: "Write a file, creating parent directories and overwriting any existing content.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "Edit",
    description:
      "Exact string replacement in a file. old_string must match exactly and (unless replace_all) " +
      "be unique in the file; old_string and new_string must differ.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to modify" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "Glob",
    description:
      "Find files matching a glob pattern (e.g. **/*.ts). Results are absolute paths sorted by " +
      "modification time, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Directory to search (default: session cwd)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "Grep",
    description:
      "Search file contents with a JavaScript regular expression. Supported options only: " +
      "glob file filter, output_mode (files_with_matches | content | count), case-insensitive, " +
      "line numbers, context lines.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (JavaScript syntax)" },
        path: { type: "string", description: "Directory or file to search (default: session cwd)" },
        glob: { type: "string", description: "Glob filter for files to search (e.g. *.ts)" },
        output_mode: {
          type: "string",
          enum: ["files_with_matches", "content", "count"],
          description: "Output shape (default files_with_matches)",
        },
        "-i": { type: "boolean", description: "Case-insensitive matching" },
        "-n": { type: "boolean", description: "Include line numbers (content mode)" },
        context: { type: "number", description: "Lines of context around each match (content mode)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

export class BuiltinExecutor {
  private readonly cwd: string;
  private readonly signal: AbortSignal;
  private readonly children = new Set<ChildProcess>();
  private readonly onAbort = () => this.killAll();

  constructor(opts: { cwd: string; signal: AbortSignal }) {
    this.cwd = opts.cwd;
    this.signal = opts.signal;
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  /**
   * Throw-safe is NOT this layer's contract — the bridge wrapper contains
   * throws (§D3). This method throws freely on contract violations; the
   * error texts below that are RESULTS (not throws) are the agent-facing
   * failure modes the Claude lane also surfaces as results.
   */
  async execute(name: string, input: unknown): Promise<string> {
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    switch (name) {
      case "Bash":
        return this.bash(args);
      case "Read":
        return this.read(args);
      case "Write":
        return this.write(args);
      case "Edit":
        return this.edit(args);
      case "Glob":
        return this.globTool(args);
      case "Grep":
        return this.grep(args);
      default:
        return `Tool execution failed (${name}): unknown builtin`;
    }
  }

  /** SIGTERM the process groups, SIGKILL stragglers after the grace window. */
  killAll(): void {
    for (const child of this.children) {
      killGroup(child, "SIGTERM");
      const timer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      timer.unref();
    }
  }

  private bash(args: Record<string, unknown>): Promise<string> {
    const command = requireString(args, "command");
    const timeoutMs = Math.min(
      typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : BASH_DEFAULT_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS,
    );
    return new Promise((resolve) => {
      // argv array (CLAUDE.md no-shell-string rule governs ENGINE interpolation;
      // command is the agent's own surface — Claude-lane bypassPermissions parity).
      // detached: own process group, so abort/timeout kills the whole tree.
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: this.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      let output = "";
      let truncated = false;
      const append = (chunk: Buffer) => {
        if (output.length >= OUTPUT_TRUNCATE_CHARS) {
          truncated = true;
          return;
        }
        output += chunk.toString("utf8");
        if (output.length > OUTPUT_TRUNCATE_CHARS) {
          output = output.slice(0, OUTPUT_TRUNCATE_CHARS);
          truncated = true;
        }
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
      }, timeoutMs);
      timer.unref();
      child.on("error", (err) => {
        clearTimeout(timer);
        this.children.delete(child);
        resolve(`Tool execution failed (Bash): ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        let text = output;
        if (truncated) text += "\n[output truncated at 30000 characters]";
        if (timedOut) text += `\n[command timed out after ${timeoutMs}ms and was killed]`;
        else if (code !== null && code !== 0) text += `\nExit code ${code}`;
        resolve(text);
      });
    });
  }

  private async read(args: Record<string, unknown>): Promise<string> {
    const filePath = requireString(args, "file_path");
    if (UNSUPPORTED_READ_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      return `Read failed: ${extname(filePath)} files are not supported on this provider lane (text files only)`;
    }
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return `Read failed: file not found: ${filePath}`;
    }
    if (st.isDirectory()) return `Read failed: ${filePath} is a directory`;
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : READ_DEFAULT_LIMIT;
    const window = lines.slice(offset - 1, offset - 1 + limit);
    const body = window
      .map((line, i) => {
        const n = offset + i;
        const text = line.length > READ_LINE_TRUNCATE ? `${line.slice(0, READ_LINE_TRUNCATE)}… [line truncated]` : line;
        return `${String(n).padStart(6)}\t${text}`;
      })
      .join("\n");
    const remaining = lines.length - (offset - 1 + window.length);
    return remaining > 0 ? `${body}\n[${remaining} more lines — use offset/limit to read further]` : body;
  }

  private async write(args: Record<string, unknown>): Promise<string> {
    const filePath = requireString(args, "file_path");
    const content = requireString(args, "content");
    mkdirSync(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
  }

  private async edit(args: Record<string, unknown>): Promise<string> {
    const filePath = requireString(args, "file_path");
    const oldString = requireString(args, "old_string");
    const newString = requireString(args, "new_string");
    const replaceAll = args.replace_all === true;
    if (oldString === newString) return "Edit failed: old_string and new_string are identical";
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return `Edit failed: file not found: ${filePath}`;
    }
    const count = raw.split(oldString).length - 1;
    if (count === 0) return `Edit failed: old_string not found in ${filePath}`;
    if (count > 1 && !replaceAll) {
      return `Edit failed: old_string matches ${count} locations in ${filePath} — make it unique or pass replace_all: true`;
    }
    const next = replaceAll ? raw.split(oldString).join(newString) : raw.replace(oldString, newString);
    await writeFile(filePath, next, "utf8");
    return `Edited ${filePath} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? "s" : ""})`;
  }

  private async globTool(args: Record<string, unknown>): Promise<string> {
    const pattern = requireString(args, "pattern");
    const searchPath = typeof args.path === "string" ? args.path : this.cwd;
    const matches = await glob(pattern, { cwd: searchPath, absolute: true, dot: false });
    if (matches.length === 0) return "No files found";
    const withMtime = await Promise.all(
      matches.map(async (m) => {
        try {
          return { m, mtime: (await stat(m)).mtimeMs };
        } catch {
          return { m, mtime: 0 };
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.map((e) => e.m).join("\n");
  }

  private async grep(args: Record<string, unknown>): Promise<string> {
    const pattern = requireString(args, "pattern");
    const flags = args["-i"] === true ? "i" : "";
    const re = new RegExp(pattern, flags); // invalid regex throws → bridge contains it
    const searchPath = typeof args.path === "string" ? args.path : this.cwd;
    const mode = typeof args.output_mode === "string" ? args.output_mode : "files_with_matches";
    const withLineNumbers = args["-n"] === true;
    const context = typeof args.context === "number" && args.context > 0 ? Math.floor(args.context) : 0;

    let files: string[];
    const st = await stat(searchPath).catch(() => null);
    if (st?.isFile()) {
      files = [searchPath];
    } else {
      const filePattern = typeof args.glob === "string" ? `**/${args.glob}` : "**/*";
      files = await glob(filePattern, {
        cwd: searchPath,
        absolute: true,
        dot: false,
        ignore: ["**/node_modules/**", "**/.git/**"],
      });
    }

    const out: string[] = [];
    let totalChars = 0;
    for (const file of files) {
      const fst = await stat(file).catch(() => null);
      if (!fst?.isFile() || fst.size > GREP_MAX_FILE_BYTES) continue;
      const raw = await readFile(file, "utf8").catch(() => null);
      if (raw === null || raw.includes("\0")) continue; // unreadable / binary
      const lines = raw.split("\n");
      const matchIdx: number[] = [];
      lines.forEach((line, i) => {
        if (re.test(line)) matchIdx.push(i);
      });
      if (matchIdx.length === 0) continue;
      if (mode === "files_with_matches") {
        out.push(file);
      } else if (mode === "count") {
        out.push(`${file}: ${matchIdx.length}`);
      } else {
        out.push(`== ${file} ==`);
        const emitted = new Set<number>();
        for (const i of matchIdx) {
          for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
            if (emitted.has(j)) continue;
            emitted.add(j);
            out.push(withLineNumbers ? `${j + 1}: ${lines[j]}` : lines[j]);
          }
        }
      }
      totalChars = out.reduce((n, s) => n + s.length + 1, 0);
      if (totalChars > OUTPUT_TRUNCATE_CHARS) {
        out.push("[grep output truncated at 30000 characters]");
        break;
      }
    }
    return out.length > 0 ? out.join("\n") : "No matches found";
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string parameter '${key}'`); // bridge wrapper contains this
  }
  return v;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal); // negative pid = process group (detached:true)
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
```

Also update `EXECUTOR_BACKED_BUILTIN_NAMES` and `BUILTIN_TOOL_DEFINITIONS` (the stub's empty values are replaced by the above).

- [ ] **Step 2.3: Write `src/agents/provider-adapters/builtin-executor.test.ts` (T3)**

Fixtures: `mkdtempSync(join(tmpdir(), "kpr348-"))` per test, cleaned in `afterEach`. Executor constructed with `{ cwd: tmp, signal: new AbortController().signal }`. Golden texts assert the **contract**; add the spec-mandated comment: `// T3 asserts the agent-facing contract — do NOT add assertions on Claude-CLI-internal quirks.`

Required cases:
  - [ ] Read: `cat -n` format — line numbers from 1, tab separator; offset/limit window (offset 3, limit 2 of a 5-line file → lines 3-4 numbered 3,4 + remaining marker); 2500-line file default read stops at 2000 + remaining marker; 3000-char line truncated at 2000 with marker; missing file → `Read failed: file not found: …`; directory → `is a directory`; `.png` → `not supported on this provider lane`
  - [ ] Edit: unique replace works and reports 1 replacement; not-found → distinct text; 2 occurrences without `replace_all` → distinct non-unique text naming the count; `replace_all` replaces both; identical strings → distinct text
  - [ ] Write: nested path parents created; overwrite replaces content
  - [ ] Bash: `echo hi` → `hi`; `exit 3` → output contains `Exit code 3` (result, not throw); `command: "printf 'a%.0s' {1..40000}"` → truncated marker; timeout 200ms on `sleep 5` → timed-out marker and (poll ~1s) child pid gone; relative-path `pwd` → executor cwd; no-cwd-persistence: `cd /tmp` then a second `pwd` call → executor cwd again
  - [ ] Glob: two files with distinct mtimes (set via `utimes`) → newest first, absolute paths; no match → `No files found`
  - [ ] Grep: files_with_matches default; count mode; content mode with `-n` and `context: 1`; `-i`; `glob: "*.ts"` filter excludes `.md`; no match → `No matches found`
  - [ ] contract violations throw (missing `command`, invalid regex) — asserted with `rejects.toThrow` (containment is the BRIDGE's job; T1 pins that side)
  - [ ] T5 (kill half): start `Bash sleep 30`, call `killAll()`, poll until `process.kill(pid, 0)` throws ESRCH. **Default (deterministic):** expose a test-only pid getter (e.g. `activeChildCount()`/pids accessor) on `BuiltinExecutor` and read the pid directly off it. **Fallback only if the getter proves impractical:** assert via `pgrep -f` of a unique marker arg (e.g. `sleep 30 # kpr348-t5`).

- [ ] **Step 2.4: `tool-transport.ts` — per-tool builtin names + executor-backed classify branch**

Modify `src/agents/provider-adapters/tool-transport.ts`:

Replace `CLAUDE_SDK_BUILTIN_TOOL_NAMES` (lines 36-49; only consumer is `agent-runner.ts:1286` — verified, so no toolkit-rendering impact):

```typescript
/**
 * Claude Agent SDK built-ins advertised by Hive's toolkit section — per-tool
 * (KPR-348 replaced the compound display names so archetype rules and the
 * builtin executor address tools by their real names).
 */
export const CLAUDE_SDK_BUILTIN_TOOL_NAMES: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TodoWrite",
];
```

In `classifyToolTransport`, replace the `claude-builtin`/`claude-subagent` branch (lines 84-99) — import `EXECUTOR_BACKED_BUILTIN_NAMES` from `./builtin-executor.js` (runtime import direction: tool-transport → builtin-executor; builtin-executor's import of `HiveToolSchemaEntry` from tool-transport is **type-only** and erased, so no runtime cycle):

```typescript
  if (input.transport === "claude-builtin" || input.transport === "claude-subagent") {
    // KPR-348 (spec §D5, canon 2): the six executor-backed builtins are
    // bridgeable on every Lane B provider — ONE code path emits openai,
    // gemini, and codex identically (codex ≡ openai at the classify site;
    // gemini upgraded for classification honesty — its adapter still
    // advertises zero tools until KPR-352, only its omission record changes).
    const executorBacked =
      input.transport === "claude-builtin" && EXECUTOR_BACKED_BUILTIN_NAMES.has(input.name);
    const nonClaude: ProviderToolCompatibility = executorBacked ? "requires-hive-bridge" : "claude-only";
    return {
      name: input.name,
      transport: input.transport,
      source: input.source,
      requiresTurnContext,
      requiresHiveRuntime,
      inProcess,
      compatibility: {
        claude: "direct",
        openai: nonClaude,
        gemini: nonClaude,
        codex: nonClaude,
      },
    };
  }
```

- [ ] **Step 2.5: `agent-runner.ts` — builtin inventory entries flip to `static` (canon 1)**

Modify the builtin loop (`agent-runner.ts:1286-1296`). Add imports `BUILTIN_TOOL_DEFINITIONS`, `EXECUTOR_BACKED_BUILTIN_NAMES` from `./provider-adapters/builtin-executor.js` (import direction agent-runner → builtin-executor, same direction as its existing tool-transport import — spec §D5):

```typescript
    for (const name of CLAUDE_SDK_BUILTIN_TOOL_NAMES) {
      // KPR-348 (canon 1): the six executor-backed builtins are the fleet's
      // only {kind:"static"} schema producer; the rest stay unavailable
      // (WebFetch/WebSearch/NotebookEdit/TodoWrite claude-only by ruling,
      // Task = child 9).
      const staticDef = EXECUTOR_BACKED_BUILTIN_NAMES.has(name)
        ? BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === name)
        : undefined;
      inventory.push({
        ...classifyToolTransport({
          name,
          transport: "claude-builtin",
          source: "sdk-builtin",
        }),
        schemas: staticDef ? { kind: "static", tools: [staticDef] } : { kind: "unavailable" },
      });
    }
```

- [ ] **Step 2.6: Extract `AgentRunner.buildInProcessServers` (behavior-preserving)**

In `src/agents/agent-runner.ts`, cut the in-process construction block from `send()` (lines 1561-1728: the team-roster block through the structured-memory block, inclusive) into a new **public** method placed beside `buildToolTransportInventory`:

```typescript
  /**
   * KPR-348 (spec §D4): build the in-process SDK MCP servers for one turn —
   * extracted VERBATIM from send() so the Lane B assembly can carry the same
   * instances (same handlers, same *ContextRef closures) to the tool bridge.
   * Behavior-preserving on the Claude lane: send() calls this and merges the
   * result exactly where the inline block used to assign. Per-runner
   * instance caching, shouldEnableInProcessServer gating, workflow flag,
   * context-ref refreshes, and prefix-cache invalidation closures all
   * unchanged.
   */
  buildInProcessServers(context?: WorkItemContext): Record<string, McpSdkServerConfigWithInstance> {
    const servers: Record<string, McpSdkServerConfigWithInstance> = {};
    // <the eleven blocks from send(), verbatim, each assigning into `servers`
    //  instead of `mcpServers`: team-roster, memory, event-bus, contacts,
    //  schedule, team, admin, code-search, workflow, callback,
    //  structured-memory — including the callbackContextRef.current and
    //  structuredMemoryContextRef.current refresh lines>
    return servers;
  }
```

In `send()`, the removed block becomes:

```typescript
    Object.assign(mcpServers, this.buildInProcessServers(context));
```

Mechanical rules: every `mcpServers["x"] = …` becomes `servers["x"] = …`; nothing else changes — same order, same comments, same gating conditions. Add the `McpSdkServerConfigWithInstance` type import from `@anthropic-ai/claude-agent-sdk` if not already imported.

- [ ] **Step 2.7: Create `src/agents/session-cwd.ts` + wire both lanes**

```typescript
/**
 * KPR-348 (spec §D5-cwd): shared session-cwd resolution — extracted from
 * AgentRunner.send() so the Claude lane and the Lane B builtin executor
 * cannot drift. Archetype-provided cwd wins with a fail-loud stat check;
 * otherwise the per-agent scratch dir, lazily created (KPR-51).
 */
import { mkdirSync, statSync } from "node:fs";
import { hiveHome, agentScratchDir } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("session-cwd");

export function resolveSessionCwd(opts: { archetypeCwd: unknown; agentId: string }): string {
  const source: "archetype" | "default" = typeof opts.archetypeCwd === "string" ? "archetype" : "default";
  const effectiveCwd = source === "archetype" ? (opts.archetypeCwd as string) : agentScratchDir(opts.agentId, hiveHome);
  if (source === "default") {
    // Lazy create — fail loud on mkdir errors (permissions, read-only fs).
    mkdirSync(effectiveCwd, { recursive: true });
  } else {
    // Archetype path must already exist: operator-configured; a missing dir
    // is a misconfig surfaced at session start, not silently recreated.
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(effectiveCwd);
    } catch (err) {
      const msg = `Archetype cwd unavailable at session start — refusing to run: ${effectiveCwd} (${String(err)})`;
      log.error(msg, { agent: opts.agentId });
      throw new Error(msg);
    }
    if (!st.isDirectory()) {
      const msg = `Archetype cwd is not a directory: ${effectiveCwd}`;
      log.error(msg, { agent: opts.agentId });
      throw new Error(msg);
    }
  }
  return effectiveCwd;
}
```

Wire it:
1. `send()` (agent-runner.ts:1765-1795): replace the inline cwd-resolution block with `const effectiveCwd = resolveSessionCwd({ archetypeCwd: archetypeExtra.cwd, agentId: this.agentConfig.id });` (delete the now-unused inline `cwdSource` logic; keep the `archetypeExtra` computation above it — `settingSources` still needs it). Remove `mkdirSync`/`statSync` imports from agent-runner **only if** no other call sites use them (grep first).
2. New public runner method for the Lane B assembly, beside `buildInProcessServers` (duplicating only the small `sessionOptions` try/catch, same ignore posture as `send()` — documented):

```typescript
  /**
   * KPR-348 (spec §D5-cwd): resolve the session cwd for a Lane B spawn —
   * exactly the Claude-lane rule. Archetype sessionOptions().cwd wins (with
   * the shared fail-loud stat check → the assembly's TurnAssemblyError try
   * classifies it non-provider); otherwise the agent scratch dir.
   */
  resolveTurnCwd(context?: WorkItemContext): string {
    let archetypeCwd: unknown;
    const archetypeDef = this.getArchetypeDef();
    if (archetypeDef && this.agentConfig.archetypeConfig) {
      try {
        archetypeCwd = archetypeDef.sessionOptions({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
          workItemContext: context,
        }).cwd;
      } catch (err) {
        log.error("Archetype sessionOptions threw — ignoring", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }
    return resolveSessionCwd({ archetypeCwd, agentId: this.agentConfig.id });
  }
```

3. `src/agents/session-cwd.test.ts`: default path → dir created + returned; archetype path exists → returned as-is, NOT created if missing (throws, message contains `refusing to run`); archetype path is a file → throws `not a directory`.

- [ ] **Step 2.8: `turn-assembly.ts` — carry `inProcessServers` + `sessionCwd`**

Modify `src/agents/provider-adapters/turn-assembly.ts`:
1. Import `McpSdkServerConfigWithInstance` type from `@anthropic-ai/claude-agent-sdk`.
2. `ProviderTurnAssembly` gains (additive — canon 4):

```typescript
  /**
   * KPR-348 (spec §D4): the SAME in-process McpServer instances the Claude
   * lane would run (same handlers, same *ContextRef closures) — the bridge
   * connects to them over InMemoryTransport. The inventory remains the
   * single source of WHICH servers the agent gets; this record is merely
   * the carrier for HOW. Built inside the TurnAssemblyError try: a Mongo
   * fault during factory construction classifies non-provider.
   */
  inProcessServers: Record<string, McpSdkServerConfigWithInstance>;
  /** KPR-348 (spec §D5-cwd): resolved per-spawn session cwd for the builtin executor. */
  sessionCwd: string;
```

3. Inside `assembleProviderTurn`'s existing `try` (after the partition, before the return):

```typescript
    // KPR-348 (§D4): *ContextRef.current is set here with the turn's context —
    // per-spawn adapters make construction-time ≡ turn-time (canon 4).
    const inProcessServers = input.runner.buildInProcessServers(input.workItemContext);
    const sessionCwd = input.runner.resolveTurnCwd(input.workItemContext);
```

and add both to the returned object. Gate construction line is untouched in this chunk (Task 3 changes its body, not its call site — except the added `workItemContext` argument, also Task 3).

4. Update `turn-assembly.test.ts` fixtures: existing `makeAssembly`-style fixtures across adapter tests gain `inProcessServers: {}` and `sessionCwd: <tmpdir>` (compile-driven sweep — `gemini-adk-adapter.test.ts` / `codex-subscription-adapter.test.ts` fixture objects too; their behavior pins stay untouched). Add assertions: assembly output contains `inProcessServers` (fixture runner returns a planted record) and a resolved `sessionCwd`; a runner whose `resolveTurnCwd` throws → `TurnAssemblyError`.

- [ ] **Step 2.9: T8 tests + refactor-equivalence**

1. `tool-transport.test.ts`: six executor tools classify `{claude: "direct", openai: "requires-hive-bridge", gemini: "requires-hive-bridge", codex: "requires-hive-bridge"}` with an explicit `expect(d.compatibility.codex).toEqual(d.compatibility.openai)` canon-2 pin; `WebFetch`/`NotebookEdit`/`TodoWrite`/`Task` stay `claude-only`; `claude-subagent` unchanged.
2. `agent-runner.test.ts`: extend the existing `buildToolTransportInventory` assertions — per-tool builtin names present (`"Bash"`, `"Read"`, …, no compound `"Read / Write / Edit"`), six entries `schemas.kind === "static"` with exactly one tool def whose name matches, `WebFetch` et al `unavailable`.
3. Extraction equivalence: a test constructing an `AgentRunner` the way existing `agent-runner.test.ts` tests do, asserting `buildInProcessServers(ctx)` returns the same server keys the pre-change `send()` path wired (team-roster when roster present; db-gated set when a db stub is present — reuse the file's existing construction helpers; where existing tests already assert send()-path server wiring, their continued green IS the equivalence evidence — add at minimum: no db + no roster → `{}`, roster only → `{"team-roster"}`).

- [ ] **Step 2.10: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0. Pay attention to: no regression in `agent-runner.test.ts` (extraction), adapter fixture compile errors all swept (Step 2.8.4).

**PR description must call out two documented spec deviations from this chunk** (both intentional, both explained in the reviewer notes at the bottom of this plan): (1) `BUILTIN_TOOL_DEFINITIONS` are plain JSON-schema constants, not spec §D5's "authored as zod, emitted as JSON schema"; (2) `Bash` uses `spawn(..., {detached: true})`, not the spec's literal `execFile` — argv-array posture (no shell-string interpolation) is preserved, and `detached: true` is required for T5's process-group kill (`killGroup`'s `process.kill(-pid, …)`).

```bash
git add -A src/ package.json package-lock.json
git commit -m "KPR-348: builtin executor, in-process carriage, inventory static schemas, shared cwd"
```

---

## Task 3 (Chunk 3): Guardrail gate port, adapter wiring, telemetry

**Spike dependencies:** S4/S5 (tool binding shape in Step 3.2 — `tool()` with JSON schema + `strict: false`, or the `getAllMcpTools` fallback confined to Task 1's bridge internals).

- [ ] **Step 3.1: Create `src/agents/provider-adapters/archetype-gate.ts` + flip the gate body (canon 6)**

```typescript
/**
 * KPR-348 (spec §D6): real archetype PreToolUse evaluation for the Lane B
 * guardrail gate — a PORT of buildHooks' semantics (agent-runner.ts), not a
 * modification of it. Same matcher production, same fail-closed posture:
 *  - preToolUseHooks() throw at production → deny-all gate (buildHooks'
 *    fallback reason shape, verbatim);
 *  - evaluation throw at call time → deny (plus the bridge wrapper's
 *    throw-is-deny rule — double containment);
 *  - first permissionDecision:"deny" wins; {continue:true}/allow/empty →
 *    keep going; no denial ⇒ allow.
 *
 * DOCUMENTED NARROWING (spec §D6): hooks consumed via this gate must depend
 * only on tool_name/tool_input (+ synthesized event fields) — true of the
 * only registered archetype (software-engineer) and pinned by T2. A future
 * archetype needing full CLI session fields extends this adapter
 * deliberately; it does not break silently.
 */
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { AgentConfig } from "../../types/agent-config.js";
import type { ArchetypeDefinition } from "../../archetypes/registry.js";
import type { WorkItemContext } from "../agent-runner.js";
import type { GuardrailGate } from "./types.js";

const log = createLogger("archetype-gate");

export function buildArchetypeGuardrailGate(
  config: AgentConfig,
  archetypeDef: ArchetypeDefinition,
  workItemContext?: WorkItemContext,
): GuardrailGate {
  let matchers: HookCallbackMatcher[];
  try {
    // Produced once at assembly — identical inputs to buildHooks (agent-runner.ts:1469-1473).
    matchers = archetypeDef.preToolUseHooks({
      agentConfig: config,
      archetypeConfig: config.archetypeConfig!,
      workItemContext,
    });
  } catch (err) {
    // Fail-closed parity with buildHooks' deny-all fallback (agent-runner.ts:1477-1495).
    log.error("Archetype preToolUseHooks threw — installing deny-all guardrail gate", {
      agent: config.id,
      archetype: config.archetype,
      error: String(err),
    });
    const reason = `Archetype hook initialization failed (${String(err)}). All tool calls blocked until the archetype is fixed.`;
    return async () => ({ behavior: "deny", reason });
  }

  // Archetype produced no PreToolUse matchers (e.g. software-engineer with
  // zero workspaces) → allow everything — identical to buildHooks installing
  // no PreToolUse hook.
  if (matchers.length === 0) {
    return async () => ({ behavior: "allow" });
  }

  const neverAborted = new AbortController();

  return async (call) => {
    try {
      // GuardrailToolCall → PreToolUse hook-input shape, best-effort session fields.
      const hookInput = {
        hook_event_name: "PreToolUse",
        tool_name: call.toolName,
        tool_input: (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, unknown>,
        session_id: "",
        transcript_path: "",
        cwd: "",
        permission_mode: "bypassPermissions",
      };
      for (const matcher of matchers) {
        // SDK matcher semantics: tool-name pattern when present; absent = all tools.
        if (matcher.matcher && !matchesToolName(matcher.matcher, call.toolName)) continue;
        for (const hook of matcher.hooks) {
          const out = await hook(hookInput as never, undefined, { signal: neverAborted.signal } as never);
          const hso = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)
            ?.hookSpecificOutput;
          if (hso?.permissionDecision === "deny") {
            return { behavior: "deny", reason: hso.permissionDecisionReason ?? "Denied by archetype tool policy." };
          }
          // allow decisions, {continue:true}, empty outputs → keep evaluating.
        }
      }
      return { behavior: "allow" };
    } catch (err) {
      // Any evaluation throw ⇒ deny (spec §D6 point 3).
      return { behavior: "deny", reason: `Archetype gate evaluation failed: ${String(err)}` };
    }
  };
}

function matchesToolName(pattern: string, toolName: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(toolName);
  } catch {
    // Unparseable matcher: treat as matching (evaluate the hook) — the
    // fail-closed direction for a policy hook.
    return true;
  }
}
```

Then in `turn-assembly.ts`, replace `buildDefaultGuardrailGate` (lines 87-94). Predicate, allow-all branch, location, and export all keep — canon; the signature gains one **optional** param (the minimal extension §D6 step 1 requires — matcher production takes the turn's context, exactly as `buildHooks(context)` does):

```typescript
export function buildDefaultGuardrailGate(
  config: AgentConfig,
  workItemContext?: WorkItemContext,
): GuardrailGate {
  const archetypeDef = config.archetype ? getArchetype(config.archetype) : undefined;
  if (archetypeDef && config.archetypeConfig) {
    // KPR-348 (canon 6): real archetype PreToolUse evaluation — ports
    // buildHooks' semantics (the deny-all placeholder body is gone).
    return buildArchetypeGuardrailGate(config, archetypeDef, workItemContext);
  }
  return async () => ({ behavior: "allow" });
}
```

and in `assembleProviderTurn`: `const guardrailGate = buildDefaultGuardrailGate(input.config, input.workItemContext);`

**Relocate, don't delete, the KPR-347 deny-all assertions** in `turn-assembly.test.ts`: the "archetyped agent ⇒ deny" test becomes T2's "assembly-throw ⇒ deny-all" (a fixture archetype whose `preToolUseHooks` throws) — the archetype-less "allow-all" test keeps passing unchanged (canon branch untouched).

- [ ] **Step 3.2: Wire the bridge into `openai-agents-adapter.ts` (§D8)**

Modify `src/agents/provider-adapters/openai-agents-adapter.ts`:

1. Imports: add `tool` to the `@openai/agents` import; add `import { ToolBridge, type BridgedTool } from "./tool-bridge.js";`.
2. Replace the body of `runTurn`'s `try` block start (deleting the KPR-347 zero-tools comment at lines 51-54):

```typescript
    const bridge = new ToolBridge({
      inventory: this.options.assembly.toolInventory,
      inProcessServers: this.options.assembly.inProcessServers,
      gate: this.options.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.options.name,
      sessionCwd: this.options.assembly.sessionCwd,
      skillIndex: this.options.assembly.skillIndex,
    });

    try {
      // KPR-348: connect() is fail-soft per server and never throws (§D7);
      // a fully-failed bridge yields [] and the turn runs tool-less.
      const bridged = await bridge.connect();
      const tools = bridged.map((bt) => bindTool(bt));
      const agent = new Agent({
        name: this.options.name,
        instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
        model: this.options.model,
        ...(tools.length > 0 ? { tools } : {}),
      });
      // …existing runOptions/streamed/non-streamed paths unchanged, except
      // every buildResult call gains: toolStats: bridge.stats
    } catch (error) {
      // Existing catch LOGIC unchanged (isAbortError path etc.) — but its
      // buildResult call site is one of the ones item 3 below governs: it
      // also gains toolStats: bridge.stats, same as every other call site.
    } finally {
      await bridge.close(); // never throws/rejects (advisory 1)
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
```

Module-level helper (SPIKE(S4/S5): shape per the spike record — default shown):

```typescript
function bindTool(bt: BridgedTool) {
  return tool({
    name: bt.name,
    description: bt.description,
    parameters: bt.inputSchema as never, // normalized JSON schema, non-strict (spike S4)
    strict: false,
    execute: (input: unknown) => bt.execute(input),
    // Belt-and-suspenders (§D3): even an SDK-internal invocation fault
    // becomes model-visible text, not a run-loop rejection.
    errorFunction: (_ctx: unknown, err: unknown) =>
      `Tool execution failed (${bt.name}): ${err instanceof Error ? err.message : String(err)}`,
  } as never);
}
```

3. Metrics — `buildResult` signature gains `toolStats?: { toolCalls: number; toolMs: number; perTool: Map<string, number> }` and the body replaces the hardcoded zeros (lines 237-242):

```typescript
    const toolMs = toolStats?.toolMs ?? 0;
    const toolCalls = toolStats?.toolCalls ?? 0;
    const toolSummary =
      toolStats && toolStats.perTool.size > 0
        ? [...toolStats.perTool.entries()].map(([n, c]) => `${n}×${c}`).join(", ")
        : "none";
    return {
      text,
      sessionId,
      costUsd: 0,
      durationMs,
      // §D8 + final-review advisory 2: llmMs excludes tool time (mirrors
      // agent-runner.ts:2089) — the breaker's p95 latency window samples
      // llmMs; folding tool time in would let slow-but-healthy tools trip a
      // healthy endpoint. Clamped: mocked/degenerate timing can't go negative.
      llmMs: Math.max(0, durationMs - toolMs),
      toolMs,
      toolCalls,
      toolSummary,
      // …rest unchanged (token zeros stay — best-effort usage fill only if
      // trivially extractable from the run result's usage surface; not a
      // goal-gate, matrix note otherwise)…
    };
```

All existing `buildResult` call sites pass `toolStats: bridge.stats` (success, abort, and error paths alike — an aborted/failed turn still reports the tool time it consumed).

4. Sessions untouched: `previousResponseId`, `extractSessionId`, `runWithAuthFallback` — zero diff (canon 3). `abort()` untouched (the existing controller already feeds the bridge signal and the SDK `runOptions.signal`).

- [ ] **Step 3.3: T2 tests — `src/agents/provider-adapters/archetype-gate.test.ts`**

Fixtures: real software-engineer archetype via `getArchetype("software-engineer")` after importing `../../archetypes/index.js`; `archetypeConfig` literal copied from the existing fixture shape in `src/archetypes/software-engineer/hooks.test.ts` (workshop = tmpdir, one workspace). Agent config fixture: minimal `AgentConfig` with `archetype: "software-engineer"` (mirror whatever builder `turn-assembly.test.ts` uses).

Cases (each asserting through `buildDefaultGuardrailGate` where noted, else `buildArchetypeGuardrailGate` directly):
  - [ ] Edit inside workspace → `{behavior:"deny"}`, reason contains `code_task` (the flagship parity proof — tool names are Claude-lane-identical so the policy transfers unmodified)
  - [ ] Edit outside any workspace (inside workshop) → allow
  - [ ] Bash anywhere (even workspace path in input) → allow (not in `BLOCKED_TOOLS`)
  - [ ] NotebookEdit with `notebook_path` inside workspace → deny (path-extraction honored)
  - [ ] synthetic archetype def whose `preToolUseHooks` throws → every call denied, reason contains `Archetype hook initialization failed`
  - [ ] synthetic matcher `{matcher: "^Edit$", hooks:[deny-hook]}` → Edit denied, Write allowed (matcher regex honored)
  - [ ] synthetic hook that throws at call time → deny, reason contains `evaluation failed`
  - [ ] synthetic hook returning `{continue: true}` then a second denying hook → deny (evaluation continues past non-deny outputs)
  - [ ] software-engineer with `workspaces: []` → allow-all (matchers `[]` — identical to buildHooks installing nothing)
  - [ ] archetype-less config through `buildDefaultGuardrailGate` → allow-all (canon branch untouched)
  - [ ] narrowing pin: assert the gate produces correct decisions when the hook input contains ONLY `tool_name`/`tool_input` + synthesized fields (this IS the shape the gate builds — the software-engineer cases above already prove sufficiency; add a comment naming the spec's documented narrowing)
  - [ ] **negative-verify (record in PR):** temporarily restore the pre-348 deny-all body and confirm the allow cases (Edit-outside, Bash, workspaces-empty) FAIL; restore. Record command + failing output in the PR description.

- [ ] **Step 3.4: T1/T5/T7 adapter tests — extend `openai-agents-adapter.test.ts`**

Test-harness change: extend the existing `vi.mock("@openai/agents", …)` factory with `tool: vi.fn((cfg: unknown) => cfg)` and export the MCP server class mocks used transitively (the adapter itself doesn't import them, but `tool-bridge` does — mock at the `tool-bridge` boundary instead where simpler: for adapter tests, drive everything through **in-process fixtures + builtin entries**, which need no `@openai/agents` MCP classes at all). Update `makeAssembly` to include `inProcessServers: {}`, `sessionCwd: mkdtemp(...)`.

Tool-call-driving mock: `runnerRunMock`/`runMock` implementations receive the mocked `Agent` (`{options}`) and invoke tools:

```typescript
runMock.mockImplementation(async (agent: { options: { tools?: Array<{ name: string; execute: (i: unknown) => Promise<string> }> } }) => {
  const t = agent.options.tools?.find((x) => x.name === toolNameToCall);
  const toolResult = t ? await t.execute(toolInput) : undefined;
  return { finalOutput: `model saw: ${toolResult}`, lastResponseId: "resp_tool" };
});
```

Cases:

**T7 — integration:**
  - [ ] assembly with one in-process fixture server (real `McpServer`, echo tool) → mocked run invokes `mcp__fixture__echo` → gate spy called first with `{toolName, input, workItemContext}` → result text flows into `finalOutput` → `RunResult.toolCalls === 1`, `toolMs > 0`, `toolSummary === "mcp__fixture__echo×1"`
  - [ ] builtin entry (static Read def) + tmp fixture file → `Read` executes through the executor and returns `cat -n` text
  - [ ] `llmMs` pin: fixture tool sleeps ~50ms → `result.llmMs === result.durationMs - result.toolMs` and `llmMs >= 0`; feed the result through `classifyTurnResult` → success (breaker latency window sees tool-free time — §D8 rationale comment in the test)
  - [ ] streamed variant: mock stream result object (`toTextStream` + `completed`) whose production first awaits one tool `execute` → same stats assertions, `streamed: true`
  - [ ] **zero-tools pin inverted for openai only:** replace KPR-347's T1 assertion (`expect("tools" in agentOptions).toBe(false)`, line ~275) with: non-empty bridgeable inventory ⇒ `agentOptions.tools` present with the bridged names; empty inventory ⇒ no `tools` key (pilot behavior still valid). Confirm `gemini-adk-adapter.test.ts` / `codex-subscription-adapter.test.ts` zero-tools pins are UNTOUCHED and green.

**T1 — containment (seam half):**
  - [ ] gate throws on every call → turn completes, `RunResult.error` undefined, text contains the model-visible denial via the mock, `classifyTurnResult(result)` → `{outcome:"success"}`
  - [ ] in-process handler throws → same (error text visible, turn success)
  - [ ] breaker-neutrality: run 3 consecutive tool-throw turns, feed each result's classification into a real `ProviderCircuitBreaker` instance (constructor/usage per `provider-circuit-breaker` tests) → breaker state stays closed
  - [ ] **negative-verify (unwrapped throw is load-bearing):** hand the mocked run an `agent.options.tools` array containing a RAW throwing execute (bypassing the bridge — constructed inline in the test) → `runTurn` resolves with `RunResult.error` SET (adapter's last-resort catch) — proving the wrapper, not the adapter catch, is what keeps tool faults out of `RunResult.error`. Then negative-verify the negative: same turn through the real bridge → `error` unset.

Note (record in the PR description too): spec §Critical-flows T1 sketches an unwrapped throw as something that would reject `runTurn`; this plan's deliberate refinement is that it instead surfaces as `RunResult.error` SET via the adapter's last-resort catch, so `runTurn` itself still resolves. This is a documented refinement, not a spec deviation — flag it for reviewers so the assertion above isn't mistaken for a regression.

**T5 — abort (adapter half):**
  - [ ] abort during a long-running fake in-process tool (sleeps 10s; abort after 100ms; mocked run rejects with AbortError when signal fires) → `RunResult.aborted === true`, `bridge.close()` invoked (spy via in-process client close), `wasAborted === true`, no unhandledRejection (probe armed) even after the sleeping tool eventually settles
  - [ ] abort during a real `Bash` sleep through the executor (builtin entry, mocked run drives `Bash {command:"sleep 30"}` then rejects on abort) → child process gone within ~6s (pid probe), aborted result
  - [ ] faulting close: in-process fixture whose client `close()` rejects → `runTurn` still resolves normally (advisory 1)

- [ ] **Step 3.5: Verify + commit**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0. Watch: `turn-assembly.test.ts` relocated assertions; gemini/codex suites untouched-and-green; no `types.ts` diff (`git diff --stat` must not list it).

```bash
git add -A src/
git commit -m "KPR-348: archetype guardrail gate port, openai adapter tool wiring, honest telemetry"
```

---

## Task 4 (Chunk 4): Live e2e evidence (T0b) + final verification

- [ ] **Step 4.1: T0b — live end-to-end `openai/…` turn** (dev Mac, real creds — the spike-deferred e2e leg; T0 splits: T0a = Task 0 pre-implementation legs, T0b = this, post-implementation)

Scratch driver (tsx): construct `AgentRunner` + `assembleProviderTurn` + `OpenAIAgentsAdapter` the way `agent-manager.ts:488-534` does (or run a real dev hive with a test agent whose model is `openai/gpt-5.4-mini`), then:

The scratch-driver path is **mandatory** for the abort leg below — the "run a real dev hive" alternative has no way to reach into the adapter and call `adapter.abort()` mid-turn; only the scratch driver holds a direct reference to the adapter instance.
  - [ ] one turn whose prompt forces a bridged MCP tool call (e.g. keychain list via stdio, or slack via hosted MCP) — transcript shows gate-allowed execution and real tool output in the reply
  - [ ] one turn forcing a builtin (`Read` a known file) — reply reflects file content
  - [ ] one turn with `Bash sleep 30` + `adapter.abort()` after ~2s — aborted result, `pgrep sleep` empty, engine process healthy
  - [ ] observed per-turn connect cost noted (spike table last row — matrix note or follow-up decision)

Append all transcripts to `docs/epics/kpr-345/kpr-348-spike-notes.md` under a `## T0b — live e2e` heading.

- [ ] **Step 4.2: Final full verification**

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck + lint + format + full vitest suite green.

Then confirm behavior-neutrality by inspection (use `$(git merge-base kpr-345 HEAD)` rather than the fixed `e774260` sha so these survive a mid-sprint rebase):
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/provider-adapters/gemini-adk-adapter.ts src/agents/provider-adapters/codex-subscription-adapter.ts src/agents/provider-adapters/types.ts` → empty
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/agent-manager.ts` → empty
  - [ ] `claude-agent-adapter.ts` untouched
  - [ ] `git diff $(git merge-base kpr-345 HEAD)..HEAD -- src/agents/agent-runner.ts` → targeted eyeball of the `buildHooks` region specifically (not just an empty-diff check, since this file IS modified for the `buildInProcessServers`/cwd extractions) — confirm `buildHooks` itself has zero lines touched, making the buildHooks-neutrality claim inspectable rather than asserted

- [ ] **Step 4.3: Commit**

```bash
git add docs/epics/kpr-345/kpr-348-spike-notes.md
git commit -m "KPR-348: live e2e evidence (T0b) + verification"
```

---

## Notes for the reviewer (plan-level decisions and their rationale)

1. **Builtin schemas as plain JSON-schema constants, not zod:** spec §D5 says "authored as zod, emitted as JSON schema"; this plan authors the JSON schema directly. Rationale: `zod` is not a direct dependency (transitively resolved today — engine files import it, but adding a zod→JSON-schema emitter would mean another dep), and the bridge already carries every MCP-discovered tool as plain JSON schema through the same non-strict `tool()` path — one schema mechanism instead of two. The contract artifact (`BUILTIN_TOOL_DEFINITIONS: HiveToolSchemaEntry[]`) is exactly what the spec requires.
2. **`buildDefaultGuardrailGate` optional second param:** spec §D6 says the function "keeps its signature" AND that matchers are produced with `workItemContext`. These conflict; the minimal resolution is one optional trailing parameter (existing call sites/tests compile unchanged). Predicate, allow-all branch, location, name: untouched.
3. **T0's e2e leg split (T0a/T0b):** the spec's T0 lists a live end-to-end turn as spike evidence, but the bridge must exist first. Task 0 carries every pre-implementation leg; the e2e leg is Task 4, still recorded in the same evidence file, still blocking for ticket completion.
4. **Chunk-1 `BuiltinExecutor` stub:** lets the bridge's builtin case be written and reviewed in chunk 1 while remaining unreachable (inventory doesn't emit static builtin entries until chunk 2). Alternative (ifdef-style deferral) would put transport-dispatch churn in chunk 2; the stub is smaller.
5. **`sessionCwd`/`inProcessServers` on `ProviderTurnAssembly`:** `inProcessServers` is spec §D4 verbatim; `sessionCwd` is the plan's carrier for §D5-cwd ("resolved once per spawn … throw at assembly → TurnAssemblyError") — additive, KPR-349-compatible.
6. **`resolveTurnCwd` duplicates the small `sessionOptions` try/catch** from `send()` rather than restructuring `send()` (which still needs `settingSources` from the same call). The shared `resolveSessionCwd` helper is the anti-drift point the spec demands (mkdir/stat semantics live once).
7. **`agentId` label:** the adapter passes its display `name` (agent-manager is a no-touch file per the spec's integration table, so the agent id isn't available without widening `OpenAIAgentsAdapterOptions` — which KPR-352/353 can do when they need it).
