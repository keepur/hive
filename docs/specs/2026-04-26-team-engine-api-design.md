# Team — Engine-Native API — Design Spec

**Date:** 2026-04-26
**Author:** May (CEO) + Mokie (Opus)
**Linear:** KPR-79
**Triggered by:** Recurring papercut all session — `shared/business-context.md` carries a duplicated team-roster table because there's no engine-level concept of "team." The contacts MCP can't be trusted as authoritative (mixed with 7,000+ HubSpot records), `agent_definitions` lives outside any roster surface, and the memory blob has to be hand-edited every time the team changes. Business-context literally tells agents *"use this table — not the contacts database, which may have outdated or incorrect data."* That's a code smell the duplicate exists to work around.

## Problem

Today, "who's on the team" is answered three different ways depending on the agent's context:

1. **Memory blob** (`shared/business-context.md`) — a hand-maintained table CoS edits. Read into every agent's session prompt. Stale by design — every team change requires a memory edit.
2. **`contacts` MongoDB collection** — 7,711 records on dodi, mostly HubSpot-synced customer data. Mixed with humans we'd consider team. No way to filter "team only." No agent records at all.
3. **`agent_definitions` MongoDB collection** — engine-managed; the live source of truth for AI agents. Not exposed as a roster query.

There's no engine primitive that says "give me the team." Agents can't reliably look up a teammate without scraping a memory document. Updating team membership requires editing a memory file *and* updating agent definitions, depending on whether it's a human or agent. The duplication is the bug.

## Goals

1. **Engine exposes team membership as a first-class primitive.** Built-in tools every agent gets (alongside core SDK tools), not gated through a swappable plugin or feature-flagged MCP.
2. **Single source of truth per actor type.**
   - **Team-agents:** queried directly from `agent_definitions`. No mirroring, no synthetic email shenanigans, no upsert dance. The live document IS the source.
   - **Team-humans:** stored in the existing `contacts` collection with `category: "team-human"`. CoS edits via the existing contacts MCP write path (`contacts_create` / `contacts_update`).
3. **Cache layer** at engine level for hot-path lookups; invalidated when CoS performs agent-management actions (admin MCP writes) or team-human contacts are updated.
4. **The team table in `shared/business-context.md` goes away.** Replaced by a concise summary auto-injected into the system prompt (generated from live data) plus tool calls for full detail.

## Non-goals

- **Splitting customer/CRM contacts out of the `contacts` collection** — KPR-80 (filed). The current spec works alongside the mixed namespace; the `category` filter is the contract. KPR-80 is a follow-up cleanup that becomes easier once `category` exists. Either order works.
- **Operator YAML / file-based roster.** Earlier draft proposed a `team-roster.yaml` operator-config; rejected by May. Team membership is live data; CoS updates it via the same channels as everything else (contacts MCP for humans, admin MCP for agents). No file CoS has to remember to edit.
- **Cross-instance team rosters.** `db.contacts` and `db.agent_definitions` are per-`hive_<id>`. Each instance has its own team. No federation in this spec.
- **Mirroring agent records into `contacts`.** Agents are already in `agent_definitions`; the team API joins them in at query time.
- **Replacing HubSpot as the customer-record source of truth.** HubSpot stays authoritative for customers. This spec only reaches authoritative-status for the team-roster slice.

## Design

### Schema: add `category` to ContactDoc

Extend the existing `contacts` document shape with one new field:

```ts
type ContactCategory =
  | "team-human"   // current team member, curated via contacts MCP
  | "customer"     // HubSpot-sourced; the bulk of the dataset today
  | "vendor"       // service providers, partners-by-payment
  | "partner"      // strategic partners, non-payment relationships
  | "archived";    // former team-human / stale customer / no-longer-active
```

`category` is **optional** for backward compatibility. Records without it are treated as "uncategorized" by the team API (excluded from team queries; remain queryable via the unchanged `contacts_search`/`contacts_get`/`contacts_list` tools). The migration (below) backfills `category` on all current records to keep the DB consistent.

Note: `team-agent` is **not** in the enum. Agents live in `agent_definitions`, not contacts. The team API joins them in at query time.

Additional optional field: `pronouns` on `ContactDoc`. Existing records without it remain valid.

### Engine team-API: built-in tools

Implementation lives in a new `src/team-roster/` module that exposes two surfaces:

1. **Internal TypeScript API** — `getTeam()`, `lookupHuman()`, `lookupAgent()`, `teamSummary()` — imported by engine code (agent-runner, dispatcher) directly. No MCP overhead for engine-internal callers.
2. **Agent-facing tools** — exposed via an in-process team-roster MCP server (`src/team-roster/team-roster-mcp-server.ts`) that shares the same cache instance as the internal API.

**Wiring (the "core access, not plugin" requirement):** `agent-runner.ts` unconditionally prepends the team-roster MCP server to every agent's MCP server list, regardless of what's in the agent's `coreServers` config. The established pattern for "always-on built-ins" lives in `agent-runner.ts` at the `filterCoreServers` helper (around lines 866-883) and the `INFRASTRUCTURE_SERVERS` list (around line 937 — servers in this list are wired in but hidden from the agent's "## Your tools" prompt section). Plan-stage adds `coreSet.add("team-roster")` to `filterCoreServers` and adds `"team-roster"` to `INFRASTRUCTURE_SERVERS`. Agents cannot opt out — any attempt in agent config to remove or override `team-roster` is ignored by the runner. Roster lookup is foundational (every agent needs to know who's on the team for routing, mentions, escalation), so it's an engine primitive, not a swappable plugin.

**Naming and the existing `team` MCP server:** there is already an unrelated `team` MCP server at `src/team/team-mcp-server.ts` for direct agent-to-agent messaging (feature-flagged via `team.enabled`; tools `send_message`, `list_agents`). The new module is named `team-roster` to keep concerns separate (messaging vs. roster lookups). Tool names are prefixed `team_*` (`team_list`, `team_lookup_human`, `team_lookup_agent`) and do not collide with the existing server's unprefixed tools. The two modules will coexist; future consolidation (if desired) is out of scope for this spec.

The MCP server runs **in-process** (not stdio subprocess) so it shares the cache with the internal API. This is a deliberate exception to Hive's stdio-subprocess MCP norm — the cache invariants require single-process state, and roster data has no isolation/security argument for separate-process execution.

**Implementation mechanism:** the in-process server is built using `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`. `agent-runner.ts` injects it into the agent's `mcpServers` map alongside the existing stdio entries (which use `mcpPath(...)` and `type: "stdio"`). The server's tool handlers close over the same `teamCache` singleton imported by engine code, so internal callers and agent tool calls hit identical state.

**Note for plan stage:** this would be the **first in-process (`createSdkMcpServer`) server in the codebase** — every existing MCP server is a stdio subprocess. Plan should include a smoke test confirming the in-process server registers correctly in the SDK's `mcpServers` map alongside stdio entries, and that agents can invoke its tools end-to-end.

```
team_list
  Args: { includeArchived?: boolean, includeAgents?: boolean }
  Returns: TeamMember[]
  Description: List the team. Defaults: active humans + active agents,
               sorted by category then name. Set includeArchived=true to
               include archived humans and deactivated agents. Set
               includeAgents=false to filter to humans only.

team_lookup_human
  Args: { name?: string, email?: string }    // exactly one required
  Returns: TeamMember | null
  Description: Look up a team-human by name or email.
  Scope: only records where `category === "team-human"`. Records without
         `category`, or with another category, are not matched even if
         their name/email matches the query.
  Match semantics:
    - by email: case-insensitive exact match against `ContactDoc.email`
                (both sides lowercase-normalized; records with null email skipped)
    - by name: case-insensitive exact match against `ContactDoc.name`. If
               `name` is empty on a record (sparse HubSpot rows), fall back
               to matching `firstName + ' ' + lastName`. No fuzzy/partial
               match — agents should pass the full display name.
    - returns null if zero matches; if multiple match, returns most recently updated

team_lookup_agent
  Args: { agentId?: string, name?: string }    // exactly one required
  Returns: TeamMember | null
  Description: Look up a team-agent by id or display name.
  Match semantics:
    - by agentId: exact match against `AgentDefinition._id` (case-sensitive —
                  agentIds are stable identifiers)
    - by name: case-insensitive exact match against `AgentDefinition.name`
               OR any entry in `AgentDefinition.aliases[]`. Aliases exist
               for nickname routing ("Sam" → "Samantha"); ignoring them
               would be a footgun.
    - returns null if zero matches
```

`TeamMember` shape:

```ts
interface TeamMember {
  kind: "human" | "agent";
  id: string;            // human: contacts._id.toHexString(); agent: agent_definitions.agentId (string)
  name: string;
  email?: string;        // humans always have one; agents may not
  role?: string;
  pronouns?: string;
  category: "team-human" | "team-agent" | "archived";
  // Note: `team-agent` is synthesized at query time from agent_definitions;
  // it is NOT a stored ContactDoc category (see `ContactCategory` enum above).
  // Agent-only fields; undefined for humans:
  agentId?: string;
  slackChannel?: string;
  model?: string;
  active?: boolean;      // agents: from agent_definitions; humans: derived from category
}
```

Validation: handlers MUST guard "exactly one arg required" at the top of their bodies (Zod can't enforce declaratively). Plan-stage tests cover both/neither cases.

### Cache layer

The team module holds an in-memory cache with two slices:

- **`humans`** — team-human contacts (lowercased-email index + name index).
- **`agents`** — agent_definitions records (agentId index + name index).

Both populate lazily on first lookup and invalidate explicitly on writes:

- **Agents slice invalidates** by subscribing to `agent-registry`'s post-reload event. Today, `agent_definitions` reloads happen on three triggers:
  - admin MCP write (create/update/disable) — eventually flows through `registry.load()` via the change-stream path.
  - MongoDB change-stream / poll detecting any mutation (admin-driven or out-of-band — direct DB edit, REST API write).
  - SIGUSR1 signal — invokes the reload function in `index.ts`, which calls `registry.load()`.

  Importantly, **`AgentRegistry` today already has a field named `onReload`** but with **opposite semantics** to what we want — it's a *pre*-reload pull-trigger (single callback set by constructor; fires when the change-stream detects a mutation, used to schedule a debounced reload in `index.ts`). This spec commits to two small changes in `agent-registry.ts`:

  1. Rename the existing `onReload` field to `onChangeDetected` to disambiguate (it's a change-detection trigger, not a reload-completion event).
  2. Add a new multi-subscriber `onPostReload(handler)` emitter on `AgentRegistry`. It fires from **inside `registry.load()`** *after* the new state is committed (`this.agents` updated, `rebuildOriginIndex()` complete) — not from `index.ts`. Firing inside `load()` ensures every path that successfully updates the registry's view of `agent_definitions` notifies subscribers, regardless of who initiated the reload.

  The team-roster cache subscribes to `onPostReload` and invalidates the agents slice. This single subscription covers all three triggers (admin write, change-stream, SIGUSR1) because they all converge on `registry.load()`.

- **Humans slice invalidates** via a MongoDB change-stream watcher on the `contacts` collection, **running in the engine process** (started alongside the team-roster module init in `src/index.ts` or the team-roster bootstrap). The contacts MCP runs as a stdio subprocess with no shared memory with the engine — it cannot call `teamCache.invalidateHumans()` directly — so the engine-side change-stream is the sole invalidation channel. The watcher fires on **any write to the `contacts` collection** and calls `teamCache.invalidateHumans()` in-process. Coarse-by-design: the humans cache holds <100 records, repopulate-on-next-read is cheap, and this avoids MongoDB pre-image setup (which would be required to detect `team-human` → `archived` transitions precisely — pre-image requires `changeStreamPreAndPostImages` enabled on the collection via `collMod`, plus `fullDocumentBeforeChange` on the `watch()` call; not currently enabled on any collection in the codebase). Acceptable trade: HubSpot's nightly customer-sync writes will trigger ~7K wasted invalidations per night, but each repopulate is a single small query against a tiny filtered set. Polling fallback applies if change-stream is unavailable (same fallback the agent-registry already uses). This means the humans-slice mechanism is symmetric with the agents-slice — both rely on engine-side change-stream observation, neither relies on a subprocess→engine call.

- **Invalidation timing:** the engine-side change-stream watcher fires **after the Mongo write commits and is observable in the oplog** — not before, not on uncommitted intermediate state. This is a property of MongoDB's change-stream semantics, not something the spec needs to enforce in code. (Symmetric with the agents-slice via `registry.load()` re-reading committed state.)

- **Latency profile** (agents and humans slices both):
  - Change-stream mode (typical): write commits → oplog event → change-stream `on("change")` fires → `onChangeDetected` schedules a 500ms debounced reload (agents) or direct invalidation (humans) → cache invalidates. Window: ~500ms-1s end-to-end.
  - Polling-fallback mode: window grows to ~poll-interval+500ms (agent-registry today polls every 30s when change-stream unavailable; humans-slice watcher uses the same configuration).
  - Worst-case bound: 60s TTL.

  No synchronous admin-write→cache-invalidate path exists. Acceptable because admin/team-human writes are operator-driven and infrequent; plan-stage tests should write to the latency window stated above, not assume immediate consistency.

- **TTL fallback:** 60s soft expiry on both slices. Defense-in-depth in case an invalidation hook is missed; explicit invalidation usually kicks in first.

The cache lives in-process per Hive instance (each instance is a single process — no cross-process distribution needed). The cache module exports `invalidateAgents()` / `invalidateHumans()` as the public hook surface; both are called only from in-process subscribers (the agent-registry `onPostReload` listener and the engine-side contacts change-stream watcher). The contacts and admin MCPs themselves run as stdio subprocesses and are not aware of the cache — they write to MongoDB; the change-stream-based propagation does the rest.

### System-prompt injection

Currently `shared/business-context.md` is read into every agent's session prompt and contains the team table. Two ways the new team API could surface to agents:

- **Pull-only:** agent calls `team_list` when it needs to know the team.
- **Push-summary + pull-detail:** a concise team summary (names + roles + agent-ids + channels, ~10–15 lines) auto-injected into the system prompt; full details (email, pronouns, etc.) via tool call.

**Decision: push-summary + pull-detail.** Agents commonly need to know "who's on the team" without explicitly asking — that's why the table was injected in the first place. A 10-15 line summary is well under the hot-tier budget. Full details come via tool call when needed.

Injection lives in `agent-runner.ts` system-prompt assembly. The actual assembly order in code is: `systemPrompt → constitution → tool catalog → delegate summary → memory (hot-tier or legacy blob)`. `team_summary()` is called inline and slotted in **immediately after the constitution push, before the tool catalog**. Rationale: team-summary content is identity-context (who's on the team, who reports to whom), semantically constitution-adjacent. Tool catalog and delegate summary are technical wiring — keeping team summary close to constitution groups related identity content together, and lets constitution prose reference "the team summary below" or the team-API tools without forward-reference issues.

The summary is generated from the same cached data the tools use, so there's no extra DB hit per session beyond the cache populate.

### Migration (dodi)

One-time cleanup script at `scripts/migrate-contacts-categories.ts`. Operations:

1. **Delete obvious test rows.** `email: /^layna\+test/` and similar known-stale entries. Show diff via `--dry-run`; require `--apply` to commit.
2. **De-duplicate by lowercase email.** Records sharing `email` after lowercase normalization → keep the most recently updated, archive the others (set `category: "archived"`, retain for audit).
3. **Backfill `category`** on remaining records, with the rules below applied **in order — first match wins**:
   - **(precedence 1)** Match team-humans by email. Lowercase-normalize the contact's email and compare against a hard-coded list of current team-member emails (May, Corey, Aaron, Angus, Angela, Lauren, Zhitong, Mike). On match → `category: "team-human"`. This rule takes precedence over the `source: "hubspot"` rule — a HubSpot-synced record whose email belongs to a team member is categorized as team-human, not customer. After migration, CoS verifies via `team_list` and uses `contacts_update` to fix any misses.
   - **(precedence 2)** `source: "hubspot"` (and not matched above) → `customer`.
   - **(precedence 3)** Everything else (manually-created, unknown source) → `customer` (default; operator can re-categorize via `contacts_update`).
4. **Mark stale/former team members archived.** Konstantin (former Director of Operations) and other no-longer-present entries → `archived`.

**Caveat on email-typo collapse (applies to step 2):** step 2 only collapses records whose emails are *identical after lowercasing* — it does NOT fix typos like `cotry@dodihome.com` vs `corey@dodihome.com` (distinct strings won't collide). Known-bad emails must be corrected manually by the operator either before migration (edit the source row) or after (`contacts_update` to fix the email, then re-run the backfill on that record).

**Restore semantics:** the migration NEVER hard-deletes (test rows in step 1 are the only true deletes — those are intentionally trash). De-duped records (step 2) get `category: "archived"`, retaining the document for audit. To restore a mistakenly-archived record, operator runs `contacts_update` to flip `category` back. The `--dry-run` mode writes the full diff to `/tmp/kpr-79-migration-<timestamp>.diff`; `--apply` writes the same diff for post-hoc reference.

Keepur's instance has only a handful of contacts — same script, much less to clean up.

### Removing the duplicate from `business-context.md`

After the team API is wired and migration runs:

1. Delete the team-roster table from `db.memory[shared/business-context.md]` on dodi (and keepur, and any other instance).
2. Delete the "use this table — not contacts DB" footnote.
3. Update the constitution / agent prompts to reference the team API tools instead of the table.
4. Mokie's onboarding skill (KPR-71) starts using `team_list` / `team_lookup_human` / `team_lookup_agent` rather than the table.

Net token savings per session-load: ~1.5 KB / ~30 lines × every agent × every conversation. Not large per-session; adds up across the full agent population — and more importantly, eliminates the staleness footgun entirely.

## Acceptance criteria

- [ ] `category` field added to `ContactDoc`; existing tools transparent over its presence/absence
- [ ] `pronouns` field added to `ContactDoc` (optional)
- [ ] New `src/team-roster/` module implements `team_list`, `team_lookup_human`, `team_lookup_agent` with cache layer (lazy populate, explicit invalidate, 60s TTL fallback)
- [ ] Built-in tools wired into `agent-runner.ts` system-prompt assembly (universal, can't be opted out)
- [ ] System-prompt assembly includes a concise team summary generated from live data (replaces the table from `business-context.md`)
- [ ] Cache invalidation wired via (a) an `AgentRegistry.onPostReload` subscriber for the agents slice (registry's existing `onReload` field renamed to `onChangeDetected`; new `onPostReload` multi-subscriber emitter fires from inside `registry.load()` after state commit), and (b) an engine-side MongoDB change-stream watcher on `contacts` for the humans slice (coarse — invalidates on any write to the collection); polling fallback for both when change-stream unavailable. MCP subprocesses do NOT call invalidation hooks directly.
- [ ] Migration script `scripts/migrate-contacts-categories.ts` runs cleanly on dodi + keepur (with `--dry-run` and `--apply`)
- [ ] Team-roster table + "use this table" footnote removed from `business-context.md` on dodi and keepur (post-migration)
- [ ] Constitution updated to reference team API; Mokie's onboarding skill (KPR-71) uses the new tools
- [ ] No regression on existing `contacts_search`/`contacts_get`/`contacts_list`/`contacts_create`/`contacts_update`

## Coordination with sibling tickets

- **KPR-80** (split customer/CRM contacts out of the `contacts` collection) — follow-up. The `category` enum introduced here is the contract KPR-80 uses to identify what to move. Either order works; KPR-80 becomes mechanical once `category` is populated.
- **KPR-71** (CoS onboarding refinement) — once the team API lands, Mokie's onboarding flow uses it for "who's on the team" rather than the business-context table.
- **KPR-78** (CoS environment audit) — Mokie's prompt + memory references should switch to team API for roster queries.

## Open design questions

1. **System-prompt summary format and depth.** Markdown table with `name | role | channel?`, or a more compact pipe-delimited line per row? Should `pronouns` be in the auto-injected summary or only via `team_lookup_human`? Lean: simple markdown table; include pronouns inline (cheap, useful for tone).

## Path to implementation

Once spec is review-clean → KPR-79 advances to Plan Drafting. Plan covers:

1. Schema additions + types (~20 LOC)
2. `src/team-roster/` module: cache + lookup primitives + `team_summary()` (~140 LOC + tests)
3. Built-in tools wired in `agent-runner.ts` (~40 LOC + tests)
4. System-prompt summary injection (~30 LOC + tests)
5. Cache invalidation wiring: rename `AgentRegistry.onReload` → `onChangeDetected`; add `onPostReload` multi-subscriber emitter fired from inside `registry.load()` after state commit; team-roster bootstrap subscribes to `onPostReload` (agents slice) and starts an engine-side MongoDB change-stream watcher on `contacts` (humans slice). MCP subprocesses are NOT modified for invalidation. (~30 LOC across `agent-registry.ts` + team-roster bootstrap)
6. Smoke test for the in-process `createSdkMcpServer` server: confirm it registers correctly in agent-runner's `mcpServers` map alongside stdio entries and that agents can invoke `team_list` / `team_lookup_human` / `team_lookup_agent` end-to-end (~20 LOC test)
7. Migration script (~100 LOC + tests + dry-run)
8. Run migration on dodi + keepur
9. Update business-context (db.memory) on both instances
10. Update Mokie's onboarding skill / constitution references

Estimated 2-3 days of focused work after plan-clean.
