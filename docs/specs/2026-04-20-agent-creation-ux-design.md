# Agent Creation UX — Design Spec

**Date:** 2026-04-20
**Status:** Draft — brainstorm output, pending review
**Depends on:**
- [Agent Builder](2026-04-08-agent-builder-design.md) (skill design)
- [Software-Engineer Archetype](2026-04-09-software-engineer-archetype-design.md) (archetype plumbing — shipped)
- [Agent homeBase](2026-04-12-agent-home-base-design.md) (creation-boundary validation — shipped)

## Problem

Hermi (the chief-of-staff on a keepur instance) created three new agents — Samantha (Head of Marketing), Alexandria (Head of Product/Engineering), Luna — using her `agent-builder` skill. All three came back broken:

- `coreServers: []` — no `memory`, no `keychain`, no `contacts`, no `event-bus`. They function as echo bots with no persistence.
- `archetype` unset on Alex despite her being explicitly "Head of Product and Engineering — owns architecture, code review, and shipping." She should be a `software-engineer` archetype instance; she's a plain unstructured agent.

Three root causes, three layers:

1. **`admin-mcp-server.ts::agent_create` (line 184)** defaults `coreServers` to `[]` when the caller omits the field. `AGENT_DEFINITION_DEFAULTS` has no `coreServers` entry either — there's no baseline even in principle.
2. **`agent_create` doc construction (lines 174-208)** silently drops `archetype`, `title`, `archetypeConfig`, `homeBase` even if the caller passes them in `fields`. The tool accepts a `Record<string, any>` bag but only propagates a fixed subset into the inserted document.
3. **`seeds/chief-of-staff/skills/agent-builder/.../SKILL.md`** is a 170-word stub. The approved spec for this skill ([2026-04-08-agent-builder-design.md](2026-04-08-agent-builder-design.md)) is 251 lines — with a full INTAKE → PERSONA → MAP → CHECK → GAP → PROPOSE → CONFIRM → CREATE → INTRODUCE flow, guardrails, and reference examples. None of that is in the shipped skill.

The archetype plumbing (archetype registry, config validation, prompt card injection) is already landed per `2026-04-09`. The gap is entirely in the **creation surface** — the tool that writes agent definitions and the skill that drives it.

## Scope

One spec, two phases (per brainstorm Q1/A).

**Phase 1 — Admin MCP & defaults.** Fix the tool so Hermi can create an agent correctly even with her current stub skill. Ships first; impact is "Hermi's future agent creations are no longer silently broken."

**Phase 2 — Skill rewrite.** Materialize the agent-builder skill per its approved spec, wired to the Phase 1 surface. Ships second; impact is "Hermi's creation flow matches the designed UX."

### Explicit out-of-scope

- **Retrofitting existing agents** (Samantha, Alexandria, Luna). They've been manually patched with sensible `coreServers`. Alex's archetype conversion is a one-off admin operation for after Phase 1 lands (use the fixed `agent_update`) — not design work.
- **New archetypes.** Only `software-engineer` exists today. Adding bookkeeper/designer/etc. is YAGNI until a real use case shows up.
- **Workspace registration UX** (per `2026-04-09` open question — deferred to beekeeper-managed MVP, propose-and-approve in V2). Phase 2's SE branch only asks for `workshop`; `workspaces` stays empty at creation time.
- **Channel auto-provisioning.** Flagged in the agent-builder spec; still requires human Slack-admin action. Unchanged here.
- **`instance_capabilities` changes.** Already shipped (verified in `src/tools/instance-capabilities.ts` + admin MCP tool 545).

## Decisions summary

| Q | Decision |
|---|---|
| Q1 | One spec, two phases (infra → skill). |
| Q2 | In scope: A–G (admin MCP + skill rewrite + archetype discovery). Out: retrofit, new archetypes, workspace reg. |
| Q3 | `coreServers` baseline: `["memory","structured-memory","keychain","event-bus","contacts"]`. Slack/schedule/team stay implicit in `agent-runner.ts`. |
| Q4 | Promote `homeBase`/`archetype`/`title`/`soul`/`systemPrompt` to top-level on `agent_create`. Everything else stays in `fields`. |
| Q5 | `list_archetypes` returns `id` + `description` + `whenToUse` + `configSchema` per archetype. |
| Q6 | SE archetype config at creation: `workshop` only. Workspaces deferred to future admin flow. |
| Q7a | `agent_update` gets the same top-level promotions. |
| Q7b | `agent_create` rejects unknown archetypes at tool level; archetype's own `validateConfig` still runs at load time. |

## Phase 1 — Admin MCP & defaults

### 1.1 Default `coreServers` baseline

Add to `AGENT_DEFINITION_DEFAULTS` in `src/types/agent-definition.ts`:

```ts
export const AGENT_DEFINITION_DEFAULTS = {
  // ... existing fields ...
  coreServers: ["memory", "structured-memory", "keychain", "event-bus", "contacts"] satisfies readonly string[],
  delegateServers: [] satisfies readonly string[],
} as const;
```

**Type note:** the existing object is `as const` with narrow literal types. Use `satisfies readonly string[]` (not `as string[]`) so the baseline keeps the `as const` readonly nature and doesn't force a type widening at the declaration site. Call sites that spread into a mutable array (`[...AGENT_DEFINITION_DEFAULTS.coreServers]`) already handle the readonly→mutable conversion correctly.

**`delegateServers` baseline is `[]`** — stated explicitly so Phase 1 doesn't surprise anyone. Matches today's silent default; agents that delegate opt in via the `fields` bag.

**Rationale:** the five `coreServers` are the "functional team member" set. `memory` + `structured-memory` = cross-session persistence. `keychain` = credential access (any agent calling a tool likely needs a token). `event-bus` = cross-agent events. `contacts` = the team roster (matches the mental model: every agent knows who their colleagues and humans are).

**Not in the baseline:**
- `slack`, `schedule`, `team` — already implicit core servers in `agent-runner.ts`. Listing them here would be redundant and drift-prone.
- `admin` — privileged; only managerial agents need it (Hermi has it explicitly).
- `code-task`, `github`, `linear`, `clickup`, `workflow`, etc. — role-specific; added per-agent by the skill or by hand.

**Downstream:** this default is applied at `agent_create` time only. Existing agents in MongoDB with `coreServers: []` are NOT backfilled; that's a one-off admin op.

### 1.2 `agent_create` — schema promotion + silent-drop fix

Current signature:
```ts
{ _id: string, name: string, model: string, fields?: Record<string, any> }
```

New signature (top-level promotion of creation-boundary fields):
```ts
{
  _id: string,
  name: string,
  model: string,
  homeBase: string,          // promoted from fields — was validated but not in schema
  soul?: string,             // promoted
  systemPrompt?: string,     // promoted
  archetype?: string,        // promoted
  title?: string,            // promoted
  fields?: Record<string, any>,  // everything else (channels, schedule, autonomy, archetypeConfig, etc.)
}
```

**`archetypeConfig` stays under `fields`** — it's an opaque blob whose shape differs per archetype. Surfacing it as a typed top-level field would force a union type that drifts whenever a new archetype lands. The existing fields-bag pattern works fine for opaque structures; the discovery affordance comes from `list_archetypes` returning `configSchema`.

**Doc construction fix:** extend the `doc: AgentDefinition` builder (lines 174-208) to also pick up:
```ts
archetype: (f.archetype as string) ?? undefined,
title: (f.title as string) ?? undefined,
archetypeConfig: f.archetypeConfig as Record<string, unknown> | undefined,
```
…plus whatever comes from the new top-level params. Today these three are silently dropped — the root cause of Alex missing her archetype.

**coreServers default:**
```ts
coreServers: (f.coreServers as string[]) ?? [...AGENT_DEFINITION_DEFAULTS.coreServers],
```

### 1.3 `agent_create` — unknown-archetype validation

After the `_id` collision check and before doc insertion: if `archetype` was provided, look it up via `getArchetype(id)`. If unknown, return an `isError` response:

```
Unknown archetype: "foo". Known: software-engineer.
```

This catches typos and hallucinations at the tool call, not at agent-load time. The archetype's own `validateConfig` still runs at load (per the archetype spec) to validate structural config — belt-and-suspenders.

### 1.4 `agent_update` — mirror the creation-surface changes

Apply Q7a to `agent_update` (admin-mcp-server.ts line 228):
- Promote `homeBase`/`archetype`/`title`/`soul`/`systemPrompt` to top-level for schema parity and LLM discoverability.
- Reject unknown `archetype` at tool level (same check as 1.3).

**No silent-drop fix needed here:** unlike `agent_create`, `agent_update` already uses `$set: { ...fields, updatedAt, updatedBy }`, which writes any key the caller provides — archetype/title/archetypeConfig flow through untouched today. The only concrete change is schema surface + unknown-archetype validation.

This is what makes the out-of-scope Alex retrofit tractable later: it's one `agent_update` call with the right fields.

### 1.5 New admin tool: `list_archetypes`

Self-documenting archetype catalog for the skill (and for future tooling). Shape:

```ts
[
  {
    id: "software-engineer",
    description: "Owns codebases and ships production code through disciplined delivery (ticket → spec → PR → CI → close).",
    whenToUse: "Pick this when the agent's core job is writing, reviewing, or shipping production code. For product strategists, marketers, or anyone where code is incidental, use a plain agent.",
    configSchema: {
      workshop: {
        type: "string",
        required: true,
        description: "Absolute filesystem path — the engineer's bounded root directory (e.g. /Users/you/dev)."
      },
      workspaces: {
        type: "array",
        required: false,
        description: "Registered codebases inside the workshop. Do NOT prompt for these at creation time — workspace registration is a separate admin flow. Start with an empty array."
      }
    }
  }
]
```

No parameters. Returns the full registered catalog. Registry is populated at startup (already wired).

### 1.6 `ArchetypeDefinition` type extension

Add three optional fields to the archetype interface in `src/archetypes/registry.ts`:

```ts
interface ArchetypeDefinition<Config = unknown> {
  id: string;
  description?: string;
  whenToUse?: string;
  configSchema?: Record<string, { type: string; required: boolean; description: string }>;
  // ... existing: validateConfig, systemPromptCard, preToolUseHooks, memoryScopes, sessionOptions
}
```

All three are optional — missing = archetype stays usable but `list_archetypes` returns it as bare `{ id }`. This keeps backward-compatibility with any archetype registered before the field lands.

### 1.7 Software-engineer archetype — populate self-description

Update `src/archetypes/software-engineer/index.ts` to pass the three new fields into `registerArchetype`. Content as shown in 1.5. Source of truth for `description` and `whenToUse` is this spec.

## Phase 2 — Skill rewrite

Target: `seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md`.

Current: 170-word stub. Replacement: materialized per `2026-04-08-agent-builder-design.md`, condensed from design prose into executable skill format.

### 2.1 Skill structure

Nine numbered steps, each a short imperative paragraph (not prose). Maps 1:1 to the spec's Skill Flow section:

1. **INTAKE** — get the one job the agent does.
2. **PERSONA** — shape who they are as a person.
3. **MAP** — capabilities needed (common sense, no lookup table).
4. **CHECK** — call `instance_capabilities` to see what's configured.
5. **GAP** — flag missing integrations, ask if needed now or later.
6. **PROPOSE** — plain-language summary, no jargon.
7. **CONFIRM** — user approves or tweaks.
8. **CREATE** — `agent_create` with the mapped fields.
9. **INTRODUCE** — tell the user where to find the agent + one thing to try.

### 2.2 Discipline-vs-role-shape detection

New substep within MAP (step 3): after gathering the job, call `list_archetypes`. For each returned archetype, compare the user's described role against `whenToUse`. If there's a clear match, set `archetype` + `title` on the resulting agent; otherwise create a plain agent.

Skill prompt language: *"Most agents are plain — they're defined by their soul and system prompt. A few roles are disciplines with shared infrastructure (e.g. software-engineer owns codebases and writes code through PRs, not free-text Edit). Use `list_archetypes` to see what disciplines exist. If the user's described role matches an archetype's `whenToUse`, pick it. Otherwise, go plain."*

For MVP this decision collapses to: *"Is the agent primarily a software engineer?"*. New archetypes expand the space automatically via `list_archetypes`.

### 2.3 Archetype-specific config gathering — SE branch

If `archetype: "software-engineer"`, skill inserts one extra question during MAP:

> *"What's your engineering root directory? That's where the engineer will prototype and where codebases live. Default: `~/dev`."*

Validate the path exists and is a directory before proceeding. Preferred: call a dedicated admin helper (e.g. extend `instance_capabilities` with a `verify_path` tool, or add a thin `path_check` admin tool). Fallback: if the chief-of-staff already has Bash whitelisted for its session, use `test -d`. Do NOT rely on Bash being available — the skill runs inside an SDK session where tool availability depends on agent config.

Pass as `archetypeConfig: { workshop: "/expanded/absolute/path", workspaces: [] }`.

**Workspaces are not asked for at creation.** The archetype works without them; workspace registration is a future separate admin flow.

### 2.4 Guardrails section

Ported verbatim from the 2026-04-08 spec's Guardrails section:

1. One job, not a job description.
2. Start minimal.
3. Don't offer what wasn't asked.
4. No jargon.
5. When in doubt, leave it out.
6. Name them like a person.
7. Default to restrictive (Haiku ceiling, low budget, limited servers).

### 2.5 Defaults the skill must pass explicitly

- `autonomy: { externalComms: false }` — system default is `true`; skill must opt out unless the user approved outbound comms in the conversation.
- No need to pass `coreServers` unless overriding; Phase 1's default picks it up.
- `homeBase` — skill must construct this (e.g. `agent-<id>`) and tell the user to create the Slack channel.

### 2.6 Reference examples

Include the four example profiles from 2026-04-08 (inbound communicator, scheduled reporter, outbound coordinator, internal operator) condensed to 3-5 lines each. Model uses for calibration.

## Test strategy

### Phase 1 unit tests

- `AGENT_DEFINITION_DEFAULTS.coreServers` — exported correctly, matches the baseline.
- `agent_create` with no `coreServers` in fields → doc has baseline coreServers.
- `agent_create` with `coreServers: ["admin"]` → doc has `["admin"]` (no auto-merge; caller is explicit).
- `agent_create` with `archetype: "software-engineer"` + `archetypeConfig: { workshop: ... }` → doc has both set (regression test for the silent-drop bug).
- `agent_create` with `archetype: "foo"` → isError with known-archetype list.
- `agent_update` — mirror tests: archetype/title/archetypeConfig write-through, unknown archetype rejected.
- `list_archetypes` returns the registered catalog with description/whenToUse/configSchema.
- `ArchetypeDefinition` registration without the new optional fields still works (backward compat).

### Phase 2 validation

The skill is prose; correctness is validated by Hermi creating a new agent and the agent being functional. No automated test — the proof is "Hermi creates agent X, it has memory/keychain/contacts, it posts to Slack, it remembers across sessions." Manual verification captured as acceptance criteria in the Phase 2 ticket.

## Non-goals (explicit)

- Retrofit existing agents (Sam/Alex/Luna) — one-off admin op, not design.
- New archetypes — YAGNI.
- Workspace registration UX — deferred per 2026-04-09.
- Auto-provisioning Slack channels — still requires human admin.
- UI/visual builder — conversational only, matches agent-builder spec.
- Expanding `agent_create` beyond the creation-boundary fields — runtime tuning stays in `fields`.

## Rollout

Phase 1 and Phase 2 ship serially:

1. **Phase 1** merges first. No visible effect until an agent creation happens — then the creation is sound even with the current stub skill. Safe to land behind whatever gate.
2. **Phase 2** merges second. Flips Hermi's creation UX to the designed flow. No `setup:seeds` re-run required — per Risk #2, SKILL.md is read from disk at session start, so Hermi picks up the new skill on her next message after the package deploys.
3. **Post-landing:** Alex retrofit as a one-off admin op — `agent_update alexandria archetype: software-engineer, archetypeConfig: { workshop: "/Users/may/dev", workspaces: [] }, title: "Head of Product"`. Validation: restart Alex's session, check archetype card renders, verify she has the discipline framing in her system prompt.

## Risks

1. **Existing agents with `coreServers: []` are not auto-backfilled.** Defaults apply at creation, not at load. Any agent already in MongoDB stays broken until manually updated. Mitigation: `admin_mcp::agent_list` → check `coreServers` — documented as a post-deploy operational task.
2. **Seed import behavior on skill updates.** The `setup:seeds` script writes MongoDB agent documents and does not touch `SKILL.md` files. Skill markdown is read from disk at session start by the chief-of-staff. Phase 2 ships a new SKILL.md; it lands in the deployed package (`pkg/` or source) and Hermi picks up the new markdown on her next session. No cache to invalidate.
3. **`list_archetypes` drift.** If an archetype module registers itself but forgets to set description/whenToUse, the skill may fail to recognize it as a match and default to plain. Mitigation: lint rule or CI check that every registered archetype has all three discovery fields. Out of scope for this spec but noted.
4. **`configSchema` expressiveness.** The shape chosen is intentionally flat — `{ type, required, description }` per key. Complex nested archetypes (e.g. `workspaces: { items: { tracker: { oneOf: [...] } } }`) will need richer schema eventually. For MVP with one archetype whose workspaces-field is deferred, this is sufficient.

## Implementation plan outline

Details via `dodi-dev:write-plan` per phase.

**Phase 1 ticket** — Admin MCP & defaults
- Modified: `src/types/agent-definition.ts` (defaults baseline)
- Modified: `src/admin/admin-mcp-server.ts` (agent_create + agent_update schemas, doc construction, unknown-archetype check, new list_archetypes tool)
- Modified: `src/archetypes/registry.ts` (ArchetypeDefinition interface extension)
- Modified: `src/archetypes/software-engineer/index.ts` (populate new fields)
- Tests: `src/admin/admin-mcp-server.test.ts` (new cases), `src/archetypes/registry.test.ts` (new cases)

**Phase 2 ticket** — Skill rewrite
- Modified: `seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md`
- No other file changes
- Validation: manual — Hermi creates a test agent; verify archetype set, coreServers populated, soul/systemPrompt shaped from conversation

## Open questions

1. **Should the skill gather `delegateServers` at creation?** Today the current skill doesn't prompt for it, and Hermi set `delegateServers: []` for all three of her creations. If the agent's job involves heavy delegation (e.g. a coordinator that routes work to specialists), this is a gap. Out of scope for MVP; revisit after observing real usage.
2. **Model-selection rubric.** Agent-builder spec says skill picks Haiku/Sonnet based on complexity, but the heuristics are prose-vague. Observable behavior may reveal whether we need structured guidance. Out of scope; revisit post-rollout.
