# KPR-329: Tool Search / Deferred Loading Adoption — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Pin the SDK CLI's `ENABLE_TOOL_SEARCH` env var explicitly on every Claude-provider spawn, driven by a new hive.yaml `toolSearch.mode` section (default `auto`) with an optional per-agent `toolSearch` override field — so hive owns the deferred-tool-loading policy instead of riding the CLI's implicit experimental default.

**Architecture:** A liberal-loader `toolSearch` config section in `src/config.ts` feeds a pure `resolveToolSearchEnv()` function in `agent-runner.ts` that maps the resolution chain (agent-definition field → hive.yaml → engine default `auto`) to the CLI env values `"auto" | "true" | "false"`, injected into the existing per-spawn `env` block. The optional agent field is sanitized at registry load (KPR-184 pattern) and validated at admin write time. A toolkit-section addendum capability ships behind a hard-disabled boolean pending live-instance verification of CLI-injected guidance (spec §4.4 / open assumption #3).

**Tech Stack:** TypeScript (strict), Vitest, `@anthropic-ai/claude-agent-sdk` (env-var passthrough only — no SDK option exists), MongoDB agent definitions.

## Testing Contract

### Required Test Groups
- **Unit: required** — Scope: `resolveToolSearchConfig` (config loader), `resolveToolSearchEnv` full resolution matrix, registry `toolSearch` sanitization, admin create/update validation, toolkit-hint conservative default, env-block wiring via mocked `query()`. Reason: this change is entirely config-and-wiring; every piece is a pure function or a mocked-boundary handler. Minimum assertions: (a) all 3 valid agent values × 3 hive modes resolve per the spec §4.1 table; (b) invalid/absent values fall through the chain correctly; (c) invalid hive.yaml mode warns and defaults to `auto`; (d) registry logs error + treats invalid agent field as absent; (e) admin rejects invalid `toolSearch` on create and update with `isError: true`; (f) **negative-verify (spec §6.6):** with resolved mode `off`, `options.env.ENABLE_TOOL_SEARCH` captured from the mocked `query()` call is literally the string `"false"` — not `undefined`, not absent.
- **Integration: not-required** — the only integration surface is the spawned CLI process honoring the env var, which is a live-instance concern (spec §6.1–6.5, post-merge operational verification, explicitly out of scope for this plan).
- **E2E: not-required** — same reason; no channel/dispatcher/data-model behavior changes.

### Critical Flows
1. Spawn env resolution: agent field absent + hive.yaml absent → `ENABLE_TOOL_SEARCH: "auto"` in the `query()` env (new default posture — the value is now *always* set, never inherited from ambient `process.env`).
2. Rollback flow: `toolSearch.mode: off` → env value `"false"` (CLI `standard` mode — today's intended eager behavior).
3. Per-agent escape hatch: agent `toolSearch: "off"` overrides hive.yaml `on`/`auto`.
4. Bad data never propagates: invalid agent-def value is stripped at load (inherit global) and rejected at admin write.

### Regression Surface
- The `env` block passed to `query()` (agent-runner.ts ~1771) — existing keys (`ANTHROPIC_API_KEY` conditional, `CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDECODE: undefined`) must be untouched; existing agent-runner tests cover this indirectly via `getCapturedOptions()`.
- `toAgentConfig` projection — new optional field must not disturb existing field mapping (existing `toAgentConfig` tests in agent-registry.test.ts).
- Registry `load()` — new sanitization runs beside the KPR-184 `sanitizeDelegateServers` call; must not alter disabled-agent/eviction ordering (existing registry load tests).
- Toolkit section output — must be byte-identical for all existing inputs while the hint flag is `false` (existing toolkit-section.test.ts + agent-runner toolkit prompt tests).
- Prefix cache (KPR-213): no new invalidation plumbing — the `toolSearch` agent-def field change already invalidates via the definition-update path; hive.yaml changes require restart (cache is in-memory). No test needed beyond the toolkit-output-unchanged assertions.

### Commands
```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-registry.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/admin/admin-mcp-server.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/toolkit-section.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check   # final gate
```

### Harness Requirements
No *new* harness, but one piece of **required existing-harness maintenance**: agent-runner.test.ts mocks `../config.js` wholesale (`vi.mock` factory, lines 89–130) and currently exports only `config` with no `toolSearch` key and no `isToolSearchMode`. Task 3 Step 1 updates that factory (adds `toolSearch: { mode: "auto", source: "default" }` to the mocked `config` and exports a real `isToolSearchMode` stub) — without it, the new imports in agent-runner.ts break every test in the file at import time. Everything else reuses existing patterns: agent-runner.test.ts already mocks `@anthropic-ai/claude-agent-sdk` and exposes `getCapturedOptions()` / `makeAgentConfig()`; admin-mcp-server.test.ts drives `buildAdminTools(deps)` handlers directly against a fake Mongo Db; config.test.ts imports resolvers as pure functions.

### Non-Required Rationale
Integration/E2E: the runtime effect of `ENABLE_TOOL_SEARCH` lives inside the bundled CLI binary of the SDK. Spec §6.1–6.5 (baseline capture, mode matrix on a live instance, functional deferred-tool discovery, cache sanity, in-process eligibility) are **post-merge operational verification tasks against a deployed dev instance** — they are deliberately excluded from this implementation plan (leaf workers have no live-instance access). §6.6 (negative-verify of the literal env value) IS included as a unit test. Reviewers: do not flag §6.1–6.5 as missing tasks.

### Verification Rules
- Every task ends with its vitest command green before commit.
- No claim of "matrix covered" without the test file enumerating all 9 valid agent×hive combinations plus invalid/absent variants.
- `npm run check` (typecheck + lint + format + test) must pass before the final commit.
- Negative-verify test must assert `toBe("false")` (strict string equality), per feedback_negative_verify_regression_tests.

---

## Out of scope (do not touch)

Per spec §5: **no changes** to `buildServerSubAgents`, `filterCoreServers`, `src/agents/in-process-servers.ts`, `prefix-builder.ts` core hot-tier/memory logic (only the toolkit-section call-site input gains one field), `prefix-cache.ts`, provider adapters (`CodexSubscriptionAdapter`/`OpenAIAgentsAdapter`/`GeminiAdkAdapter` — empty tool inventories, deferral meaningless there), or the dispatcher. No hive-side tool counting, no `auto:N` tuning surface, no new telemetry fields, no `hive doctor` section, no Haiku special-casing (SDK excludes Haiku itself). No live-instance verification steps in this plan (see Non-Required Rationale).

---

### Task 1: `toolSearch` config section (liberal loader)

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/config.ts` (insert resolver after `resolveOutageQueueConfig`, ~line 92; add export entry beside `outageQueue`, ~line 360)
- Test: `/Users/mokie/github/kpr-326-work/src/config.test.ts` (append describe block)

- [ ] Step 1: In `src/config.ts`, immediately after the `resolveOutageQueueConfig` function (ends ~line 92), add:

```ts
/**
 * KPR-329: tool-search (deferred MCP tool loading) mode. Controls the
 * `ENABLE_TOOL_SEARCH` env var pinned on every Claude-provider spawn:
 *   auto → CLI threshold mode (defer only past ~10% context) — engine default
 *   on   → always defer eligible MCP tool schemas
 *   off  → eager loading (today's intended behavior) — the rollback posture
 */
export type ToolSearchMode = "auto" | "on" | "off";

export interface ToolSearchConfig {
  mode: ToolSearchMode;
  /** Where `mode` came from — explicit hive.yaml value vs engine default.
   *  Feeds the per-spawn debug log (`source=agent|hive.yaml|default`). */
  source: "hive.yaml" | "default";
}

export const DEFAULT_TOOL_SEARCH_CONFIG: ToolSearchConfig = { mode: "auto", source: "default" };

/** Type guard shared by the loader; agent-side guards live at their own boundaries. */
export function isToolSearchMode(v: unknown): v is ToolSearchMode {
  return v === "auto" || v === "on" || v === "off";
}

/**
 * KPR-329: liberal-loader resolver for the `toolSearch` hive.yaml section
 * (KPR-225 F3 — all keys optional, unknown keys ignored, absent section =
 * all defaults, invalid mode → warn + default). Exported pure for unit tests.
 */
export function resolveToolSearchConfig(raw: unknown): ToolSearchConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TOOL_SEARCH_CONFIG };
  const r = raw as Record<string, unknown>;
  if (r.mode === undefined) return { ...DEFAULT_TOOL_SEARCH_CONFIG };
  if (isToolSearchMode(r.mode)) return { mode: r.mode, source: "hive.yaml" };
  console.warn(
    `[config] toolSearch.mode "${String(r.mode)}" is invalid — expected auto | on | off; defaulting to "auto".`,
  );
  return { ...DEFAULT_TOOL_SEARCH_CONFIG };
}
```

- [ ] Step 2: In the exported `config` object, directly after the `outageQueue:` entry (~line 360), add:

```ts
  // KPR-329: tool-search / deferred MCP tool loading (hive.yaml `toolSearch`,
  // all keys optional; mode: off = eager loading, the rollback posture).
  toolSearch: resolveToolSearchConfig(hive.toolSearch),
```

- [ ] Step 3: In `src/config.test.ts`, extend the top import from `./config.js` with `resolveToolSearchConfig, DEFAULT_TOOL_SEARCH_CONFIG` and append:

```ts
describe("resolveToolSearchConfig (KPR-329)", () => {
  it("returns defaults for absent/garbage section", () => {
    expect(resolveToolSearchConfig(undefined)).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig(null)).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig("off")).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig(42)).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig([])).toEqual({ mode: "auto", source: "default" });
  });

  it("returns a copy of defaults, not the shared object", () => {
    const a = resolveToolSearchConfig(undefined);
    expect(a).not.toBe(DEFAULT_TOOL_SEARCH_CONFIG);
  });

  it("accepts each valid mode with source hive.yaml", () => {
    expect(resolveToolSearchConfig({ mode: "auto" })).toEqual({ mode: "auto", source: "hive.yaml" });
    expect(resolveToolSearchConfig({ mode: "on" })).toEqual({ mode: "on", source: "hive.yaml" });
    expect(resolveToolSearchConfig({ mode: "off" })).toEqual({ mode: "off", source: "hive.yaml" });
  });

  it("warns and defaults to auto on an invalid mode value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveToolSearchConfig({ mode: "yes" })).toEqual({ mode: "auto", source: "default" });
      expect(resolveToolSearchConfig({ mode: true })).toEqual({ mode: "auto", source: "default" });
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[0][0])).toContain("toolSearch.mode");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats an empty section as defaults and ignores unknown keys", () => {
    expect(resolveToolSearchConfig({})).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig({ mode: "on", autoThresholdPercent: 5 })).toEqual({
      mode: "on",
      source: "hive.yaml",
    });
  });
});
```

- [ ] Step 4: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts` → all tests pass, new describe block green.
- [ ] Step 5: Commit —
```bash
cd /Users/mokie/github/kpr-326-work
git add src/config.ts src/config.test.ts
git commit -m "KPR-329: add toolSearch config section (liberal loader, default auto)"
```

---

### Task 2: agent-definition field + registry load-time sanitization

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/types/agent-definition.ts` (field after `spawnBudget` ~line 77; projection in `toAgentConfig` after `spawnBudget:` ~line 162)
- Modify: `/Users/mokie/github/kpr-326-work/src/types/agent-config.ts` (field after `spawnBudget` ~line 42)
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/agent-registry.ts` (sanitizer after `sanitizeDelegateServers` ~line 55; call in `load()` after line 224)
- Test: `/Users/mokie/github/kpr-326-work/src/agents/agent-registry.test.ts`

- [ ] Step 1: In `src/types/agent-definition.ts`, inside `AgentDefinition` after the `spawnBudget?: number;` member, add:

```ts
  /**
   * KPR-329: per-agent tool-search (deferred MCP tool loading) override.
   * Absent ⇒ inherit hive.yaml `toolSearch.mode` (engine default "auto").
   * Validated at admin write time; sanitized at registry load (invalid →
   * treated as absent, error logged) — KPR-184 pattern.
   */
  toolSearch?: "auto" | "on" | "off";
```

In `toAgentConfig`, after the `spawnBudget: doc.spawnBudget,` line, add:

```ts
    // KPR-329: pass through as-is; agent-registry sanitizes invalid values
    // (from legacy/hand-edited docs) to undefined at load time.
    toolSearch: doc.toolSearch,
```

- [ ] Step 2: In `src/types/agent-config.ts`, inside `AgentConfig` after the `spawnBudget?: number;` member, add:

```ts
  /**
   * KPR-329: per-agent tool-search override ("auto" | "on" | "off").
   * Absent ⇒ inherit hive.yaml toolSearch.mode. Guaranteed valid-or-undefined
   * post-registry-load (sanitized there); hand-built configs may carry
   * anything, which resolveToolSearchEnv treats as absent.
   */
  toolSearch?: "auto" | "on" | "off";
```

- [ ] Step 3: In `src/agents/agent-registry.ts`, directly after the `sanitizeDelegateServers` function (ends ~line 55), add:

```ts
/**
 * KPR-329: sanitize the optional `toolSearch` field. Invalid values (anything
 * other than "auto" | "on" | "off" | absent) are treated as absent — the agent
 * inherits the global hive.yaml mode — and an error is logged so the operator
 * can repair the doc. Mirrors the KPR-184 delegateServers sanitizer: the admin
 * tool rejects malformed inputs at create/update; this guards pre-existing or
 * hand-edited data on engine boot. `null` is treated as an intentional unset
 * (no log) — Mongo docs cleared via `$set: null` should not spam errors.
 */
function sanitizeToolSearch(agentId: string, value: unknown): "auto" | "on" | "off" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "on" || value === "off") return value;
  log.error("Invalid toolSearch value — must be auto | on | off. Treating as absent (inherit global).", {
    agent: agentId,
    value: String(value),
    remediation: 'Fix via admin_agent_update (toolSearch: "auto" | "on" | "off") or unset the field.',
  });
  return undefined;
}
```

- [ ] Step 4: In `load()`, directly after the KPR-184 sanitization line (`agentConfig.delegateServers = sanitizeDelegateServers(...)`, ~line 224) and before `currentIds.add(agentConfig.id);`, add:

```ts
      // KPR-329: sanitize the optional toolSearch override before any
      // downstream consumer (spawn env resolution, prefix builder) sees it.
      agentConfig.toolSearch = sanitizeToolSearch(agentConfig.id, agentConfig.toolSearch);
```

- [ ] Step 5: In `src/agents/agent-registry.test.ts`, add to the `toAgentConfig` describe (or a new sibling describe):

```ts
describe("toolSearch field (KPR-329)", () => {
  it("toAgentConfig passes toolSearch through and leaves it undefined when absent", () => {
    expect(toAgentConfig(makeDefinition({ toolSearch: "on" }), {}).toolSearch).toBe("on");
    expect(toAgentConfig(makeDefinition(), {}).toolSearch).toBeUndefined();
  });
});
```

Then, following the file's existing registry-load test setup (fake `Collection` whose `find().toArray()` resolves the docs array — mirror the KPR-184 sanitization test if present, otherwise the nearest `registry.load()` test), add:

```ts
describe("AgentRegistry toolSearch sanitization (KPR-329)", () => {
  it("strips an invalid toolSearch value at load, logs an error, and keeps the agent active", async () => {
    const doc = makeDefinition({ _id: "bad-ts", toolSearch: "always" as never });
    const registry = makeRegistryWithDocs([doc]); // reuse the file's existing fake-collection helper pattern
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await registry.load();
      const cfg = registry.get("bad-ts");
      expect(cfg).toBeDefined();
      expect(cfg!.toolSearch).toBeUndefined(); // inherit global
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("preserves a valid toolSearch value at load", async () => {
    const doc = makeDefinition({ _id: "good-ts", toolSearch: "off" });
    const registry = makeRegistryWithDocs([doc]);
    await registry.load();
    expect(registry.get("good-ts")!.toolSearch).toBe("off");
  });
});
```

(Implementer note: `makeRegistryWithDocs` is a placeholder name for whatever fake-collection constructor the existing load tests in this file use — reuse it verbatim; do not invent a new harness. If the logger writes via `createLogger` rather than console, assert sanitization by the resulting config state only — the state assertions are the load-bearing ones.)

- [ ] Step 6: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-registry.test.ts` → green.
- [ ] Step 7: Commit —
```bash
cd /Users/mokie/github/kpr-326-work
git add src/types/agent-definition.ts src/types/agent-config.ts src/agents/agent-registry.ts src/agents/agent-registry.test.ts
git commit -m "KPR-329: agent-definition toolSearch field + registry load-time sanitization"
```

---

### Task 3: `resolveToolSearchEnv` + spawn env wiring + logs (agent-runner)

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/agent-runner.ts` (pure functions at module level near other module-scope helpers, before the `AgentRunner` class; wiring before the `query()` call ~line 1745; env block ~line 1771–1776)
- Test: `/Users/mokie/github/kpr-326-work/src/agents/agent-runner.test.ts`

- [ ] Step 1: **Update the `../config.js` mock factory in `src/agents/agent-runner.test.ts` FIRST** (lines 89–130). The file mocks the config module *wholesale* with a factory that currently exports only `config` — it has no `toolSearch` key and no `isToolSearchMode` export. Since Step 2 below makes agent-runner.ts import `isToolSearchMode` from `../config.js` and read `config.toolSearch.mode`/`config.toolSearch.source` in `send()`, the unmodified mock would make **every** test in the file (including all pre-existing describes) throw `TypeError: isToolSearchMode is not a function` / crash on the missing `toolSearch` key. Do NOT rely on "the test env has no hive.yaml toolSearch section" — the module is mocked, not env-driven. Edit the factory exactly as follows: inside the exported `config` object, after the `voice:` entry (line 128), add the `toolSearch` key; and after the closing brace of `config`, add a real `isToolSearchMode` stub (a genuine implementation, so the resolution-chain tests below exercise true behavior — `importOriginal` is deliberately avoided because the real config.ts runs env/hive.yaml loading at module scope, which is why this file mocks it wholesale):

```ts
// ── Config mock ─────────────────────────────────────────────────────
vi.mock("../config.js", () => ({
  config: {
    // ... all existing keys (instance, slack, mongo, google, quo, taskLedger,
    // brave, resend, linear, clickup, github, recall, background, codeTask,
    // anthropic, defaultAgent, autonomy, browser, memory, workflow) unchanged ...
    voice: { apiKey: "", phoneNumberId: "", assistants: {} },
    // KPR-329: engine-default tool-search config for the mocked module.
    toolSearch: { mode: "auto", source: "default" },
  },
  // KPR-329: real stub matching config.ts's type guard — agent-runner.ts
  // imports this; the mock factory must export it or every test in this
  // file throws at import time.
  isToolSearchMode: (v: unknown): v is "auto" | "on" | "off" =>
    v === "auto" || v === "on" || v === "off",
}));
```

(Only the two `// KPR-329` additions are new — leave every existing config key byte-identical. Both additions are purely additive: no existing test in this file reads `config.toolSearch` or `isToolSearchMode`, so pre-existing describes are unaffected.)

- [ ] Step 2: At module scope in `agent-runner.ts` (after the existing module-level constants, before the `AgentRunner` class), add — note `config` is already imported at line 11 and `isToolSearchMode` comes from `../config.js`:

```ts
// ── KPR-329: tool-search (deferred MCP tool loading) resolution ──────────────

/** Resolution-chain provenance for the spawn debug log. */
export type ToolSearchSource = "agent" | "hive.yaml" | "default";

/**
 * KPR-329: resolve the effective tool-search mode + provenance.
 * Chain: agent-definition `toolSearch` field → hive.yaml `toolSearch.mode` →
 * engine default "auto". The agent value is defensively re-validated here
 * (registry sanitizes on load, but hand-built configs in tests/fixtures
 * bypass the registry).
 */
export function resolveToolSearchMode(
  agentToolSearch: string | undefined,
  hiveMode: string,
  hiveSource: "hive.yaml" | "default" = "hive.yaml",
): { mode: "auto" | "on" | "off"; source: ToolSearchSource } {
  if (isToolSearchMode(agentToolSearch)) return { mode: agentToolSearch, source: "agent" };
  if (isToolSearchMode(hiveMode)) return { mode: hiveMode, source: hiveSource };
  return { mode: "auto", source: "default" };
}

/**
 * KPR-329: map the resolved mode to the CLI's `ENABLE_TOOL_SEARCH` env value
 * (spec §4.1 table): auto → "auto" (tst-auto threshold mode), on → "true"
 * (always defer), off → "false" (standard/eager — the rollback posture).
 * The value is ALWAYS set on the spawn env — never left to ambient
 * process.env or the CLI's drifting experimental default.
 */
export function resolveToolSearchEnv(
  agentToolSearch: string | undefined,
  hiveMode: string,
): "auto" | "true" | "false" {
  const { mode } = resolveToolSearchMode(agentToolSearch, hiveMode);
  return mode === "on" ? "true" : mode === "off" ? "false" : "auto";
}

/**
 * KPR-329: ambient CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS force-disables tool
 * search inside the CLI regardless of ENABLE_TOOL_SEARCH — it would silently
 * defeat `on`/`auto`. Warn once per process (the CLI itself logs once per
 * process; per-spawn would be log spam).
 */
let warnedToolSearchForceDisabled = false;
export function __resetToolSearchWarnForTests(): void {
  warnedToolSearchForceDisabled = false;
}
function warnIfToolSearchForceDisabled(): void {
  if (warnedToolSearchForceDisabled || !process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) return;
  warnedToolSearchForceDisabled = true;
  log.warn(
    "Ambient CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set — the CLI force-disables tool search; toolSearch mode 'on'/'auto' will silently run eager (KPR-329)",
    { value: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS },
  );
}
```

Extend the existing `import { config } from "../config.js";` (line 11) to `import { config, isToolSearchMode } from "../config.js";`.

- [ ] Step 3: In `send()`, immediately before `const q = query({` (~line 1745), add the resolution + debug log (mirrors the spawnBudget `budgetSource` provenance style — structured field, not string interpolation):

```ts
    // KPR-329: resolve tool-search mode for this spawn. The env value is
    // always pinned (see env block below) so hive owns the policy — the CLI's
    // implicit default is never in play.
    const toolSearch = resolveToolSearchMode(
      this.agentConfig.toolSearch,
      config.toolSearch.mode,
      config.toolSearch.source,
    );
    log.debug("Tool search mode resolved", {
      agent: this.agentConfig.id,
      mode: toolSearch.mode,
      source: toolSearch.source,
    });
    warnIfToolSearchForceDisabled();
```

- [ ] Step 4: In the `env` block (~line 1771–1776), add one entry after `CLAUDECODE: undefined,`:

```ts
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined,
          // KPR-329: always pinned — overrides any ambient ENABLE_TOOL_SEARCH.
          ENABLE_TOOL_SEARCH:
            toolSearch.mode === "on" ? "true" : toolSearch.mode === "off" ? "false" : "auto",
        },
```

(The inline ternary reuses the already-resolved `toolSearch.mode` rather than re-calling `resolveToolSearchEnv` so the logged mode and the env value cannot diverge; `resolveToolSearchEnv` remains the exported spec-contract function and is what the unit-test matrix exercises.)

- [ ] Step 5: In `src/agents/agent-runner.test.ts`, extend the import from `./agent-runner.js` with `resolveToolSearchEnv, resolveToolSearchMode` and append:

```ts
describe("resolveToolSearchEnv (KPR-329)", () => {
  it("agent override wins over every hive mode", () => {
    for (const hive of ["auto", "on", "off"]) {
      expect(resolveToolSearchEnv("auto", hive)).toBe("auto");
      expect(resolveToolSearchEnv("on", hive)).toBe("true");
      expect(resolveToolSearchEnv("off", hive)).toBe("false");
    }
  });

  it("falls back to hive mode when agent field is absent", () => {
    expect(resolveToolSearchEnv(undefined, "auto")).toBe("auto");
    expect(resolveToolSearchEnv(undefined, "on")).toBe("true");
    expect(resolveToolSearchEnv(undefined, "off")).toBe("false");
  });

  it("falls back to engine default auto when both are absent/invalid", () => {
    expect(resolveToolSearchEnv(undefined, "")).toBe("auto");
    expect(resolveToolSearchEnv(undefined, "garbage")).toBe("auto");
  });

  it("treats an invalid agent value as absent (inherit hive mode)", () => {
    expect(resolveToolSearchEnv("always", "off")).toBe("false");
    expect(resolveToolSearchEnv("", "on")).toBe("true");
    expect(resolveToolSearchEnv("TRUE", "auto")).toBe("auto");
  });

  it("reports resolution source: agent | hive.yaml | default", () => {
    expect(resolveToolSearchMode("on", "auto")).toEqual({ mode: "on", source: "agent" });
    expect(resolveToolSearchMode(undefined, "off")).toEqual({ mode: "off", source: "hive.yaml" });
    expect(resolveToolSearchMode(undefined, "auto", "default")).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchMode("bogus", "junk")).toEqual({ mode: "auto", source: "default" });
  });
});

describe("AgentRunner ENABLE_TOOL_SEARCH env pinning (via send) (KPR-329)", () => {
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages = null;
    memoryManager = makeMockMemoryManager();
  });

  it("pins ENABLE_TOOL_SEARCH to 'auto' by default (no agent field, default config)", async () => {
    const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
    await runner.send("hello");
    const options = getCapturedOptions();
    expect(options.env.ENABLE_TOOL_SEARCH).toBe("auto");
  });

  it("agent toolSearch 'on' yields the literal string 'true'", async () => {
    const runner = new AgentRunner(makeAgentConfig({ toolSearch: "on" }), memoryManager as any);
    await runner.send("hello");
    expect(getCapturedOptions().env.ENABLE_TOOL_SEARCH).toBe("true");
  });

  // Spec §6.6 negative-verify: 'off' must produce the literal string "false"
  // in the spawn env map — NOT merely absent/undefined (absent would let the
  // CLI's implicit experimental default back in).
  it("agent toolSearch 'off' yields the literal string 'false', not undefined", async () => {
    const runner = new AgentRunner(makeAgentConfig({ toolSearch: "off" }), memoryManager as any);
    await runner.send("hello");
    const env = getCapturedOptions().env;
    expect(env.ENABLE_TOOL_SEARCH).not.toBeUndefined();
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
  });

  it("engine value overrides ambient process.env.ENABLE_TOOL_SEARCH", async () => {
    process.env.ENABLE_TOOL_SEARCH = "true";
    try {
      const runner = new AgentRunner(makeAgentConfig({ toolSearch: "off" }), memoryManager as any);
      await runner.send("hello");
      expect(getCapturedOptions().env.ENABLE_TOOL_SEARCH).toBe("false");
    } finally {
      delete process.env.ENABLE_TOOL_SEARCH;
    }
  });
});
```

(Implementer note: `makeMockMemoryManager`, `makeAgentConfig`, `getCapturedOptions`, and `mockMessages` are this file's existing helpers — reuse them exactly as the "betas passthrough (via send)" describe at ~line 2344 does. The default-config assertion ("pins to 'auto' by default") is satisfied by the mock factory's `toolSearch: { mode: "auto", source: "default" }` from Step 1 — the `../config.js` module is mocked wholesale in this file, so the ambient test env / absence of a hive.yaml section is irrelevant here.)

- [ ] Step 6: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-runner.test.ts` → green, including all pre-existing describes (regression check on the env block **and** on the Step 1 mock-factory update — pre-existing tests must be unaffected by the two additive mock keys).
- [ ] Step 7: Commit —
```bash
cd /Users/mokie/github/kpr-326-work
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
git commit -m "KPR-329: pin ENABLE_TOOL_SEARCH per spawn via resolveToolSearchEnv (agent → hive.yaml → auto)"
```

---

### Task 4: admin MCP validation on agent_create / agent_update

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/admin/admin-mcp-server.ts` (helper beside `checkDelegateContextDependent` ~line 58; create-path check after the KPR-221 check ~line 302 + doc field ~line 343; update-path check after the delegateServers block ~line 441)
- Test: `/Users/mokie/github/kpr-326-work/src/admin/admin-mcp-server.test.ts`

- [ ] Step 1: Beside the existing `checkDelegateServers` / `checkDelegateContextDependent` helpers, add:

```ts
/**
 * KPR-329: validate the optional `toolSearch` field at the write boundary.
 * Returns an error string for the tool response, or null if acceptable.
 * `undefined`/`null` are acceptable (absent / explicit unset — inherit the
 * hive.yaml global). The registry re-sanitizes at load as defense in depth.
 */
function checkToolSearch(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value === "auto" || value === "on" || value === "off") return null;
  return `Invalid toolSearch: "${String(value)}". Must be one of: auto, on, off — or omit the field to inherit the hive.yaml toolSearch.mode (engine default: auto).`;
}
```

- [ ] Step 2: In the `agent_create` handler, directly after the KPR-221 `contextError` check (~line 302), add:

```ts
          // KPR-329: reject invalid toolSearch at the write boundary.
          const toolSearchError = checkToolSearch(f.toolSearch);
          if (toolSearchError) {
            return { isError: true, content: [{ type: "text", text: toolSearchError }] };
          }
```

And in the `doc: AgentDefinition = { ... }` literal, after the `spawnBudget:` entry, add:

```ts
            // KPR-329: optional; absent = inherit hive.yaml toolSearch.mode.
            toolSearch: f.toolSearch as "auto" | "on" | "off" | undefined,
```

- [ ] Step 3: In the `agent_update` handler, directly after the `delegateServers` validation block (closes ~line 441), add:

```ts
          // KPR-329: reject invalid toolSearch at the write boundary. null is
          // allowed through (explicit unset — registry treats it as absent).
          if ("toolSearch" in merged) {
            const toolSearchError = checkToolSearch(merged.toolSearch);
            if (toolSearchError) {
              return { isError: true, content: [{ type: "text", text: toolSearchError }] };
            }
          }
```

- [ ] Step 4: In `src/admin/admin-mcp-server.test.ts`, following the file's existing handler-invocation pattern (find the tool by name from `buildAdminTools(deps)`, call `.handler(args)` against the fake Db), add:

```ts
describe("toolSearch validation (KPR-329)", () => {
  it("agent_create rejects an invalid toolSearch value", async () => {
    const res = await callTool("agent_create", {
      ...validCreateArgs(),                      // reuse the file's existing valid-args helper/literal
      fields: { toolSearch: "always" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid toolSearch");
    expect(agentDocsStore.size).toBe(0);         // nothing persisted
  });

  it("agent_create persists a valid toolSearch value", async () => {
    const res = await callTool("agent_create", {
      ...validCreateArgs(),
      fields: { toolSearch: "off" },
    });
    expect(res.isError).toBeUndefined();
    expect(agentDocsStore.get(validCreateArgs()._id).toolSearch).toBe("off");
  });

  it("agent_create leaves toolSearch absent when omitted", async () => {
    await callTool("agent_create", validCreateArgs());
    expect(agentDocsStore.get(validCreateArgs()._id).toolSearch).toBeUndefined();
  });

  it("agent_update rejects an invalid toolSearch value without writing", async () => {
    seedAgent();                                  // reuse existing seeding helper/pattern
    const res = await callTool("agent_update", {
      agent_id: seededAgentId,
      fields: { toolSearch: "TRUE" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid toolSearch");
    expect(agentDocsStore.get(seededAgentId).toolSearch).toBeUndefined();
  });

  it("agent_update accepts a valid toolSearch value", async () => {
    seedAgent();
    const res = await callTool("agent_update", {
      agent_id: seededAgentId,
      fields: { toolSearch: "on" },
    });
    expect(res.isError).toBeUndefined();
    expect(agentDocsStore.get(seededAgentId).toolSearch).toBe("on");
  });
});
```

(Implementer note: `callTool`, `validCreateArgs`, `seedAgent` are placeholder names — bind them to whatever helpers/literals the existing create/update tests in this file use, e.g. the KPR-184 delegateServers-rejection tests, which have exactly this shape.)

- [ ] Step 5: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/admin/admin-mcp-server.test.ts` → green.
- [ ] Step 6: Commit —
```bash
cd /Users/mokie/github/kpr-326-work
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "KPR-329: validate toolSearch on agent_create/agent_update"
```

---

### Task 5: toolkit-section addendum capability (conservatively disabled)

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/toolkit-section.ts` (input field ~line 36; flag + conditional at the end of `buildToolkitSection` ~line 167)
- Modify: `/Users/mokie/github/kpr-326-work/src/agents/prefix-builder.ts` (toolkit call-site ~line 117–123 only — no other prefix logic)
- Test: `/Users/mokie/github/kpr-326-work/src/agents/toolkit-section.test.ts`

- [ ] Step 1: In `toolkit-section.ts`, add to `ToolkitSectionInput` (after `autoInjectedServers`):

```ts
  /**
   * KPR-329: true when this agent's resolved tool-search mode ≠ "off" —
   * i.e. MCP tool schemas may be deferred and discovered on demand. Gates
   * the optional discovery-hint line (see TOOLKIT_DEFERRED_HINT below).
   * Optional so existing callers/tests are unaffected.
   */
  deferredLoadingActive?: boolean;
```

- [ ] Step 2: Above `buildToolkitSection`, add the flag; at the end of the function (after the delegate subsection push, before `return`), add the conditional:

```ts
/**
 * KPR-329 / spec §4.4 — deferred-tool discovery hint, INTENTIONALLY DISABLED.
 *
 * The CLI may already inject equivalent "search for deferred tools" guidance
 * when tool search is active: it demonstrably does in interactive Claude
 * Code, but whether SDK-spawned sessions get the same injection is
 * unverified (spec open assumption #3), and verifying requires a live hive
 * instance. Shipping this line before that check risks double-prompting the
 * agent with two overlapping instructions.
 *
 * To enable: run the spec §6 live verification (inspect a spawned session's
 * system context under toolSearch mode "on" for CLI-injected discovery
 * guidance); if the CLI does NOT inject it, flip this to true. No other
 * change is needed — the gating input is already wired from prefix-builder.
 */
const TOOLKIT_DEFERRED_HINT = false;
```

```ts
  // KPR-329: optional discovery hint — only when deferral can be active for
  // this agent AND the hint is enabled (see TOOLKIT_DEFERRED_HINT rationale).
  if (TOOLKIT_DEFERRED_HINT && input.deferredLoadingActive) {
    sections.push(
      "Some tool schemas load on demand — if a listed tool isn't directly callable, search for it by name first.",
    );
  }
```

- [ ] Step 3: In `prefix-builder.ts`, extend the `buildToolkitSection({ ... })` call (~line 117) with one field (`config` is already imported at line 29; `agentConfig.toolSearch` is valid-or-undefined post-registry-sanitization):

```ts
    buildToolkitSection({
      coreServerNames: ctx.coreServerNames,
      delegateServerNames: ctx.activeDelegateNames,
      plugins: ctx.plugins,
      autoInjectedServers: ctx.autoInjectedServers,
      // KPR-329: resolved mode ≠ "off" (agent override → hive.yaml → auto).
      // Lives in the cached prefix: the agent-def field change invalidates via
      // the definition-update path; hive.yaml changes require restart anyway.
      deferredLoadingActive: (agentConfig.toolSearch ?? config.toolSearch.mode) !== "off",
    }),
```

- [ ] Step 4: In `toolkit-section.test.ts`, following the file's existing input-fixture pattern, add:

```ts
describe("deferred-loading hint (KPR-329)", () => {
  const HINT = "Some tool schemas load on demand";

  it("is NOT emitted while TOOLKIT_DEFERRED_HINT is disabled, even when deferral is active", () => {
    // Locks the conservative default: the hint ships dark until the CLI
    // double-prompting question (spec §4.4 / open assumption #3) is settled
    // against a live instance.
    const out = buildToolkitSection({ ...baseInput(), deferredLoadingActive: true });
    expect(out).not.toContain(HINT);
  });

  it("is NOT emitted when deferral is inactive or unspecified", () => {
    expect(buildToolkitSection({ ...baseInput(), deferredLoadingActive: false })).not.toContain(HINT);
    expect(buildToolkitSection(baseInput())).not.toContain(HINT);
  });

  it("output is unchanged by the new optional input (byte-identical)", () => {
    expect(buildToolkitSection({ ...baseInput(), deferredLoadingActive: true })).toBe(
      buildToolkitSection(baseInput()),
    );
  });
});
```

(Implementer note: `baseInput()` = the file's existing minimal `ToolkitSectionInput` fixture — reuse it. When `TOOLKIT_DEFERRED_HINT` is later flipped to true, the first and third tests are the ones to update — note this in the test comment only if the file's conventions do so elsewhere; no TODO markers.)

- [ ] Step 5: Verify — `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/toolkit-section.test.ts src/agents/prefix-builder.test.ts` → green (prefix-builder tests confirm no regression from the call-site change).
- [ ] Step 6: Commit —
```bash
cd /Users/mokie/github/kpr-326-work
git add src/agents/toolkit-section.ts src/agents/prefix-builder.ts src/agents/toolkit-section.test.ts
git commit -m "KPR-329: toolkit deferred-loading hint capability (shipped dark pending CLI-guidance verification)"
```

---

### Task 6: CLAUDE.md gotcha + full quality gate

**Files:**
- Modify: `/Users/mokie/github/kpr-326-work/CLAUDE.md` (append one bullet under `## Common Gotchas`, alongside the KPR-306/KPR-307 bullets)

- [ ] Step 1: Add this bullet to the Common Gotchas list:

```markdown
- **Tool search / deferred MCP tool loading (KPR-329):** every Claude spawn pins `ENABLE_TOOL_SEARCH` explicitly — resolution: agent-definition `toolSearch` field → hive.yaml `toolSearch.mode` → engine default `auto`. `auto` = the CLI's token-threshold mode (defers MCP tool schemas only past ~10% of context — small agents see zero change); `on` = always defer; `off` = eager loading, exactly the pre-KPR-329 intended behavior. Rollback: set `toolSearch.mode: off` in hive.yaml + restart (per-agent: `admin_agent_update` + SIGUSR1, takes effect next spawn). Haiku models are excluded by the SDK (silently eager). Operators fronting a non-first-party `ANTHROPIC_BASE_URL` proxy should set `mode: off` — a proxy that strips `tool_reference` blocks degrades `on`/`auto` turns. Ambient `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` force-disables tool search inside the CLI (engine warns once per process).
```

- [ ] Step 2: Verify — full quality gate:
```bash
cd /Users/mokie/github/kpr-326-work
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck, lint, format, and the full vitest suite all pass (exit 0).
- [ ] Step 3: Commit —
```bash
cd /Users/mokie/github/kpr-326-work
git add CLAUDE.md
git commit -m "KPR-329: CLAUDE.md gotcha — toolSearch mode semantics + rollback"
```

---

## Post-merge (NOT plan tasks — recorded so nothing is silently dropped)

Spec §6.1–6.5 are operational verification against a live dev instance (baseline capture settling the "already implicitly on?" question, mode matrix via `get_context_usage`, functional deferred-tool discovery on a heavy agent, cache-read sanity across consecutive turns, in-process SDK-server eligibility). They run after merge/deploy and their outcomes go in the PR/ticket — including the decision on flipping `TOOLKIT_DEFERRED_HINT` (open assumption #3).
