# Software-Engineer Archetype — Design Spec

**Date**: 2026-04-09
**Status**: Draft — brainstorm output, pending review
**Scope**: Epic (3 tickets: archetype plumbing, software-engineer archetype, Jasper migration)

## Problem

Hive's target customer is an exec who wants a delegate responsible for **system design and codebase ownership**. Today's closest approximation is Jasper (VP Engineering), whose workflow is:

1. Read a ticket
2. Create a worktree
3. Spawn a `code_task` inner Claude Code session pointing at the worktree
4. Wait for the session to implement, review, PR, merge

That works *once the ticket exists*. It breaks down upstream of the ticket — during the phase where the exec has an idea and needs a design partner to explore it, pressure-test it, shape it, and turn it into a spec. Jasper is not that partner today:

- His working directory is Hive's process cwd (`~/github/hive`), not `~/dev/dodi_v2` — he doesn't see the codebase he's supposedly the VP of.
- `dodi_v2/CLAUDE.md` and `dodi_v2/DEVELOPMENT-PROCESS.md` are not loaded. He is told to read them in his system prompt, and sometimes does.
- `dodi_v2/.claude/settings.json` and project skills are not loaded.
- The `~/.claude/projects/-Users-mokie-dev-dodi-v2/memory/` auto-memory index — the brain a real Claude Code session at that path would inherit — is invisible to him.
- He has no delivery workflow skills (`brainstorm`, `write-plan`, `review`, `file-ticket`). His `plugins: []`.
- He can Edit and Write anywhere, including directly into `dodi_v2`, which silently defeats the design-review-implement-PR discipline.

The result: to do design work on DOD-324, the exec opens a Claude Code CLI session in `~/dev/dodi_v2` and talks to *that*, because the CLI session has all the context Jasper lacks. The Hive agent becomes a message router, not a partner.

This is a symptom of a broader gap: **Hive has no concept of a discipline-bound agent**. Every agent is a bag of MCP servers and a free-text system prompt. For roles defined by their tools and workflow — software engineer, bookkeeper, accountant — this is too loose. You can't enforce "owns a codebase and never commits directly" by writing it in prose and hoping.

## Solution

Introduce **agent archetypes** as a first-class hive concept, and ship `software-engineer` as the first archetype.

An archetype is a **discipline**, encoded in code. It defines invariants that every instance of that archetype must uphold — config shape, system-prompt framing, tool policies, memory scopes, enforcement hooks. Instances differ by *title*, *scope*, and *bolt-on capabilities*, but share the irreducible discipline core.

This spec covers two layers:

- **Layer 1 — archetype plumbing** (reusable foundation). How any archetype gets defined, loaded, enforced. The next archetype after software-engineer (bookkeeper? designer? data-analyst?) plugs into this.
- **Layer 2 — software-engineer archetype** (first instance). Workshop and workspaces, ticket-as-spec workflow, delegate-only execution inside workspaces, auto-memory bridge to Claude Code's project memory.

Jasper migrates to the archetype in a third phase and becomes the first production instance. The DOD-324 design work — which prompted this spec — becomes the validation exercise.

## Mental model

### Discipline vs title

Some roles are **disciplines** — universal, tool-bound, output-defined. A software engineer has a codebase, VCS, PRs, CI. A bookkeeper has a GL, ledgers, reconciliations. Remove the tools and the role evaporates. These are archetypes.

Other roles are **role-shapes** — they mean different things at different orgs. A "Chief of Staff" has no defining tool. These stay composition-first (soul + system prompt + MCP servers) without needing archetype status.

The archetype name is the **discipline**. The *title* is the customer-facing framing that varies by scope and seniority. One archetype, many titles:

```yaml
archetype: software-engineer   # discipline — invariant, enforced in code
title: VP Engineering          # customer-facing framing — free text
```

A Senior Engineer, Tech Lead, Staff Engineer, and the CTO of a five-person startup are all instances of the same archetype with different titles. Same for bookkeeper/controller/staff accountant in the accounting discipline.

### Workshop and workspaces

A software engineer has a **workshop** — a bounded filesystem root where they have full agency to prototype, spin up infra, write tool scripts, and experiment. `~/dev` is a natural workshop.

Inside the workshop live **workspaces** — registered codebases the engineer formally owns. Each workspace has a tracker, a CLAUDE.md, and an expectation of delivery discipline. `~/dev/dodi_v2` is a workspace.

This distinction carries real policy weight:

- **Inside the workshop, outside any workspace**: full agency. Edit, Write, Bash, git, docker — whatever the engineer needs to prototype. No ticket required, no PR required.
- **Inside a workspace**: delegate-only. Read-only from the archetype's tools. Every code change flows through `code_task`. Ticket-backed. PR-gated.

This mirrors how engineers actually work. "Don't push to main without a PR" applies in the product repo; "I'm going to try something in `~/scratch`" is obviously fine.

### Promotion lifecycle

A new idea follows this path:

1. Exec: *"I have a new idea."*
2. Engineer: creates `<workshop>/spike-<name>`. Full agency. Prototypes fast with the exec.
3. When the idea is worth formalizing, the engineer **registers it as a workspace** — wires it to a tracker, ensures CLAUDE.md exists, commits to git. From that moment forward, it's under delegate-only discipline.
4. All subsequent changes go through the ticket → `code_task` → PR flow.

The workshop is the prototyping space. Workspaces are the production space. Registration is the crossing.

### Ticket as spec

Inside a workspace, the archetype's file output is **zero**. Nothing. All work products land in one of two places:

- **Tracker** (Linear / GitHub Issues / ClickUp): specs, decisions, acceptance criteria, review comments. The filed ticket description IS the design spec — no `docs/specs/*.md` artifact in the workspace repo.
- **Workshop**: prototypes, scratch code, infra scripts. Private to the engineer.

This collapses a lot of structure. The archetype's workflow at the workspace boundary is:

1. Brainstorm in chat with the exec
2. File ticket — description IS the spec (problem, approach, acceptance criteria)
3. Delegate via `code_task`: *"work on ticket DOD-324"* — inner session fetches ticket, reads spec, implements, commits, PRs
4. Review PR (read-only access is fine)
5. Close ticket when CI green

No file lifecycle to manage. No "draft vs committed spec" split. No promotion of spec files across boundaries. The tracker is the spec's home, the repo is the code's home, and the two link naturally via ticket-PR references.

### Layering with `code_task`

The archetype sits **upstream** of `code_task`. The archetype's skill bundle is small and delivery-oriented:

- Brainstorm (conversation pattern, not a skill)
- File ticket (MCP tool on the tracker)
- Delegate (`code_task`, existing)
- Review (read PR, read CI, comment on ticket)

The *heavy* delivery skills (`write-plan`, `implement`, `submit`) live inside the `code_task` inner session — a Claude Code CLI running in the workspace with the dodi-dev plugin. Clean layering:

```
┌─────────────────────────────────────┐
│ Archetype (Hive agent)              │
│   brainstorm (conversation)         │
│   file_ticket                       │
│   code_task (delegate)              │
│   review (read PR + comment)        │
└──────────────┬──────────────────────┘
               │ code_task
               ▼
┌─────────────────────────────────────┐
│ code_task inner session             │
│ (Claude Code CLI, in workspace)     │
│   dodi-dev: write-plan              │
│   dodi-dev: implement               │
│   dodi-dev: review                  │
│   dodi-dev: submit                  │
└─────────────────────────────────────┘
```

The archetype never does what the inner session does, and vice versa. The seam is `code_task`.

## Core invariants (software-engineer)

These define what `software-engineer` *is*. They are enforced — by config validation, by hooks, or by system-prompt framing depending on the invariant. An instance that doesn't satisfy these is not a software-engineer.

1. **Workshop** — a bounded filesystem root. Required. Full agency outside workspaces; sandboxed to this root (no access outside it).
2. **Workspaces** — zero or more registered codebases inside the workshop. Read-only from the archetype's perspective.
3. **Per-workspace project context** — CLAUDE.md, `.claude/settings.json`, project skills auto-loaded via SDK `cwd` + `settingSources: ["project"]`.
4. **Per-workspace auto-memory bridge** — the archetype's memory MCP server reads and writes `~/.claude/projects/<workspace-slug>/memory/` directly, so a fresh Claude Code session in the workspace sees what the archetype learned and vice versa.
5. **Workshop shop-journal memory** — the archetype reads and writes `~/.claude/projects/<workshop-slug>/memory/` for cross-workspace engineering craft notes.
6. **Delivery primitives** — four and only four: brainstorm (prompt pattern), file_ticket, code_task, review. These are not new MCP servers — `file_ticket` and `review` are conventions over whichever tracker MCP (`linear`, `github-issues`, `clickup`) the workspace declares. The archetype card teaches the agent to invoke them by convention.
7. **Delegate-only execution in workspaces** — Edit, Write, MultiEdit, NotebookEdit blocked on any path inside a workspace via PreToolUse hook. Bash left to system-prompt discipline (unparseable, covered in non-goals).
8. **Full agency in the workshop, outside workspaces** — Edit, Write, Bash unrestricted outside workspace paths.
9. **Tracker required per workspace** — workspaces without a configured tracker are rejected at config-load time.
10. **Definition of done encoded** — the archetype's system-prompt card enforces: ticket filed → code_task completed → PR merged → CI green → ticket closed; reported back in that order.

Invariants 1, 2, 7, 8, 9 are enforced at load time or runtime. Invariants 3, 4, 5 are enforced by the memory MCP wiring. Invariant 10 is framing. Invariant 6 is the skill bundle exposed.

## Config shape

### New `AgentConfig` fields

```ts
interface AgentConfig {
  // ... existing fields ...

  /** Discipline identifier. Unset = unstructured agent (current behavior). */
  archetype?: string;

  /** Customer-facing title (e.g., "VP Engineering"). Free text. */
  title?: string;

  /** Archetype-specific config blob, validated by the archetype on load. */
  archetypeConfig?: Record<string, unknown>;
}
```

**What `title` is used for:** it appears in the archetype system prompt card (e.g., *"You are a software engineer. Your title is VP Engineering."*) and nowhere else. Slack identity, agent ID, and display name continue to use the existing `name`/`icon`/`slackBot` fields. If `title` is unset the card falls back to `agentConfig.name`. This is the full consumer surface — no other subsystem references it.

**No data migration needed.** All three fields are optional; existing `agent_definitions` documents load as unstructured agents (current behavior) with the fields defaulting to `undefined` through `toAgentConfig`. No backfill script, no version bump on the collection.

Archetype-specific config lives under `archetypeConfig` as an opaque blob at the core-schema level. Each archetype validates its own slice on load. This keeps `AgentConfig` stable across archetypes — adding a new archetype doesn't modify the core schema.

### Software-engineer `archetypeConfig`

```ts
interface SoftwareEngineerConfig {
  workshop: string;              // absolute path, required
  workspaces: Workspace[];       // array, may be empty on day 1
}

interface Workspace {
  name: string;                  // stable identifier used in error messages, scope routing
  path: string;                  // absolute path, must be inside workshop
  tracker: TrackerConfig;        // required — no workspace without a tracker
  primary?: boolean;             // optional hint, used when inferring active workspace
}

type TrackerConfig =
  | { type: "linear"; project: string }
  | { type: "github"; repo: string }     // e.g., "dodi-hq/dodi_v2"
  | { type: "clickup"; list: string };
```

### Example: Jasper after migration

```yaml
_id: vp-engineering
name: VP Engineering
archetype: software-engineer
title: VP Engineering
model: claude-haiku-4-5       # unchanged from current seed; model router promotes to Sonnet as needed
# ... existing fields preserved ...
archetypeConfig:
  workshop: /Users/mokie/dev
  workspaces:
    - name: dodi_v2
      path: /Users/mokie/dev/dodi_v2
      tracker:
        type: linear
        project: DOD
      primary: true
```

The example above is **illustrative** — it shows only the new archetype fields. Jasper's `coreServers`, `delegateServers`, `channels`, scheduled tasks, and other existing fields are preserved verbatim during migration. The migration is diff-friendly: add archetype fields, trim the redundant "How You Work — Code Task Workflow" section from `systemPrompt`, leave everything else alone.

### Config validation rules

Enforced at agent load time by the software-engineer archetype registration:

- `workshop` must be an absolute path, must exist, must be a directory.
- Every `workspace.path` must be absolute, must exist, must be a directory, must be inside `workshop`.
- Every workspace must have a `tracker`. Omitting it rejects the config.
- No two software-engineer instances in the same Hive may declare overlapping workshops (one engineer per workshop root).
- Workspace `name` values must be unique within one engineer.

Validation failures are loud at load time — the agent fails to start, with a log message that points at the offending field.

## Layer 1: Archetype plumbing (Ticket 1)

The reusable foundation. No software-engineer code lands here. Pure infrastructure.

### Archetype registry

A module-level registry in `src/archetypes/registry.ts`:

```ts
interface ArchetypeDefinition<Config = unknown> {
  id: string;                                                       // "software-engineer"
  validateConfig(config: unknown): Config;                          // throws on invalid
  systemPromptCard(ctx: ArchetypePromptContext<Config>): string;    // returns the card
  preToolUseHooks(ctx: ArchetypeHookContext<Config>): HookCallbackMatcher[];
  memoryScopes(ctx: ArchetypeMemoryContext<Config>): MemoryScope[];
  sessionOptions(ctx: ArchetypeSessionContext<Config>): Partial<QueryOptions>;
}

export function registerArchetype<C>(def: ArchetypeDefinition<C>): void;
export function getArchetype(id: string): ArchetypeDefinition | undefined;
```

**Context types** — the minimum fields each context carries:

```ts
interface ArchetypePromptContext<C> {
  agentConfig: AgentConfig;              // full runtime config
  archetypeConfig: C;                    // already validated by validateConfig
  activeWorkItem?: WorkItemContext;      // channel/thread/sender if available
}

interface ArchetypeHookContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}

interface ArchetypeMemoryContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
}

interface ArchetypeSessionContext<C> {
  agentConfig: AgentConfig;
  archetypeConfig: C;
  workItemContext?: WorkItemContext;
}
```

The prompt and hook contexts both carry `WorkItemContext` because both may need to make decisions based on which channel/thread the agent is currently serving (e.g., inferring active workspace from channel binding in a future multi-workspace extension). The memory and session contexts don't — those run at session-construction time, not per-turn.

Archetypes register themselves on import. `agent-manager` imports all known archetype modules at startup, populating the registry. Unknown `archetype` values in agent configs log a warning and the agent runs as unstructured (graceful degradation).

### AgentConfig extension

The new fields land in **two** places and must be threaded through the mapper:

- `src/types/agent-definition.ts` — `AgentDefinition` is the MongoDB document shape. Add `archetype?`, `title?`, `archetypeConfig?` as optional fields.
- `src/types/agent-config.ts` — `AgentConfig` is the runtime shape. Same three fields, optional.
- `src/types/agent-definition.ts::toAgentConfig` — the mapper copies fields from the DB shape to the runtime shape. Without this, the new fields never cross the DB → runtime boundary.

Existing unstructured agents are unaffected — they leave all three unset.

### Agent load pipeline

`agent-registry.ts` loads an agent definition from MongoDB. New step: if `archetype` is set, look up the definition, call `validateConfig(archetypeConfig)`, store the parsed typed config on the runtime `AgentConfig` object. Failures bubble up and the agent is marked as errored, not loaded.

### System prompt assembly

`agent-runner.ts::buildSystemPrompt` gains an archetype step. Current assembly order:

```
soul → systemPrompt → constitution → tool summaries → delegate summaries → memory → datetime
```

New order:

```
soul → archetype card → systemPrompt → constitution → tool summaries → delegate summaries → memory → datetime
```

**The archetype card sits immediately after `soul` and before the agent's freeform `systemPrompt` field.** This ordering matters: the card defines the agent's discipline (invariants, policies, workflow) and is authoritative. The agent's `systemPrompt` field is for instance-specific flavor — Slack identity prefixes, scheduled task wording, secondary responsibilities — and should not preempt archetype framing. By placing the card first, any subsequent agent-level prompt content reads as "additional notes on top of an already-defined role," not as a competing definition.

Rules for Layer 3 migration:
- **Keep in the agent's `systemPrompt` field**: Slack identity prefix (`:wrench: **VP Engineering**:`), scheduled task instructions (morning briefing), agent-specific guardrails (no Gmail access), voice/tone notes.
- **Remove from `systemPrompt`, delegated to the archetype card**: workflow framing ("How You Work — Code Task Workflow"), definition of done, workspace/workshop policy, delegate-only rules.

Each archetype provides its card via `systemPromptCard(ctx)`.

**Cache locality matters.** `buildSystemPrompt` is organized around a static-prefix / dynamic-suffix contract for prompt caching (`agent-runner.ts:81-83`): content before the memory injection is stable across turns (cacheable), content after is not. The archetype card must land in the **static prefix** — it's rendered once per session from immutable config and shouldn't invalidate the cache every turn. The placement above (between `soul` and `systemPrompt`) preserves this. Do not move it past the memory injection.

### PreToolUse hook framework

`agent-runner.ts` currently wires PreCompact hooks (`buildPreCompactHook`). Extend this to support archetype-provided PreToolUse hooks:

```ts
private buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks = this.buildPreCompactHook();
  if (this.archetypeDef) {
    const pre = this.archetypeDef.preToolUseHooks({ ... });
    if (pre.length > 0) hooks.PreToolUse = pre;
  }
  return hooks;
}
```

Archetypes return an array of matchers. The framework is generic — any archetype can register hooks for any tool, including arbitrary policy logic. The software-engineer archetype uses this to block Edit/Write inside workspaces (Layer 2).

### Silent impact on scheduled tasks and event-triggered sessions

Setting `cwd = workshop` on the archetype's `query()` call affects **every** session that agent runs, not just interactive ones. Jasper's scheduled tasks (morning briefing, memory review) and any event-bus-triggered handlers will now execute with `cwd = ~/dev` instead of Hive's process cwd (`~/github/hive`).

For Jasper specifically, none of his existing scheduled tasks depend on Hive's cwd — they read memory, post to Slack, and nothing more. But this needs to be **audited as part of Ticket 3**:
- Walk his scheduled task definitions and confirm no `Read`, `Bash`, or file reference assumes Hive-repo-relative paths
- Walk his event subscribers and confirm the same

For future software-engineer instances, the rule must be documented in the archetype card: *"your working directory is your workshop — treat all relative file paths accordingly; reference Hive's own source only via absolute paths."*

### `cwd` and `settingSources` wiring

`agent-runner.ts::query()` call gains two new options sourced from the archetype:

```ts
const extra = this.archetypeDef?.sessionOptions({ ... }) ?? {};
const q = query({
  prompt,
  options: {
    // ... existing options ...
    ...extra,   // cwd, settingSources, etc.
  },
});
```

`sessionOptions` returns a partial `QueryOptions`. For software-engineer this returns `{ cwd: workshop, settingSources: ["project"] }`. The `"user"` setting source is intentionally omitted — pulling the global `~/.claude/settings.json` into an always-on Hive agent would import every local dev tool, hook, and MCP server, creating uncontrolled surface. Hive-managed tools stay the source of truth.

Note: with `cwd = workshop`, the SDK walks from workshop root. CLAUDE.md in a workspace subdirectory is still found when the session reads files in that subdirectory. If the archetype needs to pre-load a specific workspace's CLAUDE.md (for active-workspace framing), it can inject that content into the system prompt card directly.

### Memory MCP scope dimension

Today's memory MCP server (`src/memory/memory-mcp-server.ts`) reads and writes `agents/<agent-id>/...` in MongoDB. Extend it to accept a scope parameter on reads, writes, lists:

```ts
memory_save({ scope: "self" | "workshop" | `workspace:${name}`, ... })
memory_read({ scope, key })
memory_list({ scope })
```

Scope routing:

- `self` — MongoDB, existing path (`agents/<agent-id>/...`). Jasper's agent-level memory.
- `workshop` — filesystem, `~/.claude/projects/<workshop-slug>/memory/`. Shared with any Claude Code session rooted at the workshop.
- `workspace:<name>` — filesystem, `~/.claude/projects/<workspace-slug>/memory/`. Shared with any Claude Code session rooted at that workspace.

The slug transform is the path with `/` replaced by `-` (matching the Claude Code harness convention: `~/dev/dodi_v2` → `-Users-mokie-dev-dodi-v2`).

The archetype provides its scopes via `memoryScopes(ctx)`. The memory MCP server receives the scope list as env vars at startup (`MEMORY_SCOPES_JSON`) and enforces — unknown scopes rejected, writes to filesystem scopes follow harness format (frontmatter + MEMORY.md index entry).

Reads of filesystem scopes are straightforward (read the file). Writes need to maintain the MEMORY.md index convention. The implementation is a thin file-backed store mirroring the harness's auto-memory format — same frontmatter shape, same MEMORY.md one-liner pointer pattern described in `/Users/mokie/.claude/projects/-Users-mokie-github-hive/memory/` today.

### Non-changes at Layer 1

The plumbing does NOT add:

- A generic "workspaces" concept to core (workshop/workspace is software-engineer vocabulary, not universal)
- A tool filtering mechanism (archetypes can't strip tools, only gate them via PreToolUse hooks)
- A new channel or adapter
- Any changes to `code_task`, dispatcher, or triage
- Any interaction with `buildSdkPlugins` / `buildNativeSkills` — the agent's `plugins` field remains independent of archetype wiring and stays empty for software-engineer instances (dodi-dev runs inside the `code_task` inner session, not at the archetype level)

### Model router interaction

The archetype does not override model-router behavior. A software-engineer instance is still subject to per-turn Haiku/Sonnet/Opus classification capped at the agent's model ceiling. Brainstorming and spec-writing are exactly the kind of work that benefits from Sonnet+; instances that find Haiku-default insufficient can raise their model ceiling via normal agent config, independent of the archetype. The archetype has no opinion here.

## Layer 2: Software-engineer archetype (Ticket 2)

Built on Layer 1 primitives. The first archetype implementation.

### Module layout

```
src/archetypes/software-engineer/
  index.ts                  // registerArchetype(...) at import
  config.ts                 // SoftwareEngineerConfig + validateConfig
  prompt-card.ts            // systemPromptCard(ctx)
  hooks.ts                  // preToolUseHooks(ctx) — Edit/Write blocking
  paths.ts                  // workshop/workspace resolution helpers
  memory-scopes.ts          // memoryScopes(ctx) — workshop + per-workspace
  session-options.ts        // cwd + settingSources
```

`src/archetypes/index.ts` re-exports and triggers registration of all archetypes at import. `agent-manager.ts` imports `./archetypes/index.js` once at startup.

### Path resolution helpers

Core utilities in `paths.ts`:

```ts
export function isInsideWorkshop(path: string, cfg: SoftwareEngineerConfig): boolean;
export function findWorkspace(path: string, cfg: SoftwareEngineerConfig): Workspace | undefined;
export function workshopSlug(cfg: SoftwareEngineerConfig): string;
export function workspaceSlug(ws: Workspace): string;
```

`findWorkspace` resolves a given file path to the workspace it belongs to (if any). Used by the PreToolUse hook and the error message generator.

**All helpers must be pure functions** of their arguments — no module-level mutable state, no caches, no lazy-init. The same software-engineer agent may run two sessions concurrently (e.g., an interactive Slack thread and a scheduled morning briefing), and any hidden state would create race conditions. Purity is an enforced contract: each helper takes the config explicitly and returns a computed value, nothing more.

### PreToolUse hook: Edit/Write blocking

The hook intercepts `Edit`, `Write`, `MultiEdit`, `NotebookEdit`. `MultiEdit` is a real tool in the SDK surface and would be a trivial bypass if omitted. For each:

1. Extract the target file path from tool input.
2. Resolve to absolute.
3. If `findWorkspace` returns a workspace, deny. Otherwise allow.

**The entire hook body is wrapped in try/catch and returns deny-with-error on any internal exception** (see Runtime Failure Mode 4). This is an unconditional requirement, not contingent on Spike B's outcome — a bug in path resolution must never silently fail-open and disable enforcement. Fail-closed on exception is the security contract.

Deny response is a teaching error message passed back in the hook response:

> *Edit blocked: `/Users/mokie/dev/dodi_v2/apps/web/...` is inside workspace `dodi_v2`. Code changes inside workspaces flow through `code_task`, not direct edits — this preserves the spec → plan → PR → CI discipline. If you're drafting a prototype, work inside the workshop outside any workspace. If you're ready to implement against a ticket, use `code_task` with the ticket ID.*

The agent sees the error in its next turn's context and course-corrects.

Bash is **not** hooked. Static parsing of shell commands for mutation intent is unreliable (aliases, pipes, heredocs, shells inside shells). The system-prompt card tells the agent loudly: *inside workspaces, ALL execution — including git, npm, builds, test runs — flows through code_task*. Log observations of actual Bash calls from software-engineer agents inside workspace paths, and if violation patterns emerge, revisit with a narrower intervention (e.g., deny a Bash command whose cwd is inside a workspace, or track workspace-rooted commands and audit after the fact).

### Memory scopes

`memoryScopes(ctx)` returns `[self, workshop, workspace:<name>...]` — self plus workshop plus one scope per workspace. The memory MCP server is configured at agent startup with this scope list.

Writes to the `workshop` scope land in `~/.claude/projects/<workshop-slug>/memory/`. Writes to `workspace:<name>` land in `~/.claude/projects/<workspace-slug>/memory/`. Both maintain the MEMORY.md index convention used by the Claude Code harness:

```
<scope dir>/
  MEMORY.md              # index file, one-liner per memory
  <topic>.md             # individual memory with frontmatter
```

Readers (Jasper, or a fresh Claude Code session at the same path) see an identical shared brain.

### System prompt card

`systemPromptCard(ctx)` renders:

- Identity framing: *"You are a software engineer. Your discipline is owning codebases and shipping production code through disciplined delivery."*
- Workshop path and list of workspaces with tracker mappings
- Workshop/workspace policy (full agency vs delegate-only, with the error message pattern)
- Ticket-as-spec workflow
- The four delivery primitives and how they compose
- Definition of done
- Hard guardrails: never directly edit workspace files, always work through code_task for workspace mutations, always file a ticket before delegating, always verify PR + CI before closing a ticket

The card is templated (no LLM generation at render time). Archetype defaults are overridable by the agent's own `systemPrompt` field for agent-specific flavor (Jasper's voice, scheduled tasks, secondary responsibilities), but the archetype card itself is immutable by the agent.

### Review primitive

`review` is a small pattern, not a new tool. The archetype card teaches a concrete recipe that spans two surfaces:

- **Code host** (PR + CI status) — `gh pr view <number>` and `gh pr checks <number>` via Bash. GitHub is the dominant case; `gh` is already on PATH in Hive's environment. For workspaces on other code hosts, the archetype card notes that the pattern generalizes but Layer 2 only ships the `gh` recipe.
- **Tracker** (ticket comments) — whichever tracker MCP the workspace declared (`linear`, `github-issues`, `clickup`). The archetype card instructs the agent to use `<tracker>:create_comment` (or equivalent) with the PR URL and status summary.

**Split-tracker case**: a workspace may use Linear for tickets AND GitHub for code (Jasper/dodi_v2 is exactly this). The archetype card spells it out: *"For review, use `gh pr view`/`gh pr checks` for PR state, then comment on the ticket via your workspace's tracker MCP."* No new MCP server is needed; the pattern is taught in prose.

**Jasper's coreServers today** include `linear` but not `github-issues`. For the DOD-324 validation, Jasper uses `gh` (Bash) for PR/CI reads and `linear` MCP for ticket comments. No seed changes needed in Ticket 3 for the review primitive to work.

### Session options

`sessionOptions(ctx)` returns:

```ts
{
  cwd: ctx.config.workshop,
  settingSources: ["project"],
}
```

### `code_task` ticket handoff

`code_task` today takes a `prompt: string` and does NOT auto-wire tracker MCPs into the inner session (`code-task-manager.ts` — no tracker awareness). For the ticket-as-spec workflow to work end-to-end, one of two patterns is required:

**Chosen pattern (MVP): Jasper pastes the ticket body into the prompt at delegation time.** When Jasper invokes `code_task` for DOD-324, he first reads the ticket via his own `linear` MCP, then constructs a `code_task` prompt like:

```
You are working on DOD-324: <title>.

<ticket description with problem statement, approach, acceptance criteria>

Execute: dodi-dev:write-plan → dodi-dev:implement → dodi-dev:review → dodi-dev:submit.
```

The inner session has the spec inline. No extra wiring. This is the MVP approach.

**Deferred pattern**: wire a tracker MCP into `code_task` inner sessions via `codeTask.mcpServers` in `hive.yaml`, so the inner session can fetch the ticket itself. This would reduce Jasper's prompt construction burden and let the inner session re-read the ticket as needed during long implementations. Deferred to a follow-up — not in scope for this epic.

### Validation-gated tracker

`validateConfig` throws if any workspace omits `tracker`. This is the one hard requirement that elevates the tracker from "nice to have" to "core invariant."

## Layer 3: Jasper migration (Ticket 3)

Small, tactical. Assumes Layers 1 and 2 are landed.

### Changes

1. **Update `plugins/dodi/agent-seeds/vp-engineering.yaml`**:
   - Add `archetype: software-engineer`
   - Add `title: VP Engineering`
   - Add `archetypeConfig.workshop: /Users/mokie/dev`
   - Add `archetypeConfig.workspaces: [{name: dodi_v2, path: /Users/mokie/dev/dodi_v2, tracker: {type: linear, project: DOD}, primary: true}]`
   - Strip the "How You Work — Code Task Workflow" section from `systemPrompt` — the archetype card carries this now
   - Keep agent-specific content: soul, scheduled tasks, guardrails specific to Jasper (e.g., "no Gmail access"), morning-briefing section

2. **Apply to running agent definition** via admin MCP — agent defs live in MongoDB, not files. The seed update is for future imports; live changes happen via `agent_update` admin tool.

3. **Bootstrap workshop memory** — seed `~/.claude/projects/-Users-mokie-dev/memory/MEMORY.md` with a minimal shop journal if it doesn't exist. Content can be empty-ish (`# Workshop Shop Journal\n`) — the important thing is the file exists so the scope has a home.

4. **SIGUSR1 reload** to pick up the new definition.

5. **Smoke test** — ask Jasper a dodi_v2 question (e.g., *"what are the TypeScript conventions in dodi_v2?"*); verify the system prompt includes workshop memory + archetype card; verify he can read CLAUDE.md; verify Edit on a workspace path is blocked with the teaching error.

### What's NOT in the migration

- Removing Jasper's MongoDB self-memory (it stays, it's his personal agent knowledge)
- Changing Jasper's model or channels
- Modifying any other agents
- Touching dodi_v2 in any way (the migration is purely in Hive)

## Validation (not a ticket)

Once Jasper is migrated, the exec uses him to work through DOD-324 end-to-end:

1. Exec opens a thread with Jasper, describes the DOD-324 idea at a high level
2. Jasper brainstorms — asks clarifying questions, proposes approaches, reaches alignment with the exec
3. Jasper files a ticket in Linear (description IS the spec)
4. Jasper delegates to `code_task`: *"work on ticket DOD-324"* with the dodi_v2 worktree path
5. Inner session fetches the ticket, follows dodi-dev plan → implement → review → submit
6. Jasper watches the PR, reports back
7. Ticket closes when CI merges the PR

Success criteria:

- Jasper's context loads CLAUDE.md and MEMORY.md from `~/dev/dodi_v2`
- Jasper never directly edits a file in `~/dev/dodi_v2` (hook fires if he tries)
- The ticket description reads like a human-written spec (problem, approach, acceptance criteria)
- The inner `code_task` session completes without escalation (or with only substantive escalations, not context-missing ones)
- The exec experience is *"I talked to my VP of Engineering and the thing got built"*, not *"I routed a message through a chatbot"*

Friction points are captured as learnings for refinement, not ticket blockers. This is exploratory validation.

## Non-goals (explicit)

- **Multi-workspace active-workspace routing**. MVP assumes one primary workspace per engineer. When a second workspace is added to an engineer's config, we'll solve active-workspace detection then (channel binding, ticket-prefix inference, explicit thread scoping, or LLM inference). Until then, the `primary: true` workspace is the implicit default and the archetype card lists others as available references.
- **Bash enforcement inside workspaces**. Not reliably parseable; covered by system-prompt framing; observability-driven iteration later if needed.
- **Auto-registration of workspaces**. Too magical; rejected.
- **Self-service workspace registration by the archetype**. Constitutionally, agents don't modify their own definitions. MVP uses beekeeper admin for registration. V2 may add a propose-and-approve pattern.
- **Cross-engineer coordination**. If Hive ever has two software-engineer instances with adjacent workspaces, coordination between them is out of scope. Use existing team MCP messaging.
- **New customer-facing UI**. The exec interacts via existing channels (Slack, SMS, WS).
- **Migrating other agents** (Chloe, Milo, etc.). They're role-shapes, not disciplines. They stay unstructured.
- **Retiring `code_task`**. It remains the implementation seam. The archetype layers on top of it.

## Test strategy

**Unit tests** (per ticket, in `src/archetypes/**/*.test.ts`):
- Registry: register, lookup, duplicate-id handling, graceful degradation on unknown archetype
- Config validation: happy path + every validation rule (missing workshop, workspace outside workshop, missing tracker, duplicate workspace names, cross-engineer overlap detection)
- Path resolution helpers: pure, with explicit test cases for edge paths (trailing slashes, dots, nested workspaces, paths that look like but aren't inside workspaces)
- Prompt card rendering: deterministic output, all branches exercised (workshop only, workshop + one workspace, workshop + multiple workspaces)
- Memory scope routing: self → MongoDB, workshop/workspace → correct filesystem path
- Hook blocking: Edit/Write/MultiEdit/NotebookEdit all blocked on workspace paths, all allowed on workshop-outside-workspace paths

**Integration tests** (spike-originated, promoted to permanent):
- Spike A result → permanent test that a `query()` with `settingSources: ["project"]` loads a known CLAUDE.md. Stub CLAUDE.md in a fixture dir.
- Spike B result → permanent test that a PreToolUse hook denying a path blocks an Edit under `bypassPermissions`. This is the load-bearing guarantee for the entire enforcement model — it cannot be a one-time check.
- Spike C result → permanent test for the slug transformation function, with all edge cases the spike uncovered.

**Not tested automatically** (manual verification in Ticket 3):
- Live SIGUSR1 reload of Jasper's definition
- Actual DOD-324 brainstorm → file ticket → code_task end-to-end (this is the validation exercise, not a test suite run)

Test coverage is explicit acceptance criteria for Tickets 1 and 2. A ticket is not merge-ready if any of the unit tests above are missing.

## Open questions

These are areas we chose not to resolve in brainstorm because real use will inform them better than speculation:

1. **Workspace registration UX**. MVP is beekeeper-managed. V2 is likely a propose-and-approve pattern where the archetype does prep work (validate repo, check CLAUDE.md, confirm tracker) and beekeeper rubber-stamps. The exact shape emerges after the first few real registrations.
2. **Active-workspace inference when multi-workspace lands**. Channel binding feels most natural (`#dodi-v2` → dodi_v2 workspace), but thread continuity and ticket-prefix inference are alternatives. Decide when the second workspace is real.
3. **Concurrency on shared memory files**. Jasper and a human Claude Code session writing to the same MEMORY.md simultaneously *could* race. In practice files are small and writes are brief; collisions are rare. Revisit if observed.
4. **Format drift risk on the auto-memory bridge**. The Claude Code harness owns the MEMORY.md format. If Anthropic changes it, the archetype's memory MCP will drift. Mitigation: strict schema on writes, versioning check at read time, log on format mismatch.
5. **Whether other delivery-oriented agents (e.g., DevOps, if reactivated) should also become archetypes**. DevOps has workshop-like characteristics (infra repos, deployment workflows). Open for future decision after software-engineer ships.

## Implementation plan outline

Details land in per-ticket plans via `dodi-dev:write-plan`. High-level file map:

**Ticket 1 — Archetype plumbing**

New:
- `src/archetypes/registry.ts` — archetype registry + types
- `src/archetypes/index.ts` — imports all archetype modules to trigger registration
- Tests for registry, config validation pipeline

Modified:
- `src/types/agent-definition.ts` — add `archetype`, `title`, `archetypeConfig` to `AgentDefinition` (DB shape); update `toAgentConfig` mapper to carry them through
- `src/types/agent-config.ts` — add same three fields to `AgentConfig` (runtime shape)
- `src/agents/agent-registry.ts` — call archetype validator on load; fail-closed on invalid config
- `src/agents/agent-runner.ts`:
  - `buildSystemPrompt` — inject archetype card in the static prefix
  - `query()` call — merge archetype `sessionOptions`
  - `buildPreCompactHook` → generalize to `buildHooks` — merge archetype PreToolUse hooks
- `src/memory/memory-mcp-server.ts` — add `scope` parameter to tools; support filesystem-backed scopes; atomic-rename write strategy

**Ticket 2 — Software-engineer archetype**

New:
- `src/archetypes/software-engineer/` (full module tree above)
- Tests: config validation, path resolution, hook blocking behavior, memory scope routing, prompt card rendering

Modified:
- `src/archetypes/index.ts` — import software-engineer

**Ticket 3 — Jasper migration**

Modified:
- `plugins/dodi/agent-seeds/vp-engineering.yaml` — archetype fields, trimmed system prompt

Operational:
- Admin MCP call to update Jasper's live definition in MongoDB
- Seed `~/.claude/projects/-Users-mokie-dev/memory/MEMORY.md`
- SIGUSR1 reload
- Smoke test

Per-ticket plans will expand file-by-file, test plan, order of operations. The spec defines the shape; plans define the execution.

## Prerequisite spikes (before Ticket 1 commits)

Two load-bearing assumptions must be validated before any production code lands. Failures here change the implementation significantly, so treat them as gating work, not risks.

**Spike A — `settingSources: ["project"]` behavior in the SDK.** The SDK docs say it loads CLAUDE.md and `.claude/settings.json`. Spike this with a minimal test: spawn a Hive-style `query()` with `cwd: ~/dev/dodi_v2` and `settingSources: ["project"]`, ask the model what CLAUDE.md says. Verify:
- CLAUDE.md content is visible to the model
- No Hive-hostile hooks or settings get loaded from `.claude/settings.json`
- Project skills (if any in `.claude/skills/`) surface as expected
- No filesystem writes or process spawns are triggered just by enabling the option

If any of these surprise us, Layer 1 changes — we may need to manually pre-load CLAUDE.md into the system prompt card instead of relying on `settingSources`.

**Spike B — PreToolUse hooks under `bypassPermissions` mode.** Hive runs with `permissionMode: "bypassPermissions"` AND `allowDangerouslySkipPermissions: true` (`agent-runner.ts:904-905`). Spike this: register a PreToolUse hook that denies `Edit` on a specific path, run an agent that tries to edit it. Verify:
- The hook fires in `bypassPermissions` mode (not silently skipped)
- The denial is respected, not bypassed
- The error message is visible to the agent in its next turn
- **Hook exception semantics**: if the hook callback throws, is the tool call fail-open (succeeds) or fail-closed (blocked)? This is the security-critical subcase — a bug in path resolution should NOT silently disable enforcement. If the SDK fails open on hook exceptions, Layer 2's hook implementation must wrap its entire body in a try/catch that returns deny-with-error on any internal error.

If PreToolUse hooks ARE bypassed in `bypassPermissions` mode, the entire delegate-only enforcement model collapses to system-prompt framing only. In that case we need a different enforcement mechanism before Layer 1: either switch to `permissionMode: "default"` with a pre-approved allowlist, or wrap tools in a middleware layer.

**Spike B becomes a permanent regression test.** Once Spike B validates the behavior, the same test moves into the test suite as a regression — the guarantee that Hive's permission mode doesn't silently break archetype enforcement is too load-bearing to leave as a one-time spike.

**Spike C — auto-memory slug format.** The Claude Code harness converts a path like `~/dev/dodi_v2` to a project directory slug like `-Users-mokie-dev-dodi-v2`. The exact transformation rules (slash handling, dot handling, case, home expansion) are not in any published contract and could break silently if we guess wrong. Spike: find a running Claude Code session's actual project memory path for a known cwd and derive the rule empirically. Write the rule as a single function with explicit test cases covering: paths with dots, paths with multiple slashes, paths with trailing slashes, root-relative vs tilde-expanded paths. This function is the source of truth for `workshopSlug` / `workspaceSlug` in `paths.ts`.

All three spikes are small — a few hours each — and must complete green before Ticket 1 breaks ground.

## Runtime failure modes

These are the error cases the plumbing must handle explicitly. Omitting them would create silent failures.

1. **Workshop directory deleted between reloads**. Agent definition valid at load time, workshop gone at session-start time. The SDK `query()` call with a non-existent `cwd` will fail. Layer 1 must validate workshop existence **at session-start**, not just at agent-load, and return a clear error to the caller (dispatcher logs and skips the message, surfacing to beekeeper if it persists). No silent hangs.
2. **Auto-memory directory unreadable** (perms, uid mismatch). The memory MCP server must catch filesystem errors on reads/writes and return them as tool errors to the agent, not crash the subprocess. Log the first occurrence at warn level, then at debug to avoid log spam.
3. **Unknown memory scope**. The memory MCP server receives a scope it wasn't configured with (e.g., typo, or removed workspace after a config reload). Response: return a tool error to the LLM with the valid scope list. Do NOT throw — keep the MCP subprocess alive.
4. **Hook callback throws**. Already covered by Spike B — the archetype's hook implementation wraps its body in try/catch and fails closed (denies the tool call with an internal-error message) if SDK behavior is fail-open.
5. **Across separate Hive instances on the same machine** — workshop overlap is allowed. Intra-instance overlap is rejected by config validation (one software-engineer per workshop root within a single Hive); but the personal and dodi Hive instances both run on the same Mac Mini and may independently configure software-engineers with `workshop: ~/dev`. Both would read/write the same `~/.claude/projects/-Users-mokie-dev/memory/` files. **This is allowed and handled by the atomic-rename strategy** — last-writer-wins on concurrent MEMORY.md edits, no partial-read windows. The spec explicitly does NOT add a machine-level lockfile; cross-instance coordination is out of scope. Document this as expected behavior, not a bug.

## Risks

1. **Auto-memory format drift**. The Claude Code harness auto-memory format is not a stable published contract. A silent Anthropic change could break read or write compat. Mitigation: strict write schema, tolerant read parser, log-and-skip on mismatch.
2. **Workshop path sandboxing**. If the PreToolUse hook blocks writes inside workspaces but the workshop is `~/dev`, the agent still has Edit/Write access to everything in `~/dev` outside any workspace. That includes potentially sensitive files if the exec keeps non-dev content there. Document the expectation: the workshop is a dedicated engineering root, not `~` or somewhere mixed-use.
3. **Shared memory file concurrency**. The auto-memory bridge writes to `~/.claude/projects/<slug>/memory/` files that a human Claude Code session may also write to. In practice files are small and writes are brief. The write strategy is **atomic rename**: write to a temp file in the same directory, then `fs.renameSync` over the target. Last-writer-wins semantics, no partial-read windows. MEMORY.md edits are read-modify-write under the same scheme. If observed collisions become a problem, upgrade to an advisory file lock.
4. **Scheduled task / event subscriber cwd shift in Ticket 3**. Migrating Jasper changes his session `cwd` from Hive's process cwd to `~/dev` for ALL sessions — interactive, scheduled, and event-triggered. Ticket 3 must audit Jasper's scheduled tasks (morning briefing, memory review) and event subscriptions to confirm none rely on Hive-repo-relative file paths. Mitigation: the audit is a checklist item in Ticket 3's acceptance criteria.
5. **MongoDB live-migration of Jasper**. Editing the running agent definition mid-flight carries some risk of a transient bad state. The rollback path is the existing `agent_definition_versions` collection (see CLAUDE.md) — `admin_mcp::agent_get` to snapshot, `admin_mcp::agent_update` to apply, `admin_mcp::agent_rollback` to revert if reload fails. No ad-hoc backup needed — version history is already wired.

## Rollout

Serial, not parallel:

1. Merge Ticket 1 (plumbing). No visible effect.
2. Merge Ticket 2 (software-engineer archetype). Still no visible effect until an agent opts in.
3. Run Ticket 3 (Jasper migration) in a low-activity window. Verify smoke tests pass before the next exec interaction.
4. Use DOD-324 as the validation exercise. Capture friction, refine.
5. Only after DOD-324 succeeds, consider migrating other delivery-oriented agents or building the next archetype.
