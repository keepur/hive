# KPR-348 — OpenAI tool bridge: MCP stdio/http, in-process function tools, builtin executor, guardrail gate

**Child 3 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D4 (this child's design section), §D7 (guardrail parity), §D1 (two lanes), §D5/D6 (siblings' seams — consumed, not implemented).
**Shape:** the epic's largest net-new component (builtin executor) + the bridge that makes `openai/…` turns actually execute tools. **Depends on:** KPR-347 (merged @ e774260 — all contract references below verified against that baseline in this worktree). **Informs:** KPR-352/353 (gemini/codex replication reuse the bridge core), KPR-349 (renders into the same seam file), KPR-350 (session mechanics beside, never through, this bridge).
**Decision-register canon honored:** entries 1–7 (KPR-347 coherence review). Each is cited inline where it binds.
**Provider-surface evidence:** primary = the installed `@openai/agents` **0.11.4** type declarations + shim sources read directly (`~/github/hive/node_modules/@openai/agents-core/dist/{mcp.d.ts,tool.d.ts,agent.d.ts,run.d.ts,shims/mcp-server/node.js}`, and `@modelcontextprotocol/sdk/dist/cjs/client/stdio.js`), verified **2026-07-20**. Secondary = [Agents SDK MCP guide](https://openai.github.io/openai-agents-js/guides/mcp/) and [tools guide](https://openai.github.io/openai-agents-js/guides/tools/) (fetched 2026-07-20). Provider docs churn fast — the plan's spike (step 0) re-verifies the load-bearing behaviors live before any dependent chunk starts.

## TL;DR

Make `openai/…` turns execute real hive tools. The bridge consumes `assembly.toolInventory` (the KPR-347 bridgeable partition) and materializes it per transport class: **stdio MCP** → Agents SDK `MCPServerStdio`, **http/sse MCP** → `MCPServerStreamableHttp` (headers via `requestInit` — the hosted Slack MCP is load-bearing), **sdk-in-process** → MCP client over `InMemoryTransport` against the same `createSdkMcpServer` instances (same handlers, same `*ContextRef` context), **claude-builtin** → a new hive **builtin executor** (Bash/Read/Write/Edit/Glob/Grep) whose semantics match the agent-facing contract, not CLI internals. Every tool — regardless of transport — is presented to the model as a hive-wrapped function tool whose dispatch wrapper enforces, in order: **guardrail gate** (real archetype PreToolUse evaluation replacing KPR-347's deny-all placeholder — canon 6), **execution**, **exception containment** (any throw → structured error result to the model, `non-provider`, never escapes `runTurn`). `abort()` mid-bridge kills builtin subprocesses, discards in-flight tool results, and closes every MCP connection in a `finally`. Plan step 0 is the ⚠ `MCPServerStdio` fidelity spike (Gate 1 delegated assumption (a)).

## Key Points

- **One dispatch loop, one gate.** The bridge never passes servers via `Agent.mcpServers` — it connects MCP servers itself (`listTools`/`callTool` as clients) and wraps every tool as a hive function tool. That single wrapper is where the gate, exception containment, abort propagation, and tool metrics live. Rejected alternative: `Agent.mcpServers` + SDK `needsApproval`/guardrails (§D2 records why — wrong deny semantics, no gate hook on MCP-converted tools).
- **Schema materialization happens here** (canon 1): `connect-time` entries resolve to real schemas at bridge connect (`tools/list` for stdio/http/sse, in-memory `listTools` for sdk-in-process); the builtin executor's authored tools are the **only** `{kind:"static"}` producer — `buildToolTransportInventory`'s claude-builtin entries flip from `unavailable` to `static` for the six executor-backed tools.
- **Tool names preserve Claude-lane identity:** MCP tools surface as `mcp__<server>__<tool>`, builtins as `Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep` — so archetype rules (which match tool names, e.g. the software-engineer `BLOCKED_TOOLS` set) apply unchanged, and prompts/memory that reference tool names stay true across providers.
- **Guardrail gate becomes real** (canon 6): the deny-all body in `buildDefaultGuardrailGate` is replaced by a port of `buildHooks`' archetype evaluation — same `archetypeDef.preToolUseHooks()` production, same fail-closed-on-throw posture, hook outputs (`permissionDecision: "deny"` / `{continue: true}`) mapped to `GuardrailDecision`. The two-part predicate and the allow-all branch are untouched (canon).
- **Exception containment is structural, not incidental:** the dispatch wrapper's `execute` **cannot throw** — gate throw ⇒ deny (typed contract, `types.ts:119-126`), handler/builtin/MCP-call throw ⇒ structured error text to the model. The SDK's `errorFunction` is set as belt-and-suspenders. Contract tests pin all three throw sites plus the no-escape property (a tool-layer throw can never reach the breaker's `classifyThrown` path and misread as a provider fault — epic §D4 invariant).
- **`abort()` mid-bridge** (canon 5 — manager-owned early abort is done; this is the runTurn-interior half): the adapter's existing `AbortController` signal reaches the SDK run loop (already wired) **and** the bridge — builtin executor kills its process group, MCP `close()` runs in a `finally` on every path (terminates stdio subprocesses), in-flight non-cancellable results are discarded without unhandled rejections.
- **Builtin executor scope ruling:** Bash, Read, Write, Edit, Glob, Grep ship; WebFetch/WebSearch (MCP substitutes exist: brave-search, browser), NotebookEdit, TodoWrite, Task (child 9) stay claude-only, matrix-listed. Semantics are the **agent-facing contract**: `cat -n` Read format, exact-match Edit with uniqueness, Bash with timeout/truncation and *documented* no-cwd-persistence (the same contract hive already states for subagent bash), cwd resolved exactly as the Claude lane resolves it (archetype `sessionOptions.cwd` else agent scratch dir).
- **Reuse designed in where free** (for KPR-352/353): the bridge core (`tool-bridge.ts`) is provider-neutral — it produces `BridgedTool[]` (name, description, normalized JSON schema, gated+contained `execute`) and owns lifecycle; only the last mile (`BridgedTool` → Agents SDK `tool()` → `Agent.tools`) is OpenAI-specific and lives in the adapter. Gemini/codex children bind the same `BridgedTool[]` to their own SDK shapes. Their adapters' zero-tools stubs are **not** flipped here.
- ⚠ **Spike first** (plan step 0, Gate 1 delegated assumption (a)): `MCPServerStdio` fidelity against real hive stdio servers — env passing (verified in source: `{...getDefaultEnvironment(), ...env}` merge inheriting HOME/PATH/SHELL/etc.), lifecycle/close, concurrency, timeout defaults, schema acceptance — plus hosted Slack MCP over `MCPServerStreamableHttp` with `Authorization` via `requestInit` (verified present in shim source; live-verified in spike). Fallback if infidelity surfaces: the bridge speaks `@modelcontextprotocol/sdk` `Client` directly (already the in-process mechanism), contained entirely inside `tool-bridge.ts`.

## Problem

Post-KPR-347 the seam is wired but dead-ended: `assembleProviderTurn` builds a real partitioned inventory and a guardrail gate, `OpenAIAgentsAdapter` receives them — and deliberately ignores them. The flip-point comments mark the exact sites (`openai-agents-adapter.ts:51-54`: "KPR-348 flips this (no `tools` key here until then)"). Three gaps:

1. **No execution path.** `HiveToolInventoryEntry` carries `serverConfig` (stdio/http/sse) and declares `schemas: {kind:"connect-time"}` for MCP entries — but nothing connects, discovers, or dispatches. In-process entries have no carrier at all (their `serverConfig` is deliberately omitted; the factories live in `AgentRunner.send()`'s lazy-construction block, `agent-runner.ts:1559-1728`, which only the Claude lane runs).
2. **No builtin equivalents.** claude-builtin entries are `{schemas: "unavailable", compatibility: claude-only}` (`tool-transport.ts:84-99`, `agent-runner.ts:1286-1296`) — a reassigned agent loses Bash/Read/Write/Edit entirely, violating R3 for the most-used tools in the fleet.
3. **The gate is a placeholder.** `buildDefaultGuardrailGate` (`turn-assembly.ts:87-94`) deny-alls every archetyped agent — correct posture pre-tools, useless once tools execute. Real archetype evaluation exists only as SDK hook matchers (`buildHooks`, `agent-runner.ts:1461-1499`) consumed by the Claude CLI.

## Goals

- G1: `openai/…` turns execute every bridgeable tool class: stdio MCP, http/sse MCP (Slack hosted MCP demonstrably working), sdk-in-process, claude-builtin (via the executor).
- G2: Schema materialization per canon 1 — connect-time discovery for MCP entries; authored static schemas for the executor's six tools, flowing back into the inventory declaration.
- G3: Guardrail gate performs real archetype PreToolUse evaluation with `buildHooks`-identical semantics; fail-closed on every error path (canon 6).
- G4: Exception-containment invariant holds structurally, with contract tests: throwing gate / throwing in-process handler / throwing builtin / throwing MCP call ⇒ structured error result, `non-provider`-classified world, never escapes `runTurn`, never trips a breaker.
- G5: `abort()` mid-bridge: subprocesses killed, MCP servers closed on every path, aborted `RunResult` returned, no unhandled rejections.
- G6: Honest tool telemetry on Lane B: `toolCalls`/`toolMs`/`toolSummary` populated by the dispatch wrapper (replacing the hardcoded zeros/`"none"`).
- G7: Bridge core reusable by KPR-352/353 without redesign (provider-neutral `BridgedTool[]`), at zero extra build cost here.

## Non-goals

- Flipping the **gemini/codex** adapters' zero-tools stubs — KPR-352/353 (their `assembly` is already carried; only `openai-agents-adapter.ts` changes here).
- Prompt assembly, memory bundle, skill-index **population**, toolkit-section rendering — KPR-349. (The bridge *renders* a `load_skill` function tool when `assembly.skillIndex` is non-empty — dark until 349 populates it; ruling in §D6.)
- Resume/session semantics — KPR-350. `SESSION_SEMANTICS`, `LaneBProviderId`, `previousResponseId` wiring in the adapter are untouched (canon 3).
- Subagent parity — child 9. `claude-subagent` entries remain claude-only and partition-omitted.
- Lane A anything; voice (epic-pinned to Claude lane); parity matrix (child 10 — this spec's caveats feed it).
- Token/cost accounting parity beyond a best-effort usage fill (§D8); no new config knobs (simplicity ruling — constants over levers).
- The pre-existing `prepareSpawn` abort gap — canon 7: candidate follow-up, explicitly not this ticket.

## Design

### D1 — Bridge architecture: one loop, four transports

New file `src/agents/provider-adapters/tool-bridge.ts`. The bridge is constructed per spawn from the assembly (adapters are per-spawn — canon 4's invariant makes construction-time ≡ turn-time) and produces a uniform tool surface:

```ts
export interface BridgedTool {
  /** Provider-facing name — Claude-lane-identical (mcp__<server>__<tool>, or Bash/Read/…). */
  name: string;
  description: string;
  /** Normalized JSON schema (§D1.5). */
  inputSchema: Record<string, unknown>;
  /** Gated + contained + metered. NEVER throws. Returns model-visible text. */
  execute(input: unknown): Promise<string>;
}

export class ToolBridge {
  constructor(opts: {
    inventory: HiveToolInventoryEntry[];      // assembly.toolInventory
    inProcessServers: Record<string, McpSdkServerConfigWithInstance>; // assembly (§D4)
    gate: GuardrailGate;                       // assembly.guardrailGate
    workItemContext?: WorkItemContext;         // for GuardrailToolCall
    signal: AbortSignal;                       // the turn's abort signal
    agentId: string;                           // logging/telemetry only
  });
  /** Connect all transports, discover schemas, build BridgedTool[]. Fail-soft per server (§D7). */
  async connect(): Promise<BridgedTool[]>;
  /** Idempotent. Closes every MCP connection, kills builtin children. Called in finally. */
  async close(): Promise<void>;
  /** Dispatch-loop metrics for RunResult (§D8). */
  readonly stats: { toolCalls: number; toolMs: number; perTool: Map<string, number> };
  /** R3 honesty: servers that failed to connect this turn (names + reason class only). */
  readonly runtimeOmissions: { server: string; reason: string }[];
}
```

Per transport class (from each entry's `transport` field):

| Transport | Mechanism | Evidence |
|---|---|---|
| `stdio` | `new MCPServerStdio({command, args, env, cacheToolsList: true, ...timeouts})` from the entry's `serverConfig` (KPR-347 attached the exact Claude-lane config, resolved secret-env and all). Env semantics: the MCP SDK merges `{...getDefaultEnvironment(), ...env}` — HOME/LOGNAME/PATH/SHELL/TERM/USER inherited, explicit vars win (`@modelcontextprotocol/sdk` `client/stdio.js`, read 2026-07-20). Hive's stdio configs that pin `PATH`/`HOME` explicitly (google, github-issues, browser) keep working; those that omit them get the safe inherited set. | `mcp.d.ts:299-328`; spike verifies live |
| `http` / `sse` | `new MCPServerStreamableHttp({url, requestInit: {headers}, ...})` — the entry's `serverConfig.headers` (e.g. Slack `Authorization: Bearer`) map to `requestInit.headers`, which the shim passes verbatim to `StreamableHTTPClientTransport` (`shims/mcp-server/node.js:441-449`). Legacy `sse` entries use `MCPServerSSE` (same options shape). Slack hosted MCP (`agent-runner.ts:472-480`) is the load-bearing case — in the fleet's universal-9 baseline. | `mcp.d.ts:331-346`; spike verifies live |
| `sdk-in-process` | MCP client over `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/inMemory.js`, already a transitive dep) connected to the **same** `McpServer` instance the Claude lane would use — `createSdkMcpServer` returns `McpSdkServerConfigWithInstance` with the underlying `instance: McpServer` exposed (`@anthropic-ai/claude-agent-sdk` `sdk.d.ts:795-796`). Same handlers, same structured-error wrappers (KPR-122), same `*ContextRef` closures — zero handler duplication. Instances come from the assembly (§D4). | verified in local SDK types |
| `claude-builtin` | The builtin executor (§D5) — direct function tools, no MCP hop. | — |

After `connect()`, every discovered/authored tool becomes a `BridgedTool` whose `execute` is the dispatch wrapper (§D3). The OpenAI adapter binds `BridgedTool[]` → Agents SDK `tool({name, description, parameters, strict: false, execute, errorFunction})` → `Agent({..., tools})`. `Agent.mcpServers` is **never used** (§D2).

**Lifecycle:** `runTurn()` does `bridge.connect()` inside its existing try (after the AbortController is armed), runs the model, and calls `bridge.close()` in a `finally` — every path: success, error, abort, throw. Per-turn stdio subprocess spawn matches today's Claude-lane cost model (the CLI spawns stdio MCP servers per `query()` since KPR-220 per-turn spawns); no regression, noted for the matrix. Connect runs servers in parallel; `cacheToolsList: true` per server (server objects are per-spawn, so the cache scope is one turn).

**Timeouts (constants, not config):** connect/session RPC `clientSessionTimeoutSeconds: 30`; per-tool-call `timeout: 600_000` ms (aligned with the Bash max, generous enough for code-task-class tools). The spike validates SDK defaults are actually overridden by these options — and explicitly confirms the **units** on each: agents-core's `clientSessionTimeoutSeconds` is seconds, while the MCP SDK's `RequestOptions.timeout` (the per-call knob the shim ultimately threads through) is milliseconds. A seconds/ms mix-up here would silently produce an absurd timeout (e.g. a 30ms session timeout or a 600-second-mistaken-for-600ms tool-call timeout) rather than a loud failure, so the spike records the confirmed unit for each knob before any dependent chunk starts.

### D2 — Ruling: bridge-owned dispatch, not `Agent.mcpServers`

**Decision: MCP servers are used as *clients* (connect/listTools/callTool); tools are always presented to the model as hive-wrapped function tools. `Agent.mcpServers` is not used.**

- The SDK's `Agent.mcpServers` path converts MCP tools to function tools internally (`mcpToFunctionTool`) and invokes `server.callTool` directly — there is **no gate hook** on that path. `needsApproval` produces *interruptions* requiring an approval-resolution loop (human-in-the-loop shape); a PreToolUse deny is not an interruption — it is a deterministic, model-visible denial that lets the turn continue, exactly like the Claude lane's `permissionDecision: "deny"`. Agent-level input guardrails abort the whole run on tripwire — also the wrong shape.
- A single wrapper gives one place for the containment invariant, abort propagation, and metrics — three obligations this ticket owes contract tests for. Split dispatch (SDK-managed MCP + hive-managed builtins) would double every test surface.
- Implementation freedom (plan decides post-spike): the wrapper may reuse the SDK's conversion (`getAllMcpTools`/`mcpToFunctionTool`, decorating the returned `FunctionTool.invoke`) or hand-roll `tool()` per discovered schema — behavior contract is identical; `BridgedTool` hides the choice.

### D3 — The dispatch wrapper (gate → execute → contain)

Every `BridgedTool.execute` body, uniformly:

```
1. gate: decision = await gate({toolName, input, workItemContext})
     — wrapped in try/catch: a gate THROW is a DENY (typed contract, types.ts:119-126)
2. deny → return the denial as model-visible text:
     `Tool call denied by policy: <reason>` (turn continues — PreToolUse parity)
3. allow → t0 = now; result = await underlying(input)   // MCP callTool | in-process callTool | builtin
4. shape result → text (§D3.1); stats.toolCalls++, stats.toolMs += now-t0
5. ANY throw in 3-4 → return `Tool execution failed (<name>): <message>`
     (mirrors the KPR-122 in-process structured-error invariant)
```

The wrapper **never throws** — that is the structural half of the epic §D4 exception-containment invariant. Belt-and-suspenders: the Agents SDK `errorFunction` is also set (tool-level and, if the SDK conversion path is used, server-level `errorFunction`), so even an SDK-internal invocation fault becomes a model-visible message rather than a run-loop rejection. The adapter's existing catch → `RunResult.error` remains the last resort only; nothing in the bridge path is designed to reach it. Consequences for classification: a turn with failing tools is a *successful* turn (`RunResult.error` unset) — tool failures are model-visible, `non-provider` by construction, breaker-invisible (KPR-306 rule unchanged).

**§D3.1 Result shaping:** MCP `CallToolResultContent` text items are joined with `\n`; non-text content items (image/audio/resource) become a placeholder line `[non-text content: <type> — not supported on this provider lane]` (matrix caveat). Builtin results are already text.

### D4 — In-process servers: assembly carries the instances

`assembleProviderTurn` (the seam file both 348 and 349 edit, per its header) gains one step and one field:

- New `AgentRunner` method `buildInProcessServers(context?: WorkItemContext): Record<string, McpSdkServerConfigWithInstance>` — extracted from `send()`'s lazy-construction block (`agent-runner.ts:1559-1728`), preserving exact behavior: per-runner instance caching, `shouldEnableInProcessServer` gating, `config.workflow.enabled` gate, `*ContextRef.current` refresh from `context` (callback + structured-memory), prefix-cache invalidation closures. `send()` calls it; behavior on the Claude lane is unchanged (existing runner tests + a refactor-equivalence test pin this). On the Lane B path the runner is fresh per spawn, so instances are fresh per spawn and connect only to the bridge's in-memory client.
- `ProviderTurnAssembly` gains `inProcessServers: Record<string, McpSdkServerConfigWithInstance>` (additive; built inside the existing `TurnAssemblyError` try — a Mongo fault during factory construction classifies `non-provider`, per canon 4's throw contract). The bridge filters this record by the inventory's `sdk-in-process` entry names — the inventory remains the single source of *which* servers the agent gets; the record is merely the carrier for *how*.

Context threading: `*ContextRef.current` is set during assembly with the turn's `WorkItemContext` — per-spawn adapters make construction-time ≡ turn-time (canon 4), so handlers see the correct channel/thread for the whole turn.

### D5 — Builtin executor

New component `src/agents/provider-adapters/builtin-executor.ts` (internal layout — one file or a `builtins/` dir — is a plan choice). Authors six function tools with static schemas and executes them in-engine.

**Scope ruling (which builtins get equivalents):**

| Tool | Ships? | Rationale |
|---|---|---|
| Bash, Read, Write, Edit, Glob, Grep | **yes** | the working set; archetype rules reference Edit/Write by name |
| WebFetch / WebSearch | no — claude-only | MCP substitutes in fleet baseline (brave-search, browser/CDP); epic already lists this caveat for Lane A |
| NotebookEdit, TodoWrite | no — claude-only | niche / CLI-UI-coupled; matrix-listed |
| Task | no — child 9 | `claude-subagent` parity is its own child |
| MultiEdit | no | not in the advertised builtin set; `Edit` + `replace_all` covers; archetype's `BLOCKED_TOOLS` mention is harmless (absent tool can't be called) |

**Semantics = the agent-facing contract** (what the tool description promises the agent), explicitly **not** CLI internals:

- **`Bash`** `{command, timeout?, description?}` — `execFile("/bin/bash", ["-c", command])` (argv array — the CLAUDE.md no-shell-string rule governs *engine interpolation of untrusted input*; Bash-the-tool is the agent's own command surface, identical posture to the Claude lane under `bypassPermissions`). cwd = §D5-cwd. Timeout default 120 s, max 600 s. Combined stdout+stderr, truncated at 30 000 chars with a truncation marker; non-zero exit appends `Exit code N` (model-visible result, not an error). **No cwd/env persistence across calls** — documented caveat, and already the stated hive contract for agent-thread bash ("cwd reset between calls; use absolute paths"). No `run_in_background` (the `background` MCP server is the fleet's sanctioned mechanism; param omitted from the schema so the model can't reach for it).
- **`Read`** `{file_path, offset?, limit?}` — `cat -n` format, line numbers from 1, 2000-line default window, long lines truncated at 2000 chars; missing file/directory → error text. Text only: images/PDF/notebooks → `unsupported on this provider lane` error text (matrix caveat).
- **`Write`** `{file_path, content}` — creates parents, overwrites. The Claude lane's read-before-overwrite affordance is CLI-session state; not enforced here (documented divergence, matrix-listed).
- **`Edit`** `{file_path, old_string, new_string, replace_all?}` — exact-match; not-found and non-unique matches are distinct error texts mirroring the agent-facing failure modes. Stateless — full fidelity.
- **`Glob`** `{pattern, path?}` — matches sorted by mtime (newest first). Implementation uses an existing repo glob dep if present, else adds `tinyglobby` (plan verifies; dependency addition declared here either way as possible).
- **`Grep`** `{pattern, path?, glob?, output_mode?, -i?, -n?, context?}` — pure-Node line-regex implementation over walked files; supported-subset schema only (honest surface — the model cannot pass ripgrep flags we don't honor).

**cwd posture:** resolved once per spawn, exactly the Claude-lane rule (`agent-runner.ts:1765-1795`): archetype `sessionOptions().cwd` wins with the same fail-loud stat check (throw at assembly → `TurnAssemblyError` → `non-provider`); otherwise `agentScratchDir(agentId, hiveHome)` lazily created. The resolution is extracted to a small shared helper so the two lanes cannot drift.

**Sandboxing/permissions posture:** none beyond the gate — parity with the Claude lane's `bypassPermissions` mode (agents are employees; per-agent guardrails are archetype/prompt-level). Bash/Read run as the engine user with the engine's env, which is what Claude-lane Bash already sees — **no new credential exposure surface** relative to the Claude lane (the DOD-212 "no agent-visible `.env` exfil paths" concern is lane-equivalent, not expanded; noted for the security review lens).

**Schemas:** authored as zod, emitted as JSON schema; exported as `BUILTIN_TOOL_DEFINITIONS` (name/description/inputSchema) so `buildToolTransportInventory` sources `{kind: "static", tools}` from the executor module (canon 1 — the reserved `static` producer). Import direction: `agent-runner.ts` → `provider-adapters/builtin-executor.ts` (same direction as its existing `tool-transport.ts` import; no cycle).

**Inventory/classifier changes** (`tool-transport.ts:41-49, 84-99`; `agent-runner.ts:1286-1296`): the compound display names (`"Read / Write / Edit"`, …) are replaced by per-tool entries. The six executor-backed tools classify `{claude: "direct", openai: "requires-hive-bridge", gemini: "requires-hive-bridge", codex: "requires-hive-bridge"}` — codex mirrors openai at the classify site (canon 2; one code path emits both), and gemini is upgraded identically for classification honesty (ruling: the gemini *adapter* still advertises zero tools until KPR-352 — only its partition log/omission record changes, no behavior). WebFetch/WebSearch/NotebookEdit/TodoWrite/Task remain `claude-only` + `unavailable`.

### D6 — Guardrail gate: real archetype evaluation (canon 6)

`buildDefaultGuardrailGate` (`turn-assembly.ts:87-94`) keeps its signature, location, predicate (`archetypeDef && config.archetypeConfig`), and allow-all branch (all canon). The deny-all body is replaced by delegation to a new helper (`src/agents/provider-adapters/archetype-gate.ts`):

1. **Produce matchers once at assembly:** `archetypeDef.preToolUseHooks({agentConfig, archetypeConfig, workItemContext})` — inside try/catch; a throw installs a deny-all gate with the same reason shape as `buildHooks`' fallback (`agent-runner.ts:1477-1495`). Fail-closed parity, verbatim posture.
2. **The returned gate evaluates per call:** adapt `GuardrailToolCall` → the PreToolUse hook-input shape (`{tool_name, tool_input, hook_event_name: "PreToolUse"}` + best-effort session fields); for each matcher whose `matcher` pattern (tool-name regex, when present) matches `toolName`, run its hooks in order. First `permissionDecision: "deny"` wins → `{behavior: "deny", reason}`. `{continue: true}`, allow decisions, or empty outputs → keep going; no denial ⇒ `{behavior: "allow"}`.
3. **Any evaluation throw ⇒ deny** with the error in the reason (both the gate's own catch and the bridge wrapper's throw-is-deny rule — double containment).

**Documented narrowing:** archetype hooks consumed via the gate must depend only on `tool_name`/`tool_input` (+ the synthesized event fields) — true of the only registered archetype (software-engineer reads exactly those, `hooks.ts:38-46`) and pinned by a contract test; a future archetype needing full CLI session fields is a deliberate extension of the adapter shape, not silent breakage. Because builtin tools keep Claude-lane names (§Key Points), the software-engineer workspace policy (block Edit/Write inside workspaces → steer to `code_task`) transfers to Lane B **unmodified** — the flagship guardrail-parity proof.

**`load_skill` ruling (seam split with KPR-349):** the bridge renders a `load_skill` function tool (name → read that entry's `SKILL.md`, path-validated against the index) whenever `assembly.skillIndex` is non-empty. It ships here — dark, since KPR-347 pins `skillIndex: []` until 349 — so KPR-349 stays a pure assembly-side child and never edits bridge internals. Contract-tested against a fixture index. Like every other bridged tool, `load_skill` goes through the same gated dispatch wrapper (§D3) — no special-casing in the gate or containment path — and it stays the minimal read-and-return tool described (path-validated lookup + file contents back to the model; no listing, search, or write surface).

### D7 — Failure containment at connect, and runtime omissions

Per-server **fail-soft**: a server that fails `connect()`/`listTools()` is dropped from this turn's tool surface, logged at `warn` (server name + error class, never configs/env — the KPR-347 secrecy rule), and recorded in `bridge.runtimeOmissions` (the runtime sibling of the assembly's partition-time `omittedTools` — R3's "nothing silently dropped," now covering the temporal gap between partition and connect). The turn proceeds with the remaining tools; an all-servers-failed turn still runs with builtins. No connect failure may throw out of `runTurn` — connect errors are hive/tool-side, `non-provider` by nature, and a healthy OpenAI endpoint must not eat a breaker fault because Mongo or a plugin subprocess is sick (same reasoning as `TurnAssemblyError`, enforced by the bridge's own catch rather than a wrapper type since `connect()` runs inside `runTurn`).

### D8 — Adapter wiring and telemetry (`openai-agents-adapter.ts`)

- `runTurn()` constructs the bridge, connects, builds `tools` (BridgedTool → `tool()` with `strict: false` + normalized schema §D1.5-style defaults `{required: [], additionalProperties: false}` filled when absent — spike-verified acceptance), passes them to `new Agent({..., tools})` — deleting the KPR-347 zero-tools comment at `:51-54`. `finally` → `bridge.close()`.
- **Metrics:** `buildResult` takes `toolCalls`/`toolMs`/`toolSummary` from `bridge.stats` (`toolSummary` = `"name×count"` joined, `"none"` when zero) — replacing hardcoded zeros (`:240-242`). Best-effort token usage from the run result's usage surface if trivially extractable (else stays 0 — matrix note; not a goal-gate). **`llmMs` exclusion:** today the adapter sets `llmMs: durationMs` (`openai-agents-adapter.ts:239`); once real tool dispatch lands, `llmMs = durationMs - stats.toolMs`, mirroring the Claude lane's `llmMs = durationMs - totalToolMs` (`agent-runner.ts:2089`). This matters beyond cosmetic parity: the circuit breaker's p95 latency trip samples `llmMs` on successful turns (`provider-circuit-breaker.ts:11,264`) — leaving tool time folded into `llmMs` would let a tool-heavy-but-healthy openai turn feed slow-tool time into the breaker's latency window, tripping a healthy endpoint via the latency path and defeating G4's "never trips a breaker" guarantee.
- **Abort:** existing `AbortController` (`:43-45, :122-125`) additionally feeds the bridge's `signal`. On abort: SDK run loop stops (already wired via `runOptions.signal`), builtin executor kills its process group (SIGTERM → SIGKILL after 5 s), in-flight MCP/in-process calls have no protocol-level cancel — their settled results are discarded by the already-rejected run; wrapper catches keep them from becoming unhandled rejections; `finally` close tears down stdio subprocesses. `wasAborted`/aborted-result behavior unchanged (`isAbortError` path).
- **Name normalization:** OpenAI function-name constraints (`[a-zA-Z0-9_-]`, ≤64 chars) — hive names already comply in the fleet (`mcp__structured-memory__…` worst-case ≈ 45); the bridge enforces deterministic sanitize/truncate-with-hash on violation plus collision dedupe, logged (edge case, not expected in production).
- **Tool-count cap:** if the bridged surface exceeds the provider's per-request tool limit (128), keep inventory order, drop the tail into `runtimeOmissions`, log loudly. Unreachable for baseline agents; plugin-heavy edge documented.
- Sessions untouched: `previousResponseId` chaining, `extractSessionId`, `SESSION_SEMANTICS` — all KPR-350 surface (canon 3).

## Integration points

| Seam | This ticket | Must NOT touch |
|---|---|---|
| `turn-assembly.ts` | gate body (§D6), `inProcessServers` field + build step (§D4) | `instructions` production (`buildPilotInstructions` call — KPR-349 swaps it); `memory`/`skillIndex` population (KPR-349) |
| `tool-transport.ts` | claude-builtin classify branch upgrade + per-tool builtin names + `static` schemas (§D5) | compatibility semantics for MCP transports; partition function; `LaneBProviderId` |
| `agent-runner.ts` | extract `buildInProcessServers` (behavior-preserving); builtin inventory entries (§D5); shared cwd-resolution helper | prompt/prefix assembly (`buildSystemPrompt`/`buildPrefix` — KPR-349's extraction), hooks wiring for the Claude lane (`buildHooks` stays; the gate *ports* its semantics, does not modify it) |
| `openai-agents-adapter.ts` | tools wiring, metrics, abort-to-bridge (§D8) | session fields; auth-fallback machinery (`runWithAuthFallback`) |
| `agent-manager.ts` | none (seam landed in KPR-347: `createProviderAdapter` :488-534, early-abort closure :1177-1198) | early-abort closure (canon 5 — manager side done); `prepareSpawn` abort gap (canon 7 — follow-up candidate only) |
| `gemini-adk-adapter.ts` / `codex-subscription-adapter.ts` | none — zero-tools stubs stay; KPR-352/353 bind `BridgedTool[]` to their SDK shapes | everything |
| `types.ts` | none (GuardrailGate/Decision/ToolCall consumed as-is) | `SESSION_SEMANTICS`, provider unions |
| deps | `@openai/agents` already at `^0.11.4` (package.json:76 — no dependency addition); possible small glob dep (§D5) | — |

**What KPR-352/353 reuse:** `ToolBridge` + `BridgedTool[]` + the gate + the builtin executor wholesale; their work is the last-mile binding (ADK tool shape / Responses `tools` array) plus their own containment/abort contract tests against their SDKs. The MCP client classes (`MCPServerStdio` etc.) are provider-neutral MCP plumbing from `@openai/agents-core` — reusing them in the shared core is deliberate and documented (they carry no OpenAI API coupling).

## Edge cases

- **Gate deny mid-turn:** model receives the denial text and continues — a denied tool never aborts the turn (PreToolUse parity).
- **Abort during `connect()`:** partial connections closed by the `finally`; aborted result via the existing path.
- **Abort during a long Bash:** process group killed; wrapper returns (discarded); no unhandled rejection (test-pinned).
- **Server emits schema without `required`/`additionalProperties`:** normalized defaults filled (§D8); spike verifies the SDK accepts the normalized non-strict form.
- **Duplicate tool names across servers:** `mcp__<server>__` prefixing prevents it; post-sanitization collision → deterministic suffix + log.
- **Empty bridgeable inventory:** bridge yields `[]`; Agent runs tool-less — the pilot behavior, still valid.
- **Archetyped agent, archetype hooks return `[]`** (e.g. software-engineer with zero workspaces): gate allows everything — identical to `buildHooks` (no PreToolUse installed).
- **In-process handler mutates `*ContextRef` expectations:** refs are set at assembly with the turn's context; per-spawn instances mean no cross-turn bleed.
- **Non-text MCP content:** placeholder line (§D3.1), matrix-listed.
- **Reflection turns on an openai agent:** same path; tools available during reflection exactly as on the Claude lane.
- **Engine shutdown mid-turn:** process exit reaps stdio children (no detach); no new orphan class beyond the Claude lane's.

## Testing contract sketch

Vitest beside source; `npm run check` green. The exception-containment and abort tests are this ticket's headline obligations (epic §D4, Gate 1 assumption (b) via T3).

- **T0 — spike evidence (plan step 0, ⚠ gate for chunks 1+):** recorded transcript/script results — `MCPServerStdio` against ≥2 real hive stdio servers (candidates: keychain, background — low-dependency) covering env passing (explicit + inherited), `tools/list` schema acceptance, `callTool` round-trip, 3-server concurrency, `close()` leaves no orphan (ps-verified), timeout options honored; `MCPServerStreamableHttp` against the hosted Slack MCP with `Authorization` via `requestInit` (connect + list + one read-only call); one live end-to-end `openai/…` turn with a bridged MCP tool + a builtin + an abort mid-Bash. Fallback decision recorded if any leg fails (§Key Points last bullet).
- **T1 — containment (contract):** throwing gate ⇒ deny-shaped result text, turn completes; throwing in-process handler ⇒ structured error text; throwing builtin ⇒ structured error text; throwing MCP `callTool` ⇒ structured error text. In all four: `runTurn` resolves, `RunResult.error` unset, `classifyTurnResult` → success; seam-level: 3 repeated tool-throw turns leave the openai breaker **closed** (existing breaker harness). Negative-verify: a deliberately unwrapped executor throw (test-only bypass) rejects `runTurn` — proving the wrapper is load-bearing.
- **T2 — gate port parity:** software-engineer fixture — Edit inside workspace → deny, reason contains the code_task steer; Edit outside → allow; Bash anywhere → allow (not in `BLOCKED_TOOLS`); NotebookEdit path extraction honored; `preToolUseHooks` throw at assembly → deny-all gate; hook throw at call time → deny; matcher-regex matchers honored; archetype-less → allow-all (canon branch untouched). Negative-verify against the pre-348 deny-all body: the allow cases fail on reverted source.
- **T3 — builtin executor semantics (contract = agent-facing behavior):** Read `cat -n` format/offset/limit/line+window truncation/missing-file text; Edit uniqueness + not-found + replace_all; Write parent creation + overwrite; Bash exit-code surfacing, timeout kill, 30k truncation, cwd = resolved dir, argv (no shell-string of engine data); Glob mtime ordering; Grep mode subset. Golden texts assert the *contract*, with a comment forbidding assertions on CLI-internal quirks.
- **T4 — bridge materialization:** fixture inventory (stdio + http + in-process + builtin + a claude-only entry) with mocked MCP clients → correct `BridgedTool` names (`mcp__*` + bare builtins), normalized schemas, claude-only never materialized, connect-failure → fail-soft + `runtimeOmissions` + no throw; secrecy: no env value in any log/omission projection.
- **T5 — abort mid-bridge:** abort during a long-running fake tool and during a real Bash sleep → `aborted: true` result, `close()` invoked on every server (spy), bash child gone (pid probe), no unhandled rejections (process hook armed in test).
- **T6 — in-process InMemory round-trip:** a real `createSdkMcpServer` fixture server → listTools/callTool through the bridge; `*ContextRef` visibility (handler echoes `current` set at assembly).
- **T7 — adapter integration:** mocked model transport issues a tool call → gate consulted → executed → provider-shaped result returned → final text; `stats` → `RunResult.toolCalls`/`toolMs`/`toolSummary`; zero-tools pin *removed* for openai (negative-verify: KPR-347's T1 zero-tools assertion now inverted for openai only; gemini/codex pins stay). `llmMs` pin: a turn with nonzero `stats.toolMs` reports `llmMs = durationMs - toolMs`, and the breaker's p95 latency window is unaffected by tool time (§D8 rationale). Cheap streamed variant (`stream: true`) of the tool-call round-trip, since the fleet's Slack path streams.
- **T8 — inventory/classifier:** per-tool builtin entries; six executor tools `{static, requires-hive-bridge}` on all three non-claude columns with `codex ≡ openai` (canon-2 pin retained); the rest `claude-only`; `buildInProcessServers` extraction equivalence (send() path unchanged — existing runner tests + one targeted refactor test).
- **T9 — name/cap edges:** >64-char synthetic name → deterministic mapping + dispatch still routes; >128 tools → tail dropped + logged + recorded.

## Open assumptions

**Blocking (spike-gated, plan step 0):**
- ⚠ `MCPServerStdio` runs hive's stdio servers faithfully (env/lifecycle/concurrency/timeouts) — source-verified this ticket (env merge, spawn args, close path) but Gate 1 marks it docs-verified until the live spike; fallback (raw MCP `Client`) is contained in `tool-bridge.ts`.
- ⚠ Hosted Slack MCP accepts `Authorization` via `requestInit` through `MCPServerStreamableHttp` end-to-end (header pass-through verified in shim source; live handshake unproven).

**Non-blocking (⚠ delegated/documented):**
- ⚠ Schema normalization (`required: []`/`additionalProperties: false` defaults) is accepted by the SDK's non-strict tool path for every fleet server's emitted schemas — spike samples; per-server surprises are fail-soft omissions, not turn failures.
- ⚠ SDK-conversion reuse (`getAllMcpTools` + invoke decoration) vs hand-rolled `tool()` — plan decides post-spike; `BridgedTool` isolates the choice.
- ⚠ Gate hook-input narrowing (tool_name/tool_input only) holds for all current archetypes — pinned by T2; future archetypes extend the adapter deliberately.
- ⚠ Token-usage fill from the Agents SDK result is best-effort; zeros remain acceptable (matrix note).
- ⚠ `load_skill` renders dark until KPR-349 populates `skillIndex` — contract-tested here against a fixture, first exercised live by 349.
- ⚠ Per-turn stdio spawn cost matches Claude-lane per-query spawn cost in practice (no KPR-122-class churn regression) — observed during the spike; if materially worse, pooling is a follow-up, not this ticket.
