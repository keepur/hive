# Per-Agent cwd + Instance Sibling Namespaces — Design Spec

**Date**: 2026-04-21
**Ticket**: [KPR-51](https://linear.app/keepur/issue/KPR-51) (Phase 1 of [KPR-50](https://linear.app/keepur/issue/KPR-50) — Instance dir restructure, v0.2.0)
**Status**: Draft

## Problem

Every business agent in a running Hive instance writes into `HIVE_HOME` — the instance root that currently triples as git clone, build dir, and runtime. On the dodi instance today this has produced ~55 loose files at the root (social-media scrapes, ad-hoc `.ts` scripts, standups, CSVs, summaries) plus a 21MB `.playwright-mcp/` dir full of console logs.

Root cause: `src/agents/agent-runner.ts` only sets the SDK session `cwd` when the agent's archetype returns one (line 1153, `...(archetypeExtra.cwd ? { cwd: archetypeExtra.cwd } : {})`). Only the `software-engineer` archetype does this. Every other agent — Milo, River, Jessica, Wyatt, Rae, Chloe, Colt, etc. — inherits the Hive Node process cwd, which is `HIVE_HOME`. Any `Bash`, `Write`, or `Edit` that uses a relative path lands at the instance root.

Additionally, the stdio MCP subprocess for `@playwright/mcp` writes its browser profile and snapshot artifacts (`.playwright-mcp/`, screenshots, traces) relative to its own working directory. The SDK's `McpStdioServerConfig` type (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:878`) accepts only `type`, `command`, `args`, `env` — no `cwd` field — so the Playwright subprocess inherits the Hive Node cwd and dumps into `HIVE_HOME/.playwright-mcp/`.

## Goal

Purely additive change: stop new agent writes from landing at `HIVE_HOME`. No engine move yet (that's Phase 2). After this ships, a day of agent activity must not dirty the instance root — `git status` at the instance root stays clean through a full agent session.

Non-goal: migrating the existing pollution. That's Phase 5.

## Design

### Per-agent cwd default

`agent-runner.ts` computes a single `effectiveCwd` for every session before the SDK `query()` call:

```
effectiveCwd =
  archetypeExtra.cwd                              // archetype-provided (software-engineer today)
  ?? <hiveHome>/agents/<agentId>/scratch/         // business-agent fallback
```

Sequencing at the call site (currently line 1100-1153):

1. Compute `archetypeExtra` as today.
2. Compute `effectiveCwd` per the rule above, and remember which branch fired (`source: "archetype" | "default"`).
3. If `source === "default"`: `mkdirSync(effectiveCwd, { recursive: true })`. A mkdir failure here is the real error surface (permissions, read-only fs) and should propagate — do not fall through to step 4.
4. Run the existence/`isDirectory()` check at line 1121 against `effectiveCwd` only when `source === "archetype"`. The archetype path must exist before we start a session (Jasper's workshop is operator-configured — a missing dir there is a misconfig and we want a loud throw). The default path is covered by step 3's mkdir, so the check is redundant for it and would only re-report a mkdir failure as a confusing "cwd is not a directory".
5. Pass `cwd: effectiveCwd` to the SDK options (no more conditional spread).

The existing guard (`if (typeof archetypeExtra.cwd === "string")`) is removed because the post-resolution cwd is always a string — but the fail-loud check it gated stays, now gated by `source === "archetype"` instead.

**Why per-agent, not per-thread.** Agents already queue serially on a single thread (the per-thread-serialization invariant in `agent-manager.ts`), and parallel work across agents goes through separate `agent_id`s anyway. Per-agent dirs are discoverable and human-readable; per-thread dirs would carve by ephemeral IDs and defeat the "Milo wants to re-read yesterday's standup" use case. If per-thread scoping becomes necessary later, it can be nested under `agents/<id>/threads/<thread_id>/` without breaking this contract.

**Why no env var, no yaml field.** The path is derived from `hiveHome` (already resolved in `src/paths.ts`) and `agentConfig.id` (already required). Adding a `hive.yaml` field or `AGENTS_HOME` env var is ceremony that doesn't buy configurability the user actually needs. Layout convention beats configuration here.

### Playwright MCP output scoping

Since the SDK's `McpStdioServerConfig` has no `cwd` field, we can't redirect the Playwright subprocess via its cwd. Instead we pass per-agent output paths directly as CLI flags to `@playwright/mcp` (verified against `npx @playwright/mcp --help`):

```ts
// agent-runner.ts around line 520
const agentPlaywrightDir = resolve(hiveHome, "agents", this.agentConfig.id, "playwright");
mkdirSync(agentPlaywrightDir, { recursive: true });
servers["browser"] = {
  type: "stdio",
  command: "npx",
  args: [
    "@playwright/mcp@latest",
    "--cdp-endpoint", config.browser.cdpEndpoint,
    "--output-dir", agentPlaywrightDir,
    "--user-data-dir", resolve(agentPlaywrightDir, "user-data"),
  ],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
};
```

`--output-dir` scopes snapshots, traces, and screenshots. `--user-data-dir` scopes the browser profile (cookies, storage) per agent, which also prevents agents from leaking session state into each other's browsers. This is stricter than the today-behavior (single shared temp profile), and is a deliberate correctness improvement — but it's additive, not a breaking change, since agents don't rely on the Playwright MCP preserving profile state across sessions today.

This keeps CDP console-log spillover (`.playwright-mcp/`, screenshots, traces) out of `HIVE_HOME` and scoped to the agent namespace.

### Sibling instance namespaces

Create the following top-level dirs inside each instance, alongside `agents/`:

| Dir | Purpose | Gitignore? | Authored by |
|-----|---------|------------|-------------|
| `agents/` | Per-agent home — `<id>/{scratch,reports,feeds,playwright}` | Yes | Agents at runtime |
| `workflow/` | Instance-authored flows (future) | Yes | Operator/agents |
| `data/` | Pipeline dump ground — transient scratch for ingest/embed jobs | Yes | Pipelines |
| `skills/` | Instance-authored skills | Already gitignored via `/skills/` | Operator |
| `plugins/` | Instance-authored plugins (business-specific MCP servers the instance develops) | Yes | Operator |

`plugins/` is instance-authored — distinct from `plugins/claude-code/` which ships inside the engine. After Phase 2, engine plugins live at `.hive/plugins/`; for Phase 1 the engine's `plugins/claude-code/` stays where it is (already gitignored in the deploy dir).

Phase 1 does not populate `workflow/`, `data/`, `skills/`, or `plugins/` — it just reserves the names by gitignoring them. Agents that need transient scratch keep using `agents/<id>/scratch/`.

### Per-agent subdirs

Created on first use (lazy `mkdirSync`), never pre-created during setup:

| Subdir | Purpose | Who creates |
|--------|---------|-------------|
| `scratch/` | Default cwd — ad-hoc files, throwaway work | agent-runner on session start |
| `reports/` | Standups, CSVs, deliverables — anything the agent wants to keep | Agent code (agents author here deliberately) |
| `feeds/` | Browser scrapes — transient | Agent code |
| `playwright/` | Browser profile / CDP artifacts | agent-runner (browser MCP spawn) |
| `workshop/` | Software-engineer archetype only | Not in Phase 1 — archetype still uses configured `workshop` path |

Only `scratch/` and `playwright/` are created by agent-runner. `reports/` and `feeds/` are agent conventions documented in agent system prompts (covered by Phase 4 doc refresh); agents can mkdir on first write.

### Software-engineer archetype in Phase 1

**Unchanged.** Jasper's `workshop` config stays pointing wherever it points today (`~/github/hive` or similar). The archetype's `sessionOptions()` still returns `cwd: workshop`, priority rule 1 still matches, no behavioral change.

Relocating the default workshop to `<instance>/agents/<id>/workshop/` is done at the agent-definition level (seed templates + the Phase 5 migration script), not in Phase 1 code. See Phase 5 for the migration. Phase 1 only creates the *infrastructure* for per-agent dirs — switching the software-engineer archetype's default workshop is a data migration, not a code change.

### Retention policy

Hive accumulates transient data fast — one week of `.playwright-mcp/` bloat on dodi is 21MB; pipeline `data/` runs could dwarf that. Retention ships *in Phase 1* because without it the new dirs start rotting on day 1.

Shape:

```yaml
# hive.yaml
retention:
  enabled: false           # dry-run only on rollout; operator flips to true after a week
  defaults:
    days: 7                # fallback for any path not listed below
  paths:
    data: 7
    "agents/*/scratch": 7
    "agents/*/feeds": 7
    "agents/*/playwright": 3
    "agents/*/reports": 0  # 0 = keep forever
    logs: 30
```

Per-subdir override: any dir may contain a `.retention-days` dotfile with a single integer — that wins over `hive.yaml` for that dir and its children.

Enforcement: a scheduled `hive` task (not cron — uses the in-engine scheduler) runs weekly. When `retention.enabled: false`, it reports what it *would* delete via Slack DM to the beekeeper channel. When `enabled: true`, it `rm -rf`s age-over files older than `mtime + days`.

**Rollout**: Phase 1 ships with `enabled: false`. The scheduler task fires, emits a dry-run report, and we leave it like that for a full week before any operator flips the flag. This is load-bearing — a mis-configured retention policy on day 1 could delete in-flight standups.

### What the agent sees

The agent's system-prompt card does not need to enumerate every new dir (that's noise). Agents discover their scratch dir by using relative paths — the SDK gives them `pwd` via their cwd. Documentation changes are scoped to:

- Agent seed definitions: the one-line "your working dir is ..." that currently reads as `HIVE_HOME` now naturally becomes `agents/<your-id>/scratch` because that's what `pwd` reports.
- No prompt-card changes for the `software-engineer` archetype (still workshop-based).

## Files touched

### Code

- `src/agents/agent-runner.ts` — default cwd resolution around line 1100-1153; browser MCP spawn cwd around line 520-530.
- `src/paths.ts` — add `agentsDir(hiveHome)` and `agentScratchDir(hiveHome, agentId)` helpers; keep them pure (no I/O).
- `src/retention/` (new) — `retention-config.ts` (parses `retention:` block), `retention-sweeper.ts` (walks paths, reports or deletes). Scheduler registration wires into the existing scheduler entry point.
- `src/config.ts` — parse the `retention:` block into typed config (with defaults when absent).

### Config / ignore

- `.gitignore` additions under the deploy dir: `/agents/`, `/workflow/`, `/data/`, `/plugins/`. (Current engine repo `.gitignore` also gets these since some dev users run agents out of `~/github/hive`.)
- `hive.yaml.example` — document the `retention:` block with commented defaults.

### Tests

- `src/agents/agent-runner.test.ts` — new tests: business agent (no archetype) gets `<hiveHome>/agents/<id>/scratch/` as cwd; software-engineer archetype cwd still wins when set; scratch dir is created on demand.
- `src/retention/retention-sweeper.test.ts` — new tests: age filter, `.retention-days` override, dry-run mode emits report without deleting.

### Not touched in Phase 1

- `src/archetypes/software-engineer/*` — no code changes. Workshop default in agent definitions is a Phase 5 concern.
- `src/code-task/code-task-mcp-server.ts` — `code_task`'s `cwd` tool argument is required (`z.string()` at line 84, no default). The caller (Jasper, today) always provides an absolute path derived from his workshop. Since Phase 1 leaves Jasper's workshop unchanged, the `code_task` call sites don't move. No server-side changes.
- `src/background/background-task-mcp-server.ts` — `cwd` tool argument is optional; the server resolves it to `body.cwd ?? process.env.HOME ?? "/tmp"` (`background-task-manager.ts:227`). Not affected by the session cwd default — a tool call without an explicit `cwd` still lands under `$HOME`, not the agent's scratch dir. If an agent wants background-task output scoped to their scratch dir, they must pass `cwd: "<abs>/agents/<id>/scratch/"` (or a relative path, which resolves against `$HOME` — the wrong base) explicitly. Prompt-card guidance for this is covered by Phase 4 docs; no server-side change in Phase 1.

## Runtime failure modes

1. **Agent has no `id`.** Can't happen — agent loading rejects without one. The cwd resolver would throw, but it's unreachable.
2. **`hiveHome` is read-only.** Install path error, surfaces at startup (mkdir fails loud). Same class as existing `logs/` failures.
3. **Retention sweep deletes an in-flight file.** Mitigated by the `enabled: false` default + week-long dry-run period. Long term: sweeper checks mtime *and* atime, and skips paths where either is within the retention window.
4. **Operator mis-sets `days: 0` meaning "delete everything".** Config validator treats `0` as "keep forever" (documented). Negative values rejected at parse.

## Acceptance

- Start dodi instance, post a message to Milo, River, Jessica, and Wyatt in their respective channels. For each agent, any file they write via `Bash`/`Write`/`Edit` with a relative path lands in `<instance>/agents/<agent_id>/scratch/`, not at `<instance>/`.
- `git status` at the instance root (while it's still a git clone — Phase 3 removes that) stays clean after an hour of agent activity.
- Trigger a Playwright scrape from River. `<instance>/.playwright-mcp/` is not created; artifacts land in `agents/river/playwright/`.
- Start Jasper (software-engineer archetype). Jasper's cwd is the configured workshop, unchanged from today.
- Retention sweeper runs on its schedule. With `enabled: false`, it posts a dry-run report to the beekeeper Slack channel. With `enabled: true` and a seeded old file, it deletes the old file and leaves in-window files alone.
- `hive.yaml.example` documents the new `retention:` block; real instance `hive.yaml` files without a `retention:` block still parse (defaults apply).

## Open questions

None. AGENTS_HOME resolution settled on layout convention (no env var, no yaml field). Cwd scope settled on per-agent. Retention ships with Phase 1 in dry-run-only mode.
