# KPR-347 — Lane B contract expansion: tool inventory, session-semantics descriptor, seam wiring

**Child 2 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D3 (this child's design section), §D1, §D4–D6, §D8.
**Shape:** contract + seam. **Depends on:** none. **Informs:** KPR-348 (tool bridge), KPR-349 (memory+skills), KPR-350 (resume) — this is the contract hub the downstream children spec against.
**Repo baseline:** epic branch `kpr-345` @ 15ebac7 (== main @ 60ad454 + epic spec commit). All file:line references verified at this baseline.
**Decision-register canon:** none exists yet — this is the epic's first matured child. The rulings in this spec (§D2 codex dimension, §D3 static semantics map, §D5 assembly seam, behavior-neutrality invariant) are the candidate seed entries for the epic decision register. Not a blocker.

## TL;DR

Expand the Lane B provider contract so it can *express* full parity — per-tool inventory with JSON-schema entries, assembled instructions, memory bundle, skill index, fail-closed guardrail gate, and a four-value session-semantics descriptor — and wire the seam: the empty tuple at `agent-manager.ts:499` and all three `assertToolFreePilot()` guards are deleted, replaced by a compatibility partition; adapter construction becomes an async assembly point whose throws classify `non-provider`. The change is **behavior-neutral on every production path** — its value is the contract KPR-348/349/350 build against.

## Key Points

- **Contract, not capability.** After this ticket, pilots still advertise zero tools to their providers and produce byte-identical instructions (`buildPilotInstructions`, relocated not rewritten). What changes: the real inventory flows through the seam, guards stop throwing, semantics drive persistence, and every downstream child has a typed surface to land on. Behavior-neutrality is a tested invariant (§Testing T1).
- **`AgentProviderAdapter`/`AgentProviderTurnRequest` interfaces stay unchanged.** Adapters are per-spawn (fresh instance per turn, `agent-manager.ts:1149-1152`), so adapter-lifetime payload ≡ turn payload; parity flows through a new per-spawn `ProviderTurnAssembly` passed at construction. This keeps `ClaudeAgentAdapter`'s passthrough untouched and `runTurn()` minimal.
- **Codex gets its own compatibility dimension** (ruling, §D2): `compatibility` grows from `{claude, openai, gemini}` to `{claude, openai, gemini, codex}`, populated identically to `openai` by the single classifier today. The codex adapter's implicit `.openai` read (`codex-subscription-adapter.ts:170`) is exactly the hidden coupling this epic exists to remove.
- **Session semantics is a static per-provider fact** (ruling, §D3): `SESSION_SEMANTICS: Record<AgentProviderId, SessionSemantics>` with the four epic-canon values; exhaustive `Record` forces every future provider id to declare semantics at compile time. Supersedes and deletes `RESUMABLE_SESSION_PROVIDERS`; both call sites (write-side `finalizeSpawnResult`, read-side `SessionStore.normalizeRef`) re-key with today's behavior preserved exactly.
- **Schemas materialize at bridge time, not assembly time** (ruling, §D1.2): stdio/http/sse *and* sdk-in-process entries declare `{kind: "connect-time"}` — KPR-348's bridge discovers/holds schemas when it connects or instantiates the server. KPR-347 does zero schema extraction; the type carries `{kind: "static", tools}` for KPR-348's authored builtin-executor schemas.
- **The compatibility filter replaces the throw:** `partitionInventoryForProvider()` (pure, in `tool-transport.ts`) splits bridgeable vs omitted; omitted entries are recorded on the assembly (`omittedTools`) and logged once per spawn — R3's "nothing silently dropped" honesty surface, feeding the parity matrix (child 10).
- **Async assembly point with typed error containment:** `createProviderAdapter` becomes async, awaited inside the KPR-306 recorded try; assembly throws are wrapped in `TurnAssemblyError`, which `classifyThrown` short-circuits to `non-provider` — a Mongo `ECONNREFUSED` during memory fold-in must never pattern-match `connect-fail` and trip a healthy foreign provider's breaker (the epic §D5 hazard, contract-tested here).
- **Guardrail gate ships fail-closed:** archetype-less agents get allow-all (matches Claude lane — no PreToolUse hooks without an archetype); archetyped agents get deny-all until KPR-348 ports real archetype evaluation (mirror of the `buildHooks` deny-all fallback, `agent-runner.ts:1459-1473`). Invisible pre-348 (no tools execute), but the posture is in code, not prose.
- ⚠ Delegated assumptions (all non-blocking, §Open assumptions): `McpServerConfig` as the bridge-config carrier (348 may narrow), memory/skill field shapes (349 may refine additively), in-process `*ContextRef` threading (348), gemini/codex both mapped `stateless-replay` pre-350.

## Problem

The epic's verified current state (kpr-345-spec §"Verified current state"): the contract cannot express parity. `AgentProviderTurnRequest` carries prompt/session/stream/limits/effort only; `AgentProviderAdapter` is `{provider, runTurn, abort, wasAborted}` (`src/agents/provider-adapters/types.ts:31-53`). `createProviderAdapter` hardcodes a type-level empty tuple (`const toolInventory: [] = []`, `agent-manager.ts:499`) into all three pilot constructors, while the built-and-tested classifier front-end (`tool-transport.ts`, `AgentRunner.buildToolTransportInventory` at `agent-runner.ts:1209-1277`) has zero production call sites. All three pilots carry `assertToolFreePilot()` guards (`openai-agents-adapter.ts:130-135`, `gemini-adk-adapter.ts:91-96`, `codex-subscription-adapter.ts:169-174`) that throw on any non-`claude-only` entry — dead code today, and the wrong shape (throw) for tomorrow: R3 demands a filter with documented omissions, not a refusal.

Three structural gaps block the downstream children:

1. **No per-tool contract.** `HiveToolTransportDescriptor` (`tool-transport.ts:23-35`) is server-granularity with no schemas and no bridge-config; KPR-348 cannot connect an `MCPServerStdio` or wrap an in-process handler from it.
2. **No session-semantics surface.** Resumability is a boolean set (`RESUMABLE_SESSION_PROVIDERS`, `types.ts:22`) that cannot distinguish server-handle resume, conversation-store resume, client-transcript replay, and hive-owned stateless replay — the distinctions KPR-350 and the parity matrix are built on.
3. **No async construction point.** `createProviderAdapter` is synchronous; prompt assembly (KPR-349) and inventory building are async, and their failure classification (`non-provider`) is unowned.

## Goals

- G1: Types that express full Lane B parity — per-tool inventory (schemas, bridge config, compatibility incl. codex), instructions, memory bundle, skill index, guardrail gate, session semantics.
- G2: Seam wiring — real inventory flows from `AgentRunner.buildToolTransportInventory` through async `createProviderAdapter` into pilot constructors; empty tuple and tool-free guards deleted.
- G3: Compatibility partition with an honesty record (omitted tools) replacing the throw.
- G4: `SESSION_SEMANTICS` descriptor supersedes `RESUMABLE_SESSION_PROVIDERS` with behavior preserved.
- G5: `TurnAssemblyError` containment — assembly throws classify `non-provider`, never trip a foreign breaker.
- G6: Zero production behavior change on the Claude lane and (modulo one new log line and async construction) the pilot lane.

## Non-goals

- Executing any bridged tool, connecting any MCP server, authoring any builtin executor or its schemas — **KPR-348**.
- Extracting `AgentRunner` prompt assembly, populating memory/skill fields, toolkit-section rendering — **KPR-349**.
- Implementing resume for any provider, changing any `SESSION_SEMANTICS` value, transcript-replay storage — **KPR-350** (and Gemini/Codex replication children).
- Lane A anything: passthrough table, `AgentProviderId` growth for `kimi`/`deepseek`, Lane A resumability keying — **child 1**. (This spec leaves the union at four members; §D3 notes the extension point.)
- Subagent parity (`claude-subagent` entries stay `claude-only`) — child 9.
- Voice: pinned to the Claude lane per epic ruling (out of scope §4); no voice-path change here.

## Design

### D1 — Contract types

#### D1.1 Provider id subsets (`types.ts`)

```ts
export type AgentProviderId = "claude" | "openai" | "gemini" | "codex"; // unchanged this ticket

/**
 * KPR-347: the native-lane (Lane B) adapter providers — the set whose
 * adapters run a provider SDK/API directly and need the hive bridge.
 * DELIBERATELY a literal union, NOT Exclude<AgentProviderId, "claude">:
 * Lane A providers (kimi/deepseek — child 1) join AgentProviderId but run
 * the Claude-lane runtime and must NEVER gain a compatibility column or a
 * bridge path. Growing this union is a Lane B replication child's explicit
 * one-line concern.
 */
export type LaneBProviderId = "openai" | "gemini" | "codex";
```

#### D1.2 Per-tool inventory (`tool-transport.ts`)

The existing transport × compatibility classifier is reused as-is; the descriptor grows a codex column (§D2) and a new inventory-entry type layers per-tool schema availability and bridge config on top:

```ts
export interface HiveToolTransportDescriptor {
  name: string;
  transport: HiveToolTransportKind;
  source: HiveToolTransportSource;
  requiresTurnContext: boolean;
  requiresHiveRuntime: boolean;
  inProcess: boolean;
  compatibility: Record<"claude" | LaneBProviderId, ProviderToolCompatibility>; // grows codex (§D2)
}

/** One provider-facing tool with its JSON-schema input contract. */
export interface HiveToolSchemaEntry {
  /** Provider-facing tool name, e.g. "mcp__memory__view" or "Bash". */
  name: string;
  description: string;
  /**
   * JSON Schema for the tool input, as emitted by the MCP SDK's zod
   * conversion (in-process/stdio discovery) or authored (builtin executor,
   * KPR-348). Opaque at the type level — the bridge passes it through to
   * the provider SDK; hive never interprets it.
   */
  inputSchema: Record<string, unknown>;
}

/**
 * Where an entry's per-tool schemas come from. KPR-347 populates the
 * declaration only; KPR-348 materializes:
 *  - "connect-time": schemas are discovered by the bridge when it connects
 *    (stdio/http/sse → MCP tools/list) or instantiates the server
 *    (sdk-in-process → the same factory outputs AgentRunner.send() wires).
 *  - "static": hive holds the schemas now (KPR-348's authored builtin-
 *    executor tools; any future eagerly-manifested server).
 *  - "unavailable": no schema surface exists (claude-builtin until the
 *    executor is authored; claude-subagent until child 9). Entries in this
 *    state are claude-only by classification and never reach a bridge.
 */
export type ToolSchemaAvailability =
  | { kind: "static"; tools: HiveToolSchemaEntry[] }
  | { kind: "connect-time" }
  | { kind: "unavailable" };

export interface HiveToolInventoryEntry extends HiveToolTransportDescriptor {
  schemas: ToolSchemaAvailability;
  /**
   * Present on external MCP transports (stdio | http | sse) only: the exact
   * server config the Claude lane would pass to the SDK, resolved env
   * (incl. secret-env) and all — KPR-348 translates it to MCPServerStdio /
   * MCPServerStreamableHttp params. Credential posture unchanged: this
   * object is bridge-facing, never model-facing, and MUST never be logged
   * (log entry NAMES only). Omitted for sdk-in-process entries — their
   * stdio-placeholder config is wrong by construction (send() overrides it);
   * the bridge instantiates from the factories instead.
   */
  serverConfig?: McpServerConfig;
}
```

Sourcing rules (implemented in `AgentRunner.buildToolTransportInventory`, which changes return type to `HiveToolInventoryEntry[]` — it has `serverConfig` in scope at every classify site, `agent-runner.ts:1216-1231`):

| Entry class | `schemas` | `serverConfig` |
|---|---|---|
| stdio / http / sse MCP server | `connect-time` | attached |
| sdk-in-process (incl. `memory` explicit surface, `team-roster`) | `connect-time` | omitted |
| claude-builtin | `unavailable` (KPR-348 flips to `static` with the executor) | omitted |
| claude-subagent (delegates) | `unavailable` | omitted |

**Ruling — no schema extraction in this ticket.** An earlier framing had KPR-347 extracting in-process tool schemas from `createSdkMcpServer` outputs. Rejected: the bridge (KPR-348) must obtain the factory outputs anyway to wrap handlers as function tools, at which point names/descriptions/zod schemas are in hand — extraction at assembly time would duplicate that work against a possibly-non-public SDK introspection surface, for zero KPR-347 consumer. `connect-time` covers both discovery mechanics symmetrically.

#### D1.3 Guardrail gate (`types.ts`)

```ts
export interface GuardrailToolCall {
  toolName: string;
  input: unknown;
  workItemContext?: WorkItemContext;
}

export type GuardrailDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string };

/**
 * KPR-347 (consumed by KPR-348's dispatch loop): fail-closed pre-execution
 * gate — the Lane B analog of the archetype PreToolUse hooks. The bridge
 * MUST call it before every tool execution and MUST treat a gate throw as
 * deny (contained per the epic §D4 exception-containment invariant: a gate
 * throw becomes a structured error result, classifies non-provider, and
 * never escapes runTurn).
 */
export type GuardrailGate = (call: GuardrailToolCall) => Promise<GuardrailDecision>;
```

#### D1.4 Turn assembly (new file: `src/agents/provider-adapters/turn-assembly.ts`)

```ts
export interface OmittedToolRecord {
  name: string;
  transport: HiveToolTransportKind;
  /** Why it was omitted: "claude-only" | "unsupported" for this provider. */
  compatibility: ProviderToolCompatibility;
}

/**
 * KPR-349 populates both of the following; shapes are deliberately minimal
 * placeholders KPR-349's spec may refine ADDITIVELY (new optional fields
 * only — downstream children pin the existing fields).
 */
export interface ProviderMemoryBundle {
  /** Rendered hot-tier memory block, ready for instruction fold-in. */
  hotTierPrompt?: string;
}

export interface ProviderSkillIndexEntry {
  name: string;
  description: string;
  /** Absolute path to SKILL.md — consumed by the load_skill function tool (KPR-348/349, epic §D5). */
  path: string;
}

/**
 * Everything a Lane B adapter needs beyond the per-turn request. Built
 * asynchronously per spawn by assembleProviderTurn(); passed at adapter
 * construction. INVARIANT this design rests on: adapters are per-spawn
 * (agent-manager.ts runOneSpawnAttempt), so construction-time ≡ turn-time.
 * If adapters ever become long-lived again, this object moves into
 * AgentProviderTurnRequest — that refactor is mechanical because nothing
 * else changes shape.
 */
export interface ProviderTurnAssembly {
  /**
   * Assembled system instructions. KPR-347: buildPilotInstructions output
   * (soul + systemPrompt, byte-identical to today). KPR-349 swaps in the
   * shared prompt builder (minus Claude-specific fragments, plus toolkit
   * rendered from toolInventory).
   */
  instructions: string;
  /** Bridgeable subset for the route provider — already partitioned. */
  toolInventory: HiveToolInventoryEntry[];
  /** R3 honesty record: what the partition removed, for logging/telemetry/matrix. */
  omittedTools: OmittedToolRecord[];
  guardrailGate: GuardrailGate;
  memory: ProviderMemoryBundle;      // {} until KPR-349
  skillIndex: ProviderSkillIndexEntry[]; // [] until KPR-349
}

export async function assembleProviderTurn(input: {
  runner: AgentRunner;
  config: AgentConfig;
  provider: LaneBProviderId;
  workItemContext?: WorkItemContext;
}): Promise<ProviderTurnAssembly>;
```

`assembleProviderTurn` body (this ticket):
1. `instructions = buildPilotInstructions(config.name, config.soul, config.systemPrompt)` — the function moves from `agent-manager.ts:231-234` into this file unchanged, so KPR-349 has a single seam file to edit.
2. `inventory = runner.buildToolTransportInventory(workItemContext)` — the epic's "wire them together" (kills the dead front-end).
3. `{ bridgeable, omitted } = partitionInventoryForProvider(inventory, provider)` (§D4).
4. `guardrailGate = buildDefaultGuardrailGate(config)` (§D1.5).
5. `memory: {}`, `skillIndex: []`.
6. **The entire body is wrapped in try/catch → `throw new TurnAssemblyError(...)`** (§D6).

#### D1.5 Default guardrail gate (this ticket's construction; KPR-348 ports real evaluation)

Mirror of `buildHooks` posture (`agent-runner.ts:1439-1477`):

- No `archetype`/`archetypeConfig` on the agent → `async () => ({ behavior: "allow" })` — exactly the Claude lane, which installs no PreToolUse hooks for archetype-less agents.
- Archetype present → deny-all with reason `"Archetype tool policy (<archetype>) is not yet enforced on the native provider lane; tool blocked fail-closed (KPR-348)."` — the analog of the deny-all fallback at `agent-runner.ts:1459-1473`. Behaviorally invisible until KPR-348 executes tools, but the fail-closed posture ships in code (code-enforce, don't prose-enforce).

#### D1.6 What does NOT change

`AgentProviderAdapter` (methods and `provider` field) and `AgentProviderTurnRequest` keep their exact current shapes (`types.ts:31-53`). `RunResult`, `StreamCallback`, `WorkItemContext` untouched. `ClaudeAgentAdapter` untouched. `ProviderModelRoute`/`resolveProviderModel`/`splitProviderModel` untouched (Lane A grammar is child 1).

### D2 — Ruling: codex gets its own compatibility dimension

**Decision: explicit `codex` column, not an alias of `openai`.**

- The status quo — codex adapter reading `compatibility.openai` (`codex-subscription-adapter.ts:170`) — is a live latent coupling: any future openai-only compatibility upgrade (e.g. hosted-MCP `direct` classification) would silently change codex behavior on a surface (subscription OAuth, hard `store:false`, raw Responses fetch — no Agents SDK) that has not been validated for it.
- The classifier (`classifyToolTransport`, `tool-transport.ts:62-118`) populates `codex` identically to `openai` at all three return sites **today** — one code path emits both, so there is no duplication to drift; divergence, when it comes (KPR-348 may bridge MCP via Agents SDK classes for openai but plain function-calling for codex), is a deliberate per-site edit.
- The parity matrix (child 10) needs per-provider cells regardless; the type-level cost is one field.
- Session/storage differences (resume, `store:false`) live in the session-semantics descriptor (§D3), **not** in tool compatibility — the two dimensions are orthogonal by design.

After the guard deletion, no adapter reads `compatibility` at all (partition happens in assembly); the column's consumers are `partitionInventoryForProvider`, KPR-348's per-transport bridge decisions, and the matrix.

### D3 — Session-semantics descriptor (`types.ts`)

Epic-canon four values (kpr-345-spec §D3), as a **static per-provider fact** — preserving the KPR-313 architectural principle ("resumability is a static per-provider fact, not a per-result flag") rather than moving the declaration onto adapter instances, which would create a second source of truth the read side (no adapter in scope) cannot consult:

```ts
/**
 * KPR-347 (epic §D3): per-provider session continuity semantics. Drives
 * AgentManager persistence (write side) and SessionStore normalization
 * (read side). Supersedes RESUMABLE_SESSION_PROVIDERS (deleted).
 *
 *  - "server-resumable":   provider holds session state; the returned
 *                          sessionId is a real server handle (openai
 *                          previousResponseId chaining today).
 *  - "conversation-store": provider-side durable conversation object; the
 *                          persisted ref is a conversation id (KPR-350's
 *                          OpenAI Conversations candidate; unoccupied today).
 *  - "client-transcript":  session id is persisted and resume works via
 *                          client-side transcript replay (Claude CLI today;
 *                          Lane A passthrough providers — child 1).
 *  - "stateless-replay":   NO provider-side resumable handle exists;
 *                          continuity, if any, is hive-persisted history
 *                          replayed client-side. Replay implementation
 *                          status is per-provider (codex gains replay in
 *                          KPR-350; gemini leaves this category when
 *                          Interactions lands) — the persistence behavior
 *                          (never persist a handle) is identical either
 *                          way, which is what this descriptor keys.
 */
export type SessionSemantics =
  | "server-resumable"
  | "conversation-store"
  | "client-transcript"
  | "stateless-replay";

/**
 * Exhaustive by construction: adding a provider id without declaring its
 * semantics is a compile error (the property the old Set silently lacked —
 * an undeclared provider was implicitly non-resumable). Child 1 adds Lane A
 * ids here as "client-transcript"; KPR-350 and the replication children
 * change values, one line each, in the same PR as the mechanism.
 */
export const SESSION_SEMANTICS: Readonly<Record<AgentProviderId, SessionSemantics>> = {
  claude: "client-transcript",
  openai: "server-resumable",
  gemini: "stateless-replay",
  codex: "stateless-replay",
};

export function sessionSemanticsFor(provider: AgentProviderId): SessionSemantics {
  return SESSION_SEMANTICS[provider];
}

/** True ⇔ the persisted sessionId is a real handle worth storing/resuming. */
export function persistsResumableHandle(semantics: SessionSemantics): boolean {
  return semantics !== "stateless-replay";
}
```

**Re-keyed call sites (behavior-preserving — `persistsResumableHandle(sessionSemanticsFor(p))` ≡ `RESUMABLE_SESSION_PROVIDERS.has(p)` for all four current ids):**

1. Write side — `finalizeSpawnResult`, `agent-manager.ts:1403` (`const resumable = ...`) feeding the `sessionStore.set(..., resumable ? result.sessionId : "", ...)` at `:1421`. Row-persistence semantics unchanged (stateless providers keep the thread-mapping row with `""`).
2. Read side — `SessionStore.normalizeRef`, `session-store.ts:104-109` (belt-and-braces scrub of non-resumable handles on tagged rows) and the import at `session-store.ts:3`.
3. `RESUMABLE_SESSION_PROVIDERS` is **deleted** from `types.ts` (grep-verified: no other consumers at baseline). Its KPR-313 doc comment's per-provider rationale migrates into the `SESSION_SEMANTICS` comment block.

The KPR-313 session-identity guard (`agent-manager.ts:694-713`) is untouched — it keys on provider *identity* transition, not resumability, and stays correct under the descriptor.

### D4 — Compatibility filter replaces `assertToolFreePilot` (`tool-transport.ts`)

```ts
/** Compatibility classes the Lane B bridge can carry (KPR-348 implements per class). */
export const BRIDGEABLE_COMPATIBILITIES: ReadonlySet<ProviderToolCompatibility> = new Set([
  "direct",
  "mcp-bridge-candidate",
  "requires-hive-bridge",
]);

export function partitionInventoryForProvider(
  inventory: readonly HiveToolInventoryEntry[],
  provider: LaneBProviderId,
): { bridgeable: HiveToolInventoryEntry[]; omitted: OmittedToolRecord[] };
```

Pure function, provider column lookup, order-preserving. `assembleProviderTurn` calls it; the assembly logs the omission once per spawn at `info` — names + compatibility reasons only, never configs — e.g. `Lane B inventory partition: 14 bridgeable, 9 omitted (claude-only: Bash, Read / Write / Edit, …)`. This log line is the operator's day-1 answer to "why doesn't my reassigned agent have X" until the parity matrix ships.

**Deletions:** `assertToolFreePilot` bodies and call sites — `openai-agents-adapter.ts:43,130-135`; `gemini-adk-adapter.ts:50,91-96`; `codex-subscription-adapter.ts:58,169-174`. The stale guard reference in the KPR-313 handoff comment (`agent-manager.ts:241-244`) is updated in passing (comment-only).

**Pre-KPR-348 adapter behavior (pinned by test):** adapters receive `assembly.toolInventory` but advertise **zero tools** to their providers — openai constructs `Agent` without a tools param, codex posts `tools: []`, gemini passes `tools: []` — because advertising a tool with no executor invites tool calls nothing handles. A code comment at each site names KPR-348 as the flip point. Constructor options change: `instructions` + `toolInventory` fields are **replaced** by `assembly: ProviderTurnAssembly` in all three `*AdapterOptions` (internal API; tests updated). Adapters read `assembly.instructions` where they read `options.instructions` today (the `request.systemPromptOverride ?? …` precedence is preserved verbatim).

### D5 — Async construction/assembly point (seam wiring in `agent-manager.ts`)

`createProviderAdapter` (`agent-manager.ts:489-526`) becomes:

```ts
private async createProviderAdapter(
  agentId: string,
  route: ProviderModelRoute,
  workItemContext?: WorkItemContext,
): Promise<AgentProviderAdapter>
```

- Claude branch: unchanged logic (`new AgentRunner(...)` → `ClaudeAgentAdapter`) — now merely inside an async function; no awaits on this path, no prefix-cache interaction (the runner still assembles its own prompt in `send()`, KPR-213 cache untouched).
- Lane B branch: `const assembly = await assembleProviderTurn({ runner, config, provider: route.provider, workItemContext })`, then construct the pilot adapter with `{ name, model, …, assembly }`. The `const toolInventory: [] = []` at `:499` and the local `buildPilotInstructions` call at `:498` are deleted (function relocated, §D1.4).
- Note: the `AgentRunner` instance is already constructed unconditionally at `:493` and is what carries `buildToolTransportInventory`; Lane B reuses it as the inventory source. (It remains otherwise unused on pilot paths — same as today; slimming runner construction is not this ticket.)

Call-site reorder in `runOneSpawnAttempt` (`agent-manager.ts:1143-1178`): `bgContext` (currently built at `:1155-1163`, *after* adapter construction) moves **above** the now-awaited `createProviderAdapter` call so assembly receives the turn's `WorkItemContext` (context-sensitive server configs, `buildToolTransportInventory(context)`).

**Classification placement invariant (R7-order preserved):** `runOneSpawnAttempt` is called inside the KPR-306 recorded try (`agent-manager.ts:737-757`); making construction async moves assembly throws onto exactly the `classifyThrown → record → rethrow` path at `:752-756`. The `prepareSpawn` degenerate-route comment contract (`agent-manager.ts:1199-1208` — "Unknown agent" throws inside the recorded try) continues to hold unchanged.

**Abort-window closure:** today `ticket.attachAbort(() => adapter.abort())` fires immediately after sync construction (`:1153`); an async assembly opens a window (Mongo-bound, typically ms) where `ticket.abort()` is a lost no-op (`abortHandle` unset, `agent-manager.ts:819-829`). Close it with an early-flag attach:

```ts
let abortedEarly = false;
ticket.attachAbort(() => { abortedEarly = true; });
const adapter = await this.createProviderAdapter(effectiveCtx.agentId, shaping.route, bgContext);
ticket.attachAbort(() => adapter.abort());
if (abortedEarly) adapter.abort();
```

An abort during assembly then aborts the turn at first opportunity instead of silently completing. (Aborted results are breaker-neutral per `classifyTurnResult` — no classification change.)

### D6 — Error classification (`error-classification.ts`)

```ts
/**
 * KPR-347: typed wrapper for any throw during Lane B turn assembly
 * (inventory build, prompt assembly, gate construction — the pre-runTurn
 * phase). Exists because assembly failure causes are hive-internal (Mongo,
 * config, filesystem) but their MESSAGES can pattern-match provider-fault
 * rows — a Mongo blip's "ECONNREFUSED" would classify connect-fail and
 * count toward a healthy foreign provider's trip streak. The instanceof
 * short-circuit below runs BEFORE the pattern tables.
 */
export class TurnAssemblyError extends Error {
  override readonly name = "TurnAssemblyError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
```

`classifyThrown` (`error-classification.ts:126-128`) gains the pre-check as its first statement:

```ts
export function classifyThrown(err: unknown): TurnClassification {
  if (err instanceof TurnAssemblyError) {
    return { outcome: "fault", kind: "non-provider", message: err.message };
  }
  return classifyErrorString(String(err));
}
```

The module stays pure/dependency-free (an Error subclass adds no imports). `classifyTurnResult` is untouched — assembly precedes `runTurn`, so only the throw path is reachable. This, plus §D5's placement, discharges the ticket requirement "prompt-assembly throws classify `non-provider`" *by type*, not by string luck — and the epic §D5 contract-test obligation for child 2's half of the seam.

## Integration points (what downstream children consume)

| Child | Consumes | Exact seams |
|---|---|---|
| **KPR-348** (tool bridge) | `assembly.toolInventory` (per-entry `transport`, `serverConfig` for MCPServerStdio/StreamableHttp, `schemas` materialization duty), `assembly.guardrailGate` (dispatch-loop call + throw-as-deny), `BRIDGEABLE_COMPATIBILITIES` per-class implementation; flips claude-builtin entries to `static` schemas + upgrades their non-claude compatibility columns in `classifyToolTransport`; replaces the three zero-tools adapter stubs (§D4) with live wiring; owns the exception-containment + `abort()`-mid-bridge contract tests (epic §D4). | `turn-assembly.ts` (types), `tool-transport.ts:84-98` (builtin classify), the three adapter tool-wiring sites |
| **KPR-349** (memory+skills) | Replaces the `buildPilotInstructions` call inside `assembleProviderTurn` with the shared prompt builder; populates `assembly.memory` / `assembly.skillIndex` (additive shape refinement allowed); renders the toolkit section from `assembly.toolInventory`; carries the Claude-lane byte-parity gate and its half of the `TurnAssemblyError` contract tests. | `turn-assembly.ts:assembleProviderTurn` step 1, `ProviderMemoryBundle`, `ProviderSkillIndexEntry` |
| **KPR-350** (resume) | Changes `SESSION_SEMANTICS` values (openai → `conversation-store` if Conversations wins; codex replay implementation under its existing `stateless-replay` label), one line per provider in the same PR as the mechanism; consumes `sessionSemanticsFor` in replay/persistence logic; extends the KPR-313 guard only if new ids appear. | `types.ts:SESSION_SEMANTICS`, `agent-manager.ts:1403`, `session-store.ts:104-109` |
| **Child 1** (Lane A) | Adds `kimi`/`deepseek` to `AgentProviderId` + `SESSION_SEMANTICS` (`client-transcript`) — the compile-time exhaustive Record replaces the "extend the resumability keying" interim named in epic §D2; must NOT touch `LaneBProviderId` (§D1.1 comment enforces intent). | `types.ts` |
| **Child 7/8** (Gemini/Codex replication) | `SESSION_SEMANTICS.gemini` → `server-resumable` with Interactions; codex divergence, if any, lands as deliberate per-site `codex`-column edits in `classifyToolTransport` (§D2). | `types.ts`, `tool-transport.ts` |
| **Child 10** (matrix) | `omittedTools` records + compatibility columns are the matrix's cell inputs. | `turn-assembly.ts` |

## Edge cases

- **Agent removed by SIGUSR1 mid-turn:** `createProviderAdapter`'s `Unknown agent` throw stays inside the recorded try (§D5); classifies `non-provider` via the fail-safe default, exactly as today (`agent-manager.ts:1199-1208` contract preserved).
- **Abort during assembly:** early-flag attach (§D5) — turn aborts at construction completion; breaker-neutral.
- **Empty inventory** (agent with no servers, no delegates): partition returns `{[], […builtins]}`; adapters construct normally; log reads `0 bridgeable`.
- **Reflection turns on a Lane B agent:** route through the same `runOneSpawnAttempt` seam; assembly runs identically (reflection prompt is `shaping.prompt`, unaffected).
- **Voice:** pinned Claude lane by epic ruling; `systemPromptOverride` precedence in adapters preserved verbatim regardless.
- **`serverConfig` secrecy:** carried on bridge-facing entries only; the omission log and any future telemetry emit entry *names* only (tested: log-line assertion contains no env values).
- **Legacy untagged session rows:** `normalizeRef`'s fabricated-id scrub path (`session-store.ts:112+`) is independent of the resumability keying and unchanged.
- **`compatibility` shape change ripples:** the codex column addition touches every literal `HiveToolTransportDescriptor` in tests (`tool-transport.test.ts`, adapter tests) — mechanical, compile-enforced; no runtime consumer reads columns positionally.

## Testing contract sketch

All tests beside source (`src/**/*.test.ts`), vitest, `npm run check` green. New/updated:

- **T1 — behavior-neutrality (the headline invariant):**
  - Pilot construction through the real seam with a non-empty inventory **does not throw** — negative-verified against the pre-change guards (revert-source check per regression-test discipline: same input throws at baseline).
  - Each pilot still advertises zero tools: openai `Agent` constructed without `tools`; codex request body `tools: []`; gemini `tools: []` (existing adapter test harnesses extended).
  - `instructions` byte-equal to `buildPilotInstructions` output for a fixture agent.
- **T2 — partition:** each compatibility class × each `LaneBProviderId`; codex column consulted (a claude-only-for-codex/bridgeable-for-openai synthetic entry partitions differently per provider); order preservation; empty input.
- **T3 — classifier codex column:** for every transport class, `compatibility.codex === compatibility.openai` at baseline (pinned so future divergence is a deliberate test edit).
- **T4 — session semantics:** `persistsResumableHandle(sessionSemanticsFor(p))` equals the old set membership for all four ids (equivalence pin); `finalizeSpawnResult` persists a handle for claude/openai and `""` for gemini/codex (existing KPR-313 tests re-keyed, assertions unchanged); `SessionStore.normalizeRef` scrub behavior unchanged. Record exhaustiveness is compile-time (no test needed).
- **T5 — assembly error containment:** `assembleProviderTurn` with a runner whose inventory build throws `Error("connect ECONNREFUSED 127.0.0.1:27017")` → rejects with `TurnAssemblyError`; `classifyThrown` on it → `non-provider` (the killer test — same message unwrapped classifies `connect-fail`, asserted as the contrast case); seam-level: spawn through `AgentManager` with assembly forced to throw records `non-provider` on the breaker and the circuit stays closed after 3 repeats (existing breaker test harness).
- **T6 — abort window:** `ticket.abort()` fired between construction start and completion → turn result `aborted: true`, breaker-neutral.
- **T7 — inventory sourcing:** `buildToolTransportInventory` fixture agent (stdio + http + in-process + delegate + builtins) yields the §D1.2 table: `serverConfig` present exactly on external MCP entries; `schemas.kind` per class; no env value appears in any loggable projection.
- **T8 — gate defaults:** archetype-less → allow; archetyped → deny with reason; gate never throws for well-formed input.

## Open assumptions

**Blocking:** none — Gate 1 rulings (R2/R3/R4, ruled-out list) cover every design fork encountered; no product question remains open.

**Non-blocking (⚠ delegated forward):**
- ⚠ `McpServerConfig` (SDK type) as the `serverConfig` carrier: KPR-348 may need a narrowed hive-owned projection for MCPServerStdio/StreamableHttp param translation. The field is bridge-facing only, so narrowing later is non-breaking to 349/350.
- ⚠ `ProviderMemoryBundle`/`ProviderSkillIndexEntry` shapes are minimal placeholders; KPR-349's spec may refine **additively** (new optional fields only) without re-opening this contract.
- ⚠ In-process factory instantiation at bridge time must thread the per-turn `*ContextRef` context (KPR-122 pattern) — expressed here via `requiresTurnContext` on entries; the mechanics are KPR-348's, flagged so they are designed, not discovered.
- ⚠ Gemini and codex both map `stateless-replay` pre-KPR-350 although neither implements replay yet — the category keys persistence behavior (never persist a handle), which is identical; documented in the type comment.
- ⚠ Constructor-options replacement (`assembly` supersedes `instructions`/`toolInventory`) assumes no out-of-tree consumer of the three `*AdapterOptions` interfaces — engine-internal at baseline (grep-verified: adapters + their tests + `createProviderAdapter` only).
