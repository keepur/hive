# KPR-347 — Implementation plan: Lane B contract expansion

**Spec:** [kpr-347-spec.md](./kpr-347-spec.md) @ 57b9818 (the contract — this plan adds no design decisions).
**Epic spec:** [kpr-345-spec.md](./kpr-345-spec.md) (§D3 design section).
**Baseline:** branch `mature/kpr-347` @ 57b9818 (== epic branch `kpr-345` @ 15ebac7 + spec commits). All file:line anchors below re-verified at this baseline.
**Advisory finding carried from final spec review (implemented in Task 1.3):** the `normalizeRef` read-side semantics lookup is fail-closed on out-of-union DB provider strings — `SESSION_SEMANTICS[doc.provider] ?? "stateless-replay"` — preserving the old `RESUMABLE_SESSION_PROVIDERS.has()` scrub-on-unknown posture.

## Shape

Two chunks, each independently reviewable and `npm run check`-green at its commit:

- **Chunk 1 — Contract types + session semantics (no seam change).** New types in `types.ts`/`tool-transport.ts`, the `codex` compatibility column, `SESSION_SEMANTICS` supersedes `RESUMABLE_SESSION_PROVIDERS` (both call sites re-keyed, behavior preserved, fail-closed read side), inventory-entry sourcing in `AgentRunner.buildToolTransportInventory`, `TurnAssemblyError` + `classifyThrown` pre-check. `createProviderAdapter` and the adapters are untouched — the empty tuple and the guards still exist at the end of chunk 1.
- **Chunk 2 — Seam wiring.** New `turn-assembly.ts` (assembly fn + relocated `buildPilotInstructions` + default guardrail gate), async `createProviderAdapter` with `WorkItemContext` threading and abort-window closure, adapter options replaced by `assembly`, guards and empty tuple deleted, behavior-neutrality tests.

Behavior-neutrality invariant (spec TL;DR / G6) is pinned by explicit tests in Tasks 1.7, 2.5, 2.6.

---

## Chunk 1 — Contract types + session semantics

### Task 1.1 — `types.ts`: LaneBProviderId, session semantics, guardrail gate; delete RESUMABLE_SESSION_PROVIDERS

- [ ] In `src/agents/provider-adapters/types.ts`, replace the entire `RESUMABLE_SESSION_PROVIDERS` block (lines 6–22, doc comment included) with:

```ts
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

/**
 * KPR-347 (epic §D3): per-provider session continuity semantics. Drives
 * AgentManager persistence (write side) and SessionStore normalization
 * (read side). Supersedes RESUMABLE_SESSION_PROVIDERS (deleted) while
 * preserving the KPR-313 principle it encoded: resumability is a static
 * per-provider fact, not a per-result flag.
 *
 *  - "server-resumable":   provider holds session state; the returned
 *                          sessionId is a real server handle (openai
 *                          previousResponseId chaining today — server
 *                          retention 30d > store TTL 7d).
 *  - "conversation-store": provider-side durable conversation object; the
 *                          persisted ref is a conversation id (KPR-350's
 *                          OpenAI Conversations candidate; unoccupied today).
 *  - "client-transcript":  session id is persisted and resume works via
 *                          client-side transcript replay (Claude CLI today —
 *                          KPR-310-verified stable ids; Lane A passthrough
 *                          providers — child 1).
 *  - "stateless-replay":   NO provider-side resumable handle exists;
 *                          continuity, if any, is hive-persisted history
 *                          replayed client-side. Codex posts store:false and
 *                          sends no previous_response_id; gemini runs
 *                          runEphemeral — their pilot-fabricated ids are not
 *                          handles. Replay implementation status is
 *                          per-provider (codex gains replay in KPR-350;
 *                          gemini leaves this category when Interactions
 *                          lands) — the persistence behavior (never persist
 *                          a handle) is identical either way, which is what
 *                          this descriptor keys.
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

- [ ] In the same file, after the `AgentProviderAdapter` interface, append the guardrail gate types (spec §D1.3 — `WorkItemContext` is already imported at line 2):

```ts
/** KPR-347 (§D1.3): one tool call presented to the guardrail gate. */
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

- [ ] Verify `WorkItemContext` remains a used import (it is — `AgentProviderTurnRequest.workItemContext` and now `GuardrailToolCall`).

### Task 1.2 — `agent-manager.ts`: re-key the write side

- [ ] `src/agents/agent-manager.ts:35` — replace
  `import { RESUMABLE_SESSION_PROVIDERS } from "./provider-adapters/types.js";`
  with
  `import { persistsResumableHandle, sessionSemanticsFor } from "./provider-adapters/types.js";`
- [ ] `finalizeSpawnResult` (~:1403) — replace
  `const resumable = RESUMABLE_SESSION_PROVIDERS.has(route.provider);`
  with
  `const resumable = persistsResumableHandle(sessionSemanticsFor(route.provider));`
  The `sessionStore.set(..., resumable ? result.sessionId : "", ...)` at :1421 is untouched — row-persistence semantics unchanged (stateless providers keep the thread-mapping row with `""`).

### Task 1.3 — `session-store.ts`: re-key the read side, fail-closed (advisory finding)

- [ ] `src/agents/session-store.ts:3` — replace the import with:

```ts
import {
  SESSION_SEMANTICS,
  persistsResumableHandle,
  type AgentProviderId,
  type SessionSemantics,
} from "./provider-adapters/types.js";
```

- [ ] In `normalizeRef` (:102–109), replace the tagged-row branch with:

```ts
    // Tagged row (post-KPR-313 write).
    if (doc.provider) {
      // KPR-347 (review advisory): fail-closed on out-of-union provider
      // strings. doc.provider is typed AgentProviderId, but the DB is not
      // bound by the union — a row written by a newer/older engine may carry
      // a provider this build doesn't know. The old Set's .has() scrubbed
      // unknowns implicitly; the ?? preserves exactly that posture (unknown
      // ⇒ stateless-replay ⇒ no handle).
      const semantics: SessionSemantics | undefined = SESSION_SEMANTICS[doc.provider];
      return {
        sessionId: persistsResumableHandle(semantics ?? "stateless-replay")
          ? doc.sessionId || undefined
          : undefined,
        provider: doc.provider,
      };
    }
```

  The fabricated-id scrub path below (:111+) is untouched.

### Task 1.4 — `tool-transport.ts`: codex column, inventory-entry types, partition

- [ ] Add imports at the top of `src/agents/provider-adapters/tool-transport.ts`:

```ts
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LaneBProviderId } from "./types.js";
```

  (No import cycle: `types.ts` does not import `tool-transport.ts`.)

- [ ] Change `HiveToolTransportDescriptor.compatibility` (lines 30–34) to the Record form (grows `codex` — spec §D2 ruling):

```ts
  compatibility: Record<"claude" | LaneBProviderId, ProviderToolCompatibility>;
```

- [ ] In `classifyToolTransport`, add `codex` to all three compatibility literals, always equal to the `openai` value at this site (one code path emits both; divergence is a deliberate future per-site edit — spec §D2):
  - broken branch (:76–80): `codex: "unsupported",` after `gemini`.
  - claude-builtin/subagent branch (:92–96): `codex: "claude-only",`.
  - default branch (:112–116): `codex: nonClaudeCompatibility,`.
- [ ] Append the per-tool inventory types after `HiveToolTransportDescriptor` (spec §D1.2 — copy the doc comments verbatim from the spec):

```ts
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

- [ ] Append the partition surface (spec §D4) at the end of the file:

```ts
/** Compatibility classes the Lane B bridge can carry (KPR-348 implements per class). */
export const BRIDGEABLE_COMPATIBILITIES: ReadonlySet<ProviderToolCompatibility> = new Set([
  "direct",
  "mcp-bridge-candidate",
  "requires-hive-bridge",
]);

/** R3 honesty record: one tool the partition removed for a provider. */
export interface OmittedToolRecord {
  name: string;
  transport: HiveToolTransportKind;
  /** Why it was omitted: "claude-only" | "unsupported" for this provider. */
  compatibility: ProviderToolCompatibility;
}

/**
 * KPR-347 (§D4): pure compatibility partition — replaces the pilot
 * assertToolFreePilot throws. Order-preserving; provider-column lookup only.
 * Omitted entries carry names + reasons ONLY (never serverConfig) — safe to
 * log and to feed the parity matrix (child 10).
 */
export function partitionInventoryForProvider(
  inventory: readonly HiveToolInventoryEntry[],
  provider: LaneBProviderId,
): { bridgeable: HiveToolInventoryEntry[]; omitted: OmittedToolRecord[] } {
  const bridgeable: HiveToolInventoryEntry[] = [];
  const omitted: OmittedToolRecord[] = [];
  for (const entry of inventory) {
    const compatibility = entry.compatibility[provider];
    if (BRIDGEABLE_COMPATIBILITIES.has(compatibility)) {
      bridgeable.push(entry);
    } else {
      omitted.push({ name: entry.name, transport: entry.transport, compatibility });
    }
  }
  return { bridgeable, omitted };
}
```

### Task 1.5 — `agent-runner.ts`: inventory sourcing (`HiveToolInventoryEntry[]`)

- [ ] In `src/agents/agent-runner.ts`, extend the existing `tool-transport.js` import to include `type HiveToolInventoryEntry` (the import block at lines 23–29 already carries `classifyToolTransport` and the descriptor types — add the new type there).
- [ ] Rewrite `buildToolTransportInventory` (:1209–1277) to return `HiveToolInventoryEntry[]` per the spec §D1.2 sourcing table. Exact new body (only the pushes change; loop structure, sources, and classify inputs are byte-identical to today):

```ts
  buildToolTransportInventory(context?: WorkItemContext): HiveToolInventoryEntry[] {
    const allServerConfigs = this.buildAllServerConfigs(context);
    const mcpServers = this.filterCoreServers(allServerConfigs);
    const autoInjectedServers = AgentRunner.autoInjectedServerNames();
    const pluginServerNames = this.pluginServerNames();
    const inventory: HiveToolInventoryEntry[] = [];

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      const inProcess = !!this.db && IN_PROCESS_PORTED_SERVERS.has(name) && this.shouldEnableInProcessServer(name);
      const source: HiveToolTransportSource = autoInjectedServers.has(name)
        ? "engine"
        : pluginServerNames.has(name)
          ? "plugin"
          : "core";

      const descriptor = classifyToolTransport({
        name,
        transport: inProcess ? "sdk-in-process" : AgentRunner.transportKindForServerConfig(serverConfig),
        source,
        requiresTurnContext: TURN_CONTEXT_DEPENDENT_SERVERS.has(name),
        requiresHiveRuntime: inProcess,
        inProcess,
      });
      // KPR-347 (§D1.2): schemas materialize at bridge time — both discovery
      // mechanics declare connect-time. serverConfig rides ONLY on external
      // MCP entries; an in-process entry's stdio placeholder is wrong by
      // construction (send() overrides it with the factory).
      inventory.push(
        inProcess
          ? { ...descriptor, schemas: { kind: "connect-time" } }
          : { ...descriptor, schemas: { kind: "connect-time" }, serverConfig },
      );
    }

    // KPR-327: "memory" has no stdio placeholder in buildAllServerConfigs
    // anymore (native-contract cutover), so it is absent from the filtered
    // map — surface its in-process descriptor explicitly, mirroring the
    // runtime wiring in send().
    if (!!this.db && this.shouldEnableInProcessServer("memory") && !mcpServers["memory"]) {
      inventory.push({
        ...classifyToolTransport({
          name: "memory",
          transport: "sdk-in-process",
          source: "core",
          requiresTurnContext: TURN_CONTEXT_DEPENDENT_SERVERS.has("memory"),
          requiresHiveRuntime: true,
          inProcess: true,
        }),
        schemas: { kind: "connect-time" },
      });
    }

    if (this.teamRoster) {
      inventory.push({
        ...classifyToolTransport({
          name: "team-roster",
          transport: "sdk-in-process",
          source: "engine",
          requiresTurnContext: false,
          requiresHiveRuntime: true,
          inProcess: true,
        }),
        schemas: { kind: "connect-time" },
      });
    }

    for (const name of this.activeDelegateNames(allServerConfigs)) {
      inventory.push({
        ...classifyToolTransport({
          name,
          transport: "claude-subagent",
          source: "delegate",
        }),
        schemas: { kind: "unavailable" },
      });
    }

    for (const name of CLAUDE_SDK_BUILTIN_TOOL_NAMES) {
      inventory.push({
        ...classifyToolTransport({
          name,
          transport: "claude-builtin",
          source: "sdk-builtin",
        }),
        // KPR-348 flips claude-builtin to { kind: "static" } with the executor.
        schemas: { kind: "unavailable" },
      });
    }

    return inventory;
  }
```

### Task 1.6 — `error-classification.ts`: TurnAssemblyError + classifyThrown pre-check

- [ ] Append to `src/agents/provider-adapters/error-classification.ts` (module stays pure/dependency-free — an Error subclass adds no imports):

```ts
/**
 * KPR-347: typed wrapper for any throw during Lane B turn assembly
 * (inventory build, prompt assembly, gate construction — the pre-runTurn
 * phase). Exists because assembly failure causes are hive-internal (Mongo,
 * config, filesystem) but their MESSAGES can pattern-match provider-fault
 * rows — a Mongo blip's "ECONNREFUSED" would classify connect-fail and
 * count toward a healthy foreign provider's trip streak. The instanceof
 * short-circuit in classifyThrown runs BEFORE the pattern tables.
 */
export class TurnAssemblyError extends Error {
  override readonly name = "TurnAssemblyError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
```

- [ ] Replace `classifyThrown` (:126–128) with:

```ts
export function classifyThrown(err: unknown): TurnClassification {
  if (err instanceof TurnAssemblyError) {
    return { outcome: "fault", kind: "non-provider", message: err.message };
  }
  return classifyErrorString(String(err));
}
```

  `classifyTurnResult` is untouched — assembly precedes `runTurn`, so only the throw path is reachable.

### Task 1.7 — Chunk 1 tests

- [ ] **Compile-fix the three adapter test literals** (compat Record grew `codex`): in `makeDescriptor` in `openai-agents-adapter.test.ts` (:41–57), `gemini-adk-adapter.test.ts`, and `codex-subscription-adapter.test.ts`, add `codex: <same value as openai>` to the `compatibility` literal. No behavioral change — the guards and their tests still pass in chunk 1.
- [ ] **`tool-transport.test.ts`** — extend the import block: the file currently imports only `classifyToolTransport` from `./tool-transport.js`; add `partitionInventoryForProvider`, `type HiveToolInventoryEntry`, `type OmittedToolRecord` to that import, and add a new `import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";` (needed by the serverConfig-secrecy case below). Then update every `compatibility` `toEqual` literal to include `codex` (mechanical, compile-enforced), then add:
  - **T3 codex-column pin** — for every transport class (`stdio`, `http`, `sse`, `sdk-in-process`, `claude-builtin`, `claude-subagent`, and the `broken: true` case), assert `descriptor.compatibility.codex === descriptor.compatibility.openai`. Comment: pinned so future divergence is a deliberate test edit (spec T3).
  - **T2 partition** — new `describe("partitionInventoryForProvider (KPR-347)")` with a helper:

```ts
function makeEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
  return {
    name: "tool",
    transport: "stdio",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: "mcp-bridge-candidate",
      gemini: "mcp-bridge-candidate",
      codex: "mcp-bridge-candidate",
    },
    schemas: { kind: "connect-time" },
    ...overrides,
  };
}
```

    Minimum cases:
    1. Each compatibility class × each `LaneBProviderId`: `direct`/`mcp-bridge-candidate`/`requires-hive-bridge` land in `bridgeable`; `claude-only`/`unsupported` land in `omitted` with `{name, transport, compatibility}` populated (it.each over the 5×3 grid).
    2. Per-provider divergence: a synthetic entry with `compatibility: { claude: "direct", openai: "mcp-bridge-candidate", gemini: "mcp-bridge-candidate", codex: "claude-only" }` partitions bridgeable for `openai`, omitted for `codex` (the codex column is genuinely consulted).
    3. Order preservation: three entries in, `bridgeable`/`omitted` each preserve input order.
    4. Empty input → `{ bridgeable: [], omitted: [] }`.
    5. **serverConfig secrecy (T7 half)**: an entry with `serverConfig: { type: "stdio", command: "x", args: [], env: { SECRET_TOKEN: "hunter2" } } as McpServerConfig` and a claude-only codex column → `expect(JSON.stringify(omitted)).not.toContain("hunter2")` and `expect(Object.keys(omitted[0]!)).toEqual(["name", "transport", "compatibility"])`.
- [ ] **New file `src/agents/provider-adapters/types.test.ts`** — **T4 equivalence pin**:

```ts
import { describe, expect, it } from "vitest";
import {
  SESSION_SEMANTICS,
  persistsResumableHandle,
  sessionSemanticsFor,
  type AgentProviderId,
} from "./types.js";

describe("SESSION_SEMANTICS (KPR-347 §D3)", () => {
  // Equivalence pin: persistsResumableHandle(sessionSemanticsFor(p)) must
  // equal the deleted RESUMABLE_SESSION_PROVIDERS = {claude, openai}
  // membership for all four current ids (spec T4 — behavior preserved).
  it.each([
    ["claude", true],
    ["openai", true],
    ["gemini", false],
    ["codex", false],
  ] as const)("%s → persistsResumableHandle=%s (old Set membership preserved)", (provider, expected) => {
    expect(persistsResumableHandle(sessionSemanticsFor(provider as AgentProviderId))).toBe(expected);
  });

  it("declares exactly the four current provider ids (Record exhaustiveness is compile-time)", () => {
    expect(Object.keys(SESSION_SEMANTICS).sort()).toEqual(["claude", "codex", "gemini", "openai"]);
  });
});
```

- [ ] **`session-store.test.ts`** — existing normalizeRef tests must pass **unchanged** (assertions untouched — that is the re-key evidence). Add one fail-closed test (advisory). The file's harness is a fully mocked db (`makeMockDb()`, `vi.fn()` collection methods) — there is no real collection and no `collection.insertOne`; every existing `get()` test seeds via `mocks.findOne.mockResolvedValueOnce(doc(sessionId, provider))` using the file's own `doc()` helper (lines 26–34). Follow that exact pattern:

```ts
  it("KPR-347 fail-closed: out-of-union provider tag on a row yields NO handle (old .has() scrub posture preserved)", async () => {
    mocks.findOne.mockResolvedValueOnce(doc("some-real-looking-id", "kimi"));
    const ref = await store.get("agent-a", "sms:line-1:t1");
    expect(ref?.sessionId).toBeUndefined();
    expect(ref?.provider).toBe("kimi"); // provenance passes through; handle does not
  });
```

  No `as never` needed — the `doc()` helper's `provider?: string` parameter already accepts out-of-union strings.
- [ ] **`error-classification.test.ts`** — extend the import block: add `TurnAssemblyError` to the existing `import { classifyTurnResult, classifyThrown, HARD_FAULT_KINDS, type ProviderFaultKind } from "./error-classification.js";`. Then add **T5 unit half (the killer test)**:

```ts
describe("TurnAssemblyError (KPR-347 §D6)", () => {
  it("a wrapped Mongo ECONNREFUSED classifies non-provider — the instanceof pre-check beats the pattern tables", () => {
    const msg = "connect ECONNREFUSED 127.0.0.1:27017";
    expect(classifyThrown(new TurnAssemblyError(msg, { cause: new Error(msg) }))).toEqual({
      outcome: "fault", kind: "non-provider", message: msg,
    });
    // Contrast case: the SAME message unwrapped pattern-matches connect-fail —
    // proving the type, not string luck, carries the classification.
    expect(classifyThrown(new Error(msg))).toMatchObject({ outcome: "fault", kind: "connect-fail" });
  });
});
```

- [ ] **`agent-runner.test.ts`** — **T7 sourcing**: extend the existing `describe("AgentRunner.buildToolTransportInventory")` (:1141+) with assertions against the fixture runners it already builds (stdio + in-process + delegate + builtins are all covered by existing fixtures; add an http-server fixture if none exists in that describe):
  - external MCP entry (stdio and http): `entry.schemas` equals `{ kind: "connect-time" }` **and** `entry.serverConfig` is defined and deep-equals the config passed to the runner fixture;
  - sdk-in-process entry (incl. `memory` explicit surface and `team-roster`): `schemas: { kind: "connect-time" }` and `expect("serverConfig" in entry).toBe(false)`;
  - claude-builtin and claude-subagent entries: `schemas: { kind: "unavailable" }`, no `serverConfig`;
  - existing name/compatibility assertions in the describe stay untouched (they now read through the extended entry type — behavior-neutral evidence).
- [ ] **`agent-manager.test.ts`** — zero edits required in chunk 1; the KPR-313 persist-rule tests (:2356–2430) pass as-is against the re-keyed write side. Run them explicitly (command below) — that is T4's "existing KPR-313 tests re-keyed, assertions unchanged".
- [ ] Run chunk-1 verification:

```bash
cd /Users/mokie/github/hive-mature-kpr-347
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
  src/agents/provider-adapters/ src/agents/session-store.test.ts src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

  Expected: all listed suites green (agent-manager suite green **without edits**); `npm run check` exits 0 (typecheck + lint + format + full test).
- [ ] Commit chunk 1:

```bash
git add -A && git commit -m "KPR-347: contract types + session-semantics descriptor (chunk 1)

- LaneBProviderId, SESSION_SEMANTICS (supersedes RESUMABLE_SESSION_PROVIDERS,
  behavior-preserving re-key of finalizeSpawnResult + normalizeRef; read side
  fail-closed on out-of-union DB provider strings per review advisory)
- codex compatibility column (= openai at every classify site, pinned)
- HiveToolInventoryEntry: per-tool schemas declaration + serverConfig on
  external MCP entries; buildToolTransportInventory sources them
- partitionInventoryForProvider + OmittedToolRecord + BRIDGEABLE_COMPATIBILITIES
- TurnAssemblyError + classifyThrown instanceof pre-check
- GuardrailGate types"
```

---

## Chunk 2 — Seam wiring

### Task 2.0 — Negative-verify baseline evidence (T1, before touching adapters)

- [ ] Before any chunk-2 edit, run the three adapter suites and record that the baseline guard tests pass — these are the pre-change probes T1 inverts (`assertToolFreePilot()` is called at the top of `runTurn()`, not in the constructors — constructors are bare field assignments at `openai-agents-adapter.ts:40`, `gemini-adk-adapter.ts:47`, `codex-subscription-adapter.ts:55`):

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
  src/agents/provider-adapters/openai-agents-adapter.test.ts \
  src/agents/provider-adapters/gemini-adk-adapter.test.ts \
  src/agents/provider-adapters/codex-subscription-adapter.test.ts
```

  Expected: green, including the "rejects non-Claude tool inventory before calling the SDK / before constructing ADK objects / before calling Codex" tests (openai :251–259, gemini :280–289, codex :259–272 — Task 2.3's ranges are the deletion authority) which assert `runTurn()` **rejects** on any non-`claude-only` entry while **construction does not throw**. These tests are deleted in Task 2.3 in the same commit that deletes the guards — their passing run here is the recorded revert-source evidence that T1's "construction + runTurn does not throw" flips real baseline behavior (regression-test discipline: same input, baseline throws from runTurn).

### Task 2.1 — New file `src/agents/provider-adapters/turn-assembly.ts`

- [ ] Create the file with this complete content:

```ts
/**
 * KPR-347 (§D1.4): the Lane B per-spawn assembly seam. Everything a native
 * provider adapter needs beyond the per-turn request is built here,
 * asynchronously, and passed at adapter construction. KPR-348 consumes
 * toolInventory + guardrailGate; KPR-349 swaps buildPilotInstructions for
 * the shared prompt builder and populates memory/skillIndex — this file is
 * the single seam both edit.
 */
import { createLogger } from "../../logging/logger.js";
import { getArchetype } from "../../archetypes/registry.js";
import type { AgentConfig } from "../../types/agent-config.js";
import type { AgentRunner, WorkItemContext } from "../agent-runner.js";
import type { GuardrailGate, LaneBProviderId } from "./types.js";
import {
  partitionInventoryForProvider,
  type HiveToolInventoryEntry,
  type OmittedToolRecord,
} from "./tool-transport.js";
import { TurnAssemblyError } from "./error-classification.js";

const log = createLogger("turn-assembly");

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
   * (soul + systemPrompt, byte-identical to pre-347). KPR-349 swaps in the
   * shared prompt builder (minus Claude-specific fragments, plus toolkit
   * rendered from toolInventory).
   */
  instructions: string;
  /** Bridgeable subset for the route provider — already partitioned. */
  toolInventory: HiveToolInventoryEntry[];
  /** R3 honesty record: what the partition removed, for logging/telemetry/matrix. */
  omittedTools: OmittedToolRecord[];
  guardrailGate: GuardrailGate;
  memory: ProviderMemoryBundle; // {} until KPR-349
  skillIndex: ProviderSkillIndexEntry[]; // [] until KPR-349
}

/**
 * Relocated verbatim from agent-manager.ts (KPR-347 §D1.4 step 1) so
 * KPR-349 has a single seam file to edit. Output is byte-identical.
 */
export function buildPilotInstructions(name: string, soul: string, systemPrompt: string): string {
  const sections = [soul.trim(), systemPrompt.trim()].filter(Boolean);
  return sections.length ? sections.join("\n\n") : `You are ${name}.`;
}

/**
 * KPR-347 (§D1.5): default fail-closed guardrail gate — the mirror of the
 * buildHooks posture (agent-runner.ts). Predicate is the identical two-part
 * presence check buildHooks uses (archetypeDef && archetypeConfig):
 *  - both present → deny-all until KPR-348 ports real archetype evaluation
 *    (behaviorally invisible pre-348 — no tools execute — but the posture
 *    ships in code, not prose);
 *  - otherwise → allow-all, exactly the Claude lane (no PreToolUse hooks
 *    unless both parts resolve). Registry sanitization strips unresolvable
 *    archetype ids at load time, so the mixed state is unreachable for any
 *    registry-loaded agent.
 */
export function buildDefaultGuardrailGate(config: AgentConfig): GuardrailGate {
  const archetypeDef = config.archetype ? getArchetype(config.archetype) : undefined;
  if (archetypeDef && config.archetypeConfig) {
    const reason = `Archetype tool policy (${config.archetype}) is not yet enforced on the native provider lane; tool blocked fail-closed (KPR-348).`;
    return async () => ({ behavior: "deny", reason });
  }
  return async () => ({ behavior: "allow" });
}

/**
 * Build the per-spawn assembly for a Lane B provider. Every throw inside —
 * inventory build, partition, gate construction — is wrapped in
 * TurnAssemblyError so classifyThrown short-circuits it to non-provider
 * (§D6): a Mongo ECONNREFUSED during assembly must never pattern-match
 * connect-fail and trip a healthy foreign provider's breaker.
 */
export async function assembleProviderTurn(input: {
  runner: AgentRunner;
  config: AgentConfig;
  provider: LaneBProviderId;
  workItemContext?: WorkItemContext;
}): Promise<ProviderTurnAssembly> {
  try {
    const instructions = buildPilotInstructions(input.config.name, input.config.soul, input.config.systemPrompt);
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
    const guardrailGate = buildDefaultGuardrailGate(input.config);
    return {
      instructions,
      toolInventory: bridgeable,
      omittedTools: omitted,
      guardrailGate,
      memory: {},
      skillIndex: [],
    };
  } catch (err) {
    throw new TurnAssemblyError(
      `Lane B turn assembly failed for agent ${input.config.id} (provider ${input.provider}): ${String(err)}`,
      { cause: err },
    );
  }
}
```

  Import-cycle check: this file imports `agent-runner.js` **type-only**; adapters import this file type-only; `agent-manager.ts` imports the function. No new runtime cycle.

### Task 2.2 — Adapter options: `assembly` replaces `instructions`/`toolInventory`; guards deleted

Apply the same mechanical change to all three adapters. Internal API — grep-verified consumers are `createProviderAdapter` + the adapter tests only.

- [ ] **`openai-agents-adapter.ts`**:
  - Replace the `tool-transport.js` type import (:5) with `import type { ProviderTurnAssembly } from "./turn-assembly.js";`
  - In `OpenAIAgentsAdapterOptions` (:8–17): delete `instructions: string;` and `toolInventory?: HiveToolTransportDescriptor[];`, add `assembly: ProviderTurnAssembly;`.
  - In `runTurn` (:43): delete the `this.assertToolFreePilot();` line.
  - At the `Agent` construction (:54–58): `instructions: request.systemPromptOverride ?? this.options.assembly.instructions,` (precedence preserved verbatim) and add the comment above the constructor call:

```ts
      // KPR-347: assembly.toolInventory is carried but deliberately NOT
      // advertised — an Agent with a tools param but no executor invites
      // tool calls nothing handles. KPR-348 flips this (no `tools` key here
      // until then).
```

  - Delete the `assertToolFreePilot` method (:130–135).
- [ ] **`gemini-adk-adapter.ts`**: same pattern — import swap (:15), options field swap (:18–30), delete `this.assertToolFreePilot();` (:50) and the method (:91–96), `instruction: request.systemPromptOverride ?? this.options.assembly.instructions,` at :131, and the KPR-348 flip-point comment above `tools: [],` at :133.
- [ ] **`codex-subscription-adapter.ts`**: same pattern — import swap (:3), options field swap (:13–23), delete `this.assertToolFreePilot();` (:58) and the method (:169–174) — this deletion also removes the implicit `.openai` read at :170, the epic's hidden coupling — `instructions: request.systemPromptOverride ?? this.options.assembly.instructions,` at :88, and the KPR-348 flip-point comment above `tools: [],` at :93.

### Task 2.3 — Adapter tests: harness swap + T1

For each of the three adapter test files:

- [ ] Add a shared assembly fixture (per file, adapting the existing `makeAdapter` defaults):

```ts
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";

function makeAssembly(overrides: Partial<ProviderTurnAssembly> = {}): ProviderTurnAssembly {
  return {
    instructions: "Be useful.",
    toolInventory: [],
    omittedTools: [],
    guardrailGate: async () => ({ behavior: "allow" }),
    memory: {},
    skillIndex: [],
    ...overrides,
  };
}

function makeInventoryEntry(name = "memory"): HiveToolInventoryEntry {
  return {
    name,
    transport: "sdk-in-process",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: true,
    inProcess: true,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
  };
}
```

- [ ] Update `makeAdapter` to pass `assembly: makeAssembly()` instead of `instructions: "Be useful."`; delete `makeDescriptor` and the old guard tests (baseline evidence already recorded in Task 2.0):
  - **`openai-agents-adapter.test.ts`** — delete `"rejects non-Claude tool inventory before calling the SDK"` (:251–259) AND `"ignores Claude-only inventory for a tool-free run"` (:261–272; describe block closes at :273).
  - **`gemini-adk-adapter.test.ts`** — delete `"rejects non-Claude tool inventory before constructing ADK objects"` (:280–289) AND `"ignores Claude-only inventory for a tool-free run"` (:291–303; describe block closes at :304).
  - **`codex-subscription-adapter.test.ts`** — delete `"rejects non-Claude tool inventory before calling Codex"` (:259–272; describe block closes at :273). Codex has no separate "ignores Claude-only inventory" test — the reject test is the only guard-throw test in this file.
  - Both `"ignores Claude-only inventory for a tool-free run"` tests (openai, gemini) reference the deleted `toolInventory` constructor option and cannot survive Task 2.2's option swap — they must be deleted in the same commit as the guards, not left dangling to fail compilation. Rationale: their claude-only-passes behavior (construction + `runTurn()` succeed when the only inventory entry is claude-only) is superseded by T1's stronger non-empty-**bridgeable**-entry case (this task's T1 bullet below), which proves the same "construction + runTurn does not throw" fact against a real bridgeable inventory, not merely a claude-only one.
- [ ] Every existing assertion that reads the instructions (e.g. openai test asserting `Agent` was constructed with `instructions: "Be useful."`, codex body assertions, gemini `LlmAgent` assertions) keeps passing unchanged — that is part of the neutrality evidence.
- [ ] Add **T1** per adapter (adapt mocks per file's harness):
  - **openai**: `const adapter = makeAdapter({ assembly: makeAssembly({ toolInventory: [makeInventoryEntry()] }) });` → `await adapter.runTurn({ prompt: "hello" })` resolves (mock `run`/`runnerRunMock` as the existing happy-path tests do); then `const agentOptions = AgentMock.mock.calls[0]![0] as Record<string, unknown>; expect("tools" in agentOptions).toBe(false);` — construction + runTurn with a non-empty bridgeable inventory does not throw AND the Agent advertises zero tools.
  - **codex**: same construction; assert on the mocked fetch's request body: `expect(JSON.parse(body).tools).toEqual([]);` (the existing body-assertion helper covers this).
  - **gemini**: same construction; assert the `LlmAgent` mock/constructed options carry `tools: []` (follow the file's existing constructor-inspection pattern).
  - In each, additionally pin instructions byte-equality for a fixture agent: `makeAssembly({ instructions: buildPilotInstructions("Pilot", "soul", "system") })` and assert the provider surface received exactly `"soul\n\nsystem"` (import `buildPilotInstructions` from `./turn-assembly.js`).

### Task 2.4 — New file `src/agents/provider-adapters/turn-assembly.test.ts` (T5 unit, T8, log secrecy)

- [ ] Create with this content (adjust the `AgentConfig` literal to the full required fields — copy the `makeAgentConfig` shape from `agent-manager.test.ts:161–186`):

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentConfig } from "../../types/agent-config.js";
import type { AgentRunner } from "../agent-runner.js";
import { registerArchetype } from "../../archetypes/registry.js";
import { classifyThrown, TurnAssemblyError } from "./error-classification.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import {
  assembleProviderTurn,
  buildDefaultGuardrailGate,
  buildPilotInstructions,
} from "./turn-assembly.js";

const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: mockLogInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "pilot", name: "Pilot", model: "openai/gpt-5.4-mini",
    channels: [], passiveChannels: [], keywords: [], isDefault: false,
    schedule: [], budgetUsd: 10, maxTurns: 25, coreServers: [], delegateServers: [],
    icon: "", soul: "pilot soul", systemPrompt: "pilot system",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
  return {
    name: "memory", transport: "sdk-in-process", source: "core",
    requiresTurnContext: false, requiresHiveRuntime: true, inProcess: true,
    compatibility: {
      claude: "direct", openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge", codex: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
    ...overrides,
  };
}

function makeRunner(inventory: HiveToolInventoryEntry[] | (() => HiveToolInventoryEntry[])): AgentRunner {
  const impl = typeof inventory === "function" ? inventory : () => inventory;
  return { buildToolTransportInventory: vi.fn(impl) } as unknown as AgentRunner;
}

beforeEach(() => vi.clearAllMocks());

describe("assembleProviderTurn (KPR-347 §D1.4)", () => {
  it("instructions are byte-identical to buildPilotInstructions; inventory partitioned; placeholders empty", async () => {
    const bridgeable = makeEntry();
    const omittedEntry = makeEntry({
      name: "Bash", transport: "claude-builtin", inProcess: false, requiresHiveRuntime: false,
      compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
      schemas: { kind: "unavailable" },
    });
    const assembly = await assembleProviderTurn({
      runner: makeRunner([bridgeable, omittedEntry]),
      config: makeAgentConfig(),
      provider: "openai",
    });
    expect(assembly.instructions).toBe(buildPilotInstructions("Pilot", "pilot soul", "pilot system"));
    expect(assembly.instructions).toBe("pilot soul\n\npilot system");
    expect(assembly.toolInventory).toEqual([bridgeable]);
    expect(assembly.omittedTools).toEqual([{ name: "Bash", transport: "claude-builtin", compatibility: "claude-only" }]);
    expect(assembly.memory).toEqual({});
    expect(assembly.skillIndex).toEqual([]);
  });

  it("omission log carries names + reasons only — never serverConfig/env values (§edge: serverConfig secrecy)", async () => {
    const secretEntry = makeEntry({
      name: "quo", transport: "stdio", inProcess: false, requiresHiveRuntime: false,
      compatibility: { claude: "direct", openai: "unsupported", gemini: "unsupported", codex: "unsupported" },
      serverConfig: { type: "stdio", command: "quo", args: [], env: { QUO_API_KEY: "hunter2" } } as never,
    });
    await assembleProviderTurn({ runner: makeRunner([secretEntry]), config: makeAgentConfig(), provider: "openai" });
    expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("hunter2");
    expect(JSON.stringify(mockLogInfo.mock.calls)).toContain("quo:unsupported");
  });

  it("T5: an inventory-build throw rejects with TurnAssemblyError and classifies non-provider", async () => {
    const promise = assembleProviderTurn({
      runner: makeRunner(() => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:27017");
      }),
      config: makeAgentConfig(),
      provider: "gemini",
    });
    await expect(promise).rejects.toBeInstanceOf(TurnAssemblyError);
    const err = await promise.catch((e: unknown) => e);
    expect(classifyThrown(err)).toMatchObject({ outcome: "fault", kind: "non-provider" });
  });
});

describe("buildDefaultGuardrailGate (KPR-347 §D1.5, T8)", () => {
  it("archetype-less agent → allow-all (mirror of the Claude lane's no-hooks state)", async () => {
    const gate = buildDefaultGuardrailGate(makeAgentConfig());
    await expect(gate({ toolName: "anything", input: {} })).resolves.toEqual({ behavior: "allow" });
  });

  it("archetyped agent (def + config both present) → deny-all with the KPR-348 reason", async () => {
    registerArchetype({
      id: "kpr347-stub",
      validateConfig: (c: unknown) => c,
      preToolUseHooks: () => [],
      systemPromptCard: () => "",
    } as never);
    const gate = buildDefaultGuardrailGate(
      makeAgentConfig({ archetype: "kpr347-stub", archetypeConfig: {} }),
    );
    const decision = await gate({ toolName: "Bash", input: { command: "ls" } });
    expect(decision).toEqual({
      behavior: "deny",
      reason: "Archetype tool policy (kpr347-stub) is not yet enforced on the native provider lane; tool blocked fail-closed (KPR-348).",
    });
  });

  it("archetype id that does not resolve → allow-all (unreachable post-registry-sanitization; posture matches buildHooks)", async () => {
    const gate = buildDefaultGuardrailGate(
      makeAgentConfig({ archetype: "no-such-archetype", archetypeConfig: {} }),
    );
    await expect(gate({ toolName: "x", input: null })).resolves.toEqual({ behavior: "allow" });
  });

  it("gate never throws for well-formed input", async () => {
    const gate = buildDefaultGuardrailGate(makeAgentConfig());
    await expect(gate({ toolName: "", input: undefined })).resolves.toBeDefined();
  });
});
```

  (Check `registerArchetype`'s required `ArchetypeDefinition` fields at `src/archetypes/registry.ts:56+` when writing the stub — supply any additional required members; the `as never` escape is acceptable in the test only if the stub misses optional fields, otherwise fill them.)

### Task 2.5 — `agent-manager.ts`: async seam + abort-window closure

- [ ] Delete `buildPilotInstructions` (:231–234) and add to the provider-adapter import block: `import { assembleProviderTurn } from "./provider-adapters/turn-assembly.js";`
- [ ] Update the KPR-313 handoff comment (:241–244, comment-only): replace the parenthetical "(assertToolFreePilot in codex/gemini; openai gets the no-tool variant regardless)" with "(pilot adapters advertise zero tools until KPR-348 wires the bridge — KPR-347 deleted the assertToolFreePilot guards)".
- [ ] Replace `createProviderAdapter` (:489–526) with:

```ts
  private async createProviderAdapter(
    agentId: string,
    route: ProviderModelRoute,
    workItemContext?: WorkItemContext,
  ): Promise<AgentProviderAdapter> {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle);
    if (route.provider === "claude") {
      return new ClaudeAgentAdapter(runner);
    }

    // KPR-347 (§D5): Lane B per-spawn assembly — real inventory through the
    // compatibility partition; instructions byte-identical to the pre-347
    // buildPilotInstructions output. Assembly throws are TurnAssemblyError
    // (classifies non-provider inside the caller's recorded try).
    const assembly = await assembleProviderTurn({
      runner,
      config,
      provider: route.provider,
      workItemContext,
    });

    if (route.provider === "codex") {
      return new CodexSubscriptionAdapter({
        name: config.name,
        model: route.model || appConfig.codex.agentModel,
        reasoningEffort: route.reasoningEffort,
        assembly,
      });
    }

    if (route.provider === "openai") {
      return new OpenAIAgentsAdapter({
        name: config.name,
        model: route.model || appConfig.openai.agentModel || "gpt-5.4-mini",
        assembly,
      });
    }

    return new GeminiAdkAdapter({
      name: config.name,
      model: route.model || appConfig.gemini.agentModel || "gemini-2.5-flash",
      assembly,
    });
  }
```

  Keep the existing doc comment above the method; append one line to it: "KPR-347: async — Lane B construction awaits turn assembly; Claude branch has no awaits and is unchanged in logic." (TS narrows `route.provider` to `LaneBProviderId` after the claude early-return — no cast.)
- [ ] Rewrite the top of `runOneSpawnAttempt` (:1143–1163): move `bgContext` **above** construction, await the adapter, close the abort window:

```ts
  private async runOneSpawnAttempt(
    ctx: TurnContext,
    shaping: SpawnShaping,
    ticket: SpawnTicket,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<RunResult> {
    // KPR-347: built BEFORE adapter construction so Lane B assembly receives
    // the turn's WorkItemContext (context-sensitive server configs).
    const bgContext: WorkItemContext = {
      adapterId: ctx.workItem.source.adapterId ?? ctx.workItem.source.kind,
      channelId: ctx.channelId,
      channelKind: ctx.workItem.source.kind,
      channelLabel: ctx.workItem.source.label,
      threadId: ctx.threadId,
      slackTs: (ctx.workItem.meta?.slackTs as string) ?? "",
      slackThreadTs: (ctx.workItem.meta?.slackThreadTs as string) ?? "",
    };

    // Fresh provider adapter per spawn — its lazy-built in-process MCPs are therefore
    // also fresh, with channel/thread ctx captured at construction. The
    // long-lived path keeps reusing one runner per agent.
    //
    // KPR-347 abort-window closure (§D5): construction is now async; an
    // abort landing while assembly is in flight must not become a lost
    // no-op (abortHandle unset). Flag early, re-attach after construction,
    // re-check. Aborted results stay breaker-neutral (classifyTurnResult).
    let abortedEarly = false;
    ticket.attachAbort(() => {
      abortedEarly = true;
    });
    const adapter = await this.createProviderAdapter(ctx.agentId, shaping.route, bgContext);
    ticket.attachAbort(() => adapter.abort());
    if (abortedEarly) adapter.abort();

    const result = await adapter.runTurn({
      prompt: shaping.prompt,
      sessionId: ctx.sessionId,
      onStream,
      workItemContext: bgContext,
      resourceLimits: shaping.resourceLimits,
      systemPromptOverride: ctx.systemPromptOverride,
      effort: shaping.effortOverride,
    });
    // KPR-224: model router cost lives outside RunResult; add it here so
    // finalizeSpawnResult and recordSpawnObservability see the full cost.
    result.costUsd += shaping.routerCostUsd;
    return result;
  }
```

  Classification placement invariant (R7): `runOneSpawnAttempt` is awaited inside the KPR-306 recorded try (:737–757) — assembly rejections now land on exactly the `classifyThrown → record → rethrow` path at :752–756, and the `prepareSpawn` degenerate-route contract (:1199–1208, "Unknown agent" throws inside the recorded try) holds unchanged. No edit needed at those sites — verify by reading after the change.

### Task 2.6 — `agent-manager.test.ts`: harness + neutrality + T5 seam + T6

- [ ] **Adapter mock factories** (:107–140): add hoisted abort spies so T6 can assert. Extend the `vi.hoisted` block with `mockCodexAbort: vi.fn()` (and, for symmetry, `mockOpenAIAbort`, `mockGeminiAbort`), and use them as the `abort` members of the returned mock objects (replacing the inline `abort: vi.fn()`).
- [ ] **Constructor-shape assertions** — update to the `assembly` form:
  - :2619–2625 (codex full-equality):

```ts
      expect(mockCodexConstructor).toHaveBeenCalledWith({
        name: "Codex Pilot",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        assembly: expect.objectContaining({
          instructions: "pilot soul\n\npilot system",
          toolInventory: [],
          omittedTools: [],
          memory: {},
          skillIndex: [],
        }),
      });
```

  - it.each at :2659–2662: `expect(constructorMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Pilot", assembly: expect.objectContaining({ instructions: "pilot system" }) }));`
  - Confirm :2210/:2798/:2884 need no edit — they pin model/effort only (`expect.objectContaining({ model: "gpt-5.5" })` at :2210, `expect.objectContaining({ model: "gpt-5.5", reasoningEffort: "medium" })` at :2798 and :2884), never `instructions`/`toolInventory`. After editing the two constructor-shape sites above, `grep -n "instructions\|toolInventory" src/agents/agent-manager.test.ts` will legitimately hit the NEW `assembly: expect.objectContaining({ instructions: ... })` forms — the gate is "no stale top-level-options expectation" verified by inspecting each grep hit, not an empty grep result.
  - The byte-identity claim is pinned here: `"pilot soul\n\npilot system"` is the exact pre-347 expectation, now flowing through `assembly.instructions` — same fixture, same bytes (T1's third bullet at the seam).
- [ ] **T1 seam-level (non-empty inventory does not throw)** — new test in the pilot-routing describe:

```ts
    it("KPR-347: pilots construct and run with a REAL non-empty inventory — guards are gone, partition feeds the assembly", async () => {
      registry._agents.set(
        "codex-pilot",
        makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
      );
      mockRunnerToolInventory.mockReturnValueOnce([
        {
          name: "memory", transport: "sdk-in-process", source: "core",
          requiresTurnContext: false, requiresHiveRuntime: true, inProcess: true,
          compatibility: { claude: "direct", openai: "requires-hive-bridge", gemini: "requires-hive-bridge", codex: "requires-hive-bridge" },
          schemas: { kind: "connect-time" },
        },
        {
          name: "Bash", transport: "claude-builtin", source: "sdk-builtin",
          requiresTurnContext: false, requiresHiveRuntime: false, inProcess: false,
          compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
          schemas: { kind: "unavailable" },
        },
      ]);
      const result = await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr347-t1" }));
      expect(result.finalMessage).toBe("codex response");
      const options = mockCodexConstructor.mock.calls.at(-1)![0];
      expect(options.assembly.toolInventory.map((e: { name: string }) => e.name)).toEqual(["memory"]);
      expect(options.assembly.omittedTools).toEqual([
        { name: "Bash", transport: "claude-builtin", compatibility: "claude-only" },
      ]);
    });
```

  (Reuse the file's existing `smsCtx`/`makeCtx` helper names — follow whichever the surrounding describe uses.)
- [ ] **T5 seam-level (assembly throw → non-provider, breaker stays closed)** — new test beside the KPR-306 describe (:2049+):

```ts
    it("KPR-347 T5: assembly throws with a provider-fault-shaped message — classifies non-provider, breaker closed after 3 repeats", async () => {
      registry._agents.set(
        "oai-pilot",
        makeAgentConfig({ id: "oai-pilot", name: "OAI", model: "openai/gpt-5.4-mini", coreServers: [] }),
      );
      mockRunnerToolInventory.mockImplementation(() => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:27017");
      });
      // try/finally: restore the mock even if an assertion below throws, so a
      // failed run doesn't leak the throwing implementation into later tests
      // (belt-and-braces — beforeEach already re-primes mockRunnerToolInventory).
      try {
        for (let i = 0; i < 3; i++) {
          await expect(
            manager.spawnTurn(smsCtx({ agentId: "oai-pilot", threadId: `sms:line-1:kpr347-asm-${i}` })),
          ).rejects.toThrow(/Lane B turn assembly failed/);
        }
        // The killer assertion: three ECONNREFUSED-worded failures did NOT open
        // the openai circuit — TurnAssemblyError short-circuited the pattern
        // tables (§D6). A raw Error with this message would have tripped it.
        const snap = manager.circuitBreakers.stateFor("openai");
        expect(snap?.state).toBe("closed");
        expect(snap?.consecutiveHardFaults).toBe(0);
      } finally {
        mockRunnerToolInventory.mockReturnValue([]);
      }
    });
```

- [ ] **T6 abort-window** — new test in the same area:

```ts
    it("KPR-347 T6: abort landing DURING async assembly is not lost — adapter aborted at construction completion, breaker-neutral", async () => {
      registry._agents.set(
        "codex-pilot",
        makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5", coreServers: [] }),
      );
      mockRunnerToolInventory.mockImplementationOnce(() => {
        // Fires ticket.abort() while assembly is in flight — after the
        // early-flag attach, before the adapter exists. Without the §D5
        // closure this abort is a lost no-op (abortHandle unset).
        manager.stopAgent("codex-pilot");
        return [];
      });
      mockCodexRunTurn.mockResolvedValueOnce(makeRunResult({ text: "", sessionId: "", aborted: true }));
      const result = await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr347-abortwin" }));
      expect(mockCodexAbort).toHaveBeenCalled(); // the re-check fired adapter.abort()
      expect(result.finalMessage).toBe("");
      // Aborted turns are breaker-neutral (classifyTurnResult → aborted).
      expect(manager.circuitBreakers.stateFor("codex")?.consecutiveHardFaults ?? 0).toBe(0);
      manager.restartAgent("codex-pilot"); // don't leak stopped state into later tests
    });
```

  (Confirm `restartAgent` is the un-stop API — the Phase 13 test at :1195 uses it; mirror that test's cleanup. If `spawnTurn` instead rejects with `AgentStoppedError` on this path — stop checkpoints live in `withSpawnTicket`, all pre-`runOneSpawnAttempt`, so it should not — adjust the expectation to the observed contract and keep the two load-bearing assertions: `mockCodexAbort` called, breaker neutral.)
- [ ] **Neutrality sweep**: every pre-existing test in `agent-manager.test.ts` outside the constructor-shape edits above must pass **without assertion changes** — Claude-lane routing, KPR-313 persist/handoff, KPR-306 breaker, KPR-311/338 effort, reflection, stop/restart. This is G6's regression evidence.

### Task 2.7 — Chunk 2 verification + commit

- [ ] Run:

```bash
cd /Users/mokie/github/hive-mature-kpr-347
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

  Expected: typecheck + lint + format + full test suite all green — including the new `turn-assembly.test.ts`, `types.test.ts`, updated adapter suites (old guard tests deleted, T1 present), and the untouched-assertion legacy of `agent-manager.test.ts`. Chunk 2 is check-green at its commit, same bar as chunk 1.
- [ ] Grep gates (each must return nothing):

```bash
grep -rn "assertToolFreePilot" src/
grep -rn "RESUMABLE_SESSION_PROVIDERS" src/
grep -rn "const toolInventory: \[\]" src/
```

- [ ] Commit:

```bash
git add -A && git commit -m "KPR-347: seam wiring — async assembly point, partition replaces pilot guards (chunk 2)

- turn-assembly.ts: assembleProviderTurn (TurnAssemblyError containment),
  relocated buildPilotInstructions (byte-identical), fail-closed default
  guardrail gate (buildHooks-mirror predicate)
- createProviderAdapter async + WorkItemContext threading; empty tuple and
  local buildPilotInstructions deleted; bgContext hoisted above construction
- abort-window closure in runOneSpawnAttempt (early-flag attach + re-check)
- adapter options: assembly replaces instructions/toolInventory; all three
  assertToolFreePilot guards deleted; zero-tools advertisement pinned by test
- tests: T1 neutrality (negative-verified against baseline guard tests),
  T5 seam containment, T6 abort window, T8 gate defaults"
```

---

## Testing Contract

**Harness:** vitest, tests beside source (`src/**/*.test.ts` — repo convention, `reference_test_file_location`). All named suites exist at baseline except the two new files (`types.test.ts`, `turn-assembly.test.ts`). Runner env stubs required by config load: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test`.

**Commands:**

```bash
# full gate (typecheck + lint + format + test) — must exit 0 at each chunk commit
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
# focused during development
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/ src/agents/agent-manager.test.ts src/agents/session-store.test.ts src/agents/agent-runner.test.ts
```

**Unit tests — REQUIRED.** This is a types+seam ticket; the deliverable *is* contract behavior, and every contract clause is unit-pinnable. Scope and minimum assertions (spec T1–T8 made concrete):

| Spec ID | Suite | Minimum assertions |
|---|---|---|
| T1 | 3 adapter suites + `agent-manager.test.ts` | Per adapter: construction + `runTurn()` with non-empty bridgeable inventory resolves; zero tools advertised (openai `Agent` has no `tools` key; codex body `tools: []`; gemini `tools: []`); instructions byte-equal to `buildPilotInstructions` fixture output. Seam: partition results visible on the constructed `assembly`. **Negative-verify:** baseline guard tests (which pin the pre-change `runTurn()` throw for the same input, throw-from-runTurn-not-construction) run green in Task 2.0 before being deleted with the guards — recorded revert-source evidence. |
| T2 | `tool-transport.test.ts` | 5 compatibility classes × 3 Lane B providers; codex-divergent synthetic entry partitions differently per provider; order preservation; empty input; omitted-record key set exactly `{name, transport, compatibility}` + no env value in `JSON.stringify(omitted)`. |
| T3 | `tool-transport.test.ts` | `compatibility.codex === compatibility.openai` for every transport class + broken case (pin: future divergence = deliberate test edit). |
| T4 | `types.test.ts`, `session-store.test.ts`, `agent-manager.test.ts` | Equivalence pin for all 4 ids vs old Set membership; KPR-313 persist-rule + normalizeRef suites pass with **zero assertion edits**; new fail-closed out-of-union-provider test (advisory). Record exhaustiveness is compile-time (no runtime test). |
| T5 | `error-classification.test.ts`, `turn-assembly.test.ts`, `agent-manager.test.ts` | `TurnAssemblyError("connect ECONNREFUSED …")` → `non-provider`; identical message unwrapped → `connect-fail` (contrast case); `assembleProviderTurn` wraps inventory-build throws; seam: 3 assembly failures leave the openai breaker `closed` with `consecutiveHardFaults === 0`. |
| T6 | `agent-manager.test.ts` | Abort fired mid-assembly → adapter `abort()` invoked post-construction, turn aborted, breaker-neutral. |
| T7 | `agent-runner.test.ts` | §D1.2 sourcing table: `serverConfig` present exactly on external MCP entries; `schemas.kind` per class (`connect-time` external + in-process incl. explicit `memory` + `team-roster`; `unavailable` builtin + subagent). |
| T8 | `turn-assembly.test.ts` | Archetype-less → allow; registered archetype + config → deny with the exact KPR-348 reason string; unresolvable archetype id → allow; gate never throws for well-formed input. |

**Integration tests — REQUIRED, in-repo (mocked-adapter seam level).** The `agent-manager.test.ts` harness (mocked `AgentRunner`, mocked pilot adapters, real `AgentManager`/breaker/session-store logic) is the established integration surface for spawn-path behavior; T1-seam/T5-seam/T6 above run the real `spawnTurn → prepareSpawn → recorded try → runOneSpawnAttempt → assembleProviderTurn → finalizeSpawnResult` chain. No new harness needed.

**E2E tests — NOT required.** Rationale: the ticket is behavior-neutral by design (G6) — no live provider call changes shape (pilots still send zero tools and identical instructions), no persistence value changes, no channel behavior changes. Live-provider end-to-end proof is explicitly child 6's scope (production validation) per the epic sequencing; running paid provider calls here would test nothing this ticket changed.

**Critical flows pinned:** Claude-lane spawn (unchanged logic through the now-async constructor — entire existing `agent-manager.test.ts` Claude suite), pilot spawn per provider (routing + constructor shape + result mapping), session persist/normalize for all four providers, breaker record path for thrown assembly errors, abort during construction, KPR-313 provider-transition guard (untouched — its tests are neutrality evidence).

**Regression surface:** `agent-manager.test.ts` (~3k lines — the KPR-306/311/313/220/224/226/338 pins all cross this seam), `session-store.test.ts` (KPR-313 normalization), `claude-agent-adapter.test.ts` (must not change at all), `tool-transport.test.ts`, `agent-runner.test.ts` inventory suite, `error-classification.test.ts` (auth-row superset pins untouched). The rule for chunk-2 review: outside constructor-shape assertions and deleted guard tests, **no existing assertion changes** — any other diff in a test file is a red flag.

---

## Final verification task

- [ ] From a clean tree at the chunk-2 commit:

```bash
cd /Users/mokie/github/hive-mature-kpr-347
git status               # expect: clean
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

  Expected output: typecheck clean, eslint clean, prettier clean, vitest all suites pass, exit code 0.
- [ ] Confirm the three grep gates from Task 2.7 still return nothing.
- [ ] Confirm the plan's two commits exist with the messages above (`git log --oneline -2`).

## Out-of-scope guard (do not do these while implementing)

- No schema extraction from `createSdkMcpServer` outputs (ruled out — §D1.2).
- No tool advertisement/execution, no MCP connection, no builtin executor (KPR-348).
- No prompt-builder extraction, no memory/skill population (KPR-349).
- No `SESSION_SEMANTICS` value changes, no replay implementation (KPR-350).
- No `AgentProviderId` growth, no Lane A grammar (child 1). No voice-path change.
- `AgentProviderAdapter`/`AgentProviderTurnRequest`/`ClaudeAgentAdapter`/`resolveProviderModel` shapes untouched (§D1.6).
