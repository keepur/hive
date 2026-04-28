# KPR-87 — Agent toolkit visibility

**Ticket**: [KPR-87](https://linear.app/keepur/issue/KPR-87) — runtime "Your toolkit" section in system prompt.
**Branch**: `KPR-87-toolkit-visibility` (worktree at `~/github/hive-KPR-87`).
**Base**: `main`.

## Problem (one-line)

Agents have three layers of tools (SDK builtins, engine-auto-injected MCPs, explicit MCPs) and zero of them are canonically listed in their context. They guess at what they have.

## Current state (read before designing)

`src/agents/agent-runner.ts` already builds two server-listing sections inside `buildSystemPrompt`:

- **`## Your tools`** (lines ~247-255) — lists `coreServerNames` minus `INFRASTRUCTURE_SERVERS = { schedule, structured-memory, team }` (line 936-938). Built from `formatCatalogEntry(...)` over `SERVER_CATALOG` entries.
- **`## Available via subagents`** (lines ~258-265) — lists `activeDelegates` (the keys actually built by `buildDelegateAgents`).

What's missing right now (the KPR-87 gap):

1. **SDK builtins** are never listed. Agents have `Bash/Read/Write/Edit/Glob/Grep/NotebookEdit/WebFetch/WebSearch` from the SDK and no in-prompt reference exists. The SDK does not expose a programmatic manifest, so this list lives as a hardcoded constant in the engine.
2. **Engine-auto-injected MCPs** (`schedule`, `structured-memory`, `team`, `slack`, conditional `workflow`) — the auto-inject logic in `filterCoreServers` (lines 866-883) adds these regardless of the agent's `coreServers` field, then `INFRASTRUCTURE_SERVERS` filters them out of the visible "Your tools" listing. So the agent has no idea that `team_*`, `slack_*`, `schedule_*`, `memory_recall`, etc. exist in their toolbelt.
3. **Conditional servers** (e.g. `browser`) — only built when `config.browser.cdpEndpoint` is truthy, so they only appear if actually present. This is correct already; we just need to mirror it.
4. **Disambiguation** — `team` (agent-to-agent) vs `contacts` (people-directory lookup) is the canonical confusing pair. Today `contacts` has a `notFor` blurb but `team` has no entry at all in `SERVER_CATALOG` (it's auto-injected and infrastructure-filtered, so no blurb has ever been authored).

## Decision summary

- **Replace** the existing `## Your tools` + `## Available via subagents` blocks with a single unified `## Your toolkit` section that has four named subsections: SDK builtins, engine-provided, capability MCPs, delegated capability MCPs. Single section keeps all "what can I call" information in one place; agents stop having to scan two adjacent headers.
- **Single registry** — extend `SERVER_CATALOG` in `src/tools/server-catalog.ts` with a new optional field `toolkitBlurb` (short — target ~60-100 chars). When unset, fall back to `description`. Plugin MCP servers continue to source their blurb from `plugin.yaml` `description` (we don't add a new manifest field — plugin descriptions are already short).
- **Engine-auto-inject decisions** are read by *mirroring* the existing logic in `filterCoreServers`. Refactoring `filterCoreServers` to expose its decision is a larger change with broader test surface; mirroring is small (~6 lines) and the duplication is bounded. We add a comment in both places pointing at the other so they stay in sync. (If this becomes painful in the future, refactor then.)
- **SDK builtins** list is hardcoded in the new toolkit assembler. The list is short, stable across SDK versions in practice (the SDK doesn't add tools without major-version churn), and the source is `@anthropic-ai/claude-agent-sdk` — a constant in our code with a comment pointing at the SDK README is the cheapest correct answer.
- **Position in assembly** — replace the existing `## Your tools` insertion site (between constitution and memory). Per CLAUDE.md: assembly order is date/time → soul → systemPrompt → constitution → agent memory. KPR-87 inserts toolkit *after constitution, before memory* (where `## Your tools` already lives). No assembly-order change.
- **`team` blurb** — add an entry to `SERVER_CATALOG` so `team` has a documented blurb even though it's auto-injected. The toolkit assembler emits it under "engine-provided" regardless. Disambiguation language goes in the blurb itself.

## File list

### New files

- **`src/agents/toolkit-section.ts`** (new module) — exports `buildToolkitSection(opts)` that returns the formatted markdown. Hosts the SDK-builtins constant, the engine-auto-inject mirror, and the section assembly. Pure function — no I/O, no side effects, takes everything by parameter for trivial testability.
- **`src/agents/toolkit-section.test.ts`** — unit tests (see test plan below).

### Modified files

- **`src/tools/server-catalog.ts`**
  - Add `toolkitBlurb?: string` to `ServerCatalogEntry` interface.
  - Add a `toolkitBlurb` to entries that need a punchier line than their `description` (most don't — the existing descriptions are already short).
  - Add a new entry for `team` with explicit disambiguation: `description: "Direct agent-to-agent messaging — peer hive agents, not Slack DMs"`, plus a `notFor` line like `"People directory lookups — use contacts instead"`.
  - Update the `contacts` `notFor` to add the inverse: `"Messaging another hive agent — use team instead"`.

- **`src/agents/agent-runner.ts`**
  - Import `buildToolkitSection` from `./toolkit-section.js`.
  - In `buildSystemPrompt`: replace the existing `## Your tools` and `## Available via subagents` blocks (lines ~247-265) with a single call to `buildToolkitSection(...)`. Pass it the resolved core server keys (post-filter, `coreServerNames` is what we already pass in), the active delegate keys (`activeDelegates`), the plugin list (for plugin-server blurbs), the `INFRASTRUCTURE_SERVERS` set (so the assembler knows which servers are engine-auto-injected vs explicit-from-config), and the conditional flags it needs (`config.workflow.enabled`, `config.browser.cdpEndpoint`).
  - The `INFRASTRUCTURE_SERVERS` constant stays as the source-of-truth. It controls which auto-injected servers go into the "engine-provided" subsection and which explicit servers go into "capability MCPs."

- **`src/agents/agent-runner.test.ts`**
  - Update existing assertions that reference `## Your tools` / `## Available via subagents` headers to match the new section structure (or replace with subsection-targeted assertions).
  - Existing tests that assert `excludes structured-memory from 'Your tools' section` etc. — update intent: structured-memory remains hidden as an auto-paired infrastructure server (it's spawned but listed under `memory` in the prompt, not as its own line). Tests that check positive presence of `memory:`, `contacts:`, plugin-server-with-fallback, usage hints, and notFor hints all stay.
  - Add an assertion that the new section appears between constitution and memory (already implicit; explicit anchor test).

### Touched but not changed (verification only)

- `src/tools/server-catalog.test.ts` — existing tests pass unchanged after the catalog additions. May want to add a test that the new `toolkitBlurb` field renders correctly when set.
- `src/agents/prompt-builder.ts` — voice prompt builder. Per its docstring, voice intentionally omits tool summaries. **Do not** add the toolkit section to voice prompts (Vapi handles tools at the platform layer). No change.

## API shape — `buildToolkitSection`

```ts
export interface ToolkitSectionInput {
  /** Names of MCP servers actually configured for this agent's parent session
   *  (after filterCoreServers — i.e. post-auto-inject, post-autonomy-gate). */
  coreServerNames: string[];
  /** Names of MCP servers actually built as delegate subagents. */
  delegateServerNames: string[];
  /** Plugins in the runner — for resolving plugin-server descriptions. */
  plugins: LoadedPlugin[];
  /** Set of server names that are auto-injected by the engine (not from agent definition). */
  autoInjectedServers: ReadonlySet<string>;
}

export function buildToolkitSection(input: ToolkitSectionInput): string;
```

Output structure (markdown):

```
## Your toolkit

You have access to the following tools this session. Try them; don't guess at availability.

### Built-in (always available)
- Bash — run shell commands
- Read / Write / Edit — file I/O
- Glob / Grep — file/content search
- WebFetch / WebSearch — web access
- NotebookEdit — Jupyter notebook editing

### Engine-provided (always available to every agent)
- memory — Read and write your personal agent memory
  → durable scratchpad for facts across conversations
- structured-memory — Semantic + temporal memory tiers
  → memory_recall / memory_save / memory_pin
- schedule — Self-service schedule management
- team — Direct agent-to-agent messaging — peer hive agents, not Slack DMs
- slack — Slack API — read channels, post messages, manage threads
- (workflow — only if config.workflow.enabled)

### Capability MCPs (provisioned for your role)
- <each non-auto-injected server in coreServerNames, with blurb from catalog/plugin manifest>

### Delegated capability MCPs (via Agent tool)
- <each server in delegateServerNames, same lookup>
```

Subsections that would be empty are omitted entirely (e.g. an agent with no delegates doesn't get an empty "Delegated" subsection).

## Engine-auto-inject decision mirror

The toolkit assembler will treat a server as "engine-provided" iff it appears in `coreServerNames` AND in `autoInjectedServers`. The caller (`agent-runner.ts`) passes a frozen set built once at call time:

```ts
const AUTO_INJECTED = new Set([
  "schedule",
  "structured-memory",
  "team",
  "slack",
  ...(config.workflow.enabled ? ["workflow"] : []),
]);
```

This list mirrors the additions in `filterCoreServers` (lines 866-883). Both sites get a comment pointing at each other.

`memory` is interesting — it's *always built* in `buildAllServerConfigs` (it's not gated), but it's only included for an agent if their `coreServers` list has it. In practice today every business agent has `memory` because the universal-9 default ships it. We treat `memory` as "engine-provided" only if it's auto-injected, otherwise as a normal capability MCP. Since it isn't currently auto-injected, this means agents that put `memory` in their `coreServers` (the current pattern) see it under "Capability MCPs." That's accurate per the actual auto-inject logic. (If KPR-86 / KPR-71 later promotes `memory` to universal default by *injecting* rather than requiring it to be authored, this list updates.)

## Test plan (`src/agents/toolkit-section.test.ts`)

Pure-function tests — no SDK mocking needed.

1. **bare-bones agent** — `coreServerNames: ["memory", "schedule", "team", "slack", "structured-memory"]`, no delegates, no plugins → output contains "Built-in" and "Engine-provided" subsections, has a single line per engine-provided server, no "Capability MCPs" or "Delegated" subsection. Output ≤ 1 KB. (Concrete budget assertion.)
2. **typical agent** — `coreServerNames: ["memory", "schedule", "team", "slack", "structured-memory", "google", "resend", "callback"]`, `delegateServerNames: ["linear", "brave-search"]` → both "Capability MCPs" and "Delegated" subsections present, plugin-style blurbs on the right ones.
3. **conditional browser** — server `"browser"` in `coreServerNames` → appears under Capability MCPs; not in `coreServerNames` → absent. (No special handling — pure list rendering. The conditional is upstream.)
4. **plugin server fallback** — `coreServerNames: ["custom-tool"]`, plugin manifest provides description → that description renders.
5. **unknown server** — `coreServerNames: ["mystery"]`, no plugin entry → falls through to `description = name` (matches `getServerCatalogEntry` behavior). One-line acceptable fallback.
6. **team vs contacts disambiguation** — agent has both → `team` line mentions "agent-to-agent", `contacts` line mentions "directory lookups", neither line claims the other's role.
7. **`toolkitBlurb` override** — when an entry has `toolkitBlurb`, that's used instead of `description` in the toolkit section. (Spot-check: don't fail every test on every blurb tweak.)
8. **size budget** — bare-bones output ≤ 1 KB (`Buffer.byteLength(output, "utf8")` < 1024).
9. **subsection order is stable** — Built-in → Engine-provided → Capability MCPs → Delegated. (String-position comparison, like the archetype card test.)
10. **size budget — typical agent** — ~1.5 KB ceiling for an 8-core / 4-delegate agent (sanity check; not a regression gate).

Plus: keep the existing `agent-runner.test.ts` assertions for `## Your toolkit` presence, and update the negative assertions that reference `## Your tools` to the new header.

## Server catalog updates (concrete)

Additions:

```ts
team: {
  description: "Direct agent-to-agent messaging — peer hive agents, not Slack DMs",
  usage: "Sending a message or task to another agent in this hive",
  notFor: "Looking up people in the contact directory — use contacts instead",
},
```

Edit to existing `contacts`:

```ts
contacts: {
  description: "Contact lookups by name, email, or phone",
  usage: "Quick lookups of people in the contact directory",
  notFor: "Messaging another hive agent (use team) or CRM deal/company data (use a CRM plugin)",
},
```

No other catalog edits in scope. Other entries already have appropriate descriptions.

## Acceptance criteria checklist

- [x] System prompt at runtime contains a `## Your toolkit` section listing SDK builtins, engine-injected MCPs, capability MCPs, and delegated capability MCPs.
- [x] Each tool/server has a one-line blurb from a single registry.
- [x] `team` and `contacts` are explicitly disambiguated in their blurbs.
- [ ] §7.4 lightening — **out of scope** for this PR. Lives in hive-baseline frame's capabilities.md, not the engine. Filed as follow-up: "Soften capabilities clause in hive-baseline frame after KPR-87 ships toolkit visibility."
- [x] Section ≤ 1 KB for a bare-bones agent (test enforced).

## Out of scope

- Listing individual tool *methods* (e.g. `memory_save`, `memory_pin`) — would blow the 1 KB budget. Server-level granularity only.
- Refactoring `filterCoreServers` to expose its auto-inject decision — duplication is small enough; refactor when it bites.
- Adding the toolkit section to voice prompts — Vapi handles voice tools at the platform layer, voice prompt is intentionally tool-summary-free.
- Hardening the SDK builtins list against SDK version drift — the list is hardcoded with a `// Source: @anthropic-ai/claude-agent-sdk vX.Y.Z` comment.

## Implementation order

1. Catalog edits (`server-catalog.ts` — add `toolkitBlurb` field, add `team` entry, edit `contacts.notFor`).
2. New module (`src/agents/toolkit-section.ts`) — pure function.
3. Unit tests (`src/agents/toolkit-section.test.ts`).
4. Integration into `agent-runner.ts` `buildSystemPrompt` — replace existing tool-section blocks.
5. Update `agent-runner.test.ts` to match new section name + structure.
6. `npm run check` — typecheck + lint + format + test all green.
7. `npm run bundle && node scripts/check-bundle-strings.mjs` — bundle decontamination clean (no plugin-specific strings).
8. dodi-dev:review on diff.
9. Submit PR (base `main`, title `KPR-87: agent toolkit visibility — runtime "Your toolkit" section in system prompt`).

## Risks / unknowns

- **Risk: SDK builtin list drifts.** Mitigation: comment with SDK version in the constant; if it gets stale, the worst case is the agent sees an old list. The SDK additions in our experience are rare and additive.
- **Risk: bundle decontamination flake.** This change adds a new prompt-assembly path. Plugin server names are already in plugin manifests, not the engine bundle. The new module shouldn't introduce any plugin-specific strings (no "dodi", no "hubspot", no "cabinet"). Verify with the script.
- **Risk: existing test churn.** Several assertions reference the old `## Your tools` header. Update them deliberately (preserving intent) rather than mass-replace.
- **Unknown: do any agents currently have `team` or `slack` explicitly in `coreServers`?** If so, the auto-inject decision today double-injects (coreSet.add is idempotent — `Set.add` no-ops on duplicates) so behavior is unchanged. The toolkit section's "engine-provided vs capability MCPs" classification keys off `autoInjectedServers`, so even if an agent author added `team` explicitly, it shows under "engine-provided" (correct). No issue.

## Plan-author confidence

Medium-high. The design is small, the existing structure already supports most of it (the catalog, the formatter, the assembly site all exist), and the tests are pure-function. Main risk is test-update churn in `agent-runner.test.ts`, which is mechanical.
