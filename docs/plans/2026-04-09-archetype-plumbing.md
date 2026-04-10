# Archetype Plumbing Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Ticket:** #115 (Epic #114)
**Spec:** [`docs/specs/2026-04-09-software-engineer-archetype-design.md`](../specs/2026-04-09-software-engineer-archetype-design.md) — Layer 1
**Goal:** Ship the reusable archetype foundation in hive core so a future archetype (software-engineer, bookkeeper, etc.) can plug in with zero changes to core.

**Architecture:** An archetype is a discipline encoded in code. Layer 1 adds a module-level registry (`src/archetypes/registry.ts`), three optional fields on `AgentConfig`/`AgentDefinition` (`archetype`, `title`, `archetypeConfig`), an archetype-aware step in `agent-registry` (validation on load, fail-closed), an archetype card slot in `buildSystemPrompt` between `soul` and `systemPrompt`, a generalized `buildHooks` that merges archetype `PreToolUse` hooks, archetype-provided `sessionOptions` merged into the `query()` call, and a scope-aware memory MCP server with filesystem-backed scopes. No software-engineer code lands in this ticket.

**Tech Stack:** TypeScript (strict), `@anthropic-ai/claude-agent-sdk`, Vitest, MongoDB, `@modelcontextprotocol/sdk`, Zod.

---

## File map

**New:**
- `src/archetypes/registry.ts` — `ArchetypeDefinition<C>` interface, context types, `registerArchetype`, `getArchetype`, `listArchetypeIds`
- `src/archetypes/registry.test.ts` — register/lookup/duplicate/unknown tests
- `src/archetypes/index.ts` — imports all archetype modules to trigger registration (empty in this ticket; Layer 2 adds the software-engineer import)
- `src/archetypes/slug.ts` — `claudeProjectSlug(absolutePath)` pure function (Spike C output)
- `src/archetypes/slug.test.ts` — edge-case tests for slug transform
- `src/archetypes/spike-settings-sources.test.ts` — Spike A permanent regression (SDK `settingSources: ["project"]` loads CLAUDE.md)
- `src/archetypes/spike-pretooluse-hook.test.ts` — Spike B permanent regression (PreToolUse denial fires under `bypassPermissions`, fail-closed on throw)
- `src/memory/memory-scope.ts` — scope parser + router (self → Mongo, `workshop`/`workspace:<name>` → filesystem)
- `src/memory/memory-scope.test.ts` — scope routing tests
- `src/memory/fs-memory-store.ts` — filesystem-backed memory store with atomic-rename writes and MEMORY.md index maintenance
- `src/memory/fs-memory-store.test.ts` — read/write/list/MEMORY.md index tests

**Modified:**
- `src/types/agent-definition.ts` — add `archetype?`, `title?`, `archetypeConfig?` to `AgentDefinition`; thread through `toAgentConfig`
- `src/types/agent-config.ts` — add same three optional fields to `AgentConfig`
- `src/agents/agent-registry.ts` — call archetype validator on load; mark agent errored on invalid config (fail-closed, do not add to active map)
- `src/agents/agent-registry.test.ts` — add tests covering archetype validation path
- `src/agents/agent-runner.ts`:
  - `buildSystemPrompt` — inject archetype card between `soul` and `systemPrompt` (static prefix, cache-safe)
  - `buildPreCompactHook` → generalize to `buildHooks` — merge archetype `PreToolUse` hooks
  - `send` → `query()` options — spread archetype `sessionOptions` (cwd, settingSources)
  - Resolve archetype once per `send` via `getArchetype(agentConfig.archetype)`; log warn + continue unstructured on unknown ID
- `src/agents/agent-runner.test.ts` — add archetype card placement + hook merge tests
- `src/memory/memory-mcp-server.ts` — accept `scope` tool param; read `MEMORY_SCOPES_JSON` env at startup; route writes via scope router; wrap every tool body in try/catch (tool error on throw, never crash subprocess)

---

## Prerequisite spikes

**These three spikes gate all production code in this ticket.** Each produces a small artifact (fixture or transform fn) that becomes a permanent regression test. Run them first; do not start Task 2 until all three are green.

### Spike A — `settingSources: ["project"]` behavior

**Files:**
- Create: `src/archetypes/spike-settings-sources.test.ts`
- Create: `src/archetypes/fixtures/spike-a/CLAUDE.md` (fixture with known unique sentinel string)
- Create: `src/archetypes/fixtures/spike-a/.claude/settings.json` (empty `{}`)

- [ ] **Step 1:** Create the fixture directory and CLAUDE.md with a sentinel like `SPIKE_A_SENTINEL_7f3c9a — fixture CLAUDE.md loaded successfully`.

- [ ] **Step 2:** Write a vitest test that calls `query()` with `cwd: <fixture abs path>`, `settingSources: ["project"]`, a trivial prompt (`"What does CLAUDE.md say verbatim?"`), `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, no mcpServers, no plugins, `model: "claude-haiku-4-5"`. Collect `SDKResultMessage.result` text. Assert it contains the sentinel.

```typescript
// src/archetypes/spike-settings-sources.test.ts
import { describe, it, expect } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/spike-a");
const SENTINEL = "SPIKE_A_SENTINEL_7f3c9a";

describe("Spike A — settingSources project loads CLAUDE.md", () => {
  it("CLAUDE.md content is visible to the model", async () => {
    const q = query({
      prompt: "Quote the CLAUDE.md file verbatim in your response.",
      options: {
        model: "claude-haiku-4-5",
        cwd: FIXTURE,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 2,
        thinking: { type: "disabled" },
      },
    });

    let result = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") {
        result = msg.result;
      }
    }
    expect(result).toContain(SENTINEL);
  }, 60_000);
});
```

- [ ] **Step 3:** Run and verify.

Run: `npx vitest run src/archetypes/spike-settings-sources.test.ts`
Expected: test passes; manual review of test logs confirms no unexpected filesystem writes or hook/process spawns from Hive-hostile settings.

- [ ] **Step 4:** **If the test fails** (CLAUDE.md not surfaced, or unwanted settings loaded): stop, document findings in `docs/specs/2026-04-09-software-engineer-archetype-design.md` as an addendum, and switch Layer 1 to manually pre-load CLAUDE.md into the archetype system-prompt card. Do not proceed to Spike B until direction is confirmed.

- [ ] **Step 5:** Commit.

```bash
git add src/archetypes/spike-settings-sources.test.ts src/archetypes/fixtures/spike-a/
git commit -m "test: spike A — settingSources project loads CLAUDE.md"
```

---

### Spike B — PreToolUse hook under `bypassPermissions`

**Files:**
- Create: `src/archetypes/spike-pretooluse-hook.test.ts`
- Create: `src/archetypes/fixtures/spike-b/` (scratch dir; test writes + reads here)

- [ ] **Step 1:** Write a vitest test that calls `query()` with:
  - A `PreToolUse` hook that denies any `Edit` whose file path contains `DENIED_`.
  - `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`.
  - A prompt instructing the model to `Edit` a file at `<fixture>/DENIED_target.txt`.
  - Assert the hook fires (observed via side-effect: hook writes to a counter variable).
  - Assert the Edit did not actually happen (check `DENIED_target.txt` contents unchanged).
  - Assert the model's next-turn context sees the denial message.

```typescript
// src/archetypes/spike-pretooluse-hook.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query, type HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/spike-b");
const TARGET = resolve(FIXTURE, "DENIED_target.txt");
const INITIAL = "initial content — must not change";

beforeEach(() => {
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(TARGET, INITIAL, "utf-8");
});

describe("Spike B — PreToolUse hook fires under bypassPermissions", () => {
  it("denies Edit, file unchanged, agent sees error", async () => {
    let fired = 0;
    const denyHook: HookCallbackMatcher = {
      matcher: "Edit",
      hooks: [
        async (input) => {
          fired++;
          const path = (input as any)?.tool_input?.file_path ?? "";
          if (path.includes("DENIED_")) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "spike B denial — test sentinel",
              },
            };
          }
          return { continue: true };
        },
      ],
    };

    const q = query({
      prompt: `Use Edit to replace the content of ${TARGET} with "MUTATED". If Edit is denied, explain why.`,
      options: {
        model: "claude-haiku-4-5",
        cwd: FIXTURE,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 4,
        thinking: { type: "disabled" },
        hooks: { PreToolUse: [denyHook] },
      },
    });

    let lastText = "";
    for await (const msg of q) {
      if (msg.type === "result" && msg.subtype === "success") lastText = msg.result;
    }

    expect(fired).toBeGreaterThan(0);
    expect(readFileSync(TARGET, "utf-8")).toBe(INITIAL);
    expect(lastText.toLowerCase()).toMatch(/denied|blocked|not allowed/);
  }, 90_000);

  it("fails closed on hook exception", async () => {
    const throwHook: HookCallbackMatcher = {
      matcher: "Edit",
      hooks: [async () => { throw new Error("intentional hook throw"); }],
    };

    const q = query({
      prompt: `Use Edit to replace the content of ${TARGET} with "MUTATED".`,
      options: {
        model: "claude-haiku-4-5",
        cwd: FIXTURE,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        thinking: { type: "disabled" },
        hooks: { PreToolUse: [throwHook] },
      },
    });

    for await (const _ of q) { /* drain */ }
    // Expected SDK behavior is fail-closed. If this assertion fails, SDK is fail-open —
    // document in spec addendum and require archetype hook bodies to wrap in try/catch
    // and explicitly return deny. Layer 2 hooks MUST do this regardless of SDK behavior.
    expect(readFileSync(TARGET, "utf-8")).toBe(INITIAL);
  }, 90_000);
});
```

- [ ] **Step 2:** Run and verify.

Run: `npx vitest run src/archetypes/spike-pretooluse-hook.test.ts`
Expected: both tests pass. File is unmodified in both cases.

- [ ] **Step 3:** **If the denial test fails**: the entire enforcement model collapses. Stop — raise to user, discuss switching to `permissionMode: "default"` with allowlist, or middleware wrapping. Do not proceed.

- [ ] **Step 4:** **If the fail-closed test fails**: SDK is fail-open on hook throws. Document in spec addendum; record that Layer 2 software-engineer hook implementation MUST wrap its entire body in try/catch and explicitly return a deny result on any internal exception (this is already mandated by the spec but the test outcome determines whether the SDK provides a second safety net).

- [ ] **Step 5:** Commit.

```bash
git add src/archetypes/spike-pretooluse-hook.test.ts src/archetypes/fixtures/spike-b/.gitkeep
git commit -m "test: spike B — PreToolUse hook denial under bypassPermissions"
```

---

### Spike C — Claude Code slug format

**Files:**
- Create: `src/archetypes/slug.ts`
- Create: `src/archetypes/slug.test.ts`

- [ ] **Step 1:** Empirically derive the rule. From a terminal (user action, not in the plan), run:

```bash
ls ~/.claude/projects/ | head -20
```

Match each listed directory to a known cwd (e.g. `-Users-mokie-github-hive` ↔ `/Users/mokie/github/hive`). Record the transformation in a comment block at the top of `src/archetypes/slug.ts`.

- [ ] **Step 2:** Implement the transform as a pure function.

```typescript
// src/archetypes/slug.ts

/**
 * Transform an absolute filesystem path into the Claude Code harness's
 * project-directory slug, e.g. /Users/mokie/dev/dodi_v2 → -Users-mokie-dev-dodi-v2.
 *
 * Empirically derived from ~/.claude/projects/ listings (see Spike C).
 * Rules:
 *  - Input must be an absolute path (leading "/"). Throws otherwise.
 *  - Trailing slashes are stripped.
 *  - Each "/" becomes "-" (so a leading "/" yields a leading "-").
 *  - Dots in path segments become "-" (e.g. dodi_v2 stays, but a.b becomes a-b).
 *    Confirm during Spike C — update if harness behavior differs.
 *  - Underscores are preserved.
 *
 * This function is the source of truth for workshopSlug/workspaceSlug in Layer 2.
 */
export function claudeProjectSlug(absPath: string): string {
  if (!absPath.startsWith("/")) {
    throw new Error(`claudeProjectSlug: path must be absolute, got ${absPath}`);
  }
  const trimmed = absPath.replace(/\/+$/, "");
  // Adjust the replacement rule to match Spike C findings exactly.
  return trimmed.replace(/[./]/g, "-");
}
```

- [ ] **Step 3:** Write explicit edge-case tests.

```typescript
// src/archetypes/slug.test.ts
import { describe, it, expect } from "vitest";
import { claudeProjectSlug } from "./slug.js";

describe("claudeProjectSlug", () => {
  it("transforms a simple path", () => {
    expect(claudeProjectSlug("/Users/mokie/github/hive")).toBe("-Users-mokie-github-hive");
  });

  it("transforms dotted path segments", () => {
    expect(claudeProjectSlug("/Users/mokie/dev/dodi_v2")).toBe("-Users-mokie-dev-dodi_v2");
  });

  it("strips trailing slashes", () => {
    expect(claudeProjectSlug("/Users/mokie/dev/")).toBe("-Users-mokie-dev");
    expect(claudeProjectSlug("/Users/mokie/dev///")).toBe("-Users-mokie-dev");
  });

  it("rejects relative paths", () => {
    expect(() => claudeProjectSlug("./rel")).toThrow();
    expect(() => claudeProjectSlug("rel")).toThrow();
  });

  it("round-trips against the Hive project itself", () => {
    // This is the load-bearing fact: our own memory lives at this slug today.
    expect(claudeProjectSlug("/Users/mokie/github/hive")).toBe("-Users-mokie-github-hive");
  });
});
```

- [ ] **Step 4:** Verify against real filesystem data.

Run: `ls ~/.claude/projects/ | grep -- -Users-mokie-github-hive`
Expected: exactly one match, confirming the Hive slug matches our function's output.

- [ ] **Step 5:** Run the tests.

Run: `npx vitest run src/archetypes/slug.test.ts`
Expected: all pass.

- [ ] **Step 6:** **If any edge case contradicts the implementation**, iterate on the transform rule before moving on — do not ship a guess.

- [ ] **Step 7:** Commit.

```bash
git add src/archetypes/slug.ts src/archetypes/slug.test.ts
git commit -m "feat(archetypes): claudeProjectSlug path transform (spike C)"
```

---

## Task 1: `AgentConfig` / `AgentDefinition` extension

**Files:**
- Modify: `src/types/agent-definition.ts`
- Modify: `src/types/agent-config.ts`

- [ ] **Step 1:** Add three optional fields to `AgentDefinition`.

In `src/types/agent-definition.ts`, inside the `AgentDefinition` interface, add after the `systemPrompt` field:

```typescript
  // Archetype (optional — unset = unstructured agent, current behavior)
  archetype?: string;                       // discipline id, e.g. "software-engineer"
  title?: string;                           // customer-facing title, e.g. "VP Engineering"
  archetypeConfig?: Record<string, unknown>; // opaque blob, validated by the archetype
```

- [ ] **Step 2:** Thread the three fields through `toAgentConfig` at the bottom of the same file. Add three lines inside the returned object literal, alongside `soul` / `systemPrompt`:

```typescript
    soul: doc.soul ?? "",
    systemPrompt: doc.systemPrompt ?? "",
    archetype: doc.archetype,
    title: doc.title,
    archetypeConfig: doc.archetypeConfig,
    autonomy: resolveAutonomy(instanceAutonomy, doc.autonomy),
```

- [ ] **Step 3:** Add the three fields to `AgentConfig` in `src/types/agent-config.ts`, after `systemPrompt`:

```typescript
  soul: string;
  systemPrompt: string;
  archetype?: string;                       // discipline id
  title?: string;                           // customer-facing title
  archetypeConfig?: Record<string, unknown>; // opaque blob, validated by archetype on load
  autonomy: AutonomyFlags;
```

- [ ] **Step 4:** Typecheck.

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 5:** Commit.

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts
git commit -m "feat(types): optional archetype/title/archetypeConfig on agent types"
```

---

## Task 2: Archetype registry

**Files:**
- Create: `src/archetypes/registry.ts`
- Create: `src/archetypes/registry.test.ts`
- Create: `src/archetypes/index.ts`

- [ ] **Step 1:** Create the registry module.

```typescript
// src/archetypes/registry.ts
import type { HookCallbackMatcher, Options as SdkQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types/agent-config.js";
import type { WorkItemContext } from "../agents/agent-runner.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("archetypes");

/** Memory scope metadata returned by an archetype. */
export interface MemoryScope {
  /** Scope identifier: "self" | "workshop" | `workspace:<name>` | archetype-defined */
  id: string;
  /** Backing store. "mongo" for AGENT_ID-scoped MongoDB (legacy self), "filesystem" for auto-memory. */
  backing: "mongo" | "filesystem";
  /** Absolute filesystem directory for `backing: "filesystem"`. Ignored otherwise. */
  dir?: string;
}

export interface ArchetypePromptContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

export interface ArchetypeHookContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

export interface ArchetypeMemoryContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
}

export interface ArchetypeSessionContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

export interface ArchetypeDefinition<Config = unknown> {
  /** Stable discipline id, e.g. "software-engineer". */
  id: string;

  /** Validate the raw archetypeConfig blob. Throws on invalid. Returns typed config. */
  validateConfig(config: unknown): Config;

  /** Return the system-prompt card (rendered once per session). */
  systemPromptCard(ctx: ArchetypePromptContext<Config>): string;

  /** Return PreToolUse hook matchers. Merged into agent-runner's hook set. */
  preToolUseHooks(ctx: ArchetypeHookContext<Config>): HookCallbackMatcher[];

  /** Declare the memory scopes this archetype exposes to the memory MCP server. */
  memoryScopes(ctx: ArchetypeMemoryContext<Config>): MemoryScope[];

  /** Return partial SDK query options merged into agent-runner's query() call. */
  sessionOptions(ctx: ArchetypeSessionContext<Config>): Partial<SdkQueryOptions>;
}

const registry = new Map<string, ArchetypeDefinition>();

export function registerArchetype<C>(def: ArchetypeDefinition<C>): void {
  if (registry.has(def.id)) {
    // Idempotent re-registration (module reload) is allowed but logged.
    log.warn("Archetype already registered — overwriting", { id: def.id });
  }
  registry.set(def.id, def as ArchetypeDefinition);
  log.info("Registered archetype", { id: def.id });
}

export function getArchetype(id: string): ArchetypeDefinition | undefined {
  return registry.get(id);
}

export function listArchetypeIds(): string[] {
  return Array.from(registry.keys());
}

/** Test-only helper. Do not call from production code. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
```

- [ ] **Step 2:** Create the barrel that triggers archetype registration at startup.

```typescript
// src/archetypes/index.ts
/**
 * Archetype registration barrel.
 *
 * Importing this module triggers side-effect registration of every known archetype
 * via registerArchetype(...). agent-manager imports this once at startup.
 *
 * Layer 1 ships no archetypes — this file is intentionally empty.
 * Layer 2 adds:  import "./software-engineer/index.js";
 */
export {};
```

- [ ] **Step 3:** Create the registry tests.

```typescript
// src/archetypes/registry.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerArchetype,
  getArchetype,
  listArchetypeIds,
  __resetRegistryForTests,
  type ArchetypeDefinition,
} from "./registry.js";

function stub(id: string, overrides: Partial<ArchetypeDefinition> = {}): ArchetypeDefinition {
  return {
    id,
    validateConfig: (c) => c,
    systemPromptCard: () => `card:${id}`,
    preToolUseHooks: () => [],
    memoryScopes: () => [],
    sessionOptions: () => ({}),
    ...overrides,
  };
}

describe("archetype registry", () => {
  beforeEach(() => __resetRegistryForTests());

  it("registers and looks up an archetype by id", () => {
    registerArchetype(stub("software-engineer"));
    expect(getArchetype("software-engineer")?.id).toBe("software-engineer");
  });

  it("returns undefined for unknown ids", () => {
    expect(getArchetype("bookkeeper")).toBeUndefined();
  });

  it("lists registered ids", () => {
    registerArchetype(stub("a"));
    registerArchetype(stub("b"));
    expect(listArchetypeIds().sort()).toEqual(["a", "b"]);
  });

  it("overwrites on duplicate registration (idempotent reload)", () => {
    registerArchetype(stub("x", { systemPromptCard: () => "first" }));
    registerArchetype(stub("x", { systemPromptCard: () => "second" }));
    const card = getArchetype("x")!.systemPromptCard({
      agentConfig: {} as any,
      archetypeConfig: {},
    });
    expect(card).toBe("second");
  });
});
```

- [ ] **Step 4:** Typecheck and run tests.

Run: `npm run typecheck && npx vitest run src/archetypes/registry.test.ts`
Expected: typecheck clean; 4 tests pass.

- [ ] **Step 5:** Commit.

```bash
git add src/archetypes/registry.ts src/archetypes/registry.test.ts src/archetypes/index.ts
git commit -m "feat(archetypes): archetype registry + context types"
```

---

## Task 3: Validate archetype config on agent load

**Files:**
- Modify: `src/agents/agent-registry.ts`
- Modify: `src/agents/agent-registry.test.ts`

- [ ] **Step 1:** In `src/agents/agent-registry.ts`, add an import at the top of the file:

```typescript
import { getArchetype } from "../archetypes/registry.js";
```

Also add a side-effect import so registrations run before any agent is loaded:

```typescript
import "../archetypes/index.js";
```

- [ ] **Step 2:** In `load()`, right after `const agentConfig = toAgentConfig(doc, appConfig.autonomy);` and before the `if (agentConfig.disabled)` check, insert the archetype validation block:

```typescript
      // Archetype validation (fail-closed on invalid archetypeConfig)
      if (agentConfig.archetype) {
        const def = getArchetype(agentConfig.archetype);
        if (!def) {
          // Graceful degradation — unknown archetype runs as unstructured.
          log.warn("Unknown archetype — loading agent as unstructured", {
            id: agentConfig.id,
            archetype: agentConfig.archetype,
          });
          agentConfig.archetype = undefined;
          agentConfig.archetypeConfig = undefined;
        } else {
          try {
            // Replace raw blob with archetype-validated typed config.
            agentConfig.archetypeConfig = def.validateConfig(agentConfig.archetypeConfig) as Record<string, unknown>;
          } catch (err) {
            log.error("Archetype config validation failed — agent will not load", {
              id: agentConfig.id,
              archetype: agentConfig.archetype,
              error: String(err),
            });
            // Fail-closed: skip this agent entirely, do not add to active map.
            continue;
          }
        }
      }
```

- [ ] **Step 3:** Add a test in `src/agents/agent-registry.test.ts` covering the three paths (unknown archetype → unstructured, valid → loaded, invalid → skipped). Use an in-memory Mongo mock matching the existing test pattern — reuse the fixtures already in the file. Register stub archetypes with `registerArchetype` in `beforeEach`.

```typescript
// Add to src/agents/agent-registry.test.ts
import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";

describe("archetype validation on load", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerArchetype({
      id: "test-arch",
      validateConfig: (c: any) => {
        if (!c || typeof c.workshop !== "string") throw new Error("missing workshop");
        return c;
      },
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
  });

  it("loads agent with valid archetypeConfig", async () => {
    // insert doc with archetype: "test-arch", archetypeConfig: { workshop: "/tmp" }
    // assert the agent is in registry.getAll()
  });

  it("fails closed on invalid archetypeConfig", async () => {
    // insert doc with archetype: "test-arch", archetypeConfig: {}
    // assert the agent is NOT in registry.getAll()
  });

  it("degrades gracefully on unknown archetype id", async () => {
    // insert doc with archetype: "missing", archetypeConfig: {}
    // assert agent IS in registry.getAll(), but archetype and archetypeConfig are undefined
  });
});
```

Fill in the insert/assert stubs by copying the setup pattern from existing tests in the same file.

- [ ] **Step 4:** Run tests.

Run: `npx vitest run src/agents/agent-registry.test.ts`
Expected: all pass, including the three new cases.

- [ ] **Step 5:** Commit.

```bash
git add src/agents/agent-registry.ts src/agents/agent-registry.test.ts
git commit -m "feat(agents): validate archetypeConfig on load, fail-closed"
```

---

## Task 4: Archetype card in `buildSystemPrompt`

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1:** Add imports to `src/agents/agent-runner.ts`:

```typescript
import { getArchetype, type ArchetypeDefinition } from "../archetypes/registry.js";
import type { QueryOptions } from "@anthropic-ai/claude-agent-sdk";
```

(Use whatever the exported options type is called in the installed SDK version — verify with `grep "export.*Options" node_modules/@anthropic-ai/claude-agent-sdk/dist/*.d.ts` if unsure.)

- [ ] **Step 2:** Add a private helper to resolve the archetype for this runner once, cached:

```typescript
  private _archetypeDef: ArchetypeDefinition | null | undefined = undefined;
  private getArchetypeDef(): ArchetypeDefinition | null {
    if (this._archetypeDef === undefined) {
      this._archetypeDef = this.agentConfig.archetype
        ? getArchetype(this.agentConfig.archetype) ?? null
        : null;
      if (this.agentConfig.archetype && !this._archetypeDef) {
        log.warn("Archetype referenced by agent not registered — running unstructured", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
        });
      }
    }
    return this._archetypeDef;
  }
```

Place this near the other private helpers (above `buildPreCompactHook`).

- [ ] **Step 3:** Modify `buildSystemPrompt` to inject the archetype card between `soul` and `systemPrompt`. Change lines 86–91 from:

```typescript
    if (this.agentConfig.soul) {
      parts.push(this.agentConfig.soul);
    }

    parts.push(this.agentConfig.systemPrompt);
```

to:

```typescript
    if (this.agentConfig.soul) {
      parts.push(this.agentConfig.soul);
    }

    // Archetype card (static — cacheable prefix). Lives between soul and systemPrompt
    // so the archetype defines the discipline and the agent's own systemPrompt reads
    // as instance-specific flavor layered on top.
    const archetypeDef = this.getArchetypeDef();
    if (archetypeDef && this.agentConfig.archetypeConfig) {
      try {
        const card = archetypeDef.systemPromptCard({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
        });
        if (card) parts.push(card);
      } catch (err) {
        log.error("Archetype systemPromptCard threw — omitting card", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }

    parts.push(this.agentConfig.systemPrompt);
```

- [ ] **Step 4:** Add a unit test verifying placement.

```typescript
// Add to src/agents/agent-runner.test.ts
import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";

describe("buildSystemPrompt — archetype card", () => {
  beforeEach(() => __resetRegistryForTests());

  it("injects card between soul and systemPrompt", async () => {
    registerArchetype({
      id: "stub",
      validateConfig: (c) => c,
      systemPromptCard: () => "ARCH_CARD_MARKER",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({  // use existing test helper, or inline a minimal AgentConfig
      soul: "SOUL_MARKER",
      systemPrompt: "SYSPROMPT_MARKER",
      archetype: "stub",
      archetypeConfig: {},
    });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    const soulIdx = prompt.indexOf("SOUL_MARKER");
    const cardIdx = prompt.indexOf("ARCH_CARD_MARKER");
    const sysIdx = prompt.indexOf("SYSPROMPT_MARKER");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(cardIdx).toBeGreaterThan(soulIdx);
    expect(sysIdx).toBeGreaterThan(cardIdx);
  });

  it("no card when archetype unset", async () => {
    const runner = makeRunner({ soul: "s", systemPrompt: "p" });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    expect(prompt).not.toContain("ARCH_CARD_MARKER");
  });

  it("omits card gracefully when archetype throws", async () => {
    registerArchetype({
      id: "throws",
      validateConfig: (c) => c,
      systemPromptCard: () => { throw new Error("boom"); },
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "s", systemPrompt: "p",
      archetype: "throws", archetypeConfig: {},
    });
    const prompt = await (runner as any).buildSystemPrompt([], []);
    expect(prompt).toContain("s");
    expect(prompt).toContain("p");
  });
});
```

If the existing test file lacks a `makeRunner` helper, add one that stubs `MemoryManager` with empty `read`/`list` and minimal `AgentConfig`. Match the existing test style.

- [ ] **Step 5:** Run.

Run: `npx vitest run src/agents/agent-runner.test.ts`
Expected: all pass.

- [ ] **Step 6:** Commit.

```bash
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "feat(agents): inject archetype card in system prompt static prefix"
```

---

## Task 5: Generalize `buildPreCompactHook` → `buildHooks` and merge archetype PreToolUse hooks

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** Rename `buildPreCompactHook` to a new top-level `buildHooks` that returns the merged hook set. Keep the PreCompact logic intact — extract the current body into a private `buildPreCompactMatcher(): HookCallbackMatcher[]` and have `buildHooks` call it.

```typescript
  private buildHooks(context?: WorkItemContext): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreCompact: this.buildPreCompactMatcher(),
    };

    const archetypeDef = this.getArchetypeDef();
    if (archetypeDef && this.agentConfig.archetypeConfig) {
      try {
        const pre = archetypeDef.preToolUseHooks({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
          workItemContext: context,
        });
        if (pre.length > 0) {
          hooks.PreToolUse = pre;
        }
      } catch (err) {
        log.error("Archetype preToolUseHooks threw — omitting PreToolUse hooks", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }

    return hooks;
  }

  private buildPreCompactMatcher(): HookCallbackMatcher[] {
    // ...existing body from lines 831-870, unchanged, returning the PreCompact matcher array
  }
```

- [ ] **Step 2:** In `send()`, update the `hooks` wiring at line 915 from:

```typescript
        hooks: this.buildPreCompactHook(),
```

to:

```typescript
        hooks: this.buildHooks(context),
```

- [ ] **Step 3:** Typecheck.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4:** Add a unit test verifying hook merge behavior.

```typescript
// Add to src/agents/agent-runner.test.ts
describe("buildHooks — archetype PreToolUse merge", () => {
  beforeEach(() => __resetRegistryForTests());

  it("includes PreCompact by default", () => {
    const runner = makeRunner({ soul: "", systemPrompt: "" });
    const hooks = (runner as any).buildHooks();
    expect(hooks.PreCompact).toBeDefined();
    expect(hooks.PreToolUse).toBeUndefined();
  });

  it("merges archetype PreToolUse hooks", () => {
    registerArchetype({
      id: "hooked",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [{ matcher: "Edit", hooks: [async () => ({ continue: true })] }],
      memoryScopes: () => [],
      sessionOptions: () => ({}),
    });
    const runner = makeRunner({
      soul: "", systemPrompt: "",
      archetype: "hooked", archetypeConfig: {},
    });
    const hooks = (runner as any).buildHooks();
    expect(hooks.PreCompact).toBeDefined();
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].matcher).toBe("Edit");
  });
});
```

- [ ] **Step 5:** Run.

Run: `npx vitest run src/agents/agent-runner.test.ts`
Expected: all pass.

- [ ] **Step 6:** Commit.

```bash
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "feat(agents): generalize buildPreCompactHook to buildHooks with archetype PreToolUse merge"
```

---

## Task 6: Merge archetype `sessionOptions` into `query()`

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** In `send()`, just before the `const q = query({ ... })` call (line 899), compute the archetype session options:

```typescript
    // Archetype session options (cwd, settingSources, etc.)
    let archetypeExtra: Partial<Parameters<typeof query>[0]["options"]> = {};
    const archetypeDefForSession = this.getArchetypeDef();
    if (archetypeDefForSession && this.agentConfig.archetypeConfig) {
      try {
        archetypeExtra = archetypeDefForSession.sessionOptions({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
          workItemContext: context,
        }) as any;
      } catch (err) {
        log.error("Archetype sessionOptions threw — ignoring", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }
```

- [ ] **Step 2:** Add `...archetypeExtra` into the `options` object passed to `query()`. Place it **after** `env:` (so archetype options override `env` defaults only if they intentionally set `env`, which software-engineer does not) but **before** the closing brace. Actually, per the spec, place it early so core options still win — insert it right after `thinking`:

```typescript
      options: {
        model: effectiveModel,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: resourceLimits?.maxTurns ?? this.agentConfig.maxTurns,
        maxBudgetUsd: resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,
        thinking: { type: "disabled" },
        ...archetypeExtra, // cwd, settingSources — archetype owns these keys exclusively
        includePartialMessages: !!onStream,
        ...(sessionId ? { resume: sessionId } : {}),
        // ... rest unchanged
```

Rationale for placement: `permissionMode`, `maxTurns`, `maxBudgetUsd`, `thinking` are core Hive invariants the archetype must not override. `includePartialMessages`, `resume`, `mcpServers`, `agents`, `plugins`, `hooks`, `betas`, `env` are runtime wiring the archetype must not clobber. The archetype's legitimate territory (`cwd`, `settingSources`) does not collide with either band, so spreading in the middle is safe. Document this in a comment.

- [ ] **Step 3:** Typecheck.

Run: `npm run typecheck`
Expected: clean. (If SDK types reject the spread, cast `archetypeExtra` more narrowly — `Pick<..., "cwd" | "settingSources">` — and update the `ArchetypeDefinition.sessionOptions` return type to match.)

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agents): merge archetype sessionOptions into query()"
```

---

## Task 7: Session-start workshop existence check

**Files:**
- Modify: `src/agents/agent-runner.ts`

Per spec Runtime Failure Mode 1, workshop directory must be re-validated at session start (not only at agent load) so a delete-between-reloads fails loudly instead of hanging.

Layer 1 does not know *about* workshops — that's software-engineer vocabulary. The generalized hook: before spreading `archetypeExtra` into `query()`, if `archetypeExtra.cwd` is set, verify the directory exists and is a directory. If not, throw a clear error (dispatcher already catches errors from `send` and logs them).

- [ ] **Step 1:** Just before the `const q = query({ ... })` call, after computing `archetypeExtra`, add:

```typescript
    if (archetypeExtra && typeof (archetypeExtra as any).cwd === "string") {
      const cwd = (archetypeExtra as any).cwd as string;
      const { statSync } = await import("node:fs");
      try {
        const st = statSync(cwd);
        if (!st.isDirectory()) {
          throw new Error(`archetype cwd is not a directory: ${cwd}`);
        }
      } catch (err) {
        const msg = `Archetype cwd unavailable at session start — refusing to run: ${cwd} (${String(err)})`;
        log.error(msg, { agent: this.agentConfig.id });
        throw new Error(msg);
      }
    }
```

(Prefer to use the already-imported `existsSync` and `statSync` — `existsSync` is imported at line 3 of the file. Inline `statSync` import only if not already there.)

- [ ] **Step 2:** Run typecheck and any adjacent tests.

Run: `npm run typecheck && npx vitest run src/agents/agent-runner.test.ts`
Expected: clean.

- [ ] **Step 3:** Commit.

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agents): validate archetype cwd at session start (fail loud)"
```

---

## Task 8: Memory MCP scope dimension — filesystem store

**Files:**
- Create: `src/memory/fs-memory-store.ts`
- Create: `src/memory/fs-memory-store.test.ts`

This is a pure module — no MCP surface here, just the file-backed CRUD primitives the memory MCP server will call. Separating it keeps the MCP surface thin and unit-testable.

- [ ] **Step 1:** Implement atomic-rename write with MEMORY.md index maintenance.

```typescript
// src/memory/fs-memory-store.ts
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Filesystem-backed memory store that mirrors the Claude Code harness auto-memory format.
 *
 * Layout under `dir`:
 *   MEMORY.md        — index file, one-liner pointer per memory file
 *   <topic>.md       — individual memory with YAML frontmatter
 *
 * All writes use atomic rename (temp file in same directory → renameSync) so concurrent
 * readers never see a partial file. MEMORY.md is updated under the same scheme.
 *
 * The store does NOT take a lock — cross-instance writes on the same file follow
 * last-writer-wins semantics per spec Runtime Failure Mode 5.
 */
export class FsMemoryStore {
  constructor(private readonly dir: string) {
    if (!resolve(dir).startsWith("/")) {
      throw new Error(`FsMemoryStore requires absolute path, got ${dir}`);
    }
  }

  /** Ensure dir and MEMORY.md exist. Safe to call repeatedly. */
  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
    const memoryMd = join(this.dir, "MEMORY.md");
    if (!existsSync(memoryMd)) {
      this.atomicWrite(memoryMd, "# Memory\n");
    }
  }

  read(relPath: string): string | null {
    const abs = this.safeJoin(relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf-8");
  }

  /** List .md files in the store (excluding MEMORY.md). */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort();
  }

  /**
   * Write a memory file and update MEMORY.md with a one-liner pointer.
   *
   * `indexLine` is the one-liner description inserted into MEMORY.md, e.g.
   *   "- [Workshop journal](workshop.md) — prototyping notes across repos"
   * If null, the file is written but MEMORY.md is not touched (useful when the
   * caller maintains the index separately).
   */
  write(relPath: string, content: string, indexLine: string | null): void {
    this.ensure();
    const abs = this.safeJoin(relPath);
    this.atomicWrite(abs, content);
    if (indexLine !== null) {
      this.updateIndex(basename(abs), indexLine);
    }
  }

  /** Read-modify-write MEMORY.md under atomic rename. Dedups by filename. */
  private updateIndex(filename: string, indexLine: string): void {
    const memoryMd = join(this.dir, "MEMORY.md");
    const existing = existsSync(memoryMd) ? readFileSync(memoryMd, "utf-8") : "# Memory\n";
    const lines = existing.split("\n");
    // Remove any prior line referencing this file
    const filtered = lines.filter((l) => !l.includes(`(${filename})`));
    filtered.push(indexLine);
    // Ensure trailing newline
    const next = filtered.join("\n").replace(/\n*$/, "\n");
    this.atomicWrite(memoryMd, next);
  }

  private atomicWrite(abs: string, content: string): void {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, abs);
  }

  private safeJoin(relPath: string): string {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      throw new Error(`FsMemoryStore: invalid relative path ${relPath}`);
    }
    return join(this.dir, relPath);
  }
}
```

- [ ] **Step 2:** Write tests.

```typescript
// src/memory/fs-memory-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsMemoryStore } from "./fs-memory-store.js";

describe("FsMemoryStore", () => {
  let dir: string;
  let store: FsMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fsmem-"));
    store = new FsMemoryStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates dir and MEMORY.md on ensure", () => {
    store.ensure();
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("# Memory");
  });

  it("writes a memory file and adds an index line", () => {
    store.write("topic-a.md", "---\nname: topic-a\n---\nbody", "- [A](topic-a.md) — about A");
    expect(readFileSync(join(dir, "topic-a.md"), "utf-8")).toContain("body");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toContain("- [A](topic-a.md) — about A");
  });

  it("dedupes repeat index writes for same filename", () => {
    store.write("t.md", "v1", "- [T](t.md) — old");
    store.write("t.md", "v2", "- [T](t.md) — new");
    const idx = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    expect(idx).toContain("new");
    expect(idx).not.toContain("old");
  });

  it("reads null for missing files", () => {
    expect(store.read("missing.md")).toBeNull();
  });

  it("lists .md files excluding MEMORY.md", () => {
    store.write("a.md", "a", "- a");
    store.write("b.md", "b", "- b");
    expect(store.list()).toEqual(["a.md", "b.md"]);
  });

  it("rejects path traversal", () => {
    expect(() => store.write("../escape.md", "", null)).toThrow();
    expect(() => store.read("../escape.md")).toThrow();
  });

  it("write is atomic (no partial file on concurrent reads)", () => {
    // Smoke test — race the writer against a reader, assert reader never sees "".
    store.write("r.md", "full content", null);
    for (let i = 0; i < 20; i++) {
      store.write("r.md", `v${i} — ${"x".repeat(500)}`, null);
      expect(store.read("r.md")!.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3:** Run.

Run: `npx vitest run src/memory/fs-memory-store.test.ts`
Expected: 7 tests pass.

- [ ] **Step 4:** Commit.

```bash
git add src/memory/fs-memory-store.ts src/memory/fs-memory-store.test.ts
git commit -m "feat(memory): filesystem memory store with atomic-rename writes"
```

---

## Task 9: Memory MCP scope routing module

**Files:**
- Create: `src/memory/memory-scope.ts`
- Create: `src/memory/memory-scope.test.ts`

Pure parser/router so the MCP server stays thin. Takes a scope list from env and dispatches reads/writes.

- [ ] **Step 1:** Implement the router.

```typescript
// src/memory/memory-scope.ts
import { FsMemoryStore } from "./fs-memory-store.js";

export interface ScopeDecl {
  id: string;                      // "self" | "workshop" | "workspace:<name>" | archetype-defined
  backing: "mongo" | "filesystem";
  dir?: string;                    // absolute, required when backing === "filesystem"
}

export type ScopeList = ScopeDecl[];

/**
 * Parse MEMORY_SCOPES_JSON env var into a validated scope list.
 * Returns [] if unset. Throws on malformed JSON or missing `dir` on filesystem scopes.
 */
export function parseScopesEnv(json: string | undefined): ScopeList {
  if (!json) return [];
  const raw = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("MEMORY_SCOPES_JSON must be an array");
  return raw.map((s, i) => {
    if (!s || typeof s.id !== "string") throw new Error(`scope[${i}]: missing id`);
    if (s.backing !== "mongo" && s.backing !== "filesystem") {
      throw new Error(`scope[${i}]: backing must be "mongo" or "filesystem"`);
    }
    if (s.backing === "filesystem") {
      if (typeof s.dir !== "string" || !s.dir.startsWith("/")) {
        throw new Error(`scope[${i}]: filesystem scope requires absolute dir`);
      }
    }
    return { id: s.id, backing: s.backing, dir: s.dir };
  });
}

export class ScopeRouter {
  private readonly stores = new Map<string, FsMemoryStore>();
  constructor(private readonly scopes: ScopeList) {
    for (const s of scopes) {
      if (s.backing === "filesystem" && s.dir) {
        this.stores.set(s.id, new FsMemoryStore(s.dir));
      }
    }
  }

  scopeIds(): string[] {
    return this.scopes.map((s) => s.id);
  }

  get(id: string): ScopeDecl | undefined {
    return this.scopes.find((s) => s.id === id);
  }

  fsStore(id: string): FsMemoryStore | undefined {
    return this.stores.get(id);
  }

  /** Throws a friendly error with the valid scope list if the id is unknown. */
  requireFs(id: string): FsMemoryStore {
    const store = this.stores.get(id);
    if (!store) {
      throw new Error(
        `Unknown filesystem memory scope: ${id}. Valid scopes: ${this.scopeIds().join(", ") || "(none)"}`,
      );
    }
    return store;
  }
}
```

- [ ] **Step 2:** Tests.

```typescript
// src/memory/memory-scope.test.ts
import { describe, it, expect } from "vitest";
import { parseScopesEnv, ScopeRouter } from "./memory-scope.js";

describe("parseScopesEnv", () => {
  it("returns [] when unset", () => {
    expect(parseScopesEnv(undefined)).toEqual([]);
    expect(parseScopesEnv("")).toEqual([]);
  });

  it("parses a valid mixed list", () => {
    const json = JSON.stringify([
      { id: "self", backing: "mongo" },
      { id: "workshop", backing: "filesystem", dir: "/Users/mokie/dev-mem" },
    ]);
    const parsed = parseScopesEnv(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].dir).toBe("/Users/mokie/dev-mem");
  });

  it("rejects filesystem scope without dir", () => {
    const json = JSON.stringify([{ id: "workshop", backing: "filesystem" }]);
    expect(() => parseScopesEnv(json)).toThrow();
  });

  it("rejects filesystem scope with relative dir", () => {
    const json = JSON.stringify([{ id: "workshop", backing: "filesystem", dir: "rel" }]);
    expect(() => parseScopesEnv(json)).toThrow();
  });

  it("rejects unknown backing", () => {
    const json = JSON.stringify([{ id: "x", backing: "redis" }]);
    expect(() => parseScopesEnv(json)).toThrow();
  });
});

describe("ScopeRouter", () => {
  it("lists scope ids and returns fs stores for filesystem scopes", () => {
    const router = new ScopeRouter([
      { id: "self", backing: "mongo" },
      { id: "workshop", backing: "filesystem", dir: "/tmp/non-existent-xyz" },
    ]);
    expect(router.scopeIds()).toEqual(["self", "workshop"]);
    expect(router.fsStore("self")).toBeUndefined();
    expect(router.fsStore("workshop")).toBeDefined();
  });

  it("requireFs throws with valid list on unknown scope", () => {
    const router = new ScopeRouter([{ id: "workshop", backing: "filesystem", dir: "/tmp/x" }]);
    expect(() => router.requireFs("typo")).toThrow(/typo.*workshop/);
  });
});
```

- [ ] **Step 3:** Run.

Run: `npx vitest run src/memory/memory-scope.test.ts`
Expected: 7 tests pass.

- [ ] **Step 4:** Commit.

```bash
git add src/memory/memory-scope.ts src/memory/memory-scope.test.ts
git commit -m "feat(memory): scope router (mongo + filesystem backings)"
```

---

## Task 10: Wire scope into `memory-mcp-server.ts`

**Files:**
- Modify: `src/memory/memory-mcp-server.ts`

- [ ] **Step 1:** At the top of the file, import the new modules and parse the env var. Do NOT crash the subprocess on parse failure — log to stderr and fall back to the legacy (self-only) behavior.

```typescript
import { parseScopesEnv, ScopeRouter } from "./memory-scope.js";

const SCOPES_JSON = process.env.MEMORY_SCOPES_JSON;
let router: ScopeRouter;
try {
  router = new ScopeRouter(parseScopesEnv(SCOPES_JSON));
} catch (err) {
  process.stderr.write(`memory-mcp-server: invalid MEMORY_SCOPES_JSON, falling back to self-only: ${String(err)}\n`);
  router = new ScopeRouter([]);
}
```

- [ ] **Step 2:** Add a `scope` optional parameter to every tool's input schema and route reads/writes/lists. The existing behavior is preserved when `scope` is unset or `"self"`: Mongo-backed `agents/${AGENT_ID}/` paths.

For filesystem scopes, `path` is interpreted as a relative filename under the scope's dir (e.g., `memory_write({scope: "workshop", path: "journal.md", content: "..."})` writes to `<workshop-dir>/journal.md`).

Wrap every tool handler body in try/catch returning `{isError: true, content: [{type:"text", text: ...}]}` instead of throwing (Runtime Failure Mode 2: never crash the subprocess).

Concrete edits per tool:

**`memory_read`:**
```typescript
  async ({ path, scope }) => {
    try {
      if (!scope || scope === "self") {
        if (!isAllowed(path)) {
          return { content: [{ type: "text", text: `Access denied: ${path}` }], isError: true };
        }
        const doc = await collection.findOne({ path });
        if (!doc) return { content: [{ type: "text", text: `File not found: ${path}` }], isError: true };
        return { content: [{ type: "text", text: doc.content }] };
      }
      const decl = router.get(scope);
      if (!decl) {
        return {
          content: [{ type: "text", text: `Unknown scope: ${scope}. Valid: ${router.scopeIds().join(", ") || "self"}` }],
          isError: true,
        };
      }
      if (decl.backing === "mongo") {
        // Future archetype mongo scopes would go here; Layer 1 has none.
        return { content: [{ type: "text", text: `Mongo scope ${scope} has no read mapping` }], isError: true };
      }
      const store = router.requireFs(scope);
      const body = store.read(path);
      if (body === null) return { content: [{ type: "text", text: `File not found: ${scope}:${path}` }], isError: true };
      return { content: [{ type: "text", text: body }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_read error: ${String(err)}` }], isError: true };
    }
  },
```

Update the Zod schema:

```typescript
    inputSchema: {
      path: z.string().describe(`Path. For scope=self: "agents/${AGENT_ID}/foo.md". For filesystem scopes: filename relative to the scope dir.`),
      scope: z.string().optional().describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${["self", ...router.scopeIds().filter(s => s !== "self")].join(", ")}`),
    },
```

**`memory_write`:** Mirror the same structure. For filesystem scope, call `store.write(path, content, "- [" + path.replace(/\.md$/, "") + "](" + path + ") — (updated by agent)")`. (The archetype may later provide a smarter index-line generator; for Layer 1 a plain pointer is enough and the existing harness convention accepts it.)

**`memory_list`:** For filesystem scope, ignore the `path` arg and return `store.list().join("\n")`. For self, existing Mongo behavior.

**`memory_history` / `memory_rollback`:** Only supported for `scope: "self"` in Layer 1. Return a clear error for filesystem scopes: *"history/rollback not supported for filesystem scopes — use git or equivalent"*.

- [ ] **Step 3:** Wrap the existing tool bodies in try/catch (even for self scope) so any Mongo hiccup returns a tool error instead of crashing. Pattern:

```typescript
  async (args) => {
    try {
      // ...existing body...
    } catch (err) {
      return { content: [{ type: "text", text: `memory_xxx error: ${String(err)}` }], isError: true };
    }
  }
```

- [ ] **Step 4:** Build and run existing memory tests (if any cover this server).

Run: `npm run build && npx vitest run src/memory`
Expected: clean. (If existing memory tests break due to schema changes, update them to pass `scope: "self"` explicitly or rely on the default.)

- [ ] **Step 5:** Smoke test the server standalone.

Run:
```bash
AGENT_ID=test-agent \
MONGODB_URI=mongodb://localhost:27017 \
MEMORY_SCOPES_JSON='[{"id":"self","backing":"mongo"}]' \
node dist/memory/memory-mcp-server.js <<< ''
```

Expected: process starts, prints MCP handshake on stdout (JSON-RPC), waits on stdin. Ctrl+C to exit. No stderr warnings.

- [ ] **Step 6:** Commit.

```bash
git add src/memory/memory-mcp-server.ts
git commit -m "feat(memory): scope parameter on memory MCP tools, fail-safe tool errors"
```

---

## Task 11: Wire `MEMORY_SCOPES_JSON` from agent-runner

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** In `buildAllServerConfigs`, where the `memory` server env is built (around line 193), add `MEMORY_SCOPES_JSON` sourced from the archetype's `memoryScopes(ctx)`. Default to `[{id:"self",backing:"mongo"}]` when no archetype is set.

```typescript
    const archetypeDef = this.getArchetypeDef();
    let scopesJson = JSON.stringify([{ id: "self", backing: "mongo" }]);
    if (archetypeDef && this.agentConfig.archetypeConfig) {
      try {
        const scopes = archetypeDef.memoryScopes({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
        });
        // Always include self-mongo as the first scope so legacy behavior is preserved.
        const merged = [{ id: "self", backing: "mongo" as const }, ...scopes.filter(s => s.id !== "self")];
        scopesJson = JSON.stringify(merged);
      } catch (err) {
        log.error("Archetype memoryScopes threw — using self-only", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }

    servers["memory"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/memory/memory-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        MEMORY_SCOPES_JSON: scopesJson,
      },
    };
```

- [ ] **Step 2:** Typecheck and build.

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3:** Commit.

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agents): pass MEMORY_SCOPES_JSON from archetype to memory MCP"
```

---

## Task 12: Full verification + CI gate

- [ ] **Step 1:** Run the full check.

Run: `npm run check`
Expected: typecheck + lint + format + tests all green.

- [ ] **Step 2:** Verify the three spike tests are in the suite (they will run with every `npm run test` going forward).

Run: `npx vitest run src/archetypes/`
Expected: all tests (registry, slug, spike-a, spike-b) pass.

- [ ] **Step 3:** Verify existing agents still load unchanged. Use the dev runtime briefly:

```bash
npm run dev
```

Expected: logs show the existing agents loading as before, no "Unknown archetype" warnings (no agent has archetype set yet).

Stop with Ctrl+C.

- [ ] **Step 4:** Final summary commit if any stragglers (docs, formatting):

```bash
git status
# if clean, skip
```

---

## Acceptance checklist (mirrors issue #115)

- [ ] All three prerequisite spikes complete green and are in the suite as permanent regressions
- [ ] `AgentDefinition` and `AgentConfig` carry `archetype?`, `title?`, `archetypeConfig?`; `toAgentConfig` threads them
- [ ] Unknown archetype IDs load as unstructured (graceful degradation), logged at warn
- [ ] Invalid `archetypeConfig` fails closed — agent is skipped, not loaded
- [ ] `buildSystemPrompt` injects the archetype card between `soul` and `systemPrompt` in the static prefix (cache-safe)
- [ ] `buildHooks` merges archetype `PreToolUse` matchers alongside the existing `PreCompact` hook
- [ ] `query()` receives archetype `sessionOptions` (cwd, settingSources)
- [ ] Workshop cwd is re-validated at session start (fail-loud on missing dir)
- [ ] Memory MCP server accepts `scope` parameter; filesystem-backed scopes use atomic-rename writes with MEMORY.md index maintenance
- [ ] Memory MCP tool bodies are wrapped in try/catch — subprocess never crashes on tool errors
- [ ] `MEMORY_SCOPES_JSON` is wired from agent-runner based on the archetype's `memoryScopes(ctx)`
- [ ] Unit tests cover registry, config validation, scope router, fs store, slug transform, prompt card placement, hook merge
- [ ] `npm run check` passes
- [ ] Existing non-archetype agents unchanged — no behavioral regressions in dev run

---

## Out of scope (per ticket)

- Software-engineer archetype code (Ticket #116)
- Jasper migration (Ticket #117)
- `code_task` changes
- Dispatcher / triage / model-router changes
- Interaction with `buildSdkPlugins` / `buildNativeSkills`

---

**Plan saved to `docs/plans/2026-04-09-archetype-plumbing.md`. Ready to execute?**
