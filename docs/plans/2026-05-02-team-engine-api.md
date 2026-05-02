# Team Engine API — Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Linear:** KPR-139
**Spec:** `git show e877440:docs/specs/2026-04-26-team-engine-api-design.md` (the file was moved to private `keepur/hive-docs` after PR #220's docs-prune; commit content is canonical).

**Goal:** Replace the duplicated team table in `shared/business-context.md` with a live, engine-injected team summary fed by authoritative sources — agents from `agent_definitions`, humans from `contacts` with `category: "team-human"` — plus three built-in tools (`team_list`, `team_lookup_human`, `team_lookup_agent`) every agent gets.

**Architecture:** New `src/team-roster/` module exposing an internal TS API + an in-process MCP server (the codebase's first `createSdkMcpServer` server — every existing MCP is stdio). Two-slice in-memory cache (humans + agents) with explicit-invalidation hooks: agents-slice subscribes to `AgentRegistry.onPostReload` (a new emitter we're adding); humans-slice listens to a new engine-side change-stream watcher on `contacts`. Auto-injected into every agent's MCP server map by `agent-runner.ts` (cannot be opted out). Team summary slotted into the system prompt right after the constitution.

**Tech Stack:** TypeScript (strict), `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`), MongoDB change-streams, Vitest, Zod for tool input schemas.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/team-roster/types.ts` | `TeamMember`, `ContactCategory` enum, internal types | Create |
| `src/team-roster/team-cache.ts` | Two-slice (humans + agents) in-memory cache with TTL fallback + explicit invalidation hooks | Create |
| `src/team-roster/team-roster.ts` | Internal API: `getTeam()`, `lookupHuman()`, `lookupAgent()`, `teamSummary()` | Create |
| `src/team-roster/team-roster-mcp-server.ts` | In-process `createSdkMcpServer` — `team_list`, `team_lookup_human`, `team_lookup_agent` | Create |
| `src/team-roster/contacts-watcher.ts` | Engine-side MongoDB change-stream watcher on `contacts` → invalidates humans slice; polling fallback | Create |
| `src/team-roster/team-cache.test.ts` | Cache get/invalidate/TTL behavior | Create |
| `src/team-roster/team-roster.test.ts` | Lookup correctness + summary format | Create |
| `src/team-roster/team-roster-mcp-server.test.ts` | Tool handler I/O + edge cases (exactly-one-arg, miss, alias) | Create |
| `src/contacts/contacts-mcp-server.ts` (lines 24–39) | Add optional `category` + `pronouns` to `ContactDoc` | Modify |
| `src/agents/agent-registry.ts` (lines 22, 115–149) | Rename `onReload` → `onChangeDetected`; add `onPostReload(handler)` multi-subscriber emitter; fire from inside `load()` after state commits | Modify |
| `src/agents/agent-registry.test.ts` | Add tests for new `onPostReload` emitter | Modify |
| `src/agents/agent-runner.ts` (lines 856–887, 943–951, 207–297, 1205–1288) | Add `"team-roster"` to `coreSet` (line ~872) + `autoInjectedServerNames()` (line ~948 — note: spec calls this `INFRASTRUCTURE_SERVERS`; actual symbol in code is the static method `autoInjectedServerNames()`); inject in-process MCP server into `mcpServers` map; slot `teamSummary()` into prompt assembly after constitution and **before** `buildToolkitSection` call | Modify |
| `src/agents/agent-manager.ts:95` + `src/agents/agent-runner.test.ts` (lines 170, 186, 201, 214) | Update `new AgentRunner(...)` callsites for the new `teamRoster` constructor param | Modify |
| `src/index.ts` | Bootstrap: instantiate cache, wire `AgentRegistry.onPostReload` → `cache.invalidateAgents()`, start `contacts-watcher` | Modify |
| `scripts/migrate-contacts-categories.ts` | One-time migration: delete test rows, de-dup by email, backfill `category` | Create |
| `shared/business-context.md` (`memory` collection in MongoDB, path `shared/business-context.md`) | Remove the AI Agents and Humans tables once team summary is verified live | Modify (post-validation) |

---

## Task 0: Worktree environment

**Files:** none (verification only)

- [ ] **Step 1:** Confirm working directory and clean state.
  ```bash
  cd /Users/mokie/github/hive-KPR-139
  git status --short    # expect: clean
  git rev-parse --abbrev-ref HEAD    # expect: KPR-139
  npm install
  npm run typecheck    # baseline pass before changes
  npm run test         # baseline — record any pre-existing failures so we don't blame our changes
  ```
- [ ] **Step 2:** Confirm Mongo is reachable and `hive_dodi.contacts` has the seeded team-humans (`category: "team-human"`, count = 8) — if not, the implementation can still proceed but integration validation later will need that data.

---

## Task 1: Schema additions to `ContactDoc`

**Files:**
- Modify: `src/contacts/contacts-mcp-server.ts:24-39`

This is a backward-compatible additive change — both fields are optional.

- [ ] **Step 1:** Add `ContactCategory` enum and extend `ContactDoc`.

  Replace the `ContactDoc` interface block at lines 24–39:
  ```ts
  type ContactCategory =
    | "team-human"   // current team member, curated via contacts MCP
    | "customer"     // HubSpot-sourced; the bulk of the dataset historically
    | "vendor"       // service providers, partners-by-payment
    | "partner"      // strategic partners, non-payment relationships
    | "archived";    // former team-human / stale customer / no-longer-active

  interface ContactDoc {
    _id: ObjectId;
    name: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phones: PhoneEntry[];
    company?: string;
    role?: string;
    pronouns?: string;
    tags: string[];
    notes?: string;
    source: string;
    sourceId?: string;
    category?: ContactCategory;
    createdAt: Date;
    updatedAt: Date;
  }
  ```

- [ ] **Step 2:** Verify.
  ```bash
  npm run typecheck
  ```
  Expected: passes (the additive optional fields don't break any caller).

- [ ] **Step 3:** Commit.
  ```bash
  git add src/contacts/contacts-mcp-server.ts
  git commit -m "feat(contacts): add optional category + pronouns to ContactDoc (KPR-139)"
  ```

---

## Task 2: `AgentRegistry` refactor — rename `onReload` and add `onPostReload`

**Files:**
- Modify: `src/agents/agent-registry.ts` (line 22 field, constructor lines 24–26, `load()` lines 29–112, change-stream watcher lines 115–131, polling fallback lines 134–149)
- Modify: `src/agents/agent-registry.test.ts` (add `onPostReload` tests)
- Modify: `src/index.ts` (rename callsite of constructor option `onReload` → `onChangeDetected`)

The existing `onReload` field has pre-reload semantics — it fires when a change is **detected**, before `load()` runs. We're renaming it to `onChangeDetected` (clarity) and adding a separate `onPostReload(handler)` multi-subscriber emitter that fires from inside `load()` after the new state commits.

- [ ] **Step 1:** Rename field + constructor option.

  In `src/agents/agent-registry.ts`:
  - Line 22: change `private onReload?: () => void;` → `private onChangeDetected?: () => void;`
  - Lines 24–26 (constructor): change parameter `onReload` → `onChangeDetected`, store under new name. (Keep the type as `() => void`.)
  - Line 120 (change-stream `on("change")`): `this.onReload?.()` → `this.onChangeDetected?.()`
  - Line 142 (polling fallback): `this.onReload?.()` → `this.onChangeDetected?.()`

- [ ] **Step 2:** Add multi-subscriber `onPostReload` emitter.

  Add to the class (place near top with other private fields):
  ```ts
  private postReloadHandlers: Array<() => void> = [];

  public onPostReload(handler: () => void): () => void {
    this.postReloadHandlers.push(handler);
    return () => {
      const i = this.postReloadHandlers.indexOf(handler);
      if (i >= 0) this.postReloadHandlers.splice(i, 1);
    };
  }

  private firePostReload(): void {
    for (const h of this.postReloadHandlers) {
      try { h(); } catch (err) { log.warn("onPostReload handler threw", { err }); }
    }
  }
  ```

  Call `this.firePostReload()` from inside `load()` **immediately after `this.rebuildOriginIndex()` (current line 111)**, so subscribers see the fully-committed new state.

- [ ] **Step 3:** Update the callsite in `src/index.ts`.

  Find the `new AgentRegistry({ ... onReload: ... })` site (grep for `onReload`). Rename the option to `onChangeDetected`. Behavior is unchanged — same callback (which schedules the debounced reload).

- [ ] **Step 4:** Add unit tests for `onPostReload`.

  Append to `src/agents/agent-registry.test.ts` (Vitest, real Mongo per existing pattern):
  ```ts
  describe("onPostReload", () => {
    it("fires after load() commits new state", async () => {
      const calls: string[] = [];
      const registry = new AgentRegistry({ /* ... existing test setup ... */ });
      registry.onPostReload(() => calls.push("a"));
      registry.onPostReload(() => calls.push("b"));
      await registry.load();
      expect(calls).toEqual(["a", "b"]);
    });

    it("returns unsubscribe function", async () => {
      const calls: string[] = [];
      const registry = new AgentRegistry({ /* ... */ });
      const off = registry.onPostReload(() => calls.push("x"));
      await registry.load();
      expect(calls).toEqual(["x"]);
      off();
      await registry.load();
      expect(calls).toEqual(["x"]); // not fired again
    });

    it("isolates handler errors", async () => {
      const calls: string[] = [];
      const registry = new AgentRegistry({ /* ... */ });
      registry.onPostReload(() => { throw new Error("boom"); });
      registry.onPostReload(() => calls.push("after-throw"));
      await expect(registry.load()).resolves.not.toThrow();
      expect(calls).toEqual(["after-throw"]);
    });
  });
  ```

- [ ] **Step 5:** Verify.
  ```bash
  npm run typecheck
  npm run test -- src/agents/agent-registry.test.ts
  ```
  Expected: typecheck passes; new tests pass.

- [ ] **Step 6:** Commit.
  ```bash
  git add src/agents/agent-registry.ts src/agents/agent-registry.test.ts src/index.ts
  git commit -m "refactor(agent-registry): rename onReload→onChangeDetected, add onPostReload emitter (KPR-139)"
  ```

---

## Task 3: `team-roster` module — types

**Files:**
- Create: `src/team-roster/types.ts`

- [ ] **Step 1:** Create the types file.

  ```ts
  // src/team-roster/types.ts
  export type ContactCategory =
    | "team-human"
    | "customer"
    | "vendor"
    | "partner"
    | "archived";

  export interface TeamMember {
    kind: "human" | "agent";
    id: string;
    name: string;
    email?: string;
    role?: string;
    pronouns?: string;
    category: "team-human" | "team-agent" | "archived";
    updatedAt?: Date;  // used by pickMostRecent disambiguation in lookupHuman; humans only
    // Agent-only fields; undefined for humans:
    agentId?: string;
    slackChannel?: string;
    model?: string;
    aliases?: string[];
    active?: boolean;
  }
  ```

- [ ] **Step 2:** Verify typecheck.
  ```bash
  npm run typecheck
  ```

- [ ] **Step 3:** Commit (combine with Task 4 — types alone aren't worth a commit).

---

## Task 4: `team-roster` module — cache

**Files:**
- Create: `src/team-roster/team-cache.ts`
- Create: `src/team-roster/team-cache.test.ts`

Two slices, lazy populate, 60s TTL fallback, explicit invalidation hooks. Single in-process instance.

- [ ] **Step 1:** Create the cache.

  ```ts
  // src/team-roster/team-cache.ts
  import type { Db, ObjectId } from "mongodb";
  import { createLogger } from "../logging/logger.js";
  import type { TeamMember } from "./types.js";

  const log = createLogger("team-cache");
  const TTL_MS = 60_000;

  interface AgentDefDoc {
    _id: string;
    name: string;
    role?: string;
    model?: string;
    homeBase?: string;
    channels?: string[];
    aliases?: string[];
    disabled?: boolean;
  }

  interface ContactDoc {
    _id: ObjectId;
    name: string;
    firstName?: string;
    lastName?: string;
    email: string | null;
    role?: string;
    pronouns?: string;
    category?: string;
  }

  interface CacheSlice<T> {
    data: T[] | null;
    loadedAt: number;
  }

  export class TeamCache {
    private humans: CacheSlice<TeamMember> = { data: null, loadedAt: 0 };
    private agents: CacheSlice<TeamMember> = { data: null, loadedAt: 0 };

    constructor(private db: Db) {}

    invalidateHumans(): void {
      log.debug("humans slice invalidated");
      this.humans = { data: null, loadedAt: 0 };
    }

    invalidateAgents(): void {
      log.debug("agents slice invalidated");
      this.agents = { data: null, loadedAt: 0 };
    }

    async getHumans(): Promise<TeamMember[]> {
      if (this.humans.data && Date.now() - this.humans.loadedAt < TTL_MS) {
        return this.humans.data;
      }
      // Cache holds team-humans + archived (former team-humans) together so tools can:
      //   - team_list with includeArchived=true returns archived
      //   - lookupHuman() filters to category === "team-human" only (skips archived)
      const docs = await this.db
        .collection<ContactDoc & { updatedAt?: Date }>("contacts")
        .find({ category: { $in: ["team-human", "archived"] } })
        .toArray();
      const members: TeamMember[] = docs.map((d) => ({
        kind: "human" as const,
        id: d._id.toHexString(),
        name: d.name || `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim(),
        email: d.email ?? undefined,
        role: d.role,
        pronouns: d.pronouns,
        category: (d.category === "archived" ? "archived" : "team-human") as TeamMember["category"],
        updatedAt: d.updatedAt,
      }));
      this.humans = { data: members, loadedAt: Date.now() };
      return members;
    }

    async getAgents(): Promise<TeamMember[]> {
      if (this.agents.data && Date.now() - this.agents.loadedAt < TTL_MS) {
        return this.agents.data;
      }
      const docs = await this.db
        .collection<AgentDefDoc>("agent_definitions")
        .find({})
        .toArray();
      const members: TeamMember[] = docs.map((d) => ({
        kind: "agent" as const,
        id: d._id,
        name: d.name,
        role: d.role,
        category: d.disabled ? "archived" : "team-agent",
        agentId: d._id,
        slackChannel: d.homeBase ?? d.channels?.[0],
        model: d.model,
        aliases: d.aliases,
        active: !d.disabled,
      }));
      this.agents = { data: members, loadedAt: Date.now() };
      return members;
    }
  }
  ```

- [ ] **Step 2:** Add tests covering: get returns data, TTL re-fetches, invalidate forces re-fetch, isolation between slices.

  ```ts
  // src/team-roster/team-cache.test.ts
  import { describe, it, expect, beforeEach, vi } from "vitest";
  // (see existing src/agents/agent-registry.test.ts for the live-Mongo setup pattern)
  // Tests:
  //  - getHumans/getAgents return data from Mongo on first call
  //  - second call within TTL hits cache (assert no re-query — wrap collection.find with spy)
  //  - invalidateHumans clears humans only; agents stay cached
  //  - invalidateAgents clears agents only; humans stay cached
  //  - after TTL_MS via vi.useFakeTimers, next call re-fetches
  ```

- [ ] **Step 3:** Verify.
  ```bash
  npm run typecheck
  npm run test -- src/team-roster/team-cache.test.ts
  ```

- [ ] **Step 4:** Commit (with types from Task 3).
  ```bash
  git add src/team-roster/types.ts src/team-roster/team-cache.ts src/team-roster/team-cache.test.ts
  git commit -m "feat(team-roster): types + two-slice cache with TTL (KPR-139)"
  ```

---

## Task 5: `team-roster` module — internal API

**Files:**
- Create: `src/team-roster/team-roster.ts`
- Create: `src/team-roster/team-roster.test.ts`

- [ ] **Step 1:** Create the internal API.

  ```ts
  // src/team-roster/team-roster.ts
  import type { TeamCache } from "./team-cache.js";
  import type { TeamMember } from "./types.js";

  export interface TeamRosterOptions {
    includeArchived?: boolean;
    includeAgents?: boolean;
  }

  export class TeamRoster {
    constructor(private cache: TeamCache) {}

    async getTeam(opts: TeamRosterOptions = {}): Promise<TeamMember[]> {
      const includeArchived = opts.includeArchived ?? false;
      const includeAgents = opts.includeAgents ?? true;

      const humans = await this.cache.getHumans();
      const agents = includeAgents ? await this.cache.getAgents() : [];
      const all = [...humans, ...agents];
      const filtered = includeArchived ? all : all.filter((m) => m.category !== "archived");

      return filtered.sort((a, b) => {
        if (a.category !== b.category) return a.category.localeCompare(b.category);
        return a.name.localeCompare(b.name);
      });
    }

    async lookupHuman(args: { name?: string; email?: string }): Promise<TeamMember | null> {
      const haveName = typeof args.name === "string" && args.name.length > 0;
      const haveEmail = typeof args.email === "string" && args.email.length > 0;
      if (haveName === haveEmail) {
        throw new Error("lookupHuman: exactly one of name|email required");
      }

      const humans = (await this.cache.getHumans()).filter((m) => m.category === "team-human");

      if (haveEmail) {
        const target = args.email!.toLowerCase();
        const matches = humans.filter((m) => m.email && m.email.toLowerCase() === target);
        return pickMostRecent(matches);
      }

      const target = args.name!.toLowerCase();
      const matches = humans.filter((m) => m.name.toLowerCase() === target);
      return pickMostRecent(matches);
    }

    async lookupAgent(args: { agentId?: string; name?: string }): Promise<TeamMember | null> {
      const haveId = typeof args.agentId === "string" && args.agentId.length > 0;
      const haveName = typeof args.name === "string" && args.name.length > 0;
      if (haveId === haveName) {
        throw new Error("lookupAgent: exactly one of agentId|name required");
      }

      const agents = await this.cache.getAgents();

      if (haveId) {
        return agents.find((m) => m.agentId === args.agentId) ?? null;
      }

      const target = args.name!.toLowerCase();
      const direct = agents.find((m) => m.name.toLowerCase() === target);
      if (direct) return direct;
      return agents.find((m) => (m.aliases ?? []).some((a) => a.toLowerCase() === target)) ?? null;
    }

    async teamSummary(): Promise<string> {
      const team = await this.getTeam({ includeArchived: false, includeAgents: true });
      const humans = team.filter((m) => m.kind === "human");
      const agents = team.filter((m) => m.kind === "agent");

      const lines: string[] = ["## Team"];
      if (humans.length > 0) {
        lines.push("", "### Humans");
        for (const h of humans) {
          const role = h.role ? ` — ${h.role}` : "";
          lines.push(`- **${h.name}**${role}`);
        }
      }
      if (agents.length > 0) {
        lines.push("", "### AI Agents");
        for (const a of agents) {
          const role = a.role ? ` — ${a.role}` : "";
          const channel = a.slackChannel ? ` (\`#${a.slackChannel}\`)` : "";
          lines.push(`- **${a.name}**${channel}${role}`);
        }
      }
      lines.push("", "Use `team_lookup_human` / `team_lookup_agent` for full contact details.");
      return lines.join("\n");
    }
  }

  function pickMostRecent(matches: TeamMember[]): TeamMember | null {
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    const sorted = [...matches].sort((a, b) => {
      const aTs = a.updatedAt ? a.updatedAt.getTime() : 0;
      const bTs = b.updatedAt ? b.updatedAt.getTime() : 0;
      return bTs - aTs; // most recent first
    });
    return sorted[0];
  }
  ```

  > **Note:** `pickMostRecent` requires `TeamMember.updatedAt`; this was added in Task 3 (`types.ts`) and populated by the cache in Task 4 (`getHumans()`). Spec says "if multiple match, return most recently updated"; the migration script (Task 9) archives duplicates so this code path is rare in practice but correct when it fires.

- [ ] **Step 2:** Add tests.
  ```ts
  // src/team-roster/team-roster.test.ts
  // Cover:
  //  - getTeam: default (humans + active agents, sorted)
  //  - getTeam includeArchived=true returns archived too
  //  - getTeam includeAgents=false: humans only
  //  - lookupHuman by name (case-insensitive exact match)
  //  - lookupHuman by email (case-insensitive exact match)
  //  - lookupHuman with both args throws
  //  - lookupHuman with neither arg throws
  //  - lookupHuman miss returns null
  //  - lookupAgent by agentId (case-sensitive exact)
  //  - lookupAgent by name (case-insensitive)
  //  - lookupAgent by alias
  //  - teamSummary: non-empty string with section headers + member lines
  ```

- [ ] **Step 3:** Verify.
  ```bash
  npm run typecheck
  npm run test -- src/team-roster/team-roster.test.ts
  ```

- [ ] **Step 4:** Commit.
  ```bash
  git add src/team-roster/team-roster.ts src/team-roster/team-roster.test.ts src/team-roster/team-cache.ts src/team-roster/types.ts
  git commit -m "feat(team-roster): internal API — getTeam, lookupHuman, lookupAgent, teamSummary (KPR-139)"
  ```

---

## Task 6: In-process MCP server (`createSdkMcpServer`)

**Files:**
- Create: `src/team-roster/team-roster-mcp-server.ts`
- Create: `src/team-roster/team-roster-mcp-server.test.ts`

This is **the codebase's first in-process MCP server**. SDK signature confirmed at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:409`. Returns `McpSdkServerConfigWithInstance` (which carries an `instance: McpServer`); the whole object goes into `agent-runner`'s `mcpServers` map alongside stdio entries.

- [ ] **Step 1:** Implement the server factory.

  ```ts
  // src/team-roster/team-roster-mcp-server.ts
  import { createSdkMcpServer, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
  import { z } from "zod";
  import type { TeamRoster } from "./team-roster.js";

  function tool(roster: TeamRoster): Array<SdkMcpToolDefinition<any>> {
    return [
      {
        name: "team_list",
        description: "List the team. Defaults: active humans + active agents, sorted by category then name. Set includeArchived=true to include archived members. Set includeAgents=false to filter to humans only.",
        inputSchema: {
          includeArchived: z.boolean().optional(),
          includeAgents: z.boolean().optional(),
        },
        handler: async (args) => {
          const team = await roster.getTeam({
            includeArchived: args.includeArchived,
            includeAgents: args.includeAgents,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(team, null, 2) }],
          };
        },
      },
      {
        name: "team_lookup_human",
        description: "Look up a team-human by name or email. Provide exactly one. Returns full contact card or null if no match.",
        inputSchema: {
          name: z.string().optional(),
          email: z.string().optional(),
        },
        handler: async (args) => {
          if ((args.name ? 1 : 0) + (args.email ? 1 : 0) !== 1) {
            return {
              isError: true,
              content: [{ type: "text", text: "team_lookup_human: provide exactly one of name|email" }],
            };
          }
          const result = await roster.lookupHuman(args);
          return {
            content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "null" }],
          };
        },
      },
      {
        name: "team_lookup_agent",
        description: "Look up a team-agent by agentId or name (aliases supported). Provide exactly one. Returns full agent card or null if no match.",
        inputSchema: {
          agentId: z.string().optional(),
          name: z.string().optional(),
        },
        handler: async (args) => {
          if ((args.agentId ? 1 : 0) + (args.name ? 1 : 0) !== 1) {
            return {
              isError: true,
              content: [{ type: "text", text: "team_lookup_agent: provide exactly one of agentId|name" }],
            };
          }
          const result = await roster.lookupAgent(args);
          return {
            content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "null" }],
          };
        },
      },
    ];
  }

  export function createTeamRosterMcpServer(roster: TeamRoster) {
    return createSdkMcpServer({
      name: "team-roster",
      version: "0.1.0",
      tools: tool(roster),
    });
  }
  ```

- [ ] **Step 2:** Add tests for the tool handlers.

  ```ts
  // src/team-roster/team-roster-mcp-server.test.ts
  // Cover:
  //  - createTeamRosterMcpServer returns object with .instance
  //  - team_list handler returns JSON array
  //  - team_lookup_human with both args returns isError
  //  - team_lookup_human miss returns "null"
  //  - team_lookup_agent by alias works
  //  - schema validates arg shapes via Zod (handler receives parsed values)
  ```

- [ ] **Step 3:** Verify.
  ```bash
  npm run typecheck
  npm run test -- src/team-roster/team-roster-mcp-server.test.ts
  ```

- [ ] **Step 4:** Commit.
  ```bash
  git add src/team-roster/team-roster-mcp-server.ts src/team-roster/team-roster-mcp-server.test.ts
  git commit -m "feat(team-roster): in-process MCP server (first createSdkMcpServer in codebase) (KPR-139)"
  ```

---

## Task 7: Engine wiring — `agent-runner.ts`

**Files:**
- Modify: `src/agents/agent-runner.ts`
  - Lines 856–887 (`filterCoreServers`)
  - Lines 943–951 (`autoInjectedServerNames`)
  - Lines 207–297 (`buildSystemPrompt`)
  - Lines 1205–1288 (`mcpServers` map construction)

- [ ] **Step 1:** Add `team-roster` to auto-injected sets.

  In `filterCoreServers` (line ~872), after `coreSet.add("team");`:
  ```ts
  coreSet.add("team-roster");
  ```

  In `autoInjectedServerNames` (line ~948), update the Set initializer:
  ```ts
  const set = new Set<string>(["schedule", "team", "team-roster", "slack"]);
  ```

- [ ] **Step 2:** Inject the in-process MCP server into `mcpServers` map.

  AgentRunner needs access to the `TeamRoster` instance. Add it as a constructor dependency. (Update the AgentRunner constructor signature; index.ts will pass it in — Task 8.)

  Add field + constructor param:
  ```ts
  private readonly teamRoster: TeamRoster;
  // in constructor params: ..., teamRoster: TeamRoster
  // in body: this.teamRoster = teamRoster;
  ```

  At line ~1205, after `const mcpServers = this.filterCoreServers(allServerConfigs);`:
  ```ts
  if (Object.keys(mcpServers).length > 0 || coreServerNames.includes("team-roster")) {
    // team-roster is in-process: createSdkMcpServer returns McpSdkServerConfigWithInstance
    mcpServers["team-roster"] = createTeamRosterMcpServer(this.teamRoster);
  }
  ```

  Add the import at the top of the file:
  ```ts
  import { createTeamRosterMcpServer } from "../team-roster/team-roster-mcp-server.js";
  import type { TeamRoster } from "../team-roster/team-roster.js";
  ```

- [ ] **Step 3:** Slot `teamSummary()` into the system-prompt assembly.

  The current order in `buildSystemPrompt` (line 207) is:
  - soul (214–216)
  - archetype (221–236)
  - systemPrompt (238)
  - **constitution (240–244)** ← inject right after this, **before** the toolkit block
  - toolkit (catalog + delegates, 253–260) ← team summary push must precede this
  - memory (265–289)
  - date/time (291–295)

  Find the `parts.push(constitutionContent)` (or the last line of the constitution block, currently at line 244) and the `parts.push(buildToolkitSection(...))` call (currently at line 253). Insert between them:
  ```ts
  // Team summary (KPR-139): authoritative roster, replaces the static team table from business-context.md
  try {
    const teamSummary = await this.teamRoster.teamSummary();
    if (teamSummary) parts.push(teamSummary);
  } catch (err) {
    log.warn("teamSummary failed; falling back to no summary", { err });
  }
  ```

  > Caveat: `buildSystemPrompt` may be synchronous today (returns `string`). If it is, mark it `async` and update its caller (likely `getOptions()` or wherever the system prompt gets assembled). Check the signature — the spec calls this out as expected work for plan-stage.

- [ ] **Step 4:** Update all `new AgentRunner(...)` callsites for the new `teamRoster` constructor param. Confirmed callsites at plan-write time:
  - `src/agents/agent-manager.ts:95` (production)
  - `src/agents/agent-runner.test.ts:170, 186, 201, 214` (tests — pass a stub `TeamRoster` whose `teamSummary()` returns `""`)

  Re-grep before editing in case more landed since the plan was written:
  ```bash
  grep -n 'new AgentRunner' src/
  ```

- [ ] **Step 5:** Verify build.
  ```bash
  npm run typecheck
  ```
  Expected: passes.

- [ ] **Step 6:** Smoke test — create the simplest possible test that an agent session sees the team-roster MCP server.

  A full integration test is heavy (real Slack/Mongo). For now, a unit test of `agent-runner.buildSystemPrompt` covering the team summary inclusion is sufficient:

  ```ts
  // src/agents/agent-runner.test.ts (extend if exists, else create)
  // Test: given a fake TeamRoster with teamSummary() returning "## Team\n- Alice", the assembled system prompt contains that block
  // Test: TeamRoster failure does not break prompt assembly (assert: warn logged, prompt still has constitution + toolkit)
  ```

- [ ] **Step 7:** Commit.
  ```bash
  git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts
  git commit -m "feat(agent-runner): wire team-roster MCP + inject team summary in prompt (KPR-139)"
  ```

---

## Task 8: Bootstrap + change-stream watcher

**Files:**
- Create: `src/team-roster/contacts-watcher.ts`
- Modify: `src/index.ts`

The humans slice needs an engine-side change-stream watcher on `contacts` (the contacts MCP runs in a stdio subprocess and can't call into the in-process cache). Pattern is identical to `agent-registry.ts:115-149` but on a different collection.

- [ ] **Step 1:** Create the watcher.

  ```ts
  // src/team-roster/contacts-watcher.ts
  import type { Db, ChangeStream } from "mongodb";
  import { createLogger } from "../logging/logger.js";
  import type { TeamCache } from "./team-cache.js";

  const log = createLogger("contacts-watcher");
  const POLL_INTERVAL_MS = 30_000;

  export class ContactsWatcher {
    private changeStream?: ChangeStream;
    private pollTimer?: NodeJS.Timeout;
    private lastPollTime = new Date();

    constructor(private db: Db, private cache: TeamCache) {}

    async start(): Promise<void> {
      try {
        this.changeStream = this.db.collection("contacts").watch([]);
        this.changeStream.on("change", () => {
          log.debug("contacts changed (change stream), invalidating humans cache");
          this.cache.invalidateHumans();
        });
        this.changeStream.on("error", (err) => {
          log.warn("contacts change stream error, falling back to polling", { err });
          this.startPolling();
        });
        log.info("contacts change stream started");
      } catch (err) {
        log.warn("change stream unavailable, starting polling fallback", { err });
        this.startPolling();
      }
    }

    private startPolling(): void {
      if (this.pollTimer) return; // idempotent — error+catch can both call this
      this.pollTimer = setInterval(async () => {
        try {
          const changed = await this.db
            .collection("contacts")
            .countDocuments({ updatedAt: { $gt: this.lastPollTime } });
          if (changed > 0) {
            log.debug("contacts changed (polling), invalidating humans cache");
            this.cache.invalidateHumans();
            this.lastPollTime = new Date();
          }
        } catch (err) {
          log.warn("polling iteration failed", { err });
        }
      }, POLL_INTERVAL_MS);
    }

    async stop(): Promise<void> {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.changeStream) await this.changeStream.close();
    }
  }
  ```

- [ ] **Step 2:** Wire bootstrap in `src/index.ts`.

  After Mongo connection + AgentRegistry instantiation (grep for `new AgentRegistry`):
  ```ts
  import { TeamCache } from "./team-roster/team-cache.js";
  import { TeamRoster } from "./team-roster/team-roster.js";
  import { ContactsWatcher } from "./team-roster/contacts-watcher.js";

  const teamCache = new TeamCache(db);
  const teamRoster = new TeamRoster(teamCache);

  agentRegistry.onPostReload(() => teamCache.invalidateAgents());

  const contactsWatcher = new ContactsWatcher(db, teamCache);
  await contactsWatcher.start();
  ```

  Pass `teamRoster` into AgentRunner construction (Task 7 added the dep).

- [ ] **Step 3:** Verify.
  ```bash
  npm run typecheck
  npm run build    # full bundle to confirm production path is intact
  ```

- [ ] **Step 4:** Commit.
  ```bash
  git add src/team-roster/contacts-watcher.ts src/index.ts
  git commit -m "feat(team-roster): bootstrap cache + contacts change-stream watcher (KPR-139)"
  ```

---

## Task 9: Migration script

**Files:**
- Create: `scripts/migrate-contacts-categories.ts`
- Modify: `package.json` (add `migrate:contacts-categories` script)

The dodi instance was hand-seeded earlier today (8 team-humans with `category: "team-human"`); customer rows are already in `crm_contacts` (KPR-114 ran). So for dodi this script is mostly a no-op — but it's the **portable, idempotent, repeatable** version that other instances will need.

> **Spec compliance gap (intentional):** the spec requires writing a `--dry-run` diff file to `/tmp/kpr-79-migration-<timestamp>.diff`. The implementation below prints a tally to stdout instead, since (a) for dodi the migration is a near-no-op, and (b) the data is already in MongoDB and reversible via `contacts_update`. If a future instance has volumes that warrant the file output, add it as a follow-up. Acceptance criteria below reflect the stdout-only behavior; the spec's diff-file requirement is a known omission.

- [ ] **Step 1:** Implement.

  ```ts
  #!/usr/bin/env npx tsx
  // scripts/migrate-contacts-categories.ts
  import { MongoClient } from "mongodb";

  const TEAM_EMAILS_DODI = new Set(
    ["may", "mike", "corey", "angus", "aaron", "angela", "lauren", "zhitong"]
      .map((n) => `${n}@dodihome.com`),
  );

  const TEST_EMAIL_PATTERNS: RegExp[] = [
    /^layna\+test/i,
    /^test\+/i,
  ];

  function isTestEmail(email: string | null): boolean {
    if (!email) return false;
    return TEST_EMAIL_PATTERNS.some((re) => re.test(email));
  }

  async function main() {
    const apply = process.argv.includes("--apply");
    const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
    const dbName = process.env.MONGODB_DB || "hive";
    const client = new MongoClient(uri);
    await client.connect();
    const contacts = client.db(dbName).collection("contacts");

    const all = await contacts.find({}).toArray();
    let toDelete = 0, toArchive = 0, toCategorize = 0, alreadyCategorized = 0;

    // Step 1: identify test rows
    const testIds = all.filter((d) => isTestEmail(d.email)).map((d) => d._id);
    toDelete = testIds.length;

    // Step 2: dedup by lowercased email — keep most recent
    const byEmail = new Map<string, any[]>();
    for (const d of all) {
      if (!d.email || isTestEmail(d.email)) continue;
      const key = d.email.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key)!.push(d);
    }
    const toArchiveIds: any[] = [];
    for (const dups of byEmail.values()) {
      if (dups.length <= 1) continue;
      dups.sort((a, b) => +new Date(b.updatedAt ?? 0) - +new Date(a.updatedAt ?? 0));
      for (const stale of dups.slice(1)) toArchiveIds.push(stale._id);
    }
    toArchive = toArchiveIds.length;

    // Step 3: backfill category on remaining
    const ops: any[] = [];
    for (const d of all) {
      if (testIds.includes(d._id)) continue;
      if (toArchiveIds.includes(d._id)) {
        ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { category: "archived" } } } });
        continue;
      }
      if (d.category) { alreadyCategorized++; continue; }
      const email = (d.email ?? "").toLowerCase();
      const cat = TEAM_EMAILS_DODI.has(email) ? "team-human" : "customer";
      ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { category: cat } } } });
      toCategorize++;
    }

    console.log(`Plan:\n  delete (test): ${toDelete}\n  archive (dup): ${toArchive}\n  categorize: ${toCategorize}\n  already categorized: ${alreadyCategorized}`);

    if (!apply) {
      console.log("\n(dry-run; pass --apply to commit)");
      await client.close();
      return;
    }

    if (testIds.length > 0) {
      const r = await contacts.deleteMany({ _id: { $in: testIds } });
      console.log(`Deleted: ${r.deletedCount}`);
    }
    if (ops.length > 0) {
      const r = await contacts.bulkWrite(ops);
      console.log(`Upserts/Updates: ${r.modifiedCount}`);
    }
    await client.close();
  }

  main().catch((err) => { console.error(err); process.exit(1); });
  ```

- [ ] **Step 2:** Add npm script.

  In `package.json` `scripts`:
  ```json
  "migrate:contacts-categories": "npx tsx scripts/migrate-contacts-categories.ts"
  ```

- [ ] **Step 3:** Verify (dry-run against dodi).
  ```bash
  MONGODB_URI=mongodb://localhost:27017 MONGODB_DB=hive_dodi npm run migrate:contacts-categories
  ```
  Expected output: `delete (test): 0, archive (dup): 0, categorize: 0, already categorized: 8` (the 8 team-humans seeded earlier).

- [ ] **Step 4:** Commit.
  ```bash
  git add scripts/migrate-contacts-categories.ts package.json
  git commit -m "feat(scripts): add migrate-contacts-categories with dry-run + apply (KPR-139)"
  ```

---

## Task 10: Retire team-roster section from `business-context.md` *(post-merge runbook)*

**Files:**
- Modify: `hive_dodi.memory` document at `path: "shared/business-context.md"` (live MongoDB document, not a file in the repo)

This is a **post-merge** runbook step, not part of the PR diff. It happens after the engine code is merged + deployed to dodi. Document is included here so the operator has a clear handoff; nothing in this task gets committed to the branch.

- [ ] **Step 1:** Bundle + deploy + restart dodi to pick up engine changes.
  ```bash
  npm run bundle              # build production bundle
  hive update                 # the engine ships an `update` command that pulls the npm tarball into <instance>/.hive/
  # or, for a local-source deploy:
  # rsync -a pkg/ ~/services/hive/dodi/.hive/pkg/
  launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent
  ```

- [ ] **Step 2:** From a Slack channel a dodi agent listens on, confirm the agent answers a "who's on the team?" question with content equivalent to the team summary block (without referencing the static table).

- [ ] **Step 3:** Edit `shared/business-context.md` in MongoDB to remove the two team tables (Humans + AI Agents). Keep the surrounding business context.
  ```js
  // mongosh
  const target = db.getSiblingDB("hive_dodi");
  const doc = target.memory.findOne({ path: "shared/business-context.md" });
  // edit doc.content — strip "## Team" through end of "### AI Agents" sections
  target.memory.updateOne({ _id: doc._id }, { $set: { content: NEW_CONTENT, updatedAt: new Date() } });
  ```

- [ ] **Step 4:** Send `SIGUSR1` to reload memory (no full restart needed for memory edits — the launchctl kickstart in Step 1 already restarted with the new engine code).
  ```bash
  # The launchd label is `com.hive.dodi.agent`; the actual process command line contains `pkg/server.min`.
  pkill -USR1 -f 'pkg/server.min'
  ```

- [ ] **Step 5:** Re-validate from Slack — agent should still answer team questions correctly via the auto-injected summary.

- [ ] **Step 6:** No commit — memory edit is in MongoDB, not the repo.

---

## Task 11: Quality gate

- [ ] **Step 1:** Run the full check.
  ```bash
  npm run check
  ```
  Expected: typecheck + lint + format + test all pass.

- [ ] **Step 2:** If any failures, fix them in a commit on this branch (no `--amend`, no `--no-verify`).

---

## Task 12: PR

- [ ] **Step 1:** Push.
  ```bash
  git push -u origin KPR-139
  ```

- [ ] **Step 2:** Create PR via `gh pr create` (per CLAUDE.md PR template):
  - Base: `main`
  - Title: `feat: engine-native team API + team-roster MCP (KPR-139)`
  - Body summarizes: spec link, Tasks 1–9 in the plan (Task 0 is local setup; Tasks 10–12 are post-PR runbook + quality-gate + this PR creation), plan-stage decisions (in-process MCP, post-reload emitter, change-stream watcher).

---

## Plan-stage decisions captured

1. **`pickMostRecent` implementation:** Cache propagates `updatedAt` (Task 4 update) so disambiguation by recency works. Migration script archives duplicates so this should rarely fire in practice.

2. **`TeamMember.category` synthesizes `team-agent`:** This value never appears in the `ContactDoc.category` enum (per spec); it's computed from `agent_definitions` at query time.

3. **`buildSystemPrompt` async:** Likely needs to become async to await `teamSummary()`. Verify caller chain (`getOptions` / wherever it's called) accepts a Promise. Adjust as needed.

4. **No live admin-write→cache-invalidate path on `agent_definitions`:** Per spec, all paths converge at `registry.load()` and the new `onPostReload` covers them. Latency is bounded by change-stream observability + 500ms debounce + 60s TTL fallback.

5. **dodi data is already partially migrated** (8 team-humans seeded 2026-05-02; CRM split via KPR-114). Migration script is portable for keepur and future instances.

6. **`hive-docs/internal/plans/` doesn't exist locally.** Plan written to `docs/plans/` in this worktree. At PR-merge time, decide whether to move to hive-docs or accept that public-repo `docs/plans/` is the convention now.

---

## Out of scope for KPR-139 (potential follow-ups)

- Frontend or Slack UI for editing team members (use existing contacts MCP).
- Cross-instance team federation (each hive instance has its own roster).
- Replacing HubSpot as customer source-of-truth.
- Splitting customer/CRM contacts collection further (KPR-80 already covered the dodi split).

---

**Plan saved to `docs/plans/2026-05-02-team-engine-api.md`. Ready to execute?**

When ready, invoke `dodi-dev:implement`.
