# Per-Agent cwd + Instance Sibling Namespaces Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Ticket:** [KPR-51](https://linear.app/keepur/issue/KPR-51) (Phase 1 of KPR-50, v0.2.0)
**Spec:** [2026-04-21-per-agent-cwd-design.md](../specs/2026-04-21-per-agent-cwd-design.md)
**Branch:** `kpr-51` (already on `kpr-50`; create `kpr-51` at start)

**Goal:** Stop business-agent writes from landing at HIVE_HOME. Default session cwd becomes `<hive>/agents/<id>/scratch/`; Playwright MCP artifacts and browser profile become per-agent. Retention sweeper ships in dry-run-only mode.

**Architecture:** Agent-runner resolves a single `effectiveCwd` per session — archetype-provided wins, otherwise the per-agent scratch dir (lazy `mkdirSync`). Playwright MCP gets `--output-dir` and `--user-data-dir` CLI flags scoped per agent (the SDK's `McpStdioServerConfig` has no `cwd`). Retention is a new top-level `RetentionSweeper` with its own interval timer, injected into `src/index.ts` alongside the existing `Sweeper`; dry-run reports go to the global Slack audit channel.

**Tech Stack:** TypeScript (strict), Node 24, `@anthropic-ai/claude-agent-sdk`, Vitest.

---

## File Structure

### New files
- `src/retention/retention-config.ts` — parses `retention:` YAML block into typed config, applies defaults, rejects negatives.
- `src/retention/retention-sweeper.ts` — walks configured paths, computes age-over candidates, deletes (or dry-runs), emits a Slack summary via injected callback.
- `src/retention/retention-sweeper.test.ts` — covers `.retention-days` override, age filter, dry-run mode, glob expansion (`agents/*/scratch`).

### Modified files
- `src/paths.ts` — add pure `agentsDir(hiveHome)`, `agentScratchDir(hiveHome, id)`, `agentPlaywrightDir(hiveHome, id)` helpers. No I/O.
- `src/agents/agent-runner.ts` — replace lines ~1100-1153 cwd block; replace browser MCP spawn at ~520-530.
- `src/agents/agent-runner.test.ts` — add cases for default cwd + mkdir behavior, and Playwright per-agent flags.
- `src/config.ts` — parse `hive.retention` block into `config.retention`.
- `src/index.ts` — instantiate and start `RetentionSweeper`, stop it in `shutdown`.
- `.gitignore` — add `/agents/`, `/workflow/`, `/data/`; broaden `/plugins/claude-code/` to `/plugins/`.
- `hive.yaml.example` — document the `retention:` block (commented, showing defaults).

### Intentionally NOT touched (per spec, §Files touched / Not touched in Phase 1)
- `src/archetypes/software-engineer/*` — workshop default is a Phase 5 data migration.
- `src/code-task/*`, `src/background/background-task-mcp-server.ts` — prompt-side guidance lands in Phase 4 docs.
- `src/scheduler/scheduler.ts` — retention uses its own timer, not cron.

---

## Task 1: Path helpers

**Files:**
- Modify: `src/paths.ts`

- [ ] **Step 1:** Add three pure helpers at the end of `src/paths.ts`. Keep them pure — no `mkdirSync`, the agent-runner owns the mkdir.

```typescript
/**
 * Instance-local per-agent home root: `<hiveHome>/agents/`.
 * The runner creates `<this>/<agentId>/` subdirs lazily on first use.
 */
export function agentsDir(home: string = hiveHome): string {
  return resolve(home, "agents");
}

/**
 * Default session cwd for an agent with no archetype-provided cwd.
 * Business agents (Milo, River, Jessica, etc.) land here.
 */
export function agentScratchDir(agentId: string, home: string = hiveHome): string {
  return resolve(agentsDir(home), agentId, "scratch");
}

/**
 * Per-agent Playwright MCP home — holds the browser profile (`user-data/`)
 * and CDP artifacts (snapshots, traces, screenshots) via `--output-dir`.
 */
export function agentPlaywrightDir(agentId: string, home: string = hiveHome): string {
  return resolve(agentsDir(home), agentId, "playwright");
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit -p .`
Expected: exits 0, no new errors.

- [ ] **Step 3:** Commit

```bash
git checkout -b kpr-51
git add src/paths.ts
git commit -m "feat(paths): add agents/scratch/playwright path helpers (KPR-51)"
```

---

## Task 2: Agent-runner default cwd + mkdir

**Files:**
- Modify: `src/agents/agent-runner.ts:1100-1153`

- [ ] **Step 1:** Add `mkdirSync` to the fs import at line 3.

```typescript
import { existsSync, statSync, mkdirSync } from "node:fs";
```

- [ ] **Step 2:** Add the paths-helper import below the existing `hiveHome` import (~line 12).

```typescript
import { hiveHome, agentScratchDir } from "../paths.js";
```

- [ ] **Step 3:** Replace the entire block at lines 1100-1153 (archetype sessionOptions compute → SDK query call). Match the current block carefully — the `...(archetypeExtra.cwd ? { cwd: archetypeExtra.cwd } : {})` spread is gone, replaced by a plain `cwd: effectiveCwd`.

Replace:

```typescript
    // Archetype session options (cwd, settingSources, etc.)
    let archetypeExtra: Partial<SdkQueryOptions> = {};
    const archetypeDefForSession = this.getArchetypeDef();
    if (archetypeDefForSession && this.agentConfig.archetypeConfig) {
      try {
        archetypeExtra = archetypeDefForSession.sessionOptions({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
          workItemContext: context,
        });
      } catch (err) {
        log.error("Archetype sessionOptions threw — ignoring", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }

    // Validate archetype cwd at session start — fail loud if workshop was deleted
    // between agent load and session start (spec Runtime Failure Mode 1).
    if (typeof archetypeExtra.cwd === "string") {
      const cwd = archetypeExtra.cwd;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(cwd);
      } catch (err) {
        const msg = `Archetype cwd unavailable at session start — refusing to run: ${cwd} (${String(err)})`;
        log.error(msg, { agent: this.agentConfig.id });
        throw new Error(msg);
      }
      if (!st.isDirectory()) {
        const msg = `Archetype cwd is not a directory: ${cwd}`;
        log.error(msg, { agent: this.agentConfig.id });
        throw new Error(msg);
      }
    }
```

with:

```typescript
    // Archetype session options (cwd, settingSources, etc.)
    let archetypeExtra: Partial<SdkQueryOptions> = {};
    const archetypeDefForSession = this.getArchetypeDef();
    if (archetypeDefForSession && this.agentConfig.archetypeConfig) {
      try {
        archetypeExtra = archetypeDefForSession.sessionOptions({
          agentConfig: this.agentConfig,
          archetypeConfig: this.agentConfig.archetypeConfig,
          workItemContext: context,
        });
      } catch (err) {
        log.error("Archetype sessionOptions threw — ignoring", {
          agent: this.agentConfig.id,
          archetype: this.agentConfig.archetype,
          error: String(err),
        });
      }
    }

    // Resolve the session cwd. Archetype-provided wins; otherwise every agent
    // gets a per-agent scratch dir so Bash/Write with relative paths lands in
    // the agent's namespace instead of HIVE_HOME. See KPR-51 design spec.
    const cwdSource: "archetype" | "default" =
      typeof archetypeExtra.cwd === "string" ? "archetype" : "default";
    const effectiveCwd =
      cwdSource === "archetype"
        ? (archetypeExtra.cwd as string)
        : agentScratchDir(this.agentConfig.id, hiveHome);

    if (cwdSource === "default") {
      // Lazy create — fail loud on mkdir errors (permissions, read-only fs).
      mkdirSync(effectiveCwd, { recursive: true });
    } else {
      // Archetype path must already exist: Jasper's workshop is operator-configured
      // and a missing dir there is a misconfig we want to surface at session start,
      // not silently recreate.
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(effectiveCwd);
      } catch (err) {
        const msg = `Archetype cwd unavailable at session start — refusing to run: ${effectiveCwd} (${String(err)})`;
        log.error(msg, { agent: this.agentConfig.id });
        throw new Error(msg);
      }
      if (!st.isDirectory()) {
        const msg = `Archetype cwd is not a directory: ${effectiveCwd}`;
        log.error(msg, { agent: this.agentConfig.id });
        throw new Error(msg);
      }
    }
```

- [ ] **Step 4:** Replace the `...(archetypeExtra.cwd ? { cwd: archetypeExtra.cwd } : {})` spread in the SDK `query()` options (currently line 1153). Find:

```typescript
        ...(archetypeExtra.cwd ? { cwd: archetypeExtra.cwd } : {}),
```

Replace with:

```typescript
        cwd: effectiveCwd,
```

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit -p .`
Expected: exits 0.

Run: `npx vitest run src/agents/agent-runner.test.ts`
Expected: existing suite still passes (test updates come in Task 4 — some of the archetype-cwd-guard tests may need to be re-read; if any break now, proceed to Task 4 to fix them, don't patch here).

- [ ] **Step 6:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agent-runner): default session cwd to per-agent scratch dir (KPR-51)"
```

---

## Task 3: Playwright MCP per-agent output/profile

**Files:**
- Modify: `src/agents/agent-runner.ts:520-530`

- [ ] **Step 1:** Add `agentPlaywrightDir` to the import from `../paths.js` (done partially in Task 2 — extend the same import line).

```typescript
import { hiveHome, agentScratchDir, agentPlaywrightDir } from "../paths.js";
```

- [ ] **Step 2:** Replace the browser MCP block at ~line 520-530.

Replace:

```typescript
    // Browser — Playwright MCP connected to user's Chrome via CDP
    if (config.browser.cdpEndpoint) {
      servers["browser"] = {
        type: "stdio",
        command: "npx",
        args: ["@playwright/mcp@latest", "--cdp-endpoint", config.browser.cdpEndpoint],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
      };
    }
```

with:

```typescript
    // Browser — Playwright MCP connected to user's Chrome via CDP.
    // Per-agent `--output-dir` (snapshots/traces/screenshots) and
    // `--user-data-dir` (profile) scope browser state to the agent's namespace
    // and keep `.playwright-mcp/` out of HIVE_HOME. The SDK's McpStdioServerConfig
    // has no cwd field, so CLI flags are the path — see KPR-51 design spec.
    if (config.browser.cdpEndpoint) {
      const pwDir = agentPlaywrightDir(this.agentConfig.id, hiveHome);
      mkdirSync(pwDir, { recursive: true });
      servers["browser"] = {
        type: "stdio",
        command: "npx",
        args: [
          "@playwright/mcp@latest",
          "--cdp-endpoint", config.browser.cdpEndpoint,
          "--output-dir", pwDir,
          "--user-data-dir", resolve(pwDir, "user-data"),
        ],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
      };
    }
```

(`resolve` is already imported at line 2; `mkdirSync` was added in Task 2.)

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit -p .`
Expected: exits 0.

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agent-runner): scope Playwright MCP output + profile per agent (KPR-51)"
```

---

## Task 4: Update agent-runner tests

**Files:**
- Modify: `src/agents/agent-runner.test.ts:1-20` (add `mkdirSync` to the `node:fs` mock)
- Modify: `src/agents/agent-runner.test.ts:1640-1720` (archetype cwd block — still relevant but now default-cwd tests belong here too)

- [ ] **Step 1:** Extend the `node:fs` hoisted mock at lines 10-17 to include `mkdirSync`.

Replace:

```typescript
const { mockExistsSync, mockStatSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockStatSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
}));
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
}));
```

with:

```typescript
const { mockExistsSync, mockStatSync, mockMkdirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockStatSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  mockMkdirSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
}));
```

- [ ] **Step 2:** Update the existing "does not invoke statSync when no archetype is configured" test (around line 1712). It used to assert `options.cwd` is `undefined` — now the default cwd always fires.

Replace:

```typescript
  it("does not invoke statSync when no archetype is configured", async () => {
    mockStatSync.mockClear();
    const runner = makeRunner({});
    await runner.send("hello");
    expect(mockStatSync.mock.calls.length).toBe(0);
    const options = getCapturedOptions();
    expect(options.cwd).toBeUndefined();
  });
```

with:

```typescript
  it("falls back to per-agent scratch dir when no archetype is configured", async () => {
    mockStatSync.mockClear();
    mockMkdirSync.mockClear();
    const runner = makeRunner({ id: "milo" });
    await runner.send("hello");
    // Default path: mkdir the scratch dir, no archetype stat.
    expect(mockStatSync.mock.calls.length).toBe(0);
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/\/agents\/milo\/scratch$/),
      { recursive: true },
    );
    const options = getCapturedOptions();
    expect(options.cwd).toMatch(/\/agents\/milo\/scratch$/);
  });

  it("archetype-provided cwd still wins over default scratch dir", async () => {
    mockMkdirSync.mockClear();
    registerArchetype({
      id: "overrides",
      validateConfig: (c) => c,
      systemPromptCard: () => "",
      preToolUseHooks: () => [],
      memoryScopes: () => [],
      sessionOptions: () => ({ cwd: "/tmp/exists" }),
    });
    const runner = makeRunner({
      id: "jasper",
      archetype: "overrides",
      archetypeConfig: {},
    });
    await runner.send("hello");
    const options = getCapturedOptions();
    expect(options.cwd).toBe("/tmp/exists");
    // Archetype branch must not mkdir (operator-configured path must already exist).
    const jasperScratchCalls = mockMkdirSync.mock.calls.filter((c) =>
      /\/agents\/jasper\/scratch$/.test(String(c[0])),
    );
    expect(jasperScratchCalls.length).toBe(0);
  });

  it("propagates mkdir failure when scratch dir can't be created", async () => {
    mockMkdirSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    const runner = makeRunner({ id: "river" });
    await expect(runner.send("hello")).rejects.toThrow(/EACCES/);
  });
```

- [ ] **Step 3:** Add a test for Playwright per-agent flags. Put it in the existing `describe("AgentRunner.buildMcpServers (via send)")` block — find a sensible insertion point near the other server-specific tests.

```typescript
  it("scopes Playwright MCP output-dir and user-data-dir per agent", async () => {
    const { config } = await import("../config.js");
    const orig = config.browser.cdpEndpoint;
    (config.browser as any).cdpEndpoint = "http://127.0.0.1:9222";
    try {
      const runner = new AgentRunner(
        makeAgentConfig({ id: "river", coreServers: ["browser"] }),
        memoryManager as any,
      );
      await runner.send("hello");
      const servers = getCapturedServers();
      expect(servers).toHaveProperty("browser");
      const args: string[] = servers.browser.args;
      const outIdx = args.indexOf("--output-dir");
      const udIdx = args.indexOf("--user-data-dir");
      expect(outIdx).toBeGreaterThan(-1);
      expect(udIdx).toBeGreaterThan(-1);
      expect(args[outIdx + 1]).toMatch(/\/agents\/river\/playwright$/);
      expect(args[udIdx + 1]).toMatch(/\/agents\/river\/playwright\/user-data$/);
    } finally {
      (config.browser as any).cdpEndpoint = orig;
    }
  });
```

- [ ] **Step 4:** Verify

Run: `npx vitest run src/agents/agent-runner.test.ts`
Expected: all tests pass (existing + 4 new).

- [ ] **Step 5:** Commit

```bash
git add src/agents/agent-runner.test.ts
git commit -m "test(agent-runner): cover default scratch cwd + playwright per-agent dirs (KPR-51)"
```

---

## Task 5: Retention config in `config.ts` + YAML example

**Files:**
- Modify: `src/config.ts` (add `retention` section to exported `config`)
- Modify: `hive.yaml.example` (document `retention:` block)

- [ ] **Step 1:** Add a `RetentionConfig` interface and the `retention` block to the exported `config`. Insert the interface near the existing `RegistryConfig` / `SmsLine` interface cluster (~line 66-83); add the `retention:` key in the `config` object (alphabetical placement near `sweeper` is fine).

Interface (add near other interface exports in `config.ts`):

```typescript
export interface RetentionPathConfig {
  /** Number of days to keep files. `0` means keep forever. Negative values are rejected. */
  days: number;
}

export interface RetentionConfig {
  /** When false, sweeper logs + reports candidates but does not delete (ship as false). */
  enabled: boolean;
  /** Interval between sweeps. Defaults to 7 days. */
  intervalMs: number;
  /** Fallback retention for any path not in `paths`. */
  defaultDays: number;
  /** Per-path retention. Keys are glob-like strings relative to hiveHome (e.g. "agents/*\/scratch"). */
  paths: Record<string, RetentionPathConfig>;
}
```

Block inside `config` (add after the `sweeper: { ... }` object):

```typescript
  retention: {
    enabled: Boolean(hive.retention?.enabled ?? false),
    intervalMs: parseInt(
      optional("RETENTION_INTERVAL_MS", String(hive.retention?.intervalMs ?? 7 * 24 * 3600_000)),
      10,
    ),
    defaultDays: Number(hive.retention?.defaults?.days ?? 7),
    paths: ((hive.retention?.paths ?? {
      data: 7,
      "agents/*/scratch": 7,
      "agents/*/feeds": 7,
      "agents/*/playwright": 3,
      "agents/*/reports": 0,
      logs: 30,
    }) as Record<string, number>) as unknown as Record<string, RetentionPathConfig>,
  } as RetentionConfig,
```

Note: the YAML shape `paths: { foo: 7 }` gives us `Record<string, number>`. The retention module will normalize to `{ days: number }` at load time (next task). Keeping the config layer thin — no schema massaging here.

Actually let me simplify this — normalize at the config layer so the rest of the codebase deals with a single shape:

Replace the above `retention:` block with:

```typescript
  retention: (() => {
    const yamlPaths = (hive.retention?.paths ?? {
      data: 7,
      "agents/*/scratch": 7,
      "agents/*/feeds": 7,
      "agents/*/playwright": 3,
      "agents/*/reports": 0,
      logs: 30,
    }) as Record<string, number>;
    const paths: Record<string, RetentionPathConfig> = {};
    for (const [k, v] of Object.entries(yamlPaths)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`Invalid retention.paths.${k}: must be a non-negative integer (got ${v})`);
      }
      paths[k] = { days: v };
    }
    const defaultDays = Number(hive.retention?.defaults?.days ?? 7);
    if (!Number.isFinite(defaultDays) || defaultDays < 0) {
      throw new Error(`Invalid retention.defaults.days: ${defaultDays}`);
    }
    return {
      enabled: Boolean(hive.retention?.enabled ?? false),
      intervalMs: parseInt(
        optional("RETENTION_INTERVAL_MS", String(hive.retention?.intervalMs ?? 7 * 24 * 3600_000)),
        10,
      ),
      defaultDays,
      paths,
    } satisfies RetentionConfig;
  })(),
```

- [ ] **Step 2:** Append a commented `retention:` block to `hive.yaml.example`.

Add to the end of `hive.yaml.example`:

```yaml

# Retention policy — age-based sweep of agent scratch/feeds/playwright and pipeline data dirs.
# Ships in dry-run mode by default: the sweeper reports what it would delete to the
# Slack audit channel, but does not delete until `enabled: true`.
# retention:
#   enabled: false
#   intervalMs: 604800000   # 7 days
#   defaults:
#     days: 7
#   paths:
#     data: 7
#     "agents/*/scratch": 7
#     "agents/*/feeds": 7
#     "agents/*/playwright": 3
#     "agents/*/reports": 0   # 0 = keep forever
#     logs: 30
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit -p .`
Expected: exits 0.

Run: `npx vitest run src/config.test.ts`
Expected: passes (no new config assertions yet; we're only checking the existing suite still loads).

- [ ] **Step 4:** Commit

```bash
git add src/config.ts hive.yaml.example
git commit -m "feat(config): add retention block (defaults dry-run) (KPR-51)"
```

---

## Task 6: Retention sweeper module

**Files:**
- Create: `src/retention/retention-sweeper.ts`
- Create: `src/retention/retention-sweeper.test.ts`

- [ ] **Step 1:** Create `src/retention/retention-sweeper.ts`.

```typescript
import { readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createLogger } from "../logging/logger.js";
import type { RetentionConfig } from "../config.js";

const log = createLogger("retention");

export interface RetentionCandidate {
  path: string;
  /** Which configured path rule matched (e.g. "agents/*\/scratch"). */
  rule: string;
  /** Effective retention days (after `.retention-days` override, if any). */
  days: number;
  /** mtime of the file/dir. */
  mtime: Date;
  /** Age in days at sweep time. */
  ageDays: number;
}

export interface RetentionReport {
  sweptAt: Date;
  dryRun: boolean;
  candidates: RetentionCandidate[];
  deleted: RetentionCandidate[];
  errors: { path: string; error: string }[];
}

export interface RetentionSweeperDeps {
  /** Hive home to resolve rule paths against. */
  hiveHome: string;
  /** Posts the dry-run/enforcement summary somewhere the operator can see (usually Slack). */
  report: (text: string) => Promise<void> | void;
}

/**
 * Walks configured paths, deletes age-over files (or reports them in dry-run mode),
 * and emits a summary via the injected `report` callback.
 *
 * Design notes (see 2026-04-21-per-agent-cwd-design.md):
 * - `.retention-days` dotfile in any directory overrides the configured rule for that
 *   subtree. Integer only; negative/NaN falls back to rule default with a log warning.
 * - `days: 0` means "keep forever" — per spec §Retention Policy, not "delete everything".
 * - mtime-only for Phase 1. atime-skip is listed under Runtime Failure Mode 3 as a
 *   future hardening; not implemented here because atime is unreliable across filesystems.
 */
export class RetentionSweeper {
  private config: RetentionConfig;
  private deps: RetentionSweeperDeps;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RetentionConfig, deps: RetentionSweeperDeps) {
    this.config = config;
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => log.error("Retention sweep failed", { error: String(err) }));
    }, this.config.intervalMs);
    log.info("Retention sweeper started", {
      intervalMs: this.config.intervalMs,
      enabled: this.config.enabled,
      rules: Object.keys(this.config.paths).length,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Retention sweeper stopped");
  }

  /** Runs one sweep pass. Public so tests and ops triggers can invoke directly. */
  async sweep(): Promise<RetentionReport> {
    const sweptAt = new Date();
    const candidates: RetentionCandidate[] = [];
    const deleted: RetentionCandidate[] = [];
    const errors: { path: string; error: string }[] = [];

    for (const [rule, cfg] of Object.entries(this.config.paths)) {
      if (cfg.days === 0) continue; // keep forever
      for (const root of expandRule(this.deps.hiveHome, rule)) {
        try {
          collectCandidates(root, rule, cfg.days, sweptAt, candidates);
        } catch (err) {
          errors.push({ path: root, error: String(err) });
        }
      }
    }

    if (this.config.enabled) {
      for (const c of candidates) {
        try {
          rmSync(c.path, { recursive: true, force: true });
          deleted.push(c);
        } catch (err) {
          errors.push({ path: c.path, error: String(err) });
        }
      }
    }

    const report: RetentionReport = {
      sweptAt,
      dryRun: !this.config.enabled,
      candidates,
      deleted,
      errors,
    };

    try {
      await this.deps.report(formatReport(report));
    } catch (err) {
      log.warn("Retention report delivery failed", { error: String(err) });
    }

    return report;
  }
}

/**
 * Expand a rule string into concrete absolute roots under hiveHome.
 * Supports exactly one `*` segment (e.g. `agents/*\/scratch` → every agent's scratch).
 * Phase 1 deliberately does not support arbitrary globbing — if you need deeper matching,
 * write a second rule. Keeping the matcher simple keeps the blast radius small.
 */
export function expandRule(hiveHome: string, rule: string): string[] {
  const segments = rule.split("/");
  const starIdx = segments.indexOf("*");
  if (starIdx === -1) {
    const full = resolve(hiveHome, rule);
    return existsSync(full) ? [full] : [];
  }
  if (segments.indexOf("*", starIdx + 1) !== -1) {
    throw new Error(`Retention rules support at most one '*' segment: ${rule}`);
  }
  const prefix = segments.slice(0, starIdx).join(sep);
  const suffix = segments.slice(starIdx + 1).join(sep);
  const parent = resolve(hiveHome, prefix);
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(parent, e.name, suffix))
    .filter((p) => existsSync(p));
}

function collectCandidates(
  root: string,
  rule: string,
  defaultDays: number,
  now: Date,
  out: RetentionCandidate[],
): void {
  const effectiveDays = readRetentionOverride(root) ?? defaultDays;
  if (effectiveDays === 0) return; // override says keep forever
  const cutoff = now.getTime() - effectiveDays * 86400_000;

  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".retention-days") continue;
    const full = join(root, entry.name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs <= cutoff) {
      out.push({
        path: full,
        rule,
        days: effectiveDays,
        mtime: st.mtime,
        ageDays: (now.getTime() - st.mtimeMs) / 86400_000,
      });
    }
  }
}

function readRetentionOverride(dir: string): number | null {
  const path = join(dir, ".retention-days");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    log.warn("Invalid .retention-days override — ignoring", { path, raw });
    return null;
  }
  return n;
}

function formatReport(r: RetentionReport): string {
  const verb = r.dryRun ? "would delete" : "deleted";
  const lines = [
    `*Retention sweep* (${r.dryRun ? "dry-run" : "enforced"}) @ ${r.sweptAt.toISOString()}`,
    `${r.candidates.length} candidates · ${verb} ${r.dryRun ? r.candidates.length : r.deleted.length} · ${r.errors.length} errors`,
  ];
  const sample = r.candidates.slice(0, 10);
  if (sample.length) {
    lines.push("```");
    for (const c of sample) {
      lines.push(`${c.path}  (age ${c.ageDays.toFixed(1)}d, rule ${c.rule}@${c.days}d)`);
    }
    if (r.candidates.length > sample.length) {
      lines.push(`… and ${r.candidates.length - sample.length} more`);
    }
    lines.push("```");
  }
  if (r.errors.length) {
    lines.push(`Errors: ${r.errors.slice(0, 3).map((e) => `${e.path}: ${e.error}`).join(" | ")}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 2:** Create `src/retention/retention-sweeper.test.ts`.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { RetentionSweeper, expandRule } from "./retention-sweeper.js";
import type { RetentionConfig } from "../config.js";

function makeHive(): string {
  const root = resolve(tmpdir(), `hive-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function touch(path: string, ageDays: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const now = Date.now();
  const t = (now - ageDays * 86400_000) / 1000;
  utimesSync(path, t, t);
}

function baseCfg(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    enabled: false,
    intervalMs: 60_000,
    defaultDays: 7,
    paths: {},
    ...overrides,
  };
}

describe("expandRule", () => {
  let hive: string;
  beforeEach(() => {
    hive = makeHive();
  });
  afterEach(() => rmSync(hive, { recursive: true, force: true }));

  it("resolves a static rule to a single absolute path", () => {
    mkdirSync(join(hive, "data"), { recursive: true });
    expect(expandRule(hive, "data")).toEqual([join(hive, "data")]);
  });

  it("expands a single-star rule across direct children", () => {
    mkdirSync(join(hive, "agents", "milo", "scratch"), { recursive: true });
    mkdirSync(join(hive, "agents", "river", "scratch"), { recursive: true });
    mkdirSync(join(hive, "agents", "jasper", "workshop"), { recursive: true });
    const expanded = expandRule(hive, "agents/*/scratch").sort();
    expect(expanded).toEqual([
      join(hive, "agents", "milo", "scratch"),
      join(hive, "agents", "river", "scratch"),
    ]);
  });

  it("returns empty when parent doesn't exist", () => {
    expect(expandRule(hive, "missing/*/scratch")).toEqual([]);
  });

  it("rejects rules with more than one star", () => {
    expect(() => expandRule(hive, "agents/*/foo/*")).toThrow(/at most one/);
  });
});

describe("RetentionSweeper.sweep", () => {
  let hive: string;
  let report: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hive = makeHive();
    report = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => rmSync(hive, { recursive: true, force: true }));

  it("reports age-over candidates in dry-run mode without deleting", async () => {
    touch(join(hive, "data", "old.csv"), 10);
    touch(join(hive, "data", "new.csv"), 1);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.dryRun).toBe(true);
    expect(r.candidates.map((c) => c.path)).toEqual([join(hive, "data", "old.csv")]);
    expect(r.deleted).toEqual([]);
    expect(existsSync(join(hive, "data", "old.csv"))).toBe(true);
    expect(report).toHaveBeenCalledOnce();
  });

  it("deletes candidates when enabled", async () => {
    touch(join(hive, "data", "old.csv"), 10);
    const sweeper = new RetentionSweeper(
      baseCfg({ enabled: true, paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.deleted.map((c) => c.path)).toEqual([join(hive, "data", "old.csv")]);
    expect(existsSync(join(hive, "data", "old.csv"))).toBe(false);
  });

  it("honors .retention-days override in a target directory", async () => {
    mkdirSync(join(hive, "data"), { recursive: true });
    writeFileSync(join(hive, "data", ".retention-days"), "30\n");
    touch(join(hive, "data", "old.csv"), 10); // 10 < 30, so NOT a candidate
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates).toEqual([]);
  });

  it("skips rules with days=0 (keep forever)", async () => {
    touch(join(hive, "agents", "milo", "reports", "standup.md"), 365);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { "agents/*/reports": { days: 0 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates).toEqual([]);
  });

  it("expands star rules into per-agent roots", async () => {
    touch(join(hive, "agents", "milo", "scratch", "old.txt"), 10);
    touch(join(hive, "agents", "river", "scratch", "old.txt"), 10);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { "agents/*/scratch": { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates.map((c) => c.path).sort()).toEqual([
      join(hive, "agents", "milo", "scratch", "old.txt"),
      join(hive, "agents", "river", "scratch", "old.txt"),
    ]);
  });

  it("ignores invalid .retention-days content and falls back to rule default", async () => {
    mkdirSync(join(hive, "data"), { recursive: true });
    writeFileSync(join(hive, "data", ".retention-days"), "not-a-number");
    touch(join(hive, "data", "old.csv"), 10);
    const sweeper = new RetentionSweeper(
      baseCfg({ paths: { data: { days: 7 } } }),
      { hiveHome: hive, report },
    );
    const r = await sweeper.sweep();
    expect(r.candidates.map((c) => c.path)).toEqual([join(hive, "data", "old.csv")]);
  });
});
```

- [ ] **Step 3:** Verify

Run: `npx vitest run src/retention/retention-sweeper.test.ts`
Expected: all 10 tests pass.

Run: `npx tsc --noEmit -p .`
Expected: exits 0.

- [ ] **Step 4:** Commit

```bash
git add src/retention/retention-sweeper.ts src/retention/retention-sweeper.test.ts
git commit -m "feat(retention): add dry-run retention sweeper with .retention-days overrides (KPR-51)"
```

---

## Task 7: Wire retention sweeper into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

The sweeper needs a `report(text)` callback to post to Slack. Reuse the Slack gateway and the already-resolved `fallbackId` (audit channel) — if no audit channel is configured, fall back to logging only.

- [ ] **Step 1:** Add the import near the other retention/sweeper imports (~line 27 block).

Find:

```typescript
import { Sweeper } from "./sweeper/sweeper.js";
```

Add immediately after:

```typescript
import { RetentionSweeper } from "./retention/retention-sweeper.js";
```

- [ ] **Step 2:** Promote `fallbackId` so it's visible outside the audit-channel try/catch.

Find (around line 300):

```typescript
    const fallbackName = config.slack.auditChannel;
    const fallbackId = fallbackName ? channelIdByName.get(fallbackName) : undefined;
    dispatcher.setAuditChannel(slackAdapter, channelIdByName, fallbackId);
```

Replace with:

```typescript
    const fallbackName = config.slack.auditChannel;
    fallbackAuditId = fallbackName ? channelIdByName.get(fallbackName) : undefined;
    dispatcher.setAuditChannel(slackAdapter, channelIdByName, fallbackAuditId);
```

And declare `fallbackAuditId` before the `try` (search upward to the outer scope — add it right before `const channelIdByName = new Map<string, string>();` around line 286):

```typescript
  let fallbackAuditId: string | undefined;
  const channelIdByName = new Map<string, string>();
```

- [ ] **Step 3:** Declare the sweeper variable in the outer scope (near `let scheduler: Scheduler;` around line 74) so `shutdown` can reach it.

Find:

```typescript
  let scheduler: Scheduler;
```

Add:

```typescript
  let retentionSweeper: RetentionSweeper | undefined;
```

- [ ] **Step 4:** Instantiate + start the retention sweeper after the existing `sweeper.start()` (around line 503).

Find:

```typescript
  sweeper.start();
  log.info("Sweeper started", { intervalMs: config.sweeper.intervalMs });
```

Add immediately after:

```typescript
  // Retention sweeper — deletes (or dry-runs) age-over files under agents/*, data/, logs/.
  // Ships in dry-run mode (enabled: false) until operator flips the flag after a week of
  // dry-run Slack reports prove the candidate list is sane. See KPR-51 design spec.
  retentionSweeper = new RetentionSweeper(config.retention, {
    hiveHome,
    report: async (text) => {
      if (fallbackAuditId) {
        await slack.postMessage(fallbackAuditId, text).catch((err) =>
          log.warn("Retention report: Slack post failed", { error: String(err) }),
        );
      } else {
        log.info("Retention report (no audit channel configured)", { text });
      }
    },
  });
  retentionSweeper.start();
  log.info("Retention sweeper started", {
    enabled: config.retention.enabled,
    intervalMs: config.retention.intervalMs,
  });
```

- [ ] **Step 5:** Stop the sweeper in `shutdown` (around line 508).

Find:

```typescript
    sweeper.stop();
```

Add immediately after:

```typescript
    retentionSweeper?.stop();
```

- [ ] **Step 6:** Ensure `hiveHome` is imported into `index.ts`. Check for an existing `import { ... } from "./paths.js"` line; if `hiveHome` isn't in it, add it.

Run: `grep -n 'from "./paths.js"' src/index.ts`
If `hiveHome` isn't imported, add `hiveHome` to that import.

- [ ] **Step 7:** Verify

Run: `npx tsc --noEmit -p .`
Expected: exits 0.

Run: `npm run build`
Expected: builds without error.

- [ ] **Step 8:** Commit

```bash
git add src/index.ts
git commit -m "feat(startup): wire retention sweeper with Slack dry-run reporting (KPR-51)"
```

---

## Task 8: Gitignore + hive.yaml.example cleanup

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1:** Update `.gitignore` to cover the new instance sibling dirs.

Find:

```
# Instance-specific (generated by setup wizard)
hive.yaml
beekeeper.yaml
/plugins/claude-code/
logs/
.hive-generated.json
.hive/
```

Replace with:

```
# Instance-specific (generated by setup wizard)
hive.yaml
beekeeper.yaml
/plugins/
logs/
.hive-generated.json
.hive/

# Instance sibling namespaces (KPR-51 / Phase 1 of KPR-50)
/agents/
/workflow/
/data/
```

Note: `/plugins/` broadens from `/plugins/claude-code/` to also cover instance-authored plugins (per spec §Sibling instance namespaces). The old engine-plugins path is a strict subset.

- [ ] **Step 2:** Verify

Run: `git status --ignored | head -20`
Expected: no tracked files get newly ignored; untracked `/agents/`, `/workflow/`, `/data/` (if any exist) show as ignored.

Run: `git check-ignore -v agents/ workflow/ data/ plugins/claude-code/test`
Expected: each path prints a matching rule line.

- [ ] **Step 3:** Commit

```bash
git add .gitignore
git commit -m "chore(gitignore): ignore agents/workflow/data and broaden plugins (KPR-51)"
```

---

## Task 9: Full check + acceptance

- [ ] **Step 1:** Run the full quality gate.

Run: `npm run check`
Expected: typecheck + lint + format + test all pass.

If Prettier objects to anything, run `npm run format` and commit the formatting-only diff as `style: prettier (KPR-51)`.

- [ ] **Step 2:** Manual acceptance via dev run (optional but strongly recommended before PR).

Start dev: `npm run dev`

In a separate terminal, post a simple message to Milo's channel (or any non-archetype agent channel) via Slack. After the agent responds, check:

```bash
ls ~/github/hive-kpr-50/agents/milo/scratch/     # scratch exists, may be empty
git -C ~/github/hive-kpr-50 status                # stays clean at instance root
```

If you can trigger a Playwright scrape:

```bash
ls ~/github/hive-kpr-50/agents/<agent>/playwright/
# expect: user-data/, possibly trace/screenshot artifacts. No top-level .playwright-mcp/.
```

Expected outcomes (per spec §Acceptance):
- Agent-written files under `agents/<id>/scratch/`, not instance root.
- `git status` clean at instance root after a session.
- Playwright artifacts scoped to `agents/<id>/playwright/`; no `.playwright-mcp/` at root.
- Jasper (software-engineer archetype) still cwds to configured workshop.
- Retention sweeper emits dry-run Slack summary on first fire (7-day interval by default; for manual verification, set `RETENTION_INTERVAL_MS=60000` env + touch an old file under `data/`).
- `hive.yaml` without a `retention:` block still parses (defaults kick in).

- [ ] **Step 3:** Push + open PR.

```bash
git push -u origin kpr-51
gh pr create --title "feat: per-agent cwd + instance sibling dirs (KPR-51)" --body "$(cat <<'EOF'
## Summary
- Default session cwd becomes `<hive>/agents/<id>/scratch/` for every business agent; archetype-provided cwd still wins.
- Playwright MCP gets per-agent `--output-dir` and `--user-data-dir`, keeping `.playwright-mcp/` out of HIVE_HOME.
- New retention sweeper (`src/retention/`) walks `agents/*/scratch`, `agents/*/feeds`, `agents/*/playwright`, `data/`, `logs/` and reports age-over candidates to the Slack audit channel. Ships in dry-run mode (`enabled: false`).
- `.gitignore` reserves the new sibling dirs (`agents/`, `workflow/`, `data/`, `plugins/`) so instance roots stop dirtying their git index.

Phase 1 of [KPR-50](https://linear.app/keepur/issue/KPR-50) (v0.2.0 instance dir restructure). No engine move yet; deploy flow untouched.

## Test plan
- [ ] `npm run check` green locally
- [ ] Post a message to Milo/River/Jessica/Wyatt; confirm writes land in `agents/<id>/scratch/`
- [ ] `git status` at instance root stays clean after an agent session
- [ ] Playwright scrape from River: artifacts in `agents/river/playwright/`, no `.playwright-mcp/` at root
- [ ] Jasper (software-engineer archetype) unchanged — cwd is configured workshop
- [ ] Retention sweeper dry-run report appears in Slack audit channel (verified with shortened `RETENTION_INTERVAL_MS`)
EOF
)"
```

---

## Out-of-scope reminders

If any of these come up during execution, stop and note them — they are explicitly deferred:

- Moving `software-engineer`'s default workshop under `agents/<id>/workshop/` — Phase 5 data migration.
- Passing `cwd` to `background-task` or `code-task` MCP servers automatically — Phase 4 docs.
- Migrating the existing ~55 loose files from the dodi instance root — Phase 5.
- Renaming `workshop` → `workbench` — explicitly rejected in epic §Out of scope.
- Flipping `retention.enabled: true` in any real instance — operator task after the week-long dry-run validation window.
